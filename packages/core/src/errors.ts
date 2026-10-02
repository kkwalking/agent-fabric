/**
 * Domain error model (v11 §22).
 *
 * Every lifecycle failure carries a stable machine-readable `code` plus the
 * stage it happened in, so callers (API / CLI / UI) can tell an agent
 * execution failure from a validation failure from a publish failure — and
 * never collapse them into one plain "Task failed" (v11 §20/§23).
 *
 * Codes are grouped by the stage that raises them. Messages are safe to show
 * and to store: they are redacted of credential material at the boundary
 * (see `core/redaction.ts`).
 */

/** Every domain failure code AgentFabric can report. */
export type ErrorCode =
  /* Source */
  | "source-url-invalid"
  | "source-not-found"
  | "source-auth-failed"
  | "source-network-failed"
  | "source-credential-missing"
  | "source-credential-invalid"
  | "base-ref-not-found"
  | "branch-invalid"
  | "branch-not-found"
  | "branch-conflict"
  /* Workspace */
  | "workspace-create-failed"
  | "workspace-locked"
  | "workspace-invalid"
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
  /* Validation */
  | "validation-failed"
  | "validation-timeout"
  /* Git finalization */
  | "git-state-invalid"
  | "git-commit-failed"
  /* Publishing */
  | "git-push-failed"
  | "git-push-auth-failed"
  | "git-push-rejected"
  | "remote-branch-conflict"
  /* Project / Task */
  | "project-not-found"
  | "project-invalid"
  | "credential-not-found"
  | "task-not-found"
  | "task-state-invalid"
  | "task-busy"
  | "policy-denied"
  /* Platform */
  | "supervisor-restarted"
  | "internal-error";

/** The stage a failure belongs to (v11 §20). */
export type FailureStage =
  | "workspace"
  | "source"
  | "runtime"
  | "agent"
  | "validation"
  | "finalization"
  | "publish";

const STAGE_BY_CODE: Partial<Record<ErrorCode, FailureStage>> = {
  "source-url-invalid": "source",
  "source-not-found": "source",
  "source-auth-failed": "source",
  "source-network-failed": "source",
  "source-credential-missing": "source",
  "source-credential-invalid": "source",
  "base-ref-not-found": "source",
  "branch-invalid": "source",
  "branch-not-found": "source",
  "branch-conflict": "source",
  "workspace-create-failed": "workspace",
  "workspace-locked": "workspace",
  "workspace-invalid": "workspace",
  "runtime-create-failed": "runtime",
  "runtime-start-failed": "runtime",
  "runtime-lost": "runtime",
  "runtime-timeout": "runtime",
  "agent-start-failed": "agent",
  "agent-failed": "agent",
  "agent-timeout": "agent",
  "agent-cancelled": "agent",
  "validation-failed": "validation",
  "validation-timeout": "validation",
  "git-state-invalid": "finalization",
  "git-commit-failed": "finalization",
  "git-push-failed": "publish",
  "git-push-auth-failed": "publish",
  "git-push-rejected": "publish",
  "remote-branch-conflict": "publish",
};

export function stageForCode(code: ErrorCode): FailureStage {
  return STAGE_BY_CODE[code] ?? "agent";
}

/**
 * The single error type raised by platform-enforced lifecycle steps. It is
 * deliberately not `Error`-with-a-string: the code drives retry semantics
 * (retry agent vs retry validation vs retry publish).
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
  if (code.endsWith("-not-found") || code === "project-not-found" || code === "credential-not-found") return 404;
  if (
    code === "workspace-locked" ||
    code === "branch-conflict" ||
    code === "remote-branch-conflict" ||
    code === "task-busy" ||
    code === "task-state-invalid"
  ) {
    return 409;
  }
  if (code === "source-auth-failed" || code === "git-push-auth-failed" || code === "policy-denied") return 403;
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
  return 400;
}

/** Wraps any thrown value into a `DomainError` with a fallback code. */
export function asDomainError(err: unknown, fallback: ErrorCode, context?: string): DomainError {
  if (err instanceof DomainError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DomainError(fallback, context ? `${context}: ${message}` : message);
}

/* ------------------------------------------------------------------ */
/* Retry semantics (v11 §31)                                          */
/* ------------------------------------------------------------------ */

/** The retry a failure permits. Never a single generic "retry task". */
export type RetryKind = "agent" | "validation" | "publish" | "none";

export function retryKindForFailure(stage: FailureStage | undefined): RetryKind {
  switch (stage) {
    case "workspace":
    case "source":
    case "runtime":
    case "agent":
      return "agent";
    case "validation":
      return "validation";
    case "finalization":
      // A failed finalization leaves the workspace intact; the next agent run
      // re-inspects and re-commits, which is the honest recovery path.
      return "agent";
    case "publish":
      return "publish";
    default:
      return "none";
  }
}
