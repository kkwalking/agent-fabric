import { Store, newId } from "./store.js";
import { EventBus } from "./eventbus.js";
import { existsSync } from "node:fs";
import {
  ArtifactService,
  ModelService,
  NativeStateService,
  ProfileService,
  ProviderService,
  RuntimeService,
  RuntimeSessionService,
  SecretService,
  TaskService,
  WorkspaceService,
  now,
  sameResumeWorkspace,
  type NewTaskInput,
} from "./services.js";
import type {
  HarnessThreadDetail,
  HarnessThreadFilter,
  HarnessThreadItem,
  HarnessThreadSummary,
  ImportHarnessThreadInput,
  ImportHarnessThreadResult,
  LocalHarnessThreadSource,
  SyncHarnessThreadResult,
} from "./harnessThreads.js";
import {
  createHttpCompletionFn,
  generateHandoffSummary,
  HandoffBudgetExceededError,
  HANDOFF_GENERATION_BUDGET_MS,
  type CompletionFn,
} from "./handoffSummary.js";
import { HandoffService, buildAssistedHandoffContent, renderHandoffPrompt } from "./handoff.js";
import {
  ContainerLeaseManager,
  DEFAULT_KEEP_ALIVE_IDLE_MS,
  normalizeLifecycle,
  recoverKeepAliveContainers,
  resolveLifecycle,
  type ContainerOps,
} from "./lifecycle.js";
import { addUsage, emptyUsage, estimateCost } from "./cost.js";
import { buildProxyEnv } from "./proxy.js";
import { resolveRunConfig, type ResolvedRunConfig } from "./policy.js";
import {
  effectiveCapabilities,
  type ArtifactDraft,
  type AgentRuntimeAdapter,
  type HarnessAuthStatus,
  type ReusableContainer,
  type RuntimeContext,
  type RuntimeRegistry,
  type RuntimeResult,
} from "./runtime.js";
import type {
  Artifact,
  EventType,
  ExecutionPolicy,
  Handoff,
  HandoffContent,
  HandoffContextWindowSource,
  HandoffGeneration,
  HandoffModelSource,
  HandoffTrigger,
  ID,
  LogLevel,
  Model,
  Provider,
  Run,
  RunContinuity,
  RunEvent,
  Runtime,
  RuntimeCapability,
  RuntimeLifecycle,
  RuntimeNativeState,
  RuntimeSessionRef,
  Secret,
  Task,
  Usage,
  Workspace,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min safety net

/**
 * Turn grouping for a native thread (v6 §8): harness-provided boundaries
 * when available, else the flattened history split at each user message.
 */
function groupHarnessThreadTurns(detail: HarnessThreadDetail): Array<{ userText?: string; items: HarnessThreadItem[] }> {
  if (detail.turns && detail.turns.length > 0) return detail.turns;
  const turns: Array<{ userText?: string; items: HarnessThreadItem[] }> = [];
  for (const item of detail.items) {
    if (item.kind === "user-message") {
      turns.push({ userText: item.text, items: [] });
    } else {
      if (turns.length === 0) turns.push({ userText: undefined, items: [] });
      turns[turns.length - 1].items.push(item);
    }
  }
  if (turns.length === 0) turns.push({ userText: undefined, items: [] });
  return turns;
}

/* ------------------------------------------------------------------ */
/* Resume compatibility (v3 §13–§15)                                    */
/* ------------------------------------------------------------------ */

export interface ResumeCompatibility {
  compatible: boolean;
  /** Human-readable explanation, used verbatim in continuation results. */
  reason: string;
}

/**
 * Native resume requires *all* of (v3 §13):
 * 1. same harness,
 * 2. runtime capability supports native resume under the execution
 *    backend actually in use (v3 §16/§17),
 * 3. a valid, active RuntimeSessionRef,
 * 4. the corresponding Runtime Native State — for a containerized target
 *    the session's state record must exist and its directory must be on
 *    disk; a session created on the other backend cannot be attached
 *    (its state lives where the target run cannot read it),
 * 5. the same workspace (v3 §14: native sessions are bound to their
 *    working context).
 *
 * The checks are named and ordered so future dimensions (runtime
 * version, harness version, native-state version, model, runtime
 * configuration — v3 §15) slot in without changing the contract.
 */
function evaluateResumeCompatibility(
  ref: RuntimeSessionRef,
  target: Runtime,
  caps: RuntimeCapability,
  workspaceId: ID | undefined,
  nativeStates: NativeStateService
): ResumeCompatibility {
  // 1. Same harness.
  if (ref.runtimeKind !== target.kind) {
    return { compatible: false, reason: `different harness (${ref.runtimeKind} → ${target.kind})` };
  }
  // 2. Capability under the backend actually in use.
  if (!caps.supportsNativeResume) {
    return { compatible: false, reason: `${target.name} does not support native resume under the current execution mode` };
  }
  // 3. Valid reference.
  if (ref.status !== "active" || !ref.resumeSupported) {
    return { compatible: false, reason: `native session reference ${ref.nativeSessionRef} is not resumable` };
  }
  // 4. Corresponding runtime native state.
  if (target.containerized) {
    const state = ref.nativeStateId ? nativeStates.get(ref.nativeStateId) : undefined;
    if (!state || !existsSync(state.path)) {
      return {
        compatible: false,
        reason: `no runtime native state behind session ${ref.nativeSessionRef} — it cannot survive a container`,
      };
    }
  } else if (ref.nativeStateId || ref.executionBackend === "docker") {
    return {
      compatible: false,
      reason: `session ${ref.nativeSessionRef} lives in containerized native state; resume it with a containerized runtime`,
    };
  }
  // 5. Same workspace.
  if (!sameResumeWorkspace(ref.workspaceId, workspaceId)) {
    return {
      compatible: false,
      reason: `workspace changed (${ref.workspaceId ?? "none"} → ${workspaceId ?? "none"}); native sessions stay bound to their workspace`,
    };
  }
  return { compatible: true, reason: `same harness (${target.kind}) + same workspace + native state available` };
}

/**
 * Everything needed to materialize one Run under an existing Task
 * (submit creates its own Task; continuation passes overrides here).
 */
interface RunSpec {
  title?: string;
  runtimeId?: ID;
  modelId?: ID;
  workspaceId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: ID[];
  tools?: string[];
  timeoutMs?: number;
  policy?: ExecutionPolicy;
  inputInstruction?: string;
  /** The user's actual input (bare prompt, no handoff/system context — v5 §5). */
  userPrompt?: string;
  /** System instructions snapshotted from the agent profile (v4 §10). */
  systemInstructions?: string;
  continuity?: RunContinuity;
  previousHandoffId?: ID;
  runtimeSessionRefId?: ID;
  lifecycle?: RuntimeLifecycle;
}

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

/**
 * Raised when a handoff's context cannot be produced by the model: no
 * summarization model is configured, the provider call failed, or the
 * transcript could not be summarized. Recoverable — the caller may retry
 * with `allowDegradedHandoff`, which explicitly accepts a structured
 * digest in place of a model summary (recorded as
 * `generation.method: "heuristic"` so it is never mistaken for one).
 */
export class HandoffUnavailableError extends Error {
  readonly code = "handoff-unavailable";
  constructor(readonly reason: string, readonly detail?: string) {
    super(`Handoff context could not be generated: ${reason}${detail ? ` — ${detail}` : ""}`);
    this.name = "HandoffUnavailableError";
  }
}

/**
 * Raised when continuing would need a handoff that does not exist yet.
 *
 * A Handoff is an explicit action: it crosses from one native session to
 * another (usually a different harness), so it is only generated when the
 * user asks for it — never as a side effect of sending a message. A
 * continuation therefore has exactly two options: resume natively, or
 * consume a handoff that already exists (armed by the Handoff action, or
 * produced for the previous run). Anything else is this error, and the
 * client must generate the handoff first.
 *
 * Not to be confused with context compaction, which is the harness's own
 * intra-session summarization and never crosses a session boundary.
 */
export class HandoffRequiredError extends Error {
  readonly code = "handoff-required";
  constructor() {
    super(
      "This continuation needs a handoff context. A handoff is an explicit action — generate it first " +
        "(POST /api/tasks/:id/handoff, or continue with mode \"handoff\"), then send the message."
    );
    this.name = "HandoffRequiredError";
  }
}

/**
 * The target runtime is marked `usableInTask: false` — it may not execute
 * AgentFabric tasks (e.g. a discovery-only kind with no runner adapter).
 * Blocked at submit/continue time with a machine-readable code, never
 * surfaced later as a harness launch failure.
 */
export class RuntimeNotUsableError extends Error {
  readonly code = "runtime-not-usable";
  constructor(runtime: Runtime) {
    super(
      `Runtime "${runtime.name}" (${runtime.kind}) is not usable for tasks (usableInTask is disabled) — ` +
        "pick a usable runtime, or enable it on the Runtimes page."
    );
    this.name = "RuntimeNotUsableError";
  }
}

/**
 * A context window the runtime itself declares, if any (v9 §5). Explicit
 * capability metadata beats every configured fallback and is the only way a
 * harness-native target's real window can reach the handoff budget.
 */
export function declaredRuntimeContextWindow(runtime: Runtime | undefined): number | undefined {
  if (!runtime) return undefined;
  for (const value of [runtime.contextWindow, runtime.capabilities?.contextWindow, runtime.config?.contextWindow]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** Input for continuing an existing Task (spec v1 §15/§18/§20). */
export interface ContinueTaskInput {
  prompt: string;
  title?: string;
  /** Target runtime. Defaults to the task's runtime / the latest run's runtime. */
  runtimeId?: ID;
  modelId?: ID;
  /** Force `resume` or `handoff`; default `auto` decides by harness + capability. */
  mode?: "auto" | "resume" | "handoff";
  /** Extra user notes folded into the handoff (spec v1 §7 User-provided). */
  userNotes?: string;
  /**
   * Accept a degraded handoff when the model summary is unavailable. Off
   * by default: the continuation fails with `HandoffUnavailableError`
   * instead of silently degrading, and the caller must ask the user.
   */
  allowDegradedHandoff?: boolean;
  lifecycle?: RuntimeLifecycle;
  workspaceId?: ID;
  profileId?: ID;
  env?: Record<string, string>;
  secretIds?: ID[];
  tools?: string[];
  timeoutMs?: number;
  policy?: ExecutionPolicy;
}

export interface ContinueResult {
  task: Task;
  run: Run;
  continuity: RunContinuity;
  /** Handoff created/used for this continuation (handoff continuity only). */
  handoff?: Handoff;
  /** Native session resumed by this run (resume continuity only). */
  runtimeSessionRef?: RuntimeSessionRef;
  /** Human-readable explanation of the resume-vs-handoff decision. */
  explanation: string;
}

/** Preview of what continuing a Task would do (spec v1 §18: clear UX). */
export interface ContinueOptions {
  task: Task;
  latestRun?: Run;
  currentRuntime?: { id: ID; name: string; kind: string };
  targetRuntime?: { id: ID; name: string; kind: string; capabilities: RuntimeCapability };
  resumeAvailable: boolean;
  suggestedMode: "resume" | "handoff";
  suggestedContinuity: RunContinuity;
  resumableSession?: RuntimeSessionRef;
  /** An explicitly requested handoff is armed: the next turn (any harness) consumes it as the sole context. */
  handoffReady: boolean;
  /**
   * A handoff already exists for the latest run (armed, or generated for
   * it): the continuation consumes it without generating anything. When
   * false and `suggestedContinuity` is `handoff`, the client must ask the
   * user to generate one — `continue` refuses to do it implicitly.
   */
  handoffAvailable: boolean;
  explanation: string;
}

/** Builds the one-off completion client used for compaction summarization. */
export type CompletionFactory = (opts: {
  provider: Provider;
  model: Model;
  apiKey?: string;
}) => CompletionFn;

export class RunService {
  private controllers = new Map<string, { controller: AbortController; reason: "cancel" | "timeout" | "policy" }>();
  private active = new Map<string, Promise<void>>();
  private leaseManager: ContainerLeaseManager;
  /** In-flight handoff generations keyed by the previous run and its degradation policy, so the UI pre-generate and a racing continue share one result. */
  private handoffGenerations = new Map<string, Promise<Handoff>>();
  /**
   * Local harness thread sources (v6 §6–§8): read existing harness-native
   * threads (e.g. Codex threads created outside AgentFabric) for
   * discovery and adoption. Injected by the server/CLI; absent sources
   * simply disable those routes.
   */
  private threadSources: Partial<Record<string, LocalHarnessThreadSource>>;

  constructor(
    private store: Store,
    private bus: EventBus,
    private registry: RuntimeRegistry,
    private containerOps: ContainerOps = { destroy: async () => {} },
    private completionFactory: CompletionFactory = ({ provider, model, apiKey }) =>
      createHttpCompletionFn(provider, model, apiKey),
    threadSources: Partial<Record<string, LocalHarnessThreadSource>> = {}
  ) {
    this.leaseManager = new ContainerLeaseManager(containerOps, {
      onDestroyed: async (lease) => {
        await this.emitRunEvent(lease.runId, "container.destroyed", {
          containerId: lease.containerId,
          reason: "idle-timeout",
          runtimeId: lease.runtimeId,
          taskId: lease.taskId,
        });
      },
    });
    this.threadSources = threadSources;
  }

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

  forTask(taskId: string): Run[] {
    return this.store
      .list<Run>("runs")
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async events(runId: string): Promise<RunEvent[]> {
    return this.store.readEvents(runId);
  }

  async logs(runId: string): Promise<string[]> {
    return (await this.events(runId))
      .filter((e) => e.type === "log" || e.type === "shell.output" || e.type === "agent.message")
      .map((e) => {
        const line = String(e.data?.line ?? e.data?.message ?? e.data?.text ?? e.data?.content ?? "");
        const prefix = e.type === "agent.message" ? "[agent] " : e.type === "shell.output" ? "[shell] " : "";
        return prefix + line;
      });
  }

  /** Kept keep-alive containers (for API/UI inspection). */
  keptContainers() {
    return this.leaseManager.list();
  }

  /**
   * Re-arm keep-alive destroy timers from container labels after a
   * server restart so retained containers never leak.
   */
  async recoverKeepAliveContainers(): Promise<void> {
    if (!this.containerOps.listKeepAlive) return;
    await recoverKeepAliveContainers(this.leaseManager, await this.containerOps.listKeepAlive());
  }

  async submit(input: NewTaskInput): Promise<SubmitResult> {
    const resolved = await this.resolveTask(input);
    this.assertProviderUsable(resolved.modelId);
    this.assertRuntimeUsable(resolved.runtimeId ? this.runtimeService().get(resolved.runtimeId) : undefined);
    const task = await this.taskService().create(resolved);
    const profile = resolved.profileId ? this.profileService().get(resolved.profileId) : undefined;
    const run = await this.createRun(task, {
      continuity: "new",
      inputInstruction: task.prompt,
      userPrompt: task.prompt,
      lifecycle: resolved.lifecycle,
      profileId: resolved.profileId,
      systemInstructions: profile?.systemInstructions,
    });
    void this.execute(run.id);
    return { task, run };
  }

  /**
   * A disabled provider must block new runs at creation time with a clear
   * error — never surface later as an auth/connection failure inside the
   * harness (v4 §5).
   */
  private assertProviderUsable(modelId: ID | undefined): void {
    if (!modelId) return;
    const model = this.modelService().get(modelId);
    if (!model) return;
    const provider = this.providerService().get(model.providerId);
    if (!provider) {
      throw new Error(`Model "${model.alias ?? model.name}" points at a missing provider — reconfigure the model before running`);
    }
    if (!provider.enabled) {
      throw new Error(
        `Provider "${provider.name}" is disabled — enable it before starting runs with model "${model.alias ?? model.name}"`
      );
    }
  }

  /**
   * A runtime marked `usableInTask: false` may not execute a task here
   * (e.g. discovery-only kinds without a runner adapter). Enforced at the
   * execution entry points — submit and continue — so the API cannot
   * bypass what the composers filter.
   */
  private assertRuntimeUsable(runtime: Runtime | undefined): void {
    if (!runtime) return;
    if (!runtime.usableInTask) throw new RuntimeNotUsableError(runtime);
  }

  /**
   * Continue an existing Task (spec v1 §15/§20).
   *
   * Same harness → native Resume (when the harness declares the
   * capability and a resumable session reference exists). Different
   * harness (or native resume impossible) → Handoff: a semantic work
   * handoff is generated and injected into the new harness's *new*
   * native session; the session itself is never migrated.
   */
  async continueTask(
    taskId: string,
    input: ContinueTaskInput,
    options?: { signal?: AbortSignal }
  ): Promise<ContinueResult> {
    const task = this.taskService().get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!input.prompt?.trim()) throw new Error("prompt is required to continue a task");

    const previousRuns = this.forTask(taskId);
    const previousRun = previousRuns[previousRuns.length - 1];
    const target = await this.pickTargetRuntime(task, input.runtimeId);
    const adapter = this.registry.get(target.kind);
    const caps = effectiveCapabilities(adapter, target);

    // Apply the agent profile's defaults (env/secrets/policy/model),
    // overridable by the explicit continuation input.
    const profile = input.profileId ? this.profileService().get(input.profileId) : undefined;
    const mergedEnv = { ...(profile?.env ?? {}), ...(input.env ?? {}) };
    const mergedSecretIds = [...new Set([...(input.secretIds ?? []), ...(profile?.secretIds ?? [])])];
    const mergedPolicy = input.policy ?? profile?.policy;
    // Harness-native targets (v6 §3) keep their own account/model — an
    // explicit AgentFabric model never rides along.
    const modelId = this.isHarnessNative(target) ? undefined : input.modelId ?? profile?.modelId ?? undefined;

    const previousRuntime = previousRun?.runtimeId ? this.runtimeService().get(previousRun.runtimeId) : undefined;
    const sameHarness = previousRuntime?.kind === target.kind;
    const workspaceId = input.workspaceId ?? task.workspaceId ?? previousRun?.workspaceId;
    this.assertProviderUsable(input.modelId ?? profile?.modelId ?? task.modelId ?? previousRun?.modelId);
    // A runtime the product marks unusable for tasks never executes here —
    // not as a UI filter the API could bypass.
    this.assertRuntimeUsable(target);
    // The candidate lookup filters by harness; every other dimension
    // (capability, state, workspace) is decided by the compatibility
    // gate so the blocking reason is always available for the result.
    const resumable = this.runtimeSessionService().latestResumable(taskId, target.kind);
    const resumeGate = resumable
      ? evaluateResumeCompatibility(resumable, target, caps, workspaceId, this.nativeStateService())
      : undefined;
    const armed = this.armedHandoff(taskId);
    // An explicitly requested handoff (the standalone Handoff action) is
    // harness-independent: the next turn consumes it as the *sole* context —
    // even on the same harness, where a native resume would otherwise win.
    const handoffArmed = Boolean(armed) && input.mode !== "resume";
    const forcedHandoff = input.mode === "handoff";
    const resumePossible =
      sameHarness && Boolean(resumable && resumeGate?.compatible) && !forcedHandoff && !handoffArmed;

    if (resumePossible) {
      /* ---------------- Resume: same harness, native session ---------------- */
      const ref = resumable!;
      const run = await this.createRunFromTask(task, {
        continuity: "resume",
        inputInstruction: input.prompt,
        userPrompt: input.prompt,
        runtimeId: target.id,
        modelId,
        workspaceId,
        runtimeSessionRefId: ref.id,
        lifecycle: resolveLifecycle(target, input.lifecycle),
        profileId: input.profileId,
        env: Object.keys(mergedEnv).length ? mergedEnv : undefined,
        secretIds: mergedSecretIds.length ? mergedSecretIds : undefined,
        tools: input.tools,
        timeoutMs: input.timeoutMs,
        policy: mergedPolicy,
        systemInstructions: profile?.systemInstructions,
      });
      void this.execute(run.id);
      return {
        task,
        run,
        continuity: "resume",
        runtimeSessionRef: ref,
        explanation:
          `Resume: ${target.name} (${target.kind}) supports native session resume; ` +
          `continuing its native session ${ref.nativeSessionRef}. No handoff was created.`,
      };
    }

    /* ---------------- Handoff: semantic work handoff, new native session ---------------- */
    const handoff = await this.prepareHandoff(
      task,
      previousRun,
      previousRuntime,
      target,
      input,
      "continuation",
      options?.signal
    );
    const rendered = renderHandoffPrompt(handoff, input.prompt);
    const run = await this.createRunFromTask(task, {
      continuity: "handoff",
      inputInstruction: rendered,
      userPrompt: input.prompt,
      runtimeId: target.id,
      modelId,
      workspaceId,
      previousHandoffId: handoff.id,
      lifecycle: resolveLifecycle(target, input.lifecycle),
      profileId: input.profileId,
      env: Object.keys(mergedEnv).length ? mergedEnv : undefined,
      secretIds: mergedSecretIds.length ? mergedSecretIds : undefined,
      tools: input.tools,
      timeoutMs: input.timeoutMs,
      policy: mergedPolicy,
      systemInstructions: profile?.systemInstructions,
    });
    // The next turn happened, so nothing is awaiting it any more: retire
    // every armed handoff of the task, which is the exit condition of the
    // invariant arming maintains. Retiring only the consumed record would
    // let an armed record left behind by another client (the flag is stored
    // state, so an older tab or CLI can leave one) be *resurrected* by this
    // turn and hijack a later one.
    for (const awaiting of this.handoffService().list({ taskId })) {
      if (awaiting.awaitingNextTurn) {
        await this.store.update<Handoff>("handoffs", awaiting.id, { awaitingNextTurn: false });
      }
    }
    void this.execute(run.id);
    const reason = forcedHandoff
      ? `Handoff requested explicitly.`
      : handoffArmed
        ? `Handoff: a generated handoff context is pending — this turn starts a new session seeded with it as the only context, regardless of harness.`
        : sameHarness
          ? `Handoff: ${target.name} cannot natively resume (${resumeGate && !resumeGate.compatible ? resumeGate.reason : resumable ? "native resume not permitted" : "no resumable session reference found"}); a new native session is created and continues from the handoff.`
          : `Handoff: switching harness ${previousRuntime?.name ?? previousRuntime?.kind ?? "(unknown)"} → ${target.name} (${target.kind}); sessions are not migrated across harnesses — the new harness starts its own new native session from the handoff.`;
    return { task, run, continuity: "handoff", handoff, explanation: reason };
  }

  /** Preview the resume/handoff decision for a task (used by UI/CLI). */
  continueOptions(taskId: string, runtimeId?: ID): ContinueOptions {
    const task = this.taskService().get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const previousRuns = this.forTask(taskId);
    const previousRun = previousRuns[previousRuns.length - 1];
    const previousRuntime = previousRun?.runtimeId ? this.runtimeService().get(previousRun.runtimeId) : undefined;
    // Same fallback order as pickTargetRuntime: explicit > latest run's
    // runtime > task default > first enabled runtime. The latest run wins
    // over the task's original default: after a mid-task harness switch,
    // "continue" means the harness the work just happened on — an untouched
    // continue must not silently jump back to the task's birth harness and
    // turn a plain resume into a cross-harness handoff request.
    const targetId = runtimeId ?? previousRuntime?.id ?? task.runtimeId ?? this.runtimeService().enabled()[0]?.id;
    const target = targetId ? this.runtimeService().get(targetId) : undefined;
    const adapter = target ? this.registry.get(target.kind) : undefined;
    const caps = effectiveCapabilities(adapter, target);
    const workspaceId = task.workspaceId ?? previousRun?.workspaceId;
    const resumable = target ? this.runtimeSessionService().latestResumable(taskId, target.kind) : undefined;
    const resumeGate = resumable && target
      ? evaluateResumeCompatibility(resumable, target, caps, workspaceId, this.nativeStateService())
      : undefined;
    const sameHarness = previousRuntime && target && previousRuntime.kind === target.kind;
    const handoffReady = Boolean(this.armedHandoff(taskId));
    const resumeAvailable = Boolean(sameHarness && resumable && resumeGate?.compatible) && !handoffReady;
    const suggestedMode: "resume" | "handoff" = resumeAvailable ? "resume" : "handoff";

    const explanation = handoffReady
      ? `Handoff: a generated handoff context is ready — the next turn (any harness) starts a fresh session seeded with it as the only context.`
      : resumeAvailable
        ? `Resume: same harness (${target?.name}) with a resumable native session (${resumable?.nativeSessionRef}).`
        : previousRun
          ? target && previousRuntime?.kind !== target.kind
            ? `Handoff: harness changes ${previousRuntime?.name ?? previousRuntime?.kind ?? "(unknown)"} → ${target?.name}; no session migration, the handoff plus the shared workspace carry the context.`
            : `Handoff: ${target?.name ?? "target runtime"} cannot natively resume${resumeGate && !resumeGate.compatible ? ` (${resumeGate.reason})` : ""}; continuing via a handoff into a new native session.`
          : "New task: no previous run yet — the first run starts a fresh session.";
    const noAdapter =
      target != null && !adapter
        ? " Warning: no runtime adapter is registered for this kind — the run will fail until one is available."
        : "";

    return {
      task,
      latestRun: previousRun,
      currentRuntime: previousRuntime ? { id: previousRuntime.id, name: previousRuntime.name, kind: previousRuntime.kind } : undefined,
      targetRuntime: target ? { id: target.id, name: target.name, kind: target.kind, capabilities: caps } : undefined,
      resumeAvailable,
      suggestedMode,
      suggestedContinuity: resumeAvailable ? "resume" : previousRun ? "handoff" : "new",
      resumableSession: resumable,
      handoffReady,
      handoffAvailable: Boolean(previousRun && this.latestHandoffFrom(previousRun.id)),
      explanation: explanation + noAdapter,
    };
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
  private runtimeSessionService() {
    return new RuntimeSessionService(this.store);
  }
  private nativeStateService() {
    return new NativeStateService(this.store);
  }
  private handoffService() {
    return new HandoffService(this.store);
  }

  /**
   * The handoff armed for this task's next turn — the one an explicit
   * Handoff action pre-generated and the next message must consume as its
   * sole context.
   *
   * The flag lives on the handoff record (`awaitingNextTurn`) because *it*
   * is what the next turn consumes. A run's `generatedHandoffId` only says
   * which handoff was generated from that run: it is history, it is
   * written on whichever path happened to produce a handoff (so a run that
   * generated one last week keeps it), and it can name a record that has
   * since been discarded. Deriving "is a handoff armed?" from it made the
   * armed handoff invisible the moment the page that requested it was
   * gone — the thread showed no handoff and the next message resumed the
   * native session instead of using it.
   *
   * A task has one next turn, so at most one handoff is armed; arming a
   * new one disarms the previous (see `generateHandoff`).
   */
  private armedHandoff(taskId: ID): Handoff | undefined {
    return this.handoffService()
      .list({ taskId })
      .find((h) => h.awaitingNextTurn);
  }

  /**
   * The newest handoff generated from a run — the cached summary a
   * continuation of that run reuses instead of summarizing the same runs
   * again.
   */
  private latestHandoffFrom(runId: ID): Handoff | undefined {
    return this.handoffService().list({ runId })[0];
  }

  /** Low-level event write used by lease callbacks (outside a run ctx). */
  private async emitRunEvent(runId: string, type: EventType, data: Record<string, unknown>): Promise<void> {
    const run = this.get(runId);
    const event: RunEvent = {
      id: newId("evt"),
      runId,
      seq: this.store.nextSeq(),
      type,
      timestamp: now(),
      data,
      source: "core",
    };
    await this.store.appendEvent(event);
    if (run) {
      run.eventCount += 1;
      run.updatedAt = now();
      await this.store.commit();
    }
    this.bus.publish(event);
  }

  /** Resolve profile/runtime/model/workspace defaults into a concrete task. */
  private async resolveTask(input: NewTaskInput): Promise<NewTaskInput> {
    const profile = input.profileId ? this.profileService().get(input.profileId) : undefined;
    const runtimeId = input.runtimeId ?? profile?.runtimeId ?? this.runtimeService().enabled()[0]?.id;
    const runtime = runtimeId ? this.runtimeService().get(runtimeId) : undefined;
    // Harness-native runtimes (v6 §3) never bind an AgentFabric Model —
    // they run on the harness's own account and default model (Codex +
    // ChatGPT), so no model default is injected and any explicit modelId
    // is dropped rather than silently misleading the run record.
    const modelId = this.isHarnessNative(runtime)
      ? undefined
      : input.modelId ?? profile?.modelId ?? runtime?.defaultModelId ?? this.modelService().list().find((m) => m.enabled)?.id;

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
    // Tool allowlist is the union of policy permissions, profile tools and
    // task tools (v4 §11) — runtime adapters enforce it uniformly.
    const tools = [...new Set([...(policy?.toolPermissions ?? []), ...(profile?.tools ?? []), ...(input.tools ?? [])])];
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

  private async createRun(task: Task, extra: RunSpec = {}): Promise<Run> {
    return this.createRunFromTask(task, extra, task.prompt);
  }

  /** Creates a Run for an existing Task (used by submit & continueTask). */
  private async createRunFromTask(task: Task, extra: RunSpec = {}, fallbackInstruction?: string): Promise<Run> {
    const runtimeId = extra.runtimeId ?? task.runtimeId;
    const modelId = extra.modelId ?? task.modelId;
    const runtime = runtimeId ? this.runtimeService().get(runtimeId) : undefined;
    const model = modelId ? this.modelService().get(modelId) : undefined;
    const provider = model ? this.providerService().get(model.providerId) : undefined;
    const run: Run = {
      id: newId("run"),
      taskId: task.id,
      taskTitle: extra.title ?? task.title,
      status: "pending",
      runtimeId,
      runtimeName: runtime?.name,
      modelId,
      modelName: model?.alias ?? model?.name,
      providerId: provider?.id,
      workspaceId: extra.workspaceId ?? task.workspaceId,
      inputInstruction: extra.inputInstruction ?? fallbackInstruction ?? task.prompt,
      userPrompt: extra.userPrompt ?? (extra.inputInstruction ? undefined : fallbackInstruction ?? task.prompt),
      systemInstructions: extra.systemInstructions,
      continuity: extra.continuity ?? "new",
      previousHandoffId: extra.previousHandoffId,
      runtimeSessionRefId: extra.runtimeSessionRefId,
      lifecycle: normalizeLifecycle(extra.lifecycle ?? resolveLifecycle(runtime)),
      profileId: extra.profileId,
      env: extra.env,
      secretIds: extra.secretIds,
      tools: extra.tools,
      timeoutMs: extra.timeoutMs,
      policy: extra.policy,
      artifactIds: [],
      eventCount: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.store.insert("runs", run);
    return run;
  }

  /**
   * Target runtime for continuing a task: the explicit choice wins; else the
   * latest run's runtime (a mid-task harness switch makes THAT harness the
   * natural continuation — an untouched continue must not jump back to the
   * task's birth harness and demand a cross-harness handoff); else the
   * task's default; else the first enabled runtime.
   */
  private async pickTargetRuntime(task: Task, runtimeId?: ID): Promise<Runtime> {
    const runs = this.forTask(task.id);
    let lastRunRuntimeId: ID | undefined;
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].runtimeId) {
        lastRunRuntimeId = runs[i].runtimeId;
        break;
      }
    }
    const id = runtimeId ?? lastRunRuntimeId ?? task.runtimeId;
    const runtime = id ? this.runtimeService().get(id) : undefined;
    if (!runtime) {
      const fallback = this.runtimeService().enabled()[0];
      if (!fallback) throw new Error("No enabled runtime available to continue this task");
      return fallback;
    }
    return runtime;
  }

  /**
   * True when the runtime authenticates with its own harness-native
   * account (v6 §2/§3): the runtime record or the adapter declares
   * `harness-native`, e.g. Codex Local with its ChatGPT login.
   */
  private isHarnessNative(runtime: Runtime | undefined): boolean {
    if (!runtime) return false;
    if (runtime.credentialSource === "harness-native") return true;
    if (runtime.credentialSource === "agentfabric") return false;
    return this.registry.get(runtime.kind)?.credentialSource === "harness-native";
  }

  /**
   * Resolve the Handoff mediating a cross-session continuation: reuse the
   * handoff already attached to the previous run, or generate one — the
   * latter only for an explicit request (`mode: "handoff"`), never as a
   * side effect of sending a message (`HandoffRequiredError` otherwise).
   * User notes are folded in (spec v1 §7).
   */
  private async prepareHandoff(
    task: Task,
    previousRun: Run | undefined,
    previousRuntime: Runtime | undefined,
    target: Runtime | undefined,
    input: ContinueTaskInput,
    trigger: HandoffTrigger,
    signal?: AbortSignal
  ): Promise<Handoff> {
    const handoffService = this.handoffService();

    if (!previousRun) {
      // No previous run: still record a handoff so the context trail is explicit.
      const content: HandoffContent = {
        originalTask: `#${task.title}: ${task.prompt}`,
        currentObjective: input.title ?? task.title,
        notesForNextAgent: "No previous run exists; this is the task's original brief.",
      };
      return handoffService.create({
        taskId: task.id,
        fromRunId: "none",
        fromRuntimeName: previousRuntime?.name,
        fromRuntimeKind: previousRuntime?.kind,
        toRuntimeId: target?.id,
        toRuntimeName: target?.name,
        toRuntimeKind: target?.kind,
        source: "agentfabric",
        generation: { method: "brief", trigger },
        content,
        userNotes: input.userNotes,
        workspaceId: task.workspaceId,
      });
    }

    // Reuse the newest handoff already generated from this run instead of
    // summarizing it again — a pre-generated (armed or targeted) handoff is
    // exactly this run's cached summary.
    let handoff = this.latestHandoffFrom(previousRun.id);
    const notes = input.userNotes?.trim();

    if (!handoff) {
      // Handoff vs context compaction: a handoff crosses from one native
      // session to another and is an explicit user action. Sending a
      // message must never trigger one as a side effect, so the only
      // implicit paths are resume and consuming an existing handoff
      // (handled above). Anything else is refused for the client to ask.
      if (input.mode !== "handoff") throw new HandoffRequiredError();
      // Concurrent callers (UI pre-generate + a racing continue) share one
      // generation so only one summary is produced and one record stored.
      // The degradation policy AND the notes are part of the key: two callers
      // with different notes need different budgets, and a caller that accepts
      // a digest must not inherit a strict caller's rejection (and vice versa).
      const allowDegraded = input.allowDegradedHandoff === true;
      const key = `${previousRun.id}:${allowDegraded ? "degraded" : "strict"}:${notes ?? ""}`;
      let pending = this.handoffGenerations.get(key);
      if (!pending) {
        pending = this.generateAndStoreHandoff(
          task,
          previousRun,
          previousRuntime,
          target,
          this.targetModelIdFor(target, input),
          allowDegraded,
          trigger,
          notes,
          signal
        );
        this.handoffGenerations.set(key, pending);
        pending.catch(() => {}).finally(() => this.handoffGenerations.delete(key));
      }
      handoff = await pending;
    }

    // A freshly generated handoff already carries the notes (and budgeted for
    // them); only a REUSED handoff needs them attached here.
    if (notes && handoff.userNotes !== notes) {
      handoff = (await handoffService.addUserNotes(handoff.id, notes)) ?? handoff;
    }

    // Point the handoff at the concrete target runtime. A pre-generation
    // without an explicit target stays harness-agnostic.
    if (!target) return handoff;
    handoff = (await this.store.update<Handoff>("handoffs", handoff.id, {
      toRuntimeId: target.id,
      toRuntimeName: target.name,
      toRuntimeKind: target.kind,
    })) ?? handoff;
    return handoff;
  }

  /** Generate the context bundle, store it as this run's handoff, and announce it. */
  private async generateAndStoreHandoff(
    task: Task,
    previousRun: Run,
    previousRuntime: Runtime | undefined,
    target: Runtime | undefined,
    targetModelId: ID | undefined,
    allowDegraded: boolean,
    trigger: HandoffTrigger,
    userNotes: string | undefined,
    signal?: AbortSignal
  ): Promise<Handoff> {
    const handoffService = this.handoffService();
    const artifacts = this.artifactService().list(previousRun.id);
    const generated = await this.generateHandoffContent(
      task,
      previousRun,
      previousRuntime,
      target,
      targetModelId,
      artifacts,
      allowDegraded,
      userNotes,
      signal
    );
    // The generation's provenance is written once and carried by both the
    // record and the `handoff.generated` event, so the handoff page and the
    // task timeline can never disagree about how it was produced.
    const generation: HandoffGeneration = {
      method: generated.method,
      trigger,
      ...(generated.detail ? { detail: generated.detail } : {}),
      ...(generated.chunks ? { chunks: generated.chunks } : {}),
      ...(generated.model ? { modelId: generated.model.id, modelName: generated.model.name } : {}),
      ...(generated.providerName ? { providerName: generated.providerName } : {}),
      ...(generated.modelSource ? { modelSource: generated.modelSource } : {}),
      ...(generated.coveredRunIds.length ? { coveredRunIds: generated.coveredRunIds } : {}),
      durationMs: generated.durationMs,
      ...(generated.usage ? { usage: generated.usage } : {}),
    };
    const handoff = await handoffService.create({
      taskId: task.id,
      fromRunId: previousRun.id,
      fromRuntimeId: previousRuntime?.id,
      fromRuntimeName: previousRuntime?.name,
      fromRuntimeKind: previousRuntime?.kind,
      toRuntimeId: target?.id,
      toRuntimeName: target?.name,
      toRuntimeKind: target?.kind,
      source: "agentfabric",
      generation,
      content: generated.content,
      ...(userNotes ? { userNotes } : {}),
      workspaceId: previousRun.workspaceId,
      artifactIds: artifacts.map((a) => a.id),
    });
    await this.emitRunEvent(previousRun.id, "handoff.generated", {
      handoffId: handoff.id,
      source: "agentfabric",
      ...generation,
      ...(target ? { toRuntime: target.name } : {}),
    });
    // The run keeps pointing at the handoff generated from it (the run
    // inspector shows it); decisions never read it back (see `armedHandoff`).
    await this.store.update<Run>("runs", previousRun.id, { generatedHandoffId: handoff.id, updatedAt: now() });
    return handoff;
  }

  /**
   * Pre-generate the task's handoff without starting a run — the standalone
   * Handoff action. With no explicit runtimeId the summary is harness-
   * agnostic and armed (`awaitingNextTurn`): the next turn consumes it as
   * its sole context on whichever harness that turn runs on, instead of
   * resuming a native session. An in-flight generation is awaited, not
   * doubled, and an existing summary is reused.
   *
   * This is an *explicit* request, so it never degrades by default: if the
   * model summary is unavailable it throws `HandoffUnavailableError`.
   * System callers that must not be blocked (thread adoption) pass
   * `allowDegraded`; a caller `signal` cancels the generation when the
   * client disconnects.
   */
  async generateHandoff(
    taskId: ID,
    runtimeId?: ID,
    options?: { allowDegraded?: boolean; signal?: AbortSignal; userNotes?: string }
  ): Promise<Handoff> {
    const task = this.taskService().get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const previousRuns = this.forTask(taskId);
    const previousRun = previousRuns[previousRuns.length - 1];
    if (!previousRun) throw new Error(`No run to hand off from for task: ${taskId}`);
    const previousRuntime = previousRun.runtimeId ? this.runtimeService().get(previousRun.runtimeId) : undefined;
    const target = runtimeId ? await this.pickTargetRuntime(task, runtimeId) : undefined;
    // prompt is unused on this path: a previous run always exists, so only
    // userNotes/title are read by prepareHandoff.
    const handoff = await this.prepareHandoff(
      task,
      previousRun,
      previousRuntime,
      target,
      {
        prompt: "",
        // The standalone action is itself the explicit handoff request.
        mode: "handoff",
        allowDegradedHandoff: options?.allowDegraded === true,
        userNotes: options?.userNotes,
      },
      // Without a target harness this is the user asking for a handoff; with
      // one it is a pre-generation cached for that harness (Continue with X,
      // thread adoption).
      runtimeId ? "targeted" : "explicit",
      options?.signal
    );
    // Arm only the standalone, harness-agnostic generation. An explicitly
    // targeted pre-generation (thread adoption, CLI) stays a plain cached
    // summary for that runtime — it must not hijack a same-harness resume.
    if (!runtimeId) {
      // Arming replaces whatever was armed before: a task has exactly one
      // next turn, so exactly one handoff can be waiting for it. Without
      // this, every extra click left another `awaitingNextTurn` record
      // behind — invisible ones that no turn would ever consume.
      for (const other of this.handoffService().list({ taskId })) {
        if (other.awaitingNextTurn && other.id !== handoff.id) {
          await this.store.update<Handoff>("handoffs", other.id, { awaitingNextTurn: false });
        }
      }
      return (await this.store.update<Handoff>("handoffs", handoff.id, { awaitingNextTurn: true })) ?? handoff;
    }
    return handoff;
  }

  /* ---------------- local harness threads (v6 §6–§8) ---------------- */

  /** Live harness-native auth check (v6 §2); null when the adapter has none. */
  async harnessAuthStatus(kind: string): Promise<HarnessAuthStatus | null> {
    const check = this.registry.get(kind)?.checkAuth;
    return check ? await check() : null;
  }

  private threadSource(kind: string): LocalHarnessThreadSource {
    const source = this.threadSources[kind];
    if (!source) throw new Error(`No local thread source registered for runtime kind "${kind}"`);
    return source;
  }

  /**
   * Lists existing local threads of a harness (v6 §6), newest first,
   * optionally narrowed to a workspace cwd. Threads already adopted into
   * a task are flagged so the UI can say "already in AgentFabric".
   */
  async listHarnessThreads(kind: string, filter: HarnessThreadFilter = {}): Promise<HarnessThreadSummary[]> {
    const threads = await this.threadSource(kind).listThreads(filter);
    // Adoption marker: task metadata { harness, threadId } (set by import).
    const adopted = new Map<string, ID>();
    for (const task of this.taskService().list()) {
      const meta = task.metadata ?? {};
      if (meta.importedFromHarness === kind && typeof meta.importedThreadId === "string") {
        adopted.set(meta.importedThreadId, task.id);
      }
    }
    return threads.map((t) => {
      const taskId = adopted.get(t.id);
      return taskId ? { ...t, adopted: true, adoptedTaskId: taskId } : t;
    });
  }

  /** Reads an existing harness-native thread (v6 §7) — no model request. */
  async readHarnessThread(kind: string, threadId: string): Promise<HarnessThreadDetail> {
    return this.threadSource(kind).readThread(threadId);
  }

  /**
   * Adopts an existing harness-native thread into AgentFabric (v6 §8):
   *
   *   Existing Codex Thread → Read Thread → Associate Workspace →
   *   (optional) Generate Handoff → Continue with Pi / OpenCode
   *
   * The thread itself is NOT converted into an AgentFabric session (v6
   * §14): each Codex turn is recorded as one completed Run whose events
   * are projected from the thread's items, the thread id is registered as
   * a RuntimeSessionRef (so Codex → Codex still native-resumes), and the
   * handoff toward another harness is generated from those records.
   */
  async importHarnessThread(input: ImportHarnessThreadInput): Promise<ImportHarnessThreadResult> {
    const kind = input.runtimeKind;
    const source = this.threadSource(kind);
    const runtime = this.runtimeService().enabled().find((r) => r.kind === kind);
    if (!runtime) throw new Error(`No enabled "${kind}" runtime available to adopt a ${kind} thread`);
    const adapter = this.registry.get(kind);
    const caps = effectiveCapabilities(adapter, runtime);

    const detail = await source.readThread(input.threadId);
    if (!detail.id) throw new Error(`Thread not found: ${input.threadId}`);

    /* ---- Associate workspace (v6 §8): the caller's explicit choice.
            Importing a directory is a decision — a session run in a scratch
            or nested directory must not silently become a workspace record —
            so adoption never guesses one from the cwd. ---- */
    let workspaceId = input.workspaceId;
    if (workspaceId) {
      if (!this.workspaceService().get(workspaceId)) throw new Error(`Workspace not found: ${workspaceId}`);
    } else if (input.createWorkspaceName?.trim()) {
      if (!detail.cwd) throw new Error("Cannot create a workspace for this thread: it recorded no working directory");
      // Imported in place: the record references the directory the session
      // ran in and never copies user files. It fails loudly when that
      // directory is gone, rather than degrading to "no workspace".
      workspaceId = (await this.workspaceService().import({ name: input.createWorkspaceName.trim(), type: "local", path: detail.cwd })).id;
    }

    /* ---- Turn grouping: harness-provided boundaries when available,
            else split the flattened history at each user message. ---- */
    const turns = groupHarnessThreadTurns(detail);

    const firstUser = turns.find((t) => t.userText?.trim())?.userText;
    const title =
      input.title?.trim() ||
      detail.title?.trim() ||
      (firstUser ? firstUser.slice(0, 80) : undefined) ||
      `${kind} thread ${detail.id.slice(0, 8)}`;
    const prompt = input.prompt?.trim() || firstUser || detail.preview || `Imported ${kind} thread ${detail.id}`;

    /* ---- Task + one completed Run per turn (v6 §7 → standard events). ---- */
    const task = await this.taskService().create({
      title,
      prompt,
      runtimeId: runtime.id,
      workspaceId,
      metadata: {
        imported: true,
        importedFromHarness: kind,
        importedThreadId: detail.id,
        importedAt: now(),
        ...(detail.cwd ? { importedCwd: detail.cwd } : {}),
        ...(detail.updatedAt ? { threadUpdatedAt: detail.updatedAt } : {}),
      },
    });

    // Backdated, strictly increasing timestamps keep forTask() ordering
    // stable even when turns are recorded within the same millisecond.
    const runId = await this.appendImportedTurns(task, runtime, detail, turns, workspaceId, { startIndex: 0 });

    /* ---- Register the thread as the task's native session (v6 §4):
            same harness resumes it, other harnesses go through Handoff. ---- */
    let runtimeSessionRefId: ID | undefined;
    if (runId) {
      const ref = await this.runtimeSessionService().register({
        runtimeId: runtime.id,
        runtimeKind: runtime.kind,
        runtimeName: runtime.name,
        nativeSessionRef: detail.id,
        resumeSupported: caps.supportsNativeResume,
        taskId: task.id,
        runId,
        workspaceId,
        executionBackend: "local",
        metadata: { imported: true, threadTitle: detail.title, cwd: detail.cwd },
      });
      runtimeSessionRefId = ref.id;
      await this.store.update<Run>("runs", runId, { runtimeSessionRefId: ref.id, updatedAt: now() });
      await this.emitRunEvent(runId, "runtime.session.created", {
        runtimeSessionRefId: ref.id,
        nativeSessionRef: ref.nativeSessionRef,
        runtimeKind: ref.runtimeKind,
        imported: true,
        resumeSupported: ref.resumeSupported,
        executionBackend: ref.executionBackend,
      });
    }

    /* ---- Optional handoff toward another harness (v6 §8/§9). ---- */
    let handoffId: ID | undefined;
    if (input.targetRuntimeId) {
      try {
        // Notes are folded into the generation so the budget accounts for
        // them; `prepareHandoff` handles the reused-handoff case.
        const handoff = await this.generateHandoff(task.id, input.targetRuntimeId, {
          allowDegraded: true,
          ...(input.userNotes?.trim() ? { userNotes: input.userNotes } : {}),
        });
        handoffId = handoff?.id;
      } catch {
        // Adoption must succeed even when summary generation fails — the
        // continuation path regenerates the handoff on demand.
      }
    }

    return { taskId: task.id, runId: runId!, workspaceId, runtimeSessionRefId, handoffId };
  }

  /**
   * Re-reads a task's adopted native thread and appends the turns that
   * happened in the harness after adoption (v6 §8). This is the explicit
   * refresh behind the task page's Refresh button — never a background
   * poll — and a no-op when the native thread has not grown.
   *
   * Turn accounting decides what "already here" means: every native turn
   * is represented exactly once when it is either an imported projection
   * (continuity "new" — adoption and earlier syncs) or a run that resumed
   * this very thread (continuity "resume" on the thread's session ref).
   * Handoff runs never consumed a turn of this thread: they start their
   * own native sessions.
   */
  async syncImportedThread(taskId: ID): Promise<SyncHarnessThreadResult> {
    const task = this.taskService().get(taskId);
    if (!task) throw new Error("Task not found");
    const kind = task.metadata?.importedFromHarness;
    const threadId = task.metadata?.importedThreadId;
    if (typeof kind !== "string" || typeof threadId !== "string") {
      throw new Error("Task did not adopt a native session — nothing to sync");
    }

    // A run in flight may still append its own turn to the native thread;
    // syncing under it would miscount. Fail loudly instead.
    const taskRuns = this.forTask(taskId);
    const active = taskRuns.find((r) => !["completed", "failed", "cancelled", "timeout"].includes(r.status));
    if (active) throw new Error(`Task has an active run (${active.id}) — sync after it finishes`);

    const runtime = this.runtimeService().enabled().find((r) => r.kind === kind);
    if (!runtime) throw new Error(`No enabled "${kind}" runtime available to sync its thread`);

    const detail = await this.threadSource(kind).readThread(threadId);
    if (!detail.id) throw new Error(`Thread not found: ${threadId}`);
    const turns = groupHarnessThreadTurns(detail);

    const threadRef = this.runtimeSessionService()
      .list({ taskId })
      .find((r) => r.nativeSessionRef === threadId);
    const accounted =
      taskRuns.filter((r) => r.continuity === "new").length +
      taskRuns.filter((r) => r.continuity === "resume" && threadRef && r.runtimeSessionRefId === threadRef.id).length;
    const delta = turns.slice(accounted);

    const disarmedHandoffIds: ID[] = [];
    if (delta.length > 0) {
      await this.appendImportedTurns(task, runtime, detail, turns, task.workspaceId, { startIndex: accounted });
      // An armed handoff was generated from a snapshot the appended turns
      // no longer cover; consuming it would silently ignore the new work.
      // Disarm it — regenerating is one explicit action.
      for (const handoff of this.handoffService().list({ taskId })) {
        if (handoff.awaitingNextTurn) {
          await this.store.update<Handoff>("handoffs", handoff.id, { awaitingNextTurn: false });
          disarmedHandoffIds.push(handoff.id);
        }
      }
    }
    if (detail.updatedAt) {
      await this.taskService().update(taskId, {
        metadata: { ...task.metadata, threadUpdatedAt: detail.updatedAt },
      });
    }
    return { appendedTurns: delta.length, disarmedHandoffIds };
  }

  /**
   * Records native-thread turns as completed imported Runs (v6 §7 →
   * standard events) — the shared write path of adoption and native-thread
   * sync. Turns are backdated so appended runs always sort after the
   * existing ones in forTask().
   */
  private async appendImportedTurns(
    task: Task,
    runtime: Runtime,
    detail: HarnessThreadDetail,
    turns: Array<{ userText?: string; items: HarnessThreadItem[] }>,
    workspaceId: ID | undefined,
    opts: { startIndex: number }
  ): Promise<ID | undefined> {
    const baseMs = Date.now() - (turns.length - opts.startIndex);
    let runId: ID | undefined;
    let budget = 4000; // hard cap on synthesized events per append
    for (let i = opts.startIndex; i < turns.length; i++) {
      const turn = turns[i];
      const run = await this.createRunFromTask(
        task,
        {
          continuity: "new",
          inputInstruction: turn.userText ?? "(turn without user input)",
          userPrompt: turn.userText,
          runtimeId: runtime.id,
          workspaceId,
        },
        turn.userText ?? task.prompt
      );
      runId = run.id;
      const stamp = new Date(baseMs + i).toISOString();
      await this.store.update<Run>("runs", run.id, { createdAt: stamp, updatedAt: stamp });

      await this.emitImportEvent(run.id, "run.started", {
        runtime: runtime.name,
        imported: true,
        threadId: detail.id,
        turn: i + 1,
        turnCount: turns.length,
      });
      // Stand-in for the harness launch line so the thread view's turn
      // header shows where this run came from (and later command items
      // render as activity rows, not as the launch command).
      await this.emitImportEvent(run.id, "shell.command", {
        command: `${runtime.kind} (imported thread)`,
        cwd: detail.cwd,
        backend: "local",
        harnessInvocation: true,
        imported: true,
      });
      let used = 0;
      for (const item of turn.items) {
        if (budget-- <= 0) {
          await this.emitImportEvent(run.id, "log", { line: "import truncated: too many thread items" }, "warn");
          break;
        }
        const emitted = this.importItemEvents(item);
        for (const ev of emitted) {
          await this.emitImportEvent(run.id, ev.type as EventType, ev.data, ev.level as LogLevel | undefined);
          used++;
        }
      }
      await this.emitImportEvent(run.id, "run.completed", { exitCode: 0, imported: true });
      await this.store.update<Run>("runs", run.id, {
        status: "completed",
        startTime: stamp,
        endTime: stamp,
        modelName: detail.model,
        eventCount: used + 3,
        updatedAt: stamp,
      });
    }
    return runId;
  }

  /** Standard-event projections of one imported thread item (v6 §7). */
  private importItemEvents(item: HarnessThreadItem): Array<{ type: string; data: Record<string, unknown>; level?: string }> {
    switch (item.kind) {
      case "agent-message":
        return item.text.trim() ? [{ type: "agent.message", data: { content: item.text, role: "assistant" } }] : [];
      case "reasoning":
        return item.text.trim() ? [{ type: "agent.thinking", data: { content: item.text }, level: "debug" }] : [];
      case "command":
        return [
          { type: "shell.command", data: { command: item.command, backend: "local" } },
          {
            type: "shell.output",
            data: { output: item.output ?? "", exitCode: item.exitCode ?? null },
            level: item.exitCode ? "info" : "warn",
          },
        ];
      case "file-change":
        return [
          {
            type: item.action === "add" ? "file.created" : "file.modified",
            data: { path: item.path, changeKind: item.action },
          },
        ];
      case "tool-call":
        return [
          {
            type: "tool.completed",
            data: { tool: item.tool, args: item.arguments, result: item.result, isError: Boolean(item.isError) },
            level: item.isError ? "warn" : "info",
          },
        ];
      case "web-search":
        return [{ type: "tool.completed", data: { tool: "web_search", args: { query: item.query } } }];
      case "error":
        return [{ type: "runtime.error", data: { error: item.message }, level: "warn" }];
      default:
        return [];
    }
  }

  /** Persists one synthesized event for an imported run and fans it out. */
  private async emitImportEvent(
    runId: string,
    type: EventType,
    data: Record<string, unknown>,
    level: LogLevel = "info"
  ): Promise<void> {
    const event: RunEvent = {
      id: newId("evt"),
      runId,
      seq: this.store.nextSeq(),
      type,
      timestamp: now(),
      data,
      level,
      source: "import",
    };
    await this.store.appendEvent(event);
    const run = this.store.get<Run>("runs", runId);
    if (run) {
      run.eventCount += 1;
      run.updatedAt = now();
      await this.store.commit();
    }
    this.bus.publish(event);
  }

  /**
   * Generate AgentFabric-assisted handoff content: the context bundle
   * (`core/handoffContext.ts`) plus the checkpoint its selection leaves for the
   * model (`core/handoffSummary.ts`).
   *
   * Coverage is every run since the newest checkpoint the task already carries.
   * Of that coverage, the recent working trajectory and the historical user
   * instructions cross the boundary verbatim; only the rest is summarized into
   * the state index — a handoff is not a summary (v8).
   *
   * When the checkpoint cannot be written this throws
   * `HandoffUnavailableError` — or, if `allowDegraded` is set by a caller that
   * has asked the user, yields the structured digest instead (recorded as
   * `method: "heuristic"`). A cancelled `signal` always throws: there is no
   * caller left to accept a degraded context.
   */
  private async generateHandoffContent(
    task: Task,
    previousRun: Run,
    previousRuntime: Runtime | undefined,
    target: Runtime | undefined,
    targetModelId: ID | undefined,
    artifacts: Artifact[],
    allowDegraded: boolean,
    userNotes: string | undefined,
    signal?: AbortSignal
  ): Promise<{
    content: HandoffContent;
    method: "context-bundle" | "heuristic";
    detail?: string;
    chunks?: number;
    model?: Model;
    providerName?: string;
    modelSource?: HandoffModelSource;
    coveredRunIds: ID[];
    durationMs: number;
    usage?: { inputTokens: number; outputTokens: number };
  }> {
    // Coverage: everything after the newest checkpoint the task already
    // carries. Native-resume turns never consume a handoff, so anchoring
    // on `previousRun.previousHandoffId` alone silently dropped every run
    // before the last one — the handoff then restated only the original
    // task plus the most recent turn.
    const chain = this.forTask(task.id);
    const lastIndex = chain.findIndex((r) => r.id === previousRun.id);
    const covered = lastIndex >= 0 ? chain.slice(0, lastIndex + 1) : [previousRun];
    const { previousSummary, fromIndex } = this.handoffCheckpointAnchor(covered);
    // The runs the checkpoint actually covers — recorded on the handoff so
    // the record can be audited ("what is inside this context?") without
    // re-deriving the anchor from the chain later.
    const coveredRuns = covered.slice(fromIndex);
    const coveredRunIds = coveredRuns.map((r) => r.id);
    // User-prompt provenance (v10 §6): a task adopted from a source harness's
    // native thread recorded the harness's own view of each user turn, which
    // may embed wrappers or attachment metadata — it must not be handed to the
    // next agent as verified user-authored text.
    const imported = task.metadata?.imported === true;
    const userPromptProvenance: "user-authored" | "harness-reported" = imported
      ? "harness-reported"
      : "user-authored";
    const turns = await Promise.all(
      coveredRuns.map(async (r) => ({
        runId: r.id,
        events: await this.events(r.id),
        userPrompt: r.userPrompt,
        userPromptProvenance,
      }))
    );
    const events = turns.flatMap((t) => t.events);
    const startedAt = Date.now();

    const workspace = previousRun.workspaceId
      ? this.workspaceService().get(previousRun.workspaceId)
      : undefined;
    const heuristic = (detail: string) => ({
      content: buildAssistedHandoffContent({
        task,
        run: previousRun,
        events,
        artifacts,
        workspace,
        runtimeName: previousRuntime?.name,
      }),
      method: "heuristic" as const,
      detail,
      coveredRunIds,
      durationMs: Date.now() - startedAt,
    });

    // Degradation is never implicit: either the model produced the context,
    // or the caller explicitly accepted the digest after seeing the reason.
    // The summarizer model follows an explicit-priority order, recorded on
    // the generation for audit: the configured handoff model (Handoffs
    // page) wins; otherwise the covered run's own model, else the first
    // enabled model. A configured model that has become unusable is a loud
    // failure — the user explicitly chose it, so it never silently falls
    // back to another model.
    const configuredModelId = this.store.config().handoff?.modelId || undefined;
    const enabledModels = this.modelService().list().filter((m) => m.enabled);
    const modelId = configuredModelId ?? previousRun.modelId ?? enabledModels[0]?.id;
    const modelSource: HandoffModelSource = configuredModelId
      ? "configured"
      : previousRun.modelId
        ? "previous-run"
        : "first-enabled";
    const model = modelId ? this.modelService().get(modelId) : undefined;
    const provider = model ? this.providerService().get(model.providerId) : undefined;
    if (!model || !provider || !provider.enabled || (configuredModelId !== undefined && !model.enabled)) {
      const detail = !configuredModelId
        ? "no enabled model/provider for summarization"
        : model
          ? "the configured handoff model's provider is missing or disabled"
          : "the configured handoff model is missing or disabled";
      if (allowDegraded) return heuristic(detail);
      throw new HandoffUnavailableError(
        configuredModelId ? "the configured handoff model is unavailable" : "no summarization model is configured",
        detail
      );
    }
    let apiKey: string | undefined;
    if (provider.apiKeySecretId) {
      apiKey = this.secretService().getWithValue(provider.apiKeySecretId)?.value;
    }

    try {
      // Where the target window came from (v10 §23), resolved beside it.
      const targetWindow = this.handoffTargetContextWindow(task, target, targetModelId, model);
      const result = await generateHandoffSummary({
        task,
        run: previousRun,
        events,
        turns,
        artifacts,
        workspace,
        runtimeName: previousRuntime?.name,
        previousSummary,
        complete: this.completionFactory({ provider, model, apiKey }),
        modelMaxTokens:
          typeof model.parameters?.maxTokens === "number" ? model.parameters.maxTokens : undefined,
        // The summarizer's window bounds the checkpoint call only...
        modelContextWindow:
          typeof model.parameters?.contextWindow === "number" ? model.parameters.contextWindow : undefined,
        // ...while the handoff body is budgeted against the model that will
        // READ it. Unknown → the task's configured model → the summarizer's
        // (still a configured window, never a guess from the model name).
        targetContextWindow: targetWindow.window,
        contextWindowSource: targetWindow.source,
        // Task-brief provenance follows the same rule as the turns' prompts
        // (an adopted thread's brief is harness-reported, v10 §6).
        taskPromptProvenance: imported ? "harness-reported" : "user-authored",
        // User notes are rendered into the handoff body, so they are budgeted
        // with it (v9 §6).
        ...(userNotes ? { userNotes } : {}),
        // Total budget for the whole (possibly chunked) generation, plus the
        // caller's cancellation so a gone client stops the work.
        timeoutMs: HANDOFF_GENERATION_BUDGET_MS,
        signal,
      });
      return {
        content: result.content,
        method: "context-bundle",
        chunks: result.chunks,
        // A bundle whose whole covered history fit verbatim needs no model:
        // there is no checkpoint to attribute, and none was written.
        ...(result.chunks > 0 || result.checkpoint
          ? { model, providerName: provider.name, modelSource }
          : {}),
        coveredRunIds,
        durationMs: Date.now() - startedAt,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } catch (err) {
      const detail = `handoff checkpoint generation failed: ${err instanceof Error ? err.message : String(err)}`;
      // Notes that cannot fit ANY selection are an input/config error, not a
      // provider outage: degrading to a digest would silently ship the
      // overflow the budget exists to prevent. Fail loudly, always (v9 §6).
      if (err instanceof HandoffBudgetExceededError) {
        throw new HandoffUnavailableError("the handoff budget cannot hold the user notes", err.message);
      }
      // A cancelled request must never be turned into a stored handoff: the
      // caller is gone, so there is nobody to accept a degraded context.
      if (signal?.aborted) {
        throw new HandoffUnavailableError("the handoff request was cancelled", detail);
      }
      if (allowDegraded) return heuristic(detail);
      throw new HandoffUnavailableError("the checkpoint generation failed", detail);
    }
  }

  /**
   * The model a continuation will run on, resolved exactly the way
   * `continueTask` resolves it (harness-native targets keep their own account
   * and model — an AgentFabric model never rides along, v6 §3).
   */
  private targetModelIdFor(target: Runtime | undefined, input: ContinueTaskInput): ID | undefined {
    if (!target || this.isHarnessNative(target)) return undefined;
    const profile = input.profileId ? this.profileService().get(input.profileId) : undefined;
    return input.modelId ?? profile?.modelId ?? undefined;
  }

  /**
   * The context window the handoff body is budgeted against: the model that
   * will read it. Resolution order is explicit and never guesses (v9 §5):
   *
   * 1. **explicit target/runtime capability** — `runtime.contextWindow`,
   *    `runtime.capabilities.contextWindow` or `runtime.config.contextWindow`.
   *    This is what lets a harness-native target (Codex, Claude Code, Pi,
   *    OpenCode) declare its real window instead of falling back to 128K.
   * 2. **configured fallback** — the target run's AgentFabric model, else the
   *    task's model, else the model writing the checkpoint. Only configured
   *    values count.
   * 3. **safe default** — `undefined`, which `resolveHandoffBudget` turns into
   *    the documented `DEFAULT_TARGET_CONTEXT_WINDOW`.
   *
   * The returned `source` records which branch won, so the budget diagnostics
   * can state where the target window came from (v10 §23) — a human/audit
   * fact for the Inspector, never part of the receiving model's context.
   *
   * A model name is never consulted and nothing is fetched over the network.
   */
  private handoffTargetContextWindow(
    task: Task,
    target: Runtime | undefined,
    targetModelId: ID | undefined,
    summarizer: Model | undefined
  ): { window?: number; source: HandoffContextWindowSource } {
    const explicit = declaredRuntimeContextWindow(target);
    if (explicit) return { window: explicit, source: "runtime-capability" };
    const configured = (id: ID | undefined): number | undefined => {
      if (!id) return undefined;
      const window = this.modelService().get(id)?.parameters?.contextWindow;
      return typeof window === "number" && window > 0 ? window : undefined;
    };
    // Harness-native targets bring their own account and model — an
    // AgentFabric model never rides along (v6 §3), so nothing is known here.
    if (target && this.isHarnessNative(target)) return { source: "default" };
    // Every value here is a CONFIGURED window; when none is known the caller
    // falls back to the documented default. A model name is never consulted.
    const window = configured(targetModelId) ?? configured(task.modelId) ?? configured(summarizer?.id);
    return window ? { window, source: "configured-model" } : { source: "default" };
  }

  /**
   * Find the newest checkpoint the run chain already carries: the last run
   * *before* the one being handed off whose generated handoff holds a
   * checkpoint. The runs after it are what the next handoff must cover (and
   * carry verbatim where they fit), and its checkpoint feeds the iterative
   * update. A handoff without a checkpoint — a bundle whose whole history fit,
   * a harness handoff, a degraded digest — is not an anchor: those runs are
   * simply re-covered. Returns `fromIndex: 0` when nothing is checkpointed yet.
   */
  private handoffCheckpointAnchor(chain: Run[]): { previousSummary?: string; fromIndex: number } {
    for (let i = chain.length - 2; i >= 0; i--) {
      // The newest handoff generated from that run that carries a
      // checkpoint — looked up, never taken from the run's
      // `generatedHandoffId`, so a discarded record cannot silently drop
      // the anchor and make the next handoff re-cover runs it already has.
      const checkpoint = this.handoffService()
        .list({ runId: chain[i].id })
        .find((h) => h.content.contextBundle?.checkpoint)?.content.contextBundle?.checkpoint;
      if (checkpoint) return { previousSummary: checkpoint, fromIndex: i + 1 };
    }
    return { fromIndex: 0 };
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

    const runtime = run.runtimeId ? this.runtimeService().get(run.runtimeId) : undefined;
    if (!runtime || !runtime.enabled) {
      await this.finish(runId, "failed", `Runtime not found or disabled: ${run.runtimeId ?? "(none)"}`, emptyUsage());
      return;
    }

    const adapter = this.registry.get(runtime.kind);
    if (!adapter) {
      await this.finish(runId, "failed", `No adapter registered for runtime kind "${runtime.kind}"`, emptyUsage());
      return;
    }

    const model = run.modelId ? this.modelService().get(run.modelId) : undefined;
    const provider = model ? this.providerService().get(model.providerId) : undefined;
    // Defensive provider gate: the provider may have been disabled between
    // run creation and execution (v4 §5) — fail now, not inside the harness.
    if (provider && !provider.enabled) {
      const message = `Provider "${provider.name}" is disabled — enable it before running model "${model?.alias ?? model?.name}"`;
      await this.finish(runId, "failed", message, emptyUsage());
      return;
    }
    const workspace = run.workspaceId ? this.workspaceService().get(run.workspaceId) : undefined;

    // Provider API key secret → runtime environment (v4 §2): resolved from
    // the model's provider automatically, so users never re-add the same
    // secret on Task/Runtime. Exported as an env var referenced by the
    // generated harness config — the plaintext never appears in argv.
    let providerApiKey: string | undefined;
    if (provider?.apiKeySecretId) {
      const secret = this.secretService().getWithValue(provider.apiKeySecretId);
      if (!secret || secret.value === undefined) {
        const message = `Provider "${provider.name}" API key secret is missing (secret ${provider.apiKeySecretId}) — re-save the provider's API key`;
        await this.finish(runId, "failed", message, emptyUsage());
        return;
      }
      providerApiKey = secret.value;
    }

    // Run-level overrides (set at continuation time) take precedence
    // over the task's defaults. The Proxy page env (when enabled) is the
    // lowest layer — explicit task/run env wins — and is resolved at
    // spawn time: toggling affects subsequent runs, never live ones.
    const mergedEnv: Record<string, string> = {
      ...buildProxyEnv(this.store.config().proxy, Boolean(runtime.containerized)),
      ...(task.env ?? {}),
      ...(run.env ?? {}),
    };
    const mergedSecretIds = [...new Set([...(task.secretIds ?? []), ...(run.secretIds ?? [])])];
    const secrets = this.secretService().resolve(mergedSecretIds);
    const lifecycle = normalizeLifecycle(run.lifecycle ?? resolveLifecycle(runtime));
    const continuity: RunContinuity = run.continuity ?? "new";
    const runtimeSession = run.runtimeSessionRefId ? this.runtimeSessionService().get(run.runtimeSessionRefId) : undefined;
    const previousHandoff = run.previousHandoffId ? this.handoffService().get(run.previousHandoffId) : undefined;
    const caps = effectiveCapabilities(adapter, runtime);

    // The single resolved configuration every executor consumes (v4 §13):
    // runtime defaults < agent profile < task < run continuation override.
    const profile = run.profileId ? this.profileService().get(run.profileId) : undefined;
    const resolved: ResolvedRunConfig = resolveRunConfig({
      task,
      run,
      profile,
      runtime: {
        networkPolicy: runtime.networkPolicy,
        filesystemPolicy: runtime.filesystemPolicy,
        resourceLimits: runtime.resourceLimits,
      },
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    });

    // Containerized harness runs attach the runtime's opaque native-state
    // directory so the harness's own session store survives container
    // destruction (v2 §12–§15). Resuming reattaches the exact state the
    // resumable reference was created with.
    let nativeState: RuntimeNativeState | undefined;
    let nativeStateReattached = false;
    if (runtime.containerized && caps.supportsNativeSession) {
      const mountPath = String(
        runtime.config?.nativeStateMountPath ?? adapter.nativeStateMountPath ?? "/root/.agentfabric-state"
      );
      nativeState =
        (runtimeSession?.nativeStateId ? this.nativeStateService().get(runtimeSession.nativeStateId) : undefined) ??
        (await this.nativeStateService().ensureForRuntime(runtime, mountPath));
      nativeStateReattached = Boolean(runtimeSession?.nativeStateId);
      await this.store.update<Run>("runs", runId, { nativeStateId: nativeState.id, updatedAt: now() });
    }

    // Keep-alive: reuse a retained container instead of a fresh one. The
    // lease is scoped to the same logical execution context — runtime +
    // workspace + *task* — so one task's harness state is never silently
    // inherited by an unrelated task (v4 §21/§22).
    let reusableContainer: ReusableContainer | undefined;
    if (lifecycle.mode === "keep-alive") {
      const lease = this.leaseManager.acquire(runtime.id, workspace?.id, task.id);
      if (lease) reusableContainer = { containerId: lease.containerId, name: lease.containerName };
    }

    // Abort controller for cancel/timeout.
    const controller = new AbortController();
    const abortState: { reason: "cancel" | "timeout" | "policy"; policyMessage?: string } = { reason: "cancel" };
    const timeoutMs = resolved.timeoutMs;
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

    // Start. Everything below is guarded: an unexpected error must never
    // leave the run stuck in "running" nor leak the timeout timer.
    const usageAcc = emptyUsage();
    try {
      run = await this.store.update<Run>("runs", runId, {
        status: "starting",
        startTime: now(),
        updatedAt: now(),
      });
      if (!run) return; // record vanished mid-flight; nothing to execute

      const ctx: RuntimeContext = this.buildContext({
        run,
        task,
        runtime,
        model,
        provider,
        providerModels: provider
          ? this.modelService().list().filter((m) => m.providerId === provider.id && m.enabled)
          : undefined,
        workspace,
        secrets,
        env: mergedEnv,
        resolved,
        providerApiKey,
        lifecycle,
        continuity,
        runtimeSession,
        previousHandoff,
        reusableContainer,
        nativeState,
        signal: controller.signal,
        usageAcc,
        abortForPolicy,
      });

      await ctx.emit("run.started", {
        runId,
        taskId: task.id,
        title: task.title,
        runtime: runtime.name,
        model: model?.alias ?? model?.name,
        provider: provider?.name,
        workspace: workspace?.name,
        timeoutMs,
        lifecycle: lifecycle.mode,
        continuity,
        resumedSession: continuity === "resume" ? runtimeSession?.nativeSessionRef : undefined,
        handoffId: previousHandoff?.id,
      });
      // Provider compatibility is explicit, never silent (v4 §4): if the
      // harness cannot consume AgentFabric provider configuration, say so
      // instead of letting it fall back to hidden local credentials.
      if (provider && !adapter.providerCompatibility) {
        await ctx.emit(
          "log",
          {
            line: `${runtime.name} (${runtime.kind}) does not consume AgentFabric provider configuration — provider "${provider.name}" settings (base URL / API key / headers) will not reach this harness`,
            kind: "config-warning",
            scope: "provider-compatibility",
            provider: provider.name,
          },
          { level: "warn", source: runtime.kind }
        );
      }
      if (workspace) {
        await ctx.emit("workspace.attached", {
          workspaceId: workspace.id,
          name: workspace.name,
          path: workspace.path,
          mountPath: workspace.mountPath,
          source: workspace.source ?? "create",
        });
      }
      if (nativeState) {
        await ctx.emit("native.state.attached", {
          nativeStateId: nativeState.id,
          mountPath: nativeState.mountPath,
          runtimeId: runtime.id,
          runtimeKind: runtime.kind,
          reattached: nativeStateReattached,
        });
      }
      if (reusableContainer) {
        await ctx.emit("container.reused", {
          containerId: reusableContainer.containerId,
          runtimeId: runtime.id,
          lifecycle: lifecycle.mode,
        });
      }

      run = (await this.store.update<Run>("runs", runId, { status: "running", updatedAt: now() })) ?? run;

      let result: RuntimeResult;
      try {
        result = await adapter.run(ctx);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      clearTimeout(timer);
      if (lifecycle.mode === "keep-alive" && result.containerId) {
        // Keep-alive containers are owned by the lease manager, not the
        // adapter's cleanup path.
      } else {
        try {
          await adapter.cleanup?.(ctx);
        } catch {
          /* best effort */
        }
      }
      this.controllers.delete(runId);

      if (result.containerId) {
        await this.store.update<Run>("runs", runId, { containerId: result.containerId, updatedAt: now() });
      }

      // Post-run pipeline: workspace save, session reference, harness
      // handoff, container retention (spec v1 §11/§3/§7/§1).
      await this.afterRun(ctx, result, lifecycle, controller.signal.aborted);

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
        await ctx.emit("run.failed", { error: result.error, errorKind: result.errorKind });
        await this.finish(runId, "failed", result.error, addUsage(usageAcc, result.usage), result.errorKind);
      } else {
        await ctx.emit("run.completed", { exitCode: result.exitCode });
        await this.finish(runId, "completed", undefined, addUsage(usageAcc, result.usage));
      }
    } catch (err) {
      // Safety net: fail the run instead of leaving it running forever
      // and release the timeout timer (spec v1 §2: runs are records, not
      // container state — a crashed execution must stay inspectable).
      clearTimeout(timer);
      this.controllers.delete(runId);
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.finish(runId, "failed", `Internal error: ${message}`, usageAcc);
      } catch {
        /* run record may be gone; nothing else to do */
      }
    }
  }

  /**
   * Runs after the adapter returns, before the run is marked finished:
   * 1. Save the workspace so container destruction can never lose work.
   * 2. Persist the harness-native session reference (verbatim).
   * 3. Store a harness-generated handoff when the harness produced one.
   * 4. Apply the container lifecycle policy (keep-alive retention).
   *
   * An *aborted* keep-alive run (cancel/timeout/policy) never retains its
   * container: the in-container harness process was killed and its state
   * is uncertain, so the container is destroyed instead of being marked
   * reusable (v4 §23/§24).
   */
  private async afterRun(ctx: RuntimeContext, result: RuntimeResult, lifecycle: RuntimeLifecycle, aborted: boolean): Promise<void> {
    const caps = effectiveCapabilities(this.registry.get(ctx.runtime.kind), ctx.runtime);

    // 1. Workspace save.
    try {
      const saved = await ctx.saveWorkspace();
      if (saved) {
        await ctx.emit("workspace.saved", {
          workspaceId: saved.id,
          name: saved.name,
          path: saved.path,
          lastSavedAt: saved.lastSavedAt,
        });
      }
    } catch (err) {
      await ctx.log(`Workspace save failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }

    // 2. Runtime-native session reference.
    if (result.nativeSessionRef) {
      const previousRefId = ctx.run.runtimeSessionRefId;
      const ref = await this.runtimeSessionService().register({
        runtimeId: ctx.runtime.id,
        runtimeKind: ctx.runtime.kind,
        runtimeName: ctx.runtime.name,
        runtimeVersion: result.runtimeVersion,
        nativeSessionRef: result.nativeSessionRef,
        resumeSupported: caps.supportsNativeResume,
        taskId: ctx.task.id,
        runId: ctx.run.id,
        workspaceId: ctx.workspace?.id,
        nativeStateId: ctx.nativeState?.id,
        executionBackend: ctx.runtime.containerized ? "docker" : "local",
        metadata: result.nativeSessionMetadata,
      });
      await this.store.update<Run>("runs", ctx.run.id, { runtimeSessionRefId: ref.id, updatedAt: now() });
      await ctx.emit(ctx.continuity === "resume" ? "runtime.session.resumed" : "runtime.session.created", {
        runtimeSessionRefId: ref.id,
        nativeSessionRef: ref.nativeSessionRef,
        runtimeKind: ref.runtimeKind,
        previousRefId,
        resumeSupported: ref.resumeSupported,
        nativeStateId: ref.nativeStateId,
        executionBackend: ref.executionBackend,
      });
    }

    // 2b. Native state preservation: the host-mounted directory already
    // persisted everything the harness wrote during the run; record the
    // usage so the next run reattaches this exact state (v2 §15).
    if (ctx.nativeState) {
      await this.nativeStateService().markUsed(ctx.nativeState.id, ctx.run.id);
      await ctx.emit("native.state.persisted", {
        nativeStateId: ctx.nativeState.id,
        runtimeId: ctx.runtime.id,
        runtimeKind: ctx.runtime.kind,
        lastUsedRunId: ctx.run.id,
      });
    }

    // 3. Harness-generated handoff.
    if (result.handoffContent && caps.supportsHandoffGeneration) {
      const handoff = await this.handoffService().create({
        taskId: ctx.task.id,
        fromRunId: ctx.run.id,
        fromRuntimeId: ctx.runtime.id,
        fromRuntimeName: ctx.runtime.name,
        fromRuntimeKind: ctx.runtime.kind,
        source: "harness",
        // No model of ours produced this, so there is no summarization to
        // audit: only who produced it.
        generation: { method: "harness", trigger: "harness" },
        content: result.handoffContent,
        workspaceId: ctx.workspace?.id,
        artifactIds: ctx.run.artifactIds,
      });
      await this.store.update<Run>("runs", ctx.run.id, { generatedHandoffId: handoff.id, updatedAt: now() });
      await ctx.emit("handoff.generated", {
        handoffId: handoff.id,
        source: "harness",
        method: "harness",
        trigger: "harness",
        readyForNextAgent: true,
      });
    }

    // 4. Container lifecycle policy.
    const containerId = result.containerId;
    if (lifecycle.mode === "keep-alive" && containerId) {
      if (aborted) {
        // Correctness over reuse (v4 §24): destroy the container whose
        // harness process was just killed mid-flight — it must never be
        // handed to a follow-up run as safely reusable state.
        await this.containerOps.destroy(containerId);
        await ctx.emit("container.destroyed", {
          containerId,
          runtimeId: ctx.runtime.id,
          reason: "aborted-run",
        });
      } else {
        const lease = await this.leaseManager.retain({
          containerId,
          containerName: `af-keep-${ctx.runtime.id}-${ctx.task.id}`,
          runtimeId: ctx.runtime.id,
          runtimeKind: ctx.runtime.kind,
          workspaceId: ctx.workspace?.id,
          taskId: ctx.task.id,
          runId: ctx.run.id,
          idleTimeoutMs: lifecycle.idleTimeoutMs ?? DEFAULT_KEEP_ALIVE_IDLE_MS,
        });
        await ctx.emit("container.retained", {
          containerId,
          runtimeId: ctx.runtime.id,
          taskId: ctx.task.id,
          expiresAt: lease.expiresAt,
          idleTimeoutMs: lease.idleTimeoutMs,
        });
      }
    } else if (lifecycle.mode === "ephemeral" && containerId) {
      await ctx.emit("container.destroyed", { containerId, reason: "ephemeral-lifecycle" });
    }
    // persistent: intentionally kept; no destroy, no expiry.
  }

  private buildContext(opts: {
    run: Run;
    task: Task;
    runtime: Runtime;
    model?: Model;
    provider?: Provider;
    providerModels?: Model[];
    workspace?: Workspace;
    secrets: Secret[];
    env: Record<string, string>;
    resolved: ResolvedRunConfig;
    providerApiKey?: string;
    lifecycle: RuntimeLifecycle;
    continuity: RunContinuity;
    runtimeSession?: RuntimeSessionRef;
    previousHandoff?: Handoff;
    reusableContainer?: ReusableContainer;
    nativeState?: RuntimeNativeState;
    signal: AbortSignal;
    usageAcc: Usage;
    abortForPolicy: (message: string) => void;
  }): RuntimeContext {
    const { run, task, runtime, model, provider, providerModels, workspace, secrets, signal, usageAcc } = opts;
    const resolved = opts.resolved;
    const store = this.store;
    const bus = this.bus;
    const artifactService = this.artifactService();
    const workspaceService = this.workspaceService();

    const env: Record<string, string> = {
      ...opts.env,
      ...(runtime.env ?? {}),
      ...Object.fromEntries(secrets.map((s) => [s.name, s.value ?? ""])),
      ...(opts.providerApiKey !== undefined ? { AGENTFABRIC_PROVIDER_API_KEY: opts.providerApiKey } : {}),
      AGENTFABRIC_RUN_ID: run.id,
      AGENTFABRIC_TASK_ID: task.id,
      AGENTFABRIC_WORKSPACE_ID: workspace?.id ?? "",
      AGENTFABRIC_CONTINUITY: opts.continuity,
      AGENTFABRIC_LIFECYCLE: opts.lifecycle.mode,
      AGENTFABRIC_MODEL: model?.name ?? "",
      AGENTFABRIC_PROVIDER: provider?.name ?? "",
    };

    const emit = async (
      type: EventType,
      data: Record<string, unknown> = {},
      eventOpts?: { level?: LogLevel; source?: string }
    ): Promise<void> => {
      const event: RunEvent = {
        id: newId("evt"),
        runId: run.id,
        seq: store.nextSeq(),
        type,
        timestamp: now(),
        data,
        level: eventOpts?.level,
        source: eventOpts?.source ?? "core",
      };
      await store.appendEvent(event);
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
      providerModels,
      workspace,
      secrets,
      env,
      policy: resolved.policy,
      resourceLimits: resolved.resourceLimits,
      systemInstructions: resolved.systemInstructions,
      dataDir: store.dataDir,
      providerApiKey: opts.providerApiKey,
      signal,
      lifecycle: opts.lifecycle,
      continuity: opts.continuity,
      runtimeSession: opts.runtimeSession,
      previousHandoff: opts.previousHandoff,
      reusableContainer: opts.reusableContainer,
      nativeState: opts.nativeState,
      workspacePath: workspace?.path,
      emit,
      log: async (line, level = "info") => {
        await emit("log", { line }, { level, source: runtime.kind });
      },
      recordUsage: (u) => {
        // Harness-reported cost is authoritative; only estimate when the
        // harness did not report one (addUsage merges u into the
        // accumulator, so estimating here must not add cost twice).
        const withCost =
          u.estimatedCost === undefined && model
            ? { ...u, estimatedCost: estimateCost(model.name, u.inputTokens, u.outputTokens, u.cachedTokens ?? 0) }
            : u;
        Object.assign(usageAcc, addUsage(usageAcc, withCost));
        enforcePolicyLimits(resolved.policy, usageAcc, opts.abortForPolicy);
      },
      addArtifact: async (draft: ArtifactDraft): Promise<Artifact> => {
        const artifact = await artifactService.create({ runId: run.id, ...draft });
        await emit("artifact.created", { artifactId: artifact.id, name: artifact.name, kind: artifact.kind });
        return artifact;
      },
      saveWorkspace: async (): Promise<Workspace | undefined> => {
        if (!workspace) return undefined;
        return workspaceService.save(workspace.id, run.id);
      },
    };
  }

  private async finish(
    runId: string,
    status: Run["status"],
    error: string | undefined,
    usage: Usage,
    errorKind?: "usage-limit"
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
      errorKind,
      usage,
      cost,
      endTime,
      updatedAt: endTime,
    });
  }
}
