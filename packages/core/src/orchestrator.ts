import { Store, newId } from "./store.js";
import { EventBus } from "./eventbus.js";
import { existsSync } from "node:fs";
import {
  ArtifactService,
  ModelService,
  NativeStateService,
  ProfileService,
  ProviderService,
  RuntimeService,
  RuntimeSessionService,
  SecretService,
  TaskService,
  WorkspaceService,
  now,
  sameResumeWorkspace,
  type NewTaskInput,
} from "./services.js";
import { HandoffService, buildAssistedHandoffContent, renderHandoffPrompt } from "./handoff.js";
import {
  ContainerLeaseManager,
  DEFAULT_KEEP_ALIVE_IDLE_MS,
  normalizeLifecycle,
  recoverKeepAliveContainers,
  resolveLifecycle,
  type ContainerOps,
} from "./lifecycle.js";
import { addUsage, emptyUsage, estimateCost } from "./cost.js";
import {
  effectiveCapabilities,
  type ArtifactDraft,
  type AgentRuntimeAdapter,
  type ReusableContainer,
  type RuntimeContext,
  type RuntimeRegistry,
  type RuntimeResult,
} from "./runtime.js";
import type {
  Artifact,
  EventType,
  ExecutionPolicy,
  Handoff,
  HandoffContent,
  ID,
  LogLevel,
  Model,
  Provider,
  Run,
  RunContinuity,
  RunEvent,
  Runtime,
  RuntimeCapability,
  RuntimeLifecycle,
  RuntimeNativeState,
  RuntimeSessionRef,
  Secret,
  Task,
  Usage,
  Workspace,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min safety net

/* ------------------------------------------------------------------ */
/* Resume compatibility (v3 §13–§15)                                    */
/* ------------------------------------------------------------------ */

export interface ResumeCompatibility {
  compatible: boolean;
  /** Human-readable explanation, used verbatim in continuation results. */
  reason: string;
}

/**
 * Native resume requires *all* of (v3 §13):
 * 1. same harness,
 * 2. runtime capability supports native resume under the execution
 *    backend actually in use (v3 §16/§17),
 * 3. a valid, active RuntimeSessionRef,
 * 4. the corresponding Runtime Native State — for a containerized target
 *    the session's state record must exist and its directory must be on
 *    disk; a session created on the other backend cannot be attached
 *    (its state lives where the target run cannot read it),
 * 5. the same workspace (v3 §14: native sessions are bound to their
 *    working context).
 *
 * The checks are named and ordered so future dimensions (runtime
 * version, harness version, native-state version, model, runtime
 * configuration — v3 §15) slot in without changing the contract.
 */
function evaluateResumeCompatibility(
  ref: RuntimeSessionRef,
  target: Runtime,
  caps: RuntimeCapability,
  workspaceId: ID | undefined,
  nativeStates: NativeStateService
): ResumeCompatibility {
  // 1. Same harness.
  if (ref.runtimeKind !== target.kind) {
    return { compatible: false, reason: `different harness (${ref.runtimeKind} → ${target.kind})` };
  }
  // 2. Capability under the backend actually in use.
  if (!caps.supportsNativeResume) {
    return { compatible: false, reason: `${target.name} does not support native resume under the current execution mode` };
  }
  // 3. Valid reference.
  if (ref.status !== "active" || !ref.resumeSupported) {
    return { compatible: false, reason: `native session reference ${ref.nativeSessionRef} is not resumable` };
  }
  // 4. Corresponding runtime native state.
  if (target.containerized) {
    const state = ref.nativeStateId ? nativeStates.get(ref.nativeStateId) : undefined;
    if (!state || !existsSync(state.path)) {
      return {
        compatible: false,
        reason: `no runtime native state behind session ${ref.nativeSessionRef} — it cannot survive a container`,
      };
    }
  } else if (ref.nativeStateId || ref.executionBackend === "docker") {
    return {
      compatible: false,
      reason: `session ${ref.nativeSessionRef} lives in containerized native state; resume it with a containerized runtime`,
    };
  }
  // 5. Same workspace.
  if (!sameResumeWorkspace(ref.workspaceId, workspaceId)) {
    return {
      compatible: false,
      reason: `workspace changed (${ref.workspaceId ?? "none"} → ${workspaceId ?? "none"}); native sessions stay bound to their workspace`,
    };
  }
  return { compatible: true, reason: `same harness (${target.kind}) + same workspace + native state available` };
}

/**
 * Everything needed to materialize one Run under an existing Task
 * (submit creates its own Task; continuation passes overrides here).
 */
interface RunSpec {
  title?: string;
  runtimeId?: ID;
  modelId?: ID;
  workspaceId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: ID[];
  tools?: string[];
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  inputInstruction?: string;
  continuity?: RunContinuity;
  previousHandoffId?: ID;
  runtimeSessionRefId?: ID;
  lifecycle?: RuntimeLifecycle;
}

/**
 * Aborts a run when its cumulative usage crosses an ExecutionPolicy
 * budget (model calls, tokens or cost). Best-effort: the abort signal is
 * observed by runtime adapters at their next await point.
 */
function enforcePolicyLimits(
  policy: ExecutionPolicy | undefined,
  usage: Usage,
  abort: (message: string) => void
): void {
  if (!policy) return;
  if (policy.maxModelCalls !== undefined && usage.modelRequests >= policy.maxModelCalls) {
    abort(`Policy limit exceeded: max model calls (${usage.modelRequests}/${policy.maxModelCalls})`);
    return;
  }
  if (policy.maxTokens !== undefined) {
    const tokens = usage.inputTokens + usage.outputTokens + (usage.cachedTokens ?? 0);
    if (tokens >= policy.maxTokens) {
      abort(`Policy limit exceeded: max tokens (${tokens}/${policy.maxTokens})`);
      return;
    }
  }
  if (policy.maxCost !== undefined && (usage.estimatedCost ?? 0) >= policy.maxCost) {
    abort(`Policy limit exceeded: max cost ($${(usage.estimatedCost ?? 0).toFixed(6)}/$${policy.maxCost.toFixed(6)})`);
  }
}

export interface SubmitResult {
  task: Task;
  run: Run;
}

/** Input for continuing an existing Task (spec v1 §15/§18/§20). */
export interface ContinueTaskInput {
  prompt: string;
  title?: string;
  /** Target runtime. Defaults to the task's runtime / the latest run's runtime. */
  runtimeId?: ID;
  modelId?: ID;
  /** Force `resume` or `handoff`; default `auto` decides by harness + capability. */
  mode?: "auto" | "resume" | "handoff";
  /** Extra user notes folded into the handoff (spec v1 §7 User-provided). */
  userNotes?: string;
  lifecycle?: RuntimeLifecycle;
  workspaceId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: ID[];
  tools?: string[];
  timeoutMs?: number;
  policy?: ExecutionPolicy;
}

export interface ContinueResult {
  task: Task;
  run: Run;
  continuity: RunContinuity;
  /** Handoff created/used for this continuation (handoff continuity only). */
  handoff?: Handoff;
  /** Native session resumed by this run (resume continuity only). */
  runtimeSessionRef?: RuntimeSessionRef;
  /** Human-readable explanation of the resume-vs-handoff decision. */
  explanation: string;
}

/** Preview of what continuing a Task would do (spec v1 §18: clear UX). */
export interface ContinueOptions {
  task: Task;
  latestRun?: Run;
  currentRuntime?: { id: ID; name: string; kind: string };
  targetRuntime?: { id: ID; name: string; kind: string; capabilities: RuntimeCapability };
  resumeAvailable: boolean;
  suggestedMode: "resume" | "handoff";
  suggestedContinuity: RunContinuity;
  resumableSession?: RuntimeSessionRef;
  /** What the assisted handoff would look like (not persisted). */
  handoffPreview?: HandoffContent;
  explanation: string;
}

export class RunService {
  private controllers = new Map<string, { controller: AbortController; reason: "cancel" | "timeout" | "policy" }>();
  private active = new Map<string, Promise<void>>();
  private leaseManager: ContainerLeaseManager;

  constructor(
    private store: Store,
    private bus: EventBus,
    private registry: RuntimeRegistry,
    private containerOps: ContainerOps = { destroy: async () => {} }
  ) {
    this.leaseManager = new ContainerLeaseManager(containerOps, {
      onDestroyed: async (lease) => {
        await this.emitRunEvent(lease.runId, "container.destroyed", {
          containerId: lease.containerId,
          reason: "idle-timeout",
          runtimeId: lease.runtimeId,
        });
      },
    });
  }

  /* ---------------- public API ---------------- */

  list(): Run[] {
    return this.store
      .list<Run>("runs")
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Run | undefined {
    return this.store.get<Run>("runs", id);
  }

  forTask(taskId: string): Run[] {
    return this.store
      .list<Run>("runs")
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  events(runId: string): RunEvent[] {
    return this.store
      .list<RunEvent>("events")
      .filter((e) => e.runId === runId)
      .sort((a, b) => a.seq - b.seq);
  }

  logs(runId: string): string[] {
    return this.events(runId)
      .filter((e) => e.type === "log" || e.type === "shell.output" || e.type === "agent.message")
      .map((e) => {
        const line = String(e.data?.line ?? e.data?.message ?? e.data?.text ?? e.data?.content ?? "");
        const prefix = e.type === "agent.message" ? "[agent] " : e.type === "shell.output" ? "[shell] " : "";
        return prefix + line;
      });
  }

  /** Kept keep-alive containers (for API/UI inspection). */
  keptContainers() {
    return this.leaseManager.list();
  }

  /**
   * Re-arm keep-alive destroy timers from container labels after a
   * server restart so retained containers never leak.
   */
  async recoverKeepAliveContainers(): Promise<void> {
    if (!this.containerOps.listKeepAlive) return;
    await recoverKeepAliveContainers(this.leaseManager, await this.containerOps.listKeepAlive());
  }

  async submit(input: NewTaskInput): Promise<SubmitResult> {
    const resolved = await this.resolveTask(input);
    const task = await this.taskService().create(resolved);
    const run = await this.createRun(task, {
      continuity: "new",
      inputInstruction: task.prompt,
      lifecycle: resolved.lifecycle,
    });
    void this.execute(run.id);
    return { task, run };
  }

  /**
   * Continue an existing Task (spec v1 §15/§20).
   *
   * Same harness → native Resume (when the harness declares the
   * capability and a resumable session reference exists). Different
   * harness (or native resume impossible) → Handoff: a semantic work
   * handoff is generated and injected into the new harness's *new*
   * native session; the session itself is never migrated.
   */
  async continueTask(taskId: string, input: ContinueTaskInput): Promise<ContinueResult> {
    const task = this.taskService().get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!input.prompt?.trim()) throw new Error("prompt is required to continue a task");

    const previousRuns = this.forTask(taskId);
    const previousRun = previousRuns[previousRuns.length - 1];
    const target = await this.pickTargetRuntime(task, input.runtimeId);
    const adapter = this.registry.get(target.kind);
    const caps = effectiveCapabilities(adapter, target);

    // Apply the agent profile's defaults (env/secrets/policy/model),
    // overridable by the explicit continuation input.
    const profile = input.profileId ? this.profileService().get(input.profileId) : undefined;
    const mergedEnv = { ...(profile?.env ?? {}), ...(input.env ?? {}) };
    const mergedSecretIds = [...new Set([...(input.secretIds ?? []), ...(profile?.secretIds ?? [])])];
    const mergedPolicy = input.policy ?? profile?.policy;
    const modelId = input.modelId ?? profile?.modelId ?? undefined;

    const previousRuntime = previousRun?.runtimeId ? this.runtimeService().get(previousRun.runtimeId) : undefined;
    const sameHarness = previousRuntime?.kind === target.kind;
    const workspaceId = input.workspaceId ?? task.workspaceId ?? previousRun?.workspaceId;
    // The candidate lookup filters by harness; every other dimension
    // (capability, state, workspace) is decided by the compatibility
    // gate so the blocking reason is always available for the result.
    const resumable = this.runtimeSessionService().latestResumable(taskId, target.kind);
    const resumeGate = resumable
      ? evaluateResumeCompatibility(resumable, target, caps, workspaceId, this.nativeStateService())
      : undefined;
    const forcedHandoff = input.mode === "handoff";
    const resumePossible =
      sameHarness && Boolean(resumable && resumeGate?.compatible) && input.mode !== "handoff";

    if (resumePossible) {
      /* ---------------- Resume: same harness, native session ---------------- */
      const ref = resumable!;
      const run = await this.createRunFromTask(task, {
        continuity: "resume",
        inputInstruction: input.prompt,
        runtimeId: target.id,
        modelId,
        workspaceId,
        runtimeSessionRefId: ref.id,
        lifecycle: resolveLifecycle(target, input.lifecycle),
        profileId: input.profileId,
        env: Object.keys(mergedEnv).length ? mergedEnv : undefined,
        secretIds: mergedSecretIds.length ? mergedSecretIds : undefined,
        tools: input.tools,
        timeoutMs: input.timeoutMs,
        policy: mergedPolicy,
      });
      void this.execute(run.id);
      return {
        task,
        run,
        continuity: "resume",
        runtimeSessionRef: ref,
        explanation:
          `Resume: ${target.name} (${target.kind}) supports native session resume; ` +
          `continuing its native session ${ref.nativeSessionRef}. No handoff was created.`,
      };
    }

    /* ---------------- Handoff: semantic work handoff, new native session ---------------- */
    const handoff = await this.prepareHandoff(task, previousRun, previousRuntime, target, input);
    const rendered = renderHandoffPrompt(handoff, input.prompt);
    const run = await this.createRunFromTask(task, {
      continuity: "handoff",
      inputInstruction: rendered,
      runtimeId: target.id,
      modelId,
      workspaceId,
      previousHandoffId: handoff.id,
      lifecycle: resolveLifecycle(target, input.lifecycle),
      profileId: input.profileId,
      env: Object.keys(mergedEnv).length ? mergedEnv : undefined,
      secretIds: mergedSecretIds.length ? mergedSecretIds : undefined,
      tools: input.tools,
      timeoutMs: input.timeoutMs,
      policy: mergedPolicy,
    });
    void this.execute(run.id);
    const reason = forcedHandoff
      ? `Handoff requested explicitly.`
      : sameHarness
        ? `Handoff: ${target.name} cannot natively resume (${resumeGate && !resumeGate.compatible ? resumeGate.reason : resumable ? "native resume not permitted" : "no resumable session reference found"}); a new native session is created and continues from the handoff.`
        : `Handoff: switching harness ${previousRuntime?.name ?? previousRuntime?.kind ?? "(unknown)"} → ${target.name} (${target.kind}); sessions are not migrated across harnesses — the new harness starts its own new native session from the handoff.`;
    return { task, run, continuity: "handoff", handoff, explanation: reason };
  }

  /** Preview the resume/handoff decision for a task (used by UI/CLI). */
  continueOptions(taskId: string, runtimeId?: ID): ContinueOptions {
    const task = this.taskService().get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const previousRuns = this.forTask(taskId);
    const previousRun = previousRuns[previousRuns.length - 1];
    const previousRuntime = previousRun?.runtimeId ? this.runtimeService().get(previousRun.runtimeId) : undefined;
    // Same fallback order as pickTargetRuntime: explicit > task default >
    // latest run's runtime > first enabled runtime.
    const targetId = runtimeId ?? task.runtimeId ?? previousRuntime?.id ?? this.runtimeService().enabled()[0]?.id;
    const target = targetId ? this.runtimeService().get(targetId) : undefined;
    const adapter = target ? this.registry.get(target.kind) : undefined;
    const caps = effectiveCapabilities(adapter, target);
    const workspaceId = task.workspaceId ?? previousRun?.workspaceId;
    const resumable = target ? this.runtimeSessionService().latestResumable(taskId, target.kind) : undefined;
    const resumeGate = resumable && target
      ? evaluateResumeCompatibility(resumable, target, caps, workspaceId, this.nativeStateService())
      : undefined;
    const sameHarness = previousRuntime && target && previousRuntime.kind === target.kind;
    const resumeAvailable = Boolean(sameHarness && resumable && resumeGate?.compatible);
    const suggestedMode: "resume" | "handoff" = resumeAvailable ? "resume" : "handoff";

    let handoffPreview: HandoffContent | undefined;
    if (previousRun && target && !resumeAvailable) {
      const existing = previousRun.generatedHandoffId ? this.handoffService().get(previousRun.generatedHandoffId) : undefined;
      if (existing) {
        handoffPreview = existing.content;
      } else {
        handoffPreview = buildAssistedHandoffContent({
          task,
          run: previousRun,
          events: this.events(previousRun.id),
          artifacts: this.artifactService().list(previousRun.id),
          workspace: previousRun.workspaceId ? this.workspaceService().get(previousRun.workspaceId) : undefined,
          runtimeName: previousRuntime?.name,
        });
      }
    }

    const explanation = resumeAvailable
      ? `Resume: same harness (${target?.name}) with a resumable native session (${resumable?.nativeSessionRef}).`
      : previousRun
        ? target && previousRuntime?.kind !== target.kind
          ? `Handoff: harness changes ${previousRuntime?.name ?? previousRuntime?.kind ?? "(unknown)"} → ${target?.name}; no session migration, the handoff plus the shared workspace carry the context.`
          : `Handoff: ${target?.name ?? "target runtime"} cannot natively resume${resumeGate && !resumeGate.compatible ? ` (${resumeGate.reason})` : ""}; continuing via a handoff into a new native session.`
        : "New task: no previous run yet — the first run starts a fresh session.";
    const noAdapter =
      target != null && !adapter
        ? " Warning: no runtime adapter is registered for this kind — the run will fail until one is available."
        : "";

    return {
      task,
      latestRun: previousRun,
      currentRuntime: previousRuntime ? { id: previousRuntime.id, name: previousRuntime.name, kind: previousRuntime.kind } : undefined,
      targetRuntime: target ? { id: target.id, name: target.name, kind: target.kind, capabilities: caps } : undefined,
      resumeAvailable,
      suggestedMode,
      suggestedContinuity: resumeAvailable ? "resume" : previousRun ? "handoff" : "new",
      resumableSession: resumable,
      handoffPreview,
      explanation: explanation + noAdapter,
    };
  }

  /** Re-run a finished run by cloning its task. */
  async rerun(runId: string): Promise<SubmitResult> {
    const run = this.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const task = this.taskService().get(run.taskId);
    if (!task) throw new Error(`Task not found: ${run.taskId}`);
    return this.submit({
      prompt: task.prompt,
      title: task.title,
      runtimeId: task.runtimeId,
      modelId: task.modelId,
      workspaceId: task.workspaceId,
      profileId: task.profileId,
      env: task.env,
      secretIds: task.secretIds,
      tools: task.tools,
      resourceLimits: task.resourceLimits,
      timeoutMs: task.timeoutMs,
      policy: task.policy,
      lifecycle: run.lifecycle,
      metadata: task.metadata,
    });
  }

  async cancel(runId: string): Promise<Run | undefined> {
    const run = this.get(runId);
    if (!run) return undefined;
    if (!["pending", "starting", "running"].includes(run.status)) {
      return run;
    }
    const entry = this.controllers.get(runId);
    if (entry) {
      entry.reason = "cancel";
      entry.controller.abort();
    } else {
      // Not started yet — mark cancelled immediately.
      await this.finish(runId, "cancelled", "Cancelled by user", emptyUsage());
    }
    return this.get(runId);
  }

  /* ---------------- internals ---------------- */

  private taskService() {
    return new TaskService(this.store);
  }
  private artifactService() {
    return new ArtifactService(this.store);
  }
  private runtimeService() {
    return new RuntimeService(this.store);
  }
  private modelService() {
    return new ModelService(this.store);
  }
  private providerService() {
    return new ProviderService(this.store);
  }
  private workspaceService() {
    return new WorkspaceService(this.store);
  }
  private secretService() {
    return new SecretService(this.store);
  }
  private profileService() {
    return new ProfileService(this.store);
  }
  private runtimeSessionService() {
    return new RuntimeSessionService(this.store);
  }
  private nativeStateService() {
    return new NativeStateService(this.store);
  }
  private handoffService() {
    return new HandoffService(this.store);
  }

  /** Low-level event write used by lease callbacks (outside a run ctx). */
  private async emitRunEvent(runId: string, type: EventType, data: Record<string, unknown>): Promise<void> {
    const run = this.get(runId);
    const event: RunEvent = {
      id: newId("evt"),
      runId,
      seq: this.store.nextSeq(),
      type,
      timestamp: now(),
      data,
      source: "core",
    };
    await this.store.insert("events", event);
    if (run) {
      run.eventCount += 1;
      run.updatedAt = now();
      await this.store.commit();
    }
    this.bus.publish(event);
  }

  /** Resolve profile/runtime/model/workspace defaults into a concrete task. */
  private async resolveTask(input: NewTaskInput): Promise<NewTaskInput> {
    const profile = input.profileId ? this.profileService().get(input.profileId) : undefined;
    const runtimeId = input.runtimeId ?? profile?.runtimeId ?? this.runtimeService().enabled()[0]?.id;
    const runtime = runtimeId ? this.runtimeService().get(runtimeId) : undefined;
    const modelId =
      input.modelId ?? profile?.modelId ?? runtime?.defaultModelId ?? this.modelService().list().find((m) => m.enabled)?.id;

    let workspaceId = input.workspaceId;
    if (!workspaceId && profile?.workspaceConfig) {
      const ws = await this.workspaceService().ensureExists({
        name: profile.workspaceConfig.name ?? `${profile.name} workspace`,
        type: profile.workspaceConfig.type ?? "local",
        path: profile.workspaceConfig.path,
        repoUrl: profile.workspaceConfig.repoUrl,
        branch: profile.workspaceConfig.branch,
      });
      workspaceId = ws.id;
    }

    const mergedEnv: Record<string, string> = {
      ...(runtime?.env ?? {}),
      ...(profile?.env ?? {}),
      ...(input.env ?? {}),
    };
    const secretIds = [...new Set([...(input.secretIds ?? []), ...(profile?.secretIds ?? []), ...(runtime?.secretIds ?? [])])];
    const resourceLimits = input.resourceLimits ?? profile?.resourceLimits ?? runtime?.resourceLimits;
    const policy = input.policy ?? profile?.policy;
    // Task-level tools are merged into the policy's tool permissions so
    // runtime adapters can enforce them uniformly.
    const tools = [...new Set([...(policy?.toolPermissions ?? []), ...(input.tools ?? [])])];
    const mergedPolicy: ExecutionPolicy | undefined = tools.length
      ? { ...(policy ?? {}), toolPermissions: tools }
      : policy;

    return {
      ...input,
      runtimeId,
      modelId,
      workspaceId,
      env: mergedEnv,
      secretIds,
      tools,
      resourceLimits,
      policy: mergedPolicy,
    };
  }

  private async createRun(task: Task, extra: RunSpec = {}): Promise<Run> {
    return this.createRunFromTask(task, extra, task.prompt);
  }

  /** Creates a Run for an existing Task (used by submit & continueTask). */
  private async createRunFromTask(task: Task, extra: RunSpec = {}, fallbackInstruction?: string): Promise<Run> {
    const runtimeId = extra.runtimeId ?? task.runtimeId;
    const modelId = extra.modelId ?? task.modelId;
    const runtime = runtimeId ? this.runtimeService().get(runtimeId) : undefined;
    const model = modelId ? this.modelService().get(modelId) : undefined;
    const provider = model ? this.providerService().get(model.providerId) : undefined;
    const run: Run = {
      id: newId("run"),
      taskId: task.id,
      taskTitle: extra.title ?? task.title,
      status: "pending",
      runtimeId,
      runtimeName: runtime?.name,
      modelId,
      modelName: model?.alias ?? model?.name,
      providerId: provider?.id,
      workspaceId: extra.workspaceId ?? task.workspaceId,
      inputInstruction: extra.inputInstruction ?? fallbackInstruction ?? task.prompt,
      continuity: extra.continuity ?? "new",
      previousHandoffId: extra.previousHandoffId,
      runtimeSessionRefId: extra.runtimeSessionRefId,
      lifecycle: normalizeLifecycle(extra.lifecycle ?? resolveLifecycle(runtime)),
      profileId: extra.profileId,
      env: extra.env,
      secretIds: extra.secretIds,
      tools: extra.tools,
      timeoutMs: extra.timeoutMs,
      policy: extra.policy,
      artifactIds: [],
      eventCount: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.store.insert("runs", run);
    return run;
  }

  /** Target runtime for continuing a task. */
  private async pickTargetRuntime(task: Task, runtimeId?: ID): Promise<Runtime> {
    const id = runtimeId ?? task.runtimeId ?? this.forTask(task.id).find((r) => r.runtimeId)?.runtimeId;
    const runtime = id ? this.runtimeService().get(id) : undefined;
    if (!runtime) {
      const fallback = this.runtimeService().enabled()[0];
      if (!fallback) throw new Error("No enabled runtime available to continue this task");
      return fallback;
    }
    return runtime;
  }

  /**
   * Create (or reuse) the Handoff mediating a cross-session continuation:
   * prefers a harness-generated handoff attached to the previous run,
   * falls back to an AgentFabric-assisted handoff built from execution
   * records, and folds in user notes (spec v1 §7).
   */
  private async prepareHandoff(
    task: Task,
    previousRun: Run | undefined,
    previousRuntime: Runtime | undefined,
    target: Runtime,
    input: ContinueTaskInput
  ): Promise<Handoff> {
    const handoffService = this.handoffService();

    if (!previousRun) {
      // No previous run: still record a handoff so the context trail is explicit.
      const content: HandoffContent = {
        originalTask: `#${task.title}: ${task.prompt}`,
        currentObjective: input.title ?? task.title,
        notesForNextAgent: "No previous run exists; this is the task's original brief.",
      };
      return handoffService.create({
        taskId: task.id,
        fromRunId: "none",
        fromRuntimeName: previousRuntime?.name,
        fromRuntimeKind: previousRuntime?.kind,
        toRuntimeId: target.id,
        toRuntimeName: target.name,
        toRuntimeKind: target.kind,
        source: "agentfabric",
        content,
        userNotes: input.userNotes,
        workspaceId: task.workspaceId,
      });
    }

    let handoff =
      previousRun.generatedHandoffId != null ? handoffService.get(previousRun.generatedHandoffId) : undefined;

    if (!handoff) {
      const artifacts = this.artifactService().list(previousRun.id);
      const content = buildAssistedHandoffContent({
        task,
        run: previousRun,
        events: this.events(previousRun.id),
        artifacts,
        workspace: previousRun.workspaceId ? this.workspaceService().get(previousRun.workspaceId) : undefined,
        runtimeName: previousRuntime?.name,
      });
      handoff = await handoffService.create({
        taskId: task.id,
        fromRunId: previousRun.id,
        fromRuntimeId: previousRuntime?.id,
        fromRuntimeName: previousRuntime?.name,
        fromRuntimeKind: previousRuntime?.kind,
        toRuntimeId: target.id,
        toRuntimeName: target.name,
        toRuntimeKind: target.kind,
        source: "agentfabric",
        content,
        workspaceId: previousRun.workspaceId,
        artifactIds: artifacts.map((a) => a.id),
      });
      await this.emitRunEvent(previousRun.id, "handoff.generated", {
        handoffId: handoff.id,
        source: "agentfabric",
        toRuntime: target.name,
      });
      if (!previousRun.generatedHandoffId) {
        await this.store.update<Run>("runs", previousRun.id, { generatedHandoffId: handoff.id, updatedAt: now() });
      }
    }

    if (input.userNotes?.trim()) {
      handoff = (await handoffService.addUserNotes(handoff.id, input.userNotes)) ?? handoff;
    }

    // Point the handoff at the concrete target runtime.
    handoff = (await this.store.update<Handoff>("handoffs", handoff.id, {
      toRuntimeId: target.id,
      toRuntimeName: target.name,
      toRuntimeKind: target.kind,
    })) ?? handoff;
    return handoff;
  }

  private async execute(runId: string): Promise<void> {
    const prev = this.active.get(runId);
    const task = prev ?? this.runOne(runId);
    this.active.set(runId, task);
    try {
      await task;
    } finally {
      this.active.delete(runId);
    }
  }

  private async runOne(runId: string): Promise<void> {
    let run = this.get(runId);
    if (!run) return;
    const task = this.taskService().get(run.taskId);
    if (!task) {
      await this.finish(runId, "failed", "Task not found", emptyUsage());
      return;
    }

    const runtime = run.runtimeId ? this.runtimeService().get(run.runtimeId) : undefined;
    if (!runtime || !runtime.enabled) {
      await this.finish(runId, "failed", `Runtime not found or disabled: ${run.runtimeId ?? "(none)"}`, emptyUsage());
      return;
    }

    const adapter = this.registry.get(runtime.kind);
    if (!adapter) {
      await this.finish(runId, "failed", `No adapter registered for runtime kind "${runtime.kind}"`, emptyUsage());
      return;
    }

    const model = run.modelId ? this.modelService().get(run.modelId) : undefined;
    const provider = model ? this.providerService().get(model.providerId) : undefined;
    const workspace = run.workspaceId ? this.workspaceService().get(run.workspaceId) : undefined;
    // Run-level overrides (set at continuation time) take precedence
    // over the task's defaults.
    const mergedEnv: Record<string, string> = { ...(task.env ?? {}), ...(run.env ?? {}) };
    const mergedSecretIds = [...new Set([...(task.secretIds ?? []), ...(run.secretIds ?? [])])];
    const policy = run.policy ?? task.policy;
    const secrets = this.secretService().resolve(mergedSecretIds);
    const lifecycle = normalizeLifecycle(run.lifecycle ?? resolveLifecycle(runtime));
    const continuity: RunContinuity = run.continuity ?? "new";
    const runtimeSession = run.runtimeSessionRefId ? this.runtimeSessionService().get(run.runtimeSessionRefId) : undefined;
    const previousHandoff = run.previousHandoffId ? this.handoffService().get(run.previousHandoffId) : undefined;
    const caps = effectiveCapabilities(adapter, runtime);

    // Containerized harness runs attach the runtime's opaque native-state
    // directory so the harness's own session store survives container
    // destruction (v2 §12–§15). Resuming reattaches the exact state the
    // resumable reference was created with.
    let nativeState: RuntimeNativeState | undefined;
    let nativeStateReattached = false;
    if (runtime.containerized && caps.supportsNativeSession) {
      const mountPath = String(
        runtime.config?.nativeStateMountPath ?? adapter.nativeStateMountPath ?? "/root/.agentfabric-state"
      );
      nativeState =
        (runtimeSession?.nativeStateId ? this.nativeStateService().get(runtimeSession.nativeStateId) : undefined) ??
        (await this.nativeStateService().ensureForRuntime(runtime, mountPath));
      nativeStateReattached = Boolean(runtimeSession?.nativeStateId);
      await this.store.update<Run>("runs", runId, { nativeStateId: nativeState.id, updatedAt: now() });
    }

    // Keep-alive: reuse a retained container instead of a fresh one.
    let reusableContainer: ReusableContainer | undefined;
    if (lifecycle.mode === "keep-alive") {
      const lease = this.leaseManager.acquire(runtime.id, workspace?.id);
      if (lease) reusableContainer = { containerId: lease.containerId, name: lease.containerName };
    }

    // Abort controller for cancel/timeout.
    const controller = new AbortController();
    const abortState: { reason: "cancel" | "timeout" | "policy"; policyMessage?: string } = { reason: "cancel" };
    const timeoutMs = run.timeoutMs ?? task.timeoutMs ?? policy?.maxDurationMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      abortState.reason = "timeout";
      this.controllers.set(runId, { controller, reason: "timeout" });
      controller.abort();
    }, timeoutMs);
    this.controllers.set(runId, { controller, reason: "cancel" });

    // Aborts the run when an execution-policy budget is exceeded.
    const abortForPolicy = (message: string): void => {
      if (controller.signal.aborted) return;
      abortState.reason = "policy";
      abortState.policyMessage = message;
      this.controllers.set(runId, { controller, reason: "policy" });
      controller.abort();
    };

    // Start. Everything below is guarded: an unexpected error must never
    // leave the run stuck in "running" nor leak the timeout timer.
    const usageAcc = emptyUsage();
    try {
      run = await this.store.update<Run>("runs", runId, {
        status: "starting",
        startTime: now(),
        updatedAt: now(),
      });
      if (!run) return; // record vanished mid-flight; nothing to execute

      const ctx: RuntimeContext = this.buildContext({
        run,
        task,
        runtime,
        model,
        provider,
        workspace,
        secrets,
        env: mergedEnv,
        policy,
        lifecycle,
        continuity,
        runtimeSession,
        previousHandoff,
        reusableContainer,
        nativeState,
        signal: controller.signal,
        usageAcc,
        abortForPolicy,
      });

      await ctx.emit("run.started", {
        runId,
        taskId: task.id,
        title: task.title,
        runtime: runtime.name,
        model: model?.alias ?? model?.name,
        provider: provider?.name,
        workspace: workspace?.name,
        timeoutMs,
        lifecycle: lifecycle.mode,
        continuity,
        resumedSession: continuity === "resume" ? runtimeSession?.nativeSessionRef : undefined,
        handoffId: previousHandoff?.id,
      });
      if (workspace) {
        await ctx.emit("workspace.attached", {
          workspaceId: workspace.id,
          name: workspace.name,
          path: workspace.path,
          mountPath: workspace.mountPath,
          source: workspace.source ?? "create",
        });
      }
      if (nativeState) {
        await ctx.emit("native.state.attached", {
          nativeStateId: nativeState.id,
          mountPath: nativeState.mountPath,
          runtimeId: runtime.id,
          runtimeKind: runtime.kind,
          reattached: nativeStateReattached,
        });
      }
      if (reusableContainer) {
        await ctx.emit("container.reused", {
          containerId: reusableContainer.containerId,
          runtimeId: runtime.id,
          lifecycle: lifecycle.mode,
        });
      }

      run = (await this.store.update<Run>("runs", runId, { status: "running", updatedAt: now() })) ?? run;

      let result: RuntimeResult;
      try {
        result = await adapter.run(ctx);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      clearTimeout(timer);
      if (lifecycle.mode === "keep-alive" && result.containerId) {
        // Keep-alive containers are owned by the lease manager, not the
        // adapter's cleanup path.
      } else {
        try {
          await adapter.cleanup?.(ctx);
        } catch {
          /* best effort */
        }
      }
      this.controllers.delete(runId);

      if (result.containerId) {
        await this.store.update<Run>("runs", runId, { containerId: result.containerId, updatedAt: now() });
      }

      // Post-run pipeline: workspace save, session reference, harness
      // handoff, container retention (spec v1 §11/§3/§7/§1).
      await this.afterRun(ctx, result, lifecycle);

      const aborted = controller.signal.aborted;
      const reason = abortState.reason;

      if (aborted && reason === "timeout") {
        await this.finish(runId, "timeout", `Run timed out after ${timeoutMs}ms`, usageAcc);
      } else if (aborted && reason === "policy") {
        const message = abortState.policyMessage ?? "Execution policy limit exceeded";
        await ctx.emit("run.failed", { error: message });
        await this.finish(runId, "failed", message, usageAcc);
      } else if (aborted) {
        await this.finish(runId, "cancelled", "Cancelled by user", usageAcc);
      } else if (result.error) {
        await ctx.emit("run.failed", { error: result.error });
        await this.finish(runId, "failed", result.error, addUsage(usageAcc, result.usage));
      } else {
        await ctx.emit("run.completed", { exitCode: result.exitCode });
        await this.finish(runId, "completed", undefined, addUsage(usageAcc, result.usage));
      }
    } catch (err) {
      // Safety net: fail the run instead of leaving it running forever
      // and release the timeout timer (spec v1 §2: runs are records, not
      // container state — a crashed execution must stay inspectable).
      clearTimeout(timer);
      this.controllers.delete(runId);
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.finish(runId, "failed", `Internal error: ${message}`, usageAcc);
      } catch {
        /* run record may be gone; nothing else to do */
      }
    }
  }

  /**
   * Runs after the adapter returns, before the run is marked finished:
   * 1. Save the workspace so container destruction can never lose work.
   * 2. Persist the harness-native session reference (verbatim).
   * 3. Store a harness-generated handoff when the harness produced one.
   * 4. Apply the container lifecycle policy (keep-alive retention).
   */
  private async afterRun(ctx: RuntimeContext, result: RuntimeResult, lifecycle: RuntimeLifecycle): Promise<void> {
    const caps = effectiveCapabilities(this.registry.get(ctx.runtime.kind), ctx.runtime);

    // 1. Workspace save.
    try {
      const saved = await ctx.saveWorkspace();
      if (saved) {
        await ctx.emit("workspace.saved", {
          workspaceId: saved.id,
          name: saved.name,
          path: saved.path,
          lastSavedAt: saved.lastSavedAt,
        });
      }
    } catch (err) {
      await ctx.log(`Workspace save failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }

    // 2. Runtime-native session reference.
    if (result.nativeSessionRef) {
      const previousRefId = ctx.run.runtimeSessionRefId;
      const ref = await this.runtimeSessionService().register({
        runtimeId: ctx.runtime.id,
        runtimeKind: ctx.runtime.kind,
        runtimeName: ctx.runtime.name,
        runtimeVersion: result.runtimeVersion,
        nativeSessionRef: result.nativeSessionRef,
        resumeSupported: caps.supportsNativeResume,
        taskId: ctx.task.id,
        runId: ctx.run.id,
        workspaceId: ctx.workspace?.id,
        nativeStateId: ctx.nativeState?.id,
        executionBackend: ctx.runtime.containerized ? "docker" : "local",
        metadata: result.nativeSessionMetadata,
      });
      await this.store.update<Run>("runs", ctx.run.id, { runtimeSessionRefId: ref.id, updatedAt: now() });
      await ctx.emit(ctx.continuity === "resume" ? "runtime.session.resumed" : "runtime.session.created", {
        runtimeSessionRefId: ref.id,
        nativeSessionRef: ref.nativeSessionRef,
        runtimeKind: ref.runtimeKind,
        previousRefId,
        resumeSupported: ref.resumeSupported,
        nativeStateId: ref.nativeStateId,
        executionBackend: ref.executionBackend,
      });
    }

    // 2b. Native state preservation: the host-mounted directory already
    // persisted everything the harness wrote during the run; record the
    // usage so the next run reattaches this exact state (v2 §15).
    if (ctx.nativeState) {
      await this.nativeStateService().markUsed(ctx.nativeState.id, ctx.run.id);
      await ctx.emit("native.state.persisted", {
        nativeStateId: ctx.nativeState.id,
        runtimeId: ctx.runtime.id,
        runtimeKind: ctx.runtime.kind,
        lastUsedRunId: ctx.run.id,
      });
    }

    // 3. Harness-generated handoff.
    if (result.handoffContent && caps.supportsHandoffGeneration) {
      const handoff = await this.handoffService().create({
        taskId: ctx.task.id,
        fromRunId: ctx.run.id,
        fromRuntimeId: ctx.runtime.id,
        fromRuntimeName: ctx.runtime.name,
        fromRuntimeKind: ctx.runtime.kind,
        source: "harness",
        content: result.handoffContent,
        workspaceId: ctx.workspace?.id,
        artifactIds: ctx.run.artifactIds,
      });
      await this.store.update<Run>("runs", ctx.run.id, { generatedHandoffId: handoff.id, updatedAt: now() });
      await ctx.emit("handoff.generated", {
        handoffId: handoff.id,
        source: "harness",
        readyForNextAgent: true,
      });
    }

    // 4. Container lifecycle policy.
    const containerId = result.containerId;
    if (lifecycle.mode === "keep-alive" && containerId) {
      const lease = await this.leaseManager.retain({
        containerId,
        containerName: `af-keep-${ctx.runtime.id}`,
        runtimeId: ctx.runtime.id,
        runtimeKind: ctx.runtime.kind,
        workspaceId: ctx.workspace?.id,
        taskId: ctx.task.id,
        runId: ctx.run.id,
        idleTimeoutMs: lifecycle.idleTimeoutMs ?? DEFAULT_KEEP_ALIVE_IDLE_MS,
      });
      await ctx.emit("container.retained", {
        containerId,
        runtimeId: ctx.runtime.id,
        expiresAt: lease.expiresAt,
        idleTimeoutMs: lease.idleTimeoutMs,
      });
    } else if (lifecycle.mode === "ephemeral" && containerId) {
      await ctx.emit("container.destroyed", { containerId, reason: "ephemeral-lifecycle" });
    }
    // persistent: intentionally kept; no destroy, no expiry.
  }

  private buildContext(opts: {
    run: Run;
    task: Task;
    runtime: Runtime;
    model?: Model;
    provider?: Provider;
    workspace?: Workspace;
    secrets: Secret[];
    env: Record<string, string>;
    policy?: ExecutionPolicy;
    lifecycle: RuntimeLifecycle;
    continuity: RunContinuity;
    runtimeSession?: RuntimeSessionRef;
    previousHandoff?: Handoff;
    reusableContainer?: ReusableContainer;
    nativeState?: RuntimeNativeState;
    signal: AbortSignal;
    usageAcc: Usage;
    abortForPolicy: (message: string) => void;
  }): RuntimeContext {
    const { run, task, runtime, model, provider, workspace, secrets, signal, usageAcc } = opts;
    const store = this.store;
    const bus = this.bus;
    const artifactService = this.artifactService();
    const workspaceService = this.workspaceService();

    const env: Record<string, string> = {
      ...opts.env,
      ...(runtime.env ?? {}),
      ...Object.fromEntries(secrets.map((s) => [s.name, s.value ?? ""])),
      AGENTFABRIC_RUN_ID: run.id,
      AGENTFABRIC_TASK_ID: task.id,
      AGENTFABRIC_WORKSPACE_ID: workspace?.id ?? "",
      AGENTFABRIC_CONTINUITY: opts.continuity,
      AGENTFABRIC_LIFECYCLE: opts.lifecycle.mode,
      AGENTFABRIC_MODEL: model?.name ?? "",
      AGENTFABRIC_PROVIDER: provider?.name ?? "",
    };

    const emit = async (
      type: EventType,
      data: Record<string, unknown> = {},
      eventOpts?: { level?: LogLevel; source?: string }
    ): Promise<void> => {
      const event: RunEvent = {
        id: newId("evt"),
        runId: run.id,
        seq: store.nextSeq(),
        type,
        timestamp: now(),
        data,
        level: eventOpts?.level,
        source: eventOpts?.source ?? "core",
      };
      await store.insert("events", event);
      const r = store.get<Run>("runs", run.id);
      if (r) {
        r.eventCount += 1;
        r.updatedAt = now();
        await store.commit();
      }
      bus.publish(event);
    };

    return {
      run,
      task,
      runtime,
      model,
      provider,
      workspace,
      secrets,
      env,
      policy: opts.policy,
      signal,
      lifecycle: opts.lifecycle,
      continuity: opts.continuity,
      runtimeSession: opts.runtimeSession,
      previousHandoff: opts.previousHandoff,
      reusableContainer: opts.reusableContainer,
      nativeState: opts.nativeState,
      workspacePath: workspace?.path,
      emit,
      log: async (line, level = "info") => {
        await emit("log", { line }, { level, source: runtime.kind });
      },
      recordUsage: (u) => {
        // Harness-reported cost is authoritative; only estimate when the
        // harness did not report one (addUsage merges u into the
        // accumulator, so estimating here must not add cost twice).
        const withCost =
          u.estimatedCost === undefined && model
            ? { ...u, estimatedCost: estimateCost(model.name, u.inputTokens, u.outputTokens, u.cachedTokens ?? 0) }
            : u;
        Object.assign(usageAcc, addUsage(usageAcc, withCost));
        enforcePolicyLimits(opts.policy, usageAcc, opts.abortForPolicy);
      },
      addArtifact: async (draft: ArtifactDraft): Promise<Artifact> => {
        const artifact = await artifactService.create({ runId: run.id, ...draft });
        await emit("artifact.created", { artifactId: artifact.id, name: artifact.name, kind: artifact.kind });
        return artifact;
      },
      saveWorkspace: async (): Promise<Workspace | undefined> => {
        if (!workspace) return undefined;
        return workspaceService.save(workspace.id, run.id);
      },
    };
  }

  private async finish(
    runId: string,
    status: Run["status"],
    error: string | undefined,
    usage: Usage
  ): Promise<void> {
    const run = this.get(runId);
    if (!run) return;
    const endTime = now();
    let cost = usage.estimatedCost ?? 0;
    if (usage.durationMs === undefined || usage.durationMs === 0) {
      if (run.startTime) {
        usage.durationMs = Date.parse(endTime) - Date.parse(run.startTime);
      }
    }
    if (run.modelName && (usage.estimatedCost === undefined || usage.estimatedCost === 0)) {
      cost = estimateCost(run.modelName, usage.inputTokens, usage.outputTokens, usage.cachedTokens ?? 0);
    }
    usage.estimatedCost = cost;
    await this.store.update<Run>("runs", runId, {
      status,
      error,
      usage,
      cost,
      endTime,
      updatedAt: endTime,
    });
  }
}
