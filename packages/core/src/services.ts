import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Store, newId } from "./store.js";
import { EventBus } from "./eventbus.js";
import { emptyUsage, addUsage, estimateCost } from "./cost.js";
import type {
  ID,
  Provider,
  Model,
  Runtime,
  Workspace,
  Task,
  Run,
  Session,
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
} from "./types.js";

export function now(): string {
  return new Date().toISOString();
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
  defaultModelId?: ID;
  enabled?: boolean;
  ephemeral?: boolean;
  resourceLimits?: ResourceLimits;
  env?: Record<string, string>;
  secretIds?: ID[];
  networkPolicy?: Runtime["networkPolicy"];
  filesystemPolicy?: Runtime["filesystemPolicy"];
  config?: Record<string, unknown>;
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
      defaultModelId: input.defaultModelId,
      enabled: input.enabled ?? true,
      ephemeral: input.ephemeral ?? true,
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
      createdAt: now(),
    };
    return this.store.insert("workspaces", workspace);
  }

  async update(id: ID, patch: Partial<NewWorkspaceInput>): Promise<Workspace | undefined> {
    return this.store.update<Workspace>("workspaces", id, patch);
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("workspaces", id);
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

  resolve(ids: ID[] | undefined): Secret[] {
    if (!ids) return [];
    return ids
      .map((id) => this.getWithValue(id))
      .filter((s): s is Secret => Boolean(s));
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
  title?: string;
  prompt: string;
  runtimeId?: ID;
  modelId?: ID;
  workspaceId?: ID;
  sessionId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: ID[];
  tools?: string[];
  resourceLimits?: ResourceLimits;
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  metadata?: Record<string, unknown>;
}

export class TaskService {
  constructor(private store: Store) {}

  list(): Task[] {
    return this.store.list<Task>("tasks");
  }

  get(id: ID): Task | undefined {
    return this.store.get<Task>("tasks", id);
  }

  async create(input: NewTaskInput): Promise<Task> {
    const task: Task = {
      id: newId("task"),
      title: input.title ?? input.prompt.slice(0, 80),
      prompt: input.prompt,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      profileId: input.profileId,
      env: input.env,
      secretIds: input.secretIds,
      tools: input.tools,
      resourceLimits: input.resourceLimits,
      timeoutMs: input.timeoutMs,
      policy: input.policy,
      metadata: input.metadata,
      createdAt: now(),
    };
    return this.store.insert("tasks", task);
  }
}

/* ------------------------------------------------------------------ */
/* Session                                                            */
/* ------------------------------------------------------------------ */

export interface NewSessionInput {
  name?: string;
  runtimeId?: ID;
  workspaceId?: ID;
  modelId?: ID;
}

export class SessionService {
  constructor(private store: Store) {}

  list(): Session[] {
    return this.store.list<Session>("sessions");
  }

  get(id: ID): Session | undefined {
    return this.store.get<Session>("sessions", id);
  }

  async create(input: NewSessionInput): Promise<Session> {
    const session: Session = {
      id: newId("ses"),
      name: input.name,
      runtimeId: input.runtimeId,
      workspaceId: input.workspaceId,
      modelId: input.modelId,
      status: "active",
      runIds: [],
      usage: emptyUsage(),
      cost: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("sessions", session);
  }

  async close(id: ID): Promise<Session | undefined> {
    return this.store.update<Session>("sessions", id, { status: "closed", updatedAt: now() });
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("sessions", id);
  }

  async attachRun(id: ID, runId: ID): Promise<void> {
    const session = this.get(id);
    if (!session) return;
    if (!session.runIds.includes(runId)) {
      session.runIds = [...session.runIds, runId];
      session.updatedAt = now();
      await this.store.commit();
    }
  }

  async recordUsage(id: ID, usage: Usage | undefined, cost?: number): Promise<void> {
    const session = this.get(id);
    if (!session) return;
    session.usage = addUsage(session.usage, usage);
    session.cost = (session.cost ?? 0) + (cost ?? usage?.estimatedCost ?? 0);
    session.updatedAt = now();
    session.status = "idle";
    await this.store.commit();
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

      const day = (run.endTime ?? run.updatedAt).slice(0, 10);
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
/* Seed data                                                          */
/* ------------------------------------------------------------------ */

export async function seedDefaults(store: Store): Promise<void> {
  if (store.list<Runtime>("runtimes").length > 0) return;

  const providerService = new ProviderService(store);
  const modelService = new ModelService(store);
  const runtimeService = new RuntimeService(store);

  // A generic OpenAI-compatible provider with no key; users fill in their own.
  const provider = await providerService.create({
    name: "OpenAI",
    type: "openai",
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
  await runtimeService.create({
    name: "Docker (generic)",
    kind: "docker",
    description: "Generic Docker container runtime",
    image: "node:22-alpine",
    command: ["sh", "-c", "echo hello from agent-fabric container"],
    containerized: true,
    enabled: true,
    ephemeral: true,
    networkPolicy: { enabled: true },
  });
}

/* ------------------------------------------------------------------ */
/* Config helper                                                      */
/* ------------------------------------------------------------------ */

export async function dataDirFromEnv(): Promise<string> {
  return process.env.AGENTFABRIC_DATA_DIR ?? resolve(process.cwd(), "data");
}
