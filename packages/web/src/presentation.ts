/**
 * Presentation layer for the Task Thread (v5 §24/§25).
 *
 * Raw RunEvents are projected into readable Timeline Items:
 *   Raw Event → Presentation Projector → Timeline Item
 *
 * - Infrastructure events (run.*, runtime.session.*, native.state.*,
 *   workspace.*, container.*, usage.*, model.*, log, run.progress) are
 *   swallowed — the thread surfaces them as lightweight turn metadata
 *   instead (v5 §19).
 * - tool.started + tool.completed merge into ONE ToolActivity.
 * - shell.command + shell.output merge into ONE CommandActivity.
 * - Harness echoes of the input instruction (agent.message role=user /
 *   role=system) are swallowed — the thread shows `run.userPrompt`, never
 *   the stitched harness prompt (v5 §4/§5).
 * - The Core Event Schema is untouched.
 */

export interface RawEvent {
  id: string;
  runId: string;
  seq: number;
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
  level?: string;
  source?: string;
}

export interface ToolActivity {
  kind: "tool";
  key: string;
  /** Human-readable one-liner, e.g. "Read README.md" (v5 §7). */
  label: string;
  tool: string;
  status: "running" | "done" | "error";
  args?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface CommandActivity {
  kind: "command";
  key: string;
  command: string;
  cwd?: string;
  backend?: string;
  outputs: string[];
  running: boolean;
  /** Short outcome line, e.g. "✓ 148 tests passed" (v5 §9). */
  summary?: string;
  summaryOk?: boolean;
}

export interface FileActivity {
  kind: "file";
  key: string;
  action: "created" | "modified";
  path: string;
}

export interface ThinkingItem {
  kind: "thinking";
  key: string;
  content?: string;
}

export interface AgentMessageItem {
  kind: "agent-message";
  key: string;
  content: string;
  model?: string;
}

export interface ErrorItem {
  kind: "error";
  key: string;
  message: string;
}

export type TimelineItem = ToolActivity | CommandActivity | FileActivity | ThinkingItem | AgentMessageItem | ErrorItem;

/* ------------------------------------------------------------------ */
/* Readable labels (v5 §7/§10)                                         */
/* ------------------------------------------------------------------ */

const TOOL_VERBS: Record<string, string> = {
  read: "Read",
  read_file: "Read",
  cat: "Read",
  view: "Read",
  write: "Wrote",
  write_file: "Wrote",
  edit: "Edited",
  edit_file: "Edited",
  str_replace: "Edited",
  apply_patch: "Applied patch to",
  patch: "Patched",
  bash: "Ran",
  shell: "Ran",
  run_command: "Ran",
  terminal: "Ran",
  exec: "Ran",
  glob: "Listed",
  list: "Listed",
  ls: "Listed",
  list_files: "Listed",
  readdir: "Listed",
  grep: "Searched",
  search: "Searched",
  search_files: "Searched",
  find: "Searched",
  todo: "Updated the task list",
  todos: "Updated the task list",
  task_list: "Updated the task list",
  fetch: "Fetched",
  webfetch: "Fetched",
  web_fetch: "Fetched",
  browser: "Opened",
  websearch: "Searched the web",
  web_search: "Searched the web",
};

function argsOf(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const args = data?.args;
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

/** Picks the most meaningful target for a tool call: file path, command, pattern or url. */
function toolTarget(tool: string, data: Record<string, unknown> | undefined): string | undefined {
  const args = argsOf(data);
  const fromArgs =
    args.path ?? args.file_path ?? args.filePath ?? args.filename ?? args.abs_path ?? undefined;
  if (typeof fromArgs === "string" && fromArgs) return fromArgs;
  if (data?.path && typeof data.path === "string") return data.path;
  if (data?.file && typeof data.file === "string") return data.file;
  const lower = tool.toLowerCase();
  if (typeof args.command === "string" && args.command) return args.command;
  if (typeof args.cmd === "string" && args.cmd) return args.cmd;
  if (typeof args.pattern === "string" && args.pattern) return args.pattern;
  if (typeof args.query === "string" && args.query) return args.query;
  if (typeof args.url === "string" && args.url) return args.url;
  if (lower.includes("todo")) return undefined;
  return undefined;
}

export function toolLabel(tool: string, data: Record<string, unknown> | undefined): string {
  const verb = TOOL_VERBS[tool.toLowerCase()] ?? `Used ${tool}`;
  const target = toolTarget(tool, data);
  return target ? `${verb} ${target}` : verb;
}

/* ------------------------------------------------------------------ */
/* Command output summary (v5 §9)                                      */
/* ------------------------------------------------------------------ */

const PASS_RE = /(\d+)\s*(?:tests?|specs?)?\s*(?:passed|passing|pass)|all tests passed|\bPASS\b|build succeeded|✓/i;
const FAIL_RE = /(\d+)\s*(?:tests?|specs?)?\s*(?:failed|failing|fail)|tests? failed|\bFAIL\b|build failed|compilation error|error:/i;

export function summarizeOutput(outputs: string[]): { text: string; ok: boolean } | undefined {
  const lines = outputs.map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const fail = lines[i].match(FAIL_RE);
    if (fail) return { text: `✗ ${lines[i].slice(0, 120)}`, ok: false };
    const pass = lines[i].match(PASS_RE);
    if (pass) return { text: `✓ ${lines[i].slice(0, 120)}`, ok: true };
  }
  const first = lines[0];
  return { text: first.length > 120 ? `${first.slice(0, 120)}…` : first, ok: true };
}

/* ------------------------------------------------------------------ */
/* Projector                                                           */
/* ------------------------------------------------------------------ */

function eventText(data: Record<string, unknown> | undefined): string {
  return String(data?.content ?? data?.text ?? data?.message ?? data?.line ?? "");
}

/**
 * Projects one run's events into timeline items (v5 §25 merging rules).
 * The input must be sorted by seq. `live` marks whether the run is still
 * executing: once terminal, open activities close instead of spinning.
 */
export function projectTimeline(events: RawEvent[], opts: { live?: boolean } = {}): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolsByKey = new Map<string, ToolActivity>();
  const filesByPath = new Map<string, FileActivity>();
  let keySeq = 0;
  const nextKey = (p: string) => `${p}-${++keySeq}`;

  const findTool = (data: Record<string, unknown> | undefined, tool: string): ToolActivity | undefined => {
    const callId = data?.toolCallId ?? data?.callID;
    if (typeof callId === "string" && toolsByKey.has(callId)) return toolsByKey.get(callId);
    // Fall back to the newest running item for the same tool name.
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "tool" && it.tool === tool && it.status === "running") return it;
    }
    return undefined;
  };

  for (const e of events) {
    const data = e.data ?? {};
    switch (e.type) {
      case "agent.message": {
        const role = data?.role;
        // Harness echoes of the stitched instruction / system prompt are
        // not user messages — the thread renders `run.userPrompt` (v5 §4/§5).
        if (role === "user" || role === "system") break;
        const content = eventText(data).trim();
        if (!content) break;
        items.push({
          kind: "agent-message",
          key: e.id ?? nextKey("msg"),
          content,
          model: typeof data.model === "string" ? data.model : undefined,
        });
        break;
      }

      case "agent.thinking": {
        const content = eventText(data).trim();
        const last = items[items.length - 1];
        if (last?.kind === "thinking") {
          if (content) last.content = last.content ? `${last.content}\n${content}` : content;
        } else {
          items.push({ kind: "thinking", key: e.id ?? nextKey("think"), content: content || undefined });
        }
        break;
      }

      case "tool.started": {
        const tool = String(data.tool ?? "tool");
        const key = typeof data.toolCallId === "string" && data.toolCallId ? data.toolCallId : nextKey("tool");
        const item: ToolActivity = {
          kind: "tool",
          key,
          tool,
          label: toolLabel(tool, data),
          status: "running",
          args: data.args,
        };
        toolsByKey.set(key, item);
        items.push(item);
        break;
      }

      case "tool.progress": {
        const tool = String(data.tool ?? "tool");
        const item = findTool(data, tool);
        if (item && data.partialResult !== undefined) item.result = data.partialResult;
        break;
      }

      case "tool.completed": {
        const tool = String(data.tool ?? "tool");
        const isError = Boolean(data.isError ?? data.error ?? (data.status === "error"));
        let item = findTool(data, tool);
        if (!item) {
          // Harnesses that only report terminal tool states (opencode):
          // the completed call is still a complete activity.
          const key = typeof (data.toolCallId ?? data.callID) === "string"
            ? String(data.toolCallId ?? data.callID)
            : nextKey("tool");
          item = { kind: "tool", key, tool, label: toolLabel(tool, data), status: "done", args: data.input ?? data.args };
          toolsByKey.set(key, item);
          items.push(item);
        }
        item.status = isError ? "error" : "done";
        item.label = toolLabel(tool, { ...data, args: data.args ?? item.args ?? data.input });
        if (data.result !== undefined || data.output !== undefined) {
          item.result = data.result ?? data.output;
        }
        if (data.error !== undefined) item.error = String(data.error);
        break;
      }

      case "shell.command": {
        items.push({
          kind: "command",
          key: e.id ?? nextKey("cmd"),
          command: String(data.command ?? "(command)"),
          cwd: typeof data.cwd === "string" ? data.cwd : undefined,
          backend: typeof data.backend === "string" ? data.backend : undefined,
          outputs: [],
          running: true,
        });
        break;
      }

      case "shell.output": {
        const line = eventText(data);
        // Merge into the most recent open command activity (v5 §25).
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "command") {
            if (line) it.outputs.push(line);
            const summary = summarizeOutput(it.outputs);
            it.summary = summary?.text ?? it.summary;
            it.summaryOk = summary?.ok;
            break;
          }
        }
        break;
      }

      case "file.created":
      case "file.modified": {
        const path = String(data.path ?? data.file ?? "");
        if (!path) break;
        const action = e.type === "file.created" ? "created" : "modified";
        const existing = filesByPath.get(path);
        if (existing) {
          existing.action = action;
        } else {
          const item: FileActivity = { kind: "file", key: e.id ?? nextKey("file"), action, path };
          filesByPath.set(path, item);
          items.push(item);
        }
        break;
      }

      case "runtime.error": {
        const message = String(data.error ?? (eventText(data) || "Runtime error"));
        items.push({ kind: "error", key: e.id ?? nextKey("err"), message });
        break;
      }

      default:
        // Infrastructure events stay in the Run Inspector (v5 §12/§19).
        break;
    }
  }

  if (!opts.live) {
    for (const it of items) {
      if (it.kind === "tool" && it.status === "running") it.status = "done";
      if (it.kind === "command") it.running = false;
    }
  }

  return items;
}

/** True while any command activity is still open (used for live spinners). */
export function isWorkRunning(items: TimelineItem[]): boolean {
  return items.some((it) => (it.kind === "tool" && it.status === "running") || (it.kind === "command" && it.running));
}
