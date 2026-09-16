/**
 * Handoff context selection — what actually crosses the session boundary.
 *
 * ## Handoff is not a summary
 *
 * A handoff reconstructs the previous harness's working frontier with the
 * highest fidelity the target context budget allows. Summarization is only
 * the fallback representation for the history that does not fit:
 *
 * ```
 * old history                      current frontier
 * |-------------------------------------------|
 *          summarize old prefix  ↓
 *          structured checkpoint
 *          preserve important old context ↓
 *          pinned context
 *                          preserve recent work ↓
 *                          retained trajectory
 * ```
 *
 * So the bundle is:
 *
 * ```
 * ┌──────────────────────────────────────┐
 * │ Structured checkpoint (state index)  │  written by the model
 * ├──────────────────────────────────────┤
 * │ Pinned context (verbatim)            │  historical user instructions
 * ├──────────────────────────────────────┤
 * │ Retained context (verbatim)          │  the recent working trajectory
 * ├──────────────────────────────────────┤
 * │ Budget / metadata                    │
 * └──────────────────────────────────────┘
 * ```
 *
 * This module owns everything except the checkpoint's LLM call:
 * normalization (`RunEvent[]` → context items), atomic grouping, budget
 * estimation, deterministic selection, bundle assembly and slice rendering.
 * Only the normalization layer knows about `RunEvent`, so a future change can
 * feed context items in from a harness-native parser instead
 * (`native harness context → context items`) without touching the selector.
 *
 * Selection is deterministic by construction — recency, role, tool type,
 * reconstructability, atomic pairing and budget. No second LLM classifies
 * what to keep: that would add latency and cost, and would let the selector
 * hallucinate away the very context the handoff exists to preserve.
 *
 * ## Two policies that must never be confused
 *
 * - **summary representation** (`handoffSummary.ts`) may aggressively reduce
 *   history — it only feeds the checkpoint model.
 * - **retained representation** (here) keeps the recent trajectory verbatim.
 *   A tool result is never shortened just because some other code path
 *   shortens tool results.
 */
import type {
  HandoffContextBudget,
  HandoffContextBundle,
  HandoffContextSlice,
  ID,
  RunEvent,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Budget settings + the single token estimator                        */
/* ------------------------------------------------------------------ */

/**
 * Knobs for one handoff generation. Two budgets that used to be one number,
 * deliberately separated (v8 §6):
 *
 * - the **handoff context budget** (`maxHandoffTokens`, bounded by
 *   `handoffContextRatio` of the target window) is how much of the previous
 *   harness's working context crosses the boundary;
 * - the **checkpoint budget** (`checkpointMaxTokens`) is how long the state
 *   index the model writes may be. It is small and independent: 150K is not a
 *   summary output size.
 */
export interface HandoffBudgetSettings {
  /**
   * Target model context window. Unknown → the configured default; the window
   * is never guessed from a model name and never looked up over the network.
   */
  contextWindow?: number;
  /** Absolute cap on the handoff body. */
  maxHandoffTokens?: number;
  /** Share of the target window a handoff may ever occupy. */
  handoffContextRatio?: number;
  /**
   * Explicit escape hatch for callers that really do want a handoff larger
   * than `handoffContextRatio` of the target window. Without it the ratio
   * always wins, so a misconfigured `maxHandoffTokens` cannot flood the next
   * session.
   */
  overrideContextRatio?: boolean;
  /** Output-token cap for the checkpoint the summarizer writes. */
  checkpointMaxTokens?: number;
  /** Characters per token for every estimate on the handoff path. */
  charsPerToken?: number;
}

/** Context window assumed when the target's window is not configured. */
export const DEFAULT_TARGET_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_HANDOFF_TOKENS = 150_000;
export const DEFAULT_HANDOFF_CONTEXT_RATIO = 0.15;
export const DEFAULT_CHECKPOINT_MAX_TOKENS = 12_000;
/**
 * Conservative characters-per-token for Latin text, code and logs. The single
 * estimator below (`estimateTextTokens`) applies this to non-CJK text and a
 * separate, more conservative weight to CJK — see `DEFAULT_CJK_TOKENS_PER_CHAR`.
 */
export const DEFAULT_CHARS_PER_TOKEN = 2;

/**
 * Conservative tokens-per-character for CJK text (Han, Hiragana, Katakana,
 * Hangul, CJK punctuation and fullwidth forms). BPE tokenizers for these
 * scripts land around 0.6–1 token per character; counting one full token per
 * character deliberately over-estimates so a CJK-heavy handoff lands UNDER its
 * target budget rather than over it (v9 §7). Without this, the 2-chars-per-token
 * rule under-counted Chinese by roughly half.
 */
export const DEFAULT_CJK_TOKENS_PER_CHAR = 1;

/**
 * Characters that tokenize at (at least) one token each. Covers the BMP CJK
 * blocks: CJK punctuation, Hiragana, Katakana, CJK Ext-A, CJK Unified
 * Ideographs, Hangul Jamo/syllables, compatibility ideographs and fullwidth
 * forms. Astral-plane ideographs and emoji are rare in a transcript and count
 * as two ASCII characters, which is already conservative for them.
 */
const CJK_CHAR_RE =
  /[\u1100-\u11ff\u2e80-\u2fdf\u3000-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

export const DEFAULT_HANDOFF_BUDGET_SETTINGS: Required<HandoffBudgetSettings> = {
  contextWindow: DEFAULT_TARGET_CONTEXT_WINDOW,
  maxHandoffTokens: DEFAULT_MAX_HANDOFF_TOKENS,
  handoffContextRatio: DEFAULT_HANDOFF_CONTEXT_RATIO,
  overrideContextRatio: false,
  checkpointMaxTokens: DEFAULT_CHECKPOINT_MAX_TOKENS,
  charsPerToken: DEFAULT_CHARS_PER_TOKEN,
};

export interface ResolvedHandoffBudget {
  contextWindow: number;
  maxTokens: number;
  checkpointMaxTokens: number;
  charsPerToken: number;
}

/**
 * `handoffBudget = min(configuredMaxHandoffTokens, floor(window × ratio))`
 * (v8 §6.1). A caller-configured budget is honored, but the ratio still
 * bounds it unless the caller opts out explicitly with
 * `overrideContextRatio` — that flag is the override API.
 */
export function resolveHandoffBudget(settings: HandoffBudgetSettings = {}): ResolvedHandoffBudget {
  const merged = { ...DEFAULT_HANDOFF_BUDGET_SETTINGS, ...settings };
  const contextWindow = merged.contextWindow > 0 ? merged.contextWindow : DEFAULT_TARGET_CONTEXT_WINDOW;
  const ratioCap = Math.floor(contextWindow * merged.handoffContextRatio);
  const maxTokens = merged.overrideContextRatio
    ? merged.maxHandoffTokens
    : Math.min(merged.maxHandoffTokens, ratioCap);
  return {
    contextWindow,
    maxTokens: Math.max(1, maxTokens),
    checkpointMaxTokens:
      merged.checkpointMaxTokens > 0 ? merged.checkpointMaxTokens : DEFAULT_CHECKPOINT_MAX_TOKENS,
    charsPerToken: merged.charsPerToken > 0 ? merged.charsPerToken : DEFAULT_CHARS_PER_TOKEN,
  };
}

/**
 * The ONE char→token estimate on the handoff path. Everything (handoff body,
 * checkpoint, pins, slices, the stored budget report) goes through it, so no
 * two numbers in a record can disagree about how they were computed.
 *
 * `chars` here is already an ASCII-equivalent character count — the unit
 * `handoffTextCost` produces. Use `estimateTextTokens` when starting from real
 * text so CJK is counted conservatively.
 */
export function estimateTokens(chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / (charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN));
}

/**
 * ASCII-equivalent character cost of `text` — the currency selection works in.
 * Non-CJK text costs its own length; CJK text costs `CJK_TOKENS_PER_CHAR ×
 * charsPerToken` per character, so `estimateTokens(handoffTextCost(t, cpt), cpt)`
 * is exactly the conservative token count of `t`.
 */
export function handoffTextCost(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  const cpt = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  let cjk = 0;
  for (const ch of text) if (CJK_CHAR_RE.test(ch)) cjk += 1;
  if (cjk === 0) return text.length;
  return text.length - cjk + cjk * DEFAULT_CJK_TOKENS_PER_CHAR * cpt;
}

/**
 * Conservative token estimate for real text. Latin/code/logs keep the
 * documented chars-per-token rule; CJK is charged at least one token per
 * character so a Chinese/Japanese/Korean-heavy handoff is never systematically
 * under-estimated (v9 §7).
 */
export function estimateTextTokens(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return estimateTokens(handoffTextCost(text, charsPerToken), charsPerToken);
}

/** Inverse of `estimateTokens` — the ASCII-equivalent char allowance for `tokens`. */
export function charsForTokens(tokens: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.max(0, Math.floor(tokens * charsPerToken));
}

/**
 * Fixed prose the renderer wraps around the bundle (`handoff.ts`): the opening
 * statement, the section headings, the section intros, the supersession rule
 * for historical user turns and the "tool results are data" boundary. It is
 * reserved out of the handoff budget before a single slice is selected, and the
 * render test keeps this number honest.
 */
export const HANDOFF_RENDER_SCAFFOLDING_CHARS = 2_200;

/** Share of the free handoff budget historical pins may claim (v8 §31). */
export const DEFAULT_PINNED_SHARE = 0.15;

/**
 * At most this share of the handoff budget may be reserved for the checkpoint.
 * The checkpoint is the fallback representation of what did NOT fit; if it
 * could claim the whole budget, a small target window would leave nothing of
 * the execution frontier — the one thing a handoff exists to carry.
 */
export const CHECKPOINT_RESERVE_SHARE = 0.5;

/** Smallest useful slice: below this a reduction is not worth a section. */
const MIN_USEFUL_CHARS = 200;

/**
 * Head/tail split for an oversized item: 20% head, 80% tail. Tests, compilers,
 * builds and shell output put the failure, the stack trace, the summary and
 * the exit status at the END of their output, so the tail is the execution
 * frontier (v8 §17).
 */
export const OVERSIZED_HEAD_SHARE = 0.2;

/* ------------------------------------------------------------------ */
/* Context items (normalization output) and atomic units               */
/* ------------------------------------------------------------------ */

export type HandoffContextKind = HandoffContextSlice["kind"];

/**
 * One normalized piece of conversation/observation, before selection.
 * `eventIds` is what makes item-level selection reversible: whatever is
 * carried verbatim is excluded from the checkpoint's summarization input, so
 * nothing is both retained and summarized.
 */
export interface HandoffContextItem {
  id: string;
  kind: HandoffContextKind;
  text: string;
  runId?: ID;
  toolCallId?: string;
  toolName?: string;
  /**
   * The observation can be re-obtained from the shared workspace, so its body
   * never has to occupy handoff budget (v8 §16).
   */
  reconstructable?: boolean;
  /** Self-describing text that replaces a reconstructable body when omitted. */
  omissionMarker?: string;
  /** RunEvent ids this item was normalized from (empty for synthetic items). */
  eventIds: string[];
  /** Chronological position across the covered range. */
  order: number;
  /** The task's own brief — pinned ahead of every other user turn. */
  originalTask?: boolean;
}

/** One run's contribution to the covered history. */
export interface HandoffContextSourceTurn {
  runId?: ID;
  events: RunEvent[];
  /**
   * The run's bare user input. Real harnesses do not echo the user's turn back
   * as an event, so without it the user's own words would never reach the
   * handoff (v5 §5).
   */
  userPrompt?: string;
}

/**
 * An atomic context unit: what selection keeps or drops as a whole (v8 §10).
 * A user message and an assistant message are single-item units; a tool
 * interaction is `call + matching result`; a shell command is
 * `command + its output`.
 */
export interface HandoffContextUnit {
  id: string;
  kind: "user" | "assistant" | "tool";
  items: HandoffContextItem[];
}

/* ------------------------------------------------------------------ */
/* Reconstructability                                                  */
/* ------------------------------------------------------------------ */

/** Tool names whose result is a body of local file content. */
const READ_TOOLS = new Set(["read", "read_file", "readfile", "cat", "view", "open_file"]);

/** Argument keys that name the thing a read tool read. */
const READ_TARGET_KEYS = ["path", "file_path", "filepath", "file", "target"];

/**
 * Shell commands that only print existing local state. Their output is a
 * snapshot of the shared workspace, so the new harness can re-run the command
 * instead of receiving the text.
 */
const LOCAL_READ_COMMAND =
  /^\s*(cat|bat|head|tail|sed|nl|less|more|ls|tree|stat|file|wc|du|grep|rg|find|pwd|which|env|printenv|git\s+(status|diff|log|show|branch|ls-files|rev-parse)|node\s+(-v|--version)|npm\s+(ls|list)|pnpm\s+(ls|list)|cargo\s+(tree|metadata))\b/i;

/** Commands whose output depends on something outside the workspace. */
const REMOTE_COMMAND =
  /(https?:\/\/|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\brsync\b|git\s+(clone|fetch|pull|push|remote)|npm\s+(install|i|ci|view|info)|pnpm\s+(install|i|add)|yarn\s+(add|install)|pip\s+install|docker\s+(pull|run|build)|kubectl|aws\s|gcloud\s|gh\s)/i;

/** A read whose body is smaller than this is cheaper to keep than to re-read. */
export const RECONSTRUCTABLE_BODY_KEEP_MAX_CHARS = 4_000;

/**
 * Whether an observation can be re-obtained from the shared workspace. Only
 * local reads qualify: a web/API response, a remote query, a compiler or test
 * run and a subagent result are one-shot observations that no later command
 * can reproduce (v8 §16).
 */
export function isReconstructableObservation(input: {
  tool?: string;
  args?: Record<string, unknown>;
  command?: string;
  /** No shared workspace → nothing can be re-read, so nothing is omitted. */
  sharedWorkspace: boolean;
}): { reconstructable: boolean; target?: string; kind?: "path" | "command" } {
  if (!input.sharedWorkspace) return { reconstructable: false };
  const tool = (input.tool ?? "").toLowerCase();
  if (READ_TOOLS.has(tool)) {
    const target = readTargetOf(input.args);
    if (target) return { reconstructable: true, target, kind: "path" };
  }
  const command = input.command?.trim();
  if (command && LOCAL_READ_COMMAND.test(command) && !REMOTE_COMMAND.test(command)) {
    return { reconstructable: true, target: command, kind: "command" };
  }
  return { reconstructable: false };
}

/** The local thing a read tool read — a URL is not reconstructable. */
function readTargetOf(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of READ_TARGET_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * The marker that stands in for a reconstructable body. It names the read so
 * the next agent can get the content back, and it never fabricates what the
 * body said.
 */
export function reconstructableOmissionMarker(target?: string, kind: "path" | "command" = "path"): string {
  if (!target) {
    return `[Tool result omitted from the handoff: this observation is reconstructable from the shared workspace — re-run the call above if it matters.]`;
  }
  return kind === "command"
    ? `[Tool result omitted from the handoff: its output is reconstructable from the shared workspace. Re-run \`${target}\` if it matters.]`
    : `[Tool result omitted from the handoff: local file content is reconstructable from the shared workspace. Re-read ${target} if it matters.]`;
}

/* ------------------------------------------------------------------ */
/* Event reading helpers (shared with the summary serializer)          */
/* ------------------------------------------------------------------ */

export function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** First non-empty string among `keys` on an event's data. */
export function eventText(e: RunEvent, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = e.data?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** Render tool-call arguments: `name(k=v, k2=v2)`. */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return `${name}(${argsStr})`;
}

/**
 * Extract a tool event's arguments: the full input object when present
 * (`input` for OpenCode-style events, `args` for pi runtime events), else the
 * common scalar keys off the event itself.
 */
export function toolArgs(e: RunEvent): Record<string, unknown> {
  if (isObj(e.data?.input)) return e.data!.input as Record<string, unknown>;
  if (isObj(e.data?.args)) return e.data!.args as Record<string, unknown>;
  if (e.data?.path !== undefined || e.data?.command !== undefined) {
    return Object.fromEntries(
      Object.entries(e.data!).filter(([k]) => ["path", "command", "pattern", "query"].includes(k))
    );
  }
  return {};
}

/** The tool-call id a runtime attached to an event, when it has one. */
function toolCallIdOf(e: RunEvent): string | undefined {
  const id = e.data?.toolCallId ?? e.data?.callID ?? e.data?.callId;
  return typeof id === "string" && id ? id : undefined;
}

/** Argument keys that identify which local thing a tool call acted on. */
const TOOL_TARGET_KEYS = [...READ_TARGET_KEYS, "command", "query", "pattern", "url", "name", "old_string"];

/**
 * The identifying argument of a tool call — the file it read, the command it
 * ran, the query it searched. Used to pair a result with the right call when
 * the runtime supplies no call id. `undefined` when the call carries nothing
 * that distinguishes it from a same-named sibling.
 */
export function toolCallTarget(tool: string, args: Record<string, unknown>): string | undefined {
  for (const key of TOOL_TARGET_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return `${key}:${value.trim()}`;
  }
  return undefined;
}

/**
 * Index of the pending no-ID call a `tool.completed` event belongs to, or `-1`
 * when there is none.
 *
 * The runtime gives no call id, so pairing must be inferred from the call
 * itself, deterministically:
 *
 * 1. candidates are the pending calls with the same tool name;
 * 2. if the completion names the same target (path/command/query), that call
 *    wins — this is what separates `read a.ts` from `read b.ts` even when the
 *    results arrive out of order;
 * 3. otherwise the OLDEST pending call of that name is taken, because that is
 *    the order the runtime issued them in.
 *
 * A tool name is never the whole identity: two same-named calls stay distinct
 * items, and a result is never duplicated into a synthetic extra call (v9 §3).
 */
export function matchPendingToolCall(
  pending: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>,
  completed: { tool: string; args: Record<string, unknown> }
): number {
  const name = completed.tool.toLowerCase();
  const candidates: number[] = [];
  for (let i = 0; i < pending.length; i++) {
    if (pending[i].tool.toLowerCase() === name) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0];
  const target = toolCallTarget(completed.tool, completed.args);
  if (target) {
    const exact = candidates.find((i) => toolCallTarget(pending[i].tool, pending[i].args) === target);
    if (exact !== undefined) return exact;
  }
  return candidates[0];
}

/** True when a run's own events already echo a user turn. */
export function hasUserMessage(events: RunEvent[]): boolean {
  return events.some((e) => e.type === "agent.message" && e.data?.role === "user");
}

/* ------------------------------------------------------------------ */
/* Normalization: RunEvent[] → HandoffContextItem[]                    */
/* ------------------------------------------------------------------ */

export interface NormalizeEventsOptions {
  runId?: ID;
  /** Shared workspace present → local reads may be omitted later. */
  sharedWorkspace: boolean;
  /** First `order` value handed out (callers keep one global order). */
  orderStart?: number;
}

/** A shell command plus the output lines that belong to it. */
interface PendingShellOutput {
  command: string;
  callId: string;
  lines: string[];
  eventIds: string[];
}

/**
 * Normalize one run's events into context items.
 *
 * Only observable work state is normalized: user instructions, assistant
 * conclusions, tool calls and tool results. Deliberately excluded:
 *
 * - `agent.thinking` — a harness's private reasoning is not something a
 *   handoff copies across (v8 §9); the checkpoint may record the conclusions
 *   that reasoning produced.
 * - `log`, `file.created`/`file.modified`, run/usage bookkeeping — AgentFabric's
 *   own records, not the agent's conversation (v8 §26). A bigger budget is a
 *   licence to carry more valuable context, not to dump every event.
 *
 * Adjacent `shell.output` lines accumulate into one result item, because the
 * harness emitted them as one command's output (v8 §10).
 */
export function normalizeRunEvents(events: RunEvent[], options: NormalizeEventsOptions): HandoffContextItem[] {
  const items: HandoffContextItem[] = [];
  let order = options.orderStart ?? 0;
  const push = (item: Omit<HandoffContextItem, "order">): HandoffContextItem => {
    const full: HandoffContextItem = { ...item, order };
    order += 1;
    items.push(full);
    return full;
  };

  let shell: PendingShellOutput | undefined;
  let shellSeq = 0;
  const flushShell = () => {
    const pending = shell;
    shell = undefined;
    if (!pending || pending.lines.length === 0) return;
    const read = isReconstructableObservation({
      command: pending.command,
      sharedWorkspace: options.sharedWorkspace,
    });
    push({
      id: `${pending.callId}:result`,
      kind: "tool-result",
      text: pending.lines.join("\n"),
      runId: options.runId,
      toolName: "bash",
      toolCallId: pending.callId,
      ...(read.reconstructable
        ? { reconstructable: true, omissionMarker: reconstructableOmissionMarker(read.target, read.kind) }
        : {}),
      eventIds: pending.eventIds,
    });
  };

  // Calls with a native id, keyed by it; calls without one, kept in issue
  // order so a completion can be matched to the call it belongs to (v9 §3).
  const openCalls = new Map<string, HandoffContextItem>();
  const pendingCalls: Array<{ item: HandoffContextItem; tool: string; args: Record<string, unknown> }> = [];

  for (const e of events) {
    switch (e.type) {
      case "agent.message": {
        flushShell();
        const content = eventText(e, ["content", "text", "message"]);
        if (!content) break;
        push({
          id: `evt:${e.id}`,
          kind: e.data?.role === "user" ? "user" : "assistant",
          text: content,
          runId: options.runId,
          eventIds: [e.id],
        });
        break;
      }
      case "agent.thinking":
        // Private reasoning never becomes retained raw context (v8 §9).
        break;
      case "tool.started": {
        flushShell();
        const tool = eventText(e, ["tool", "toolName"]) ?? "tool";
        const args = toolArgs(e);
        const id = toolCallIdOf(e);
        const call = push({
          id: `evt:${e.id}`,
          kind: "tool-call",
          text: formatToolCall(tool, args),
          runId: options.runId,
          toolName: tool,
          ...(id ? { toolCallId: id } : {}),
          eventIds: [e.id],
        });
        if (id) openCalls.set(id, call);
        else pendingCalls.push({ item: call, tool, args });
        break;
      }
      case "tool.completed": {
        flushShell();
        const tool = eventText(e, ["tool", "toolName"]) ?? "tool";
        const args = toolArgs(e);
        const id = toolCallIdOf(e);
        let call = id ? openCalls.get(id) : undefined;
        if (id) openCalls.delete(id);
        else {
          // No native id: pair with the pending call this completion belongs
          // to (same tool, same target if named, else oldest outstanding).
          const match = matchPendingToolCall(pendingCalls, { tool, args });
          if (match >= 0) call = pendingCalls.splice(match, 1)[0].item;
        }
        if (!call) {
          // No matching start (e.g. OpenCode only reports terminal states):
          // the completed event itself carries the call.
          call = push({
            id: `evt:${e.id}:call`,
            kind: "tool-call",
            text: formatToolCall(tool, args),
            runId: options.runId,
            toolName: tool,
            ...(id ? { toolCallId: id } : {}),
            eventIds: [e.id],
          });
        }
        const result = eventText(e, ["output", "result", "error"]);
        if (result) {
          const read = isReconstructableObservation({
            tool,
            args,
            command: typeof args.command === "string" ? args.command : undefined,
            sharedWorkspace: options.sharedWorkspace,
          });
          push({
            id: `${call.id}:result`,
            kind: "tool-result",
            text: result,
            runId: options.runId,
            toolName: tool,
            // The paired call's own id, so grouping is by identity rather than
            // by tool name (a runtime with no call ids must not collapse
            // same-named calls into one another).
            toolCallId: id ?? call.toolCallId ?? call.id,
            ...(read.reconstructable
              ? { reconstructable: true, omissionMarker: reconstructableOmissionMarker(read.target, read.kind) }
              : {}),
            eventIds: [e.id],
          });
        }
        break;
      }
      case "shell.command": {
        flushShell();
        const command = eventText(e, ["command"]);
        if (!command) break;
        const callId = `shell:${++shellSeq}`;
        push({
          id: callId,
          kind: "tool-call",
          text: formatToolCall("bash", { command }),
          runId: options.runId,
          toolName: "bash",
          toolCallId: callId,
          eventIds: [e.id],
        });
        shell = { command, callId, lines: [], eventIds: [] };
        break;
      }
      case "shell.output": {
        const line = eventText(e, ["line", "message"]);
        if (line === undefined) break;
        shell ??= { command: "", callId: `shell:${++shellSeq}`, lines: [], eventIds: [] };
        shell.lines.push(line);
        shell.eventIds.push(e.id);
        break;
      }
      default:
        break;
    }
  }
  flushShell();
  return items;
}

/** Stable id of the synthetic item that carries a run's bare user input. */
function turnUserItemId(turn: HandoffContextSourceTurn, index: number): string {
  return `turn:${turn.runId ?? `#${index}`}:user`;
}

export interface CollectedHandoffContext {
  items: HandoffContextItem[];
  /** Covered-turn index → the id of the item carrying that turn's user input. */
  turnUserItemIds: Map<number, string>;
}

/**
 * Normalize the covered runs into one chronological item stream, including the
 * user turns harnesses do not echo back (v8 §8).
 *
 * `taskPrompt` is the task's own brief. It is seeded whenever no covered user
 * turn already carries it, so the original request still reaches the handoff
 * when coverage starts after an earlier checkpoint (v8 §13).
 */
export function collectHandoffContext(
  turns: HandoffContextSourceTurn[],
  options: { taskPrompt?: string; sharedWorkspace: boolean }
): CollectedHandoffContext {
  const items: HandoffContextItem[] = [];
  const turnUserItemIds = new Map<number, string>();
  let order = 0;

  turns.forEach((turn, index) => {
    if (!hasUserMessage(turn.events)) {
      const text = turn.userPrompt?.trim();
      if (text) {
        const id = turnUserItemId(turn, index);
        items.push({ id, kind: "user", text, runId: turn.runId, eventIds: [], order: order++ });
        turnUserItemIds.set(index, id);
      }
    }
    for (const item of normalizeRunEvents(turn.events, {
      runId: turn.runId,
      sharedWorkspace: options.sharedWorkspace,
      orderStart: order,
    })) {
      items.push(item);
      order = item.order + 1;
    }
  });

  const taskPrompt = options.taskPrompt?.trim();
  if (taskPrompt) {
    const existing = items.find((i) => i.kind === "user" && i.text.trim() === taskPrompt);
    if (existing) existing.originalTask = true;
    else
      items.unshift({
        id: "task:original",
        kind: "user",
        text: taskPrompt,
        originalTask: true,
        eventIds: [],
        order: -1,
      });
  }
  return { items, turnUserItemIds };
}

/* ------------------------------------------------------------------ */
/* Atomic grouping                                                     */
/* ------------------------------------------------------------------ */

/**
 * Group items into the units selection treats as indivisible (v8 §10): a tool
 * call pairs with its matching result, a shell command with its accumulated
 * output. Pairing uses the call's identity — the runtime's native call id when
 * it has one, otherwise the call item's own id, which normalization stamped on
 * the result so two same-named calls never collapse into one. A result whose
 * call was never recorded is a unit of its own — it is still an observation the
 * next agent needs.
 */
export function groupHandoffContextUnits(items: HandoffContextItem[]): HandoffContextUnit[] {
  const units: HandoffContextUnit[] = [];
  const byCallId = new Map<string, HandoffContextUnit>();

  for (const item of items) {
    if (item.kind === "tool-call") {
      const unit: HandoffContextUnit = { id: item.id, kind: "tool", items: [item] };
      units.push(unit);
      if (item.toolCallId) byCallId.set(item.toolCallId, unit);
      byCallId.set(item.id, unit);
      continue;
    }
    if (item.kind === "tool-result") {
      const unit = item.toolCallId ? byCallId.get(item.toolCallId) : undefined;
      if (unit && !unit.items.some((i) => i.kind === "tool-result")) unit.items.push(item);
      else units.push({ id: item.id, kind: "tool", items: [item] });
      continue;
    }
    units.push({ id: item.id, kind: item.kind === "user" ? "user" : "assistant", items: [item] });
  }
  return units;
}

/* ------------------------------------------------------------------ */
/* Slice rendering + cost                                              */
/* ------------------------------------------------------------------ */

const SLICE_LABELS: Record<HandoffContextKind, string> = {
  user: "[User]",
  assistant: "[Assistant]",
  "tool-call": "[Tool call]",
  "tool-result": "[Tool result]",
};

function sliceLabel(kind: HandoffContextKind): string {
  return SLICE_LABELS[kind];
}

/** One slice line as it reaches the next harness. */
function renderSlice(slice: HandoffContextSlice): string {
  return `${sliceLabel(slice.kind)}: ${slice.text}`;
}

/** Render slices in order, blank-line separated — the exact retained text. */
export function renderContextSlices(slices: HandoffContextSlice[]): string {
  return slices.map(renderSlice).join("\n\n");
}

/**
 * ASCII-equivalent cost of one slice in the rendered handoff (label +
 * separator), in the same currency as the budget's `charsPerToken` allowance.
 * CJK text costs more per character, so a CJK-heavy slice is never
 * under-charged against the budget.
 */
export function sliceChars(slice: HandoffContextSlice, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return handoffTextCost(renderSlice(slice), charsPerToken) + 2;
}

function slicesChars(slices: HandoffContextSlice[], charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return slices.reduce((sum, s) => sum + sliceChars(s, charsPerToken), 0);
}

function itemToSlice(item: HandoffContextItem, retention: HandoffContextSlice["retention"]): HandoffContextSlice {
  return {
    kind: item.kind,
    text: item.text,
    ...(item.runId ? { runId: item.runId } : {}),
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.toolName ? { toolName: item.toolName } : {}),
    ...(item.reconstructable ? { reconstructable: true } : {}),
    retention,
  };
}

/* ------------------------------------------------------------------ */
/* Oversized retention                                                 */
/* ------------------------------------------------------------------ */

function omissionMarker(omitted: number): string {
  return `\n\n[... ${omitted} characters omitted from the middle during handoff retention ...]\n\n`;
}

/** Cost of one code point in the estimator's ASCII-equivalent currency. */
function charCost(ch: string, charsPerToken: number): number {
  return CJK_CHAR_RE.test(ch) ? DEFAULT_CJK_TOKENS_PER_CHAR * charsPerToken : ch.length;
}

/** Longest prefix of `text` whose cost fits `budget`, split by code point. */
function headByCost(text: string, budget: number, charsPerToken: number): string {
  let cost = 0;
  let plainEnd = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const next = cost + charCost(ch, charsPerToken);
    if (next > budget) break;
    cost = next;
    i += ch.length;
    plainEnd = i;
  }
  return text.slice(0, plainEnd);
}

/** Longest suffix of `text` whose cost fits `budget`, split by code point. */
function tailByCost(text: string, budget: number, charsPerToken: number): string {
  const chars = [...text];
  let cost = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = cost + charCost(chars[i], charsPerToken);
    if (next > budget) break;
    cost = next;
    start = i;
  }
  return chars.slice(start).join("");
}

/**
 * Bounded head+tail reduction in the estimator's cost currency, never
 * head-only and never exceeding `maxCost`. `marker(omittedChars)` renders the
 * middle marker; the result's cost is bounded by construction (head and tail
 * budgets plus the marker's own length).
 */
export function truncateTextByCost(
  text: string,
  maxCost: number,
  charsPerToken: number,
  marker: (omittedChars: number) => string,
  headShare = OVERSIZED_HEAD_SHARE
): string {
  if (maxCost <= 0) return "";
  if (handoffTextCost(text, charsPerToken) <= maxCost) return text;
  const reserve = marker(text.length).length;
  // Too small for the marker: a bounded prefix is still better than nothing.
  if (maxCost <= reserve + 2) return headByCost(text, maxCost, charsPerToken);
  const remaining = maxCost - reserve;
  const headBudget = Math.max(1, Math.floor(remaining * headShare));
  const tailBudget = Math.max(0, remaining - headBudget);
  const head = headByCost(text, headBudget, charsPerToken);
  const tail = tailBudget > 0 ? tailByCost(text, tailBudget, charsPerToken) : "";
  const omitted = text.length - head.length - tail.length;
  return `${head}${marker(omitted)}${tail}`;
}

/**
 * Shorten text for retention, keeping a head AND the tail, tail-biased
 * (v8 §17). Never the head alone: for tests, compilers, builds and shell
 * output the end of the text carries the failure, the stack trace, the summary
 * and the exit status — the execution frontier.
 *
 * `maxCost` is in the estimator's ASCII-equivalent currency (see
 * `handoffTextCost`), so a CJK-heavy result cannot quietly consume more budget
 * than it was charged. The result's cost never exceeds `maxCost`.
 */
export function truncateForHandoffRetention(
  text: string,
  maxCost: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN
): string {
  return truncateTextByCost(text, maxCost, charsPerToken, omissionMarker);
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * How one context item was carried into the bundle (v9 §4). Only `full` and
 * `reconstructable-omitted` items may be excluded from the checkpoint's
 * summarization source: a `partial` item's omitted middle exists nowhere else,
 * so the checkpoint must still be able to represent it.
 */
export type HandoffRetentionClass = "full" | "partial" | "reconstructable-omitted";

export interface HandoffContextSelection {
  pinned: HandoffContextSlice[];
  retained: HandoffContextSlice[];
  /** ASCII-equivalent chars the pinned slices occupy in the rendered handoff. */
  pinnedChars: number;
  /** ASCII-equivalent chars the retained slices occupy in the rendered handoff. */
  retainedChars: number;
  /**
   * Item id → how the item was carried. `full` and `reconstructable-omitted`
   * items are complete representations; `partial` items were shortened, so the
   * checkpoint stays responsible for what they lost.
   */
  retentionByItemId: Map<string, HandoffRetentionClass>;
  /** Item ids carried in any form (including pins without source events). */
  coveredItemIds: Set<string>;
  /**
   * RunEvent ids that need no checkpoint representation — the item was carried
   * verbatim, or it was intentionally dropped as reconstructable. Partially
   * retained items are deliberately NOT in this set (v9 §4).
   */
  excludedFromSummaryEventIds: Set<string>;
  /** Items the budget dropped, oldest first — the checkpoint must cover them. */
  omittedItemIds: string[];
}

export interface SelectHandoffContextInput {
  items: HandoffContextItem[];
  budget: ResolvedHandoffBudget;
  /**
   * ASCII-equivalent chars held back before any context is selected: the
   * checkpoint's allowance, the render scaffolding, the workspace/run metadata
   * and the user notes.
   */
  reservedChars: number;
  /** Share of the free budget historical pins may claim. */
  pinnedShare?: number;
}

/**
 * Pick what survives, deterministically.
 *
 * 1. **Recent first.** The walk starts at the execution frontier and moves
 *    backwards, so what is lost when the budget runs out is the OLDEST
 *    context — never the failure the previous agent was staring at.
 * 2. **Atomic units.** A unit is kept whole or reduced as a whole; selection
 *    never cuts a transcript at an arbitrary character offset.
 * 3. **Tool-aware reduction.** An oversized reconstructable read keeps its
 *    call plus an omission marker; anything else oversized keeps a tail-biased
 *    head+tail.
 * 4. **Pins.** Historical user instructions are pinned verbatim out of their
 *    own allowance — an early "do not change the public API" is never left to
 *    a model's paraphrase.
 * 5. **No duplicates.** What the recent walk already retained is not pinned a
 *    second time (v8 §14).
 * 6. **No black hole.** A reduced item is reported as `partial`, so the part
 *    that did not fit still reaches the checkpoint (v9 §4).
 */
export function selectHandoffContext(input: SelectHandoffContextInput): HandoffContextSelection {
  const { items, budget } = input;
  const charsPerToken = budget.charsPerToken;
  const totalChars = charsForTokens(budget.maxTokens, charsPerToken);
  const available = Math.max(0, totalChars - Math.max(0, input.reservedChars));
  const pinAllowance = Math.floor(available * (input.pinnedShare ?? DEFAULT_PINNED_SHARE));

  // The pins are planned first only to learn how much of the budget they will
  // need; whatever they do not claim goes to the recent trajectory, which
  // outranks them (v8 §31). The plan is re-run after the walk, once it is
  // known which user turns the walk already kept.
  const plannedPins = planPinnedContext(items, new Set(), pinAllowance, charsPerToken);
  const retainedBudget = Math.max(0, available - plannedPins.chars);

  const recent = selectRecentTrajectory(items, retainedBudget, charsPerToken);
  // The second plan can pin a different set than the first (the walk has taken
  // some user turns), so its allowance is re-clamped to what the trajectory
  // actually left over. This is what makes `pinned + retained <= available`
  // hold exactly — and therefore the rendered handoff fit its budget.
  const pinned = planPinnedContext(
    items,
    recent.coveredItemIds,
    Math.max(0, Math.min(pinAllowance, available - recent.chars)),
    charsPerToken
  );

  const excludedFromSummaryEventIds = new Set<string>();
  for (const item of items) {
    const cls = recent.retentionByItemId.get(item.id);
    if (cls === "full" || cls === "reconstructable-omitted") {
      for (const id of item.eventIds) excludedFromSummaryEventIds.add(id);
    }
  }

  return {
    pinned: pinned.slices,
    retained: recent.slices,
    pinnedChars: pinned.chars,
    retainedChars: recent.chars,
    retentionByItemId: recent.retentionByItemId,
    coveredItemIds: recent.coveredItemIds,
    excludedFromSummaryEventIds,
    omittedItemIds: recent.omittedItemIds,
  };
}

/** Classify a slice against the item it was rendered from. */
function classifyItem(item: HandoffContextItem, sliceText: string): HandoffRetentionClass {
  if (item.reconstructable && item.omissionMarker && sliceText === item.omissionMarker) {
    return "reconstructable-omitted";
  }
  return sliceText === item.text ? "full" : "partial";
}

interface UnitSlices {
  slices: HandoffContextSlice[];
  chars: number;
  classes: Map<string, HandoffRetentionClass>;
}

/**
 * The slices a unit contributes when nothing forces it to be reduced.
 *
 * A large reconstructable body is replaced by its omission marker even when
 * the budget could afford it (v8 §16): a 50K-character file the new harness
 * can open in one call is not worth 25K tokens of handoff, and the marker
 * tells it exactly what to re-read. Small reads are kept — re-reading costs a
 * tool call, and the content is cheap.
 */
function unitSlices(unit: HandoffContextUnit, charsPerToken: number): UnitSlices {
  const result = unit.items.find((i) => i.kind === "tool-result");
  const omitBody =
    result?.reconstructable === true &&
    typeof result.omissionMarker === "string" &&
    handoffTextCost(result.text, charsPerToken) > RECONSTRUCTABLE_BODY_KEEP_MAX_CHARS;
  const classes = new Map<string, HandoffRetentionClass>();
  const slices = unit.items.map((item) => {
    let slice: HandoffContextSlice;
    if (omitBody && item === result) {
      slice = itemToSlice({ ...item, text: item.omissionMarker! }, "recent");
    } else if (omitBody && item.kind === "tool-call") {
      // The call only survives to make the reduced/omitted result readable.
      slice = itemToSlice(item, "paired");
    } else {
      slice = itemToSlice(item, "recent");
    }
    classes.set(item.id, classifyItem(item, slice.text));
    return slice;
  });
  return { slices, chars: slicesChars(slices, charsPerToken), classes };
}

/**
 * Walk the covered history from the execution frontier backwards (v8 §11).
 * The result is already in chronological order: selection runs backwards, the
 * handoff is always rendered oldest → newest (v8 §15 of the test plan).
 */
function selectRecentTrajectory(
  items: HandoffContextItem[],
  budgetChars: number,
  charsPerToken: number
): {
  slices: HandoffContextSlice[];
  chars: number;
  retentionByItemId: Map<string, HandoffRetentionClass>;
  coveredItemIds: Set<string>;
  omittedItemIds: string[];
} {
  const units = groupHandoffContextUnits(items);
  const slices: HandoffContextSlice[] = [];
  const coveredItemIds = new Set<string>();
  const retentionByItemId = new Map<string, HandoffRetentionClass>();
  let chars = 0;
  let cut = units.length;

  const carry = (result: UnitSlices) => {
    slices.unshift(...result.slices);
    for (const [id, cls] of result.classes) retentionByItemId.set(id, cls);
    chars += result.chars;
  };

  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    const full = unitSlices(unit, charsPerToken);
    const room = budgetChars - chars;
    if (full.chars <= room) {
      carry(full);
      for (const item of unit.items) coveredItemIds.add(item.id);
      cut = i;
      continue;
    }
    const reduced = reduceOversizedUnit(unit, room, charsPerToken);
    if (!reduced) break;
    carry(reduced);
    for (const item of unit.items) coveredItemIds.add(item.id);
    cut = i;
    if (room - reduced.chars < MIN_USEFUL_CHARS) break;
  }

  const omittedItemIds = units.slice(0, cut).flatMap((u) => u.items.map((i) => i.id));
  return { slices, chars, retentionByItemId, coveredItemIds, omittedItemIds };
}

/**
 * Reduce a unit that is larger than the room left for it. Returns `undefined`
 * when not even a reduced form is worth carrying, which ends the backwards
 * walk — everything older would be dropped for the same reason.
 */
function reduceOversizedUnit(
  unit: HandoffContextUnit,
  room: number,
  charsPerToken: number
): UnitSlices | undefined {
  const call = unit.items.find((i) => i.kind === "tool-call");
  const result = unit.items.find((i) => i.kind === "tool-result");
  const classes = new Map<string, HandoffRetentionClass>();

  const build = (item: HandoffContextItem, text: string, retention: HandoffContextSlice["retention"]) => {
    classes.set(item.id, classifyItem(item, text));
    return itemToSlice({ ...item, text }, retention);
  };

  // A local file body the new harness can re-read is never worth tens of
  // thousands of handoff characters (v8 §16): keep the call that names it and
  // replace the body with an explicit marker. A reconstructable body is never
  // truncated into the budget either — the marker or nothing.
  if (result?.reconstructable && result.omissionMarker) {
    const callSlice = call ? itemToSlice(call, "paired") : undefined;
    if (call && callSlice) classes.set(call.id, "full");
    const markerSlice = build(result, result.omissionMarker, "recent");
    const slices = callSlice ? [callSlice, markerSlice] : [markerSlice];
    const chars = slicesChars(slices, charsPerToken);
    return chars <= room ? { slices, chars, classes } : undefined;
  }

  // Everything else — test output, compiler output, a long assistant
  // conclusion — keeps a tail-biased head+tail (v8 §17). The call stays
  // readable but never crowds the body out of the allowance.
  const target = result ?? unit.items[0];
  const paired = call && call !== target ? call : undefined;
  let callSlice = paired ? itemToSlice(paired, "paired") : undefined;
  if (callSlice) classes.set(paired!.id, "full");
  if (callSlice && room - sliceChars(callSlice, charsPerToken) < MIN_USEFUL_CHARS) {
    const callRoom = Math.max(0, room - MIN_USEFUL_CHARS - sliceLabel("tool-call").length - 4);
    callSlice = build(paired!, truncateForHandoffRetention(paired!.text, callRoom, charsPerToken), "paired");
  }
  const bodyOverhead = sliceLabel(target.kind).length + 4;
  const bodyRoom = room - (callSlice ? sliceChars(callSlice, charsPerToken) : 0) - bodyOverhead;
  if (bodyRoom < MIN_USEFUL_CHARS) return undefined;
  const bodySlice = build(
    target,
    truncateForHandoffRetention(target.text, bodyRoom, charsPerToken),
    "oversized-truncated"
  );
  const slices = callSlice ? [callSlice, bodySlice] : [bodySlice];
  return { slices, chars: slicesChars(slices, charsPerToken), classes };
}

/**
 * Pin historical user instructions verbatim (v8 §13). The original task is
 * pinned first and, if it alone exceeds the allowance, shortened rather than
 * dropped; the remaining turns are taken newest → oldest until the allowance
 * runs out. Whatever cannot be pinned stays the checkpoint's job — but a
 * paraphrase is never the only copy of a constraint the user stated in their
 * own words.
 */
function planPinnedContext(
  items: HandoffContextItem[],
  alreadyCovered: Set<string>,
  allowanceChars: number,
  charsPerToken: number
): { slices: HandoffContextSlice[]; chars: number } {
  const candidates = items.filter((i) => i.kind === "user" && !alreadyCovered.has(i.id));
  const original = candidates.find((i) => i.originalTask);
  const rest = candidates.filter((i) => i !== original).reverse();
  const ordered = original ? [original, ...rest] : rest;

  const pinned: HandoffContextItem[] = [];
  let used = 0;
  for (const item of ordered) {
    const cost = sliceChars(itemToSlice(item, "pinned"), charsPerToken);
    if (used + cost <= allowanceChars) {
      pinned.push(item);
      used += cost;
      continue;
    }
    if (item.originalTask && pinned.length === 0) {
      const overhead = sliceLabel("user").length + 4;
      const room = allowanceChars - used - overhead;
      if (room >= MIN_USEFUL_CHARS) {
        const text = truncateForHandoffRetention(item.text, room, charsPerToken);
        pinned.push({ ...item, text });
        used += sliceChars(itemToSlice({ ...item, text }, "pinned"), charsPerToken);
      }
    }
  }
  // The order above only decides who gets the allowance; rendering restores
  // chronological order.
  pinned.sort((a, b) => a.order - b.order);
  return { slices: pinned.map((item) => itemToSlice(item, "pinned")), chars: used };
}

/* ------------------------------------------------------------------ */
/* Bundle assembly                                                     */
/* ------------------------------------------------------------------ */

/**
 * The generation-time facts the rendered handoff states next to the bundle:
 * which workspace the work happened in, how the previous run ended, what it
 * produced. Rendered by the handoff renderer and reserved for by the
 * assembler through this ONE function, so the budget cannot drift from what
 * the next harness actually reads.
 */
export function formatHandoffMetadataSections(meta: {
  workspaceStatus?: string;
  previousRunResult?: string;
  artifacts?: string[];
}): string {
  const lines: string[] = [];
  if (meta.workspaceStatus) lines.push(meta.workspaceStatus);
  if (meta.previousRunResult) lines.push(meta.previousRunResult);
  if (meta.artifacts?.length) lines.push(`Artifacts from that run: ${meta.artifacts.join(", ")}.`);
  return lines.join("\n");
}

export interface AssembleBundleInput {
  selection: HandoffContextSelection;
  budget: ResolvedHandoffBudget;
  checkpoint?: string;
  /**
   * ASCII-equivalent cost of everything the renderer writes outside
   * checkpoint/pins/retained: the workspace/run metadata and the fixed render
   * scaffolding.
   */
  metadataChars: number;
  /**
   * ASCII-equivalent cost of the user notes the renderer appends. Counted in
   * the same accounting as every other section, so the reported handoff size
   * covers what is actually sent (v9 §6).
   */
  userNotesChars?: number;
}

/**
 * Assemble the stored bundle and its budget accounting. Written once, at
 * generation time: what the record says is what the next harness gets, and
 * nothing downstream recomputes it (AGENTS.md).
 *
 * `budget.estimatedTokens` covers the handoff BODY only — checkpoint, pins,
 * retained trajectory, metadata, scaffolding and user notes. The receiving
 * harness's own instruction is appended outside this budget
 * (`renderHandoffPrompt`), which is a separate execution runway (v9 §6).
 */
export function assembleHandoffContextBundle(input: AssembleBundleInput): HandoffContextBundle {
  const { budget, selection } = input;
  const charsPerToken = budget.charsPerToken;
  const checkpointCost = input.checkpoint ? handoffTextCost(input.checkpoint, charsPerToken) : 0;
  const userNotesChars = Math.max(0, input.userNotesChars ?? 0);
  const accounting: HandoffContextBudget = {
    contextWindow: budget.contextWindow,
    maxTokens: budget.maxTokens,
    estimatedTokens: estimateTokens(
      checkpointCost + selection.pinnedChars + selection.retainedChars + input.metadataChars + userNotesChars,
      charsPerToken
    ),
    checkpointTokens: estimateTokens(checkpointCost, charsPerToken),
    pinnedTokens: estimateTokens(selection.pinnedChars, charsPerToken),
    retainedTokens: estimateTokens(selection.retainedChars, charsPerToken),
    metadataTokens: estimateTokens(input.metadataChars, charsPerToken),
    ...(userNotesChars > 0 ? { userNotesTokens: estimateTokens(userNotesChars, charsPerToken) } : {}),
    charsPerToken,
  };
  return {
    version: 2,
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    pinnedContext: selection.pinned,
    retainedContext: selection.retained,
    budget: accounting,
  };
}

/* ------------------------------------------------------------------ */
/* Turns left for the checkpoint                                       */
/* ------------------------------------------------------------------ */

/**
 * The covered turns with the fully-carried trajectory removed: what remains is
 * the checkpoint's job (v8 §20/§30).
 *
 * Only items classified `full` or `reconstructable-omitted` are excluded. A
 * `partial` item was shortened for retention, so its event stays in the
 * checkpoint's input — the omitted middle exists nowhere else and must not
 * become an information black hole (v9 §4). A turn whose user input was
 * retained keeps only its remaining events.
 *
 * Pinned user turns deliberately stay in: the checkpoint is the state index,
 * and it must be able to say what the user's constraints are (its
 * `## Constraints & Preferences` section is also what the UI reads back). A
 * pinned message therefore appears twice in the *checkpoint's input* — never
 * twice in the handoff, which is what §14 forbids.
 */
export function unretainedTurns(
  turns: HandoffContextSourceTurn[],
  collected: CollectedHandoffContext,
  selection: HandoffContextSelection
): HandoffContextSourceTurn[] {
  const out: HandoffContextSourceTurn[] = [];
  turns.forEach((turn, index) => {
    const userItemId = collected.turnUserItemIds.get(index);
    const userRetained = userItemId ? selection.coveredItemIds.has(userItemId) : false;
    const events = turn.events.filter((e) => !selection.excludedFromSummaryEventIds.has(e.id));
    const userPrompt = userRetained ? undefined : turn.userPrompt;
    if (events.length === 0 && !userPrompt?.trim()) return;
    out.push({ ...turn, events, userPrompt });
  });
  return out;
}
