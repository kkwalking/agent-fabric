import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Store, newId } from "./store.js";
import { EventBus } from "./eventbus.js";
import { emptyUsage, addUsage, estimateCost } from "./cost.js";
import { DomainError, isDomainError } from "./errors.js";
import { decryptSecretValue, encryptSecretValue, isEncryptedSecretValue } from "./secretCrypto.js";
import { resolveSecretsForPurpose, type SecretPurpose } from "./secrets.js";
import { taskLifecycle } from "./lifecycle.js";
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
  WorkspaceLock,
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
        value: SecretService.encryptPlaintext(this.store, input.apiKey),
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
        value: SecretService.encryptPlaintext(this.store, patch.apiKey),
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
   * Declared execution backend (v11 hardening §4): `isolated` runs inside a
   * container/VM boundary, `host` runs as a local process. Absent derives
   * from `containerized`.
   */
  executionBackend?: Runtime["executionBackend"];
}

/**
 * A Task is the unit of work and a runtime is how it runs, so every runtime a
 * user is meant to own is usable in a task. The exceptions are wiring, not
 * configuration: `mock` is the test double, and `zcode` is discovery-only (its
 * sessions are found and adopted, but no runner adapter exists yet).
 *
 * This used to be a per-kind table the Runtimes page let a user override per
 * record — a switch that could only ever break things, since turning it off
 * removed the runtime from every composer.
 */
const USABLE_IN_TASK_BY_KIND: Record<Runtime["kind"], boolean> = {
  opencode: true,
  pi: true,
  codex: true,
  "claude-code": true,
  zcode: false,
  dsh: true,
  docker: true,
  mock: false,
  custom: true,
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

/**
 * A user-owned working directory. A repository is simply a directory that
 * happens to hold one — there is no separate source entity.
 */
export interface NewWorkspaceInput {
  name: string;
  type: Workspace["type"];
  path?: string;
  mountPath?: string;
  persistent?: boolean;
  /** Default runtime/model for tasks started here (see `Workspace`). */
  runtimeId?: ID;
  modelId?: ID;
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

  /**
   * The workspace already registered at this directory, if any.
   *
   * A workspace *is* a directory on this machine, so a second record for one
   * directory is the same workspace twice: the sidebar splits one history
   * across two groups and nothing can say which record owns the folder. The
   * board already states the rule for its own list ("one board per folder");
   * this is the same rule at the level where every record is created.
   */
  private workspaceAt(path: string, exceptId?: ID): Workspace | undefined {
    return this.store
      .list<Workspace>("workspaces")
      .find((w) => w.id !== exceptId && w.path !== undefined && resolve(w.path) === path);
  }

  /** Refuses a second record for a directory that already has one. */
  private assertDirectoryFree(path: string, exceptId?: ID): void {
    const existing = this.workspaceAt(path, exceptId);
    if (!existing) return;
    throw new DomainError(
      "workspace-duplicate",
      `This directory is already a workspace: ${existing.name} (${existing.id}) — ${path}`,
      existing.id
    );
  }

  /**
   * Creates an external (user-owned) working directory.
   */
  async create(input: NewWorkspaceInput): Promise<Workspace> {
    // A wire request has no type: a client built against the old shape can
    // still send `type: "git"`. A workspace is a directory, never a type.
    if ((input as { type: string }).type === "git") {
      throw new DomainError(
        "config-invalid",
        "A git repository is just a directory on this machine — add it as a workspace instead"
      );
    }
    const id = newId("ws");
    let path = input.path;
    if (path) this.assertDirectoryFree(resolve(path));
    if (input.type === "local" && path) {
      const abs = resolve(path);
      await mkdir(abs, { recursive: true });
      path = abs;
    }
    const workspace: Workspace = {
      id,
      name: input.name,
      type: input.type,
      path,
      mountPath: input.mountPath ?? "/workspace",
      persistent: input.persistent ?? true,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      source: "create",
      status: "ready",
      ownership: "external",
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
    const rawPath = input.path;
    if (!rawPath) throw new Error("workspace import requires `path` (a local directory)");
    const abs = resolve(rawPath);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new Error(`Cannot import workspace: path does not exist: ${abs}`);
    }
    if (!st.isDirectory()) throw new Error(`Cannot import workspace: not a directory: ${abs}`);
    this.assertDirectoryFree(abs);
    const id = newId("ws");
    const workspace: Workspace = {
      id,
      name: input.name,
      type: "local",
      path: abs,
      mountPath: input.mountPath ?? "/workspace",
      persistent: input.persistent ?? true,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
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
    if (patch.path) this.assertDirectoryFree(resolve(patch.path), id);
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
    const existing = this.list().find((w) => w.type === input.type && w.path === input.path);
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

/**
 * Stores whose legacy-plaintext Secret scan already ran. The scan is a
 * startup concern; several services construct their own `SecretService` over
 * the same store (the credential broker does so per Git operation), and the
 * warning must not repeat for each of them.
 */
const legacySecretScanDone = new WeakSet<Store>();

export class SecretService {
  constructor(private store: Store) {
    if (!legacySecretScanDone.has(store)) {
      legacySecretScanDone.add(store);
      this.warnAboutLegacyPlaintextSecrets();
    }
  }

  list(): Secret[] {
    return this.store.list<Secret>("secrets").map(({ value: _v, ...rest }) => rest);
  }

  get(id: ID): Secret | undefined {
    const s = this.store.get<Secret>("secrets", id);
    if (!s) return undefined;
    const { value: _v, ...rest } = s;
    return rest;
  }

  /**
   * The one read path that materializes a Secret's value. Stored values are
   * ciphertext; a record written before encryption existed fails loudly here
   * rather than being read as-is (the read path never rescues dirty data).
   * `list()` / `get()` / `remove()` never decrypt, so such a record stays
   * listable and deletable — which is exactly how a user repairs it.
   */
  getWithValue(id: ID): Secret | undefined {
    const secret = this.store.get<Secret>("secrets", id);
    if (!secret) return undefined;
    return { ...secret, value: this.decryptStoredValue(secret) };
  }

  async create(input: NewSecretInput): Promise<Secret> {
    const stored: Secret = {
      id: newId("sec"),
      name: input.name,
      value: this.encryptPlaintextValue(input.value),
      masked: maskSecret(input.value),
      scope: input.scope ?? "env",
      createdAt: now(),
      updatedAt: now(),
    };
    await this.store.insert("secrets", stored);
    // The plaintext is echoed back exactly once, to the caller that just
    // supplied it. db.json — and every later read — carries the ciphertext.
    return { ...stored, value: input.value };
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("secrets", id);
  }

  /**
   * Turns a plaintext value into its stored form. Shared by every writer of
   * the `secrets` collection (provider API keys, source credentials), so no
   * service can store a plaintext value of its own. A key problem surfaces as
   * `secret-key-invalid`; a write failure surfaces as its own fs error.
   */
  static encryptPlaintext(store: Store, plaintext: string): string {
    return encryptSecretValue(store.dataDir, plaintext);
  }

  /** Instance form of `SecretService.encryptPlaintext` for this service's store. */
  encryptPlaintextValue(plaintext: string): string {
    return SecretService.encryptPlaintext(this.store, plaintext);
  }

  /** Decrypts a stored record's value, failing loudly on a legacy plaintext one. */
  private decryptStoredValue(secret: Secret): string | undefined {
    const stored = secret.value;
    if (stored === undefined) return undefined;
    if (!isEncryptedSecretValue(stored)) {
      throw new DomainError(
        "secret-legacy-format",
        `Secret "${secret.name}" (${secret.id}) was stored before Secret values were encrypted and cannot be read — remove it and create it again with the same value`
      );
    }
    try {
      return decryptSecretValue(this.store.dataDir, stored);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The code says which failure it was; the message never carries the
      // ciphertext or the key, only which record failed.
      throw new DomainError(
        isDomainError(err) ? err.code : "secret-decrypt-failed",
        `Secret "${secret.name}" (${secret.id}) could not be read: ${message}`
      );
    }
  }

  /**
   * One scan at construction: a plaintext record is called out loudly with
   * its id and name so the user can find and re-create it, and the server
   * still starts (otherwise there would be no UI to repair it from). Never
   * an O(n) scan on a read path.
   */
  private warnAboutLegacyPlaintextSecrets(): void {
    const legacy = this.store.list<Secret>("secrets").filter((s) => s.value !== undefined && !isEncryptedSecretValue(s.value));
    if (legacy.length === 0) return;
    console.error(
      `[agent-fabric] ${legacy.length} Secret(s) are stored in the pre-encryption plaintext format and can no longer be read:`
    );
    for (const s of legacy) {
      console.error(`[agent-fabric]   - ${s.id} "${s.name}"`);
    }
    console.error(
      "[agent-fabric] Remove each one (its value is not recoverable here) and create it again with the same value; providers and source credentials referencing them will need re-saving."
    );
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
   * Resolves `git`-scoped secret material. This is the only path allowed to
   * read one, so an `agent-runtime` resolution can never obtain it.
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
  /** Explicit task id (used by callers that need to know it up front). */
  id?: ID;
  title?: string;
  prompt: string;
  runtimeId?: ID;
  modelId?: ID;
  workspaceId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: ID[];
  tools?: string[];
  resourceLimits?: ResourceLimits;
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  /**
   * Container lifecycle declared for the Task (spec v1 §1). Optional at the
   * call site; `create` materializes it once (default `ephemeral`) and the
   * stored Task always carries the result. Immutable afterwards: every Run
   * of this Task copies it verbatim.
   */
  lifecycle?: Task["lifecycle"];
  metadata?: Record<string, unknown>;
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
      tools: input.tools,
      resourceLimits: input.resourceLimits,
      timeoutMs: input.timeoutMs,
      policy: input.policy,
      // Materialized once, here: the stored Task always carries the decision.
      lifecycle: taskLifecycle(input.lifecycle),
      metadata: input.metadata,
      execution: input.execution,
      createdAt: now(),
    };
    return this.store.insert("tasks", task);
  }

  /**
   * Mutable Task fields. `lifecycle` is deliberately excluded: the container
   * policy is decided once at creation and immutable for the Task's whole
   * life, so no update path can change what a later turn runs under. The
   * exclusion is enforced by the type, not by convention.
   */
  async update(id: ID, patch: Partial<Omit<NewTaskInput, "id" | "lifecycle">>): Promise<Task | undefined> {
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
        env: {},
      });
    }
    // `usableInTask` is a property of the *kind* now, not of the record: a
    // Task is the unit of work and a runtime is how it runs, so the answer for
    // `codex` cannot differ between two codex records. The value is still
    // written into the record (reads never derive it), but it is seeded on
    // every boot rather than only when absent — otherwise a record written
    // under the old per-record toggle would keep answering "no" forever with
    // nothing in the UI left to change it.
    for (const r of existing) {
      const usable = defaultUsableInTask(r.kind);
      if (r.usableInTask !== usable) {
        await runtimeService.update(r.id, { usableInTask: usable });
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
  });
  await runtimeService.create({
    name: "OpenCode",
    kind: "opencode",
    description: "OpenCode CLI agent (local)",
    enabled: true,
    env: {},
  });
  await runtimeService.create({
    name: "Pi Agent",
    kind: "pi",
    description: "Pi coding agent (local)",
    enabled: true,
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
    env: {},
  });
  await runtimeService.create({
    name: "ZCode",
    kind: "zcode",
    description: "ZCode sessions on this machine — discovery and adoption only; continue an adopted session through a handoff to another harness (no ZCode runner adapter yet)",
    credentialSource: "harness-native",
    enabled: true,
    env: {},
  });
  await runtimeService.create({
    name: "DSH (DeepSeek)",
    kind: "dsh",
    description: "DSH (DeepSeek Harness) headless CLI on this machine — runs one task per invocation on its own DeepSeek account and subscription (no AgentFabric provider needed)",
    credentialSource: "harness-native",
    enabled: true,
    env: {},
  });
  // The generic Docker runtime is the seeded *isolated* runtime: it declares
  // container-backed execution and names an image. `usableInTask` stays false
  // until the operator opts in — the Runtimes page toggles it.
  await runtimeService.create({
    name: "Docker (generic)",
    kind: "docker",
    description: "Generic Docker container runtime — isolated execution in a container",
    image: "node:22-alpine",
    command: ["sh", "-c", "echo hello from agent-fabric container"],
    containerized: true,
    executionBackend: "isolated",
    enabled: true,
    networkPolicy: { enabled: true },
  });
}

/* ------------------------------------------------------------------ */
/* Config helper                                                      */
/* ------------------------------------------------------------------ */

export async function dataDirFromEnv(): Promise<string> {
  return process.env.AGENTFABRIC_DATA_DIR ?? join(homedir(), ".fabric");
}

/* ------------------------------------------------------------------ */
/* Providers & models declared in the configuration file              */
/* ------------------------------------------------------------------ */

/**
 * Projects the configuration file's `providers` section into the flat
 * `Provider` / `Model` records the rest of the system works with.
 *
 * The config file is the source of record; these records are the in-memory
 * projection every existing consumer reads (creation of a run, model lookup by
 * alias, the runtime's model choice). Ids are derived from names rather than
 * random so that re-running the projection — which `apply` does — reproduces
 * the same ids, and so a task or runtime that references `mod_<name>` keeps
 * pointing at the same model after an edit. Deterministic ids also make a
 * hand-written file and a UI-saved file indistinguishable.
 */
export function projectConfigProviders(config: ProviderConfigSection): {
  providers: Provider[];
  models: Model[];
} {
  const providers: Provider[] = [];
  const models: Model[] = [];
  const at = now();
  for (const entry of config ?? []) {
    const id = entry.id.trim();
    if (!id) continue;
    providers.push({
      id,
      name: entry.name || id,
      type: entry.type,
      remark: entry.remark,
      website: entry.website,
      baseUrl: entry.baseUrl,
      apiKeySecretId: entry.apiKeySecretId,
      // The mask is a read-side projection (see `Provider.apiKeyMasked`): an
      // inlined key is masked here, and a Secret-store key is masked by the
      // API response from the Secret it points at.
      ...(entry.apiKey && !entry.apiKeySecretId ? { apiKeyMasked: maskSecret(entry.apiKey) } : {}),
      headers: entry.headers,
      enabled: entry.enabled ?? true,
      createdAt: at,
      updatedAt: at,
    });
    for (const model of entry.models ?? []) {
      const name = model.name.trim();
      if (!name) continue;
      models.push({
        id: `mod_${name}`,
        providerId: id,
        name,
        alias: model.alias && model.alias !== name ? model.alias : undefined,
        parameters: model.parameters,
        capabilities: model.capabilities,
        enabled: model.enabled ?? true,
        createdAt: at,
        updatedAt: at,
      });
    }
  }
  return { providers, models };
}

/** The `providers` section of a config document, if any. */
export type ProviderConfigSection = AppConfig["providers"];

/**
 * Writes the file's provider section back from the live records. The API keys
 * of Secret-store providers are never inlined here: the section records the
 * Secret reference, so the file never grows a copy of a key the UI chose to
 * keep encrypted.
 */
export function providersToConfigSection(
  providers: Provider[],
  models: Model[]
): NonNullable<AppConfig["providers"]> {
  return providers.map((provider) => {
    const own = models.filter((m) => m.providerId === provider.id);
    return {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      ...(provider.remark ? { remark: provider.remark } : {}),
      ...(provider.website ? { website: provider.website } : {}),
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.apiKeySecretId ? { apiKeySecretId: provider.apiKeySecretId } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
      enabled: provider.enabled,
      models: own.map((m) => ({
        name: m.name,
        ...(m.alias ? { alias: m.alias } : {}),
        ...(m.parameters ? { parameters: m.parameters } : {}),
        ...(m.capabilities ? { capabilities: m.capabilities } : {}),
        enabled: m.enabled,
      })),
    };
  });
}
