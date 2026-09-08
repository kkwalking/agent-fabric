import { readdirSync, readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  HarnessThreadDetail,
  HarnessThreadFilter,
  HarnessThreadItem,
  HarnessThreadSummary,
  HarnessThreadTurn,
  LocalHarnessThreadSource,
} from "@agentfabric/core";

/**
 * Claude Code local session discovery (v7 §9/§10).
 *
 * Claude Code's *official* resume surface is `claude --resume <id>` (used
 * by the adapter for same-harness continuation). It exposes no CLI command
 * that *lists* sessions, so discovery falls back to the local session
 * transcripts Claude Code persists under `~/.claude/projects/<encoded
 * -cwd>/<session-id>.jsonl` — the format v7 §10 anticipates ("如果只能依
 * 赖本地 Transcript，则需要把相关逻辑限制在 Claude Code Adapter 内").
 *
 * Everything transcript-specific lives in this module (the adapter layer,
 * never AgentFabric core): the reader is defensive against unknown line
 * types and missing fields, reads only what discovery/adoption needs,
 * and never touches credential material. Reading a session executes no
 * model request.
 */

/** Transcript root override for tests; defaults to the CLI's own store. */
export function claudeProjectsRoot(): string {
  return process.env.AGENTFABRIC_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/**
 * Claude Code encodes a project cwd into a directory name by replacing
 * every non-alphanumeric character with "-": /Users/a/b.c → -Users-a-b-c
 * (verified against claude-cli 2.1.x on disk).
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Hard caps so a pathological transcript can never wedge discovery. */
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_LINES = 50_000;

/* ------------------------------------------------------------------ */
/* Transcript lines                                                    */
/* ------------------------------------------------------------------ */

interface TranscriptLine {
  type?: string;
  subtype?: string;
  summary?: string;
  leafUuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

function parseTranscript(path: string): TranscriptLine[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size > MAX_SESSION_BYTES) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines: TranscriptLine[] = [];
  for (const piece of raw.split("\n")) {
    if (!piece.trim()) continue;
    try {
      lines.push(JSON.parse(piece) as TranscriptLine);
    } catch {
      /* tolerate partial/corrupt lines */
    }
    if (lines.length >= MAX_SESSION_LINES) break;
  }
  return lines;
}

/** True for synthetic user lines (slash-command plumbing, reminders). */
function isSyntheticUserText(text: string): boolean {
  return (
    text.startsWith("<command-name>") ||
    text.startsWith("<command-message>") ||
    text.startsWith("<command-args>") ||
    text.startsWith("<local-command-") ||
    text.startsWith("<system-reminder>") ||
    text.startsWith("Caveat:")
  );
}

/** Extracts the real user text from a user-role message content field. */
function userTextOf(content: unknown): string | undefined {
  if (typeof content === "string") {
    const text = content.trim();
    return text && !isSyntheticUserText(text) ? text : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((b) => asRecord(b).type === "text")
    .map((b) => String(asRecord(b).text ?? ""));
  const text = texts.join("").trim();
  return text && !isSyntheticUserText(text) ? text : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Normalizes a tool_result content field to text. */
function resultTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (asRecord(b).type === "text" ? String(asRecord(b).text ?? "") : "")).join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/* ------------------------------------------------------------------ */
/* Session summary                                                     */
/* ------------------------------------------------------------------ */

interface SessionScan {
  summary: HarnessThreadSummary;
  /** Whether the transcript carries any readable conversation at all. */
  hasConversation: boolean;
}

function scanSession(id: string, lines: TranscriptLine[], mtimeMs: number): SessionScan {
  let title: string | undefined;
  let firstUser: string | undefined;
  let model: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let lastTimestamp: string | undefined;
  let turns = 0;
  let hasConversation = false;

  for (const line of lines) {
    if (line.cwd && !cwd) cwd = line.cwd;
    if (line.timestamp) {
      if (!createdAt) createdAt = line.timestamp;
      lastTimestamp = line.timestamp;
    }
    if (line.type === "summary" && typeof line.summary === "string" && line.summary.trim() && !title) {
      title = line.summary.trim();
      continue;
    }
    if (line.isSidechain || line.isMeta) continue;
    if (line.type === "user" && line.message?.role === "user") {
      const text = userTextOf(line.message.content);
      if (text) {
        turns += 1;
        hasConversation = true;
        if (!firstUser) firstUser = text;
      }
      continue;
    }
    if (line.type === "assistant" && line.message?.role === "assistant") {
      if (!model && typeof line.message.model === "string" && line.message.model) model = line.message.model;
      const blocks = Array.isArray(line.message.content) ? line.message.content : [];
      if (blocks.some((b) => asRecord(b).type === "text" && String(asRecord(b).text ?? "").trim())) {
        hasConversation = true;
      }
    }
  }

  const updatedAt = lastTimestamp ?? new Date(mtimeMs).toISOString();
  return {
    hasConversation,
    summary: {
      id,
      title: title ?? (firstUser ? firstUser.slice(0, 80) : undefined),
      preview: firstUser?.slice(0, 400),
      cwd,
      createdAt,
      updatedAt,
      turnCount: turns > 0 ? turns : undefined,
      model,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

function sessionFiles(dir: string): Array<{ id: string; file: string; mtimeMs: number }> {
  const out: Array<{ id: string; file: string; mtimeMs: number }> = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = join(dir, entry.name);
    try {
      out.push({ id: entry.name.replace(/\.jsonl$/, ""), file, mtimeMs: statSync(file).mtimeMs });
    } catch {
      /* file vanished between readdir and stat */
    }
  }
  return out;
}

/**
 * A workspace cwd must be matched in its literal and symlink-resolved
 * forms (macOS /tmp → /private/tmp), each encoded the way Claude Code
 * names its project directories.
 */
function encodedCwdCandidates(cwd: string): string[] {
  const out = new Set<string>([encodeClaudeProjectDir(cwd)]);
  try {
    out.add(encodeClaudeProjectDir(resolve(cwd)));
  } catch {
    /* keep the literal form */
  }
  try {
    out.add(encodeClaudeProjectDir(realpathSync(cwd)));
  } catch {
    /* path may not exist anymore */
  }
  return [...out];
}

/**
 * Lists local Claude Code sessions (v7 §9), newest first, optionally
 * narrowed to a workspace cwd. Sessions with no readable conversation
 * (hook plumbing only, aborted before the first turn) are skipped.
 */
export async function listClaudeSessions(
  filter: HarnessThreadFilter = {},
  opts: { projectsDir?: string } = {}
): Promise<HarnessThreadSummary[]> {
  const root = opts.projectsDir ?? claudeProjectsRoot();
  if (!existsSync(root)) return [];

  let dirs: string[];
  if (filter.cwd) {
    const wanted = new Set(encodedCwdCandidates(filter.cwd));
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && wanted.has(e.name))
      .map((e) => join(root, e.name));
  } else {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name));
  }

  const candidates: Array<{ summary: HarnessThreadSummary; mtimeMs: number }> = [];
  for (const dir of dirs) {
    for (const { id, file, mtimeMs } of sessionFiles(dir)) {
      const scan = scanSession(id, parseTranscript(file), mtimeMs);
      if (!scan.hasConversation) continue;
      candidates.push({ summary: scan.summary, mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = filter.limit && filter.limit > 0 ? candidates.slice(0, filter.limit) : candidates;
  return limited.map((c) => c.summary);
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Reads an existing Claude Code session (v7 §10) without executing the
 * model: user instructions, agent responses, reasoning, shell/file/tool
 * activity — correlated from the transcript. Tool results are attached to
 * their calls by `tool_use_id`; sidechain (subagent) internals are
 * skipped.
 */
export async function readClaudeSession(
  sessionId: string,
  opts: { projectsDir?: string } = {}
): Promise<HarnessThreadDetail> {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Invalid Claude Code session id: ${sessionId}`);
  const root = opts.projectsDir ?? claudeProjectsRoot();
  if (!existsSync(root)) throw new Error(`Claude Code session not found: ${sessionId}`);

  let file: string | undefined;
  let mtimeMs = 0;
  let projectDir: string | undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      file = candidate;
      projectDir = join(root, entry.name);
      mtimeMs = statSync(candidate).mtimeMs;
      break;
    }
  }
  if (!file) throw new Error(`Claude Code session not found: ${sessionId}`);

  const lines = parseTranscript(file);
  const scan = scanSession(sessionId, lines, mtimeMs);

  const items: HarnessThreadItem[] = [];
  const turns: HarnessThreadTurn[] = [];
  let turn: HarnessThreadTurn = { items: [] };
  turns.push(turn);
  // Pending tool calls by id — results arriving later mutate these items.
  const pending = new Map<
    string,
    | { item?: Extract<HarnessThreadItem, { kind: "tool-call" | "command" }>; name: string; input: Record<string, unknown>; fileTool?: boolean }
  >();

  const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
  const FILE_WRITE_TOOLS = new Set(["Write"]);

  for (const line of lines) {
    if (line.isSidechain || line.isMeta) continue;
    const ts = typeof line.timestamp === "string" ? line.timestamp : undefined;
    if (line.type === "user" && line.message?.role === "user") {
      const content = line.message.content;
      // Real user input → new turn boundary.
      const text = userTextOf(content);
      if (text) {
        turn = { userText: text, items: [] };
        turns.push(turn);
        const item: HarnessThreadItem = { kind: "user-message", text, ...(ts ? { timestamp: ts } : {}) };
        items.push(item);
        turn.items.push(item);
      }
      // Tool results ride user-role messages.
      if (Array.isArray(content)) {
        for (const block of content) {
          const rec = asRecord(block);
          if (rec.type !== "tool_result") continue;
          const id = typeof rec.tool_use_id === "string" ? rec.tool_use_id : undefined;
          const entry2 = id ? pending.get(id) : undefined;
          const textOut = resultTextOf(rec.content);
          const isError = Boolean(rec.is_error);
          if (entry2) {
            if (id) pending.delete(id);
            // File tools already emitted their file-change at call time;
            // the result only confirms the edit.
            if (entry2.fileTool) continue;
            if (entry2.item && entry2.item.kind === "command") {
              entry2.item.output = textOut;
              entry2.item.exitCode = null;
            } else if (entry2.item) {
              entry2.item.result = textOut || undefined;
              entry2.item.isError = isError;
            }
            continue;
          }
          // Result without a recorded call (e.g. edit performed before the
          // parsed range): still surface it as generic tool activity.
          const item: HarnessThreadItem = {
            kind: "tool-call",
            tool: "tool",
            result: textOut || undefined,
            isError,
            ...(ts ? { timestamp: ts } : {}),
          };
          items.push(item);
          turn.items.push(item);
        }
      }
      continue;
    }
    if (line.type === "assistant" && line.message?.role === "assistant") {
      const blocks = Array.isArray(line.message.content) ? line.message.content : [];
      for (const block of blocks) {
        const rec = asRecord(block);
        if (rec.type === "text") {
          const text = String(rec.text ?? "").trim();
          if (!text) continue;
          const item: HarnessThreadItem = { kind: "agent-message", text, ...(ts ? { timestamp: ts } : {}) };
          items.push(item);
          turn.items.push(item);
        } else if (rec.type === "thinking") {
          const text = String(rec.thinking ?? "").trim();
          if (!text) continue;
          const item: HarnessThreadItem = { kind: "reasoning", text, ...(ts ? { timestamp: ts } : {}) };
          items.push(item);
          turn.items.push(item);
        } else if (rec.type === "tool_use") {
          const id = typeof rec.id === "string" ? rec.id : undefined;
          const name = typeof rec.name === "string" ? rec.name : "tool";
          const input = asRecord(rec.input);
          if (name === "Bash") {
            const item: HarnessThreadItem = {
              kind: "command",
              command: String(input.command ?? "(bash)"),
              ...(ts ? { timestamp: ts } : {}),
            };
            items.push(item);
            turn.items.push(item);
            if (id) pending.set(id, { item: item as Extract<HarnessThreadItem, { kind: "command" }>, name, input });
          } else if (FILE_EDIT_TOOLS.has(name) || FILE_WRITE_TOOLS.has(name)) {
            const path = String(input.file_path ?? input.path ?? "(file)");
            const item: HarnessThreadItem = {
              kind: "file-change",
              path,
              action: FILE_WRITE_TOOLS.has(name) ? "add" : "update",
              ...(ts ? { timestamp: ts } : {}),
            };
            items.push(item);
            turn.items.push(item);
            if (id) pending.set(id, { name, input, fileTool: true });
          } else {
            const item: HarnessThreadItem = {
              kind: "tool-call",
              tool: name,
              arguments: input,
              ...(ts ? { timestamp: ts } : {}),
            };
            items.push(item);
            turn.items.push(item);
            if (id) {
              pending.set(id, {
                item: item as Extract<HarnessThreadItem, { kind: "tool-call" }>,
                name,
                input,
              });
            }
          }
        }
      }
    }
    // attachment / queue-operation / summary / system / unknown: not
    // conversation content (summary already fed the title).
  }

  return {
    ...scan.summary,
    cwd: scan.summary.cwd ?? tryDecodeProjectDir(projectDir),
    items,
    turns: turns.filter((t) => t.userText !== undefined || t.items.length > 0),
  };
}

/**
 * Best-effort cwd recovery from the encoded project directory name
 * (single-use fallback when no transcript line carries `cwd`).
 */
function tryDecodeProjectDir(projectDir: string | undefined): string | undefined {
  if (!projectDir) return undefined;
  const encoded = projectDir.split(/[\\/]/).pop() ?? "";
  return encoded.startsWith("-") ? encoded.replace(/-/g, "/") : undefined;
}

/**
 * Claude Code implementation of the local harness thread source port
 * (v7 §9–§11). Transcript parsing stays here, in the adapter layer.
 */
export const claudeCodeThreadSource: LocalHarnessThreadSource = {
  kind: "claude-code",
  listThreads: (filter) => listClaudeSessions(filter),
  readThread: (threadId) => readClaudeSession(threadId),
};
