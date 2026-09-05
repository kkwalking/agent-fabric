/**
 * Resolved run configuration (v4 §13–§19).
 *
 * A Run's effective limits may come from four places, which must merge in
 * one place with one precedence:
 *
 *   runtime defaults  <  agent profile  <  task  <  run continuation override
 *
 * The orchestrator computes a single `ResolvedRunConfig` before the run
 * starts; every execution layer (docker backend, harness adapters, policy
 * budget enforcement) consumes *only* that resolved result — never the raw
 * task/profile/runtime fields, and never runtime-specific bypasses.
 */
import type {
  AgentProfile,
  ExecutionPolicy,
  FilesystemPolicy,
  NetworkPolicy,
  ResourceLimits,
  Run,
  Task,
} from "./types.js";

/** Safety net when nothing configured a timeout (see orchestrator). */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Merge one optional field: the highest-precedence source that explicitly
 * defines it wins. `undefined` means "not configured here" — it never
 * overrides a lower source.
 */
function pick<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) {
    if (v !== undefined) return v;
  }
  return undefined;
}

function mergeNetwork(
  run?: ExecutionPolicy,
  task?: ExecutionPolicy,
  profile?: ExecutionPolicy,
  runtimeNetwork?: NetworkPolicy
): NetworkPolicy | undefined {
  return pick(run?.network, task?.network, profile?.network, runtimeNetwork);
}

/**
 * The final, unified execution policy for one Run (v4 §13). Produced once
 * by `resolveRunConfig`; all executors read this object only.
 */
export interface ResolvedExecutionPolicy extends ExecutionPolicy {
  /** Effective shell policy (explicit default: allow). */
  shell: "allow" | "deny" | "ask";
}

/** Fully resolved per-run configuration consumed by executors. */
export interface ResolvedRunConfig {
  policy: ResolvedExecutionPolicy;
  /** CPU / memory / pids limits from the resolved configuration. */
  resourceLimits: ResourceLimits;
  /** Effective timeout (run > task > policy.maxDurationMs > default). */
  timeoutMs: number;
  /** System instructions from the agent profile (may be absent). */
  systemInstructions?: string;
  /** Effective tool allowlist (profile tools ∪ task tools ∪ policy). */
  toolPermissions?: string[];
}

export interface ResolveRunConfigInput {
  task: Task;
  run: Pick<Run, "policy" | "timeoutMs" | "env" | "secretIds" | "tools" | "systemInstructions">;
  /** Live agent profile record when the task/run references one. */
  profile?: AgentProfile;
  /** Runtime defaults (network/filesystem/resource limits). */
  runtime?: {
    networkPolicy?: NetworkPolicy;
    filesystemPolicy?: FilesystemPolicy;
    resourceLimits?: ResourceLimits;
  };
  defaultTimeoutMs?: number;
}

/**
 * Computes the single resolved configuration for a Run (v4 §14).
 *
 * Precedence (low → high):
 * 1. runtime defaults — `runtime.networkPolicy/filesystemPolicy` become
 *    the policy's `network/filesystem` defaults; `runtime.resourceLimits`
 *    the default CPU/memory;
 * 2. agent profile — `profile.policy` and `profile.resourceLimits`;
 * 3. task — `task.policy`, `task.resourceLimits`, `task.timeoutMs`;
 * 4. run continuation override — `run.policy`, `run.timeoutMs`.
 *
 * Tools merge as a union (v4 §11): profile tools + task/run tools + any
 * policy toolPermissions form the effective allowlist.
 */
export function resolveRunConfig(input: ResolveRunConfigInput): ResolvedRunConfig {
  const { task, run, profile, runtime } = input;
  const pRun = run.policy;
  const pTask = task.policy;
  const pProfile = profile?.policy;

  const network = mergeNetwork(pRun, pTask, pProfile, runtime?.networkPolicy);
  const filesystem = pick(pRun?.filesystem, pTask?.filesystem, pProfile?.filesystem, runtime?.filesystemPolicy);

  const policy: ResolvedExecutionPolicy = {
    maxDurationMs: pick(pRun?.maxDurationMs, pTask?.maxDurationMs, pProfile?.maxDurationMs),
    maxModelCalls: pick(pRun?.maxModelCalls, pTask?.maxModelCalls, pProfile?.maxModelCalls),
    maxTokens: pick(pRun?.maxTokens, pTask?.maxTokens, pProfile?.maxTokens),
    maxCost: pick(pRun?.maxCost, pTask?.maxCost, pProfile?.maxCost),
    cpu: pick(pRun?.cpu, pTask?.cpu, pProfile?.cpu),
    memory: pick(pRun?.memory, pTask?.memory, pProfile?.memory),
    network,
    filesystem,
    shell: pick(pRun?.shell, pTask?.shell, pProfile?.shell) ?? "allow",
    toolPermissions: pick(pRun?.toolPermissions, pTask?.toolPermissions, pProfile?.toolPermissions),
    autoApprove: pick(pRun?.autoApprove, pTask?.autoApprove, pProfile?.autoApprove),
  };

  // Resource limits: policy cpu/memory win over explicit resourceLimit
  // records; within records the higher-precedence source wins per field.
  const resourceLimits: ResourceLimits = {
    ...(runtime?.resourceLimits ?? {}),
    ...(profile?.resourceLimits ?? {}),
    ...(task.resourceLimits ?? {}),
  };
  if (policy.cpu !== undefined) resourceLimits.cpu = policy.cpu;
  if (policy.memory !== undefined) resourceLimits.memory = policy.memory;

  const timeoutMs =
    run.timeoutMs ??
    task.timeoutMs ??
    policy.maxDurationMs ??
    input.defaultTimeoutMs ??
    DEFAULT_RUN_TIMEOUT_MS;

  // Tool allowlist is a union across every source (v4 §11); an explicit
  // policy toolPermissions list is the authoritative base.
  const tools = [
    ...(policy.toolPermissions ?? []),
    ...(profile?.tools ?? []),
    ...(task.tools ?? []),
    ...(run.tools ?? []),
  ];
  const toolPermissions = tools.length ? [...new Set(tools)] : undefined;
  if (toolPermissions) policy.toolPermissions = toolPermissions;

  const config: ResolvedRunConfig = {
    policy,
    resourceLimits,
    timeoutMs,
    // The snapshot taken when the run was created wins (a profile edited
    // mid-flight must not silently change an already-submitted run).
    systemInstructions: run.systemInstructions ?? profile?.systemInstructions,
    toolPermissions,
  };
  return config;
}
