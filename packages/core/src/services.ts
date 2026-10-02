import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Store, newId } from "./store.js";
import { EventBus } from "./eventbus.js";
import { emptyUsage, addUsage, estimateCost } from "./cost.js";
import { DomainError } from "./errors.js";
import { validateRemoteUrl, checkCredentialBinding, type CredentialBindingCheck, type GitCredentialInput } from "./git.js";
import { assertSecretAllowed, resolveSecretsForPurpose, type SecretPurpose } from "./secrets.js";
import type {
  ID,
  Provider,
  Model,
  Runtime,
  Workspace,
  Task,
  Run,
  RunEvent,
  Artifact,
  Secret,
  AgentProfile,
  AppConfig,
  Usage,
  ModelUsage,
  RunStatus,
  ExecutionPolicy,
  ResourceLimits,
  RuntimeSessionRef,
  RuntimeNativeState,
  Handoff,
  Project,
  SourceProvider,
  SourceType,
  SourceCredential,
  SourceCredentialView,
  SourceCredentialType,
  ProjectExecutionConfig,
  ProjectSkill,
  McpServerConfig,
  ValidationConfig,
  GitPublishPolicy,
  WorkspaceLock,
  BranchMode,
  TaskExecution,
} from "./types.js";

export function now(): string {
  return new Date().toISOString();
}

/**
 * The calendar day (YYYY-MM-DD) an instant falls on in the host's own time
 * zone. Usage history is grouped by this: "today" means the user's today,
 * so a run started at 23:00 in UTC+8 counts there and not on tomorrow.
 */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}***${value.slice(-4)}`;
}

/**
 * Clones a git repository into `dest`. Uses a shallow, single-branch clone
 * when a branch is given; falls back to `git clone` for full history.
 * Rejects when `git` is not available or the clone fails.
 */
export async function cloneGitRepo(repoUrl: string, dest: string, branch?: string): Promise<void> {
  const args = ["clone", "--quiet"];
  if (branch) args.push("--depth", "1", "--branch", branch, "--single-branch");
  args.push(repoUrl, dest);
  await new Promise<void>((resolvePromise, reject) => {
    execFile("git", args, { timeout: 5 * 60 * 1000 }, (err) => {
      if (err) {
        reject(new Error(`Failed to clone ${repoUrl}: ${err instanceof Error ? err.message : String(err)}`));
      } else {
        resolvePromise();
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Provider                                                           */
/* ------------------------------------------------------------------ */

export interface NewProviderInput {
  name: string;
  type: Provider["type"];
  remark?: string;
  website?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export class ProviderService {
  constructor(private store: Store) {}

  list(): Provider[] {
    return this.store.list<Provider>("providers");
  }

  get(id: ID): Provider | undefined {
    return this.store.get<Provider>("providers", id);
  }

  async create(input: NewProviderInput): Promise<Provider> {
    const id = newId("prov");
    let apiKeySecretId: string | undefined;
    let apiKeyMasked: string | undefined;
    if (input.apiKey) {
      const secret = await this.store.insert<Secret>("secrets", {
        id: newId("sec"),
        name: `${input.name} api key`,
        value: input.apiKey,
        masked: maskSecret(input.apiKey),
        scope: "provider",
        createdAt: now(),
        updatedAt: now(),
      });
      apiKeySecretId = secret.id;
      apiKeyMasked = secret.masked;
    }
    const provider: Provider = {
      id,
      name: input.name,
      type: input.type,
      remark: input.remark,
      website: input.website,
      baseUrl: input.baseUrl,
      apiKeySecretId,
      apiKeyMasked,
      headers: input.headers,
      enabled: input.enabled ?? true,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("providers", provider);
  }

  async update(id: ID, patch: Partial<Omit<NewProviderInput, "apiKey">> & { apiKey?: string }): Promise<Provider | undefined> {
    const provider = this.get(id);
    if (!provider) return undefined;
    const { apiKey: _newKey, ...rest } = patch;
    const next: Partial<Provider> = { ...rest, updatedAt: now() };
    // Empty strings mean "cleared in the UI" — persist as absent.
    if (next.remark === "") next.remark = undefined;
    if (next.website === "") next.website = undefined;
    if (next.baseUrl === "") next.baseUrl = undefined;
    if (patch.apiKey) {
      const secret: Secret = {
        id: provider.apiKeySecretId ?? newId("sec"),
        name: `${provider.name} api key`,
        value: patch.apiKey,
        masked: maskSecret(patch.apiKey),
        scope: "provider",
        createdAt: now(),
        updatedAt: now(),
      };
      if (provider.apiKeySecretId) {
        await this.store.update<Secret>("secrets", secret.id, secret);
      } else {
        await this.store.insert("secrets", secret);
      }
      next.apiKeySecretId = secret.id;
      next.apiKeyMasked = secret.masked;
    }
    return this.store.update<Provider>("providers", id, next);
  }

  async remove(id: ID): Promise<boolean> {
    const provider = this.get(id);
    if (!provider) return false;
    const models = this.store.list<Model>("models").filter((m) => m.providerId === id);
    for (const m of models) await this.store.remove("models", m.id);
    if (provider.apiKeySecretId) {
      await this.store.remove("secrets", provider.apiKeySecretId);
    }
    return this.store.remove("providers", id);
  }

  async setEnabled(id: ID, enabled: boolean): Promise<Provider | undefined> {
    return this.store.update<Provider>("providers", id, { enabled, updatedAt: now() });
  }
}

/* ------------------------------------------------------------------ */
/* Model                                                              */
/* ------------------------------------------------------------------ */

export interface NewModelInput {
  providerId: ID;
  name: string;
  alias?: string;
  parameters?: Record<string, unknown>;
  capabilities?: string[];
  enabled?: boolean;
}

export class ModelService {
  constructor(private store: Store) {}

  list(): Model[] {
    return this.store.list<Model>("models");
  }

  get(id: ID): Model | undefined {
    return this.store.get<Model>("models", id);
  }

  findByAlias(alias: string): Model | undefined {
    const models = this.list();
    return (
      models.find((m) => m.alias === alias) ??
      models.find((m) => m.name === alias) ??
      models.find((m) => m.id === alias)
    );
  }

  async create(input: NewModelInput): Promise<Model> {
    const provider = this.store.get<Provider>("providers", input.providerId);
    if (!provider) throw new Error(`Provider not found: ${input.providerId}`);
    const model: Model = {
      id: newId("mod"),
      providerId: input.providerId,
      name: input.name,
      alias: input.alias,
      parameters: input.parameters,
      capabilities: input.capabilities,
      enabled: input.enabled ?? true,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("models", model);
  }

  async update(id: ID, patch: Partial<NewModelInput>): Promise<Model | undefined> {
    return this.store.update<Model>("models", id, { ...patch, updatedAt: now() });
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("models", id);
  }
}

/* ------------------------------------------------------------------ */
/* Runtime                                                            */
/* ------------------------------------------------------------------ */

export interface NewRuntimeInput {
  name: string;
  kind: Runtime["kind"];
  description?: string;
  image?: string;
  command?: string[];
  cwd?: string;
  containerized?: boolean;
  credentialSource?: Runtime["credentialSource"];
  defaultModelId?: ID;
  enabled?: boolean;
  /** See `Runtime.usableInTask`; defaults to the kind-level table below. */
  usableInTask?: boolean;
  ephemeral?: boolean;
  lifecycle?: Runtime["lifecycle"];
  capabilities?: Runtime["capabilities"];
  /** Explicit context window of the model this runtime runs (v9 §5). */
  contextWindow?: number;
  resourceLimits?: ResourceLimits;
  env?: Record<string, string>;
  secretIds?: ID[];
  networkPolicy?: Runtime["networkPolicy"];
  filesystemPolicy?: Runtime["filesystemPolicy"];
  config?: Record<string, unknown>;
  /**
   * Declared execution backend (v11 hardening §4). `isolated` marks the
   * runtime eligible for Project Coding Tasks; `host` marks it
   * development-only. Absent derives from `containerized`.
   */
  executionBackend?: Runtime["executionBackend"];
}

/**
 * Kind-level default for `Runtime.usableInTask` — which runtime kinds
 * start out allowed to execute AgentFabric tasks. `codex` /
 * `claude-code` stay false until the user opts in even though adapters
 * exist; discovery-only kinds (zcode: sessions are found and adopted,
 * but no runner adapter exists yet) and the mock default to false; the
 * Runtimes page toggles the per-record value, so this table only decides
 * what a *new* runtime record starts at.
 */
const USABLE_IN_TASK_BY_KIND: Record<Runtime["kind"], boolean> = {
  opencode: true,
  pi: true,
  codex: false,
  "claude-code": false,
  zcode: false,
  dsh: true,
  docker: false,
  mock: false,
  custom: false,
};

export function defaultUsableInTask(kind: Runtime["kind"]): boolean {
  return USABLE_IN_TASK_BY_KIND[kind] ?? false;
}

export class RuntimeService {
  constructor(private store: Store) {}

  list(): Runtime[] {
    return this.store.list<Runtime>("runtimes");
  }

  enabled(): Runtime[] {
    return this.list().filter((r) => r.enabled);
  }

  get(id: ID): Runtime | undefined {
    return this.store.get<Runtime>("runtimes", id);
  }

  async create(input: NewRuntimeInput): Promise<Runtime> {
    // Legacy `ephemeral: false` maps to the persistent lifecycle mode.
    const lifecycle = input.lifecycle ?? (input.ephemeral === false ? { mode: "persistent" as const } : { mode: "ephemeral" as const });
    const runtime: Runtime = {
      id: newId("rt"),
      name: input.name,
      kind: input.kind,
      description: input.description,
      image: input.image,
      command: input.command,
      cwd: input.cwd,
      containerized: input.containerized ?? false,
      executionBackend: input.executionBackend,
      credentialSource: input.credentialSource,
      defaultModelId: input.defaultModelId,
      enabled: input.enabled ?? true,
      usableInTask: input.usableInTask ?? defaultUsableInTask(input.kind),
      ephemeral: input.ephemeral ?? lifecycle.mode === "ephemeral",
      lifecycle,
      capabilities: input.capabilities,
      contextWindow: input.contextWindow,
      resourceLimits: input.resourceLimits,
      env: input.env,
      secretIds: input.secretIds,
      networkPolicy: input.networkPolicy,
      filesystemPolicy: input.filesystemPolicy,
      config: input.config,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("runtimes", runtime);
  }

  async update(id: ID, patch: Partial<NewRuntimeInput>): Promise<Runtime | undefined> {
    return this.store.update<Runtime>("runtimes", id, { ...patch, updatedAt: now() });
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("runtimes", id);
  }

  async setEnabled(id: ID, enabled: boolean): Promise<Runtime | undefined> {
    return this.store.update<Runtime>("runtimes", id, { enabled, updatedAt: now() });
  }
}

/* ------------------------------------------------------------------ */
/* Workspace                                                          */
/* ------------------------------------------------------------------ */

export interface NewWorkspaceInput {
  name: string;
  type: Workspace["type"];
  path?: string;
  repoUrl?: string;
  branch?: string;
  mountPath?: string;
  persistent?: boolean;
}

/**
 * Workspaces are durable, runtime-neutral working environments
 * (spec v1 §10–§14). They outlive Tasks, Runs and Runtime Containers:
 * containers attach to a workspace for the duration of a run and can be
 * destroyed freely, while the workspace directory — the work itself —
 * persists on the host.
 */
export class WorkspaceService {
  constructor(private store: Store) {}

  list(): Workspace[] {
    return this.store.list<Workspace>("workspaces");
  }

  get(id: ID): Workspace | undefined {
    return this.store.get<Workspace>("workspaces", id);
  }

  async create(input: NewWorkspaceInput): Promise<Workspace> {
    const id = newId("ws");
    let path = input.path;
    if (input.type === "local" && path) {
      const abs = resolve(path);
      await mkdir(abs, { recursive: true });
      path = abs;
    }
    if (input.type === "git" && input.repoUrl) {
      // Clone the repository into the store's data directory so the
      // workspace is a real, mountable directory (not just a record).
      const cloneDir = join(this.store.dataDir, "workspaces", id);
      await mkdir(dirname(cloneDir), { recursive: true });
      await cloneGitRepo(input.repoUrl, cloneDir, input.branch);
      path = cloneDir;
    }
    const workspace: Workspace = {
      id,
      name: input.name,
      type: input.type,
      path,
      repoUrl: input.repoUrl,
      branch: input.branch,
      mountPath: input.mountPath ?? "/workspace",
      persistent: input.persistent ?? true,
      source: "create",
      status: "ready",
      ownership: "external",
      createdAt: now(),
    };
    return this.store.insert("workspaces", workspace);
  }

  /**
   * Create the platform-managed working copy for one Project-based Task
   * (v11 §5.1/§10). The directory is created eagerly and owned by the
   * platform; the Git content is prepared by the execution supervisor.
   *
   * One Task = one managed Workspace, never shared with another Task.
   */
  async createManaged(input: {
    name: string;
    projectId: ID;
    taskId: ID;
    repoUrl: string;
    workingBranch?: string;
    mountPath?: string;
  }): Promise<Workspace> {
    const id = newId("ws");
    const path = join(this.store.dataDir, "workspaces", id);
    try {
      await mkdir(path, { recursive: true });
    } catch (err) {
      throw new DomainError(
        "workspace-create-failed",
        `Could not create the managed workspace directory: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const workspace: Workspace = {
      id,
      name: input.name,
      type: "git",
      path,
      repoUrl: input.repoUrl,
      branch: input.workingBranch,
      workingBranch: input.workingBranch,
      mountPath: input.mountPath ?? "/workspace",
      persistent: true,
      source: "create",
      status: "ready",
      ownership: "managed",
      projectId: input.projectId,
      taskId: input.taskId,
      createdAt: now(),
    };
    return this.store.insert("workspaces", workspace);
  }

  /**
   * Import an existing working directory or git repository into
   * AgentFabric as a Workspace (spec v1 §11 Import). The directory is
   * used in place — AgentFabric does not copy or take ownership of it.
   */
  async import(input: NewWorkspaceInput): Promise<Workspace> {
    if (input.type === "git" && input.repoUrl) {
      const ws = await this.create(input);
      await this.store.update<Workspace>("workspaces", ws.id, { source: "import" });
      return { ...ws, source: "import" };
    }
    const rawPath = input.path;
    if (!rawPath) throw new Error("workspace import requires `path` (local directory) or `repoUrl` (git)");
    const abs = resolve(rawPath);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new Error(`Cannot import workspace: path does not exist: ${abs}`);
    }
    if (!st.isDirectory()) throw new Error(`Cannot import workspace: not a directory: ${abs}`);
    const id = newId("ws");
    const workspace: Workspace = {
      id,
      name: input.name,
      type: input.type === "git" ? "git" : "local",
      path: abs,
      repoUrl: input.repoUrl,
      branch: input.branch,
      mountPath: input.mountPath ?? "/workspace",
      persistent: input.persistent ?? true,
      source: "import",
      status: "ready",
      ownership: "external",
      createdAt: now(),
    };
    return this.store.insert("workspaces", workspace);
  }

  /**
   * Ensure the workspace's contents are persisted after a Run
   * (spec v1 §11 Save). Local/git workspaces are host directories that
   * containers mount read-write, so modifications are already durable —
   * `save` verifies the directory still exists and records the save so
   * users (and handoffs) can trust the workspace state.
   */
  async save(id: ID, runId?: ID): Promise<Workspace> {
    const ws = this.get(id);
    if (!ws) throw new Error(`Workspace not found: ${id}`);
    if (ws.path) {
      try {
        const st = await stat(ws.path);
        if (!st.isDirectory()) throw new Error(`Workspace path is not a directory: ${ws.path}`);
      } catch {
        await this.store.update<Workspace>("workspaces", id, { status: "missing" });
        throw new Error(`Workspace directory is missing: ${ws.path}`);
      }
    }
    const saved = await this.store.update<Workspace>("workspaces", id, {
      status: "ready",
      lastSavedAt: now(),
      lastSavedRunId: runId,
    });
    return saved!;
  }

  async update(id: ID, patch: Partial<NewWorkspaceInput>): Promise<Workspace | undefined> {
    return this.store.update<Workspace>("workspaces", id, patch);
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("workspaces", id);
  }

  /** Tasks and runs currently referencing this workspace. */
  usage(id: ID): { tasks: ID[]; runs: ID[] } {
    return {
      tasks: this.store.list<Task>("tasks").filter((t) => t.workspaceId === id).map((t) => t.id),
      runs: this.store.list<Run>("runs").filter((r) => r.workspaceId === id).map((r) => r.id),
    };
  }

  async ensureExists(input: NewWorkspaceInput): Promise<Workspace> {
    const existing = this.list().find((w) => w.type === input.type && w.path === input.path && w.repoUrl === input.repoUrl);
    return existing ?? this.create(input);
  }
}

/* ------------------------------------------------------------------ */
/* Secrets                                                            */
/* ------------------------------------------------------------------ */

export interface NewSecretInput {
  name: string;
  value: string;
  scope?: Secret["scope"];
}

export class SecretService {
  constructor(private store: Store) {}

  list(): Secret[] {
    return this.store.list<Secret>("secrets").map(({ value: _v, ...rest }) => rest);
  }

  get(id: ID): Secret | undefined {
    const s = this.store.get<Secret>("secrets", id);
    if (!s) return undefined;
    const { value: _v, ...rest } = s;
    return rest;
  }

  getWithValue(id: ID): Secret | undefined {
    return this.store.get<Secret>("secrets", id);
  }

  async create(input: NewSecretInput): Promise<Secret> {
    const secret: Secret = {
      id: newId("sec"),
      name: input.name,
      value: input.value,
      masked: maskSecret(input.value),
      scope: input.scope ?? "env",
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("secrets", secret);
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("secrets", id);
  }

  /**
   * Resolves secret ids for a **purpose**, enforcing the scope policy at the
   * resolution boundary (v11 hardening §8.3). `purpose` defaults to
   * `agent-runtime` — the safest default: a caller that forgets to say why it
   * wants a secret still cannot obtain a git-scoped one.
   */
  resolve(ids: ID[] | undefined, purpose: SecretPurpose = "agent-runtime"): Secret[] {
    return resolveSecretsForPurpose(ids, purpose, (id) => this.getWithValue(id));
  }

  /**
   * Resolves the Git credential material a Source Credential points at. This
   * is the *only* path allowed to read a `git`-scoped secret, and it is
   * reachable only from `SourceCredentialService.resolve` — the credential
   * broker.
   */
  resolveForGit(ids: ID[] | undefined): Secret[] {
    return resolveSecretsForPurpose(ids, "git", (id) => this.getWithValue(id));
  }
}

/* ------------------------------------------------------------------ */
/* Agent Profile                                                      */
/* ------------------------------------------------------------------ */

export interface NewProfileInput {
  name: string;
  description?: string;
  runtimeId?: ID;
  modelId?: ID;
  tools?: string[];
  env?: Record<string, string>;
  secretIds?: ID[];
  policy?: ExecutionPolicy;
  systemInstructions?: string;
  resourceLimits?: ResourceLimits;
  workspaceConfig?: AgentProfile["workspaceConfig"];
}

export class ProfileService {
  constructor(private store: Store) {}

  list(): AgentProfile[] {
    return this.store.list<AgentProfile>("profiles");
  }

  get(id: ID): AgentProfile | undefined {
    return this.store.get<AgentProfile>("profiles", id);
  }

  async create(input: NewProfileInput): Promise<AgentProfile> {
    const profile: AgentProfile = {
      id: newId("prof"),
      name: input.name,
      description: input.description,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      tools: input.tools,
      env: input.env,
      secretIds: input.secretIds,
      policy: input.policy,
      systemInstructions: input.systemInstructions,
      resourceLimits: input.resourceLimits,
      workspaceConfig: input.workspaceConfig,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("profiles", profile);
  }

  async update(id: ID, patch: Partial<NewProfileInput>): Promise<AgentProfile | undefined> {
    return this.store.update<AgentProfile>("profiles", id, { ...patch, updatedAt: now() });
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("profiles", id);
  }
}

/* ------------------------------------------------------------------ */
/* Task                                                               */
/* ------------------------------------------------------------------ */

export interface NewTaskInput {
  /**
   * Explicit task id. The execution supervisor generates it up front because
   * the managed workspace and the system-generated working branch are both
   * derived from it (v11 §8).
   */
  id?: ID;
  title?: string;
  prompt: string;
  runtimeId?: ID;
  modelId?: ID;
  workspaceId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: ID[];
  /** Secrets the Task's validation commands may receive (v11 hardening §6.2). */
  validationSecretIds?: ID[];
  tools?: string[];
  resourceLimits?: ResourceLimits;
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  /** Container lifecycle override for the run (spec v1 §1). */
  lifecycle?: Runtime["lifecycle"];
  metadata?: Record<string, unknown>;
  /** Project-based Task fields (v11 §6). */
  projectId?: ID;
  baseRef?: string;
  baseCommitSha?: string;
  workingBranch?: string;
  branchMode?: BranchMode;
  validation?: ValidationConfig;
  git?: GitPublishPolicy;
  execution?: TaskExecution;
}

/**
 * How long a soft-deleted task stays recoverable before the server's
 * purge pass physically removes it with everything it owns.
 */
export const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class TaskService {
  constructor(private store: Store) {}

  /** `deleted` narrows the list: `false` = live tasks, `true` = deleted ones, absent = both. */
  list(filter?: { deleted?: boolean }): Task[] {
    const all = this.store.list<Task>("tasks");
    if (filter?.deleted === undefined) return all;
    return all.filter((t) => (t.deletedAt != null) === filter.deleted);
  }

  get(id: ID): Task | undefined {
    return this.store.get<Task>("tasks", id);
  }

  /** The task when it has not been soft-deleted — the only form task-scoped reads and actions accept. */
  getLive(id: ID): Task | undefined {
    const task = this.get(id);
    return task?.deletedAt == null ? task : undefined;
  }

  async create(input: NewTaskInput): Promise<Task> {
    const task: Task = {
      id: input.id ?? newId("task"),
      title: input.title ?? input.prompt.slice(0, 80),
      prompt: input.prompt,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      env: input.env,
      secretIds: input.secretIds,
      validationSecretIds: input.validationSecretIds,
      tools: input.tools,
      resourceLimits: input.resourceLimits,
      timeoutMs: input.timeoutMs,
      policy: input.policy,
      metadata: input.metadata,
      projectId: input.projectId,
      baseRef: input.baseRef,
      baseCommitSha: input.baseCommitSha,
      workingBranch: input.workingBranch,
      branchMode: input.branchMode,
      validation: input.validation,
      git: input.git,
      execution: input.execution,
      createdAt: now(),
    };
    return this.store.insert("tasks", task);
  }

  async update(id: ID, patch: Partial<NewTaskInput>): Promise<Task | undefined> {
    return this.store.update<Task>("tasks", id, patch);
  }

  /** Soft delete: stamp `deletedAt`, hide from live lists, keep everything for restore. */
  async softDelete(id: ID): Promise<Task | undefined> {
    const task = this.get(id);
    if (!task || task.deletedAt != null) return undefined;
    return this.store.update<Task>("tasks", id, { deletedAt: now() });
  }

  /** Clear the soft-delete stamp. Fails for unknown or live tasks. */
  async restore(id: ID): Promise<Task | undefined> {
    const task = this.get(id);
    if (!task || task.deletedAt == null) return undefined;
    return this.store.update<Task>("tasks", id, { deletedAt: undefined });
  }

  /**
   * Physically delete tasks whose `deletedAt` is older than `retentionMs`:
   * the task record plus its runs, run event shards, artifacts, handoffs
   * and runtime session references. A **managed** workspace belonging to the
   * task is removed with it (record + directory); external workspaces are
   * user-owned and never touched. Returns the purged task ids.
   */
  async purgeExpired(retentionMs: number = TASK_RETENTION_MS): Promise<ID[]> {
    const cutoff = Date.now() - retentionMs;
    const expired = this.list({ deleted: true }).filter((t) => Date.parse(t.deletedAt!) <= cutoff);
    const purged: ID[] = [];
    for (const task of expired) {
      const runs = this.store.list<Run>("runs").filter((r) => r.taskId === task.id);
      for (const run of runs) {
        for (const artifact of this.store.list<Artifact>("artifacts").filter((a) => a.runId === run.id)) {
          await this.store.remove("artifacts", artifact.id);
        }
        await this.store.removeEventShard(run.id);
        await this.store.remove("runs", run.id);
      }
      for (const h of this.store.list<Handoff>("handoffs").filter((h) => h.taskId === task.id)) {
        await this.store.remove("handoffs", h.id);
      }
      for (const s of this.store.list<RuntimeSessionRef>("runtimeSessions").filter((s) => s.taskId === task.id)) {
        await this.store.remove("runtimeSessions", s.id);
      }
      for (const lock of this.store.list<WorkspaceLock>("workspaceLocks").filter((l) => l.taskId === task.id)) {
        await this.store.remove("workspaceLocks", lock.id);
      }
      // Managed workspaces exist only to serve their task: they go with it.
      for (const ws of this.store.list<Workspace>("workspaces").filter((w) => w.taskId === task.id && w.ownership === "managed")) {
        if (ws.path) await rm(ws.path, { recursive: true, force: true });
        await this.store.remove("workspaces", ws.id);
      }
      await this.store.remove("tasks", task.id);
      purged.push(task.id);
    }
    return purged;
  }
}

/* ------------------------------------------------------------------ */
/* Runtime Native State (v2 §13–§15)                                   */
/* ------------------------------------------------------------------ */

/**
 * Manages the opaque, per-runtime state directories harnesses need for
 * native resume. AgentFabric creates, mounts, preserves, reattaches and
 * deletes these directories — it never inspects their contents
 * (v2: "Runtime native state is opaque").
 *
 * The state is distinct from a Workspace: it holds harness plumbing
 * (native session stores, internal databases), not user work.
 */
export class NativeStateService {
  constructor(private store: Store) {}

  list(filter?: { runtimeId?: ID }): RuntimeNativeState[] {
    return this.store
      .list<RuntimeNativeState>("nativeStates")
      .filter((s) => !filter?.runtimeId || s.runtimeId === filter.runtimeId);
  }

  get(id: ID): RuntimeNativeState | undefined {
    return this.store.get<RuntimeNativeState>("nativeStates", id);
  }

  /**
   * Create (or reattach) the native state directory for a runtime. The
   * same runtime always maps to the same directory, so an ephemeral
   * container's harness state survives container destruction and the
   * next run reattaches it (v2 §15).
   */
  async ensureForRuntime(runtime: Runtime, mountPath: string): Promise<RuntimeNativeState> {
    const existing = this.list({ runtimeId: runtime.id })[0];
    if (existing) {
      await mkdir(existing.path, { recursive: true });
      if (existing.mountPath !== mountPath) {
        return (await this.store.update<RuntimeNativeState>("nativeStates", existing.id, {
          mountPath,
          updatedAt: now(),
        }))!;
      }
      return existing;
    }
    const id = newId("nstate");
    const path = join(this.store.dataDir, "native-state", runtime.id);
    await mkdir(path, { recursive: true });
    return this.store.insert<RuntimeNativeState>("nativeStates", {
      id,
      runtimeId: runtime.id,
      runtimeKind: runtime.kind,
      path,
      mountPath,
      createdAt: now(),
      updatedAt: now(),
    });
  }

  /** Record which run last attached this state (v2 §15 Preserve). */
  async markUsed(id: ID, runId: ID): Promise<RuntimeNativeState | undefined> {
    return this.store.update<RuntimeNativeState>("nativeStates", id, {
      lastUsedRunId: runId,
      lastUsedAt: now(),
      updatedAt: now(),
    });
  }

  /** Delete the record and its on-disk directory (v2 §14 Delete). */
  async remove(id: ID): Promise<boolean> {
    const state = this.get(id);
    if (!state) return false;
    await rm(state.path, { recursive: true, force: true });
    return this.store.remove("nativeStates", id);
  }
}

/* ------------------------------------------------------------------ */
/* Runtime Session References (spec v1 §3/§9, v2 §2/§6)                */
/* ------------------------------------------------------------------ */

export interface NewRuntimeSessionInput {
  runtimeId?: ID;
  runtimeKind: RuntimeSessionRef["runtimeKind"];
  runtimeName?: string;
  runtimeVersion?: string;
  nativeSessionRef: string;
  resumeSupported: boolean;
  taskId?: ID;
  runId: ID;
  workspaceId?: ID;
  /** Native state the session depends on (reattached on resume). */
  nativeStateId?: ID;
  /** Execution backend the session was created under. */
  executionBackend?: "local" | "docker";
  metadata?: Record<string, unknown>;
}

/**
 * Stores opaque references to harness-native sessions. AgentFabric never
 * inspects or transforms the session payload — the reference is only used
 * to resume the *same* harness. Cross-harness continuation goes through
 * Handoff, never through these references.
 */

/**
 * Workspace compatibility for native resume (v3 §14): a native session
 * is bound to the working context (working directory / project state)
 * it was created in, so a session is only resumable in the workspace it
 * belongs to. Two `undefined` workspaces (no workspace at all, on both
 * sides) are compatible; anything else requires the same workspace id.
 */
export function sameResumeWorkspace(refWorkspace: ID | undefined, runWorkspace: ID | undefined): boolean {
  if (refWorkspace === undefined && runWorkspace === undefined) return true;
  return refWorkspace !== undefined && runWorkspace !== undefined && refWorkspace === runWorkspace;
}

export class RuntimeSessionService {
  constructor(private store: Store) {}

  list(filter?: { taskId?: ID; runtimeKind?: string; runtimeId?: ID }): RuntimeSessionRef[] {
    const all = this.store.list<RuntimeSessionRef>("runtimeSessions");
    return all
      .filter(
        (s) =>
          (!filter?.taskId || s.taskId === filter.taskId) &&
          (!filter?.runtimeKind || s.runtimeKind === filter.runtimeKind) &&
          (!filter?.runtimeId || s.runtimeId === filter.runtimeId)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: ID): RuntimeSessionRef | undefined {
    return this.store.get<RuntimeSessionRef>("runtimeSessions", id);
  }

  async register(input: NewRuntimeSessionInput): Promise<RuntimeSessionRef> {
    const ref: RuntimeSessionRef = {
      id: newId("rses"),
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      runtimeName: input.runtimeName,
      runtimeVersion: input.runtimeVersion,
      nativeSessionRef: input.nativeSessionRef,
      resumeSupported: input.resumeSupported,
      taskId: input.taskId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      nativeStateId: input.nativeStateId,
      executionBackend: input.executionBackend,
      status: "active",
      metadata: input.metadata,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("runtimeSessions", ref);
  }

  /**
   * The most recent resumable native session for a task on a given
   * runtime kind — the *candidate* for Resume vs Handoff. The full
   * compatibility decision (capability, native state, workspace —
   * v3 §13–§15) is made by the orchestrator's resume gate.
   */
  latestResumable(taskId: ID, runtimeKind: string): RuntimeSessionRef | undefined {
    return this.list({ taskId }).find(
      (s) => s.runtimeKind === runtimeKind && s.resumeSupported && s.status === "active"
    );
  }

  async expire(id: ID): Promise<RuntimeSessionRef | undefined> {
    return this.store.update<RuntimeSessionRef>("runtimeSessions", id, { status: "expired", updatedAt: now() });
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("runtimeSessions", id);
  }
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                          */
/* ------------------------------------------------------------------ */

export interface NewArtifactInput {
  runId: ID;
  name: string;
  kind?: Artifact["kind"];
  mime?: string;
  path?: string;
  content?: string;
  meta?: Record<string, unknown>;
}

export class ArtifactService {
  constructor(private store: Store) {}

  list(runId?: ID): Artifact[] {
    const all = this.store.list<Artifact>("artifacts");
    return runId ? all.filter((a) => a.runId === runId) : all;
  }

  get(id: ID): Artifact | undefined {
    return this.store.get<Artifact>("artifacts", id);
  }

  async create(input: NewArtifactInput): Promise<Artifact> {
    const size = input.content ? Buffer.byteLength(input.content, "utf8") : 0;
    const artifact: Artifact = {
      id: newId("art"),
      runId: input.runId,
      name: input.name,
      kind: input.kind ?? "text",
      mime: input.mime,
      path: input.path,
      size,
      content: input.content,
      meta: input.meta,
      createdAt: now(),
    };
    await this.store.insert("artifacts", artifact);
    const run = this.store.get<Run>("runs", input.runId);
    if (run) {
      run.artifactIds = [...run.artifactIds, artifact.id];
      run.updatedAt = now();
      await this.store.commit();
    }
    return artifact;
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("artifacts", id);
  }
}

/* ------------------------------------------------------------------ */
/* Usage                                                              */
/* ------------------------------------------------------------------ */

export interface UsageSummary {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelRequests: number;
  estimatedCost: number;
  durationMs: number;
  byModel: Record<string, ModelUsage>;
  byProvider: Record<string, { requests: number; cost: number }>;
  history: Array<{ date: string; cost: number; requests: number; tokens: number }>;
}

export class UsageService {
  constructor(private store: Store) {}

  private allRuns(): Run[] {
    return this.store.list<Run>("runs");
  }

  summary(): UsageSummary {
    const runs = this.allRuns().filter((r) => r.status === "completed" || r.status === "failed" || r.status === "timeout");
    const total = emptyUsage();
    const byProvider: Record<string, { requests: number; cost: number }> = {};
    const history = new Map<string, { cost: number; requests: number; tokens: number }>();

    for (const run of runs) {
      const u = run.usage ?? emptyUsage();
      total.inputTokens += u.inputTokens;
      total.outputTokens += u.outputTokens;
      total.cachedTokens = (total.cachedTokens ?? 0) + (u.cachedTokens ?? 0);
      total.modelRequests += u.modelRequests;
      total.estimatedCost = (total.estimatedCost ?? 0) + (u.estimatedCost ?? 0);
      total.durationMs = (total.durationMs ?? 0) + (u.durationMs ?? 0);
      total.byModel = addUsage(total, u).byModel;

      if (run.providerId) {
        const p = byProvider[run.providerId] ?? { requests: 0, cost: 0 };
        p.requests += u.modelRequests;
        p.cost += u.estimatedCost ?? 0;
        byProvider[run.providerId] = p;
      }

      // The day a run's usage belongs to is a calendar day where the user
      // is, not a UTC one: slicing the ISO timestamp would file a 23:00
      // run in UTC+8 under the next day. Derived per read from the same
      // stored timestamps, like the rest of this summary.
      const day = localDay(run.endTime ?? run.updatedAt);
      const h = history.get(day) ?? { cost: 0, requests: 0, tokens: 0 };
      h.cost += u.estimatedCost ?? 0;
      h.requests += u.modelRequests;
      h.tokens += u.inputTokens + u.outputTokens;
      history.set(day, h);
    }

    return {
      runs: runs.length,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      cachedTokens: total.cachedTokens ?? 0,
      modelRequests: total.modelRequests,
      estimatedCost: Number((total.estimatedCost ?? 0).toFixed(6)),
      durationMs: total.durationMs ?? 0,
      byModel: total.byModel ?? {},
      byProvider,
      history: [...history.entries()]
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Project (v11 §2/§3)                                                */
/* ------------------------------------------------------------------ */

export interface NewProjectInput {
  name: string;
  description?: string;
  source: {
    type?: SourceType;
    remoteUrl: string;
    provider?: SourceProvider;
    defaultBranch?: string;
    credentialId?: ID;
  };
  execution?: ProjectExecutionConfig;
  skills?: ProjectSkill[];
  mcpServers?: McpServerConfig[];
  validation?: ValidationConfig;
  git?: GitPublishPolicy;
}

/** Infers the provider from the host so users never have to pick one. */
export function inferSourceProvider(remoteUrl: string): SourceProvider {
  const url = remoteUrl.toLowerCase();
  if (url.includes("github.com")) return "github";
  if (url.includes("gitlab")) return "gitlab";
  if (url.includes("gitee.com")) return "gitee";
  return "generic";
}

/**
 * Projects are the long-lived top-level business resource (v11 §2): one
 * codebase AgentFabric keeps working on. A Project owns its source definition
 * and the execution defaults every Task inherits; it never holds a working
 * copy (that is the Workspace's job) and never holds credential material
 * (that is the SourceCredential's job).
 */
export class ProjectService {
  constructor(private store: Store) {}

  list(): Project[] {
    return this.store.list<Project>("projects");
  }

  get(id: ID): Project | undefined {
    return this.store.get<Project>("projects", id);
  }

  async create(input: NewProjectInput): Promise<Project> {
    const name = input.name?.trim();
    if (!name) throw new DomainError("project-invalid", "A project needs a name");
    const remoteUrl = input.source?.remoteUrl?.trim();
    if (!remoteUrl) throw new DomainError("project-invalid", "A project needs a repository URL");
    const urlCheck = validateRemoteUrl(remoteUrl);
    if (!urlCheck.ok) throw new DomainError("source-url-invalid", urlCheck.reason);
    const type = input.source.type ?? "git";
    if (type !== "git") throw new DomainError("project-invalid", `Unsupported source type: ${String(type)}`);
    if (input.source.credentialId) {
      const credential = this.store.get<SourceCredential>("sourceCredentials", input.source.credentialId);
      if (!credential) {
        throw new DomainError("credential-not-found", `Source credential not found: ${input.source.credentialId}`);
      }
      // Host binding + transport compatibility are checked at configuration
      // time (v11 hardening §10.2), so an unusable pairing fails here rather
      // than after a clone was attempted.
      assertCredentialBinding(credential, remoteUrl);
    }
    const project: Project = {
      id: newId("proj"),
      name,
      description: input.description,
      source: {
        type: "git",
        remoteUrl,
        provider: input.source.provider ?? inferSourceProvider(remoteUrl),
        defaultBranch: input.source.defaultBranch?.trim() || "main",
        credentialId: input.source.credentialId,
      },
      execution: input.execution,
      skills: input.skills,
      mcpServers: input.mcpServers,
      validation: input.validation,
      git: input.git,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("projects", project);
  }

  async update(id: ID, patch: Partial<NewProjectInput>): Promise<Project | undefined> {
    const project = this.get(id);
    if (!project) return undefined;
    const next: Partial<Project> = { updatedAt: now() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new DomainError("project-invalid", "A project needs a name");
      next.name = name;
    }
    if (patch.description !== undefined) next.description = patch.description || undefined;
    if (patch.source !== undefined) {
      const remoteUrl = patch.source.remoteUrl?.trim();
      if (!remoteUrl) throw new DomainError("project-invalid", "A project needs a repository URL");
      const urlCheck = validateRemoteUrl(remoteUrl);
      if (!urlCheck.ok) throw new DomainError("source-url-invalid", urlCheck.reason);
      // The credential may be carried over from the current source; either
      // way the *resulting* pairing must satisfy the host binding (§9/§10).
      const credentialId = patch.source.credentialId !== undefined ? patch.source.credentialId : project.source.credentialId;
      if (credentialId) {
        const credential = this.store.get<SourceCredential>("sourceCredentials", credentialId);
        if (!credential) throw new DomainError("credential-not-found", `Source credential not found: ${credentialId}`);
        assertCredentialBinding(credential, remoteUrl);
      }
      next.source = {
        type: "git",
        remoteUrl,
        provider: patch.source.provider ?? inferSourceProvider(remoteUrl),
        defaultBranch: patch.source.defaultBranch?.trim() || project.source.defaultBranch || "main",
        credentialId,
      };
    }
    if (patch.execution !== undefined) next.execution = patch.execution;
    if (patch.skills !== undefined) next.skills = patch.skills;
    if (patch.mcpServers !== undefined) next.mcpServers = patch.mcpServers;
    if (patch.validation !== undefined) next.validation = patch.validation;
    if (patch.git !== undefined) next.git = patch.git;
    return this.store.update<Project>("projects", id, next);
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("projects", id);
  }

  /** Tasks belonging to this project (live and deleted alike). */
  taskIds(id: ID): ID[] {
    return this.store.list<Task>("tasks").filter((t) => t.projectId === id).map((t) => t.id);
  }
}

/* ------------------------------------------------------------------ */
/* Source Credential (v11 §4)                                         */
/* ------------------------------------------------------------------ */

/**
 * Project-level credential binding check (v11 hardening §9/§10): a Project
 * may only reference a credential that is scoped to its repository host and
 * compatible with its transport. Kept as a free function so both the Project
 * service and the supervisor's preflight run the exact same rule.
 */
export function assertCredentialBinding(credential: SourceCredential, remoteUrl: string): void {
  const check = checkCredentialBinding(credential, remoteUrl);
  if (check.ok) return;
  throw new DomainError(check.code, check.message, check.detail);
}

export interface NewSourceCredentialInput {
  name: string;
  type: SourceCredentialType;
  host?: string;
  username?: string;
  /** HTTPS token (type `https-token`) or PEM private key (`ssh-key`). */
  value?: string;
  /** SSH key passphrase, when the key is encrypted. */
  passphrase?: string;
  knownHosts?: string;
  /** Reference an existing Secret instead of creating one from `value`. */
  secretId?: ID;
}

/**
 * Reusable Git credentials (v11 §4). The sensitive value always lives in the
 * existing Secret store: this record is metadata plus a Secret reference, and
 * the API only ever serves the masked preview.
 */
export class SourceCredentialService {
  constructor(private store: Store) {}

  list(): SourceCredentialView[] {
    return this.store
      .list<SourceCredential>("sourceCredentials")
      .map((c) => this.toView(c));
  }

  get(id: ID): SourceCredential | undefined {
    return this.store.get<SourceCredential>("sourceCredentials", id);
  }

  getView(id: ID): SourceCredentialView | undefined {
    const credential = this.get(id);
    return credential ? this.toView(credential) : undefined;
  }

  private toView(credential: SourceCredential): SourceCredentialView {
    const secret = this.store.get<Secret>("secrets", credential.secretId);
    const passphrase = credential.passphraseSecretId
      ? this.store.get<Secret>("secrets", credential.passphraseSecretId)
      : undefined;
    return {
      ...credential,
      secretMasked: secret?.masked,
      passphraseMasked: passphrase?.masked,
    };
  }

  async create(input: NewSourceCredentialInput): Promise<SourceCredentialView> {
    const name = input.name?.trim();
    if (!name) throw new DomainError("source-credential-invalid", "A source credential needs a name");
    if (input.type !== "https-token" && input.type !== "ssh-key") {
      throw new DomainError("source-credential-invalid", `Unsupported credential type: ${String(input.type)}`);
    }
    let secretId = input.secretId;
    if (secretId) {
      if (!this.store.get<Secret>("secrets", secretId)) {
        throw new DomainError("source-credential-invalid", `Secret not found: ${secretId}`);
      }
    } else {
      if (!input.value) {
        throw new DomainError(
          "source-credential-invalid",
          input.type === "https-token" ? "An HTTPS credential needs a token value" : "An SSH credential needs a private key value"
        );
      }
      const secret = await this.store.insert<Secret>("secrets", {
        id: newId("sec"),
        name: `${name} ${input.type === "https-token" ? "token" : "private key"}`,
        value: input.value,
        masked: maskSecret(input.value),
        scope: "git",
        createdAt: now(),
        updatedAt: now(),
      });
      secretId = secret.id;
    }
    let passphraseSecretId: ID | undefined;
    if (input.passphrase) {
      const secret = await this.store.insert<Secret>("secrets", {
        id: newId("sec"),
        name: `${name} passphrase`,
        value: input.passphrase,
        masked: maskSecret(input.passphrase),
        scope: "git",
        createdAt: now(),
        updatedAt: now(),
      });
      passphraseSecretId = secret.id;
    }
    const credential: SourceCredential = {
      id: newId("cred"),
      name,
      type: input.type,
      host: input.host?.trim() || undefined,
      username: input.username?.trim() || undefined,
      secretId: secretId!,
      passphraseSecretId,
      knownHosts: input.knownHosts,
      createdAt: now(),
      updatedAt: now(),
    };
    const stored = await this.store.insert("sourceCredentials", credential);
    return this.toView(stored);
  }

  async update(id: ID, patch: Partial<NewSourceCredentialInput>): Promise<SourceCredentialView | undefined> {
    const credential = this.get(id);
    if (!credential) return undefined;
    const next: Partial<SourceCredential> = { updatedAt: now() };
    if (patch.name !== undefined) next.name = patch.name.trim() || credential.name;
    if (patch.host !== undefined) next.host = patch.host.trim() || undefined;
    if (patch.username !== undefined) next.username = patch.username.trim() || undefined;
    if (patch.knownHosts !== undefined) next.knownHosts = patch.knownHosts;
    if (patch.value) {
      const secret = this.store.get<Secret>("secrets", credential.secretId);
      await this.store.update<Secret>("secrets", credential.secretId, {
        value: patch.value,
        masked: maskSecret(patch.value),
        updatedAt: now(),
        ...(secret ? {} : { id: credential.secretId, name: `${credential.name} secret`, scope: "git", createdAt: now() }),
      });
    }
    if (patch.passphrase) {
      const existing = credential.passphraseSecretId
        ? this.store.get<Secret>("secrets", credential.passphraseSecretId)
        : undefined;
      if (existing) {
        await this.store.update<Secret>("secrets", existing.id, { value: patch.passphrase, masked: maskSecret(patch.passphrase), updatedAt: now() });
      } else {
        const secret = await this.store.insert<Secret>("secrets", {
          id: newId("sec"),
          name: `${credential.name} passphrase`,
          value: patch.passphrase,
          masked: maskSecret(patch.passphrase),
          scope: "git",
          createdAt: now(),
          updatedAt: now(),
        });
        next.passphraseSecretId = secret.id;
      }
    }
    const updated = await this.store.update<SourceCredential>("sourceCredentials", id, next);
    return updated ? this.toView(updated) : undefined;
  }

  async remove(id: ID): Promise<boolean> {
    const credential = this.get(id);
    if (!credential) return false;
    await this.store.remove("secrets", credential.secretId);
    if (credential.passphraseSecretId) await this.store.remove("secrets", credential.passphraseSecretId);
    return this.store.remove("sourceCredentials", id);
  }

  /**
   * Resolves the credential's plaintext material for one Git operation
   * (v11 §12.1). The result is handed straight to the credential
   * materializer and never stored, logged or returned by an API.
   *
   * This is the **credential broker** boundary (v11 hardening §8): it is the
   * only caller allowed to read a `git`-scoped secret, and it refuses to hand
   * that secret to any other purpose.
   */
  resolve(id: ID | undefined): GitCredentialInput | undefined {
    if (!id) return undefined;
    const credential = this.get(id);
    if (!credential) throw new DomainError("credential-not-found", `Source credential not found: ${id}`);
    const secret = this.store.get<Secret>("secrets", credential.secretId);
    if (!secret?.value) {
      throw new DomainError(
        "source-credential-invalid",
        `Source credential "${credential.name}" has no stored value — re-save it`
      );
    }
    // A credential's secret is git material by definition: assert the scope
    // rather than assume it, so a mis-scoped secret fails here and not at the
    // remote.
    assertSecretAllowed(secret, "git");
    const passphrase = credential.passphraseSecretId
      ? this.store.get<Secret>("secrets", credential.passphraseSecretId)?.value
      : undefined;
    if (credential.type === "https-token") {
      return { type: "https-token", username: credential.username, token: secret.value };
    }
    return {
      type: "ssh-key",
      username: credential.username,
      privateKey: secret.value,
      passphrase,
      knownHosts: credential.knownHosts,
    };
  }

  /**
   * Credential binding check (v11 hardening §9/§10): the credential may only
   * be sent to the host it is scoped to, over a transport its type supports.
   *
   * Called before the credential is materialized, and again at project
   * create/update so an incompatible configuration fails at configuration
   * time rather than after a clone was attempted.
   */
  assertBoundTo(credential: SourceCredential, remoteUrl: string): void {
    const binding = checkCredentialBinding(credential, remoteUrl);
    if (binding.ok) return;
    throw new DomainError(binding.code, binding.message, binding.detail);
  }

  /** The same check without throwing, for preflight callers. */
  checkBinding(credential: SourceCredential, remoteUrl: string): CredentialBindingCheck {
    return checkCredentialBinding(credential, remoteUrl);
  }
}

/* ------------------------------------------------------------------ */
/* Workspace locks (v11 §36)                                          */
/* ------------------------------------------------------------------ */

/**
 * One writer per managed workspace (v11 §36). A lock is held for the whole
 * lifecycle of the Run that owns the working tree and released at cleanup;
 * a lock whose run is no longer active is stale and may be reclaimed, which
 * is what makes crash recovery possible without a separate reconciliation.
 */
export class WorkspaceLockService {
  constructor(private store: Store) {}

  get(workspaceId: ID): WorkspaceLock | undefined {
    return this.store.list<WorkspaceLock>("workspaceLocks").find((l) => l.workspaceId === workspaceId);
  }

  list(): WorkspaceLock[] {
    return this.store.list<WorkspaceLock>("workspaceLocks");
  }

  /**
   * Acquires the workspace for one run. `isRunActive` decides whether an
   * existing lock is live: an active holder blocks the acquisition
   * (`workspace-locked`), a stale one is reclaimed.
   */
  async acquire(
    workspaceId: ID,
    holder: { taskId: ID; runId: ID },
    isRunActive: (runId: ID) => boolean
  ): Promise<WorkspaceLock> {
    const existing = this.get(workspaceId);
    if (existing && existing.runId !== holder.runId && isRunActive(existing.runId)) {
      throw new DomainError(
        "workspace-locked",
        `Workspace ${workspaceId} is already being written by run ${existing.runId}`,
        `held by task ${existing.taskId} since ${existing.acquiredAt}`
      );
    }
    if (existing) await this.store.remove("workspaceLocks", existing.id);
    return this.store.insert<WorkspaceLock>("workspaceLocks", {
      id: newId("wslock"),
      workspaceId,
      taskId: holder.taskId,
      runId: holder.runId,
      acquiredAt: now(),
    });
  }

  /** Releases the lock when it is held by `runId` (idempotent). */
  async release(workspaceId: ID, runId?: ID): Promise<boolean> {
    const existing = this.get(workspaceId);
    if (!existing) return false;
    if (runId && existing.runId !== runId) return false;
    return this.store.remove("workspaceLocks", existing.id);
  }

  /** Drops locks whose run is no longer active (boot-time recovery). */
  async releaseStale(isRunActive: (runId: ID) => boolean): Promise<ID[]> {
    const released: ID[] = [];
    for (const lock of this.list()) {
      if (!isRunActive(lock.runId)) {
        await this.store.remove("workspaceLocks", lock.id);
        released.push(lock.workspaceId);
      }
    }
    return released;
  }
}

/* ------------------------------------------------------------------ */
/* Seed data                                                          */
/* ------------------------------------------------------------------ */

export async function seedDefaults(store: Store): Promise<void> {
  // Existing installs (pre-v6/v7) get the harness-native local runtimes
  // seeded too — idempotent, keyed by kind.
  const existing = store.list<Runtime>("runtimes");
  const runtimeService = new RuntimeService(store);
  if (existing.length > 0) {
    if (!existing.some((r) => r.kind === "codex")) {
      await runtimeService.create({
        name: "Codex (ChatGPT)",
        kind: "codex",
        description: "Codex CLI on this machine — runs on its own ChatGPT login and subscription (no AgentFabric provider needed)",
        credentialSource: "harness-native",
        enabled: true,
        ephemeral: true,
        env: {},
      });
    }
    if (!existing.some((r) => r.kind === "claude-code")) {
      await runtimeService.create({
        name: "Claude Code (Claude.ai)",
        kind: "claude-code",
        description: "Claude Code CLI on this machine — runs on its own Claude.ai login and subscription (no AgentFabric provider needed)",
        credentialSource: "harness-native",
        enabled: true,
        ephemeral: true,
        env: {},
      });
    }
    if (!existing.some((r) => r.kind === "zcode")) {
      await runtimeService.create({
        name: "ZCode",
        kind: "zcode",
        description: "ZCode sessions on this machine — discovery and adoption only; continue an adopted session through a handoff to another harness (no ZCode runner adapter yet)",
        credentialSource: "harness-native",
        enabled: true,
        ephemeral: true,
        env: {},
      });
    }
    if (!existing.some((r) => r.kind === "dsh")) {
      await runtimeService.create({
        name: "DSH (DeepSeek)",
        kind: "dsh",
        description: "DSH (DeepSeek Harness) headless CLI on this machine — runs one task per invocation on its own DeepSeek account and subscription (no AgentFabric provider needed)",
        credentialSource: "harness-native",
        enabled: true,
        ephemeral: true,
        env: {},
      });
    }
    // `usableInTask` postdates the seeded runtimes: write the kind default
    // once, at boot, so every record carries a definite value. This is a
    // write-time seeding step — reads never derive or repair the field.
    for (const r of existing) {
      if (r.usableInTask === undefined) {
        await runtimeService.update(r.id, { usableInTask: defaultUsableInTask(r.kind) });
      }
    }
    return;
  }

  const providerService = new ProviderService(store);
  const modelService = new ModelService(store);

  // A generic OpenAI-compatible provider with no key; users fill in their own.
  const provider = await providerService.create({
    name: "OpenAI",
    type: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  });
  await modelService.create({ providerId: provider.id, name: "gpt-4o", alias: "gpt-4o", capabilities: ["chat", "vision"] });
  await modelService.create({ providerId: provider.id, name: "gpt-4o-mini", alias: "gpt-4o-mini", capabilities: ["chat", "vision"] });

  await runtimeService.create({
    name: "Mock Agent",
    kind: "mock",
    description: "Simulated agent runtime for demos and tests",
    enabled: true,
    ephemeral: true,
  });
  await runtimeService.create({
    name: "OpenCode",
    kind: "opencode",
    description: "OpenCode CLI agent (local)",
    enabled: true,
    ephemeral: true,
    env: {},
  });
  await runtimeService.create({
    name: "Pi Agent",
    kind: "pi",
    description: "Pi coding agent (local)",
    enabled: true,
    ephemeral: true,
    env: {},
  });
  // Codex Local (v6 §1): the user's own codex CLI + ChatGPT login. No
  // Provider/API key is configured or expected (v6 §2/§3).
  await runtimeService.create({
    name: "Codex (ChatGPT)",
    kind: "codex",
    description: "Codex CLI on this machine — runs on its own ChatGPT login and subscription (no AgentFabric provider needed)",
    credentialSource: "harness-native",
    enabled: true,
    ephemeral: true,
    env: {},
  });
  // Claude Code Local (v7 §1): the user's own claude CLI + Claude.ai
  // login. Same harness-native rules as Codex (v7 §2/§3).
  await runtimeService.create({
    name: "Claude Code (Claude.ai)",
    kind: "claude-code",
    description: "Claude Code CLI on this machine — runs on its own Claude.ai login and subscription (no AgentFabric provider needed)",
    credentialSource: "harness-native",
    enabled: true,
    ephemeral: true,
    env: {},
  });
  await runtimeService.create({
    name: "ZCode",
    kind: "zcode",
    description: "ZCode sessions on this machine — discovery and adoption only; continue an adopted session through a handoff to another harness (no ZCode runner adapter yet)",
    credentialSource: "harness-native",
    enabled: true,
    ephemeral: true,
    env: {},
  });
  await runtimeService.create({
    name: "DSH (DeepSeek)",
    kind: "dsh",
    description: "DSH (DeepSeek Harness) headless CLI on this machine — runs one task per invocation on its own DeepSeek account and subscription (no AgentFabric provider needed)",
    credentialSource: "harness-native",
    enabled: true,
    ephemeral: true,
    env: {},
  });
  // The generic Docker runtime is the seeded *isolated* runtime: it declares
  // container-backed execution and names an image, which is what the Project
  // Coding Task isolation gate reads (v11 hardening §4). `usableInTask` stays
  // false until the operator opts in — the Runtimes page toggles it.
  await runtimeService.create({
    name: "Docker (generic)",
    kind: "docker",
    description: "Generic Docker container runtime — isolated execution, the runtime kind Project Coding Tasks require",
    image: "node:22-alpine",
    command: ["sh", "-c", "echo hello from agent-fabric container"],
    containerized: true,
    executionBackend: "isolated",
    enabled: true,
    ephemeral: true,
    networkPolicy: { enabled: true },
  });
}

/* ------------------------------------------------------------------ */
/* Config helper                                                      */
/* ------------------------------------------------------------------ */

export async function dataDirFromEnv(): Promise<string> {
  return process.env.AGENTFABRIC_DATA_DIR ?? join(homedir(), ".fabric");
}
