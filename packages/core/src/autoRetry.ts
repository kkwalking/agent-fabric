/**
 * Automatic retry of transient failures (the policy layer).
 *
 * The three manual Retry operations (v11 §31) already exist and are correct:
 * `retryRun` continues on the same workspace, `retryValidation` re-runs only
 * the checks, `retryPublish` re-pushes the frozen revision. What was missing
 * was anything that *decides* to use them: a Task that failed because docker
 * hiccuped sat there until a human noticed.
 *
 * This module is that decision, as pure functions:
 *
 *   - `isTransientErrorCode` (errors.ts) is the only "is it retryable" oracle;
 *   - `planAutoRetry` maps a settled Task to the exact retry kind it permits,
 *     honoring the budget (`maxAttempts` per failure episode), the user's
 *     switch, and cancellation;
 *   - `autoRetryDelayMs` is the exponential backoff between attempts.
 *
 * The supervisor consumes the decision; it never re-derives it.
 */
import { isTransientErrorCode, retryKindForFailure, type RetryKind } from "./errors.js";
import type { AutoRetryConfig, Task } from "./types.js";

/** Defaults: one automatic retry, 30s backoff doubling to a 5min cap. */
export const DEFAULT_AUTO_RETRY = {
  enabled: true,
  maxAttempts: 2,
  baseDelayMs: 30_000,
  maxDelayMs: 300_000,
} as const;

/** The config with defaults applied and hostile values clamped. */
export interface ResolvedAutoRetryConfig {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export function resolveAutoRetryConfig(config?: AutoRetryConfig): ResolvedAutoRetryConfig {
  /** A finite, non-negative number; anything else falls back. */
  const nonNegative = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const maxDelayMs = nonNegative(config?.maxDelayMs, DEFAULT_AUTO_RETRY.maxDelayMs);
  // `maxAttempts: 1` means "no automatic retry" and is legal; anything below
  // one would mean "never run at all", so every value below one clamps to one
  // — a broken budget must not grant retries, and must not grant more than a
  // deliberate `0` did.
  const rawAttempts = config?.maxAttempts;
  const maxAttempts =
    typeof rawAttempts === "number" && Number.isFinite(rawAttempts)
      ? Math.max(1, Math.floor(rawAttempts))
      : DEFAULT_AUTO_RETRY.maxAttempts;
  return {
    enabled: config?.enabled ?? DEFAULT_AUTO_RETRY.enabled,
    maxAttempts,
    baseDelayMs: Math.min(nonNegative(config?.baseDelayMs, DEFAULT_AUTO_RETRY.baseDelayMs), maxDelayMs),
    maxDelayMs,
  };
}

/** Exponential backoff, capped. `attempt` is 1-based (the first retry). */
export function autoRetryDelayMs(attempt: number, config: ResolvedAutoRetryConfig): number {
  return Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** (attempt - 1));
}

export type AutoRetrySkipReason = "budget-exhausted";

export type AutoRetryDecision =
  | {
      action: "retry";
      kind: Exclude<RetryKind, "none">;
      /** 1-based number of this automatic retry (1 = the first retry). */
      attempt: number;
      delayMs: number;
      code: string;
      stage: string;
    }
  | {
      action: "skip";
      reason: AutoRetrySkipReason;
      code: string;
      stage: string;
    };

export interface PlanAutoRetryInput {
  task: Task;
  config?: AutoRetryConfig;
  /** The user cancelled this task (or is cancelling it right now). */
  cancelled: boolean;
}

/**
 * Decides what should happen to a Task that just settled in failure.
 *
 * Returns `undefined` when automatic retry does not apply at all — the task
 * completed, was cancelled, the failure is permanent, or the feature is off.
 * The caller then treats the failure as final (notification included). A
 * `skip` decision is different: the failure *would* have been retried but the
 * budget is spent — worth a visible event, never a silent drop (「失败要响」).
 */
export function planAutoRetry(input: PlanAutoRetryInput): AutoRetryDecision | undefined {
  const { task, cancelled } = input;
  const execution = task.execution;
  const failure = execution?.failure;
  if (!execution || !failure) return undefined;
  // A cancellation is a user decision; a retry would resurrect work they
  // stopped (v11 §32). This includes a cancel that landed mid-validation and
  // settled the stage as a runtime failure.
  if (cancelled || execution.status === "cancelled" || failure.code === "agent-cancelled") return undefined;
  const config = resolveAutoRetryConfig(input.config);
  if (!config.enabled) return undefined;
  if (!isTransientErrorCode(failure.code)) return undefined;
  let kind: RetryKind = retryKindForFailure(failure.stage);
  // A network failure during the push is classified by its code
  // (`source-network-failed` → stage "source" → "retry the agent"), but the
  // agent already finished and the revision is frozen: re-pushing the frozen
  // SHA is both the honest and the cheap recovery. The publish record being
  // "failed" is what proves the failure came from the publish attempt — a
  // genuine source failure on a re-run leaves it "pending" (retryRun resets
  // it before the new lifecycle starts).
  if (kind === "agent" && execution.publish?.status === "failed" && execution.frozenRevision?.finalCommitSha) {
    kind = "publish";
  }
  if (kind === "none") return undefined;

  const spent = execution.autoRetry?.attempts ?? 0;
  if (1 + spent >= config.maxAttempts) {
    return { action: "skip", reason: "budget-exhausted", code: failure.code, stage: failure.stage };
  }
  return {
    action: "retry",
    kind,
    attempt: spent + 1,
    delayMs: autoRetryDelayMs(spent + 1, config),
    code: failure.code,
    stage: failure.stage,
  };
}
