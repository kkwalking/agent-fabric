/**
 * Local harness thread discovery (v6 §6–§8).
 *
 * A port for reading *existing* harness-native threads that live on the
 * user's machine — work that started outside AgentFabric (e.g. hours of
 * Codex CLI usage). AgentFabric discovers and reads these threads through
 * the harness's own supported interface (never by parsing its private
 * files), adopts them into a Task, and hands them off to another harness.
 *
 * This is *not* a session model: threads stay native to their harness.
 * Adoption records a RuntimeSessionRef pointing at the thread so the same
 * harness can still resume it; a different harness goes through Handoff.
 */

import type { ID, RuntimeKind } from "./types.js";

/** A harness-native thread as listed by discovery (v6 §6). */
export interface HarnessThreadSummary {
  /** Opaque native thread id (also the resume reference). */
  id: string;
  /** Human title, when the harness assigned one. */
  title?: string;
  /** First-user-message preview, when available. */
  preview?: string;
  /** Working directory the thread ran in. */
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Number of turns, when the harness reports it (v6 §11). */
  turnCount?: number;
  /** Model/provider the thread used, when known. */
  model?: string;
  /** Where the thread came from (harness-reported, e.g. "vscode"/"cli"). */
  source?: string;
  /** True when the thread is already adopted into an AgentFabric task. */
  adopted?: boolean;
  /** Task that adopted this thread, when known. */
  adoptedTaskId?: ID;
}

/**
 * One flattened item of a thread's history (v6 §7): user input, agent
 * replies, tool activity, task progress — read *without* executing the
 * model again.
 */
export type HarnessThreadItem =
  | { kind: "user-message"; text: string; timestamp?: string }
  | { kind: "agent-message"; text: string; timestamp?: string }
  | { kind: "reasoning"; text: string; timestamp?: string }
  | { kind: "command"; command: string; exitCode?: number | null; output?: string; timestamp?: string }
  | {
      kind: "file-change";
      path: string;
      action: "add" | "update" | "delete";
      timestamp?: string;
    }
  | { kind: "tool-call"; tool: string; arguments?: unknown; result?: unknown; isError?: boolean; timestamp?: string }
  | { kind: "web-search"; query: string; timestamp?: string }
  | { kind: "error"; message: string; timestamp?: string };

/** One turn of an existing harness-native thread (v6 §7). */
export interface HarnessThreadTurn {
  /** The user input that started the turn, when the harness reports one. */
  userText?: string;
  /** Chronological items within the turn. */
  items: HarnessThreadItem[];
}

/** A full read of an existing harness-native thread (v6 §7). */
export interface HarnessThreadDetail extends HarnessThreadSummary {
  /** Chronological flattened history. */
  items: HarnessThreadItem[];
  /**
   * Turn-grouped history, when the harness exposes turn boundaries
   * (Codex does). Falls back to a single group derived from `items`.
   */
  turns?: HarnessThreadTurn[];
}

/** Discovery filter (v6 §6): by workspace cwd and recency. */
export interface HarnessThreadFilter {
  /** Exact working-directory match (resolved against the workspace path). */
  cwd?: string;
  /** Maximum number of threads to return. */
  limit?: number;
}

/**
 * The port a harness implements to expose its local threads (v6 §6/§7).
 * Implementations must use the harness's official thread interfaces —
 * never its internal file formats.
 */
export interface LocalHarnessThreadSource {
  readonly kind: RuntimeKind;
  listThreads(filter?: HarnessThreadFilter): Promise<HarnessThreadSummary[]>;
  readThread(threadId: string): Promise<HarnessThreadDetail>;
}

/** Input for adopting an existing harness-native thread (v6 §8). */
export interface ImportHarnessThreadInput {
  /** Harness the thread is native to (e.g. "codex"). */
  runtimeKind: RuntimeKind;
  /** Opaque native thread id from discovery. */
  threadId: string;
  /** Explicit workspace to associate; defaults to adopting the thread's cwd. */
  workspaceId?: ID;
  /** Override the task title; defaults to the thread title/preview. */
  title?: string;
  /**
   * The original ask recorded as the task prompt; defaults to the
   * thread's first user message.
   */
  prompt?: string;
  /** Runtime to pre-generate the handoff toward (e.g. pi / opencode). */
  targetRuntimeId?: ID;
  /** Extra user notes folded into the generated handoff. */
  userNotes?: string;
}

/** Result of adopting an existing harness-native thread (v6 §8). */
export interface ImportHarnessThreadResult {
  taskId: ID;
  runId: ID;
  workspaceId?: ID;
  /** Native session reference registered for the thread (same-harness resume). */
  runtimeSessionRefId?: ID;
  /** Handoff generated toward the target runtime, when requested. */
  handoffId?: ID;
}
