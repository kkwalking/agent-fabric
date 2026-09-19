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
  /**
   * Ephemeral runtime: container destroyed after the run.
   * Superseded by `lifecycle.mode`; kept for backward compatibility —
   * `ephemeral: false` maps to `lifecycle.mode: "persistent"`.
   */
  ephemeral?: boolean;
  lifecycle?: RuntimeLifecycle;
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
