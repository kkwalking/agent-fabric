/**
 * The automatic-retry policy: classification, budget and backoff.
 *
 * These are the pure decisions the supervisor consumes — the wiring is
 * covered end-to-end by `v11.retry.test.ts`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isTransientErrorCode } from "./errors.js";
import {
  DEFAULT_AUTO_RETRY,
  autoRetryDelayMs,
  planAutoRetry,
  resolveAutoRetryConfig,
} from "./autoRetry.js";
import type { Task, TaskExecution } from "./types.js";

function taskWith(execution: Partial<TaskExecution>): Task {
  return {
    id: "task_x",
    title: "t",
    prompt: "p",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    execution: {
      phase: "failed",
      status: "failed",
      failure: { stage: "publish", code: "git-push-failed", message: "boom", at: "2026-01-01T00:00:00.000Z" },
      ...execution,
    },
  } as Task;
}

describe("autoRetry: transient classification", () => {
  test("infrastructure codes are transient", () => {
    for (const code of [
      "source-network-failed",
      "validation-runtime-failed",
      "validation-runtime-unavailable",
      "git-push-failed",
    ]) {
      assert.equal(isTransientErrorCode(code), true, code);
    }
  });

  test("the work itself failing is never transient", () => {
    for (const code of [
      "agent-failed",
      "agent-timeout",
      "agent-cancelled",
      "agent-start-failed",
      "validation-failed",
      "validation-timeout",
      "git-push-auth-failed",
      "git-push-rejected",
      "remote-branch-conflict",
      "source-auth-failed",
      "source-not-found",
      "base-ref-not-found",
      "branch-conflict",
      "runtime-create-failed",
      "runtime-start-failed",
      "runtime-lost",
      "runtime-timeout",
      "policy-denied",
      "workspace-diverged-after-finalization",
      "internal-error",
    ]) {
      assert.equal(isTransientErrorCode(code), false, code);
    }
  });
});

describe("autoRetry: configuration", () => {
  test("defaults: enabled, one retry, 30s doubling to a 5min cap", () => {
    const config = resolveAutoRetryConfig(undefined);
    assert.deepEqual(config, { ...DEFAULT_AUTO_RETRY });
  });

  test("explicit values win; hostile values are clamped, not obeyed", () => {
    assert.equal(resolveAutoRetryConfig({ enabled: false }).enabled, false);
    assert.equal(resolveAutoRetryConfig({ maxAttempts: 4 }).maxAttempts, 4);
    assert.equal(resolveAutoRetryConfig({ maxAttempts: 0 }).maxAttempts, 1);
    assert.equal(resolveAutoRetryConfig({ maxAttempts: -3 }).maxAttempts, 1);
    assert.equal(resolveAutoRetryConfig({ baseDelayMs: -1 }).baseDelayMs, DEFAULT_AUTO_RETRY.baseDelayMs);
    // A base above the cap would make the first wait exceed it; the cap wins.
    assert.equal(resolveAutoRetryConfig({ baseDelayMs: 999_999, maxDelayMs: 1000 }).baseDelayMs, 1000);
  });

  test("backoff doubles per attempt and stops at the cap", () => {
    const config = resolveAutoRetryConfig({ baseDelayMs: 1000, maxDelayMs: 5000 });
    assert.equal(autoRetryDelayMs(1, config), 1000);
    assert.equal(autoRetryDelayMs(2, config), 2000);
    assert.equal(autoRetryDelayMs(3, config), 4000);
    assert.equal(autoRetryDelayMs(4, config), 5000);
    assert.equal(autoRetryDelayMs(9, config), 5000);
  });
});

describe("autoRetry: the decision", () => {
  test("a transient failure with budget left schedules the stage's own retry", () => {
    const decision = planAutoRetry({ task: taskWith({}), cancelled: false });
    assert.deepEqual(decision, {
      action: "retry",
      kind: "publish",
      attempt: 1,
      delayMs: DEFAULT_AUTO_RETRY.baseDelayMs,
      code: "git-push-failed",
      stage: "publish",
    });
  });

  test("each stage maps to its own retry kind — never a generic retry task", () => {
    const kindOf = (stage: TaskExecution["failure"] extends infer F ? F extends { stage: infer S } ? S : never : never, code: string) =>
      planAutoRetry({
        task: taskWith({ failure: { stage, code, message: "x", at: "2026-01-01T00:00:00.000Z" } }),
        cancelled: false,
      });
    assert.equal(kindOf("source", "source-network-failed")?.action === "retry" && (kindOf("source", "source-network-failed") as { kind: string }).kind, "agent");
    assert.equal(kindOf("validation", "validation-runtime-failed")?.action === "retry" && (kindOf("validation", "validation-runtime-failed") as { kind: string }).kind, "validation");
    assert.equal(kindOf("publish", "git-push-failed")?.action === "retry" && (kindOf("publish", "git-push-failed") as { kind: string }).kind, "publish");
  });

  test("a permanent failure is not retried, whatever the stage permits", () => {
    assert.equal(planAutoRetry({ task: taskWith({}), cancelled: false }) !== undefined, true);
    const permanent = taskWith({
      failure: { stage: "publish", code: "git-push-auth-failed", message: "nope", at: "2026-01-01T00:00:00.000Z" },
    });
    assert.equal(planAutoRetry({ task: permanent, cancelled: false }), undefined);
    const agentFailed = taskWith({
      failure: { stage: "agent", code: "agent-failed", message: "gave up", at: "2026-01-01T00:00:00.000Z" },
    });
    assert.equal(planAutoRetry({ task: agentFailed, cancelled: false }), undefined);
  });

  test("a cancelled task is never retried", () => {
    assert.equal(planAutoRetry({ task: taskWith({}), cancelled: true }), undefined);
    const cancelledTask = taskWith({
      status: "cancelled",
      failure: { stage: "agent", code: "agent-cancelled", message: "user", at: "2026-01-01T00:00:00.000Z" },
    });
    assert.equal(planAutoRetry({ task: cancelledTask, cancelled: false }), undefined);
  });

  test("a disabled switch or a completed task decides nothing", () => {
    assert.equal(planAutoRetry({ task: taskWith({}), cancelled: false, config: { enabled: false } }), undefined);
    assert.equal(
      planAutoRetry({ task: taskWith({ status: "completed", failure: undefined }), cancelled: false }),
      undefined
    );
  });

  test("the budget spans one failure episode and then skips visibly", () => {
    const spentOnce = taskWith({ autoRetry: { attempts: 1, code: "git-push-failed", at: "2026-01-01T00:00:00.000Z" } });
    assert.deepEqual(planAutoRetry({ task: spentOnce, cancelled: false }), {
      action: "skip",
      reason: "budget-exhausted",
      code: "git-push-failed",
      stage: "publish",
    });
    // A larger budget makes the same record retryable again.
    const decision = planAutoRetry({ task: spentOnce, cancelled: false, config: { maxAttempts: 3 } });
    assert.equal(decision?.action, "retry");
    assert.equal((decision as { attempt: number }).attempt, 2);
  });
});
