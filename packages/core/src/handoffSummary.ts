/**
 * Handoff checkpoint generation — the state index over the history a handoff
 * could not carry verbatim.
 *
 * ## Handoff is not context compaction
 *
 * - **Context compaction** is an *intra-session* event: the harness (pi,
 *   Claude Code, …) summarizes older turns of a live conversation to fit the
 *   model's window, then keeps going in the **same** native session.
 *   AgentFabric never does this — it belongs to the harness.
 * - **A handoff** is *inter-session*: the current native session ends, and a
 *   new one (usually on a different harness) starts from what AgentFabric
 *   carries across. It is an explicit user action, recorded as a `Handoff`.
 *
 * This module only ever produces the second. It borrows pi's *technique* for
 * writing the checkpoint (pi: packages/coding-agent/src/core/compaction/)
 * because that technique — structured checkpoint prompts, iterative updates
 * over a previous checkpoint, transient-error retries — is exactly what a
 * good state index needs.
 *
 * ## Where the checkpoint sits in a handoff
 *
 * A handoff is NOT a summary (v8). `core/handoffContext.ts` runs first:
 *
 * ```
 * covered runs → context items → atomic units → selection
 *                                  ├── recent working trajectory  (verbatim)
 *                                  ├── historical user pins       (verbatim)
 *                                  └── everything else ↓
 *                                      summarize → checkpoint    (state index)
 * ```
 *
 * Only the third branch reaches the model. Serializing the whole covered
 * range here would spend the summarization call — and the checkpoint itself —
 * restating context the handoff already carries word for word. The summary
 * representation used for that branch is deliberately aggressive (tool
 * results are clipped); the retained representation never is.
 *
 * Deliberate differences from pi's in-session compaction: pi's cut-point logic
 * (keepRecentTokens) selects what to keep in the SAME session; a handoff
 * starts a NEW native session where nothing is kept implicitly, so the
 * handoff either carries context verbatim or the checkpoint covers it. pi
 * forwards the session's thinkingLevel on reasoning models; the standalone
 * completion client here does not (AgentFabric models carry no thinking-level
 * configuration). The summarizer prompt also gains an authoritative
 * `<workspace>` block pi does not need: pi summarizes within the session's own
 * working directory, while a handoff crosses harnesses — the workspace
 * identity must be stated, never re-inferred from transcript residue.
 */
import type {
  Artifact,
  HandoffContextBundle,
  HandoffContextWindowSource,
  HandoffContent,
  HandoffUserPromptOrigin,
  Model,
  Provider,
  Run,
  RunEvent,
  Task,
  Workspace,
} from "./types.js";
import {
  CHECKPOINT_RESERVE_SHARE,
  DEFAULT_CHARS_PER_TOKEN,
  HANDOFF_RENDER_SCAFFOLDING_CHARS,
  assembleHandoffContextBundle,
  charsForTokens,
  collectHandoffContext,
  deriveHandoffFrontier,
  estimateTextTokens,
  eventText,
  formatHandoffMetadataSections,
  formatToolCall,
  frontierReserveChars,
  handoffTextCost,
  hasUserMessage,
  isEphemeralPath,
  isObj,
  matchPendingToolCall,
  resolveHandoffBudget,
  selectHandoffContext,
  toolArgs,
  truncateTextByCost,
  unretainedTurns,
  type HandoffBudgetSettings,
  type HandoffContextSelection,
  type HandoffContextSourceTurn,
  type ResolvedHandoffBudget,
} from "./handoffContext.js";

/* ------------------------------------------------------------------ */
/* Budgets: handoff body vs checkpoint output                          */
/* ------------------------------------------------------------------ */

/**
 * Room reserved inside the summarizer's own context window for prompts and
 * chat scaffolding.
 */
const PROMPT_OVERHEAD_TOKENS = 2_000;

/**
 * Output-token cap for ONE checkpoint call. This is the checkpoint budget
 * (`checkpointMaxTokens`, default 12K) — NOT the handoff budget. The handoff
 * budget only decides how much context crosses the session boundary; passing
 * it here would ask the model to write a 150K-token "summary", which is the
 * failure mode this split exists to prevent (v8 §6.2).
 */
export function checkpointOutputTokenCap(input: {
  /** Configured checkpoint output budget (defaults to 12K). */
  checkpointMaxTokens?: number;
  /** Context window of the model writing the checkpoint, when known. */
  summarizerContextWindow?: number;
  /** Cap from the model's parameters, when configured (pi: model.maxTokens). */
  modelMaxTokens?: number;
}): number {
  const base = input.checkpointMaxTokens && input.checkpointMaxTokens > 0 ? input.checkpointMaxTokens : 12_000;
  const window = input.summarizerContextWindow ?? 0;
  // Never more than half of a known window (pi's guard): a fixed cap would not
  // fit a small-window model.
  const capped = window > 0 ? Math.min(base, Math.floor(window / 2)) : base;
  return input.modelMaxTokens && input.modelMaxTokens > 0 ? Math.min(capped, input.modelMaxTokens) : capped;
}

export interface SummarizerBudget {
  /** Context window of the model that writes the checkpoint. */
  contextWindow: number;
  /** Output-token cap for one checkpoint call (`checkpointOutputTokenCap`). */
  maxOutputTokens: number;
  charsPerToken: number;
}

/**
 * Character budget for one summarization call's transcript — how much of the
 * unretained history fits in a single checkpoint call. Exposed for tests and
 * preview tooling.
 */
export function summarizationInputBudgetChars(budget: SummarizerBudget): number {
  const charsPerToken = budget.charsPerToken > 0 ? budget.charsPerToken : 2;
  const window = budget.contextWindow > 0 ? budget.contextWindow : 128_000;
  const inputTokens = Math.max(window - budget.maxOutputTokens - PROMPT_OVERHEAD_TOKENS, 1_000);
  return inputTokens * charsPerToken;
}

/** The summarizer-side view of one generation's budgets. */
export function summarizerBudget(
  handoff: ResolvedHandoffBudget,
  summarizerContextWindow: number | undefined,
  modelMaxTokens: number | undefined
): SummarizerBudget {
  return {
    contextWindow: summarizerContextWindow ?? handoff.contextWindow,
    maxOutputTokens: checkpointOutputTokenCap({
      checkpointMaxTokens: handoff.checkpointMaxTokens,
      summarizerContextWindow,
      modelMaxTokens,
    }),
    charsPerToken: handoff.charsPerToken,
  };
}

/* ------------------------------------------------------------------ */
/* Prompts (pi: core/compaction/compaction.ts + utils.ts, verbatim)    */
/* ------------------------------------------------------------------ */

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user — as SHORT references only (e.g. "start/upload must take -P; see preserved user constraints"), never copied out in full: the handoff carries the user's own words verbatim in a separate preserved section, so restating them wastes the checkpoint]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

This checkpoint is the HISTORICAL state index: it will be read together with a more recent verbatim trajectory that supersedes its status. Record what was true at this point in the history.

Keep each section concise. Preserve exact repository-relative file paths, function names, and error messages. Omit ephemeral temporary paths (/tmp/…, /var/folders/… scratch files) unless the work still depends on them. Text labelled [User] in the transcript arrived through the source harness's user turn and may include harness-generated wrappers or attachment metadata — attribute only clear requests to the user.`;

export const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- In "Constraints & Preferences", keep constraints as SHORT references only (the handoff carries the user's own words verbatim in a separate preserved section; never copy them out in full)
- PRESERVE exact repository-relative file paths, function names, and error messages
- Omit ephemeral temporary paths (/tmp/…, /var/folders/… scratch files) unless the work still depends on them
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered — as short references, never full copies]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

This checkpoint is the HISTORICAL state index: it will be read together with a more recent verbatim trajectory that supersedes its status. Keep each section concise.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/* ------------------------------------------------------------------ */
/* Conversation serialization (pi: compaction/utils.ts serializeConversation) */
/* ------------------------------------------------------------------ */

/**
 * Maximum characters for a tool result in a SERIALIZED SUMMARY.
 *
 * Summary representation only. This cap exists because the summarizer only
 * needs the shape of a tool result to write a state index, and pi clamps tool
 * results the same way. It is never applied to retained handoff context: a
 * recent test result that fails at the end must reach the next harness
 * intact. Retained slices are only shortened by the explicit oversized policy
 * in `handoffContext.ts` (tail-biased head+tail), never by this number.
 */
const SUMMARY_TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum cost for summarization.
 *
 * Keeps the beginning AND the end (head 20% / tail 80%, like the retained
 * policy) rather than the head alone. An oversized historical turn puts its
 * conclusion, its final failure and its architecture decision at the END, and
 * a head-only cut dropped exactly the information the checkpoint exists to
 * carry (v9 §9). The result never exceeds `maxCost`.
 */
function truncateForSummary(
  text: string,
  maxCost: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN
): string {
  return truncateTextByCost(
    text,
    maxCost,
    charsPerToken,
    (omitted) => `\n\n[... ${omitted} more characters truncated]\n\n`
  );
}

interface SerializedPart {
  kind: "user" | "assistant" | "thinking" | "toolCalls" | "toolResult";
  text: string;
  /**
   * The part was only PARTIALLY retained in the handoff, so the checkpoint is
   * the only representation of what retention dropped. It reaches the
   * summarizer in full instead of under the summary-only cap (v9 §4).
   */
  preserve?: boolean;
}

/**
 * Serialize a run's events into pi's summarization transcript format:
 * `[User]: …`, `[Assistant]: …`, `[Assistant thinking]: …`,
 * `[Assistant tool calls]: name(k=v)`, `[Tool result]: …`.
 *
 * RunEvents are the flat event log, so adjacent `shell.output` lines are
 * accumulated into a single tool-result part (the harness emitted them
 * as one command's output). Orchestrator `log` events are excluded:
 * they are AgentFabric's own bookkeeping (config injection, policy
 * warnings, harness stderr), not the agent's conversation — folding
 * them in leaked server-side absolute paths into the summary input,
 * which the summarizer then mistook for the project identity. A
 * `tool.started` renders its call and the
 * matching `tool.completed` closes it with the result only, so one tool
 * call serializes once — like pi's toolCall blocks. Consecutive tool
 * calls join with `; ` and consecutive thinking parts with `\n`, the way
 * pi renders them within one assistant message. Tool results are
 * truncated to SUMMARY_TOOL_RESULT_MAX_CHARS exactly like pi.
 *
 * The serialization is split so a handoff can cover several runs as one
 * transcript: `collectConversationParts` renders a single run's events,
 * and `serializeRunChain` stitches the runs since the last checkpoint
 * together (see `SummarizedTurn`).
 */

/**
 * One run's contribution to a multi-run handoff transcript — the same runs the
 * context bundle covers, so this is the context module's source-turn shape.
 *
 * `userPrompt` is the run's bare user input (v5 §5). Real harnesses do not
 * echo the user's turn back as an event — only the `mock` adapter emits a
 * user-role `agent.message` — so without this the summarizer never sees
 * what the user actually asked on any turn after the first, and the
 * checkpoint can only restate the original task.
 */
export type SummarizedTurn = HandoffContextSourceTurn;

/** Collect one run's events as pi-style transcript parts (no leading user turn). */
function collectConversationParts(events: RunEvent[], preserveEventIds?: ReadonlySet<string>): SerializedPart[] {
  const parts: SerializedPart[] = [];
  let pendingShellOutput: string[] = [];
  let pendingShellPreserve = false;
  const flushShell = () => {
    if (pendingShellOutput.length) {
      parts.push({
        kind: "toolResult",
        text: pendingShellOutput.join("\n"),
        ...(pendingShellPreserve ? { preserve: true } : {}),
      });
      pendingShellOutput = [];
      pendingShellPreserve = false;
    }
  };

  // A completion pairs with its started call: by native toolCallId when the
  // runtime provides one, else by matching the pending call with the same tool
  // and target (never by tool name alone — two `read`s are two calls).
  const openNativeIds = new Set<string>();
  const pendingCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const nativeIdOf = (e: RunEvent): string | undefined => {
    const id = e.data?.toolCallId ?? e.data?.callID ?? e.data?.callId;
    return typeof id === "string" && id ? `id:${id}` : undefined;
  };

  for (const e of events) {
    switch (e.type) {
      case "agent.message": {
        flushShell();
        const content = eventText(e, ["content", "text", "message"]);
        if (!content) break;
        const role = e.data?.role;
        if (role === "assistant" || role === undefined || role === "system") {
          // pi serializes assistant text; system-ish profile lines are
          // folded in as assistant context (they are part of what the
          // next agent should know, but pi never emits a [System] part).
          parts.push({ kind: "assistant", text: content });
        } else if (role === "user") {
          parts.push({ kind: "user", text: content });
        }
        break;
      }
      case "agent.thinking": {
        flushShell();
        const content = eventText(e, ["content", "text", "thinking"]);
        if (content) parts.push({ kind: "thinking", text: content });
        break;
      }
      case "tool.started": {
        flushShell();
        const tool = eventText(e, ["tool", "toolName"]) ?? "tool";
        const args = toolArgs(e);
        parts.push({ kind: "toolCalls", text: formatToolCall(tool, args) });
        const nativeId = nativeIdOf(e);
        if (nativeId) openNativeIds.add(nativeId);
        else pendingCalls.push({ tool, args });
        break;
      }
      case "tool.completed": {
        flushShell();
        const tool = eventText(e, ["tool", "toolName"]) ?? "tool";
        const args = toolArgs(e);
        const nativeId = nativeIdOf(e);
        let paired: boolean;
        if (nativeId) {
          paired = openNativeIds.delete(nativeId);
        } else {
          const match = matchPendingToolCall(pendingCalls, { tool, args });
          paired = match >= 0;
          if (paired) pendingCalls.splice(match, 1);
        }
        if (!paired) {
          // No matching start (e.g. OpenCode only reports terminal
          // states): the completed event itself carries the call.
          parts.push({ kind: "toolCalls", text: formatToolCall(tool, args) });
        }
        const result = eventText(e, ["output", "result", "error"]);
        if (result) {
          parts.push({
            kind: "toolResult",
            text: result,
            ...(preserveEventIds?.has(e.id) ? { preserve: true } : {}),
          });
        }
        break;
      }
      case "shell.command": {
        flushShell();
        const command = eventText(e, ["command"]);
        if (command) parts.push({ kind: "toolCalls", text: formatToolCall("bash", { command }) });
        break;
      }
      case "shell.output": {
        const line = eventText(e, ["line", "message"]);
        if (line) {
          pendingShellOutput.push(line);
          if (preserveEventIds?.has(e.id)) pendingShellPreserve = true;
        }
        break;
      }
      default:
        break;
    }
  }
  flushShell();
  return parts;
}

/**
 * Coalesce runs of like parts the way pi renders one assistant message
 * (thinking blocks join with newlines, tool calls with `; `) and render
 * the transcript labels.
 */
function renderConversationParts(parts: SerializedPart[]): string {
  const coalesced: SerializedPart[] = [];
  for (const p of parts) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.kind === p.kind && (p.kind === "toolCalls" || p.kind === "thinking")) {
      last.text += (p.kind === "toolCalls" ? "; " : "\n") + p.text;
      if (p.preserve) last.preserve = true;
    } else {
      coalesced.push({ ...p });
    }
  }

  const rendered = coalesced.map((p) => {
    switch (p.kind) {
      case "user":
        return `[User]: ${p.text}`;
      case "assistant":
        return `[Assistant]: ${p.text}`;
      case "thinking":
        return `[Assistant thinking]: ${p.text}`;
      case "toolCalls":
        return `[Assistant tool calls]: ${p.text}`;
      case "toolResult":
        // A partially-retained result is the checkpoint's only copy of what
        // retention dropped, so it is not capped here.
        return `[Tool result]: ${p.preserve ? p.text : truncateForSummary(p.text, SUMMARY_TOOL_RESULT_MAX_CHARS)}`;
    }
  });
  return rendered.join("\n\n");
}

export function serializeRunConversation(
  events: RunEvent[],
  task?: Task,
  preserveEventIds?: ReadonlySet<string>
): string {
  const parts = collectConversationParts(events, preserveEventIds);
  // The task prompt is the conversation's opening user message; runs
  // may not echo it back as an agent.message event.
  if (task && !hasUserMessage(events)) {
    parts.unshift({ kind: "user", text: taskLabel(task) });
  }
  return renderConversationParts(parts);
}

/**
 * Serialize several runs as ONE pi transcript — the handoff's actual
 * coverage. Every run contributes its bare user input (`userPrompt`), so
 * the summarizer sees each intermediate request instead of only the
 * original task, and the runs read as one continuous conversation exactly
 * like pi's iterative compaction over a single session.
 *
 * `task` is only a fallback for a first turn with no recorded
 * `userPrompt` (e.g. an imported thread whose turns predate the field).
 */
export function serializeRunChain(
  turns: SummarizedTurn[],
  task?: Task,
  preserveEventIds?: ReadonlySet<string>
): string {
  const parts: SerializedPart[] = [];
  turns.forEach((turn, index) => {
    if (!hasUserMessage(turn.events)) {
      const text = turn.userPrompt?.trim() || (index === 0 && task ? taskLabel(task) : "");
      if (text) parts.push({ kind: "user", text });
    }
    parts.push(...collectConversationParts(turn.events, preserveEventIds));
  });
  return renderConversationParts(parts);
}

/* ------------------------------------------------------------------ */
/* File operation tracking (pi: compaction/utils.ts, verbatim logic)   */
/* ------------------------------------------------------------------ */

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Tool names treated as read/write/edit (pi matches read/write/edit). */
const READ_TOOLS = new Set(["read", "read_file", "readfile"]);
const WRITE_TOOLS = new Set(["write", "write_file", "writefile"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "apply_patch", "str_replace"]);

/**
 * Parse the appended XML file tags back out of a checkpoint. Pi tracks
 * these as structured details on the compaction entry; AgentFabric
 * stores them only inside the summary text.
 */
export function parseFileListTags(summary: string): { readFiles: string[]; modifiedFiles: string[] } {
  const readMatch = /<read-files>\n([\s\S]*?)\n<\/read-files>/.exec(summary);
  const modifiedMatch = /<modified-files>\n([\s\S]*?)\n<\/modified-files>/.exec(summary);
  return {
    readFiles: (readMatch?.[1].split("\n") ?? []).filter(Boolean),
    modifiedFiles: (modifiedMatch?.[1].split("\n") ?? []).filter(Boolean),
  };
}

/**
 * Extract file operations from a run's events — pi extracts them from
 * assistant toolCall blocks; AgentFabric's equivalent records are
 * tool events plus the workspace-change events (file.created → written,
 * file.modified → edited). When a previous checkpoint is given, its
 * file lists seed the sets (read-files → read, modified-files → edited)
 * exactly like pi merging the previous compaction's details, so the
 * lists accumulate across iterative updates instead of restarting per
 * run.
 */
export function extractFileOperations(events: RunEvent[], previousSummary?: string): FileOperations {
  const fileOps = createFileOps();
  if (previousSummary) {
    const prev = parseFileListTags(previousSummary);
    for (const f of prev.readFiles) fileOps.read.add(f);
    for (const f of prev.modifiedFiles) fileOps.edited.add(f);
  }
  /** The file an event acted on, whether it is a top-level or an arg field. */
  const pathOf = (e: RunEvent): string | undefined => {
    const direct = eventText(e, ["path", "file"]);
    if (direct) return direct;
    // OpenCode/pi carry the path inside the tool input; without this the
    // checkpoint's file list missed every read and edit on those runtimes.
    const args = toolArgs(e);
    for (const key of ["path", "file_path", "filepath", "file", "target"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  for (const e of events) {
    const path = pathOf(e);
    if (!path) continue;
    switch (e.type) {
      case "file.created":
        fileOps.written.add(path);
        break;
      case "file.modified":
        fileOps.edited.add(path);
        break;
      case "tool.started":
      case "tool.completed": {
        const tool = (eventText(e, ["tool", "toolName"]) ?? "").toLowerCase();
        if (READ_TOOLS.has(tool)) fileOps.read.add(path);
        else if (WRITE_TOOLS.has(tool)) fileOps.written.add(path);
        else if (EDIT_TOOLS.has(tool)) fileOps.edited.add(path);
        break;
      }
      default:
        break;
    }
  }
  return fileOps;
}

/**
 * Compute final file lists from file operations (pi: verbatim).
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 * Ephemeral paths (OS temp dirs, runtime scratch) are dropped (v10 §22): they
 * exist only in the source environment and would pollute the checkpoint with
 * paths the receiving harness can do nothing with.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const durable = (paths: Set<string>) => [...paths].filter((f) => !isEphemeralPath(f));
  const modified = new Set(durable(fileOps.edited).concat(durable(fileOps.written)));
  const readOnly = durable(fileOps.read).filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

/** Format file operations as XML tags for summary (pi: verbatim). */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/* ------------------------------------------------------------------ */
/* LLM completion (pi: completeSimple via pi-ai)                       */
/* ------------------------------------------------------------------ */

export interface CompletionRequest {
  systemPrompt: string;
  /** Single user message containing the wrapped conversation + prompt. */
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  text: string;
  stopReason: "stop" | "length" | "error" | "aborted";
  errorMessage?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type CompletionFn = (req: CompletionRequest) => Promise<CompletionResponse>;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * Block types that carry a model's chain of thought rather than its
 * answer. The Responses API puts them in *separate* `reasoning` items
 * (as `summary_text` / `reasoning_text` blocks) that sit between the
 * assistant's `message` items, so a naive "any block with a `text`
 * field" read interleaves the model's private deliberation with — and
 * sometimes inside — the checkpoint.
 */
const REASONING_BLOCK_TYPES = new Set([
  "reasoning",
  "reasoning_text",
  "summary_text",
  "thinking",
  "redacted_thinking",
]);

/** Concatenate the answer blocks of one message item, skipping reasoning. */
function answerText(blocks: unknown[]): string {
  return blocks
    .filter((b): b is { type?: unknown; text: string } => isObj(b) && typeof b.text === "string")
    .filter((b) => !REASONING_BLOCK_TYPES.has(String(b.type ?? "")))
    .map((b) => b.text)
    .join("");
}

/**
 * Minimal standalone completion client honoring AgentFabric Provider
 * wire formats. This is AgentFabric's counterpart of pi's
 * `completeSimple` one-off summary call (no tools offered, no prompt
 * caching). `custom` providers have no known wire format and are
 * rejected so the caller can fall back.
 */
export function createHttpCompletionFn(
  provider: Provider,
  model: Model,
  apiKey?: string
): CompletionFn {
  const type = provider.type;
  if (type === "custom") {
    return async () => {
      throw new Error(`Provider "${provider.name}" has wire format "custom" — cannot generate a handoff summary`);
    };
  }

  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(provider.headers ?? {}),
  };

  return async (req) => {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), HANDOFF_SUMMARY_TIMEOUT_MS);

    let url: string;
    let body: Record<string, unknown>;
    let headers = { ...baseHeaders };
    if (type === "anthropic") {
      url = joinUrl(provider.baseUrl ?? "https://api.anthropic.com", "/v1/messages");
      headers = {
        ...headers,
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
        ...(apiKey ? {} : { "x-api-key-dummy": "none" }),
      };
      body = {
        model: model.name,
        max_tokens: req.maxTokens,
        system: req.systemPrompt,
        messages: [{ role: "user", content: req.prompt }],
      };
    } else {
      // openai-responses / openai-completions / openai / openai-compatible
      const base = provider.baseUrl ?? "https://api.openai.com/v1";
      if (type === "openai-responses") {
        url = joinUrl(base, "/responses");
        body = {
          model: model.name,
          max_output_tokens: req.maxTokens,
          instructions: req.systemPrompt,
          input: req.prompt,
        };
      } else {
        url = joinUrl(base, "/chat/completions");
        body = {
          model: model.name,
          max_tokens: req.maxTokens,
          messages: [
            { role: "system", content: req.systemPrompt },
            { role: "user", content: req.prompt },
          ],
        };
      }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      return { text: "", stopReason: "error", errorMessage: String(err) };
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener("abort", onOuterAbort);
    }
    if (!res.ok) {
      return {
        text: "",
        stopReason: "error",
        errorMessage: `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
      };
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;

    if (type === "anthropic") {
      const text = (json.content ?? [])
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      return {
        text,
        stopReason: json.stop_reason === "max_tokens" ? "length" : "stop",
        usage: json.usage
          ? { inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 }
          : undefined,
      };
    }
    if (type === "openai-responses") {
      // `output` interleaves `reasoning` items with the assistant's
      // `message` items. Only message items are the answer; a reasoning
      // item's `summary`/`content` is the model's deliberation, and
      // reading it made the summarizer's own draft (and its "let me …"
      // commentary) part of the stored checkpoint.
      const messages = (json.output ?? []).filter(
        (o: any) => isObj(o) && (o.type === "message" || (o.type === undefined && Array.isArray(o.content)))
      );
      const text = messages.map((o: any) => answerText(o.content ?? [])).filter(Boolean).join("\n");
      const incomplete = json.status === "incomplete";
      return {
        text,
        stopReason: incomplete ? "length" : "stop",
        usage: json.usage
          ? { inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 }
          : undefined,
      };
    }
    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    // `reasoning_content` (DeepSeek and friends) is a *separate* field and
    // is deliberately never read; some OpenAI-compatible providers instead
    // return `content` as typed blocks, where `reasoning` blocks must be
    // dropped and `text` blocks concatenated.
    const text: string =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? answerText(message.content)
          : "";
    return {
      text,
      stopReason: choice?.finish_reason === "length" ? "length" : "stop",
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
        : undefined,
    };
  };
}

/**
 * Safety cap for the one-off summary call (pi relies on the caller's signal).
 * Sized for slow reasoning models: a thinking summarizer can legitimately
 * need minutes on a full chunk, so this sits above their typical latency and
 * only cuts off genuinely stalled calls.
 */
const HANDOFF_SUMMARY_TIMEOUT_MS = 240_000;

/**
 * Default total budget for ONE handoff generation, covering every chunk and
 * retry. The per-attempt cap above bounds a single call; without a total
 * budget a chunked generation is unbounded (N sequential calls), and a
 * `continue` request would hang on it. Kept above twice the per-attempt cap
 * so a single-chunk generation is bounded by the attempt cap, not by this
 * budget. Overridable per call via `HandoffSummaryInput.timeoutMs`.
 */
export const HANDOFF_GENERATION_BUDGET_MS = 600_000;

/* ------------------------------------------------------------------ */
/* Retry (pi: pi-ai utils/retry.ts retryAssistantCall + settings.retry */
/* defaults — 3 retries, 2s base, exponential backoff)                 */
/* ------------------------------------------------------------------ */

export interface SummaryRetryPolicy {
  enabled: boolean;
  /** Max retry attempts (0 = no retries); the initial call never counts. */
  maxRetries: number;
  /** Base delay in ms; per-attempt delay is baseDelayMs × 2^(attempt−1). */
  baseDelayMs: number;
}

export const DEFAULT_SUMMARY_RETRY_POLICY: SummaryRetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};

/** Subscription/quota/billing exhaustion — deterministic, never retried (pi). */
const NON_RETRYABLE_LIMIT_PATTERN = new RegExp(
  [
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "Monthly usage limit reached",
    "available balance",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
  ].join("|"),
  "i"
);

/** Transient provider/transport failures — retried (pi, verbatim patterns). */
const RETRYABLE_PATTERN = new RegExp(
  [
    "overloaded",
    "rate.?limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "524",
    "service.?unavailable",
    "server.?error",
    "internal.?error",
    "provider.?returned.?error",
    "exceeded request buffer limit while retrying upstream",
    "network.?error",
    "connection.?error",
    "connection.?refused",
    "connection.?lost",
    "other side closed",
    "fetch failed",
    "getaddrinfo",
    "ENOTFOUND",
    "EAI_AGAIN",
    "upstream.?connect",
    "reset before headers",
    "socket hang up",
    "socket connection was closed",
    "timed? out",
    "timeout",
    "terminated",
    "websocket.?closed",
    "websocket.?error",
    "ended without",
    "stream ended before message_stop",
    "stream ended before a terminal response event",
    "http2 request did not get a response",
    "retry delay",
    "you can retry your request",
    "try your request again",
    "please retry your request",
    "ResourceExhausted",
  ].join("|"),
  "i"
);

/** Classify a failed completion as transient (pi: isRetryableAssistantError). */
export function isRetryableCompletionError(response: CompletionResponse): boolean {
  if (response.stopReason !== "error" || !response.errorMessage) return false;
  if (NON_RETRYABLE_LIMIT_PATTERN.test(response.errorMessage)) return false;
  return RETRYABLE_PATTERN.test(response.errorMessage);
}

function sleep(ms: number, signal?: AbortSignal): Promise<"ok" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("aborted");
    const timeout = setTimeout(() => resolve("ok"), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve("aborted");
    }, { once: true });
  });
}

/**
 * Run the one-off summary call with bounded retry on transient errors
 * (pi: retryAssistantCall). Success, aborts and non-error stops are
 * terminal; deterministic errors fail fast; transient errors back off
 * exponentially, and an abort during backoff normalizes to an aborted
 * response.
 */
export async function retryCompletion(
  produce: () => Promise<CompletionResponse>,
  policy: SummaryRetryPolicy | undefined,
  signal?: AbortSignal
): Promise<CompletionResponse> {
  const maxAttempts = policy?.enabled ? policy.maxRetries : 0;
  let attempt = 0;
  for (;;) {
    const response = await produce();
    if (response.stopReason !== "error") return response;
    if (attempt >= maxAttempts || !isRetryableCompletionError(response)) return response;
    attempt++;
    const delayMs = policy!.baseDelayMs * 2 ** (attempt - 1);
    if ((await sleep(delayMs, signal)) === "aborted") {
      return { ...response, text: "", stopReason: "aborted" };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Summarization (pi: generateSummaryWithUsage)                        */
/* ------------------------------------------------------------------ */

/**
 * Authoritative workspace statement for the summarizer (AgentFabric
 * addition — pi has no counterpart). Without it the summarizer fills
 * the "current project" from transcript residue (harness config lines,
 * incidental absolute paths) and can name the wrong project.
 */
export function formatWorkspaceBlock(workspace: Workspace): string {
  const where = workspace.path ?? workspace.repoUrl ?? "unknown location";
  return (
    `<workspace>\n` +
    `Workspace "${workspace.name}" (${workspace.type}) at ${where}.\n` +
    `The conversation took place inside this directory — it is the "current project" the user refers to. ` +
    `Relative file paths in the transcript resolve against it; do not infer the project from incidental absolute paths in harness output.\n` +
    `</workspace>`
  );
}

/**
 * Build the summarization user prompt: conversation wrapped in tags,
 * the authoritative workspace block, optional previous summary, then
 * the base prompt (pi: verbatim structure, plus the workspace block).
 * Exposed for tests and preview tooling.
 */
export function buildSummarizationPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string,
  workspace?: Workspace
): string {
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }

  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (workspace) {
    promptText += `${formatWorkspaceBlock(workspace)}\n\n`;
  }
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;
  return promptText;
}

/**
 * Returns an error message when a summarization response cannot safely
 * be used (pi: getSummarizationFailure — error/length stops produce
 * partial text that must not become a checkpoint).
 */
export function getSummarizationFailure(response: CompletionResponse, label: string): string | undefined {
  if (response.stopReason === "error") {
    return `${label} failed: ${response.errorMessage || "Unknown error"}`;
  }
  if (response.stopReason === "length") {
    return `${label} failed: generation hit the token cap and the summary is incomplete`;
  }
  return undefined;
}

/**
 * Reduce a completion to the one checkpoint it is supposed to carry.
 *
 * The format's first legal token is the `## Goal` heading; the system
 * prompt forbids anything else. Two leaks have to be survived, because a
 * malformed answer must never reach the next agent as context:
 *
 * - **A preamble.** Models prepend chain-of-thought ("Let me analyze this
 *   conversation…") before the heading. Everything before the first
 *   section goes.
 * - **Several drafts in one answer.** Models that deliberate in the
 *   visible channel write a draft checkpoint, comment on it, then write
 *   the real one. The last `## Goal`-rooted block is the answer; earlier
 *   ones are drafts (and when a provider interleaves reasoning, its
 *   leaked draft).
 *
 * A summary with no `## ` section at all is kept as-is: there is nothing
 * to distinguish reasoning from a (malformed) summary.
 *
 * Applied once, at generation time. Nothing downstream re-parses a stored
 * checkpoint: what is in the record is what the next agent gets, so a bad
 * record is discarded and regenerated rather than repaired on read
 * (AGENTS.md: "No compatibility logic for old data").
 */
export function extractCheckpoint(summary: string): string {
  const trimmed = summary.trim();
  const drafts = [...trimmed.matchAll(/^##[ \t]+Goal\b.*$/gim)];
  if (drafts.length > 0) {
    return trimmed.slice(drafts[drafts.length - 1].index).trim();
  }
  const firstSection = /^##\s/m.exec(trimmed);
  return firstSection ? trimmed.slice(firstSection.index).trim() : trimmed;
}

/**
 * The transcript's opening user line and the handoff's "original task".
 * Tasks whose title defaults to the prompt would render it twice —
 * `#fix the tests: fix the tests` — so the prompt is only appended when
 * it adds something.
 */
export function taskLabel(task: Task): string {
  return task.title === task.prompt ? `#${task.title}` : `#${task.title}: ${task.prompt}`;
}

/**
 * Raised when the handoff's fixed sections (user notes plus render metadata)
 * cannot fit the configured handoff budget at all. It is a deterministic
 * configuration/input error, not a provider failure: retrying or degrading to
 * a heuristic digest would not make the payload fit, so it fails loudly
 * instead of reporting a size the rendered handoff does not honour (v9 §6).
 */
export class HandoffBudgetExceededError extends Error {
  readonly code = "handoff-budget-exceeded";
  constructor(readonly detail: string) {
    super(`Handoff budget exceeded: ${detail}`);
    this.name = "HandoffBudgetExceededError";
  }
}

export interface HandoffSummaryInput {
  task: Task;
  run: Run;
  /**
   * Every event the handoff covers. With `turns` this is the
   * concatenation of their events (file-operation tracking runs over it);
   * without it, a single run's events.
   */
  events: RunEvent[];
  /**
   * The ordered runs this handoff covers — everything since the last
   * checkpoint, ending with `run`. Omitted for a single-run handoff.
   */
  turns?: SummarizedTurn[];
  artifacts: Artifact[];
  workspace?: Workspace;
  runtimeName?: string;
  /** Checkpoint the covered runs continue from (pi: iterative update). */
  previousSummary?: string;
  /** Optional custom focus (pi: customInstructions). */
  customInstructions?: string;
  complete: CompletionFn;
  /** Handoff context budget knobs (see `HandoffBudgetSettings`). */
  settings?: HandoffBudgetSettings;
  /**
   * Context window of the TARGET model — the model that will read this
   * handoff. Drives the handoff budget. Unknown → `settings.contextWindow` →
   * the configured default; never guessed from a model name.
   */
  targetContextWindow?: number;
  /**
   * Where the target context window came from (v10 §23), resolved by the
   * caller beside the window itself; recorded in the budget for Inspector
   * diagnostics. Overridden by an explicit `settings.contextWindowSource`.
   */
  contextWindowSource?: HandoffContextWindowSource;
  /**
   * Provenance of the task brief (v10 §6): harness-reported when the task was
   * adopted from a source harness's native thread (its brief may embed
   * harness wrappers), user-authored otherwise.
   */
  taskPromptProvenance?: HandoffUserPromptOrigin;
  /** Retry policy for the summary call (pi: settings.retry; default 3/2s). */
  retry?: SummaryRetryPolicy;
  /** Cap from the model's parameters, when configured (pi: model.maxTokens). */
  modelMaxTokens?: number;
  /**
   * Context window of the SUMMARIZER model, when configured. Only bounds the
   * checkpoint call's input/output; it has nothing to do with the handoff
   * budget.
   */
  modelContextWindow?: number;
  /**
   * User-provided handoff notes. They are part of the rendered handoff body,
   * so they are counted in the budget and the selector makes room for them
   * (v9 §6). Notes that alone exceed the whole handoff budget fail loudly
   * instead of silently overflowing.
   */
  userNotes?: string;
  /**
   * Caller cancellation. Aborting it (client disconnect, explicit cancel)
   * stops the in-flight summary call and the retry backoff.
   */
  signal?: AbortSignal;
  /**
   * Total wall-clock budget for the whole generation (all chunks, all
   * retries). `0`/omitted = no total budget beyond the per-call cap.
   */
  timeoutMs?: number;
}

export interface HandoffSummaryResult {
  /**
   * The structured checkpoint (state index + file XML tags) covering the
   * history that was NOT carried verbatim. Absent when the whole covered
   * history fit in the retained context and no earlier checkpoint was carried
   * forward — nothing needed summarizing.
   */
  checkpoint?: string;
  /** The stored handoff content: parsed projection + the context bundle. */
  content: HandoffContent;
  /** The assembled bundle (also `content.contextBundle`). */
  contextBundle: HandoffContextBundle;
  usage?: { inputTokens: number; outputTokens: number };
  /** Summarization calls used; > 1 when the unretained history was chunked. */
  chunks: number;
  /** What selection kept, for tests and audit (not stored separately). */
  selection: HandoffContextSelection;
}

/**
 * Split the runs the checkpoint must cover into as few chunks as fit the
 * summarization input budget. Chunking keeps the *order* of runs: each chunk is
 * summarized and its checkpoint becomes the next chunk's `<previous-summary>`,
 * so the final checkpoint still covers every run — pi's iterative update
 * applied within a single generation. A single turn larger than the budget gets
 * a chunk of its own (the caller truncates it).
 */
export function chunkTurns(
  turns: SummarizedTurn[],
  task: Task | undefined,
  budgetChars: number,
  preserveEventIds?: ReadonlySet<string>
): SummarizedTurn[][] {
  if (turns.length === 0) return [];
  if (budgetChars <= 0) return [turns];
  const chunks: SummarizedTurn[][] = [];
  let current: SummarizedTurn[] = [];
  let size = 0;
  for (const turn of turns) {
    const cost = serializeRunChain([turn], task, preserveEventIds).length;
    if (current.length > 0 && size + cost > budgetChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(turn);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Generate a handoff: select what crosses the boundary verbatim, summarize the
 * rest into a checkpoint, and assemble both into one context bundle.
 *
 * ```
 * covered runs → normalize → select ─┬─ pinned/retained context (verbatim)
 *                                    └─ unretained turns → chunk → LLM → checkpoint
 * ```
 *
 * The selection runs before the model call, and the calls made for the
 * checkpoint's own output budget are deliberately small: the handoff budget
 * decides how much context crosses the boundary, never how long the state
 * index may be (v8 §6.2).
 *
 * The whole generation is cancellable: the caller's `signal` (client
 * disconnect / explicit cancel) and the total `timeoutMs` budget both abort the
 * in-flight call and the retry backoff, and the thrown message says which
 * fired. Other failures throw too — callers decide between erroring and an
 * explicit degraded mode.
 */
export async function generateHandoffSummary(input: HandoffSummaryInput): Promise<HandoffSummaryResult> {
  const { task, run, events, artifacts, workspace, complete } = input;
  const budget = resolveHandoffBudget({
    ...(input.settings ?? {}),
    ...(input.settings?.contextWindow ? {} : { contextWindow: input.targetContextWindow }),
    ...(input.settings?.contextWindowSource
      ? {}
      : input.contextWindowSource
        ? { contextWindowSource: input.contextWindowSource }
        : {}),
  });
  const charsPerToken = budget.charsPerToken;
  const summarizer = summarizerBudget(budget, input.modelContextWindow, input.modelMaxTokens);
  const budgetChars = summarizationInputBudgetChars(summarizer);

  const turns: SummarizedTurn[] =
    input.turns && input.turns.length > 0 ? input.turns : [{ events, userPrompt: run.userPrompt, runId: run.id }];
  if (turns.length === 0) throw new Error("Handoff has no runs to cover");

  // 1. Normalize + select. Whatever survives verbatim is excluded from the
  //    checkpoint's input below, so no context is both kept and summarized.
  const collected = collectHandoffContext(turns, {
    taskPrompt: task.prompt,
    ...(input.taskPromptProvenance ? { taskPromptProvenance: input.taskPromptProvenance } : {}),
    // Only a shared workspace makes a local read reconstructable (v8 §16/§25).
    sharedWorkspace: Boolean(workspace),
    charsPerToken,
  });
  // The checkpoint allowance is reserved at its CAP, not at its (unknown)
  // final size: selection happens before the model call. A checkpoint smaller
  // than its cap simply leaves the handoff below budget, and one whose cap
  // would swallow the whole handoff is bounded by CHECKPOINT_RESERVE_SHARE —
  // the fallback representation may never crowd out the trajectory itself.
  const totalChars = charsForTokens(budget.maxTokens, charsPerToken);
  const previousSummaryCost = input.previousSummary ? handoffTextCost(input.previousSummary, charsPerToken) : 0;
  const checkpointReserveChars = Math.min(
    Math.max(charsForTokens(budget.checkpointMaxTokens, charsPerToken), previousSummaryCost),
    Math.floor(totalChars * CHECKPOINT_RESERVE_SHARE)
  );
  // The current frontier (v10 §5) is derived AFTER selection, so its (small,
  // capped) allowance is reserved up front exactly like the checkpoint's —
  // scaled down for small budgets so the trajectory keeps its room.
  const frontierReserve = frontierReserveChars(totalChars);
  // The other non-bundle sections the renderer writes (workspace, previous
  // run, artifacts) are generation-time facts, so the reserve is exact for
  // them, plus a fixed allowance for the render scaffolding itself.
  const metadataChars =
    handoffTextCost(
      formatHandoffMetadataSections(
        handoffMetadataFields({ run, artifacts, workspace, runtimeName: input.runtimeName })
      ),
      charsPerToken
    ) + HANDOFF_RENDER_SCAFFOLDING_CHARS;
  // User notes are rendered into the body, so they are reserved here and the
  // selector must leave room for them (v9 §6). Notes that alone exceed the
  // whole budget cannot be honoured by any selection, and failing loudly is
  // the only honest outcome.
  const userNotesText = input.userNotes?.trim();
  const userNotesChars = userNotesText ? handoffTextCost(userNotesText, charsPerToken) : 0;
  if (userNotesChars >= totalChars) {
    throw new HandoffBudgetExceededError(
      `user notes need ~${estimateTextTokens(userNotesText!, charsPerToken)} tokens, ` +
        `which is the whole ${budget.maxTokens}-token handoff budget`
    );
  }
  const selection = selectHandoffContext({
    items: collected.items,
    budget,
    reservedChars: checkpointReserveChars + frontierReserve + metadataChars + userNotesChars,
  });

  // 2. Summarize exactly what was NOT carried verbatim.
  const summaryTurns = unretainedTurns(turns, collected, selection);
  // Items that were only PARTIALLY retained still need checkpoint coverage, so
  // their events reach the summarizer in full rather than under the summary
  // cap (v9 §4).
  const partialEventIds = new Set<string>();
  for (const item of collected.items) {
    if (selection.retentionByItemId.get(item.id) === "partial") {
      for (const id of item.eventIds) partialEventIds.add(id);
    }
  }

  // One controller for the whole generation, driven by the caller's signal
  // and the total budget. Without it, a chunked generation had no upper
  // bound at all: N sequential calls, each capped only individually.
  const budgetMs = input.timeoutMs ?? 0;
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer =
    budgetMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, budgetMs)
      : undefined;
  const signal = controller.signal;
  const abortMessage = () =>
    timedOut
      ? `Summarization exceeded its ${budgetMs >= 1000 ? `${Math.round(budgetMs / 1000)}s` : `${budgetMs}ms`} budget`
      : "Summarization was cancelled";

  let checkpoint: string | undefined = input.previousSummary;
  let chunks = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };

  try {
    if (summaryTurns.length > 0) {
      // The running checkpoint carries the previous one forward between
      // chunks (pi's iterative update), so the last chunk's answer is the
      // complete state index.
      let running = input.previousSummary;
      for (const chunk of chunkTurns(summaryTurns, task, budgetChars, partialEventIds)) {
        if (signal.aborted) throw new Error(abortMessage());
        let conversationText = serializeRunChain(chunk, task, partialEventIds);
        if (budgetChars > 0 && handoffTextCost(conversationText, charsPerToken) > budgetChars) {
          conversationText = truncateForSummary(conversationText, budgetChars, charsPerToken);
        }
        const prompt = buildSummarizationPrompt(conversationText, running, input.customInstructions, workspace);

        const response = await retryCompletion(
          () =>
            complete({
              systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
              prompt,
              maxTokens: summarizer.maxOutputTokens,
              signal,
            }),
          input.retry ?? DEFAULT_SUMMARY_RETRY_POLICY,
          signal
        );
        // A cancelled/timed-out call surfaces as an abort, not as a provider
        // error — report the real reason instead of "operation aborted".
        if (signal.aborted) throw new Error(abortMessage());

        const failure = getSummarizationFailure(response, "Summarization");
        if (failure) throw new Error(failure);
        if (!response.text.trim()) throw new Error("Summarization returned an empty summary");
        // The prompt mandates an EXACT format whose first heading is
        // `## Goal`; an answer without it is not a checkpoint (the model
        // answered the conversation, or narrated instead of summarizing).
        // Storing it would hand the next agent prose that merely looks like
        // context, so the generation fails instead.
        const answer = extractCheckpoint(response.text);
        if (!/^##[ \t]+Goal\b/im.test(answer)) {
          throw new Error('Summarization did not return a checkpoint (no "## Goal" heading in the answer)');
        }
        chunks += 1;
        if (response.usage) {
          usage.inputTokens += response.usage.inputTokens;
          usage.outputTokens += response.usage.outputTokens;
        }
        running = answer;
      }
      checkpoint = running;
    } else if (checkpoint) {
      // Everything the checkpoint covered is in the retained context already;
      // it is carried forward as-is (minus its file tags, which are
      // recomputed below from the live workspace record).
      checkpoint = stripXmlTags(checkpoint);
    }
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }

  // Tracked file operations accumulate over the WHOLE covered range (previous
  // checkpoint's tags seeded in), exactly like pi merging a previous
  // compaction's details — the file lists describe the task's files, not only
  // the ones that happened to need summarizing.
  if (checkpoint) {
    const fileOps = extractFileOperations(events, input.previousSummary);
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    checkpoint += formatFileOperations(readFiles, modifiedFiles);
  }

  // The checkpoint was reserved at its CAP, before it existed. If the model
  // stopped naturally but wrote a longer state index than that allowance,
  // selection is re-run against the real size: the rendered handoff must obey
  // the total budget even then. What this second pass drops was part of the
  // checkpoint's own input, so the state index still covers it.
  const checkpointCost = checkpoint ? handoffTextCost(checkpoint, charsPerToken) : 0;
  let finalSelection = selection;
  if (checkpoint && checkpointCost > checkpointReserveChars) {
    finalSelection = selectHandoffContext({
      items: collected.items,
      budget,
      reservedChars: checkpointCost + frontierReserve + metadataChars + userNotesChars,
    });
  }

  // The current frontier (v10 §5): the newest state, derived deterministically
  // from the end of the retained trajectory. Capped at (and reserved as) the
  // frontier reserve, so it can never push the body past its budget.
  const frontier = deriveHandoffFrontier(finalSelection.retained, charsPerToken, frontierReserve);

  const contextBundle = assembleHandoffContextBundle({
    selection: finalSelection,
    budget,
    ...(checkpoint ? { checkpoint } : {}),
    ...(frontier ? { frontier } : {}),
    metadataChars,
    userNotesChars,
  });
  const content: HandoffContent = {
    ...handoffCheckpointToContent(checkpoint, {
      task,
      run,
      artifacts,
      workspace,
      runtimeName: input.runtimeName,
    }),
    contextBundle,
  };

  return {
    ...(checkpoint ? { checkpoint } : {}),
    content,
    contextBundle,
    ...(usage.inputTokens || usage.outputTokens ? { usage } : {}),
    chunks,
    selection: finalSelection,
  };
}

/* ------------------------------------------------------------------ */
/* Checkpoint → HandoffContent mapping                                 */
/* ------------------------------------------------------------------ */

/** Split a checkpoint into `## Section` → lines blocks (file tags stay verbatim). */
function splitSections(summary: string): Array<{ title: string; body: string[] }> {
  const sections: Array<{ title: string; body: string[] }> = [];
  let current: { title: string; body: string[] } | undefined;
  for (const line of summary.split("\n")) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      current = { title: m[1].trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections;
}

function sectionLines(body: string[]): string[] {
  return body
    // Strip list markers and pi's `- [x]` / `- [ ]` checkboxes, keep content.
    .map((l) => l.trim().replace(/^[-*+]\s+\[[ xX]\]\s*/, "").replace(/^([-*+]|\d+[.)])\s*/, "").trim())
    // Models elaborate the prompt's "(none)" placeholder ("(none — this
    // was a single informational Q&A)") — every "(none…" line means "empty".
    .filter((l) => l && !/^\[.*\]$/.test(l) && !/^\(none\b/i.test(l));
}

function subSection(body: string[], heading: string): string[] {
  const idx = body.findIndex((l) => l.trim().replace(/^#+\s*/, "").toLowerCase() === heading.toLowerCase());
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < body.length; i++) {
    const l = body[i].trim();
    if (/^#{2,3}\s+/.test(l)) break;
    if (l) out.push(l);
  }
  return out;
}

function stripXmlTags(summary: string): string {
  return summary
    .replace(/<read-files>[\s\S]*?<\/read-files>\n?/g, "")
    .replace(/<modified-files>[\s\S]*?<\/modified-files>\n?/g, "")
    .trim();
}

/**
 * The generation-time facts a rendered handoff states outside the bundle:
 * which workspace the work happened in, how the previous run ended, what it
 * produced. One source of truth for both the renderer and the context
 * budget's metadata reserve.
 *
 * Observability noise stays out (v10 §21): token usage, cost and billing are
 * audit facts — they remain on the Run record and in the Inspector, but the
 * receiving model's working context never needs them.
 */
export function handoffMetadataFields(meta: {
  run: Run;
  artifacts: Artifact[];
  workspace?: Workspace;
  runtimeName?: string;
}): Pick<HandoffContent, "workspaceStatus" | "previousRunResult" | "artifacts"> {
  const { run, workspace, artifacts } = meta;
  return {
    workspaceStatus: workspace
      ? `Workspace "${workspace.name}" (${workspace.type}) at ${workspace.path ?? workspace.repoUrl ?? "unknown"}.`
      : "No workspace was attached to the previous run.",
    previousRunResult:
      `Run ${run.id} finished with status "${run.status}"${run.error ? `, error: ${run.error}` : ""}.`,
    ...(artifacts.length ? { artifacts: artifacts.map((a) => `${a.name} (${a.kind})`) } : {}),
  };
}

/**
 * Map a checkpoint (plus run metadata that pi tracks separately in its session
 * entries) onto AgentFabric's HandoffContent *projection fields*. `summary`
 * (which keeps the checkpoint verbatim, with its file XML tags) is the field
 * the rendered handoff embeds as-is, so the next agent receives exactly the
 * checkpoint text, with no lossy re-rendering. A bundle whose whole covered
 * history was carried verbatim has no checkpoint; the projection is then just
 * the task/run metadata the handoff knows for certain.
 */
export function handoffCheckpointToContent(
  summary: string | undefined,
  meta: {
    task: Task;
    run: Run;
    artifacts: Artifact[];
    workspace?: Workspace;
    runtimeName?: string;
  }
): HandoffContent {
  const { run, task } = meta;
  const metadata = handoffMetadataFields(meta);
  const base: HandoffContent = {
    originalTask: taskLabel(task).slice(0, 2000),
    currentObjective: task.title,
    // Observability facts (model-call counts, token usage, cost) stay off the
    // LLM-facing projection (v10 §21); the Run record and Inspector keep them.
    progressSummary:
      `Run ${run.id} on ${meta.runtimeName ?? run.runtimeName ?? "previous runtime"} ${run.status}.`,
    ...metadata,
  };
  if (!summary) return base;

  const sections = splitSections(stripXmlTags(summary));
  const byTitle = (t: string) => sections.find((s) => s.title.toLowerCase() === t.toLowerCase());

  const goal = byTitle("Goal")?.body.map((l) => l.trim()).filter(Boolean).join(" ");
  const constraints = sectionLines(byTitle("Constraints & Preferences")?.body ?? []);
  const done = sectionLines(subSection(byTitle("Progress")?.body ?? [], "Done").join("\n").split("\n"));
  const inProgress = sectionLines(subSection(byTitle("Progress")?.body ?? [], "In Progress").join("\n").split("\n"));
  const blocked = sectionLines(subSection(byTitle("Progress")?.body ?? [], "Blocked").join("\n").split("\n"));
  const decisions = sectionLines(byTitle("Key Decisions")?.body ?? []);
  const nextSteps = sectionLines(byTitle("Next Steps")?.body ?? []);
  const criticalContext = sectionLines(byTitle("Critical Context")?.body ?? []);

  const { readFiles: tagRead, modifiedFiles: tagModified } = parseFileListTags(summary);
  const relevantFiles = [...new Set([...tagRead, ...tagModified])];
  const remainingWork = [
    ...inProgress.map((l) => `[in progress] ${l}`),
    ...blocked.map((l) => `[blocked] ${l}`),
    ...nextSteps,
  ];

  return {
    ...base,
    currentObjective: goal || task.title,
    ...(done.length ? { completedWork: done } : {}),
    ...(remainingWork.length ? { remainingWork } : {}),
    ...(decisions.length ? { importantDecisions: decisions } : {}),
    ...(constraints.length ? { userConstraints: constraints } : {}),
    ...(relevantFiles.length ? { relevantFiles } : {}),
    ...(criticalContext.length ? { notesForNextAgent: criticalContext.join("\n") } : {}),
  };
}
