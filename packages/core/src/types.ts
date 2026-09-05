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

export type RuntimeKind = "opencode" | "pi" | "docker" | "mock" | "custom";

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
 * Runtime Container lifecycle policies (spec v1 §1).
 *
 * - `ephemeral` (default): a fresh container per Run, destroyed when the
 *   Run completes, fails, is cancelled or times out.
 * - `keep-alive`: the container is retained for a short idle window after
 *   the Run finishes so a follow-up Run on the same harness/workspace can
 *   reuse it; it is destroyed automatically after `idleTimeoutMs`.
 * - `persistent`: long-lived container (daemon agents etc.). Reserved in
 *   the model — not a core implementation goal of this phase — but the
 *   lifecycle model and cleanup paths already honor it.
 */
export type RuntimeLifecycleMode = "ephemeral" | "keep-alive" | "persistent";

export interface RuntimeLifecycle {
  mode: RuntimeLifecycleMode;
  /** Keep-alive only: destroy the container after this much idle time. */
  idleTimeoutMs?: number;
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
  defaultModelId?: ID;
  enabled: boolean;
  /**
   * Ephemeral runtime: container destroyed after the run.
   * Superseded by `lifecycle.mode`; kept for backward compatibility —
   * `ephemeral: false` maps to `lifecycle.mode: "persistent"`.
   */
  ephemeral?: boolean;
  lifecycle?: RuntimeLifecycle;
  /** Declared capabilities; falls back to the adapter's declared set. */
  capabilities?: Partial<RuntimeCapability>;
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
  createdAt: string;
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
  tools?: string[];
  resourceLimits?: ResourceLimits;
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  metadata?: Record<string, unknown>;
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
  /** Resume / handoff / new — how this run relates to previous runs. */
  continuity?: RunContinuity;
  /** Handoff consumed by this run (cross-harness continuation). */
  previousHandoffId?: ID;
  /** Handoff this run produced for a future continuation. */
  generatedHandoffId?: ID;
  /** Runtime-native session reference used/created by this run. */
  runtimeSessionRefId?: ID;
  /** Container lifecycle policy applied to this run. */
  lifecycle?: RuntimeLifecycle;
  /** Per-run execution parameters (override the task's defaults). */
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: string[];
  tools?: string[];
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  error?: string;
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
  /** Primary generator of the content. */
  source: HandoffSource;
  /** All generators that contributed (e.g. agentfabric + user). */
  sources?: HandoffSource[];
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
}
