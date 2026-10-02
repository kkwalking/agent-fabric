/**
 * Execution Supervisor (v11 §13/§14).
 *
 * The Supervisor owns the whole lifecycle of a Project-based Task:
 *
 *   Task Created → Workspace Preparing → Source Preparing → Runtime Preparing
 *   → Agent Running → Validation → Git Finalization → Publishing → Cleanup
 *   → Completed   (v11 §9)
 *
 * It is deliberately NOT the agent: it lives in the control plane, holds the
 * source credential only for the duration of a Git operation, owns the
 * working branch, decides the commit policy and performs the push (v11 §16).
 * The runtime container the agent executes in never receives the credential.
 *
 * Every stage is idempotent and inspectable: the workspace is a durable
 * working copy, the branch is only created when the Task has not started yet,
 * a push whose result is uncertain is re-checked against the remote, and a
 * lock whose run is gone is reclaimed (v11 §36/§37).
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { EventBus } from "./eventbus.js";
import { Store, newId } from "./store.js";
import { DomainError, asDomainError, retryKindForFailure, type FailureStage, type RetryKind } from "./errors.js";
import {
  createGitOps,
  generateWorkingBranch,
  materializeGitCredential,
  validateBranchName,
  validateRemoteUrl,
  gitCredentialTempRoot,
  type GitOps,
  type GitStatus,
  type MaterializedCredential,
} from "./git.js";
import { SecretRedactor } from "./redaction.js";
import { provisionEnvironment, MCP_CONFIG_ENV_VAR, SKILLS_ENV_VAR, type ProvisionedEnvironment } from "./provisioning.js";
import { createValidationRunner, resolveValidationConfig, type ValidationRunner } from "./validation.js";
import { RunService } from "./orchestrator.js";
import {
  ArtifactService,
  ModelService,
  ProfileService,
  ProjectService,
  RuntimeService,
  SecretService,
  SourceCredentialService,
  TaskService,
  WorkspaceLockService,
  WorkspaceService,
  now,
} from "./services.js";
import type {
  GitPublishPolicy,
  ID,
  Project,
  Run,
  RunEvent,
  RunPhase,
  Runtime,
  RuntimeLifecycle,
  Task,
  TaskExecution,
  TaskFailure,
  TaskPublishState,
  TaskValidationState,
  ValidationConfig,
  ValidationStep,
  Workspace,
} from "./types.js";

/** Default publish policy when neither the Task nor the Project defines one. */
export const DEFAULT_GIT_POLICY: Required<Pick<GitPublishPolicy, "autoCommit" | "push" | "remote" | "protectedBranches">> = {
  autoCommit: true,
  push: true,
  remote: "origin",
  protectedBranches: ["main", "master"],
};

/** Every `GitOps` method, for binding a lifecycle's abort signal to them. */
const GIT_OPS_METHODS = [
  "clone",
  "fetch",
  "setRemoteUrl",
  "isRepository",
  "resolveRevision",
  "branchExists",
  "remoteBranchSha",
  "createBranch",
  "checkout",
  "currentBranch",
  "head",
  "status",
  "stageAll",
  "commit",
  "commitsBetween",
  "push",
] as const;

/** A fully resolved publish policy (no optional fields left to interpret). */
export interface ResolvedGitPolicy {
  autoCommit: boolean;
  push: boolean;
  remote: string;
  protectedBranches: string[];
  commitMessage?: string;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
}

/** Lifecycle phases that mean "this task is mid-flight". */const IN_FLIGHT_PHASES: RunPhase[] = [
  "workspace.preparing",
  "source.fetching",
  "source.checkout",
  "runtime.preparing",
  "agent.running",
  "validation.running",
  "git.finalizing",
  "git.pushing",
  "cleanup",
];

export interface StartProjectTaskInput {
  projectId: ID;
  /** The task instruction (v11 §39). */
  instruction: string;
  title?: string;
  /** Base ref / branch to start from; defaults to the Project's default branch. */
  baseRef?: string;
  /** Working branch: user-provided or system-generated (v11 §8). */
  workingBranch?: string;
  branchMode?: "new" | "continue";
  runtimeId?: ID;
  modelId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: ID[];
  tools?: string[];
  timeoutMs?: number;
  policy?: Task["policy"];
  resourceLimits?: Task["resourceLimits"];
  lifecycle?: RuntimeLifecycle;
  /** Task-level validation override (replaces the Project's). */
  validation?: ValidationConfig;
  /** Task-level publish policy override. */
  git?: GitPublishPolicy;
  metadata?: Record<string, unknown>;
  /** Set false to create the Task without starting the lifecycle. */
  autoStart?: boolean;
}

export interface StartProjectTaskResult {
  project: Project;
  task: Task;
  workspace: Workspace;
  run: Run;
}

/** Aggregated read model behind the Task Detail view (v11 §40). */
export interface TaskDetailView {
  task: Task;
  project: Project | null;
  source: {
    remoteUrl: string;
    provider?: string;
    defaultBranch?: string;
    credential: {
      id: ID;
      name: string;
      type: string;
      host?: string;
      username?: string;
      secretMasked?: string;
    } | null;
  } | null;
  workspace: Workspace | null;
  runtime: Runtime | null;
  baseRef?: string;
  baseCommitSha?: string;
  workingBranch?: string;
  phase: RunPhase;
  status: TaskExecution["status"];
  failure?: TaskFailure;
  agent: TaskExecution["agent"];
  validation: TaskValidationState;
  publish: TaskPublishState;
  finalCommitSha?: string;
  remoteBranch?: string;
  remote?: string;
  runs: Run[];
  /** Which retries the current state permits (v11 §31). */
  retry: { agent: boolean; validation: boolean; publish: boolean; kind: RetryKind };
  /** Set while a lifecycle is executing in this process. */
  running: boolean;
}

export interface SupervisorOptions {
  git?: GitOps;
  validationRunner?: ValidationRunner;
  /** Overall git operation budget (clone/fetch/push). */
  gitTimeoutMs?: number;
}

type LifecycleMode = "full" | "post-agent" | "publish-only";

export class ExecutionSupervisor {
  private readonly git: GitOps;
  private readonly validationRunner: ValidationRunner;
  private readonly gitTimeoutMs: number;
  /** In-flight lifecycles, keyed by task id. */
  private readonly active = new Map<ID, Promise<void>>();
  /**
   * Redactors for lifecycles in flight, keyed by the run events are attached
   * to. Every event payload passes through one before it is persisted, so a
   * credential value cannot reach the event log (v11 §34).
   */
  private readonly redactors = new Map<ID, SecretRedactor>();
  /**
   * Tasks whose cancellation was requested while a lifecycle is running
   * (v11 §32). A cancel during source preparation must stop the lifecycle
   * *before* the agent starts — the run record alone cannot carry that,
   * because a run that never started has no execution to abort.
   */
  private readonly cancelRequested = new Set<ID>();
  /**
   * Abort controllers for lifecycles in flight, keyed by task. Cancelling
   * aborts the in-flight git operation (clone / fetch / push) as well as the
   * runtime, so a cancel is prompt rather than waiting out a slow network
   * operation (v11 §32).
   */
  private readonly lifecycleAborts = new Map<ID, AbortController>();

  constructor(
    private store: Store,
    private bus: EventBus,
    private runService: RunService,
    options: SupervisorOptions = {}
  ) {
    this.git = options.git ?? createGitOps();
    this.validationRunner = options.validationRunner ?? createValidationRunner();
    this.gitTimeoutMs = options.gitTimeoutMs ?? 10 * 60 * 1000;
  }

  /* ---------------- services ---------------- */

  private tasks() {
    return new TaskService(this.store);
  }
  private projects() {
    return new ProjectService(this.store);
  }
  private credentials() {
    return new SourceCredentialService(this.store);
  }
  private workspaces() {
    return new WorkspaceService(this.store);
  }
  private locks() {
    return new WorkspaceLockService(this.store);
  }
  private runtimes() {
    return new RuntimeService(this.store);
  }
  private models() {
    return new ModelService(this.store);
  }
  private profiles() {
    return new ProfileService(this.store);
  }
  private secrets() {
    return new SecretService(this.store);
  }
  private artifacts() {
    return new ArtifactService(this.store);
  }

  /* ---------------- public API ---------------- */

  /** True while this task has a lifecycle executing in this process. */
  isRunning(taskId: ID): boolean {
    return this.active.has(taskId);
  }

  /** Waits for the task's in-flight lifecycle (tests and API callers). */
  async whenSettled(taskId: ID): Promise<void> {
    const pending = this.active.get(taskId);
    if (pending) await pending.catch(() => {});
  }

  /**
   * Creates a Project-based Task with its own managed Workspace and starts the
   * lifecycle (v11 §39: the user never creates a Workspace by hand).
   */
  async startTask(input: StartProjectTaskInput): Promise<StartProjectTaskResult> {
    const project = this.projects().get(input.projectId);
    if (!project) throw new DomainError("project-not-found", `Project not found: ${input.projectId}`);
    const instruction = input.instruction?.trim();
    if (!instruction) throw new DomainError("task-state-invalid", "A task needs an instruction");

    const urlCheck = validateRemoteUrl(project.source.remoteUrl);
    if (!urlCheck.ok) throw new DomainError("source-url-invalid", urlCheck.reason);

    const runtime = this.resolveRuntime(project, input.runtimeId);
    const modelId = this.resolveModelId(project, runtime, input.modelId);
    const profile = input.profileId ? this.profiles().get(input.profileId) : undefined;

    // The task id is generated up front: the managed workspace and the
    // system-generated branch name both derive from it (v11 §5.1/§8).
    const taskId = newId("task");
    const title = input.title?.trim() || instruction.slice(0, 80);
    const workingBranch = input.workingBranch?.trim() || generateWorkingBranch(taskId, title);
    const branchCheck = validateBranchName(workingBranch);
    if (!branchCheck.ok) throw new DomainError("branch-invalid", branchCheck.reason);
    const branchMode = input.branchMode ?? "new";
    const baseRef = input.baseRef?.trim() || project.source.defaultBranch || "main";
    const protectedBranches = this.effectiveGitPolicy(project, input.git).protectedBranches;
    if (protectedBranches.includes(workingBranch)) {
      throw new DomainError("branch-invalid", `"${workingBranch}" is a protected branch — a task must work on its own branch`);
    }

    const workspace = await this.workspaces().createManaged({
      name: `${project.name} / ${title}`.slice(0, 120),
      projectId: project.id,
      taskId,
      repoUrl: project.source.remoteUrl,
      workingBranch,
    });

    const execution: TaskExecution = {
      phase: "task.created",
      status: "created",
      agent: { status: "pending", attempts: 0 },
      validation: { status: "pending", attempts: 0 },
      publish: { status: "pending", attempts: 0 },
      updatedAt: now(),
    };

    const task = await this.tasks().create({
      id: taskId,
      title,
      prompt: instruction,
      projectId: project.id,
      workspaceId: workspace.id,
      runtimeId: runtime.id,
      modelId,
      profileId: input.profileId,
      baseRef,
      workingBranch,
      branchMode,
      validation: input.validation,
      git: input.git,
      env: this.mergeEnv(project, input.env),
      secretIds: [...new Set([...(project.execution?.secretIds ?? []), ...(input.secretIds ?? [])])],
      tools: input.tools ?? project.execution?.tools,
      resourceLimits: input.resourceLimits ?? project.execution?.resourceLimits,
      timeoutMs: input.timeoutMs ?? project.execution?.timeoutMs,
      policy: input.policy ?? project.execution?.policy,
      metadata: input.metadata,
      execution,
    });

    const run = await this.runService.createRunForTask(task, {
      runtimeId: runtime.id,
      modelId,
      workspaceId: workspace.id,
      projectId: project.id,
      workingBranch,
      continuity: "new",
      inputInstruction: instruction,
      userPrompt: instruction,
      systemInstructions: profile?.systemInstructions,
      profileId: input.profileId,
      lifecycle: input.lifecycle ?? project.execution?.lifecycle,
      phase: "workspace.preparing",
    });
    await this.setPhase(task.id, run.id, "workspace.preparing", "preparing");

    if (input.autoStart !== false) void this.startLifecycle(task.id, run.id, "full");
    return { project, task: this.tasks().get(task.id)!, workspace, run: this.runService.get(run.id)! };
  }

  /**
   * Cancels the Task's in-flight work (v11 §32): the runtime process is
   * terminated, the supervisor runs its cleanup, the workspace — and every
   * uncommitted modification in it — is preserved.
   */
  async cancelTask(taskId: ID): Promise<Task | undefined> {
    const task = this.tasks().get(taskId);
    if (!task) return undefined;
    // Flag the request first: a lifecycle still preparing the source must stop
    // before it starts an agent for a task the user has cancelled.
    this.cancelRequested.add(taskId);
    this.lifecycleAborts.get(taskId)?.abort();
    try {
      const active = this.activeRun(taskId);
      if (active) {
        await this.runService.cancel(active.id);
        await this.whenSettled(taskId);
        return this.tasks().get(taskId);
      }
      // No run in flight: settle the bookkeeping directly.
      if (task.execution && IN_FLIGHT_PHASES.includes(task.execution.phase)) {
        const runId = this.eventRunId(task);
        await this.patchExecution(taskId, {
          phase: "cancelled",
          status: "cancelled",
          failure: { stage: this.stageForPhase(task.execution.phase), code: "agent-cancelled", message: "Cancelled by user", at: now() },
          agent: { ...(task.execution.agent ?? { status: "pending", attempts: 0 }), status: "cancelled" },
        });
        if (runId) await this.emit(runId, "run.cancelled", { reason: "cancelled by user" });
        if (task.workspaceId) await this.locks().release(task.workspaceId);
      }
      return this.tasks().get(taskId);
    } finally {
      this.cancelRequested.delete(taskId);
    }
  }

  /**
   * Retry Agent Run (v11 §31): a **new** Run continues on the same Workspace.
   * The agent is re-executed; the workspace keeps every modification made so
   * far, so the new Run picks the work up where it stopped.
   */
  async retryRun(taskId: ID, input: { instruction?: string; runtimeId?: ID; modelId?: ID } = {}): Promise<{ task: Task; run: Run }> {
    const task = this.tasks().get(taskId);
    if (!task) throw new DomainError("task-not-found", `Task not found: ${taskId}`);
    if (!task.projectId) throw new DomainError("task-state-invalid", "This task is not project-based — retry it as a normal run");
    this.assertNotRunning(task);
    this.assertWorkspacePresent(task);
    const project = this.projects().get(task.projectId);
    if (!project) throw new DomainError("project-not-found", `Project not found: ${task.projectId}`);

    const runtime = this.resolveRuntime(project, input.runtimeId ?? task.runtimeId);
    const modelId = this.resolveModelId(project, runtime, input.modelId ?? task.modelId);
    const instruction = input.instruction?.trim() || task.prompt;
    const previous = this.activeRun(taskId) ?? this.latestRun(taskId);
    const profile = task.profileId ? this.profiles().get(task.profileId) : undefined;

    const run = await this.runService.createRunForTask(task, {
      runtimeId: runtime.id,
      modelId,
      workspaceId: task.workspaceId,
      projectId: project.id,
      workingBranch: task.workingBranch,
      baseCommitSha: task.baseCommitSha,
      continuity: "new",
      inputInstruction: instruction,
      userPrompt: instruction,
      systemInstructions: profile?.systemInstructions,
      profileId: task.profileId,
      lifecycle: previous?.lifecycle,
      phase: "workspace.preparing",
    });
    await this.patchExecution(taskId, {
      phase: "workspace.preparing",
      status: "preparing",
      failure: undefined,
      // Attempts are counted when an attempt actually starts (the lifecycle),
      // so retrying never double-counts.
      agent: { ...(task.execution?.agent ?? { attempts: 0 }), status: "pending", runId: run.id },
      validation: { status: "pending", attempts: task.execution?.validation?.attempts ?? 0 },
      // The publish record keeps what this task already published (its remote
      // branch and push time) — a new agent run must not lose the fact that
      // this branch is ours, or the next push would look like a conflict.
      publish: {
        ...(task.execution?.publish ?? { status: "pending", attempts: 0 }),
        status: "pending",
        error: undefined,
        errorCode: undefined,
      },
    });
    void this.startLifecycle(taskId, run.id, "full");
    return { task: this.tasks().get(taskId)!, run };
  }

  /**
   * Retry Validation (v11 §31): re-runs validation only. The agent is not
   * re-executed and no model is called.
   */
  async retryValidation(taskId: ID): Promise<Task | undefined> {
    const task = this.tasks().get(taskId);
    if (!task) throw new DomainError("task-not-found", `Task not found: ${taskId}`);
    this.assertNotRunning(task);
    this.assertWorkspacePresent(task);
    const runId = this.eventRunId(task);
    if (!runId) throw new DomainError("task-state-invalid", "This task has no run to validate");
    void this.startLifecycle(taskId, runId, "post-agent");
    await this.whenSettled(taskId);
    return this.tasks().get(taskId);
  }

  /**
   * Retry Publish (v11 §23/§31): pushes the already-committed revision again.
   * The agent is never re-run and no model is called.
   */
  async retryPublish(taskId: ID): Promise<Task | undefined> {
    const task = this.tasks().get(taskId);
    if (!task) throw new DomainError("task-not-found", `Task not found: ${taskId}`);
    this.assertNotRunning(task);
    this.assertWorkspacePresent(task);
    const runId = this.eventRunId(task);
    if (!runId) throw new DomainError("task-state-invalid", "This task has no run to publish");
    void this.startLifecycle(taskId, runId, "publish-only");
    await this.whenSettled(taskId);
    return this.tasks().get(taskId);
  }

  /** The aggregated Task Detail read model (v11 §40). */
  taskDetail(taskId: ID): TaskDetailView {
    const task = this.tasks().get(taskId);
    if (!task) throw new DomainError("task-not-found", `Task not found: ${taskId}`);
    const project = task.projectId ? this.projects().get(task.projectId) ?? null : null;
    const credential = project?.source.credentialId ? this.credentials().getView(project.source.credentialId) ?? null : null;
    const execution = task.execution;
    const failure = execution?.failure;
    const kind = retryKindForFailure(failure?.stage);
    const settled = !this.isRunning(taskId);
    return {
      task,
      project,
      source: project
        ? {
            remoteUrl: project.source.remoteUrl,
            provider: project.source.provider,
            defaultBranch: project.source.defaultBranch,
            credential: credential
              ? {
                  id: credential.id,
                  name: credential.name,
                  type: credential.type,
                  host: credential.host,
                  username: credential.username,
                  secretMasked: credential.secretMasked,
                }
              : null,
          }
        : null,
      workspace: task.workspaceId ? this.workspaces().get(task.workspaceId) ?? null : null,
      runtime: task.runtimeId ? this.runtimes().get(task.runtimeId) ?? null : null,
      baseRef: task.baseRef,
      baseCommitSha: task.baseCommitSha ?? execution?.baseCommitSha,
      workingBranch: task.workingBranch,
      phase: execution?.phase ?? "task.created",
      status: execution?.status ?? "created",
      failure,
      agent: execution?.agent,
      validation: execution?.validation ?? { status: "pending", attempts: 0 },
      publish: execution?.publish ?? { status: "pending", attempts: 0 },
      finalCommitSha: execution?.publish?.finalCommitSha,
      remoteBranch: execution?.publish?.remoteBranch,
      remote: execution?.publish?.remote,
      runs: this.runService.forTask(taskId),
      retry: {
        agent: settled && kind === "agent",
        validation: settled && kind === "validation",
        publish: settled && kind === "publish",
        kind,
      },
      running: this.isRunning(taskId),
    };
  }

  /**
   * Crash recovery (v11 §37): after a restart no lifecycle is running, so a
   * Task left mid-flight is marked failed with an explicit
   * `supervisor-restarted` reason and its workspace lock is released. The
   * workspace — and everything in it — is untouched; the user retries the
   * agent run on the same working copy.
   */
  async recoverInterrupted(): Promise<{ tasks: ID[]; workspaces: ID[] }> {
    const released = await this.locks().releaseStale((runId) => this.runService.isExecuting(runId));
    const interrupted: ID[] = [];
    for (const task of this.tasks().list({ deleted: false })) {
      const execution = task.execution;
      if (!execution || !IN_FLIGHT_PHASES.includes(execution.phase)) continue;
      const active = this.activeRun(task.id);
      if (active) continue;
      await this.patchExecution(task.id, {
        phase: "failed",
        status: "failed",
        failure: {
          stage: this.stageForPhase(execution.phase),
          code: "supervisor-restarted",
          message: "AgentFabric restarted while this task was in flight — the workspace was preserved; retry the agent run",
          at: now(),
        },
        agent: { ...(execution.agent ?? { status: "pending", attempts: 0 }), status: "failed", error: "Supervisor restarted" },
      });
      interrupted.push(task.id);
    }
    return { tasks: interrupted, workspaces: released };
  }

  /* ---------------- lifecycle ---------------- */

  private startLifecycle(taskId: ID, runId: ID, mode: LifecycleMode): Promise<void> {
    const previous = this.active.get(taskId);
    const promise = (async () => {
      if (previous) await previous.catch(() => {});
      await this.lifecycle(taskId, runId, mode);
    })()
      .catch(() => {
        /* every failure is recorded on the task; nothing escapes */
      })
      .finally(() => {
        if (this.active.get(taskId) === promise) this.active.delete(taskId);
      });
    this.active.set(taskId, promise);
    return promise;
  }

  private async lifecycle(taskId: ID, runId: ID, mode: LifecycleMode): Promise<void> {
    const task = this.tasks().get(taskId);
    if (!task) return;
    const project = task.projectId ? this.projects().get(task.projectId) : undefined;
    const workspace = task.workspaceId ? this.workspaces().get(task.workspaceId) : undefined;
    const redactor = new SecretRedactor();
    this.redactors.set(runId, redactor);
    const abort = new AbortController();
    this.lifecycleAborts.set(taskId, abort);
    const git = this.gitFor(abort.signal);
    let provisioned: ProvisionedEnvironment | undefined;
    let lockHeld = false;
    let failure: TaskFailure | undefined;

    try {
      if (!project) throw new DomainError("project-not-found", "This task's project no longer exists");
      if (!workspace?.path) throw new DomainError("workspace-invalid", "This task has no managed workspace");
      const credentialInput = this.credentials().resolve(project.source.credentialId);
      if (credentialInput) {
        redactor.add(credentialInput.token);
        redactor.add(credentialInput.privateKey);
        redactor.add(credentialInput.passphrase);
      }

      /* ---- 1. Workspace preparing (v11 §10) ---- */
      await this.setPhase(taskId, runId, "workspace.preparing", "preparing");
      if (mode !== "publish-only") {
        await this.locks().acquire(workspace.id, { taskId, runId }, (id) => this.isRunActive(id));
        lockHeld = true;
        await this.prepareWorkspaceDirectory(workspace);
        await this.emit(runId, "workspace.prepared", {
          workspaceId: workspace.id,
          path: workspace.path,
          ownership: workspace.ownership ?? "external",
          managed: workspace.ownership === "managed",
        });
      }

      /* ---- 2. Source preparing (v11 §11) ---- */
      if (mode === "full") {
        await this.prepareSource({ task, runId, project, workspace, redactor, credentialInput, git });
      }
      this.assertNotCancelled(taskId);

      /* ---- 3. Runtime preparing + provisioning (v11 §25/§26) ---- */
      if (mode !== "publish-only") {
        await this.setPhase(taskId, runId, "runtime.preparing", "preparing");
        const runtime = task.runtimeId ? this.runtimes().get(task.runtimeId) : undefined;
        if (!runtime) throw new DomainError("runtime-create-failed", "This task has no runtime configured");
        if (!runtime.enabled) throw new DomainError("runtime-create-failed", `Runtime "${runtime.name}" is disabled`);
        if (!runtime.usableInTask) {
          throw new DomainError("policy-denied", `Runtime "${runtime.name}" is not usable for tasks (usableInTask is disabled)`);
        }
        if (!this.runService.adapterFor(runtime.kind)) {
          throw new DomainError("runtime-start-failed", `No adapter is registered for runtime kind "${runtime.kind}"`);
        }
        provisioned = await provisionEnvironment({
          dataDir: this.store.dataDir,
          runId,
          project,
          task,
          skillsMountPath: typeof runtime.config?.skillsMountPath === "string" ? runtime.config.skillsMountPath : undefined,
          mcpConfigMountPath: typeof runtime.config?.mcpConfigMountPath === "string" ? runtime.config.mcpConfigMountPath : undefined,
          resolveSecret: (id) => this.secrets().getWithValue(id)?.value,
        });
        // Local runtimes read the provisioned paths directly from the host;
        // containerized runtimes read them at the mount points.
        const provisioningEnv: Record<string, string> = { ...provisioned.env };
        if (!runtime.containerized) {
          if (provisioned.skillsHostDir) provisioningEnv[SKILLS_ENV_VAR] = provisioned.skillsHostDir;
          if (provisioned.mcpConfigHostPath) provisioningEnv[MCP_CONFIG_ENV_VAR] = provisioned.mcpConfigHostPath;
        }
        await this.runService.setExecutionExtras(runId, {
          extraMounts: provisioned.extraMounts,
          env: provisioningEnv,
          provisioning: {
            skillsHostDir: provisioned.skillsHostDir,
            skillsMountPath: provisioned.skillsMountPath,
            mcpConfigHostPath: provisioned.mcpConfigHostPath,
            mcpConfigMountPath: provisioned.mcpConfigMountPath,
          },
        });
        await this.emit(runId, "runtime.prepared", {
          runtimeId: runtime.id,
          runtimeName: runtime.name,
          runtimeKind: runtime.kind,
          containerized: Boolean(runtime.containerized),
          modelId: task.modelId,
          skills: provisioned.skills,
          mcpServers: provisioned.mcpServers,
        });
        if (provisioned.skills.length > 0 || provisioned.mcpServers.length > 0) {
          await this.emit(runId, "provisioning.prepared", {
            skills: provisioned.skills,
            mcpServers: provisioned.mcpServers,
            skillsMountPath: provisioned.skillsMountPath,
            mcpConfigMountPath: provisioned.mcpConfigMountPath,
          });
        }
      }

      /* ---- 4. Agent running (v11 §13/§15/§16) ---- */
      if (mode === "full") {
        this.assertNotCancelled(taskId);
        // A cancel that landed during preparation may already have settled the
        // run record; starting the harness now would run work the user stopped.
        const pending = this.runService.get(runId);
        if (!pending || !["pending", "starting"].includes(pending.status)) {
          const cancelled = pending?.status === "cancelled";
          throw new DomainError(
            cancelled ? "agent-cancelled" : "agent-start-failed",
            cancelled ? "Cancelled by user" : `The run was already settled (${pending?.status ?? "missing"})`
          );
        }
        await this.setPhase(taskId, runId, "agent.running", "running");
        const attempt = (this.tasks().get(taskId)?.execution?.agent?.attempts ?? 0) + 1;
        await this.patchExecution(taskId, {
          agent: {
            ...(this.tasks().get(taskId)?.execution?.agent ?? { attempts: 0 }),
            status: "running",
            runId,
            attempts: attempt,
            startedAt: now(),
          },
        });
        await this.runService.executeRun(runId);
        const finished = this.runService.get(runId);
        const status = finished?.status ?? "failed";
        if (status !== "completed") {
          const agentStatus =
            status === "timeout" ? "timeout" : status === "cancelled" ? "cancelled" : "failed";
          const code =
            status === "timeout" ? "agent-timeout" : status === "cancelled" ? "agent-cancelled" : "agent-failed";
          await this.patchExecution(taskId, {
            agent: {
              ...(this.tasks().get(taskId)?.execution?.agent ?? { attempts: 0 }),
              status: agentStatus,
              runId,
              endedAt: now(),
              error: finished?.error ?? `Run ${status}`,
              errorCode: code,
            },
          });
          throw new DomainError(code, finished?.error ?? `The agent run ${status}`);
        }
        await this.patchExecution(taskId, {
          agent: {
            ...(this.tasks().get(taskId)?.execution?.agent ?? { attempts: 0 }),
            status: "completed",
            runId,
            endedAt: now(),
          },
        });
      }

      /* ---- 5. Validation (v11 §20) ---- */
      if (mode !== "publish-only") {
        await this.runValidationStage({ task, runId, project, workspace, redactor });
      }

      /* ---- 6. Git finalization (v11 §17) ---- */
      await this.setPhase(taskId, runId, "git.finalizing", "finalizing");
      const finalization = await this.finalizeGit({ task, runId, project, workspace, redactor, git });
      await this.patchExecution(taskId, {
        baseCommitSha: finalization.baseCommitSha,
        publish: {
          ...(this.tasks().get(taskId)?.execution?.publish ?? { status: "pending", attempts: 0 }),
          baseCommitSha: finalization.baseCommitSha,
          finalCommitSha: finalization.finalCommitSha,
        },
      });

      /* ---- 7. Publishing (v11 §18) ---- */
      const policy = this.effectiveGitPolicy(project, task.git);
      if (policy.push === false) {
        await this.patchExecution(taskId, {
          publish: {
            ...(this.tasks().get(taskId)?.execution?.publish ?? { status: "pending", attempts: 0 }),
            status: "skipped",
          },
        });
      } else {
        await this.setPhase(taskId, runId, "git.pushing", "publishing");
        await this.publish({ task, runId, project, workspace, redactor, finalCommitSha: finalization.finalCommitSha, git });
      }
    } catch (err) {
      const domain = asDomainError(err, "internal-error");
      failure = {
        stage: domain.stage,
        code: domain.code,
        message: redactor.redact(domain.message),
        at: now(),
      };
      // A cancellation that landed before the harness started still has to be
      // reported as a cancellation, not as an agent failure (v11 §32).
      if (domain.code === "agent-cancelled") {
        const current = this.tasks().get(taskId)?.execution?.agent;
        await this.patchExecution(taskId, {
          agent: { ...(current ?? { attempts: 0 }), status: "cancelled", runId, endedAt: now(), error: failure.message, errorCode: failure.code },
        });
      }
      await this.emit(runId, domain.code === "agent-cancelled" ? "run.cancelled" : "run.failed", {
        error: failure.message,
        code: failure.code,
        stage: failure.stage,
      });
      if (domain.stage === "publish") {
        await this.emit(runId, "publish.failed", { error: failure.message, code: failure.code });
      } else if (domain.stage === "validation") {
        await this.emit(runId, "validation.failed", { error: failure.message, code: failure.code });
      }
    } finally {
      /* ---- 8. Cleanup (v11 §9/§29/§32) ---- */
      try {
        await this.setPhase(taskId, runId, "cleanup", this.tasks().get(taskId)?.execution?.status ?? "failed");
        await this.runService.clearExecutionExtras(runId);
        if (provisioned) {
          await provisioned.cleanup();
          await this.emit(runId, "provisioning.cleaned", { skills: provisioned.skills, mcpServers: provisioned.mcpServers });
        }
        if (lockHeld) {
          await this.locks().release(workspace!.id, runId);
          lockHeld = false;
        }
        await this.emit(runId, "log", { line: "workspace preserved", kind: "workspace-preserved" });
      } catch {
        /* cleanup is best effort; the workspace must never be at risk */
      }
    }

    // Terminal state, written once: a failed publish keeps the development
    // result visible (v11 §23).
    const finalTask = this.tasks().get(taskId);
    const cancelled =
      failure?.code === "agent-cancelled" || finalTask?.execution?.agent?.status === "cancelled";
    await this.patchExecution(taskId, {
      phase: failure ? (cancelled ? "cancelled" : "failed") : "completed",
      status: failure ? (cancelled ? "cancelled" : "failed") : "completed",
      failure,
    });
    const finalRun = this.runService.get(runId);
    if (finalRun) {
      await this.store.update<Run>("runs", runId, {
        phase: failure ? (cancelled ? "cancelled" : "failed") : "completed",
        updatedAt: now(),
      });
    }
    this.redactors.delete(runId);
    this.lifecycleAborts.delete(taskId);
  }

  /* ---------------- stages ---------------- */

  private async prepareWorkspaceDirectory(workspace: Workspace): Promise<void> {
    const path = workspace.path!;
    try {
      await mkdir(path, { recursive: true });
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error("path is not a directory");
    } catch (err) {
      throw new DomainError(
        "workspace-create-failed",
        `Could not prepare the workspace directory: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Source preparation (v11 §11): clone or fetch, resolve the base revision,
   * create or check out the working branch, and record the revision the task
   * actually started from. The credential exists only inside this call.
   */
  private async prepareSource(opts: {
    task: Task;
    runId: ID;
    project: Project;
    workspace: Workspace;
    redactor: SecretRedactor;
    credentialInput: ReturnType<SourceCredentialService["resolve"]>;
    git: GitOps;
  }): Promise<void> {
    const { task, runId, project, workspace, redactor, git } = opts;
    const dir = workspace.path!;
    const remoteUrl = project.source.remoteUrl;
    const baseRef = task.baseRef || project.source.defaultBranch || "main";
    const workingBranch = task.workingBranch!;
    const branchMode = task.branchMode ?? "new";
    const firstPreparation = !task.baseCommitSha;

    await this.setPhase(task.id, runId, "source.fetching", "preparing");
    const credentialDir = gitCredentialTempRoot(this.store.dataDir, "source");
    let credential: MaterializedCredential | undefined;
    try {
      if (opts.credentialInput) {
        credential = await materializeGitCredential(opts.credentialInput, credentialDir);
        redactor.addAll(credential.secrets);
        const view = project.source.credentialId ? this.credentials().getView(project.source.credentialId) : undefined;
        await this.emit(runId, "credential.resolved", {
          credentialId: view?.id,
          type: view?.type,
          host: view?.host,
          username: view?.username,
          scope: "source-preparation",
        });
      }

      const isRepo = await git.isRepository({ dir });
      if (isRepo) {
        await git.setRemoteUrl({ dir, url: remoteUrl });
        await git.fetch({ dir, remoteUrl, credential, timeoutMs: this.gitTimeoutMs, redactor });
      } else {
        await this.assertDirectoryEmpty(dir);
        await git.clone({ remoteUrl, dest: dir, credential, timeoutMs: this.gitTimeoutMs, redactor });
      }

      await this.setPhase(task.id, runId, "source.checkout", "preparing");
      // The revision the task starts from: resolved once, then frozen
      // (v11 §7 — `main` moves, a commit SHA does not). In `continue` mode the
      // start revision is the existing branch's tip, not the base ref.
      let baseCommitSha: string;
      if (firstPreparation) {
        const baseRevision =
          branchMode === "new" ? await git.resolveRevision({ dir, ref: baseRef, credential }) : undefined;
        baseCommitSha = await this.ensureWorkingBranch({
          dir,
          remoteUrl,
          credential,
          redactor,
          workingBranch,
          branchMode,
          baseRevision,
          git,
        });
        // Freeze the resolved revision on the Task and this Run.
        await this.tasks().update(task.id, { baseCommitSha });
        await this.store.update<Run>("runs", runId, { baseCommitSha, updatedAt: now() });
        await this.patchExecution(task.id, { baseCommitSha });
      } else {
        // Reuse: the branch is ours and the base revision is already recorded.
        baseCommitSha = task.baseCommitSha!;
        const current = await git.currentBranch({ dir });
        if (current !== workingBranch) await git.checkout({ dir, ref: workingBranch });
      }
      const head = await git.head({ dir });
      if (!head) throw new DomainError("git-state-invalid", "The workspace has no commit checked out");
      const currentBranch = await git.currentBranch({ dir });
      if (currentBranch !== workingBranch) {
        throw new DomainError("git-state-invalid", `The workspace is on "${currentBranch ?? "(detached)"}" instead of "${workingBranch}"`);
      }
      await this.emit(runId, "source.prepared", {
        remoteUrl: project.source.remoteUrl,
        provider: project.source.provider,
        baseRef,
        baseCommitSha,
        workingBranch,
        branchMode,
        head,
        firstPreparation,
      });
    } finally {
      if (credential) {
        await credential.cleanup();
        await this.emit(runId, "credential.released", { scope: "source-preparation" });
      } else {
        await rm(credentialDir, { recursive: true, force: true });
      }
    }
  }

  /** A non-empty directory that is not a repository must not be clobbered. */
  private async assertDirectoryEmpty(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir);
      if (entries.length > 0) {
        throw new DomainError("workspace-invalid", `The workspace directory is not empty and is not a git repository: ${dir}`);
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError("workspace-invalid", `Could not read the workspace directory: ${dir}`);
    }
  }

  /**
   * Puts the workspace on the task's working branch and returns the revision
   * the task actually starts from. Idempotent: on the first preparation the
   * branch is created (or, in `continue` mode, checked out); afterwards it is
   * the caller's job to reuse it.
   */
  private async ensureWorkingBranch(opts: {
    dir: string;
    remoteUrl: string;
    credential?: MaterializedCredential;
    redactor: SecretRedactor;
    workingBranch: string;
    branchMode: "new" | "continue";
    /** Resolved base revision (branch mode `new` only). */
    baseRevision?: string;
    git: GitOps;
  }): Promise<string> {
    const { dir, remoteUrl, credential, redactor, workingBranch, branchMode, baseRevision, git } = opts;
    const localExists = await git.branchExists({ dir, branch: workingBranch });
    const remoteSha = await git.remoteBranchSha({
      dir,
      remoteUrl,
      branch: workingBranch,
      credential,
      timeoutMs: this.gitTimeoutMs,
      redactor,
    });

    if (branchMode === "new") {
      if (!baseRevision) throw new DomainError("base-ref-not-found", "No base revision was resolved for the working branch");
      // Never silently overwrite an existing branch, local or remote (v11 §8.1).
      if (localExists) throw new DomainError("branch-conflict", `The branch "${workingBranch}" already exists in the workspace`);
      if (remoteSha) throw new DomainError("branch-conflict", `The branch "${workingBranch}" already exists on the remote`);
      await git.createBranch({ dir, branch: workingBranch, startPoint: baseRevision });
      const head = await git.head({ dir });
      return head ?? baseRevision;
    }

    if (localExists) {
      await git.checkout({ dir, ref: workingBranch });
    } else if (remoteSha) {
      await git.createBranch({ dir, branch: workingBranch, startPoint: `refs/remotes/origin/${workingBranch}` });
    } else {
      throw new DomainError(
        "branch-not-found",
        `Branch mode "continue" needs the branch "${workingBranch}" to exist, locally or on the remote`
      );
    }
    const head = await git.head({ dir });
    if (!head) throw new DomainError("git-state-invalid", `The branch "${workingBranch}" has no commit`);
    return head;
  }

  /** Validation stage (v11 §20): its own outcome, its own retry. */
  private async runValidationStage(opts: {
    task: Task;
    runId: ID;
    project: Project;
    workspace: Workspace;
    redactor: SecretRedactor;
  }): Promise<void> {
    const { task, runId, project, workspace, redactor } = opts;
    const steps: ValidationStep[] = resolveValidationConfig(task.validation, project.validation);
    if (steps.length === 0) {
      await this.patchExecution(task.id, {
        validation: {
          ...(this.tasks().get(task.id)?.execution?.validation ?? { attempts: 0 }),
          status: "skipped",
          steps: [],
          endedAt: now(),
        },
      });
      return;
    }
    await this.setPhase(task.id, runId, "validation.running", "validating");
    const attempts = (this.tasks().get(task.id)?.execution?.validation?.attempts ?? 0) + 1;
    await this.patchExecution(task.id, {
      validation: { status: "running", attempts, startedAt: now(), steps: [] },
    });
    await this.emit(runId, "validation.started", { steps: steps.map((s) => ({ name: s.name, command: s.command })) });

    const result = await this.validationRunner({
      cwd: workspace.path!,
      steps,
      env: task.env,
      onStepStart: async (step) => {
        await this.emit(runId, "shell.command", { command: step.command, cwd: workspace.path, validation: step.name });
        await this.emit(runId, "validation.step", { name: step.name, status: "running", command: step.command });
      },
      onOutput: async (step, chunk, stream) => {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          await this.emit(runId, "shell.output", { line: redactor.redact(line), stream, validation: step.name });
        }
      },
    });

    const stepsOutcome = result.steps.map((s) => ({ ...s, output: s.output ? redactor.redact(s.output) : s.output }));
    await this.patchExecution(task.id, {
      validation: {
        status: result.status,
        attempts,
        steps: stepsOutcome,
        error: result.error ? redactor.redact(result.error) : undefined,
        errorCode: result.errorCode,
        endedAt: now(),
      },
    });
    // A validation report is an artifact of the run, so the Task view and the
    // Run Inspector show the same evidence.
    await this.artifacts().create({
      runId,
      name: "validation-report.txt",
      kind: "test",
      content: stepsOutcome
        .map((s) => `# ${s.name} (${s.status}${s.exitCode != null ? `, exit ${s.exitCode}` : ""})\n$ ${s.command}\n${s.output ?? ""}`)
        .join("\n\n"),
      meta: { status: result.status, steps: stepsOutcome.map((s) => ({ name: s.name, status: s.status })) },
    });
    if (result.status !== "passed") {
      throw new DomainError(
        result.errorCode ?? "validation-failed",
        result.error ? redactor.redact(result.error) : "Validation failed"
      );
    }
    await this.emit(runId, "validation.passed", {
      steps: stepsOutcome.map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs })),
    });
  }

  /**
   * Git finalization (v11 §17): inspect the repository state, then commit what
   * the agent left uncommitted according to policy. Agent-created commits are
   * never squashed, reordered or discarded — a final commit is only *added*
   * when dirty changes remain.
   */
  private async finalizeGit(opts: {
    task: Task;
    runId: ID;
    project: Project;
    workspace: Workspace;
    redactor: SecretRedactor;
    git: GitOps;
  }): Promise<{ finalCommitSha: string; baseCommitSha: string; status: GitStatus; agentCommits: string[]; committed: boolean }> {
    const { task, runId, project, workspace, git } = opts;
    const dir = workspace.path!;
    const policy = this.effectiveGitPolicy(project, task.git);
    const branch = await git.currentBranch({ dir });
    if (!branch || branch !== task.workingBranch) {
      throw new DomainError(
        "git-state-invalid",
        `The workspace is on "${branch ?? "(detached)"}" instead of the task branch "${task.workingBranch}"`
      );
    }
    const baseCommitSha = task.baseCommitSha ?? (await git.head({ dir }));
    if (!baseCommitSha) throw new DomainError("git-state-invalid", "The workspace has no commit to finalize from");
    const status = await git.status({ dir });
    const headBefore = await git.head({ dir });
    const agentCommits = await git.commitsBetween({ dir, from: baseCommitSha, to: headBefore ?? "HEAD" });

    let finalCommitSha = headBefore ?? baseCommitSha;
    let committed = false;
    if (!status.clean && policy.autoCommit) {
      await git.stageAll({ dir });
      const message = this.commitMessage(policy, task);
      finalCommitSha = await git.commit({
        dir,
        message,
        author:
          policy.commitAuthorName && policy.commitAuthorEmail
            ? { name: policy.commitAuthorName, email: policy.commitAuthorEmail }
            : undefined,
      });
      committed = true;
    }
    await this.emit(runId, "git.finalized", {
      branch,
      baseCommitSha,
      finalCommitSha,
      agentCommits: agentCommits.length,
      committedFinal: committed,
      dirtyBefore: { staged: status.staged, unstaged: status.unstaged, untracked: status.untracked },
      autoCommit: Boolean(policy.autoCommit),
      remote: policy.remote,
    });
    return { finalCommitSha, baseCommitSha, status, agentCommits, committed };
  }

  private commitMessage(policy: ResolvedGitPolicy, task: Task): string {
    const template = policy.commitMessage || "af: {title}";
    return template
      .replace(/\{title\}/g, task.title)
      .replace(/\{task\}/g, task.id)
      .replace(/\{branch\}/g, task.workingBranch ?? "");
  }

  /**
   * Publishing (v11 §18/§23/§37). Only this Task's working branch, never
   * force, never a protected branch. An uncertain push is resolved by asking
   * the remote what it actually has.
   */
  private async publish(opts: {
    task: Task;
    runId: ID;
    project: Project;
    workspace: Workspace;
    redactor: SecretRedactor;
    finalCommitSha: string;
    git: GitOps;
  }): Promise<void> {
    const { task, runId, project, workspace, redactor, finalCommitSha, git } = opts;
    const dir = workspace.path!;
    const policy = this.effectiveGitPolicy(project, task.git);
    const branch = task.workingBranch!;
    const branchCheck = validateBranchName(branch);
    if (!branchCheck.ok) throw new DomainError("branch-invalid", branchCheck.reason);
    if (policy.protectedBranches.includes(branch)) {
      throw new DomainError("policy-denied", `Refusing to publish the protected branch "${branch}"`);
    }
    const remote = policy.remote;
    const previous = this.tasks().get(task.id)?.execution?.publish;
    /**
     * Whether this task may advance a branch that already exists on the
     * remote. Two cases: the branch is the one this task already published
     * (a retry, or a new run on the same working branch), or the task was
     * explicitly created in `continue` mode on top of an existing branch
     * (v11 §8.1). Anything else is somebody else's branch.
     */
    const everPushed = Boolean(previous?.pushedAt) && previous?.remoteBranch === branch;
    const mayAdvanceExisting = everPushed || task.branchMode === "continue";
    const attempts = (previous?.attempts ?? 0) + 1;

    const credentialDir = gitCredentialTempRoot(this.store.dataDir, "publish");
    let credential: MaterializedCredential | undefined;
    try {
      const credentialInput = this.credentials().resolve(project.source.credentialId);
      if (credentialInput) {
        credential = await materializeGitCredential(credentialInput, credentialDir);
        redactor.addAll(credential.secrets);
      }
      // Idempotency (v11 §37): a push that already landed — a retry, or a
      // timeout whose request actually succeeded — is detected from the remote.
      const remoteSha = await git.remoteBranchSha({
        dir,
        remoteUrl: project.source.remoteUrl,
        branch,
        credential,
        timeoutMs: this.gitTimeoutMs,
        redactor,
      });
      if (remoteSha && remoteSha === finalCommitSha) {
        await this.recordPublish(task, {
          status: "pushed",
          remoteBranch: branch,
          remote,
          finalCommitSha,
          attempts,
        });
        await this.emit(runId, "git.pushed", { branch, remote, commitSha: finalCommitSha, alreadyPresent: true });
        return;
      }
      if (remoteSha && !mayAdvanceExisting) {
        throw new DomainError(
          "remote-branch-conflict",
          `The remote branch "${branch}" already exists (${remoteSha.slice(0, 8)}) and was not created by this task`,
          `use branch mode "continue" to build on it explicitly`
        );
      }
      try {
        await git.push({ dir, remote, branch, credential, timeoutMs: this.gitTimeoutMs, redactor });
      } catch (err) {
        // A failed push may still have landed; ask the remote before failing.
        const after = await this.git
          .remoteBranchSha({ dir, remoteUrl: project.source.remoteUrl, branch, credential, timeoutMs: this.gitTimeoutMs, redactor })
          .catch(() => undefined);
        if (after === finalCommitSha) {
          await this.recordPublish(task, {
            status: "pushed",
            remoteBranch: branch,
            remote,
            finalCommitSha,
            attempts,
          });
          await this.emit(runId, "git.pushed", { branch, remote, commitSha: finalCommitSha, recoveredFromError: true });
          return;
        }
        throw err;
      }
      const confirmed = await this.git
        .remoteBranchSha({ dir, remoteUrl: project.source.remoteUrl, branch, credential, timeoutMs: this.gitTimeoutMs, redactor })
        .catch(() => undefined);
      if (confirmed && confirmed !== finalCommitSha) {
        throw new DomainError("git-push-failed", `The remote branch "${branch}" is at ${confirmed.slice(0, 8)} after the push`);
      }
      await this.recordPublish(task, {
        status: "pushed",
        remoteBranch: branch,
        remote,
        finalCommitSha,
        attempts,
      });
      await this.emit(runId, "git.pushed", { branch, remote, commitSha: finalCommitSha, baseCommitSha: task.baseCommitSha });
    } catch (err) {
      // Record the failed attempt here, where the attempt number is known, so
      // a retry's accounting stays truthful (v11 §17.2).
      const domain = asDomainError(err, "git-push-failed");
      const redacted = redactor.redact(domain.message);
      const current = this.tasks().get(task.id)?.execution?.publish;
      await this.patchExecution(task.id, {
        publish: {
          ...(current ?? { status: "pending", attempts: 0 }),
          status: "failed",
          remoteBranch: branch,
          remote,
          finalCommitSha,
          attempts,
          error: redacted,
          errorCode: domain.code,
        },
      });
      throw new DomainError(domain.code, redacted);
    } finally {
      if (credential) {
        await credential.cleanup();
        await this.emit(runId, "credential.released", { scope: "publish" });
      } else {
        await rm(credentialDir, { recursive: true, force: true });
      }
    }
  }

  private async recordPublish(
    task: Task,
    input: { status: TaskPublishState["status"]; remoteBranch: string; remote: string; finalCommitSha: string; attempts: number }
  ): Promise<void> {
    const current = this.tasks().get(task.id)?.execution?.publish;
    await this.patchExecution(task.id, {
      publish: {
        ...(current ?? { status: "pending", attempts: 0 }),
        status: input.status,
        remoteBranch: input.remoteBranch,
        remote: input.remote,
        finalCommitSha: input.finalCommitSha,
        baseCommitSha: task.baseCommitSha ?? current?.baseCommitSha,
        pushedAt: now(),
        attempts: input.attempts,
        error: undefined,
        errorCode: undefined,
      },
    });
  }

  /* ---------------- helpers ---------------- */

  /**
   * The git operations bound to one lifecycle's abort signal, so cancelling a
   * task kills a clone or a push that is still running (v11 §32). The bound
   * object is a thin wrapper: every method receives the same options object
   * plus the signal.
   */
  private gitFor(signal: AbortSignal): GitOps {
    const source = this.git as unknown as Record<string, unknown>;
    const bound: Record<string, unknown> = { bin: this.git.bin };
    for (const method of GIT_OPS_METHODS) {
      bound[method] = (opts: Record<string, unknown>) =>
        (source[method] as (o: unknown) => unknown).call(this.git, { ...opts, signal });
    }
    return bound as unknown as GitOps;
  }

  private effectiveGitPolicy(project: Project, taskPolicy?: GitPublishPolicy): ResolvedGitPolicy {
    const merged: GitPublishPolicy = { ...(project.git ?? {}), ...(taskPolicy ?? {}) };
    return {
      autoCommit: merged.autoCommit ?? DEFAULT_GIT_POLICY.autoCommit,
      push: merged.push ?? DEFAULT_GIT_POLICY.push,
      remote: merged.remote || DEFAULT_GIT_POLICY.remote,
      protectedBranches: merged.protectedBranches ?? DEFAULT_GIT_POLICY.protectedBranches,
      commitMessage: merged.commitMessage,
      commitAuthorName: merged.commitAuthorName,
      commitAuthorEmail: merged.commitAuthorEmail,
    };
  }

  private mergeEnv(project: Project, taskEnv?: Record<string, string>): Record<string, string> | undefined {
    const merged = { ...(project.execution?.env ?? {}), ...(taskEnv ?? {}) };
    return Object.keys(merged).length ? merged : undefined;
  }

  /**
   * Runtime resolution (v11 §24): explicit task override > project default >
   * the first enabled runtime usable in tasks.
   */
  private resolveRuntime(project: Project, explicit?: ID): Runtime {
    const id = explicit ?? project.execution?.runtimeId;
    const runtime = id ? this.runtimes().get(id) : undefined;
    if (runtime) return runtime;
    if (id) throw new DomainError("runtime-create-failed", `Runtime not found: ${id}`);
    const fallback = this.runtimes().enabled().find((r) => r.usableInTask);
    if (!fallback) throw new DomainError("runtime-create-failed", "No runtime is enabled and usable for tasks");
    return fallback;
  }

  /** Model resolution: harness-native runtimes keep their own model (v6 §3). */
  private resolveModelId(project: Project, runtime: Runtime, explicit?: ID): ID | undefined {
    if (this.isHarnessNative(runtime)) return undefined;
    return (
      explicit ??
      project.execution?.modelId ??
      runtime.defaultModelId ??
      this.models().list().find((m) => m.enabled)?.id
    );
  }

  private isHarnessNative(runtime: Runtime): boolean {
    if (runtime.credentialSource === "harness-native") return true;
    if (runtime.credentialSource === "agentfabric") return false;
    return this.runService.adapterFor(runtime.kind)?.credentialSource === "harness-native";
  }

  private activeRun(taskId: ID): Run | undefined {
    return this.runService.forTask(taskId).find((r) => this.isRunActive(r.id));
  }

  private isRunActive(runId: ID): boolean {
    const run = this.runService.get(runId);
    return Boolean(run && ["pending", "starting", "running"].includes(run.status));
  }

  private latestRun(taskId: ID): Run | undefined {
    const runs = this.runService.forTask(taskId);
    return runs[runs.length - 1];
  }

  /** The run lifecycle events are attached to when no agent run is active. */
  private eventRunId(task: Task): ID | undefined {
    return task.execution?.agent?.runId ?? this.latestRun(task.id)?.id;
  }

  private assertNotRunning(task: Task): void {
    if (this.isRunning(task.id)) throw new DomainError("task-busy", `Task ${task.id} is already running`);
    if (this.activeRun(task.id)) throw new DomainError("task-busy", `Task ${task.id} has a run in flight`);
  }

  /** Stops a lifecycle whose task was cancelled while it was preparing. */
  private assertNotCancelled(taskId: ID): void {
    if (this.cancelRequested.has(taskId)) throw new DomainError("agent-cancelled", "Cancelled by user");
  }

  private assertWorkspacePresent(task: Task): void {
    const workspace = task.workspaceId ? this.workspaces().get(task.workspaceId) : undefined;
    if (!workspace?.path) throw new DomainError("workspace-invalid", "This task has no workspace to continue in");
  }

  private stageForPhase(phase: RunPhase): FailureStage {
    switch (phase) {
      case "workspace.preparing":
        return "workspace";
      case "source.fetching":
      case "source.checkout":
        return "source";
      case "runtime.preparing":
        return "runtime";
      case "validation.running":
        return "validation";
      case "git.finalizing":
        return "finalization";
      case "git.pushing":
        return "publish";
      default:
        return "agent";
    }
  }

  private async patchExecution(taskId: ID, patch: Partial<TaskExecution>): Promise<Task | undefined> {
    const task = this.tasks().get(taskId);
    if (!task) return undefined;
    const base: TaskExecution =
      task.execution ?? {
        phase: "task.created",
        status: "created",
        updatedAt: now(),
      };
    return this.store.update<Task>("tasks", taskId, {
      execution: { ...base, ...patch, updatedAt: now() },
    });
  }

  private async setPhase(taskId: ID, runId: ID, phase: RunPhase, status: TaskExecution["status"]): Promise<void> {
    await this.patchExecution(taskId, { phase, status });
    await this.store.update<Run>("runs", runId, { phase, updatedAt: now() });
    await this.emit(runId, "run.phase", { phase, status });
  }

  /**
   * Persists a lifecycle event on the run's shard and fans it out on the bus.
   * Every payload is redacted: nothing that reaches the event log can contain
   * credential material (v11 §34).
   */
  private async emit(runId: ID, type: RunEvent["type"], data: Record<string, unknown>): Promise<void> {
    const redactor = this.redactors.get(runId);
    const event: RunEvent = {
      id: newId("evt"),
      runId,
      seq: this.store.nextSeq(),
      type,
      timestamp: now(),
      data: redactor ? redactor.redactValue(data) : data,
      source: "supervisor",
    };
    await this.store.appendEvent(event);
    const run = this.store.get<Run>("runs", runId);
    if (run) {
      run.eventCount += 1;
      run.updatedAt = now();
      await this.store.commit();
    }
    this.bus.publish(event);
  }
}
