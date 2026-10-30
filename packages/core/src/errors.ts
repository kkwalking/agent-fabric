/**
 * Domain error model (v11 §22).
 *
 * Every lifecycle failure carries a stable machine-readable `code` plus the
 * stage it happened in, so callers (API / CLI / UI) can tell a workspace,
 * runtime or agent failure apart instead of collapsing them into one plain
 * "Task failed".
 *
 * Codes are grouped by the stage that raises them. Messages are safe to show
 * and to store: they are redacted of credential material at the boundary
 * (see `core/redaction.ts`).
 */

/** Every domain failure code AgentFabric can report. */
export type ErrorCode =
  /* Workspace */
  | "workspace-create-failed"
  | "workspace-locked"
  | "workspace-invalid"
  | "workspace-duplicate"
  /* Runtime */
  | "runtime-create-failed"
  | "runtime-start-failed"
  | "runtime-lost"
  | "runtime-timeout"
  /* Agent */
  | "agent-start-failed"
  | "agent-failed"
  | "agent-timeout"
  | "agent-cancelled"
  /* Task */
  | "profile-not-found"
  | "model-not-found"
  | "task-not-found"
  | "task-state-invalid"
  | "task-busy"
  | "policy-denied"
  /* Git helpers (diff capture / repository probes) */
  | "source-url-invalid"
  | "source-not-found"
  | "source-network-failed"
  | "source-credential-invalid"
  | "base-ref-not-found"
  | "git-state-invalid"
  | "git-commit-failed"
  | "git-push-failed"
  | "git-push-auth-failed"
  | "git-push-rejected"
  /* Secrets at rest */
  | "secret-legacy-format"
  | "secret-key-invalid"
  | "secret-decrypt-failed"
  | "secret-scope-not-allowed"
  /* Kanban (v13) */
  | "kanban-workspace-not-found"
  | "kanban-card-not-found"
  | "kanban-card-not-editable"
  | "kanban-session-not-found"
  | "kanban-workspace-path-invalid"
  | "kanban-workspace-duplicate"
  | "kanban-path-invalid"
  | "kanban-git-command-failed"
  | "kanban-agent-unknown"
  | "kanban-agent-not-installed"
  | "kanban-agent-profile-missing"
  | "kanban-agent-model-unavailable"
  | "kanban-agent-effort-unavailable"
  | "kanban-model-catalog-unavailable"
  | "kanban-session-not-startable"
  | "kanban-execution-mode-unavailable"
  | "kanban-worktree-unavailable"
  | "kanban-worktree-failed"
  | "kanban-terminal-unauthorized"
  | "kanban-agent-failed"
  | "kanban-session-interrupted"
  | "kanban-runtime-missing"
  /* Platform */
  | "config-invalid"
  | "settings-open-failed"
  | "internal-error";

/** The stage a failure belongs to. */
export type FailureStage = "workspace" | "runtime" | "agent";

const STAGE_BY_CODE: Partial<Record<ErrorCode, FailureStage>> = {
  "workspace-create-failed": "workspace",
  "workspace-locked": "workspace",
  "workspace-invalid": "workspace",
  "workspace-duplicate": "workspace",
  "runtime-create-failed": "runtime",
  "runtime-start-failed": "runtime",
  "runtime-lost": "runtime",
  "runtime-timeout": "runtime",
  "agent-start-failed": "agent",
  "agent-failed": "agent",
  "agent-timeout": "agent",
  "agent-cancelled": "agent",
  // A profile the Task references no longer resolves: the failure belongs to
  // run preparation, and the agent never started.
  "profile-not-found": "agent",
  "model-not-found": "runtime",
  // A board card's agent failure is an agent-stage failure of the card task.
  "kanban-agent-failed": "agent",
  "kanban-session-interrupted": "agent",
};

export function stageForCode(code: ErrorCode): FailureStage {
  return STAGE_BY_CODE[code] ?? "agent";
}

/**
 * The single error type raised by platform-enforced lifecycle steps. It is
 * deliberately not `Error`-with-a-string: the code drives retry semantics.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly stage: FailureStage;
  /** Optional non-sensitive detail (never a credential). */
  readonly detail?: string;

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.stage = stageForCode(code);
    this.detail = detail;
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}

/** HTTP status for a domain error, so the API stays consistent. */
export function httpStatusForCode(code: ErrorCode): number {
  if (code.endsWith("-not-found")) return 404;
  if (
    code === "workspace-locked" ||
    code === "workspace-duplicate" ||
    code === "task-busy" ||
    code === "task-state-invalid" ||
    code === "kanban-session-not-startable" ||
    code === "kanban-card-not-editable" ||
    code === "kanban-workspace-duplicate"
  ) {
    return 409;
  }
  if (
    code === "git-push-auth-failed" ||
    code === "policy-denied" ||
    code === "secret-scope-not-allowed" ||
    code === "kanban-terminal-unauthorized"
  ) {
    return 403;
  }
  if (
    code === "source-network-failed" ||
    code === "git-push-failed" ||
    code === "git-push-rejected" ||
    code === "runtime-create-failed" ||
    code === "runtime-start-failed" ||
    code === "runtime-lost" ||
    code === "runtime-timeout" ||
    code === "source-not-found"
  ) {
    return 502;
  }
  // A `git` invocation the platform ran and that failed on its own terms is a
  // server-side failure, not bad client input.
  if (code === "kanban-git-command-failed") return 500;
  return 400;
}

/** Wraps any thrown value into a `DomainError` with a fallback code. */
export function asDomainError(err: unknown, fallback: ErrorCode, context?: string): DomainError {
  if (err instanceof DomainError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DomainError(fallback, context ? `${context}: ${message}` : message);
}

/* ------------------------------------------------------------------ */
/* Retry semantics                                                    */
/* ------------------------------------------------------------------ */

/** The retry a failure permits. */
export type RetryKind = "agent" | "none";

export function retryKindForFailure(stage: FailureStage | undefined): RetryKind {
  return stage ? "agent" : "none";
}

/**
 * Whether a failure is transient — the environment broke, not the work.
 * Automatic retry keys off this one classification.
 */
export function isTransientErrorCode(code: string): boolean {
  switch (code) {
    case "source-network-failed":
    case "git-push-failed":
      return true;
    default:
      return false;
  }
}
