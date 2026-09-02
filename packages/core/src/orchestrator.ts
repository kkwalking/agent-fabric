import { Store, newId } from "./store.js";
import { EventBus } from "./eventbus.js";
import {
  ArtifactService,
  ModelService,
  ProfileService,
  ProviderService,
  RuntimeService,
  SecretService,
  SessionService,
  TaskService,
  WorkspaceService,
  now,
  type NewTaskInput,
} from "./services.js";
import { addUsage, emptyUsage, estimateCost } from "./cost.js";
import type {
  ArtifactDraft,
  AgentRuntimeAdapter,
  RuntimeContext,
  RuntimeRegistry,
  RuntimeResult,
} from "./runtime.js";
import type {
  Artifact,
  EventType,
  ExecutionPolicy,
  LogLevel,
  Model,
  Provider,
  Run,
  RunEvent,
  Runtime,
  Secret,
  Session,
  Task,
  Usage,
  Workspace,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min safety net

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

export class RunService {
  private controllers = new Map<string, { controller: AbortController; reason: "cancel" | "timeout" | "policy" }>();
  private active = new Map<string, Promise<void>>();

  constructor(
    private store: Store,
    private bus: EventBus,
    private registry: RuntimeRegistry
  ) {}

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

  async submit(input: NewTaskInput): Promise<SubmitResult> {
    const resolved = await this.resolveTask(input);
    const task = await this.taskService().create(resolved);
    const run = await this.createRun(task);
    void this.execute(run.id);
    return { task, run };
  }

  /** Continue an existing session with a new prompt. */
  async resume(sessionId: string, input: Omit<NewTaskInput, "sessionId">): Promise<SubmitResult> {
    const session = this.sessionService().get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const merged: NewTaskInput = {
      ...input,
      sessionId,
      runtimeId: input.runtimeId ?? session.runtimeId,
      modelId: input.modelId ?? session.modelId,
      workspaceId: input.workspaceId ?? session.workspaceId,
    };
    return this.submit(merged);
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
      sessionId: task.sessionId,
      profileId: task.profileId,
      env: task.env,
      secretIds: task.secretIds,
      tools: task.tools,
      resourceLimits: task.resourceLimits,
      timeoutMs: task.timeoutMs,
      policy: task.policy,
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
  private sessionService() {
    return new SessionService(this.store);
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

  private async createRun(task: Task): Promise<Run> {
    const runtime = task.runtimeId ? this.runtimeService().get(task.runtimeId) : undefined;
    const model = task.modelId ? this.modelService().get(task.modelId) : undefined;
    const provider = model ? this.providerService().get(model.providerId) : undefined;
    const run: Run = {
      id: newId("run"),
      taskId: task.id,
      taskTitle: task.title,
      status: "pending",
      runtimeId: task.runtimeId,
      runtimeName: runtime?.name,
      modelId: task.modelId,
      modelName: model?.alias ?? model?.name,
      providerId: provider?.id,
      workspaceId: task.workspaceId,
      sessionId: task.sessionId,
      artifactIds: [],
      eventCount: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.store.insert("runs", run);
    if (task.sessionId) {
      await this.sessionService().attachRun(task.sessionId, run.id);
    }
    return run;
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

    const runtime = task.runtimeId ? this.runtimeService().get(task.runtimeId) : undefined;
    if (!runtime || !runtime.enabled) {
      await this.finish(runId, "failed", `Runtime not found or disabled: ${task.runtimeId ?? "(none)"}`, emptyUsage());
      return;
    }

    const adapter = this.registry.get(runtime.kind);
    if (!adapter) {
      await this.finish(runId, "failed", `No adapter registered for runtime kind "${runtime.kind}"`, emptyUsage());
      return;
    }

    const model = task.modelId ? this.modelService().get(task.modelId) : undefined;
    const provider = model ? this.providerService().get(model.providerId) : undefined;
    const workspace = task.workspaceId ? this.workspaceService().get(task.workspaceId) : undefined;
    const session = task.sessionId ? this.sessionService().get(task.sessionId) : undefined;
    const secrets = this.secretService().resolve(task.secretIds);

    // Abort controller for cancel/timeout.
    const controller = new AbortController();
    const abortState: { reason: "cancel" | "timeout" | "policy"; policyMessage?: string } = { reason: "cancel" };
    const timeoutMs = task.timeoutMs ?? task.policy?.maxDurationMs ?? DEFAULT_TIMEOUT_MS;
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

    // Start.
    run = (await this.store.update<Run>("runs", runId, {
      status: "starting",
      startTime: now(),
      updatedAt: now(),
    }))!;

    const usageAcc = emptyUsage();
    const ctx: RuntimeContext = this.buildContext(run, task, runtime, model, provider, workspace, session, secrets, controller.signal, usageAcc, abortForPolicy);

    await ctx.emit("run.started", {
      runId,
      taskId: task.id,
      title: task.title,
      runtime: runtime.name,
      model: model?.alias ?? model?.name,
      provider: provider?.name,
      workspace: workspace?.name,
      timeoutMs,
    });

    run = (await this.store.update<Run>("runs", runId, { status: "running", updatedAt: now() }))!;

    let result: RuntimeResult;
    try {
      result = await adapter.run(ctx);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      try {
        await adapter.cleanup?.(ctx);
      } catch {
        /* best effort */
      }
      this.controllers.delete(runId);
    }

    if (result.containerId) {
      await this.store.update<Run>("runs", runId, { containerId: result.containerId, updatedAt: now() });
    }

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
  }

  private buildContext(
    run: Run,
    task: Task,
    runtime: Runtime,
    model: Model | undefined,
    provider: Provider | undefined,
    workspace: Workspace | undefined,
    session: Session | undefined,
    secrets: Secret[],
    signal: AbortSignal,
    usageAcc: Usage,
    abortForPolicy: (message: string) => void
  ): RuntimeContext {
    const store = this.store;
    const bus = this.bus;
    const artifactService = this.artifactService();

    const env: Record<string, string> = {
      ...(task.env ?? {}),
      ...(runtime.env ?? {}),
      ...Object.fromEntries(secrets.map((s) => [s.name, s.value ?? ""])),
      AGENTFABRIC_RUN_ID: run.id,
      AGENTFABRIC_TASK_ID: task.id,
      AGENTFABRIC_MODEL: model?.name ?? "",
      AGENTFABRIC_PROVIDER: provider?.name ?? "",
    };

    const emit = async (
      type: EventType,
      data: Record<string, unknown> = {},
      opts?: { level?: LogLevel; source?: string }
    ): Promise<void> => {
      const event: RunEvent = {
        id: newId("evt"),
        runId: run.id,
        sessionId: run.sessionId,
        seq: store.nextSeq(),
        type,
        timestamp: now(),
        data,
        level: opts?.level,
        source: opts?.source ?? "core",
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
      session,
      secrets,
      env,
      signal,
      workspacePath: workspace?.path,
      emit,
      log: async (line, level = "info") => {
        await emit("log", { line }, { level, source: runtime.kind });
      },
      recordUsage: (u) => {
        Object.assign(usageAcc, addUsage(usageAcc, u));
        if (model) {
          const cost = u.estimatedCost ?? estimateCost(model.name, u.inputTokens, u.outputTokens, u.cachedTokens ?? 0);
          usageAcc.estimatedCost = (usageAcc.estimatedCost ?? 0) + cost;
        }
        enforcePolicyLimits(task.policy, usageAcc, abortForPolicy);
      },
      addArtifact: async (draft: ArtifactDraft): Promise<Artifact> => {
        const artifact = await artifactService.create({ runId: run.id, ...draft });
        await emit("artifact.created", { artifactId: artifact.id, name: artifact.name, kind: artifact.kind });
        return artifact;
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
    if (run.sessionId) {
      await this.sessionService().recordUsage(run.sessionId, usage, cost);
    }
  }
}
