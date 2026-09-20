import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { decompress as zstdDecompress } from "fzstd";
import type {
  HarnessThreadDetail,
  HarnessThreadFilter,
  HarnessThreadItem,
  HarnessThreadSummary,
  HarnessThreadTurn,
  LocalHarnessThreadSource,
} from "@agentfabric/core";

/**
 * DSH (DeepSeek Harness) local session discovery.
 *
 * DSH exposes no CLI that lists past sessions; discovery reads the session
 * logs it persists under `$DSH_HOME/sessions` (default `~/.dsh/sessions`,
 * overridable via AGENTFABRIC_DSH_SESSIONS_DIR for tests) — the same logs
 * DSH's own resume reads. A log lives at
 * `<encoded-cwd>/<session-id>/session[.vN].jsonl[.zstd]` and is an event
 * stream: a `session` header record (id/cwd/createdAt — also the format
 * signature), then durable conversation events (`turn/start`,
 * `user/message`, `assistant/message`, `tool/call`, `tool/result`,
 * `session/title`, compaction summaries). Streaming chunk events and
 * runtime state (sandbox, approvals, retries) are not conversation
 * content. Credential material never appears in the log. Everything
 * DSH-specific lives in this module (the adapter layer, never AgentFabric
 * core).
 *
 * The `.zstd` log is frame-per-append: DSH flushes one zstd frame per
 * event batch, so a session file holds thousands of concatenated frames.
 * Node's zlib cannot walk them, and decompressing a whole log just to
 * list its title is seconds of pure-JS decompression per session — so
 * frames are split by their headers (zstd format spec §3.1) and
 * decompressed one by one. Listing stops after the header/title/
 * first-turn prefix; reading decompresses everything. Delegated subagent
 * sessions (`delegationDepth > 0`) are not part of the thread list.
 */

/** Session root override for tests; defaults to DSH's own store. */
export function dshSessionsRoot(): string {
  if (process.env.AGENTFABRIC_DSH_SESSIONS_DIR) return process.env.AGENTFABRIC_DSH_SESSIONS_DIR;
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
}

/** Session artifact naming across format generations (matches DSH's own). */
const SESSION_LOG = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/i;

/** Hard caps so a pathological log can never wedge discovery. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_LOG_FRAMES = 100_000;
const MAX_LOG_LINES = 200_000;
/** Listing needs no more log than the first turn's title + prompt; if no
 * title has shown up by then, stop anyway instead of decompressing all. */
const LIST_MAX_FRAMES = 500;

const FILE_EDIT_TOOLS = new Set(["edit", "multiedit", "notebookedit"]);
const FILE_WRITE_TOOLS = new Set(["write"]);

/* ------------------------------------------------------------------ */
/* Event log shapes                                                    */
/* ------------------------------------------------------------------ */

interface DshEvent {
  type?: string;
  seq?: number;
  time?: number;
  /** Session header fields live on the record root, not under data. */
  id?: unknown;
  version?: unknown;
  createdAt?: unknown;
  cwd?: unknown;
  delegationDepth?: unknown;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

interface DshContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface DshToolResultBlock extends DshContentBlock {
  toolCallId?: string;
  content?: DshContentBlock[];
  isError?: boolean;
}

function msToIso(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b): b is DshContentBlock => !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("")
    .trim();
}

/** tool/call arguments arrive as a JSON string; keep the object form. */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // not JSON: surface the string rather than dropping it
  }
}

interface SessionParse {
  summary: HarnessThreadSummary;
  /** Delegated subagent session — has a place in no user's thread list. */
  delegated: boolean;
  hasConversation: boolean;
  items: HarnessThreadItem[];
  turns: HarnessThreadTurn[];
}

/* ------------------------------------------------------------------ */
/* Frame-splitting decompression                                       */
/* ------------------------------------------------------------------ */

/**
 * Walks the concatenated zstd frames of a session log and returns the
 * decompressed text. Frame headers are parsed per the zstd format spec
 * (magic → header descriptor → window/dictionary/size fields → block
 * headers → checksum) so each frame can be handed to the pure-JS
 * decompressor on its own; `stop` ends the walk early once enough text
 * has accumulated (listing). A frame boundary that does not hold throws —
 * a truncated or corrupt log is surfaced, never silently truncated.
 */
function zstdLogText(buf: Buffer, stop?: (text: string, frames: number) => boolean): string {
  const chunks: Buffer[] = [];
  let decoded = ""; // progressive view for stop predicates only (ASCII markers)
  let off = 0;
  let frames = 0;
  while (off < buf.length) {
    if (frames >= MAX_LOG_FRAMES) {
      throw new Error(`DSH session log exceeds ${MAX_LOG_FRAMES} zstd frames`);
    }
    const magic = buf.readUInt32LE(off);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      // Skippable frame: 4-byte magic, 4-byte payload size, payload.
      if (off + 8 > buf.length) throw new Error("DSH session log has a truncated skippable frame");
      off += 8 + buf.readUInt32LE(off + 4);
      continue;
    }
    if (magic !== 0xfd2fb528) {
      throw new Error(`DSH session log is not a valid zstd stream (bad magic at byte ${off})`);
    }
    const start = off;
    off += 4;
    const descriptor = buf[off++];
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksum = (descriptor >> 2) & 1;
    const dictionaryFlag = descriptor & 3;
    if (!singleSegment) off += 1; // Window_Descriptor
    off += [0, 1, 2, 4][dictionaryFlag];
    off += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
    for (;;) {
      if (off + 3 > buf.length) throw new Error("DSH session log ends inside a zstd block");
      const header = buf.readUIntLE(off, 3);
      // RLE blocks carry their content as a single byte regardless of size.
      off += 3 + (((header >> 1) & 3) === 1 ? 1 : header >> 3);
      if (header & 1) break;
    }
    if (checksum) off += 4;
    const chunk = Buffer.from(zstdDecompress(buf.subarray(start, off)));
    chunks.push(chunk);
    decoded += chunk.toString("utf8");
    frames++;
    if (stop?.(decoded, frames)) break;
  }
  // Decode once from the joined chunks so multi-byte characters split
  // across frame boundaries survive.
  return Buffer.concat(chunks).toString("utf8");
}

function readLogText(file: string, stop?: (text: string, frames: number) => boolean): string {
  if (statSync(file).size > MAX_LOG_BYTES) {
    throw new Error(`DSH session log exceeds ${MAX_LOG_BYTES} bytes: ${file}`);
  }
  const buf = readFileSync(file);
  if (/\.zstd$/i.test(file)) return zstdLogText(buf, stop);
  return buf.toString("utf8");
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parses one session log into summary + history. `turn/start` opens a
 * turn; its first `user/message` is the prompt (further ones in the same
 * turn — injected inbox messages — become additional user-message items).
 * Tool identity comes from the `tool/call` event (the assistant message's
 * inline tool-call block is the same call, earlier); `tool/result`
 * completes the call it names. Compaction summaries are kept as reasoning
 * items — they are the record of the context the model still sees.
 * `partial` marks a listing parse: the log was decompressed only up to
 * its first turn, so a turn count from it would be wrong — the field is
 * left to the full read. Returns null for a file without the session
 * header (not a DSH log).
 */
function parseSessionLog(
  file: string,
  dirName: string,
  mtimeMs: number,
  text: string,
  opts: { partial?: boolean } = {}
): SessionParse | null {
  const recs: DshEvent[] = [];
  let lines = 0;
  for (const piece of text.split("\n")) {
    if (!piece.trim()) continue;
    if (++lines > MAX_LOG_LINES) break;
    try {
      recs.push(JSON.parse(piece) as DshEvent);
    } catch {
      /* tolerate a partial trailing write */
    }
  }

  // Format signature: the session header. Logs without it are not DSH
  // sessions and are skipped, not misread.
  const header = recs.find((r) => r?.type === "session" && typeof r.id === "string" && typeof r.version === "number");
  if (!header) return null;

  const items: HarnessThreadItem[] = [];
  const turns: HarnessThreadTurn[] = [];
  let turn: HarnessThreadTurn = { items: [] };
  turns.push(turn);
  let title: string | undefined;
  let firstUser: string | undefined;
  let model: string | undefined;
  let lastTime: number | undefined;
  let turnCount = 0;
  let hasConversation = false;
  // turn/start numbering, so a retried turn re-opening the same number
  // does not fork an extra empty turn.
  let turnNumber: number | undefined;
  // tool/call id → the pending item its tool/result completes.
  const pending = new Map<
    string,
    { item?: Extract<HarnessThreadItem, { kind: "tool-call" | "command" }>; fileTool?: boolean }
  >();

  const absorb = (item: HarnessThreadItem, at?: string): void => {
    items.push(item);
    turn.items.push(item);
    if (at) item.timestamp = at;
  };
  const at = (ev: DshEvent): string | undefined => {
    if (typeof ev.time === "number" && Number.isFinite(ev.time)) lastTime = ev.time;
    return msToIso(ev.time);
  };

  for (const ev of recs) {
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue;
    const data = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
    switch (ev.type) {
      case "session/title": {
        if (typeof data.title === "string" && data.title.trim()) title = data.title.trim();
        break;
      }
      case "model/selection": {
        if (typeof data.model === "string" && data.model) model = data.model;
        break;
      }
      case "turn/start": {
        const next = typeof data.turn === "number" ? data.turn : undefined;
        if (next === undefined || next !== turnNumber) {
          turn = { items: [] };
          turns.push(turn);
          turnNumber = next;
          turnCount += 1; // the harness's own turn numbering
        }
        break;
      }
      case "user/message": {
        const text2 = textOfBlocks(data.content);
        if (!text2) break;
        hasConversation = true;
        if (!firstUser) firstUser = text2;
        if (turn.userText === undefined) turn.userText = text2;
        absorb({ kind: "user-message", text: text2 }, at(ev));
        break;
      }
      case "assistant/message": {
        const message = (data.message && typeof data.message === "object" ? data.message : {}) as {
          content?: unknown;
          source?: { model?: unknown };
        };
        if (!model && message.source && typeof message.source.model === "string") model = message.source.model;
        if (!Array.isArray(message.content)) break;
        const at2 = at(ev);
        for (const block of message.content) {
          if (!block || typeof block !== "object") continue;
          const type = (block as DshContentBlock).type;
          const body = typeof (block as DshContentBlock).text === "string" ? String((block as DshContentBlock).text).trim() : "";
          if (type === "text" && body) {
            hasConversation = true;
            absorb({ kind: "agent-message", text: body }, at2);
          } else if (type === "reasoning" && body) {
            absorb({ kind: "reasoning", text: body }, at2);
          }
          // tool-call blocks are the call announcement; the tool/call event
          // carries the same identity and is what gets projected.
        }
        break;
      }
      case "tool/call": {
        const callId = typeof data.callId === "string" ? data.callId : undefined;
        const name = typeof data.name === "string" && data.name ? data.name : "tool";
        const args = parseArguments(data.arguments);
        const at2 = at(ev);
        if (name === "bash") {
          const command =
            (args && typeof args === "object" ? String((args as Record<string, unknown>).command ?? "") : "") || "(bash)";
          const item: Extract<HarnessThreadItem, { kind: "command" }> = { kind: "command", command };
          absorb(item, at2);
          if (callId) pending.set(callId, { item });
        } else if (FILE_EDIT_TOOLS.has(name) || FILE_WRITE_TOOLS.has(name)) {
          const path =
            (args && typeof args === "object"
              ? String((args as Record<string, unknown>).file_path ?? (args as Record<string, unknown>).path ?? "")
              : "") || "(file)";
          absorb(
            {
              kind: "file-change",
              path,
              action: FILE_WRITE_TOOLS.has(name) ? "add" : "update",
            },
            at2
          );
          if (callId) pending.set(callId, { fileTool: true });
        } else {
          const item: Extract<HarnessThreadItem, { kind: "tool-call" }> = { kind: "tool-call", tool: name, arguments: args };
          absorb(item, at2);
          if (callId) pending.set(callId, { item });
        }
        break;
      }
      case "tool/result": {
        const message = (data.message && typeof data.message === "object" ? data.message : {}) as {
          source?: { callId?: unknown };
          content?: unknown;
        };
        const callId = typeof message.source?.callId === "string" ? message.source.callId : undefined;
        const block = (Array.isArray(message.content) ? message.content : [])[0] as DshToolResultBlock | undefined;
        const callId2 = callId ?? (block && typeof block.toolCallId === "string" ? block.toolCallId : undefined);
        const output = textOfBlocks(block?.content);
        const target = callId2 ? pending.get(callId2) : undefined;
        if (target?.fileTool) break; // the file-change was already emitted at call time
        if (target?.item?.kind === "command") {
          if (callId2) pending.delete(callId2);
          if (output) target.item.output = output;
          break;
        }
        if (target?.item?.kind === "tool-call") {
          if (callId2) pending.delete(callId2);
          target.item.result = output || undefined;
          target.item.isError = block?.isError === true;
          break;
        }
        // A result whose call is not in the log: still surface it.
        absorb({ kind: "tool-call", tool: "tool", result: output, isError: block?.isError === true }, at(ev));
        break;
      }
      case "compaction/summary": {
        const text3 = textOfBlocks(data.summary);
        if (text3) absorb({ kind: "reasoning", text: text3 }, at(ev));
        break;
      }
      default:
        break; // streaming chunks, sandbox/approval/retry state, step bookkeeping
    }
  }

  return {
    hasConversation,
    delegated: typeof header.delegationDepth === "number" && header.delegationDepth > 0,
    items,
    turns: turns.filter((t) => t.userText !== undefined || t.items.length > 0),
    summary: {
      id: typeof header.id === "string" ? header.id : dirName,
      title: title ?? (firstUser ? firstUser.slice(0, 80) : undefined),
      preview: firstUser?.slice(0, 400),
      cwd: typeof header.cwd === "string" && header.cwd ? header.cwd : undefined,
      createdAt: msToIso(header.createdAt),
      updatedAt: msToIso(lastTime) ?? new Date(mtimeMs).toISOString(),
      turnCount: !opts.partial && turnCount > 0 ? turnCount : undefined,
      model,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

function sessionLogFiles(dir: string): Array<{ file: string; dirName: string; mtimeMs: number }> {
  const out: Array<{ file: string; dirName: string; mtimeMs: number }> = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // import-<id> holds previously imported external threads; re-listing
      // them would surface the same conversation twice.
      if (entry.name.startsWith("import-")) continue;
      out.push(...sessionLogFiles(path));
    } else if (entry.isFile() && SESSION_LOG.test(entry.name)) {
      try {
        out.push({ file: path, dirName: basename(dir), mtimeMs: statSync(path).mtimeMs });
      } catch {
        /* file vanished between readdir and stat */
      }
    }
  }
  return out;
}

/**
 * A workspace cwd must be matched in its literal and symlink-resolved
 * forms (macOS /tmp → /private/tmp); DSH records the literal cwd in the
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

/** Listing needs no more log than the first turn's title + prompt. */
function listStop(text: string, frames: number): boolean {
  return frames >= LIST_MAX_FRAMES || (text.includes('"type":"session/title"') && text.includes('"type":"user/message"'));
}

/**
 * Lists local DSH sessions, newest first, optionally narrowed to a working
 * directory. Files are parsed newest-first and the walk stops at
 * `filter.limit`; each log is decompressed only up to its header/title/
 * first-turn prefix. Sessions with no readable conversation (header only,
 * aborted before the first turn) and delegated subagent sessions are
 * skipped. A log that cannot be decompressed is skipped here — listing
 * must not die on one broken file; reading that log directly fails
 * loudly instead.
 */
export async function listDshSessions(
  filter: HarnessThreadFilter = {},
  opts: { sessionsDir?: string } = {}
): Promise<HarnessThreadSummary[]> {
  const root = opts.sessionsDir ?? dshSessionsRoot();
  if (!existsSync(root)) return [];
  const files = sessionLogFiles(root).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: HarnessThreadSummary[] = [];
  for (const { file, dirName, mtimeMs } of files) {
    if (filter.limit && filter.limit > 0 && out.length >= filter.limit) break;
    let parse: SessionParse | null;
    try {
      parse = parseSessionLog(file, dirName, mtimeMs, readLogText(file, listStop), { partial: true });
    } catch {
      continue; // one broken log must not hide every other session
    }
    if (!parse || parse.delegated || !parse.hasConversation) continue;
    if (filter.cwd && parse.summary.cwd && !cwdCandidates(filter.cwd).includes(parse.summary.cwd)) continue;
    if (filter.cwd && !parse.summary.cwd) continue;
    out.push(parse.summary);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads an existing DSH session without executing the model. The session
 * id names its own directory in DSH's layout, so only that log is
 * decompressed instead of every sibling; the full walk is the fallback
 * for layouts where they diverge. Unlike listing, this fails loudly on a
 * log that cannot be decompressed.
 */
export async function readDshSession(
  sessionId: string,
  opts: { sessionsDir?: string } = {}
): Promise<HarnessThreadDetail> {
  const root = opts.sessionsDir ?? dshSessionsRoot();
  const files = sessionLogFiles(root);
  const direct = files.filter((f) => f.dirName === sessionId);
  for (const { file, dirName, mtimeMs } of direct.length > 0 ? direct : files) {
    const parse = parseSessionLog(file, dirName, mtimeMs, readLogText(file));
    if (parse && parse.summary.id === sessionId) {
      return { ...parse.summary, items: parse.items, turns: parse.turns };
    }
  }
  throw new Error(`DSH session not found: ${sessionId}`);
}

/** DSH implementation of the local harness thread source port. */
export const dshThreadSource: LocalHarnessThreadSource = {
  kind: "dsh",
  listThreads: (filter) => listDshSessions(filter),
  readThread: (threadId) => readDshSession(threadId),
};
