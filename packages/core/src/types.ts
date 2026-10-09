/**
 * AgentFabric core domain types.
 *
 * The platform is deliberately Provider-neutral, Model-neutral and
 * Runtime-neutral. These types are the shared vocabulary used by the
 * API, CLI, Web UI and every Runtime adapter.
 */

export type ID = string;

/* ------------------------------------------------------------------ */
/* Provider                                                           */
/* ------------------------------------------------------------------ */

/**
 * API wire format spoken by the provider ("接口格式").
 * `openai` / `openai-compatible` are legacy values kept for backward
 * compatibility; new providers should use `openai-responses`,
 * `openai-completions` or `anthropic`.
 */
export type ProviderType =
  | "openai-responses"
  | "openai-completions"
  | "openai"
  | "openai-compatible"
  | "anthropic"
  | "custom";

export interface Provider {
  id: ID;
  name: string;
  /** API wire format (OpenAI Responses / OpenAI Completions / Anthropic / …). */
  type: ProviderType;
  /** Free-form note shown next to the provider. */
  remark?: string;
  /** Vendor website (informational). */
  website?: string;
  /** Custom API endpoint / base URL. */
  baseUrl?: string;
  /** Reference to a Secret id holding the API key. */
  apiKeySecretId?: string;
  /** Masked preview of the key, e.g. `sk-***xyz`. */
  apiKeyMasked?: string;
  /** Extra headers injected into every request. */
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Model                                                              */
/* ------------------------------------------------------------------ */

export interface Model {
  id: ID;
  providerId: ID;
  /** Model name / id as understood by the provider, e.g. `gpt-4o`. */
  name: string;
  /** Display name shown in the UI; also usable as a submission alias. */
  alias?: string;
  /** Model parameters (temperature, maxTokens, ...). */
  parameters?: Record<string, unknown>;
  capabilities?: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Runtime                                                            */
/* ------------------------------------------------------------------ */

export type RuntimeKind =
  | "opencode"
  | "pi"
  | "codex"
  | "claude-code"
  | "zcode"
  | "dsh"
  | "docker"
  | "mock"
  | "custom";

/**
 * Where a runtime's model access comes from (v6 §2):
 * - `agentfabric`: through an AgentFabric Provider/Model (API key in
 *   Secrets, base URL and headers configured on the Provider).
 * - `harness-native`: through the harness's own logged-in account and
 *   subscription (e.g. Codex with ChatGPT login, Claude Code with its
 *   Claude.ai login). AgentFabric never reads, copies or stores that
 *   harness's credentials; runs on such a runtime do not bind an
 *   AgentFabric Model.
 */
export type CredentialSource = "agentfabric" | "harness-native";

export interface ResourceLimits {
  cpu?: string;
  memory?: string;
  pids?: number;
}

export interface NetworkPolicy {
  enabled: boolean;
  allowedHosts?: string[];
  blockedHosts?: string[];
}

export interface FilesystemPolicy {
  readOnly?: boolean;
  allowedPaths?: string[];
  deniedPaths?: string[];
}

/**
 * Container lifecycle policies (spec v1 §1).
 *
 * - `ephemeral` (default): a fresh container per Run, destroyed when the
 *   Run completes, fails, is cancelled or times out.
 * - `keep-alive`: the container is retained for a short idle window after
 *   the Run finishes so a follow-up Run on the same harness/workspace can
 *   reuse it; it is destroyed automatically after `idleTimeoutMs`.
 * - `persistent`: long-lived container (daemon agents etc.). Reserved in
 *   the model — not a core implementation goal of this phase — but the
 *   lifecycle model and cleanup paths already honor it.
 *
 * The policy belongs to the **Task**, chosen once when the Task is created,
 * and applies to every Run of that Task for its whole life. It is not a
 * Runtime property (the same runtime serves Tasks with different needs) and
 * it is not a per-Run override (a later turn silently reverting to a
 * different policy is exactly the surprise this model removes).
 */
export type RuntimeLifecycleMode = "ephemeral" | "keep-alive" | "persistent";

export interface RuntimeLifecycle {
  mode: RuntimeLifecycleMode;
  /** Keep-alive only: destroy the container after this much idle time. */
  idleTimeoutMs?: number;
}

/**
 * Where a Runtime actually executes (v11 hardening §4/§6).
 *
 * This is the *declared* isolation metadata — the field a policy decision
 * reads. `containerized` remains the backend switch (which carrier the
 * adapter spawns on); `executionBackend` is the answer to "is the work
 * isolated from the AgentFabric host?". They normally agree, and a runtime
 * whose record predates this field is read through `executionBackendOf()`,
 * which derives the backend from `containerized`.
 *
 * - `isolated`: the harness runs inside a container/VM boundary and never on
 *   the AgentFabric host.
 * - `host`: the harness runs as a local process on the AgentFabric host.
 *   Still fully supported for development, debugging, non-project tasks and
 *   internal tests — but never for a Project Coding Task.
 */
export type RuntimeExecutionBackend = "isolated" | "host";

/**
 * Runtime isolation requirement of one execution (v11 hardening §4).
 * Derived from the runtime's declared isolation metadata, never from its
 * name or kind.
 */
export interface RuntimeIsolation {
  /** True when the runtime executes inside an isolation boundary. */
  sandboxed: boolean;
  /** The declared execution backend this verdict was read from. */
  executionBackend: RuntimeExecutionBackend;
  /** True when the backend is container-backed (the adapter spawns Docker). */
  containerized: boolean;
  /** Image the isolated runtime runs, when configured. */
  image?: string;
  /** Human-readable reason, used verbatim in a refusal. */
  reason: string;
}

/**
 * Reads a Runtime's isolation metadata. Explicit `executionBackend` wins;
 * otherwise the legacy `containerized` boolean decides, so every runtime
 * record that existed before this concept is read correctly without a
 * migration.
 */
export function executionBackendOf(runtime: Pick<Runtime, "containerized" | "executionBackend">): RuntimeExecutionBackend {
  if (runtime.executionBackend) return runtime.executionBackend;
  return runtime.containerized ? "isolated" : "host";
}

/**
 * The isolation verdict for a runtime (v11 hardening §4.2). A sandboxed
 * runtime must additionally be container-backed and name an image: a
 * "containerized" record without an image cannot actually start, so it is
 * not an isolation guarantee.
 */
export function runtimeIsolation(runtime: Pick<Runtime, "name" | "containerized" | "executionBackend" | "image">): RuntimeIsolation {
  const executionBackend = executionBackendOf(runtime);
  const containerized = Boolean(runtime.containerized);
  const image = runtime.image?.trim() || undefined;
  if (executionBackend !== "isolated") {
    return {
      sandboxed: false,
      executionBackend,
      containerized,
      image,
      reason: `Runtime "${runtime.name}" executes on the AgentFabric host`,
    };
  }
  if (!containerized) {
    return {
      sandboxed: false,
      executionBackend,
      containerized,
      image,
      reason: `Runtime "${runtime.name}" declares isolated execution but is not backed by a container`,
    };
  }
  if (!image) {
    return {
      sandboxed: false,
      executionBackend,
      containerized,
      image,
      reason: `Runtime "${runtime.name}" declares isolated execution but has no container image configured`,
    };
  }
  return {
    sandboxed: true,
    executionBackend,
    containerized,
    image,
    reason: `Runtime "${runtime.name}" executes in an isolated container (${image})`,
  };
}

/**
 * Capabilities a Runtime can declare (spec v1 §17). AgentFabric uses them
 * to decide which behaviors are available (e.g. native resume vs handoff).
 */
export interface RuntimeCapability {
  /** Harness has its own native session concept. */
  supportsNativeSession: boolean;
  /** Harness can resume a previously stored native session reference. */
  supportsNativeResume: boolean;
  /** Harness streams progress events while executing. */
  supportsStreamingEvents: boolean;
  /** Harness can produce a high-quality handoff summary itself. */
  supportsHandoffGeneration: boolean;
  /** Harness can attach to (work inside) a Workspace directory. */
  supportsWorkspace: boolean;
  /** Harness supports interactive (multi-turn) execution. */
  supportsInteractiveExecution: boolean;
  /**
   * Context window of the model this harness actually runs, when the operator
   * declares it. Explicit capability metadata — the handoff budget for a
   * harness-native target is derived from it. Never guessed from a model name
   * and never looked up over the network (v9 §5).
   */
  contextWindow?: number;
}

export interface Runtime {
  id: ID;
  name: string;
  kind: RuntimeKind;
  description?: string;
  /** Docker image used when the runtime is containerized. */
  image?: string;
  /** Command override inside the container (docker kind). */
  command?: string[];
  /** Working directory for local runtimes. */
  cwd?: string;
  /** If true, the adapter runs inside a Docker container. */
  containerized?: boolean;
  /**
   * Declared execution backend (v11 hardening §4). Absent on records created
   * before the field existed; read it through `executionBackendOf()`, which
   * derives the backend from `containerized`. Project Coding Tasks require
   * `"isolated"`.
   */
  executionBackend?: RuntimeExecutionBackend;
  /**
   * Credential source (v6 §2): `harness-native` runtimes authenticate with
   * their own logged-in account (e.g. Codex + ChatGPT) and therefore do
   * not bind an AgentFabric Provider/Model. Defaults to `agentfabric`.
   */
  credentialSource?: CredentialSource;
  defaultModelId?: ID;
  enabled: boolean;
  /**
   * Whether this runtime may be picked as a task's execution target. The
   * task page's runtime selectors filter on it: a runtime without a
   * working runner adapter (e.g. zcode — its sessions are discovered and
   * adopted, but it cannot execute here yet) defaults to false, and the
   * Runtimes page toggles the per-record value.
   */
  usableInTask: boolean;
  /** Declared capabilities; falls back to the adapter's declared set. */
  capabilities?: Partial<RuntimeCapability>;
  /**
   * Explicit context window of the model this runtime runs (v9 §5). The
   * handoff budget for a harness-native target is resolved from this — or from
   * `capabilities.contextWindow` / `config.contextWindow` — before any
   * configured model window. Never guessed from a model name, never fetched.
   */
  contextWindow?: number;
  resourceLimits?: ResourceLimits;
  env?: Record<string, string>;
  secretIds?: string[];
  networkPolicy?: NetworkPolicy;
  filesystemPolicy?: FilesystemPolicy;
  config?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Workspace                                                          */
/* ------------------------------------------------------------------ */

export type WorkspaceType = "local" | "git" | "volume";

/**
 * How a Workspace came into being (v11 §5.4):
 * - `managed`: the platform created it for one Project-based Task and owns
 *   its lifecycle. Never shared between tasks.
 * - `external`: a user directory or repository the user attached — used in
 *   place, never copied or taken over.
 */
export type WorkspaceOwnership = "managed" | "external";

export interface Workspace {
  id: ID;
  name: string;
  type: WorkspaceType;
  /** Absolute path for local/volume workspaces. */
  path?: string;
  repoUrl?: string;
  branch?: string;
  /** Mount target inside the container. */
  mountPath?: string;
  persistent: boolean;
  /** How the workspace came into being: created empty or imported. */
  source?: "create" | "import";
  /** Liveness of the backing directory ("missing" means the path vanished). */
  status?: "ready" | "missing";
  /** Last time the workspace was saved/verified after a Run. */
  lastSavedAt?: string;
  /** Run that last saved the workspace. */
  lastSavedRunId?: ID;
  /**
   * Managed vs external (v11 §5.4). Absent means external: every workspace
   * created before this concept existed is a user-owned working copy.
   */
  ownership?: WorkspaceOwnership;
  /** Project a managed workspace belongs to. */
  projectId?: ID;
  /** Task a managed workspace belongs to (1 Task = 1 Workspace, v11 §5.1). */
  taskId?: ID;
  /** Working branch checked out in a managed workspace. */
  workingBranch?: string;
  /** Base revision the managed workspace was created from. */
  baseCommitSha?: string;
  createdAt: string;
}

/**
 * A single writer lease over a Workspace (v11 §36). One managed workspace
 * has at most one active writer at a time; a second writer is refused with
 * `workspace-locked` instead of corrupting the working tree.
 */
export interface WorkspaceLock {
  id: ID;
  workspaceId: ID;
  taskId: ID;
  runId: ID;
  acquiredAt: string;
}

/* ------------------------------------------------------------------ */
/* Project & Source (v11 §2/§3)                                        */
/* ------------------------------------------------------------------ */

/** Source providers with first-class recognition (v11 §3). */
export type SourceProvider = "github" | "gitlab" | "gitee" | "generic";

export type SourceType = "git";

/**
 * A Project's primary source (v11 §3). One Project currently has exactly one
 * primary source; the shape keeps `repositories`-style multi-source growth
 * possible without a rewrite (a future version adds a list beside it).
 */
export interface ProjectSource {
  type: SourceType;
  /** Credential-free remote URL. Never carries a token or userinfo (v11 §12). */
  remoteUrl: string;
  provider?: SourceProvider;
  /** Default branch used when a Task does not name a base ref. */
  defaultBranch?: string;
  /** Reference to a SourceCredential; absent = public repository (v11 §4.3). */
  credentialId?: ID;
}

/**
 * A reusable Git credential (v11 §4). Lives in global settings, never inside
 * a Project: Projects only reference it by id. Sensitive material is always a
 * Secret reference — this record only carries non-sensitive metadata.
 */
export type SourceCredentialType = "https-token" | "ssh-key";

export interface SourceCredential {
  id: ID;
  name: string;
  type: SourceCredentialType;
  /** Host this credential applies to (e.g. `github.com`), when scoped. */
  host?: string;
  /** Non-sensitive username (HTTPS token user, or SSH user). */
  username?: string;
  /** Secret holding the token (https-token) or the private key (ssh-key). */
  secretId: ID;
  /** Secret holding the SSH key passphrase, when the key is encrypted. */
  passphraseSecretId?: ID;
  /**
   * known_hosts content for SSH host verification (v11 §12.1/§42). Absent
   * falls back to the host's `~/.ssh/known_hosts`; host keys are always
   * verified (StrictHostKeyChecking=yes) — never silently trusted.
   */
  knownHosts?: string;
  createdAt: string;
  updatedAt: string;
}

/** A SourceCredential as served by the API: metadata plus the masked secret. */
export interface SourceCredentialView extends SourceCredential {
  secretMasked?: string;
  passphraseMasked?: string;
}

/** Where a Project's agent execution defaults come from (v11 §24). */
export interface ProjectExecutionConfig {
  runtimeId?: ID;
  modelId?: ID;
  profileId?: ID;
  timeoutMs?: number;
  resourceLimits?: ResourceLimits;
  env?: Record<string, string>;
  secretIds?: ID[];
  tools?: string[];
  policy?: ExecutionPolicy;
  networkPolicy?: NetworkPolicy;
  /**
   * Explicit advanced policy allowing a Project Coding Task to run on a
   * host (non-isolated) runtime (v11 hardening §4.1). Default off; it is an
   * operator escape hatch, never something a task request can grant itself.
   */
  allowHostExecution?: boolean;
  /**
   * Secrets a validation command may receive (v11 hardening §6.2). A
   * separate allowlist from `secretIds`: build/test credentials are not
   * agent credentials. `scope: "git"` secrets are refused here as well.
   */
  validationSecretIds?: ID[];
}

/** A skill provisioned into the agent execution environment (v11 §25). */
export interface ProjectSkill {
  name: string;
  /** Host directory whose contents are provisioned. */
  path: string;
  description?: string;
}

/**
 * An MCP server definition (v11 §26). Secrets are referenced, never inlined:
 * the generated runtime configuration resolves them at provisioning time.
 */
export interface McpServerConfig {
  name: string;
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  secretIds?: ID[];
  enabled?: boolean;
}

/** One validation command (v11 §20). */
export interface ValidationStep {
  name: string;
  /** Shell command run in the workspace directory. */
  command: string;
  timeoutMs?: number;
  /** A failing required step fails validation (default true). */
  required?: boolean;
}

export interface ValidationConfig {
  enabled?: boolean;
  steps: ValidationStep[];
}

/**
 * How the platform publishes a Task's work (v11 §17/§18).
 *
 * The platform — never the agent — owns commit policy and publishing: an
 * agent that never runs `git commit` still gets its work published when
 * `autoCommit` is on (the default).
 */
export interface GitPublishPolicy {
  /** Commit remaining dirty changes at finalization (default true). */
  autoCommit?: boolean;
  /** Commit message template; `{task}` / `{title}` / `{branch}` are substituted. */
  commitMessage?: string;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
  /** Push the working branch after finalization (default true). */
  push?: boolean;
  /** Remote name to push to (default `origin`). */
  remote?: string;
  /** Branches the platform refuses to publish (default main / master). */
  protectedBranches?: string[];
}

/** How a Task's working branch comes into being (v11 §8.1). */
export type BranchMode = "new" | "continue";

export interface Project {
  id: ID;
  name: string;
  description?: string;
  source: ProjectSource;
  /** Default execution configuration inherited by every Task (v11 §24). */
  execution?: ProjectExecutionConfig;
  /** Default skills provisioned before the runtime starts (v11 §25). */
  skills?: ProjectSkill[];
  /** Default MCP servers generated into the runtime configuration (v11 §26). */
  mcpServers?: McpServerConfig[];
  /** Default validation steps; a Task may override them (v11 §20). */
  validation?: ValidationConfig;
  /** Default publish policy; a Task may override it. */
  git?: GitPublishPolicy;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Execution Policy                                                   */
/* ------------------------------------------------------------------ */

export interface ExecutionPolicy {
  maxDurationMs?: number;
  maxModelCalls?: number;
  maxTokens?: number;
  maxCost?: number;
  cpu?: string;
  memory?: string;
  network?: NetworkPolicy;
  filesystem?: FilesystemPolicy;
  shell?: "allow" | "deny" | "ask";
  toolPermissions?: string[];
  /** Auto-approve runtime permission prompts (opencode --auto). */
  autoApprove?: boolean;
}

/* ------------------------------------------------------------------ */
/* Task lifecycle (v11 §9/§21/§22/§23)                                 */
/* ------------------------------------------------------------------ */

/**
 * Fine-grained lifecycle phase of a Project-based Task / its Run (v11 §21).
 * The coarse `RunStatus` stays as-is; the phase answers "what is happening
 * right now" — developing, testing, committing or pushing.
 */
export type RunPhase =
  | "task.created"
  | "workspace.preparing"
  | "source.fetching"
  | "source.checkout"
  | "runtime.preparing"
  | "agent.running"
  | "validation.preparing"
  | "validation.running"
  | "git.finalizing"
  | "git.pushing"
  | "cleanup"
  | "completed"
  | "failed"
  | "cancelled";

/** Coarse Task lifecycle status. */
export type TaskLifecycleStatus =
  | "created"
  | "preparing"
  | "running"
  | "validating"
  | "finalizing"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Which stage a failure belongs to (v11 §20/§23). Agent execution, validation
 * and publishing failures are never collapsed into one plain "Task failed".
 */
export type TaskFailureStage = "workspace" | "source" | "runtime" | "agent" | "validation" | "finalization" | "publish";

export interface TaskFailure {
  stage: TaskFailureStage;
  /** Domain error code (see `core/errors.ts`). */
  code: string;
  message: string;
  at: string;
}

export interface TaskAgentState {
  status: "pending" | "running" | "completed" | "failed" | "timeout" | "cancelled";
  /** Run that performed the latest agent attempt. */
  runId?: ID;
  attempts: number;
  error?: string;
  errorCode?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ValidationStepResult {
  name: string;
  command: string;
  status: "passed" | "failed" | "timeout" | "skipped";
  exitCode?: number | null;
  durationMs?: number;
  /** Tail of the step's output, kept for the Task detail view. */
  output?: string;
}

export interface TaskValidationState {
  status: "pending" | "skipped" | "running" | "passed" | "failed" | "timeout" | "interrupted";
  steps?: ValidationStepResult[];
  error?: string;
  errorCode?: string;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  /**
   * Where the validation commands actually ran (v11 hardening §6). Always an
   * isolated runtime: repository commands are untrusted code and never
   * execute on the AgentFabric host.
   */
  execution?: ValidationExecutionInfo;
}

/** How validation was executed — the isolation evidence on the record. */
export interface ValidationExecutionInfo {
  /** Isolation boundary the commands ran behind. */
  backend: "isolated";
  runtimeId?: ID;
  runtimeKind?: string;
  containerized: boolean;
  image?: string;
  /** True when a disposable validation runtime was created for this attempt. */
  disposable?: boolean;
  containerId?: string;
}

/**
 * Publish outcome (v11 §17.2). Kept separate from the development result so
 * "development completed, publishing failed" is expressible and publish can
 * be retried without re-running the agent (v11 §23/§31).
 */
export interface TaskPublishState {
  status: "pending" | "pushed" | "failed" | "skipped";
  /** Remote branch the work was published to. */
  remoteBranch?: string;
  remote?: string;
  baseCommitSha?: string;
  finalCommitSha?: string;
  pushedAt?: string;
  attempts: number;
  error?: string;
  errorCode?: string;
}

/**
 * The frozen result of the first successful Git finalization (v11 hardening
 * §13). Written once; every later publish pushes exactly this revision.
 * `publishOnly` distinguishes a publish that must never touch the working
 * tree from a full lifecycle that owns it.
 */
export interface FrozenFinalRevision {
  finalCommitSha: string;
  baseCommitSha: string;
  workingBranch: string;
  remote: string;
  remoteBranch: string;
  /**
   * Fingerprint of the working tree at the moment finalization succeeded
   * (HEAD + branch + porcelain status). Retry Publish compares it to detect a
   * workspace that drifted after finalization.
   */
  workspaceFingerprint: string;
  /** When the revision was frozen. */
  at: string;
  /** Number of finalizations that produced it (always 1 for a frozen revision). */
  finalizations: number;
}

export interface TaskExecution {
  phase: RunPhase;
  status: TaskLifecycleStatus;
  failure?: TaskFailure;
  agent?: TaskAgentState;
  validation?: TaskValidationState;
  publish?: TaskPublishState;
  /** Revision the task was started from, resolved once (v11 §7). */
  baseCommitSha?: string;
  /**
   * The task's frozen publish revision (v11 hardening §13). Present once
   * finalization succeeded; Retry Publish pushes this and nothing else.
   */
  frozenRevision?: FrozenFinalRevision;
  /**
   * Stage completion record (v11 hardening §17/§36). Written monotonically:
   * a stage that completed stays completed, whatever a later stage does.
   */
  stages?: TaskStageStates;
  updatedAt: string;
}

/** Monotonic per-stage outcomes of one Project task (v11 hardening §36). */
export interface TaskStageStates {
  agent?: StageOutcome;
  validation?: StageOutcome;
  finalization?: StageOutcome;
  publish?: StageOutcome;
}

export interface StageOutcome {
  status: "completed" | "failed" | "interrupted" | "cancelled" | "skipped";
  at: string;
  /** Failure code when the stage did not complete. */
  errorCode?: string;
  /** Commit the stage produced / published, when it has one. */
  commitSha?: string;
}

/* ------------------------------------------------------------------ */
/* Task                                                               */
/* ------------------------------------------------------------------ */

export interface Task {
  id: ID;
  title: string;
  prompt: string;
  runtimeId?: ID;
  modelId?: ID;
  workspaceId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: string[];
  /**
   * Secrets the Task's validation commands may receive (v11 hardening §6.2).
   * A separate allowlist from `secretIds`: a build/test credential is not an
   * agent credential, and a git-scoped secret is refused here.
   */
  validationSecretIds?: string[];
  tools?: string[];
  resourceLimits?: ResourceLimits;
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  /**
   * Container lifecycle for **every Run of this Task**. Written once when
   * the Task is created (see `taskLifecycle()`) and never changed: later
   * turns — continue / retry / handoff — inherit it verbatim, so the policy
   * a user picked cannot silently change mid-conversation. Required: the
   * record always carries the decision, so no reader has to derive it.
   */
  lifecycle: RuntimeLifecycle;
  metadata?: Record<string, unknown>;
  /** Project this Task develops against (v11 §6); absent = classic Task. */
  projectId?: ID;
  /** Base ref the working branch was created from (v11 §7). */
  baseRef?: string;
  /** Concrete revision `baseRef` resolved to when the Task started (v11 §7). */
  baseCommitSha?: string;
  /** Branch the platform owns and publishes for this Task (v11 §7/§8). */
  workingBranch?: string;
  /** Whether the working branch is new or continues an existing one. */
  branchMode?: BranchMode;
  /** Task-level validation override (replaces the Project's). */
  validation?: ValidationConfig;
  /** Task-level publish policy override. */
  git?: GitPublishPolicy;
  /**
   * Task-level skill override (v11 §25). Declared here, the Task's list
   * **replaces** the Project's; absent (the normal case) the Project's list
   * applies. Resolved when the execution environment is provisioned.
   */
  skills?: ProjectSkill[];
  /** Task-level MCP server override (v11 §26); same replace-or-inherit rule. */
  mcpServers?: McpServerConfig[];
  /** Project-based lifecycle state (v11 §6/§40). */
  execution?: TaskExecution;
  /**
   * Set when the task was soft-deleted (recoverable, hidden from the live
   * lists); absent = live. The server purges soft-deleted tasks — record,
   * runs, events, artifacts, handoffs — once this is older than the
   * retention window (`TASK_RETENTION_MS`).
   */
  deletedAt?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Run                                                                */
/* ------------------------------------------------------------------ */

export type RunStatus =
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

/**
 * How this Run continues the Task's work (spec v1 §4/§18):
 * - `new`: first run of the task (or an explicit fresh start).
 * - `resume`: same harness, continued via its native session.
 * - `handoff`: different harness, continued via a Handoff — the new
 *   harness creates its own new native session (no session migration).
 */
export type RunContinuity = "new" | "resume" | "handoff";

export interface Run {
  id: ID;
  taskId: ID;
  taskTitle: string;
  status: RunStatus;
  /**
   * Fine-grained lifecycle phase (v11 §21) for Project-based runs. Absent on
   * classic Task runs, which never go through the execution supervisor.
   */
  phase?: RunPhase;
  /** Project this run develops against (Project-based runs only). */
  projectId?: ID;
  /** Working branch the run's workspace was on when it started. */
  workingBranch?: string;
  /** Base revision the task started from, snapshotted per run. */
  baseCommitSha?: string;
  runtimeId?: ID;
  runtimeName?: string;
  modelId?: ID;
  modelName?: string;
  providerId?: ID;
  workspaceId?: ID;
  containerId?: string;
  /** Runtime Native State attached to this run (containerized runs). */
  nativeStateId?: ID;
  /** The concrete instruction this Run executed (may include handoff context). */
  inputInstruction?: string;
  /**
   * The user's actual input for this Run — the bare prompt, without
   * handoff context, internal context or system instructions. The Task
   * Thread shows this as the User Message; `inputInstruction` stays the
   * full instruction sent to the harness (v5 §5).
   */
  userPrompt?: string;
  /**
   * System instructions snapshotted from the agent profile when the run
   * was created (v4 §10) — delivered to the harness as its system prompt.
   */
  systemInstructions?: string;
  /** Resume / handoff / new — how this run relates to previous runs. */
  continuity?: RunContinuity;
  /** Handoff consumed by this run (cross-harness continuation). */
  previousHandoffId?: ID;
  /** Handoff this run produced for a future continuation. */
  generatedHandoffId?: ID;
  /** Runtime-native session reference used/created by this run. */
  runtimeSessionRefId?: ID;
  /**
   * The container lifecycle this Run executed under — copied verbatim from
   * the Task at creation. A snapshot, not a decision: the Run never resolves
   * it, and no reader re-derives it.
   */
  lifecycle: RuntimeLifecycle;
  /** Per-run execution parameters (override the task's defaults). */
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: string[];
  tools?: string[];
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  error?: string;
  /**
   * Structured failure classification (v6 §10): `usage-limit` marks a run
   * that died on the harness's own subscription quota (e.g. Codex "You've
   * hit your usage limit") — a switch-harness scenario, not a plain run
   * failure. The Task page offers "Continue with Pi / OpenCode" instead of
   * just "Run failed".
   */
  errorKind?: "usage-limit";
  startTime?: string;
  endTime?: string;
  usage?: Usage;
  cost?: number;
  artifactIds: ID[];
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Runtime Native State (v2 §13–§14)                                   */
/* ------------------------------------------------------------------ */

/**
 * AgentFabric-managed persistent storage for a harness's *private* state
 * — the data the harness needs to resume its own native sessions
 * (native session store, internal databases, config/cache files, …).
 *
 * This is deliberately distinct from a Workspace:
 * - Workspace = the user's actual work (source code, project files).
 * - Runtime Native State = harness-internal plumbing, opaque to
 *   AgentFabric (v2: "Runtime native state is opaque").
 *
 * AgentFabric only Create / Mount / Preserve / Reattach / Delete this
 * directory; it never reads or transforms its contents.
 */
export interface RuntimeNativeState {
  id: ID;
  /** Runtime (harness instance) this state belongs to. */
  runtimeId: ID;
  runtimeKind: RuntimeKind;
  /** Host directory managed opaquely by AgentFabric. */
  path: string;
  /** Mount target inside the container (the harness's own state dir). */
  mountPath: string;
  /** Last run that attached this state. */
  lastUsedRunId?: ID;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Runtime Session Reference (spec v1 §3/§9, v2 §2/§6)                 */
/* ------------------------------------------------------------------ */

/**
 * A reference to a harness's *native* session. AgentFabric never
 * understands (or unifies) the session's internal structure — it only
 * records enough to resume the same harness later:
 * runtime type/version, the opaque native reference, resume capability
 * and runtime-specific metadata.
 *
 * Same Harness → Resume. Different Harness → Handoff.
 */
export interface RuntimeSessionRef {
  id: ID;
  runtimeId?: ID;
  /** Runtime kind (harness type) the native session belongs to. */
  runtimeKind: RuntimeKind;
  runtimeName?: string;
  /** Harness version, when known. */
  runtimeVersion?: string;
  /** Opaque reference into the harness's own session store. */
  nativeSessionRef: string;
  /** Whether this harness can resume from this reference. */
  resumeSupported: boolean;
  taskId?: ID;
  runId: ID;
  workspaceId?: ID;
  /**
   * Runtime Native State the session depends on. Resuming reattaches
   * this state so an ephemeral container can still restore the session
   * (v2 §12/§15).
   */
  nativeStateId?: ID;
  /** Execution backend the session was created under. */
  executionBackend?: "local" | "docker";
  status: "active" | "expired";
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Handoff (spec v1 §4–§8)                                             */
/* ------------------------------------------------------------------ */

/**
 * Where a handoff's content came from:
 * - `harness`: the previous agent harness produced the summary itself.
 * - `agentfabric`: AgentFabric generated it from task/run/messages/
 *   workspace/files/artifacts/logs (assisted handoff).
 * - `user`: notes supplied by the user when switching harnesses.
 * A stored handoff records which sources contributed (`sources`).
 */
export type HandoffSource = "harness" | "agentfabric" | "user";

/**
 * How a handoff's context was produced:
 * - `context-bundle`: the real thing. The covered history was split into an
 *   old prefix (summarized into a small structured checkpoint by the model)
 *   and a recent suffix (carried over verbatim as retained context); see
 *   `core/handoffContext.ts`. A bundle whose whole covered history fit in the
 *   retained context has no checkpoint at all — that is still a bundle.
 * - `heuristic`: no bundle could be assembled by the model and a structured
 *   digest of the run records was used instead. Degraded: callers must
 *   surface it and never present it as a model-written checkpoint.
 * - `harness`: the previous agent harness produced the content itself.
 * - `brief`: no previous run existed — the handoff is just the task brief.
 */
export type HandoffGenerationMethod = "context-bundle" | "heuristic" | "harness" | "brief";

/**
 * Why a handoff exists. Audit-only — it never drives behaviour (the
 * consuming turn reads `awaitingNextTurn`), it answers "who asked for
 * this, and why" when the record is read back:
 *
 * - `explicit`: the standalone Handoff action — the user asked for one;
 * - `targeted`: pre-generated toward a named harness (Continue with X,
 *   thread adoption) and cached for it;
 * - `continuation`: produced as part of a cross-harness continue;
 * - `harness`: the previous harness produced it itself.
 */
export type HandoffTrigger = "explicit" | "targeted" | "continuation" | "harness";

export interface HandoffGeneration {
  method: HandoffGenerationMethod;
  /** Why it was generated. */
  trigger?: HandoffTrigger;
  /** Why the checkpoint could not be written (degraded handoffs only). */
  detail?: string;
  /** Summarization calls used; > 1 when the summarized prefix was chunked. */
  chunks?: number;
  /** Model that wrote the checkpoint; absent when no model produced content. */
  modelId?: ID;
  modelName?: string;
  providerName?: string;
  /** Why this model was chosen (audit only); absent with the model itself. */
  modelSource?: HandoffModelSource;
  /** Runs the checkpoint covers, oldest first. */
  coveredRunIds?: ID[];
  /** Wall-clock time the summarization took. */
  durationMs?: number;
  /** Tokens the summarization calls consumed (all chunks). */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * One piece of preserved context inside a handoff bundle (v8 §7). Slices are
 * kept as discrete, labelled records — never flattened back into one blob —
 * so inspection can still answer "what survived, and why".
 *
 * `kind` is the *speaker* of the piece: a user turn, an assistant conclusion,
 * a tool call or a tool result. Tool outputs are observed data, never
 * instructions (v8 §23).
 */
/**
 * Where the handoff budget's target context window came from (v10 §23). This is
 * a human/audit fact for the Inspector — the receiving model never needs it.
 */
export type HandoffContextWindowSource = "runtime-capability" | "configured-model" | "default";

/**
 * Provenance of user-role text (v10 §6/§7): user authority depends on where
 * the text was recorded, not just on a "user" role label.
 *
 * - `user-authored`: recorded by the orchestration layer as the user's bare
 *   input (no harness framing) — the user's own words.
 * - `user-context`: arrived through the source harness's user-facing turn
 *   (a harness echo of the turn, or an adopted native thread). The source
 *   harness may have wrapped it with framing or attachment metadata, so it is
 *   not guaranteed to be the user's literal words.
 */
export type HandoffUserProvenance = "user-authored" | "user-context";

/**
 * Where a covered run's bare user prompt was RECORDED (v10 §6) — the
 * input-side fact that maps onto slice provenance:
 * `user-authored` → `[User-authored]`, `harness-reported` → `[User-context]`.
 */
export type HandoffUserPromptOrigin = "user-authored" | "harness-reported";

/**
 * Explicit outcome semantics for a slice that states a tool outcome instead of
 * carrying result data (v10 §13/§14). Distinguishes "no textual result",
 * "omitted reconstructable body" (that one is `reconstructable`), "failed" and
 * "result unavailable" — an orphan tool call with no outcome state at all is
 * an ambiguous handoff.
 */
export type HandoffToolOutcome = "failed" | "completed-no-output" | "result-unavailable";

export interface HandoffContextSlice {
  kind: "user" | "assistant" | "tool-call" | "tool-result";
  text: string;
  /** Run the slice came from (absent for synthetic slices like the task brief). */
  runId?: ID;
  toolCallId?: string;
  toolName?: string;
  /**
   * Provenance of user-role text (v10 §6/§7); only ever set on `user` slices.
   * Absent means the default, `user-authored`.
   */
  provenance?: HandoffUserProvenance;
  /**
   * A source-harness wrapper/framing pattern was positively detected inside
   * user-context text (e.g. "# Files mentioned by the user", "## My request:")
   * — the label warns the receiver that only part of the text may be the
   * user's own words.
   */
  harnessWrapper?: boolean;
  /**
   * The slice states a tool outcome rather than carrying result data
   * (v10 §13/§14). Rendered under the `[Tool result status]` label.
   */
  outcome?: HandoffToolOutcome;
  /**
   * The slice is a placeholder for an observation that the new harness can
   * re-obtain from the shared workspace (a local file read, a `cat`): the body
   * is deliberately omitted and `text` says how to get it back (v8 §16).
   */
  reconstructable?: boolean;
  /**
   * The slice is a local-mutation tool call whose large body arguments were
   * semantically projected away (v10 §9/§10): the final workspace state is
   * authoritative, so the call keeps only tool/path/operation semantics.
   */
  mutationProjected?: boolean;
  /** Why this slice survived selection (v8 §7). */
  retention: "pinned" | "recent" | "paired" | "oversized-truncated";
}

/**
 * Token accounting of one generated handoff (v8 §6.3). No tokenizer is
 * bundled: `charsPerToken` is the single conservative estimator the whole
 * handoff path uses (see `estimateTokens` in `core/handoffContext.ts`).
 */
export interface HandoffContextBudget {
  /** Target model context window the budget was derived from. */
  contextWindow: number;
  /**
   * Where `contextWindow` came from (v10 §23): runtime capability, configured
   * model, or the documented default. Inspector-only diagnostics.
   */
  contextWindowSource?: HandoffContextWindowSource;
  /** Total handoff budget: `min(maxHandoffTokens, floor(window × ratio))`. */
  maxTokens: number;
  /**
   * Estimated size of the handoff BODY: checkpoint, pinned context, retained
   * context, metadata/scaffolding and user notes. The receiving harness's own
   * instruction is appended outside this budget (see `renderHandoffPrompt`).
   */
  estimatedTokens: number;
  checkpointTokens: number;
  pinnedTokens: number;
  retainedTokens: number;
  /** The derived current-frontier section (v10 §5), when present. */
  frontierTokens?: number;
  /** Render scaffolding + workspace/run metadata the checkpoint does not own. */
  metadataTokens?: number;
  /** User-provided handoff notes, counted in the same accounting (v9 §6). */
  userNotesTokens?: number;
  charsPerToken: number;
}

/**
 * The handoff context bundle (v8 §7): what actually crosses the session
 * boundary. A handoff is NOT a summary — the checkpoint is only the fallback
 * representation of the history that did not fit verbatim.
 */
export interface HandoffContextBundle {
  version: 2;
  /**
   * Structured state index written by the model over the history that was NOT
   * carried verbatim. Absent when the whole covered history fit in the
   * retained context (nothing needed summarizing) and no earlier checkpoint
   * had to be carried forward.
   *
   * Temporal semantics (v10 §2/§3): the checkpoint describes the state BEFORE
   * the retained recent context — it is explicitly historical, never the
   * final current state. The renderer states this framing.
   */
  checkpoint?: string;
  /**
   * The current frontier (v10 §5): a small, deterministic derivation from the
   * END of the retained context (the latest assistant conclusion), so the
   * receiving harness can tell "where the work actually stands now" without
   * re-reading past a stale checkpoint. Absent when nothing was retained.
   */
  frontier?: string;
  /** High-value older context kept verbatim (historical user instructions). */
  pinnedContext: HandoffContextSlice[];
  /** Recent working trajectory kept verbatim, oldest first. */
  retainedContext: HandoffContextSlice[];
  /** How the bundle spent the handoff budget. */
  budget: HandoffContextBudget;
}

/**
 * Semantic work handoff between two agent harnesses. All fields are
 * optional — different tasks justify different content (spec v1 §6).
 * This is a *semantic* handoff, not a session-state migration.
 */
export interface HandoffContent {
  originalTask?: string;
  currentObjective?: string;
  progressSummary?: string;
  completedWork?: string[];
  remainingWork?: string[];
  importantDecisions?: string[];
  userConstraints?: string[];
  relevantFiles?: string[];
  workspaceStatus?: string;
  artifacts?: string[];
  testBuildStatus?: string;
  previousRunResult?: string;
  notesForNextAgent?: string;
  /**
   * The context bundle this handoff carries: a checkpoint over the history
   * that did not fit, plus the pinned and retained context that did — all of
   * it projected from the covered runs once, at generation time
   * (`core/handoffContext.ts` + `core/handoffSummary.ts`). Rendered verbatim
   * into the next run's instruction; the mapped fields above are a parsed
   * projection for UI/inspection. Absent on harness-generated and degraded
   * (heuristic) handoffs.
   */
  contextBundle?: HandoffContextBundle;
}

export interface Handoff {
  id: ID;
  taskId: ID;
  /** Run the work was handed over from. */
  fromRunId: ID;
  fromRuntimeId?: ID;
  fromRuntimeName?: string;
  fromRuntimeKind?: RuntimeKind;
  /** Target runtime (known at creation time when the switch is explicit). */
  toRuntimeId?: ID;
  toRuntimeName?: string;
  toRuntimeKind?: RuntimeKind;
  /**
   * Set when the handoff was pre-generated on explicit request (the UI
   * Handoff action): it is harness-agnostic and armed for the next turn —
   * whichever harness that turn runs on — which consumes it as its sole
   * context instead of resuming a native session. Cleared on consumption.
   */
  awaitingNextTurn?: boolean;
  /** Primary generator of the content. */
  source: HandoffSource;
  /** All generators that contributed (e.g. agentfabric + user). */
  sources?: HandoffSource[];
  /**
   * How this context was produced. `heuristic` marks a degraded handoff —
   * the UI must show that, so a digest is never mistaken for a summary.
   */
  generation?: HandoffGeneration;
  content: HandoffContent;
  /** Raw user-provided notes, kept verbatim. */
  userNotes?: string;
  workspaceId?: ID;
  artifactIds: ID[];
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Events & Logs                                                      */
/* ------------------------------------------------------------------ */

export type EventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.timeout"
  | "run.progress"
  | "run.phase"
  | "agent.message"
  | "agent.thinking"
  | "model.request"
  | "model.response"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "usage.updated"
  | "shell.command"
  | "shell.output"
  | "file.created"
  | "file.modified"
  | "artifact.created"
  | "runtime.error"
  | "handoff.generated"
  | "runtime.session.resumed"
  | "runtime.session.created"
  | "native.state.attached"
  | "native.state.persisted"
  | "workspace.attached"
  | "workspace.saved"
  | "workspace.prepared"
  | "source.prepared"
  | "runtime.prepared"
  | "runtime.destroyed"
  | "credential.resolved"
  | "credential.released"
  | "provisioning.prepared"
  | "provisioning.cleaned"
  | "validation.started"
  | "validation.runtime.prepared"
  | "validation.step"
  | "validation.passed"
  | "validation.failed"
  | "git.finalized"
  | "git.revision.frozen"
  | "git.pushed"
  | "publish.failed"
  | "publish.retry.started"
  | "task.recovered"
  | "container.reused"
  | "container.retained"
  | "container.destroyed"
  | "log";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RunEvent {
  id: ID;
  runId: ID;
  seq: number;
  type: EventType;
  timestamp: string;
  data: Record<string, unknown>;
  level?: LogLevel;
  source?: string;
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                          */
/* ------------------------------------------------------------------ */

export type ArtifactKind =
  | "file"
  | "diff"
  | "patch"
  | "report"
  | "test"
  | "build"
  | "text"
  | "link"
  | "other";

export interface Artifact {
  id: ID;
  runId: ID;
  name: string;
  kind: ArtifactKind;
  mime?: string;
  /** Path on disk (workspace-relative or store path). */
  path?: string;
  size?: number;
  /** Inline text content. */
  content?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Usage & Cost                                                       */
/* ------------------------------------------------------------------ */

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Reasoning/thinking tokens (subset of output when reported). */
  reasoningTokens?: number;
  requests: number;
  cost: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /** Reasoning/thinking tokens (subset of output when reported). */
  reasoningTokens?: number;
  modelRequests: number;
  durationMs?: number;
  estimatedCost?: number;
  byModel?: Record<string, ModelUsage>;
}

/* ------------------------------------------------------------------ */
/* Secrets                                                            */
/* ------------------------------------------------------------------ */

export interface Secret {
  id: ID;
  name: string;
  /** Plaintext value; only present in API responses right after creation. */
  value?: string;
  /** Masked preview, e.g. `sk-***abc`. */
  masked: string;
  /** provider | git | runtime | env | service */
  scope: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Agent Profile                                                      */
/* ------------------------------------------------------------------ */

export interface AgentProfile {
  id: ID;
  name: string;
  description?: string;
  runtimeId?: ID;
  modelId?: ID;
  tools?: string[];
  env?: Record<string, string>;
  secretIds?: string[];
  policy?: ExecutionPolicy;
  systemInstructions?: string;
  resourceLimits?: ResourceLimits;
  workspaceConfig?: {
    name?: string;
    type?: WorkspaceType;
    path?: string;
    repoUrl?: string;
    branch?: string;
  };
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

/**
 * Global egress proxy for harness processes (Proxy page). Off by default;
 * when enabled, every newly spawned harness receives standard proxy env
 * vars — running processes and the AgentFabric server itself are not
 * affected.
 */
export interface ProxyConfig {
  enabled?: boolean;
  scheme?: "http" | "socks5";
  host?: string;
  port?: number;
}

/**
 * Which model writes a handoff's checkpoint. Unset, generation follows the
 * run chain: the covered run's own model, else the first enabled model.
 */
export type HandoffModelSource = "configured" | "previous-run" | "first-enabled";

export interface AppConfig {
  server?: {
    host?: string;
    port?: number;
  };
  docker?: {
    socket?: string;
    defaultImage?: string;
  };
  opencode?: {
    bin?: string;
  };
  pi?: {
    bin?: string;
  };
  codex?: {
    bin?: string;
  };
  claudeCode?: {
    bin?: string;
    /** Override for the ~/.claude/projects transcript root (tests). */
    projectsDir?: string;
  };
  proxy?: ProxyConfig;
  handoff?: {
    /**
     * The model that writes handoff checkpoints (Handoffs page). Explicitly
     * configured: when it exists but is unusable (model or provider
     * disabled/missing), generation fails loudly — it never silently falls
     * back to another model. Unset = the covered run's model, else the
     * first enabled model.
     */
    modelId?: string;
  };
}
