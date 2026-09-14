/**
 * Handoff summary generation — writing the briefing that carries a task
 * across a session boundary.
 *
 * ## Two different things, deliberately
 *
 * - **Context compaction** is an *intra-session* event: the harness (pi,
 *   Claude Code, …) summarizes older turns of a live conversation to fit
 *   the model's window, then keeps going in the **same** native session.
 *   AgentFabric never does this — it belongs to the harness.
 * - **A handoff summary** is *inter-session*: the current native session
 *   ends, and a new one (usually on a different harness) starts with this
 *   text as its only context. It is an explicit user action, recorded as a
 *   `Handoff`.
 *
 * This module only ever produces the second. It borrows pi's *technique*
 * (pi: packages/coding-agent/src/core/compaction/) because that technique
 * — structured checkpoint prompts, iterative updates over a previous
 * summary, file-operation tracking, transient-error retries — is exactly
 * what a good handoff needs:
 *
 *   RunEvents → serializeConversation → <conversation>…</conversation>
 *             → (+ <previous-summary> from the last handoff checkpoint in
 *                the task's run chain, for pi's iterative update flow)
 *             → SUMMARIZATION_PROMPT / UPDATE_SUMMARIZATION_PROMPT
 *             → LLM (retried on transient errors) → structured
 *               checkpoint + <read-files>/<modified-files>
 *             → HandoffContent
 *
 * Deliberate differences from pi's in-session compaction: pi's cut-point
 * logic (keepRecentTokens) selects what to keep in the SAME session; a
 * handoff starts a NEW native session where nothing is kept, so the whole
 * covered range is summarized — exactly like pi's own handoff extension.
 * pi forwards the session's thinkingLevel on reasoning models; the
 * standalone completion client here does not (AgentFabric models carry no
 * thinking-level configuration). The summarizer prompt also gains an
 * authoritative <workspace> block pi does not need: pi summarizes within
 * the session's own working directory, while a handoff crosses harnesses —
 * the workspace identity must be stated, never re-inferred from transcript
 * residue.
 */
import type {
  Artifact,
  HandoffContent,
  Model,
  Provider,
  Run,
  RunEvent,
  Task,
  Workspace,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Settings (mirrors pi: DEFAULT_COMPACTION_SETTINGS)                  */
/* ------------------------------------------------------------------ */

/**
 * Settings for handoff summarization. `reserveTokens` mirrors
 * pi's default and drives the summary's max output tokens
 * (⌊0.8 × reserveTokens⌋, pi's generateSummaryWithUsage budget).
 *
 * `contextWindow` and `charsPerToken` drive the *input* budget: the
 * transcript of a long task is chunked so no single summarization call
 * exceeds the model's context, with each chunk's checkpoint feeding the
 * next as `<previous-summary>` (pi's iterative update, applied inside one
 * generation). No tokenizer is bundled, so the budget is a character
 * estimate — deliberately conservative for CJK (`charsPerToken: 2`).
 */
export interface HandoffSummarySettings {
  reserveTokens: number;
  /** Model context window in tokens; the input budget derives from it. */
  contextWindow?: number;
  /**
   * Characters per token used for budgeting. Lower = more conservative
   * (fewer characters per call, more chunks). 0 disables chunking.
   */
  charsPerToken?: number;
}

export const DEFAULT_HANDOFF_SUMMARY_SETTINGS: HandoffSummarySettings = {
  reserveTokens: 16384,
  contextWindow: 128_000,
  charsPerToken: 2,
};

/** Room reserved inside the context window for prompts and chat scaffolding. */
const PROMPT_OVERHEAD_TOKENS = 2_000;

/**
 * Output-token cap for one summary call: pi's ⌊0.8 × reserveTokens⌋, never
 * more than half a known context window (a fixed pi default would not fit
 * a small-window model).
 */
function outputTokenCap(settings: HandoffSummarySettings): number {
  const base = Math.floor(0.8 * settings.reserveTokens);
  const window = settings.contextWindow ?? 0;
  return window > 0 ? Math.min(base, Math.floor(window / 2)) : base;
}

/**
 * Character budget for one summarization call's transcript. `0` means
 * "no limit" (chunking disabled). Exposed for tests and preview tooling.
 */
export function summarizationInputBudgetChars(settings: HandoffSummarySettings): number {
  const charsPerToken = settings.charsPerToken ?? 2;
  if (charsPerToken <= 0) return 0;
  const window = settings.contextWindow ?? 128_000;
  const inputTokens = Math.max(window - outputTokenCap(settings) - PROMPT_OVERHEAD_TOKENS, 1_000);
  return inputTokens * charsPerToken;
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
- [Any constraints, preferences, or requirements mentioned by user]
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

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

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

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/* ------------------------------------------------------------------ */
/* Conversation serialization (pi: compaction/utils.ts serializeConversation) */
/* ------------------------------------------------------------------ */

/** Maximum characters for a tool result in serialized summaries (pi). */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker (pi).
 */
function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

interface SerializedPart {
  kind: "user" | "assistant" | "thinking" | "toolCalls" | "toolResult";
  text: string;
}

function eventText(e: RunEvent, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = e.data?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** Render tool-call arguments pi-style: `name(k=v, k2=v2)`. */
function formatToolCall(name: string, args: Record<string, unknown>): string {
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return `${name}(${argsStr})`;
}

/**
 * Extract a tool event's arguments: the full input object when present
 * (`input` for OpenCode-style events, `args` for pi runtime events),
 * else the common scalar keys off the event itself.
 */
function toolArgs(e: RunEvent): Record<string, unknown> {
  if (isObj(e.data?.input)) return e.data!.input as Record<string, unknown>;
  if (isObj(e.data?.args)) return e.data!.args as Record<string, unknown>;
  if (e.data?.path !== undefined || e.data?.command !== undefined) {
    return Object.fromEntries(
      Object.entries(e.data!).filter(([k]) => ["path", "command", "pattern", "query"].includes(k))
    );
  }
  return {};
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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
 * truncated to TOOL_RESULT_MAX_CHARS exactly like pi.
 *
 * The serialization is split so a handoff can cover several runs as one
 * transcript: `collectConversationParts` renders a single run's events,
 * and `serializeRunChain` stitches the runs since the last checkpoint
 * together (see `SummarizedTurn`).
 */

/** True when a run's own events already echo a user turn. */
function hasUserMessage(events: RunEvent[]): boolean {
  return events.some((e) => e.type === "agent.message" && e.data?.role === "user");
}

/**
 * One run's contribution to a multi-run handoff transcript.
 *
 * `userPrompt` is the run's bare user input (v5 §5). Real harnesses do not
 * echo the user's turn back as an event — only the `mock` adapter emits a
 * user-role `agent.message` — so without this the summarizer never sees
 * what the user actually asked on any turn after the first, and the
 * handoff can only restate the original task.
 */
export interface SummarizedTurn {
  events: RunEvent[];
  userPrompt?: string;
}

/** Collect one run's events as pi-style transcript parts (no leading user turn). */
function collectConversationParts(events: RunEvent[]): SerializedPart[] {
  const parts: SerializedPart[] = [];
  let pendingShellOutput: string[] = [];
  const flushShell = () => {
    if (pendingShellOutput.length) {
      parts.push({ kind: "toolResult", text: pendingShellOutput.join("\n") });
      pendingShellOutput = [];
    }
  };

  // toolCallId when the runtime provides one (pi runtime), else the tool
  // name — enough to pair a completion with its started call.
  const toolKey = (e: RunEvent, tool: string): string => {
    const id = e.data?.toolCallId ?? e.data?.callID ?? e.data?.callId;
    return typeof id === "string" && id ? `id:${id}` : `name:${tool}`;
  };
  const openToolStarts = new Set<string>();

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
        parts.push({ kind: "toolCalls", text: formatToolCall(tool, toolArgs(e)) });
        openToolStarts.add(toolKey(e, tool));
        break;
      }
      case "tool.completed": {
        flushShell();
        const tool = eventText(e, ["tool", "toolName"]) ?? "tool";
        if (!openToolStarts.delete(toolKey(e, tool)) && !openToolStarts.delete(`name:${tool}`)) {
          // No matching start (e.g. OpenCode only reports terminal
          // states): the completed event itself carries the call.
          parts.push({ kind: "toolCalls", text: formatToolCall(tool, toolArgs(e)) });
        }
        const result = eventText(e, ["output", "result", "error"]);
        if (result) parts.push({ kind: "toolResult", text: result });
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
        if (line) pendingShellOutput.push(line);
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
        return `[Tool result]: ${truncateForSummary(p.text, TOOL_RESULT_MAX_CHARS)}`;
    }
  });
  return rendered.join("\n\n");
}

export function serializeRunConversation(events: RunEvent[], task?: Task): string {
  const parts = collectConversationParts(events);
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
export function serializeRunChain(turns: SummarizedTurn[], task?: Task): string {
  const parts: SerializedPart[] = [];
  turns.forEach((turn, index) => {
    if (!hasUserMessage(turn.events)) {
      const text = turn.userPrompt?.trim() || (index === 0 && task ? taskLabel(task) : "");
      if (text) parts.push({ kind: "user", text });
    }
    parts.push(...collectConversationParts(turn.events));
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
  for (const e of events) {
    const path = eventText(e, ["path", "file"]);
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
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
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
      const text = (json.output ?? [])
        .flatMap((o: any) => o?.content ?? [])
        .filter((b: any) => b?.type === "output_text" || typeof b?.text === "string")
        .map((b: any) => b.text)
        .join("\n");
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
    const text: string = choice?.message?.content ?? "";
    return {
      text,
      stopReason: choice?.finish_reason === "length" ? "length" : "stop",
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
        : undefined,
    };
  };
}

/** Safety cap for the one-off summary call (pi relies on the caller's signal). */
const HANDOFF_SUMMARY_TIMEOUT_MS = 120_000;

/**
 * Default total budget for ONE handoff generation, covering every chunk and
 * retry. The per-attempt cap above bounds a single call; without a total
 * budget a chunked generation is unbounded (N sequential calls), and a
 * `continue` request would hang on it. Overridable per call via
 * `HandoffSummaryInput.timeoutMs`.
 */
export const HANDOFF_GENERATION_BUDGET_MS = 180_000;

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
 * The checkpoint format starts at the first `## ` section; the
 * system prompt forbids anything else. Models sometimes prepend
 * chain-of-thought anyway ("Let me analyze this conversation…") —
 * everything before the first `## ` heading is that leaked reasoning,
 * not checkpoint content, so it is dropped. A summary with no `## `
 * section is kept as-is: there is nothing to distinguish reasoning
 * from a (malformed) summary. Applied at generation time and again at
 * render time, so checkpoints stored before this guard also render
 * clean.
 */
export function stripCheckpointPreamble(summary: string): string {
  const match = /^##\s/m.exec(summary);
  return match ? summary.slice(match.index).trim() : summary.trim();
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

export interface HandoffSummaryInput {
  task: Task;
  run: Run;
  /**
   * Every event the summary must cover. With `turns` this is the
   * concatenation of their events (file-operation tracking runs over it);
   * without it, a single run's events.
   */
  events: RunEvent[];
  /**
   * The ordered runs this handoff covers — everything since the last
   * checkpoint, ending with `run`. Omitted for a single-run summary.
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
  settings?: HandoffSummarySettings;
  /** Retry policy for the summary call (pi: settings.retry; default 3/2s). */
  retry?: SummaryRetryPolicy;
  /** Cap from the model's parameters, when configured (pi: model.maxTokens). */
  modelMaxTokens?: number;
  /** Model context window, when configured; overrides the settings default. */
  modelContextWindow?: number;
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
  /** The raw pi-format checkpoint (structured summary + file XML tags). */
  summary: string;
  content: HandoffContent;
  usage?: { inputTokens: number; outputTokens: number };
  /** Summarization calls used; > 1 when the covered runs were chunked. */
  chunks: number;
}

/**
 * Split the covered runs into as few chunks as fit the summarization input
 * budget. Chunking keeps the *order* of runs: each chunk is summarized and
 * its checkpoint becomes the next chunk's `<previous-summary>`, so the
 * final checkpoint still covers every run — pi's iterative update applied
 * within a single generation. A single turn larger than the budget gets a
 * chunk of its own (the caller truncates it).
 */
export function chunkTurns(
  turns: SummarizedTurn[],
  task: Task | undefined,
  budgetChars: number
): SummarizedTurn[][] {
  if (turns.length === 0) return [];
  if (budgetChars <= 0) return [turns];
  const chunks: SummarizedTurn[][] = [];
  let current: SummarizedTurn[] = [];
  let size = 0;
  for (const turn of turns) {
    const cost = serializeRunChain([turn], task).length;
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
 * Generate a handoff summary through pi's compaction technique: serialize
 * the covered run(s), call the LLM with pi's prompts, enforce pi's failure
 * checks, append tracked file lists and map the checkpoint into
 * HandoffContent. Long tasks are summarized in chunks (see `chunkTurns`),
 * so a large transcript never silently overflows the context.
 *
 * The whole generation is cancellable: the caller's `signal` (client
 * disconnect / explicit cancel) and the total `timeoutMs` budget both
 * abort the in-flight call and the retry backoff, and the thrown message
 * says which fired. Other failures throw too — callers decide between
 * erroring and an explicit degraded mode.
 */
export async function generateHandoffSummary(input: HandoffSummaryInput): Promise<HandoffSummaryResult> {
  const { task, run, events, artifacts, workspace, complete } = input;
  const settings: HandoffSummarySettings =
    input.modelContextWindow && !input.settings?.contextWindow
      ? { ...(input.settings ?? DEFAULT_HANDOFF_SUMMARY_SETTINGS), contextWindow: input.modelContextWindow }
      : input.settings ?? DEFAULT_HANDOFF_SUMMARY_SETTINGS;

  const modelMax = input.modelMaxTokens ?? 0;
  const baseMax = outputTokenCap(settings);
  const maxTokens = modelMax > 0 ? Math.min(baseMax, modelMax) : baseMax;
  const budgetChars = summarizationInputBudgetChars(settings);

  const turns = input.turns ?? [{ events, userPrompt: run.userPrompt }];
  if (turns.length === 0) throw new Error("Summarization has no runs to cover");

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

  let summary = input.previousSummary;
  let chunks = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };

  try {
    for (const chunk of chunkTurns(turns, task, budgetChars)) {
      if (signal.aborted) throw new Error(abortMessage());
      let conversationText = serializeRunChain(chunk, task);
      if (budgetChars > 0 && conversationText.length > budgetChars) {
        conversationText = truncateForSummary(conversationText, budgetChars);
      }
      const prompt = buildSummarizationPrompt(conversationText, summary, input.customInstructions, workspace);

      const response = await retryCompletion(
        () =>
          complete({
            systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
            prompt,
            maxTokens,
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
      chunks += 1;
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
      }

      // File lists accumulate chunk over chunk exactly like pi's iterative
      // update, because the running checkpoint carries the XML tags forward.
      const chunkEvents = chunk.flatMap((t) => t.events);
      const fileOps = extractFileOperations(chunkEvents, summary);
      const { readFiles, modifiedFiles } = computeFileLists(fileOps);
      summary = stripCheckpointPreamble(response.text) + formatFileOperations(readFiles, modifiedFiles);
    }
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }

  const content = handoffCheckpointToContent(summary!, {
    task,
    run,
    artifacts,
    workspace,
    runtimeName: input.runtimeName,
  });

  return { summary: summary!, content, usage, chunks };
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
 * Map a pi-format checkpoint (plus run metadata that pi tracks
 * separately in its session entries) onto AgentFabric's HandoffContent.
 * `compactionSummary` keeps the full checkpoint verbatim — the field name
 * is historical (the format is pi's compaction checkpoint); the rendered
 * handoff prompt embeds it as-is so the next agent receives exactly the
 * checkpoint text, with no lossy re-rendering.
 */
export function handoffCheckpointToContent(
  summary: string,
  meta: {
    task: Task;
    run: Run;
    artifacts: Artifact[];
    workspace?: Workspace;
    runtimeName?: string;
  }
): HandoffContent {
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

  const { run, task, artifacts, workspace } = meta;
  const remainingWork = [...inProgress.map((l) => `[in progress] ${l}`), ...blocked.map((l) => `[blocked] ${l}`), ...nextSteps];

  const content: HandoffContent = {
    originalTask: taskLabel(task).slice(0, 2000),
    currentObjective: goal || task.title,
    progressSummary:
      `Run ${run.id} on ${meta.runtimeName ?? run.runtimeName ?? "previous runtime"} ${run.status}` +
      ` (${run.usage?.modelRequests ?? 0} model calls).`,
    ...(done.length ? { completedWork: done } : {}),
    ...(remainingWork.length ? { remainingWork } : {}),
    ...(decisions.length ? { importantDecisions: decisions } : {}),
    ...(constraints.length ? { userConstraints: constraints } : {}),
    ...(relevantFiles.length ? { relevantFiles } : {}),
    workspaceStatus: workspace
      ? `Workspace "${workspace.name}" (${workspace.type}) at ${workspace.path ?? workspace.repoUrl ?? "unknown"}.`
      : "No workspace was attached to the previous run.",
    ...(artifacts.length ? { artifacts: artifacts.map((a) => `${a.name} (${a.kind})`) } : {}),
    previousRunResult:
      `Run ${run.id} finished with status "${run.status}"${run.error ? `, error: ${run.error}` : ""}` +
      `; usage: ${run.usage?.inputTokens ?? 0} in / ${run.usage?.outputTokens ?? 0} out tokens, cost ${run.cost ?? 0}.`,
    ...(criticalContext.length ? { notesForNextAgent: criticalContext.join("\n") } : {}),
    compactionSummary: summary,
  };
  return content;
}
