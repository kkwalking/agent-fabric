import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
 * Pi Coding Agent local session discovery.
 *
 * Pi exposes no CLI that lists sessions; discovery reads the session
 * transcripts it persists under `~/.pi/agent/sessions/--<encoded-cwd>/
 * <timestamp>_<id>.jsonl` (overridable via AGENTFABRIC_PI_SESSIONS_DIR for
 * tests) — the same files pi's own `--session <id|path>` resume reads. A
 * transcript's first line is the session header
 * `{"type":"session","version":1|2|3,id,timestamp,cwd}`; that header is
 * also the format signature — files without it are not pi sessions and
 * are skipped. Everything transcript-specific lives in this module (the
 * adapter layer, never AgentFabric core).
 *
 * Entries form a tree through `id`/`parentId` (v1 files have no ids and
 * are read as a linear chain). Only the active branch is read: the walk
 * from the last entry to the root — abandoned branches are not part of
 * the conversation. Reading a session executes no model request.
 */

/** Transcript root override for tests; defaults to the CLI's own store. */
export function piSessionsRoot(): string {
  return process.env.AGENTFABRIC_PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
}

/** Hard caps so a pathological transcript can never wedge discovery. */
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_LINES = 50_000;

const FILE_EDIT_TOOLS = new Set(["edit", "multiedit", "notebookedit"]);
const FILE_WRITE_TOOLS = new Set(["write"]);

/* ------------------------------------------------------------------ */
/* Transcript shapes                                                   */
/* ------------------------------------------------------------------ */

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiMessage;
  modelId?: string; // model_change
  name?: string; // session_info
  summary?: string; // compaction / branch_summary
  command?: string; // bashExecution
  output?: string;
  excludeFromContext?: boolean;
  [key: string]: unknown;
}

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string; // toolCall
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
}

interface PiMessage {
  role?: string;
  content?: string | PiContentBlock[];
  model?: string;
  toolCallId?: string; // toolResult
  isError?: boolean;
  [key: string]: unknown;
}

interface SessionParse {
  summary: HarnessThreadSummary;
  hasConversation: boolean;
  items: HarnessThreadItem[];
  turns: HarnessThreadTurn[];
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function parseTranscript(file: string, mtimeMs: number): SessionParse | null {
  try {
    if (statSync(file).size > MAX_SESSION_BYTES) return null;
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const recs: PiEntry[] = [];
  for (const piece of raw.split("\n")) {
    if (!piece.trim()) continue;
    try {
      recs.push(JSON.parse(piece) as PiEntry);
    } catch {
      /* tolerate partial/corrupt lines */
    }
    if (recs.length >= MAX_SESSION_LINES) break;
  }

  // Format signature: the session header. Files without it are not pi
  // sessions (foreign .jsonl in the tree is skipped, not misread).
  const header = recs.find((r) => r?.type === "session" && typeof r.version === "number");
  if (!header) return null;

  // Tree → active branch. Each entry's parent: the entry its parentId
  // names when it carries one, else — explicit null means root, a missing
  // parentId means the previous entry (v1 linear chain).
  const entries = recs.filter((r) => r && r.type !== "session");
  const byId = new Map(entries.map((e) => [e.id as string, e] as const).filter(([id]) => typeof id === "string"));
  const parents = new Map<PiEntry, PiEntry | undefined>();
  let previous: PiEntry | undefined;
  for (const entry of entries) {
    const parent =
      typeof entry.parentId === "string"
        ? byId.get(entry.parentId)
        : entry.parentId === null
          ? undefined
          : previous;
    parents.set(entry, parent);
    previous = entry;
  }
  // The walk starts at the last entry (the live leaf) and follows parents
  // to the root; the branch is the conversation, in time order.
  const branch: PiEntry[] = [];
  const seen = new Set<PiEntry>();
  for (let cursor: PiEntry | undefined = entries[entries.length - 1]; cursor && !seen.has(cursor); cursor = parents.get(cursor)) {
    seen.add(cursor);
    branch.push(cursor);
  }
  branch.reverse();

  const items: HarnessThreadItem[] = [];
  const turns: HarnessThreadTurn[] = [];
  let turn: HarnessThreadTurn = { items: [] };
  turns.push(turn);
  let title: string | undefined;
  let firstUser: string | undefined;
  let lastModelChange: string | undefined;
  let firstAssistantModel: string | undefined;
  let lastTimestamp: string | undefined;
  let turnCount = 0;
  let hasConversation = false;
  // toolCall id → the pending item its toolResult completes.
  const pending = new Map<
    string,
    { item?: Extract<HarnessThreadItem, { kind: "tool-call" | "command" }>; fileTool?: boolean }
  >();

  const absorb = (item: HarnessThreadItem): void => {
    items.push(item);
    turn.items.push(item);
  };

  for (const entry of branch) {
    if (entry.timestamp) lastTimestamp = entry.timestamp;
    if (entry.type === "session_info") {
      if (typeof entry.name === "string" && entry.name.trim()) title = entry.name.trim();
      continue;
    }
    if (entry.type === "model_change") {
      if (typeof entry.modelId === "string" && entry.modelId) lastModelChange = entry.modelId;
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      if (summary) {
        absorb({ kind: "reasoning", text: summary, ...(entry.timestamp ? { timestamp: entry.timestamp } : {}) });
      }
      continue;
    }
    if (entry.type === "bashExecution") {
      if (entry.excludeFromContext === true) continue;
      if (typeof entry.command === "string" && entry.command) {
        absorb({
          kind: "command",
          command: entry.command,
          ...(typeof entry.output === "string" && entry.output ? { output: entry.output } : {}),
          ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
        });
      }
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue; // thinking_level_change / label / custom

    const message = entry.message;
    const ts = entry.timestamp;
    if (message.role === "user") {
      const text = userTextOf(message.content);
      if (!text) continue;
      turnCount += 1;
      hasConversation = true;
      if (!firstUser) firstUser = text;
      turn = { userText: text, items: [] };
      turns.push(turn);
      absorb({ kind: "user-message", text, ...(ts ? { timestamp: ts } : {}) });
      continue;
    }
    if (message.role === "toolResult") {
      // Results arrive as their own entries; complete the call they
      // belong to. bash gets output, everything else result/isError.
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const target = callId ? pending.get(callId) : undefined;
      const text = resultTextOf(message.content);
      if (target?.fileTool) continue; // the file-change was already emitted at call time
      if (target?.item && target.item.kind === "command") {
        if (callId) pending.delete(callId);
        if (text) target.item.output = text;
        continue;
      }
      if (target?.item && target.item.kind === "tool-call") {
        if (callId) pending.delete(callId);
        target.item.result = text || undefined;
        target.item.isError = message.isError === true;
        continue;
      }
      // A result whose call is not in the branch: still surface it.
      if (text) absorb({ kind: "tool-call", tool: "tool", result: text, isError: message.isError === true, ...(ts ? { timestamp: ts } : {}) });
      continue;
    }
    if (message.role !== "assistant") continue;

    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "text") {
        const text = typeof block.text === "string" ? block.text.trim() : "";
        if (!text) continue;
        hasConversation = true;
        absorb({ kind: "agent-message", text, ...(ts ? { timestamp: ts } : {}) });
      } else if (block?.type === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
        if (!text) continue;
        absorb({ kind: "reasoning", text, ...(ts ? { timestamp: ts } : {}) });
      } else if (block?.type === "toolCall") {
        const callId = typeof block.id === "string" ? block.id : undefined;
        const name = typeof block.name === "string" && block.name ? block.name : "tool";
        const input = (block.arguments && typeof block.arguments === "object" ? block.arguments : {}) as Record<string, unknown>;
        if (name === "bash") {
          const item: HarnessThreadItem = { kind: "command", command: String(input.command ?? "(bash)"), ...(ts ? { timestamp: ts } : {}) };
          absorb(item);
          if (callId) pending.set(callId, { item: item as Extract<HarnessThreadItem, { kind: "command" }> });
        } else if (FILE_EDIT_TOOLS.has(name) || FILE_WRITE_TOOLS.has(name)) {
          const item: HarnessThreadItem = {
            kind: "file-change",
            path: String(input.file_path ?? input.path ?? "(file)"),
            action: FILE_WRITE_TOOLS.has(name) ? "add" : "update",
            ...(ts ? { timestamp: ts } : {}),
          };
          absorb(item);
          if (callId) pending.set(callId, { fileTool: true });
        } else {
          const item: HarnessThreadItem = { kind: "tool-call", tool: name, arguments: input, ...(ts ? { timestamp: ts } : {}) };
          absorb(item);
          if (callId) pending.set(callId, { item: item as Extract<HarnessThreadItem, { kind: "tool-call" }> });
        }
      }
    }
    if (!firstAssistantModel && typeof message.model === "string" && message.model) firstAssistantModel = message.model;
  }

  const updatedAt = lastTimestamp ?? new Date(mtimeMs).toISOString();
  return {
    hasConversation,
    items,
    turns: turns.filter((t) => t.userText !== undefined || t.items.length > 0),
    summary: {
      id: typeof header.id === "string" && header.id ? header.id : basenameStem(file),
      title: title ?? (firstUser ? firstUser.slice(0, 80) : undefined),
      preview: firstUser?.slice(0, 400),
      cwd: typeof header.cwd === "string" && header.cwd ? header.cwd : undefined,
      createdAt: typeof header.timestamp === "string" ? header.timestamp : undefined,
      updatedAt,
      turnCount: turnCount > 0 ? turnCount : undefined,
      model: lastModelChange ?? firstAssistantModel,
    },
  };
}

/** string content passes through; block arrays join their text blocks. */
function userTextOf(content: string | PiContentBlock[] | undefined): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("")
    .trim();
  return text || undefined;
}

/** toolResult content → text: text blocks joined; anything else JSON. */
function resultTextOf(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}

function basenameStem(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.jsonl$/i, "");
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

function transcriptFiles(dir: string): Array<{ file: string; mtimeMs: number }> {
  const out: Array<{ file: string; mtimeMs: number }> = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...transcriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        out.push({ file: path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        /* file vanished between readdir and stat */
      }
    }
  }
  return out;
}

/**
 * A workspace cwd must be matched in its literal and symlink-resolved
 * forms (macOS /tmp → /private/tmp); pi records the literal cwd in the
 * session header.
 */
function cwdCandidates(cwd: string): string[] {
  const out = new Set<string>([cwd]);
  try {
    out.add(resolve(cwd));
  } catch {
    /* keep the literal form */
  }
  try {
    out.add(realpathSync(cwd));
  } catch {
    /* path may not exist anymore */
  }
  return [...out];
}

/**
 * Lists local Pi sessions, newest first, optionally narrowed to a working
 * directory. Sessions with no readable conversation (header only, aborted
 * before the first turn) are skipped.
 */
export async function listPiSessions(
  filter: HarnessThreadFilter = {},
  opts: { sessionsDir?: string } = {}
): Promise<HarnessThreadSummary[]> {
  const root = opts.sessionsDir ?? piSessionsRoot();
  if (!existsSync(root)) return [];
  const candidates: Array<{ summary: HarnessThreadSummary; mtimeMs: number }> = [];
  for (const { file, mtimeMs } of transcriptFiles(root)) {
    const parse = parseTranscript(file, mtimeMs);
    if (!parse || !parse.hasConversation) continue;
    if (filter.cwd && parse.summary.cwd && !cwdCandidates(filter.cwd).includes(parse.summary.cwd)) continue;
    if (filter.cwd && !parse.summary.cwd) continue;
    candidates.push({ summary: parse.summary, mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = filter.limit && filter.limit > 0 ? candidates.slice(0, filter.limit) : candidates;
  return limited.map((c) => c.summary);
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** Reads an existing Pi session without executing the model. */
export async function readPiSession(
  sessionId: string,
  opts: { sessionsDir?: string } = {}
): Promise<HarnessThreadDetail> {
  const root = opts.sessionsDir ?? piSessionsRoot();
  for (const { file, mtimeMs } of transcriptFiles(root)) {
    const parse = parseTranscript(file, mtimeMs);
    if (parse && parse.summary.id === sessionId) {
      return { ...parse.summary, items: parse.items, turns: parse.turns };
    }
  }
  throw new Error(`Pi session not found: ${sessionId}`);
}

/** Pi implementation of the local harness thread source port. */
export const piThreadSource: LocalHarnessThreadSource = {
  kind: "pi",
  listThreads: (filter) => listPiSessions(filter),
  readThread: (threadId) => readPiSession(threadId),
};
