import type {
  Artifact,
  ArtifactKind,
  EventType,
  LogLevel,
  Model,
  Provider,
  Run,
  Runtime,
  RuntimeKind,
  Secret,
  Session,
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
  session?: Session;
  secrets: Secret[];
  /** Merged environment: runtime env + task env + profile env + secrets. */
  env: Record<string, string>;
  /** Aborted when the run is cancelled or times out. */
  signal: AbortSignal;
  emit(
    type: EventType,
    data?: Record<string, unknown>,
    opts?: { level?: LogLevel; source?: string }
  ): Promise<void>;
  log(line: string, level?: LogLevel): Promise<void>;
  recordUsage(usage: Usage): void;
  addArtifact(draft: ArtifactDraft): Promise<Artifact>;
  /** Resolved absolute workspace path on the host (if any). */
  workspacePath?: string;
}

export interface RuntimeResult {
  exitCode?: number;
  usage?: Usage;
  error?: string;
  /** Docker container id, when the adapter ran a container. */
  containerId?: string;
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
  run(ctx: RuntimeContext): Promise<RuntimeResult>;
  /** Best-effort cancellation of the currently running task. */
  cancel?(ctx: RuntimeContext): Promise<void>;
  /** Best-effort cleanup of the underlying container/process. */
  cleanup?(ctx: RuntimeContext): Promise<void>;
  describe?(): Record<string, unknown>;
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
