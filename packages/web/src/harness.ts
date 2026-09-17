/**
 * Local harness thread discovery (v6 §6/§11, v7 §9/§11) — the harnesses
 * that expose existing local work, shared by the Sessions page and the
 * New task pointer to it.
 *
 * Threads stay native to their harness: discovery only lists and reads
 * them; adopting one records a RuntimeSessionRef, and a different harness
 * is reached through an explicit Handoff.
 */
export interface HarnessThreadSourceMeta {
  /** Runtime kind the harness thread source is registered under. */
  kind: string;
  /** Harness name shown in tab labels and copy. */
  label: string;
  /** What the harness calls them — Claude Code "Sessions", Codex "Threads". */
  noun: string;
  /** Where the user's own work came from. */
  hint: string;
}

export const HARNESS_THREAD_SOURCES: readonly HarnessThreadSourceMeta[] = [
  { kind: "codex", label: "Codex", noun: "Threads", hint: "in the Codex CLI or IDE extension" },
  { kind: "claude-code", label: "Claude Code", noun: "Sessions", hint: "in the Claude Code CLI on this machine" },
];

/** Harness kinds that authenticate with their own account (v6 §2/v7 §2). */
export const HARNESS_NATIVE_KINDS = new Set(["codex", "claude-code"]);

/** How many threads one discovery request asks for. */
export const HARNESS_THREAD_LIMIT = 50;
