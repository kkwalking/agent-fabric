import type {
  Artifact,
  ArtifactKind,
  EventType,
  Handoff,
  HandoffContent,
  LogLevel,
  Model,
  Provider,
  Run,
  RunContinuity,
  Runtime,
  RuntimeCapability,
  RuntimeKind,
  RuntimeLifecycle,
  RuntimeLifecycleMode,
  RuntimeNativeState,
  RuntimeSessionRef,
  Secret,
  Task,
  Usage,
  Workspace,
} from "./types.js";

/**
 * A draft artifact produced by a runtime adapter. The orchestrator
 * persists it and links it to the Run.
 */
export interface ArtifactDraft {
  name: string;
  kind: ArtifactKind;
  mime?: string;
  path?: string;
  content?: string;
  meta?: Record<string, unknown>;
}

/**
 * A kept container (keep-alive lifecycle) offered to the adapter for
 * reuse instead of creating a fresh one.
 */
export interface ReusableContainer {
  containerId: string;
  name?: string;
}

/**
 * Everything a runtime adapter needs to execute one Run. Adapters are
 * passive: they emit events/logs through `ctx`, produce artifacts through
 * `ctx.addArtifact`, report usage through `ctx.recordUsage`, and must
 * respect `ctx.signal` (abort = cancel or timeout).
 */
export interface RuntimeContext {
  run: Run;
  task: Task;
  runtime: Runtime;
  model?: Model;
  provider?: Provider;
  workspace?: Workspace;
  secrets: Secret[];
  /** Merged environment: runtime env + task env + profile env + secrets. */
  env: Record<string, string>;
  /** Aborted when the run is cancelled or times out. */
  signal: AbortSignal;
  /** Resolved container lifecycle policy for this run (spec v1 §1). */
  lifecycle: RuntimeLifecycle;
  /** How this run continues the task: new / resume / handoff. */
  continuity: RunContinuity;
  /** Harness-native session to resume (only when continuity === "resume"). */
  runtimeSession?: RuntimeSessionRef;
  /** Handoff consumed by this run (only when continuity === "handoff"). */
  previousHandoff?: Handoff;
  /** A kept container that may be reused (keep-alive lifecycle). */
  reusableContainer?: ReusableContainer;
  /**
   * Harness-native private state attached to this run (containerized
   * runs only, v2 §13–§15). Opaque: mount `path` at `mountPath` and
   * never interpret the contents.
   */
  nativeState?: RuntimeNativeState;
  emit(
    type: EventType,
    data?: Record<string, unknown>,
    opts?: { level?: LogLevel; source?: string }
  ): Promise<void>;
  log(line: string, level?: LogLevel): Promise<void>;
  recordUsage(usage: Usage): void;
  addArtifact(draft: ArtifactDraft): Promise<Artifact>;
  /** Persist the workspace after the run (spec v1 §11 Save). */
  saveWorkspace(): Promise<Workspace | undefined>;
  /** Resolved absolute workspace path on the host (if any). */
  workspacePath?: string;
}

/* ------------------------------------------------------------------ */
/* Execution Backend (v2 §7/§8)                                        */
/* ------------------------------------------------------------------ */

export interface BackendSpawnOptions {
  /** Docker image (containerized backend only). */
  image?: string;
  /** Working directory for a local spawn (host path). */
  cwd?: string;
  /** Environment variables for the process. */
  env?: Record<string, string>;
  /** Container-side path the workspace is mounted at (containerized only). */
  workspaceContainerPath?: string;
  /**
   * Explicit full command to run inside the container. When absent the
   * containerized backend drops the leading local binary name and runs
   * the remaining args (harness images use the harness as entrypoint).
   */
  containerCommand?: string[];
}

/** How a backend process finished. */
export interface BackendExit {
  code: number | null;
  /** Spawn failure (binary missing, daemon unreachable, …). */
  spawnError?: Error;
  /** Container id, when the backend ran inside a container. */
  containerId?: string;
}

/**
 * A harness command running on an execution backend. The backend is a
 * dumb carrier: it streams raw stdout/stderr lines and reports the exit
 * code. It must NOT flatten structured harness output into shell logs —
 * protocol parsing stays in the harness adapter (v2 §7).
 */
export interface BackendProcess {
  /** stdout as a line stream. */
  stdout: AsyncIterable<string>;
  /** stderr as a line stream. */
  stderr: AsyncIterable<string>;
  /** Resolves once the process/container command finishes. */
  exited: Promise<BackendExit>;
  /** Best-effort termination of the process/command. */
  kill(): void;
}

/**
 * The execution carrier under a harness adapter (v2 §7):
 *
 *   Harness Adapter → Execution Backend → (local process | Docker container)
 *
 * Local and containerized execution expose the same interface, so a
 * harness adapter can reuse one output parser for both (v2 §8).
 */
export interface ExecutionBackend {
  readonly type: "local" | "docker";
  spawn(ctx: RuntimeContext, command: string[], opts?: BackendSpawnOptions): Promise<BackendProcess>;
}

export interface RuntimeResult {
  exitCode?: number;
  usage?: Usage;
  error?: string;
  /** Docker container id, when the adapter ran a container. */
  containerId?: string;
  /**
   * Opaque reference to the harness-native session this run created or
   * resumed. AgentFabric stores it verbatim; it is never interpreted.
   */
  nativeSessionRef?: string;
  /** Harness version, when the adapter knows it. */
  runtimeVersion?: string;
  /** Runtime-specific metadata to keep alongside the session reference. */
  nativeSessionMetadata?: Record<string, unknown>;
  /**
   * Harness-generated handoff: a high-quality work summary produced by
   * the harness itself (spec v1 §7), stored for the next continuation.
   */
  handoffContent?: HandoffContent;
}

/**
 * The one interface every AgentFabric Runtime must implement.
 *
 * New community runtimes plug in by implementing this adapter and
 * registering it in the RuntimeRegistry — no core changes required.
 */
export interface AgentRuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly name: string;
  /** Capabilities declared by this harness (spec v1 §17). */
  readonly capabilities?: Partial<RuntimeCapability>;
  /**
   * Capabilities when running under the containerized execution backend
   * (v2 §11): the effective capability set must reflect what the
   * harness can *actually* do behind Docker, not just what it can do
   * locally. Only applied when `runtime.containerized` is true.
   */
  readonly containerizedCapabilities?: Partial<RuntimeCapability>;
  /**
   * Where this harness keeps its private state *inside a container*
   * (v2 §13). AgentFabric mounts an opaque native-state directory at
   * this path so native sessions survive container destruction.
   * Overridable per runtime via `runtime.config.nativeStateMountPath`.
   */
  readonly nativeStateMountPath?: string;
  run(ctx: RuntimeContext): Promise<RuntimeResult>;
  /** Best-effort cancellation of the currently running task. */
  cancel?(ctx: RuntimeContext): Promise<void>;
  /** Best-effort cleanup of the underlying container/process. */
  cleanup?(ctx: RuntimeContext): Promise<void>;
  describe?(): Record<string, unknown>;
}

/** Fallback capability set when an adapter declares nothing. */
export const DEFAULT_ADAPTER_CAPABILITIES: RuntimeCapability = {
  supportsNativeSession: false,
  supportsNativeResume: false,
  supportsStreamingEvents: false,
  supportsHandoffGeneration: false,
  supportsWorkspace: false,
  supportsInteractiveExecution: false,
};

/**
 * Effective capabilities: adapter declaration, narrowed for the real
 * execution backend when the runtime is containerized, then overridden
 * by the runtime record (v2 §11 — declared capabilities must be true
 * under the backend actually in use).
 */
export function effectiveCapabilities(
  adapter: AgentRuntimeAdapter | undefined,
  runtime?: Runtime
): RuntimeCapability {
  const base = { ...DEFAULT_ADAPTER_CAPABILITIES, ...(adapter?.capabilities ?? {}) };
  const backend: Partial<RuntimeCapability> | undefined =
    runtime?.containerized && adapter?.containerizedCapabilities
      ? adapter.containerizedCapabilities
      : undefined;
  return {
    ...base,
    ...(backend ?? {}),
    ...(runtime?.capabilities ?? {}),
  };
}

export type AdapterFactory = (kind: string) => AgentRuntimeAdapter | undefined;

/** Registry of adapters keyed by runtime kind. */
export class RuntimeRegistry {
  private adapters = new Map<string, AgentRuntimeAdapter>();

  register(adapter: AgentRuntimeAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: string): AgentRuntimeAdapter | undefined {
    return this.adapters.get(kind);
  }

  list(): AgentRuntimeAdapter[] {
    return [...this.adapters.values()];
  }
}
