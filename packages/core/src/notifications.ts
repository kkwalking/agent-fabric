/**
 * Outbound task notifications (webhook).
 *
 * A coding Task runs for minutes to hours, so "the task finished" has to reach
 * the user without them watching the page. This module is the whole feature
 * minus its wiring: it turns a terminal Task record into a JSON payload and
 * POSTs it to one configured webhook (Feishu / Slack / any HTTP endpoint).
 *
 * Three properties are non-negotiable, and the shape of the code exists to
 * make them checkable:
 *
 * - **Notification is a bypass, never part of the execution chain.** Delivery
 *   failure must never fail a Task, so `deliverNotification` *never rejects*:
 *   it resolves to a `DeliveryResult` that says exactly what happened. The
 *   caller records that result; it does not act on it.
 * - **Failure has to be loud** (repo rule). A dropped notification is not a
 *   silent no-op: the result carries the attempt count, the last HTTP status
 *   and the last error, and `enabled: true` without a `url` is a thrown
 *   `NotificationConfigError` — never a quiet skip.
 * - **The webhook URL is a secret.** Slack's incoming-webhook path *is* the
 *   token (Slack's `hooks.slack.com/services/T…/B…/X…`), so no message, result
 *   field or log line may echo the configured URL verbatim — see
 *   `redactWebhookUrl`. This is the same rule `core/redaction.ts` enforces for
 *   Git remotes, applied to the one other URL that carries credentials.
 *
 * The payload is built from the record, never re-derived: `execution.stages`
 * is monotonic (v11 hardening §36), so this module reads it verbatim and does
 * not recompute what a stage "should" be.
 */

import { redactRemoteUrl } from "./redaction.js";
import type { NotificationConfig, Run, StageOutcome, Task, TaskFailure } from "./types.js";

/* ------------------------------------------------------------------ */
/* Payload                                                            */
/* ------------------------------------------------------------------ */

/** The terminal transitions worth a notification. */
export type NotificationEvent = "task.completed" | "task.failed" | "task.cancelled";

/** Per-stage outcome, copied verbatim from `TaskExecution["stages"]`. */
export interface NotificationStages {
  agent?: StageOutcome;
  validation?: StageOutcome;
  finalization?: StageOutcome;
  publish?: StageOutcome;
}

/** The failure classification (code + stage) — the core of the error model. */
export interface NotificationFailure {
  stage: string;
  code: string;
  message: string;
}

/**
 * What a webhook receives. Deliberately flat and JSON-serializable: the
 * receiver is a chat bot or a shell script, not an AgentFabric client.
 */
export interface TaskNotificationPayload {
  /** `task.completed` | `task.failed` | `task.cancelled`. */
  event: NotificationEvent;
  taskId: string;
  title: string;
  /** The task's instruction, truncated to `instructionMaxChars`. */
  instruction: string;
  /** True when `instruction` was cut; the full text stays on the Task page. */
  instructionTruncated: boolean;
  projectId?: string;
  workingBranch?: string;
  baseRef?: string;
  /** Terminal lifecycle status, read from the record. */
  status: string;
  /** Terminal phase, read from the record. */
  phase: string;
  /** Stage outcomes as recorded; never recomputed here. */
  stages: NotificationStages;
  /** Present only when the task failed. */
  failure?: NotificationFailure;
  /** The frozen final revision's commit, when finalization succeeded. */
  finalCommitSha?: string;
  /** Remote branch the work was published to. */
  remoteBranch?: string;
  remote?: string;
  /** Task lifecycle start, best available (run start → agent start → creation). */
  startedAt: string;
  /** When the terminal state was reached. */
  endedAt: string;
  /** `endedAt - startedAt`, clamped at 0. */
  durationMs: number;
  /** Relative UI path (`/tasks/<id>`) — the host is the receiver's business. */
  link: string;
}

export interface TaskNotificationInput {
  task: Task;
  /** The run that reached the terminal state; refines start time and prompt. */
  run?: Run;
}

export interface TaskNotificationPayloadOptions {
  /** Explicit event; defaults to the one the record implies. */
  event?: NotificationEvent;
  /** Instruction budget in characters. Default `DEFAULT_INSTRUCTION_MAX_CHARS`. */
  instructionMaxChars?: number;
  /** Failure-message budget in characters. Default `DEFAULT_FAILURE_MESSAGE_MAX_CHARS`. */
  failureMessageMaxChars?: number;
}

/**
 * Instruction budget. An instruction can be a whole pasted spec (or a handoff
 * bundle), and a chat message that big is unreadable and may be rejected by
 * the endpoint — the notification links to the Task page for the full text.
 */
export const DEFAULT_INSTRUCTION_MAX_CHARS = 300;

/** Failure-message budget; validation messages can embed command output tails. */
export const DEFAULT_FAILURE_MESSAGE_MAX_CHARS = 500;

/** Cuts `text` to `maxChars` and marks the cut with an ellipsis. */
export function truncateInstruction(
  text: string,
  maxChars: number = DEFAULT_INSTRUCTION_MAX_CHARS
): { text: string; truncated: boolean } {
  const budget = Math.max(1, Math.floor(maxChars));
  if (text.length <= budget) return { text, truncated: false };
  return { text: `${text.slice(0, budget)}…`, truncated: true };
}

/**
 * The event a Task's record implies, or `undefined` while it is not terminal.
 *
 * Only terminal transitions notify. The intermediate stage outcomes do not:
 * `agent.completed` is *not* a terminal state (validation, finalization and
 * publishing still follow, and any of them can fail the task), so announcing
 * it would tell the user "done" for work that is still running — and would
 * fire a second, contradictory notification later. `publish.failed` *is*
 * terminal, and it is the case that makes this rule matter: a Task can reach
 * agent-completed and then fail to publish, and that failure is exactly what
 * the user needs to hear about.
 *
 * Cancellation is terminal too, and carries `agent-cancelled` in
 * `execution.failure.code` (see `ExecutionSupervisor.cancelTask`).
 */
export function notificationEventFor(task: Task, override?: NotificationEvent): NotificationEvent | undefined {
  if (override) return override;
  const execution = task.execution;
  if (!execution) return undefined;
  if (execution.status === "completed") return "task.completed";
  if (execution.status === "cancelled") return "task.cancelled";
  if (execution.status === "failed") return execution.failure?.code === "agent-cancelled" ? "task.cancelled" : "task.failed";
  return undefined;
}

/** Shallow copy of the recorded stage outcomes — the payload never aliases the record. */
function stagesFor(task: Task): NotificationStages {
  const stages = task.execution?.stages ?? {};
  return {
    ...(stages.agent ? { agent: { ...stages.agent } } : {}),
    ...(stages.validation ? { validation: { ...stages.validation } } : {}),
    ...(stages.finalization ? { finalization: { ...stages.finalization } } : {}),
    ...(stages.publish ? { publish: { ...stages.publish } } : {}),
  };
}

/**
 * The failure block, for the events that can have one.
 *
 * A `task.completed` event never carries one: an announcement that the task
 * finished must not also assert that something failed. The record is written
 * that way (the supervisor's terminal write stores `failure` only when there
 * is one), so this is a consistency rule for the payload rather than a repair
 * of the record.
 */
function failureFor(task: Task, event: NotificationEvent, maxChars: number): NotificationFailure | undefined {
  if (event === "task.completed") return undefined;
  const failure: TaskFailure | undefined = task.execution?.failure;
  if (!failure) return undefined;
  return {
    stage: failure.stage,
    code: failure.code,
    message: truncateInstruction(failure.message, maxChars).text,
  };
}

/** Best available lifecycle start: the run's start, the agent's start, else creation. */
function startedAtFor(task: Task, run?: Run): string {
  return run?.startTime ?? task.execution?.agent?.startedAt ?? task.createdAt;
}

/** Best available terminal timestamp. */
function endedAtFor(task: Task, run?: Run): string {
  return task.execution?.failure?.at ?? task.execution?.updatedAt ?? run?.endTime ?? task.createdAt;
}

/**
 * Builds the notification payload for a terminal Task.
 *
 * Throws `NotificationError` (`notification-not-terminal`) when the record is
 * not terminal and no explicit event was passed: there is no honest event to
 * report, and inventing one would be a silent lie.
 */
export function buildTaskNotificationPayload(
  input: TaskNotificationInput,
  options: TaskNotificationPayloadOptions = {}
): TaskNotificationPayload {
  const { task, run } = input;
  const event = notificationEventFor(task, options.event);
  if (!event) {
    throw new NotificationError(
      "notification-not-terminal",
      `Task ${task.id} is not in a terminal state (status "${task.execution?.status ?? "created"}")`
    );
  }
  const instruction = truncateInstruction(
    run?.userPrompt?.trim() || task.prompt,
    options.instructionMaxChars ?? DEFAULT_INSTRUCTION_MAX_CHARS
  );
  const failure = failureFor(task, event, options.failureMessageMaxChars ?? DEFAULT_FAILURE_MESSAGE_MAX_CHARS);
  const frozen = task.execution?.frozenRevision;
  const publish = task.execution?.publish;
  const startedAt = startedAtFor(task, run);
  const endedAt = endedAtFor(task, run);
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt);

  return {
    event,
    taskId: task.id,
    title: task.title,
    instruction: instruction.text,
    instructionTruncated: instruction.truncated,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(task.workingBranch ? { workingBranch: task.workingBranch } : {}),
    ...(task.baseRef ? { baseRef: task.baseRef } : {}),
    status: task.execution?.status ?? "created",
    phase: task.execution?.phase ?? "task.created",
    stages: stagesFor(task),
    ...(failure ? { failure } : {}),
    // The frozen revision is the published fact (v11 hardening §13); the
    // publish state's copy is only a fallback for records finalized before it.
    ...(frozen?.finalCommitSha || publish?.finalCommitSha
      ? { finalCommitSha: frozen?.finalCommitSha ?? publish?.finalCommitSha }
      : {}),
    ...(publish?.remoteBranch ? { remoteBranch: publish.remoteBranch } : {}),
    ...(publish?.remote ? { remote: publish.remote } : {}),
    startedAt,
    endedAt,
    durationMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
    link: `/tasks/${task.id}`,
  };
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

/**
 * The webhook configuration lives in `types.ts` (`AppConfig.notifications`)
 * because that is where every other persisted config shape is defined, and
 * this module already imports from there — defining it here too would invert
 * the type graph. Re-exported so callers of this module need one import.
 */
export type { NotificationConfig };

export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 10_000;
export const DEFAULT_NOTIFICATION_MAX_ATTEMPTS = 3;

/** First backoff step; doubles per attempt (1s, 2s, …) and is capped. */
export const NOTIFICATION_BACKOFF_BASE_MS = 1_000;
export const NOTIFICATION_BACKOFF_MAX_MS = 30_000;

/** A resolved, validated delivery: exactly what to POST and where. */
export interface NotificationRequest {
  event: NotificationEvent;
  /** The real URL — secret-bearing. Never log it; use `redactWebhookUrl`. */
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxAttempts: number;
  payload: TaskNotificationPayload;
}

export type NotificationErrorCode =
  | "notification-config-invalid"
  | "notification-not-terminal";

/** Raised for a configuration that cannot be honored. Never swallowed. */
export class NotificationError extends Error {
  readonly code: NotificationErrorCode;

  constructor(code: NotificationErrorCode, message: string) {
    super(message);
    this.name = "NotificationError";
    this.code = code;
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Validates the configured URL. Returns it trimmed; throws when unusable. */
function requireWebhookUrl(config: NotificationConfig): string {
  const url = config.url?.trim();
  if (!url) {
    throw new NotificationError(
      "notification-config-invalid",
      "notifications.enabled is true but notifications.url is not set — configure a webhook URL or disable notifications"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NotificationError("notification-config-invalid", `notifications.url is not a valid URL (${redactWebhookUrl(url)})`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NotificationError(
      "notification-config-invalid",
      `notifications.url must be an http(s) URL (got "${parsed.protocol}")`
    );
  }
  return url;
}

/**
 * Maps (config + Task) to "deliver this, or nothing".
 *
 * - Disabled → `undefined`: the user asked for no notifications, and that is
 *   not a failure.
 * - Enabled but unusable (no URL, malformed URL) → throws. Loud, per the repo
 *   rule that an unavailable capability must not degrade silently.
 * - Enabled, usable, but the Task is not terminal → `undefined`: there is
 *   nothing to announce yet. The caller reaches this only by calling at a
 *   non-terminal point, which is a caller bug, not a user-facing condition.
 */
export function planNotification(
  config: NotificationConfig | undefined,
  input: TaskNotificationInput,
  options: TaskNotificationPayloadOptions = {}
): NotificationRequest | undefined {
  if (!config?.enabled) return undefined;
  const url = requireWebhookUrl(config);
  const event = notificationEventFor(input.task, options.event);
  if (!event) return undefined;
  return {
    event,
    url,
    // The receiver is a chat bot or a script: JSON in, JSON out. Caller
    // headers come last so they can override anything, including content-type.
    headers: { "content-type": "application/json", ...(config.headers ?? {}) },
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_NOTIFICATION_TIMEOUT_MS),
    maxAttempts: positiveInt(config.maxAttempts, DEFAULT_NOTIFICATION_MAX_ATTEMPTS),
    payload: buildTaskNotificationPayload(input, { ...options, event }),
  };
}

/* ------------------------------------------------------------------ */
/* Delivery                                                           */
/* ------------------------------------------------------------------ */

/** Minimal response surface the delivery loop needs (`Response` satisfies it). */
export interface NotificationResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export interface NotificationFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** The one network seam; tests inject a scripted fake. */
export type NotificationFetch = (url: string, init: NotificationFetchInit) => Promise<NotificationResponse>;

export interface NotificationDeliveryDeps {
  /** Defaults to the global `fetch` (Node 18+). */
  fetchImpl?: NotificationFetch;
  /** Backoff sleep. Defaults to a real timer; tests inject a recorder. */
  sleep?: (ms: number) => Promise<void>;
}

/** Why the last attempt failed. */
export type NotificationErrorKind = "http" | "network" | "timeout" | "config";

/**
 * The outcome of a delivery. Returned, never thrown — the caller logs it; it
 * never becomes a Task failure.
 */
export interface DeliveryResult {
  delivered: boolean;
  event: NotificationEvent;
  /** Redacted (`scheme://host/***`). Safe to log and to store on an event. */
  url: string;
  /** Attempts made, including the first. */
  attempts: number;
  /** HTTP status of the last attempt, when one was received. */
  httpStatus?: number;
  /** Last error, already scrubbed of the webhook URL. */
  error?: string;
  errorKind?: NotificationErrorKind;
  /** Scrubbed tail of the last response body, when there was one. */
  detail?: string;
  /** Whether another attempt could have helped (a 4xx says no). */
  retryable?: boolean;
  durationMs: number;
}

const MAX_DETAIL_CHARS = 300;

/**
 * Redacts a webhook URL for display: scheme + host survive, everything that
 * can carry a credential does not.
 *
 * A Slack incoming webhook *is* its path (`/services/T…/B…/X…`), and a generic
 * endpoint may put a token in the query string, so path, query and userinfo
 * are all replaced. `redactRemoteUrl` covers the userinfo case; the rest is
 * this function's job.
 */
export function redactWebhookUrl(url: string): string {
  const redacted = redactRemoteUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(redacted);
  } catch {
    // Not a URL (a config typo, a bare host): never echo it back.
    return "***";
  }
  const authority = `${parsed.protocol}//${parsed.host}`;
  const hadSecret = parsed.pathname !== "" && parsed.pathname !== "/";
  return hadSecret || parsed.search || parsed.hash ? `${authority}/***` : authority;
}

/** Raw body slice scrubbed before truncation, so a URL split by the cut still matches. */
const DETAIL_SCRUB_WINDOW_CHARS = 4_000;

/**
 * Removes every occurrence of `url`'s secret parts from `text`. Applied to
 * anything this module surfaces (error messages, response bodies), because a
 * failing endpoint often echoes the URL it was called on.
 */
function scrubUrlParts(text: string, url: string): string {
  let out = text.split(url).join(redactWebhookUrl(url));
  try {
    const parsed = new URL(url);
    const parts = [
      parsed.pathname,
      `${parsed.pathname}${parsed.search}`,
      parsed.search,
      parsed.search.slice(1),
      parsed.username,
      parsed.password,
    ];
    for (const part of parts) {
      if (part.length >= 4) out = out.split(part).join("***");
    }
  } catch {
    /* not a URL; the whole-string replacement above is all we can do */
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return /timed? ?out/i.test(messageOf(err));
}

/** Exponential backoff, capped. */
function backoffMs(attempt: number): number {
  return Math.min(NOTIFICATION_BACKOFF_MAX_MS, NOTIFICATION_BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

/**
 * A response body can echo the request — including the webhook URL. Scrubbed
 * first, then bounded: truncating before scrubbing could cut a URL in half and
 * leave a prefix of the token behind, which is exactly what the scrub is for.
 */
async function readDetail(res: NotificationResponse, url: string): Promise<string | undefined> {
  try {
    const text = (await res.text()).trim();
    if (!text) return undefined;
    return scrubUrlParts(text.slice(0, DETAIL_SCRUB_WINDOW_CHARS), url).slice(0, MAX_DETAIL_CHARS).trim();
  } catch {
    return undefined;
  }
}

/**
 * POSTs `request` and retries what is worth retrying.
 *
 * Retry policy: network errors and timeouts are transient; 429 (rate limited)
 * and 5xx (server-side) are transient. Every other 4xx means the request
 * itself is wrong — a bad token, a wrong path, a payload the endpoint refuses —
 * and repeating it changes nothing, so it is reported immediately instead of
 * burning two more attempts.
 *
 * **Never rejects.** Every outcome, including "gave up", is a `DeliveryResult`.
 * A caller may therefore `await` it inside a lifecycle without any chance of
 * turning a notification problem into a Task failure.
 */
export async function deliverNotification(
  request: NotificationRequest,
  deps: NotificationDeliveryDeps = {}
): Promise<DeliveryResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const body = JSON.stringify(request.payload);
  const url = redactWebhookUrl(request.url);
  const maxAttempts = Math.max(1, request.maxAttempts);
  const started = Date.now();

  let attempts = 0;
  let lastError = "notification delivery never ran";
  let errorKind: NotificationErrorKind = "network";
  let httpStatus: number | undefined;
  let detail: string | undefined;
  let retryable = false;

  while (attempts < maxAttempts) {
    attempts += 1;
    let res: NotificationResponse;
    try {
      res = await fetchImpl(request.url, {
        method: "POST",
        headers: request.headers,
        body,
        // A fresh signal per attempt: an AbortSignal is one-shot.
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (err) {
      const timedOut = isTimeoutError(err);
      errorKind = timedOut ? "timeout" : "network";
      httpStatus = undefined;
      detail = undefined;
      lastError = timedOut
        ? `request timed out after ${request.timeoutMs}ms`
        : scrubUrlParts(messageOf(err), request.url);
      retryable = true;
      if (attempts < maxAttempts) {
        await sleep(backoffMs(attempts));
        continue;
      }
      break;
    }

    if (res.ok) {
      return {
        delivered: true,
        event: request.event,
        url,
        attempts,
        httpStatus: res.status,
        durationMs: Date.now() - started,
      };
    }

    httpStatus = res.status;
    detail = await readDetail(res, request.url);
    retryable = res.status === 429 || res.status >= 500;
    lastError = `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
    errorKind = "http";
    if (retryable && attempts < maxAttempts) {
      await sleep(backoffMs(attempts));
      continue;
    }
    break;
  }

  return {
    delivered: false,
    event: request.event,
    url,
    attempts,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    error: lastError,
    errorKind,
    ...(detail !== undefined ? { detail } : {}),
    retryable,
    durationMs: Date.now() - started,
  };
}

/**
 * The whole feature in one call: plan, then deliver. **This never rejects.**
 *
 * `undefined` means "nothing to do" (notifications disabled, or the Task is
 * not terminal). A configuration that cannot be honored — `enabled: true`
 * with no `url`, a URL that is not http(s) — is a *reported* failure, not a
 * thrown one: it comes back as a `DeliveryResult` with
 * `errorKind: "config"`. That distinction matters because this function runs
 * at the Task's terminal write; throwing there would let a notification
 * problem change the Task's recorded outcome, which the feature must never
 * do. The failure is still loud — the caller records the result — it just is
 * not fatal.
 *
 * `planNotification` remains the strict, throwing entry point for callers
 * that want configuration errors at the call site (e.g. a config write).
 */
export async function deliverTaskNotification(
  config: NotificationConfig | undefined,
  input: TaskNotificationInput,
  deps: NotificationDeliveryDeps = {},
  options: TaskNotificationPayloadOptions = {}
): Promise<DeliveryResult | undefined> {
  const started = Date.now();
  let request: NotificationRequest | undefined;
  try {
    request = planNotification(config, input, options);
  } catch (err) {
    const event = options.event ?? notificationEventFor(input.task);
    // No event means nothing would have been sent anyway; stay silent.
    if (!event) return undefined;
    return {
      delivered: false,
      event,
      url: config?.url ? redactWebhookUrl(config.url) : "***",
      attempts: 0,
      error: err instanceof Error ? err.message : String(err),
      errorKind: "config",
      retryable: false,
      durationMs: Date.now() - started,
    };
  }
  if (!request) return undefined;
  return deliverNotification(request, deps);
}
