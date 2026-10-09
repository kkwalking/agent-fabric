/**
 * Outbound task notifications (webhook).
 *
 * Pure unit tests: the network seam (`NotificationFetch`) and the backoff
 * sleep are both injected, so nothing here opens a socket and nothing waits
 * on a real timeout. The injected `sleep` is a recorder, which is also how
 * "did it retry at all, and how many times" becomes an assertion instead of
 * a timing observation.
 *
 * The cases that carry the design decisions:
 *
 * - a Task that completed agent work but failed to publish notifies
 *   `task.failed` with the publish code — `agent.completed` is not terminal;
 * - a non-retryable 4xx stops immediately (one request, not three);
 * - a URL that embeds a token never appears in a result or an error message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INSTRUCTION_MAX_CHARS,
  DEFAULT_NOTIFICATION_MAX_ATTEMPTS,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  NotificationError,
  buildTaskNotificationPayload,
  deliverNotification,
  deliverTaskNotification,
  notificationEventFor,
  planNotification,
  redactWebhookUrl,
  truncateInstruction,
  type NotificationConfig,
  type NotificationFetch,
  type NotificationFetchInit,
  type NotificationRequest,
  type NotificationResponse,
} from "./notifications.js";
import type { Run, Task } from "./types.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** A webhook-shaped URL: the path IS the token; `.invalid` is reserved (RFC 2606). */
const WEBHOOK_URL = "https://webhook.invalid/hooks/team-channel/supersecretpath";
const WEBHOOK_PATH_TOKEN = "supersecretpath";

const LIFECYCLE = { mode: "ephemeral" } as const;

function makeTask(patch: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Add retry to the publish step",
    prompt: "Make the publish step retry transient git push failures.",
    lifecycle: LIFECYCLE,
    projectId: "proj-1",
    workingBranch: "agentfabric/task-1",
    baseRef: "main",
    createdAt: "2026-10-08T10:00:00.000Z",
    execution: {
      phase: "completed",
      status: "completed",
      updatedAt: "2026-10-08T10:20:00.000Z",
      agent: {
        status: "completed",
        runId: "run-1",
        attempts: 1,
        startedAt: "2026-10-08T10:10:00.000Z",
        endedAt: "2026-10-08T10:10:00.000Z",
      },
      stages: {
        agent: { status: "completed", at: "2026-10-08T10:10:00.000Z" },
        validation: { status: "completed", at: "2026-10-08T10:15:00.000Z" },
        finalization: { status: "completed", at: "2026-10-08T10:18:00.000Z", commitSha: "f".repeat(40) },
        publish: { status: "completed", at: "2026-10-08T10:20:00.000Z", commitSha: "f".repeat(40) },
      },
      frozenRevision: {
        finalCommitSha: "f".repeat(40),
        baseCommitSha: "a".repeat(40),
        workingBranch: "agentfabric/task-1",
        remote: "origin",
        remoteBranch: "agentfabric/task-1",
        workspaceFingerprint: "fingerprint",
        at: "2026-10-08T10:18:00.000Z",
        finalizations: 1,
      },
      publish: {
        status: "pushed",
        remote: "origin",
        remoteBranch: "agentfabric/task-1",
        finalCommitSha: "f".repeat(40),
        pushedAt: "2026-10-08T10:20:00.000Z",
        attempts: 1,
      },
    },
    ...patch,
  };
}

function makeRun(patch: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    taskId: "task-1",
    taskTitle: "Add retry to the publish step",
    status: "completed",
    lifecycle: LIFECYCLE,
    artifactIds: [],
    eventCount: 0,
    startTime: "2026-10-08T10:00:30.000Z",
    endTime: "2026-10-08T10:20:00.000Z",
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:20:00.000Z",
    ...patch,
  };
}

/** A scripted transport: each call consumes the next response (or throws). */
function scriptedFetch(script: Array<NotificationResponse | Error>): {
  fetchImpl: NotificationFetch;
  calls: NotificationFetchInit[];
} {
  const calls: NotificationFetchInit[] = [];
  let index = 0;
  const fetchImpl: NotificationFetch = async (_url, init) => {
    calls.push(init);
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (!next) throw new Error("scripted fetch exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body = ""): NotificationResponse {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

/** Records the backoff waits instead of performing them. */
function sleepRecorder(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { sleep: async (ms: number) => void waits.push(ms), waits };
}

function requestFor(patch: Partial<NotificationRequest> = {}): NotificationRequest {
  return {
    event: "task.completed",
    url: WEBHOOK_URL,
    headers: { "content-type": "application/json" },
    timeoutMs: DEFAULT_NOTIFICATION_TIMEOUT_MS,
    maxAttempts: DEFAULT_NOTIFICATION_MAX_ATTEMPTS,
    payload: buildTaskNotificationPayload({ task: makeTask(), run: makeRun() }),
    ...patch,
  };
}

/* ------------------------------------------------------------------ */
/* Payload construction                                               */
/* ------------------------------------------------------------------ */

test("payload reads stage outcomes verbatim, without re-deriving them", () => {
  const task = makeTask();
  const payload = buildTaskNotificationPayload({ task, run: makeRun() });

  assert.equal(payload.event, "task.completed");
  assert.equal(payload.taskId, "task-1");
  assert.equal(payload.title, "Add retry to the publish step");
  assert.equal(payload.projectId, "proj-1");
  assert.equal(payload.workingBranch, "agentfabric/task-1");
  assert.equal(payload.status, "completed");
  assert.equal(payload.phase, "completed");
  assert.deepEqual(payload.stages, {
    agent: { status: "completed", at: "2026-10-08T10:10:00.000Z" },
    validation: { status: "completed", at: "2026-10-08T10:15:00.000Z" },
    finalization: { status: "completed", at: "2026-10-08T10:18:00.000Z", commitSha: "f".repeat(40) },
    publish: { status: "completed", at: "2026-10-08T10:20:00.000Z", commitSha: "f".repeat(40) },
  });
  // A copy, not the record's own object: a payload must not alias stored state.
  assert.notEqual(payload.stages.agent, task.execution?.stages?.agent);
});

test("a frozen revision puts finalCommitSha and remoteBranch on the payload", () => {
  const payload = buildTaskNotificationPayload({ task: makeTask(), run: makeRun() });
  assert.equal(payload.finalCommitSha, "f".repeat(40));
  assert.equal(payload.remoteBranch, "agentfabric/task-1");
  assert.equal(payload.remote, "origin");
});

test("the task link is relative — no host is baked in", () => {
  const payload = buildTaskNotificationPayload({ task: makeTask(), run: makeRun() });
  assert.equal(payload.link, "/tasks/task-1");
});

test("duration is measured from the run's start to the recorded terminal moment", () => {
  const payload = buildTaskNotificationPayload({ task: makeTask(), run: makeRun() });
  assert.equal(payload.startedAt, "2026-10-08T10:00:30.000Z");
  assert.equal(payload.endedAt, "2026-10-08T10:20:00.000Z");
  assert.equal(payload.durationMs, 19 * 60_000 + 30_000);
});

test("without a run, the agent's own start time is used", () => {
  const payload = buildTaskNotificationPayload({ task: makeTask() });
  assert.equal(payload.startedAt, "2026-10-08T10:10:00.000Z");
  assert.equal(payload.durationMs, 10 * 60_000);
});

test("the run's user prompt wins over the task prompt", () => {
  const payload = buildTaskNotificationPayload({
    task: makeTask({ prompt: "original prompt" }),
    run: makeRun({ userPrompt: "  the user's actual ask  " }),
  });
  assert.equal(payload.instruction, "the user's actual ask");
  assert.equal(payload.instructionTruncated, false);
});

test("an over-long instruction is truncated with a marker, and the budget is respected", () => {
  const long = "x".repeat(5000);
  const payload = buildTaskNotificationPayload({ task: makeTask({ prompt: long }) });

  assert.equal(payload.instructionTruncated, true);
  assert.equal(payload.instruction.length, DEFAULT_INSTRUCTION_MAX_CHARS + 1); // + the ellipsis
  assert.ok(payload.instruction.endsWith("…"));
  assert.ok(payload.instruction.startsWith("x".repeat(DEFAULT_INSTRUCTION_MAX_CHARS)));
});

test("a custom instruction budget is honored, and an exactly-fitting instruction is not truncated", () => {
  const exactly = "y".repeat(10);
  const fitting = buildTaskNotificationPayload({ task: makeTask({ prompt: exactly }) }, { instructionMaxChars: 10 });
  assert.deepEqual(fitting.instructionTruncated, false);
  assert.equal(fitting.instruction, exactly);

  const over = buildTaskNotificationPayload({ task: makeTask({ prompt: "y".repeat(11) }) }, { instructionMaxChars: 10 });
  assert.equal(over.instructionTruncated, true);
  assert.equal(over.instruction, `${"y".repeat(10)}…`);
});

test("truncateInstruction leaves short text untouched", () => {
  assert.deepEqual(truncateInstruction("short", 10), { text: "short", truncated: false });
  assert.deepEqual(truncateInstruction("exactlyten", 10), { text: "exactlyten", truncated: false });
  assert.deepEqual(truncateInstruction("elevenchars", 10), { text: "elevenchar…", truncated: true });
});

/* ---- failure payloads ---- */

/** Agent succeeded, publishing failed — the case `agent.completed` would get wrong. */
function makePublishFailureTask(): Task {
  const base = makeTask();
  return makeTask({
    execution: {
      ...base.execution!,
      phase: "failed",
      status: "failed",
      failure: {
        stage: "publish",
        code: "git-push-auth-failed",
        message: "The remote rejected the credentials for the push",
        at: "2026-10-08T10:21:00.000Z",
      },
      publish: { ...base.execution!.publish!, status: "failed", error: "auth failed", errorCode: "git-push-auth-failed" },
      stages: {
        agent: { status: "completed", at: "2026-10-08T10:10:00.000Z" },
        validation: { status: "completed", at: "2026-10-08T10:15:00.000Z" },
        finalization: { status: "completed", at: "2026-10-08T10:18:00.000Z", commitSha: "f".repeat(40) },
        publish: { status: "failed", at: "2026-10-08T10:21:00.000Z", errorCode: "git-push-auth-failed" },
      },
    },
  });
}

test("a task that completed agent work but failed to publish notifies task.failed with the code and stage", () => {
  const task = makePublishFailureTask();
  assert.equal(notificationEventFor(task), "task.failed");

  const payload = buildTaskNotificationPayload({ task, run: makeRun({ status: "failed" }) });
  assert.equal(payload.event, "task.failed");
  assert.deepEqual(payload.failure, {
    stage: "publish",
    code: "git-push-auth-failed",
    message: "The remote rejected the credentials for the push",
  });
  // The successful stages survive the failure — the payload does not collapse
  // the run into "it broke".
  assert.equal(payload.stages.agent?.status, "completed");
  assert.equal(payload.stages.publish?.status, "failed");
  assert.equal(payload.stages.publish?.errorCode, "git-push-auth-failed");
  // The frozen revision is still reported: the work exists, publishing it failed.
  assert.equal(payload.finalCommitSha, "f".repeat(40));
  assert.equal(payload.endedAt, "2026-10-08T10:21:00.000Z");
});

test("a validation failure reports the validation code and stage", () => {
  const task = makeTask({
    execution: {
      phase: "failed",
      status: "failed",
      updatedAt: "2026-10-08T10:16:00.000Z",
      failure: { stage: "validation", code: "validation-failed", message: "npm test exited 1", at: "2026-10-08T10:16:00.000Z" },
      stages: {
        agent: { status: "completed", at: "2026-10-08T10:10:00.000Z" },
        validation: { status: "failed", at: "2026-10-08T10:16:00.000Z", errorCode: "validation-failed" },
      },
    },
  });
  const payload = buildTaskNotificationPayload({ task });
  assert.equal(payload.event, "task.failed");
  assert.equal(payload.failure?.stage, "validation");
  assert.equal(payload.failure?.code, "validation-failed");
  // No frozen revision: the run never got past validation.
  assert.equal(payload.finalCommitSha, undefined);
  assert.equal(payload.remoteBranch, undefined);
});

test("a completed event never carries a failure block", () => {
  // An announcement that the task finished must not also assert a failure —
  // and an explicit override cannot produce that contradiction.
  const task = makePublishFailureTask();
  assert.equal(buildTaskNotificationPayload({ task }).failure?.code, "git-push-auth-failed");
  assert.equal(buildTaskNotificationPayload({ task }, { event: "task.completed" }).failure, undefined);
});

test("an over-long failure message is bounded", () => {
  const base = makeTask();
  const task = makeTask({
    execution: {
      ...base.execution!,
      status: "failed",
      failure: { stage: "agent", code: "agent-failed", message: "e".repeat(4000), at: "2026-10-08T10:16:00.000Z" },
    },
  });
  const payload = buildTaskNotificationPayload({ task }, { failureMessageMaxChars: 50 });
  assert.equal(payload.failure?.message.length, 51);
  assert.ok(payload.failure?.message.endsWith("…"));
});

/* ---- cancellation ---- */

test("a cancelled task is task.cancelled, not task.failed", () => {
  const base = makeTask();
  const task = makeTask({
    execution: {
      ...base.execution!,
      phase: "cancelled",
      status: "cancelled",
      failure: { stage: "agent", code: "agent-cancelled", message: "Cancelled by user", at: "2026-10-08T10:05:00.000Z" },
      stages: { agent: { status: "cancelled", at: "2026-10-08T10:05:00.000Z", errorCode: "agent-cancelled" } },
    },
  });
  assert.equal(notificationEventFor(task), "task.cancelled");
  assert.equal(buildTaskNotificationPayload({ task }).event, "task.cancelled");
});

test("a failed status carrying agent-cancelled is still a cancellation", () => {
  const base = makeTask();
  const task = makeTask({
    execution: {
      ...base.execution!,
      phase: "failed",
      status: "failed",
      failure: { stage: "agent", code: "agent-cancelled", message: "Cancelled by user", at: "2026-10-08T10:05:00.000Z" },
    },
  });
  assert.equal(notificationEventFor(task), "task.cancelled");
});

/* ---- non-terminal records ---- */

test("a non-terminal task has no event and cannot produce a payload", () => {
  for (const status of ["created", "preparing", "running", "validating", "finalizing", "publishing"] as const) {
    const base = makeTask();
    const task = makeTask({ execution: { ...base.execution!, phase: "agent.running", status } });
    assert.equal(notificationEventFor(task), undefined, status);
    assert.throws(() => buildTaskNotificationPayload({ task }), (err: unknown) => {
      assert.ok(err instanceof NotificationError);
      assert.equal(err.code, "notification-not-terminal");
      return true;
    });
  }
});

test("a task with no execution record is not terminal", () => {
  const task = makeTask({ execution: undefined });
  assert.equal(notificationEventFor(task), undefined);
});

test("an explicit event overrides the record", () => {
  const base = makeTask();
  const task = makeTask({ execution: { ...base.execution!, phase: "agent.running", status: "running" } });
  const payload = buildTaskNotificationPayload({ task }, { event: "task.cancelled" });
  assert.equal(payload.event, "task.cancelled");
  // Still reads the record's real state rather than inventing a terminal one.
  assert.equal(payload.status, "running");
});

/* ------------------------------------------------------------------ */
/* Planning (config → request)                                        */
/* ------------------------------------------------------------------ */

test("disabled notifications plan nothing, and do not throw", () => {
  assert.equal(planNotification(undefined, { task: makeTask() }), undefined);
  assert.equal(planNotification({ enabled: false }, { task: makeTask() }), undefined);
  assert.equal(planNotification({ enabled: false, url: WEBHOOK_URL }, { task: makeTask() }), undefined);
});

test("enabled with no url is an explicit configuration error, never a silent skip", () => {
  for (const config of [
    { enabled: true },
    { enabled: true, url: "" },
    { enabled: true, url: "   " },
  ] as NotificationConfig[]) {
    assert.throws(() => planNotification(config, { task: makeTask() }), (err: unknown) => {
      assert.ok(err instanceof NotificationError, `expected NotificationError for ${JSON.stringify(config)}`);
      assert.equal(err.code, "notification-config-invalid");
      assert.match(err.message, /notifications\.url/);
      return true;
    });
  }
});

test("a malformed or non-http url is refused", () => {
  assert.throws(() => planNotification({ enabled: true, url: "not a url" }, { task: makeTask() }), /not a valid URL/);
  assert.throws(() => planNotification({ enabled: true, url: "ftp://hooks.example.test/x" }, { task: makeTask() }), /http\(s\)/);
});

test("a non-terminal task with valid config plans nothing", () => {
  const base = makeTask();
  const task = makeTask({ execution: { ...base.execution!, status: "running", phase: "agent.running" } });
  assert.equal(planNotification({ enabled: true, url: WEBHOOK_URL }, { task }), undefined);
});

test("a valid config produces a request with defaults and caller headers", () => {
  const request = planNotification({ enabled: true, url: WEBHOOK_URL, headers: { authorization: "Bearer t" } }, { task: makeTask() });
  assert.ok(request);
  assert.equal(request.event, "task.completed");
  assert.equal(request.url, WEBHOOK_URL);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers.authorization, "Bearer t");
  assert.equal(request.timeoutMs, DEFAULT_NOTIFICATION_TIMEOUT_MS);
  assert.equal(request.maxAttempts, DEFAULT_NOTIFICATION_MAX_ATTEMPTS);
});

test("timeout and attempt overrides are honored, and nonsense falls back to the default", () => {
  const tuned = planNotification({ enabled: true, url: WEBHOOK_URL, timeoutMs: 250, maxAttempts: 5 }, { task: makeTask() });
  assert.equal(tuned?.timeoutMs, 250);
  assert.equal(tuned?.maxAttempts, 5);

  const nonsense = planNotification({ enabled: true, url: WEBHOOK_URL, timeoutMs: 0, maxAttempts: -3 }, { task: makeTask() });
  assert.equal(nonsense?.timeoutMs, DEFAULT_NOTIFICATION_TIMEOUT_MS);
  assert.equal(nonsense?.maxAttempts, DEFAULT_NOTIFICATION_MAX_ATTEMPTS);
});

/* ------------------------------------------------------------------ */
/* Delivery                                                           */
/* ------------------------------------------------------------------ */

test("a 2xx delivery reports success with the status and one attempt", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(200)]);
  const result = await deliverNotification(requestFor(), { fetchImpl });

  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.headers["content-type"], "application/json");
  assert.equal(JSON.parse(calls[0]!.body).event, "task.completed");
  // The abort signal is wired to the configured budget.
  assert.ok(calls[0]!.signal instanceof AbortSignal);
});

test("5xx is retried and succeeds on the second attempt", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(503, "upstream down"), jsonResponse(200)]);
  const { sleep, waits } = sleepRecorder();
  const result = await deliverNotification(requestFor(), { fetchImpl, sleep });

  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.httpStatus, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [1_000]); // exponential backoff, first step
});

test("429 is retried — rate limiting is transient", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(429, "slow down"), jsonResponse(200)]);
  const { sleep, waits } = sleepRecorder();
  const result = await deliverNotification(requestFor(), { fetchImpl, sleep });

  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [1_000]);
});

test("a 4xx that is not 429 is not retried — one request, immediate failure", async () => {
  for (const status of [400, 401, 403, 404, 410, 422]) {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(status, "nope"), jsonResponse(200)]);
    const { sleep, waits } = sleepRecorder();
    const result = await deliverNotification(requestFor(), { fetchImpl, sleep });

    assert.equal(result.delivered, false, `status ${status}`);
    assert.equal(result.attempts, 1, `status ${status} must not retry`);
    assert.equal(result.httpStatus, status);
    assert.equal(result.retryable, false);
    assert.equal(result.errorKind, "http");
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
});

test("a network error is retried up to the limit, then reported with the attempt count", async () => {
  const { fetchImpl, calls } = scriptedFetch([new Error("ECONNREFUSED 127.0.0.1:9")]);
  const { sleep, waits } = sleepRecorder();
  const result = await deliverNotification(requestFor(), { fetchImpl, sleep });

  assert.equal(result.delivered, false);
  assert.equal(result.attempts, DEFAULT_NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(calls.length, DEFAULT_NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(result.errorKind, "network");
  assert.equal(result.retryable, true);
  assert.match(result.error!, /ECONNREFUSED/);
  // Exponential: 1s then 2s — the wait after the final attempt is skipped.
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("a network error that clears on the third attempt still succeeds", async () => {
  const { fetchImpl, calls } = scriptedFetch([new Error("socket hang up"), new Error("socket hang up"), jsonResponse(200)]);
  const { sleep, waits } = sleepRecorder();
  const result = await deliverNotification(requestFor(), { fetchImpl, sleep });

  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("a timeout is retried and classified as a timeout, without waiting for a real clock", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const { fetchImpl, calls } = scriptedFetch([timeout]);
  const { sleep, waits } = sleepRecorder();
  // A tiny injected budget: the test never waits the production 10s.
  const result = await deliverNotification(requestFor({ timeoutMs: 25 }), { fetchImpl, sleep });

  assert.equal(result.delivered, false);
  assert.equal(result.attempts, DEFAULT_NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(calls.length, DEFAULT_NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(result.errorKind, "timeout");
  assert.equal(result.retryable, true);
  assert.match(result.error!, /timed out after 25ms/);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("a custom attempt budget bounds the retries", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(500)]);
  const { sleep, waits } = sleepRecorder();
  const result = await deliverNotification(requestFor({ maxAttempts: 5 }), { fetchImpl, sleep });

  assert.equal(result.attempts, 5);
  assert.equal(calls.length, 5);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000]);
});

test("a 5xx that never clears reports the status, the body tail and the attempts", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse(502, "bad gateway from the reverse proxy")]);
  const { sleep } = sleepRecorder();
  const result = await deliverNotification(requestFor(), { fetchImpl, sleep });

  assert.equal(result.delivered, false);
  assert.equal(result.attempts, DEFAULT_NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(result.httpStatus, 502);
  assert.equal(result.errorKind, "http");
  assert.equal(result.retryable, true);
  assert.match(result.error!, /HTTP 502/);
  assert.match(result.error!, /bad gateway/);
  assert.match(result.detail!, /bad gateway/);
});

test("a response body that cannot be read does not break the result", async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 500, ok: false, text: async () => { throw new Error("body stream closed"); } },
  ]);
  const { sleep } = sleepRecorder();
  const result = await deliverNotification(requestFor({ maxAttempts: 1 }), { fetchImpl, sleep });

  assert.equal(result.delivered, false);
  assert.equal(result.httpStatus, 500);
  assert.equal(result.detail, undefined);
  assert.match(result.error!, /HTTP 500/);
});

test("delivery never rejects, whatever the transport throws", async () => {
  const weird: NotificationFetch = async () => {
    throw { notAnError: true };
  };
  const { sleep } = sleepRecorder();
  const result = await deliverNotification(requestFor({ maxAttempts: 1 }), { fetchImpl: weird, sleep });
  assert.equal(result.delivered, false);
  assert.ok(result.error);
});

test("a synchronous throw from the transport is contained too", async () => {
  const sync: NotificationFetch = () => {
    throw new TypeError("fetchImpl is not a function");
  };
  const { sleep } = sleepRecorder();
  const result = await deliverNotification(requestFor({ maxAttempts: 1 }), { fetchImpl: sync, sleep });
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 1);
});

/* ------------------------------------------------------------------ */
/* URL redaction                                                      */
/* ------------------------------------------------------------------ */

test("redactWebhookUrl keeps the scheme and host and drops the secret-bearing parts", () => {
  assert.equal(redactWebhookUrl(WEBHOOK_URL), "https://webhook.invalid/***");
  assert.equal(redactWebhookUrl("https://example.test/notify"), "https://example.test/***");
  assert.equal(redactWebhookUrl("https://example.test/notify?token=abc123"), "https://example.test/***");
  // No path and no query: nothing to hide.
  assert.equal(redactWebhookUrl("https://example.test"), "https://example.test");
  assert.equal(redactWebhookUrl("https://example.test/"), "https://example.test");
  // Userinfo is a credential and goes too.
  assert.equal(redactWebhookUrl("https://user:pass@example.test/hook"), "https://example.test/***");
  // Not a URL at all: never echoed.
  assert.equal(redactWebhookUrl("nonsense"), "***");
});

test("a failed delivery never echoes the webhook URL's path or token", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse(401, `invalid token in ${WEBHOOK_URL}`)]);
  const { sleep } = sleepRecorder();
  const result = await deliverNotification(requestFor(), { fetchImpl, sleep });

  assert.equal(result.delivered, false);
  // The redacted form is what the caller may log or store.
  assert.equal(result.url, "https://webhook.invalid/***");

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(WEBHOOK_PATH_TOKEN), `result leaked the path token: ${serialized}`);
  assert.ok(!serialized.includes("/services/"), `result leaked the webhook path: ${serialized}`);
  assert.ok(!serialized.includes(WEBHOOK_URL), "result leaked the full webhook URL");
  // The endpoint's own echo of the URL is scrubbed out of the detail too.
  assert.match(result.error!, /invalid token/);
  assert.ok(!result.error!.includes("/services/"));
});

test("a network error message quoting the URL is scrubbed", async () => {
  const { fetchImpl } = scriptedFetch([new Error(`request to ${WEBHOOK_URL} failed, reason: getaddrinfo ENOTFOUND`)]);
  const { sleep } = sleepRecorder();
  const result = await deliverNotification(requestFor({ maxAttempts: 1 }), { fetchImpl, sleep });

  assert.equal(result.delivered, false);
  assert.match(result.error!, /getaddrinfo ENOTFOUND/);
  assert.ok(!result.error!.includes("/services/"), result.error!);
  assert.ok(!result.error!.includes(WEBHOOK_PATH_TOKEN), result.error!);
  assert.ok(!JSON.stringify(result).includes(WEBHOOK_PATH_TOKEN));
});

test("a query-string token echoed by the endpoint is scrubbed", async () => {
  const url = "https://hooks.example.test/notify?token=SUPERSECRETVALUE123";
  const { fetchImpl } = scriptedFetch([jsonResponse(401, `bad token: token=SUPERSECRETVALUE123`)]);
  const { sleep } = sleepRecorder();
  const result = await deliverNotification(requestFor({ url, maxAttempts: 1 }), { fetchImpl, sleep });

  assert.equal(result.delivered, false);
  assert.equal(result.url, "https://hooks.example.test/***");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("SUPERSECRETVALUE123"), `result leaked the query token: ${serialized}`);
  assert.ok(!serialized.includes("?token="), `result leaked the query string: ${serialized}`);
  assert.ok(!serialized.includes("/notify"), `result leaked the path: ${serialized}`);
});

test("a huge echoing body cannot push a partial token into the result", async () => {
  // The endpoint echoes the URL behind a long prefix; a scrub-after-truncate
  // would cut mid-token and leave a usable fragment behind.
  const { fetchImpl } = scriptedFetch([jsonResponse(500, `${"p".repeat(5_000)}${WEBHOOK_URL}`)]);
  const { sleep } = sleepRecorder();
  const result = await deliverNotification(requestFor({ maxAttempts: 1 }), { fetchImpl, sleep });

  assert.equal(result.delivered, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(WEBHOOK_PATH_TOKEN), "result leaked the path token");
  assert.ok(!serialized.includes("/services/"), "result leaked the webhook path");
  assert.ok(result.detail!.length <= 300, "the detail stays bounded");
});

test("the plan's request carries the real URL but the delivery result carries the redacted one", async () => {
  const request = planNotification({ enabled: true, url: WEBHOOK_URL }, { task: makeTask() });
  assert.equal(request?.url, WEBHOOK_URL); // the transport needs it
  const { fetchImpl } = scriptedFetch([jsonResponse(200)]);
  const result = await deliverNotification(request!, { fetchImpl });
  assert.equal(result.url, "https://webhook.invalid/***"); // the caller must not
});

/* ------------------------------------------------------------------ */
/* One-call entry point                                               */
/* ------------------------------------------------------------------ */

test("deliverTaskNotification posts a completed task and returns the result", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(200)]);
  const result = await deliverTaskNotification({ enabled: true, url: WEBHOOK_URL }, { task: makeTask(), run: makeRun() }, { fetchImpl });

  assert.ok(result);
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!.body);
  assert.equal(body.event, "task.completed");
  assert.equal(body.link, "/tasks/task-1");
});

test("deliverTaskNotification does nothing when notifications are off", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(200)]);
  const result = await deliverTaskNotification({ enabled: false }, { task: makeTask() }, { fetchImpl });
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("planNotification raises the config error for enabled-without-url", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(200)]);
  await assert.rejects(
    () => Promise.resolve().then(() => planNotification({ enabled: true }, { task: makeTask() })),
    (err: unknown) => {
      assert.ok(err instanceof NotificationError);
      assert.equal(err.code, "notification-config-invalid");
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test("deliverTaskNotification reports enabled-without-url instead of throwing", async () => {
  // This entry point runs at the Task's terminal write. A misconfiguration is
  // the user's problem to fix and must be visible, but it can never be the
  // reason a Task's recorded outcome changes — so it resolves as a result.
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(200)]);
  const result = await deliverTaskNotification({ enabled: true }, { task: makeTask() }, { fetchImpl });

  assert.ok(result, "a broken config is reported, not silently dropped");
  assert.equal(result.delivered, false);
  assert.equal(result.errorKind, "config");
  assert.equal(result.retryable, false);
  assert.equal(result.attempts, 0);
  assert.match(result.error!, /notifications\.url is not set/);
  assert.equal(calls.length, 0, "nothing was sent");
});

test("deliverTaskNotification reports a non-http(s) webhook URL without leaking it", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(200)]);
  const result = await deliverTaskNotification(
    { enabled: true, url: "ftp://hooks.example.com/services/T000/B000/supersecret" },
    { task: makeTask() },
    { fetchImpl }
  );

  assert.ok(result);
  assert.equal(result.delivered, false);
  assert.equal(result.errorKind, "config");
  assert.doesNotMatch(result.error!, /supersecret/, "the URL path is a credential and never appears");
  assert.equal(calls.length, 0);
});

test("a failed delivery through the one-call entry point resolves rather than throwing", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse(403, "forbidden")]);
  const { sleep } = sleepRecorder();
  const result = await deliverTaskNotification({ enabled: true, url: WEBHOOK_URL }, { task: makeTask() }, { fetchImpl, sleep });

  assert.ok(result);
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.httpStatus, 403);
});
