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

export type ProviderType = "openai" | "openai-compatible" | "anthropic" | "custom";

export interface Provider {
  id: ID;
  name: string;
  type: ProviderType;
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
  /** Convenient alias used when submitting tasks. */
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
  defaultModelId?: string;
  enabled: boolean;
  /** Ephemeral runtime: container destroyed after the run. */
  ephemeral?: boolean;
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
  sessionId?: ID;
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
  sessionId?: ID;
  containerId?: string;
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
/* Session                                                            */
/* ------------------------------------------------------------------ */

export type SessionStatus = "active" | "idle" | "closed";

export interface Session {
  id: ID;
  name?: string;
  runtimeId?: ID;
  workspaceId?: ID;
  modelId?: ID;
  status: SessionStatus;
  runIds: ID[];
  usage?: Usage;
  cost?: number;
  createdAt: string;
  updatedAt: string;
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
  | "agent.message"
  | "agent.thinking"
  | "model.request"
  | "model.response"
  | "tool.started"
  | "tool.completed"
  | "shell.command"
  | "shell.output"
  | "file.created"
  | "file.modified"
  | "artifact.created"
  | "runtime.error"
  | "log";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RunEvent {
  id: ID;
  runId: ID;
  sessionId?: ID;
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
  requests: number;
  cost: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
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
