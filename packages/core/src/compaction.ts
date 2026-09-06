/**
 * Handoff context generation aligned with the pi coding agent's session
 * compaction (pi: packages/coding-agent/src/core/compaction/).
 *
 * Pi's compaction summarizes a conversation with an LLM into a
 * structured context checkpoint, supports iterative updates on top of a
 * previous summary, tracks file operations from tool calls and appends
 * them to the summary as XML tags. AgentFabric reuses that exact
 * pipeline — prompts, serialization format, token budgets and failure
 * checks are kept verbatim — to generate handoff content between runs:
 *
 *   RunEvents → serializeConversation → <conversation>…</conversation>
 *             → (+ <previous-summary> from the previous handoff in the
 *                task's run chain, for pi's iterative update flow)
 *             → SUMMARIZATION_PROMPT / UPDATE_SUMMARIZATION_PROMPT
 *             → LLM → structured checkpoint + <read-files>/<modified-files>
 *             → HandoffContent
 *
 * One deliberate difference from in-session compaction: pi's cut-point
 * logic (keepRecentTokens) selects what to keep in the SAME session; a
 * handoff starts a NEW native session where nothing is kept, so the
 * whole run is summarized — exactly like pi's own handoff extension.
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
/* Settings (pi: DEFAULT_COMPACTION_SETTINGS)                          */
/* ------------------------------------------------------------------ */

/**
 * Compaction settings for handoff summarization. `reserveTokens` mirrors
 * pi's default and drives the summary's max output tokens
 * (⌊0.8 × reserveTokens⌋, pi's generateSummaryWithUsage budget).
 */
export interface CompactionSettings {
  reserveTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  reserveTokens: 16384,
};

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
 * as one command's output). Tool results are truncated to
 * TOOL_RESULT_MAX_CHARS exactly like pi.
 */
export function serializeRunConversation(events: RunEvent[], task?: Task): string {
  const parts: SerializedPart[] = [];

  // The task prompt is the conversation's opening user message; runs
  // may not echo it back as an agent.message event.
  const hasUserMessage = events.some(
    (e) => e.type === "agent.message" && e.data?.role === "user"
  );
  if (task && !hasUserMessage) {
    parts.push({ kind: "user", text: `#${task.title}: ${task.prompt}` });
  }

  let pendingShellOutput: string[] = [];
  const flushShell = () => {
    if (pendingShellOutput.length) {
      parts.push({ kind: "toolResult", text: pendingShellOutput.join("\n") });
      pendingShellOutput = [];
    }
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
      case "tool.started":
      case "tool.completed": {
        flushShell();
        const tool = eventText(e, ["tool", "toolName"]) ?? "tool";
        const args: Record<string, unknown> = isObj(e.data?.input)
          ? (e.data!.input as Record<string, unknown>)
          : e.data?.path !== undefined || e.data?.command !== undefined
            ? Object.fromEntries(
                Object.entries(e.data!).filter(([k]) => ["path", "command", "pattern", "query"].includes(k))
              )
            : {};
        parts.push({ kind: "toolCalls", text: formatToolCall(tool, args) });
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
      case "shell.output":
      case "log": {
        const line = eventText(e, ["line", "message"]);
        if (line) pendingShellOutput.push(line);
        break;
      }
      default:
        break;
    }
  }
  flushShell();

  const rendered = parts.map((p) => {
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
 * Extract file operations from a run's events — pi extracts them from
 * assistant toolCall blocks; AgentFabric's equivalent records are
 * tool events plus the workspace-change events (file.created → written,
 * file.modified → edited).
 */
export function extractFileOperations(events: RunEvent[]): FileOperations {
  const fileOps = createFileOps();
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
      throw new Error(`Provider "${provider.name}" has wire format "custom" — cannot generate a compaction summary`);
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

/* ------------------------------------------------------------------ */
/* Summarization (pi: generateSummaryWithUsage)                        */
/* ------------------------------------------------------------------ */

/**
 * Build the summarization user prompt: conversation wrapped in tags,
 * optional previous summary, then the base prompt (pi: verbatim
 * structure). Exposed for tests and preview tooling.
 */
export function buildSummarizationPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string
): string {
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }

  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
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

export interface CompactionHandoffInput {
  task: Task;
  run: Run;
  events: RunEvent[];
  artifacts: Artifact[];
  workspace?: Workspace;
  runtimeName?: string;
  /** Summary of the handoff the summarized run consumed (iterative update). */
  previousSummary?: string;
  /** Optional custom focus (pi: customInstructions). */
  customInstructions?: string;
  complete: CompletionFn;
  settings?: CompactionSettings;
  /** Cap from the model's parameters, when configured (pi: model.maxTokens). */
  modelMaxTokens?: number;
  signal?: AbortSignal;
}

export interface CompactionHandoffResult {
  /** The raw pi-format checkpoint (structured summary + file XML tags). */
  summary: string;
  content: HandoffContent;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Generate handoff content through pi's compaction pipeline: serialize
 * the run, call the LLM with pi's prompts, enforce pi's failure checks,
 * append tracked file lists and map the checkpoint into HandoffContent.
 * Throws on failure — callers fall back to the heuristic generator.
 */
export async function generateCompactionHandoff(input: CompactionHandoffInput): Promise<CompactionHandoffResult> {
  const { task, run, events, artifacts, workspace, complete } = input;
  const settings = input.settings ?? DEFAULT_COMPACTION_SETTINGS;

  const modelMax = input.modelMaxTokens ?? 0;
  const maxTokens = Math.floor(0.8 * settings.reserveTokens); // pi: floor(0.8 × reserveTokens)

  const conversationText = serializeRunConversation(events, task);
  const prompt = buildSummarizationPrompt(conversationText, input.previousSummary, input.customInstructions);

  const response = await complete({
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    prompt,
    maxTokens: modelMax > 0 ? Math.min(maxTokens, modelMax) : maxTokens,
    signal: input.signal,
  });

  const failure = getSummarizationFailure(response, "Summarization");
  if (failure) throw new Error(failure);
  if (!response.text.trim()) throw new Error("Summarization returned an empty summary");

  const fileOps = extractFileOperations(events);
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);

  const summary = response.text.trim() + formatFileOperations(readFiles, modifiedFiles);
  const content = compactionSummaryToHandoffContent(summary, {
    task,
    run,
    artifacts,
    workspace,
    runtimeName: input.runtimeName,
  });

  return { summary, content, usage: response.usage };
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
    .filter((l) => l && !/^\[.*\]$/.test(l) && l !== "(none)");
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
 * `compactionSummary` keeps the full checkpoint verbatim — the rendered
 * handoff prompt embeds it as-is so the next agent receives exactly
 * what pi's compaction would have produced.
 */
export function compactionSummaryToHandoffContent(
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

  const readMatch = /<read-files>\n([\s\S]*?)\n<\/read-files>/.exec(summary);
  const modifiedMatch = /<modified-files>\n([\s\S]*?)\n<\/modified-files>/.exec(summary);
  const relevantFiles = [
    ...new Set([...(readMatch?.[1].split("\n") ?? []), ...(modifiedMatch?.[1].split("\n") ?? [])].filter(Boolean)),
  ];

  const { run, task, artifacts, workspace } = meta;
  const remainingWork = [...inProgress.map((l) => `[in progress] ${l}`), ...blocked.map((l) => `[blocked] ${l}`), ...nextSteps];

  const content: HandoffContent = {
    originalTask: `#${task.title}: ${task.prompt}`.slice(0, 2000),
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
