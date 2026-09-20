import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  HarnessThreadDetail,
  HarnessThreadFilter,
  HarnessThreadItem,
  HarnessThreadSummary,
  HarnessThreadTurn,
  LocalHarnessThreadSource,
} from "@agentfabric/core";
import { isTempDirPath } from "./tempDirs.js";

/**
 * ZCode local session discovery.
 *
 * ZCode has no CLI that lists past sessions; discovery reads the session
 * store it persists under `~/.zcode/cli/db/db.sqlite` (overridable via
 * AGENTFABRIC_ZCODE_DB_DIR for tests) — the same store ZCode's own
 * history UI reads. The database is opened read-only and only the three
 * conversation tables are touched (`session` / `message` / `part`, each
 * message and part carrying its content as JSON in `data`); credential
 * material never appears there. Everything store-specific lives in this
 * module (the adapter layer, never AgentFabric core).
 *
 * Only main sessions are listed (parent_id null/'' — branched children are
 * internal bookkeeping). Messages and parts have a per-store `sequence`
 * column; it is monotonic within a session, so it is the ordering key.
 */

/** Store directory override for tests; contains db.sqlite. */
export function zcodeDbDir(): string {
  return process.env.AGENTFABRIC_ZCODE_DB_DIR ?? join(homedir(), ".zcode", "cli", "db");
}

/** Hard cap so a pathological session can never wedge discovery. */
const MAX_SESSION_MESSAGES = 20_000;

const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const FILE_WRITE_TOOLS = new Set(["Write"]);

/* ------------------------------------------------------------------ */
/* Store rows                                                          */
/* ------------------------------------------------------------------ */

interface SessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
}

interface ZcodeMessageData {
  role?: string;
  modelId?: string;
  [key: string]: unknown;
}

interface ZcodePartData {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: unknown };
  summary?: { body?: string };
  [key: string]: unknown;
}

function msToIso(ms: number | null | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Tool output arrives as arbitrary JSON; text passes through as-is. */
function outputText(output: unknown): string | undefined {
  if (output == null) return undefined;
  return typeof output === "string" ? output : JSON.stringify(output);
}

interface SessionParse {
  summary: HarnessThreadSummary;
  /** Whether the session carries any readable conversation at all. */
  hasConversation: boolean;
  items: HarnessThreadItem[];
  turns: HarnessThreadTurn[];
}

function openDb(dir: string): DatabaseSync {
  return new DatabaseSync(join(dir, "db.sqlite"), { readOnly: true });
}

function mainSessionRows(db: DatabaseSync): SessionRow[] {
  return db
    .prepare("SELECT id, title, directory, time_created, time_updated FROM session WHERE parent_id IS NULL OR parent_id = '' ORDER BY time_updated DESC")
    .all() as unknown as SessionRow[];
}

/**
 * Parses one session into summary + history. User messages start turns;
 * assistant parts become the unified items. Structural parts
 * (step-start/step-finish/timeline) and file attachments are not
 * conversation content; a compaction part's summary body is kept as a
 * reasoning item — it is the record of the context the model still sees.
 */
function parseSession(row: SessionRow, db: DatabaseSync): SessionParse {
  const items: HarnessThreadItem[] = [];
  const turns: HarnessThreadTurn[] = [];
  let turn: HarnessThreadTurn = { items: [] };
  turns.push(turn);
  let firstUser: string | undefined;
  let model: string | undefined;
  let turnCount = 0;
  let hasConversation = false;

  const messages = db
    .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY sequence, time_created LIMIT ?")
    .all(row.id, MAX_SESSION_MESSAGES) as unknown as Array<{ id: string; data: string; time_created: number | null }>;

  for (const message of messages) {
    let data: ZcodeMessageData;
    try {
      data = JSON.parse(message.data) as ZcodeMessageData;
    } catch {
      continue;
    }
    const ts = msToIso(message.time_created);
    const parts = db
      .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY sequence, time_created")
      .all(message.id) as unknown as Array<{ data: string }>;

    if (data.role === "user") {
      const text = textOfParts(parts);
      if (!text) continue;
      turnCount += 1;
      hasConversation = true;
      if (!firstUser) firstUser = text;
      turn = { userText: text, items: [] };
      turns.push(turn);
      const item: HarnessThreadItem = { kind: "user-message", text, ...(ts ? { timestamp: ts } : {}) };
      items.push(item);
      turn.items.push(item);
      continue;
    }
    if (data.role !== "assistant") continue; // system rows are prompt plumbing
    if (!model && typeof data.modelId === "string" && data.modelId) model = data.modelId;

    for (const part of parts) {
      let data2: ZcodePartData;
      try {
        data2 = JSON.parse(part.data) as ZcodePartData;
      } catch {
        continue;
      }
      const item = partToItem(data2, ts);
      if (!item) continue;
      if (item.kind === "agent-message") hasConversation = true;
      items.push(item);
      turn.items.push(item);
    }
  }

  return {
    hasConversation,
    items,
    turns: turns.filter((t) => t.userText !== undefined || t.items.length > 0),
    summary: {
      id: row.id,
      title: row.title?.trim() || (firstUser ? firstUser.slice(0, 80) : undefined),
      preview: firstUser?.slice(0, 400),
      cwd: row.directory ?? undefined,
      createdAt: msToIso(row.time_created),
      updatedAt: msToIso(row.time_updated),
      turnCount: turnCount > 0 ? turnCount : undefined,
      model,
    },
  };
}

function textOfParts(parts: Array<{ data: string }>): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    try {
      const data = JSON.parse(part.data) as ZcodePartData;
      if (data.type === "text" && typeof data.text === "string" && data.text.trim()) texts.push(data.text.trim());
    } catch {
      /* tolerate corrupt part rows */
    }
  }
  const text = texts.join("\n").trim();
  return text || undefined;
}

function partToItem(part: ZcodePartData, ts: string | undefined): HarnessThreadItem | undefined {
  if (part.type === "text") {
    const text = typeof part.text === "string" ? part.text.trim() : "";
    return text ? { kind: "agent-message", text, ...(ts ? { timestamp: ts } : {}) } : undefined;
  }
  if (part.type === "reasoning") {
    const text = typeof part.text === "string" ? part.text.trim() : "";
    return text ? { kind: "reasoning", text, ...(ts ? { timestamp: ts } : {}) } : undefined;
  }
  if (part.type === "compaction") {
    const body = typeof part.summary?.body === "string" ? part.summary.body.trim() : "";
    return body ? { kind: "reasoning", text: body, ...(ts ? { timestamp: ts } : {}) } : undefined;
  }
  if (part.type === "tool") {
    const name = typeof part.tool === "string" && part.tool ? part.tool : "tool";
    const input = part.state?.input ?? {};
    const output = outputText(part.state?.output);
    if (name === "Bash") {
      return {
        kind: "command",
        command: String(input.command ?? "(bash)"),
        ...(output !== undefined ? { output } : {}),
        ...(ts ? { timestamp: ts } : {}),
      };
    }
    if (FILE_EDIT_TOOLS.has(name) || FILE_WRITE_TOOLS.has(name)) {
      return {
        kind: "file-change",
        path: String(input.file_path ?? input.path ?? "(file)"),
        action: FILE_WRITE_TOOLS.has(name) ? "add" : "update",
        ...(ts ? { timestamp: ts } : {}),
      };
    }
    return {
      kind: "tool-call",
      tool: name,
      arguments: input,
      ...(output !== undefined ? { result: output } : {}),
      isError: part.state?.status === "error" ? true : undefined,
      ...(ts ? { timestamp: ts } : {}),
    };
  }
  // file (attachments), step-start/step-finish/timeline (structure),
  // anything unknown: not conversation content.
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Port implementation                                                 */
/* ------------------------------------------------------------------ */

function withDb<T>(dir: string, fn: (db: DatabaseSync) => T): T {
  const dbPath = join(dir, "db.sqlite");
  if (!existsSync(dbPath)) {
    throw new Error(`ZCode session store not found: ${dbPath}`);
  }
  const db = openDb(dir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Lists local ZCode sessions, newest first, optionally narrowed to a
 * working directory. Sessions are parsed in `time_updated` order and the
 * walk stops at `filter.limit`, so a bounded request never parses the
 * whole store. Sessions with no readable conversation are skipped.
 */
export async function listZcodeSessions(
  filter: HarnessThreadFilter = {},
  opts: { dbDir?: string } = {}
): Promise<HarnessThreadSummary[]> {
  const dir = opts.dbDir ?? zcodeDbDir();
  if (!existsSync(join(dir, "db.sqlite"))) return [];
  return withDb(dir, (db) => {
    const out: HarnessThreadSummary[] = [];
    for (const row of mainSessionRows(db)) {
      if (filter.cwd && row.directory !== filter.cwd) continue;
      const parse = parseSession(row, db);
      if (!parse.hasConversation) continue;
      // Temp-directory constraint: probe/CI/fixture sessions are not the
      // user's work (see tempDirs.ts).
      if (parse.summary.cwd && isTempDirPath(parse.summary.cwd)) continue;
      out.push(parse.summary);
      if (filter.limit && filter.limit > 0 && out.length >= filter.limit) break;
    }
    return out;
  });
}

/** Reads an existing ZCode session without executing the model. */
export async function readZcodeSession(
  sessionId: string,
  opts: { dbDir?: string } = {}
): Promise<HarnessThreadDetail> {
  const dir = opts.dbDir ?? zcodeDbDir();
  return withDb(dir, (db) => {
    const row = (
      db.prepare("SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ? AND (parent_id IS NULL OR parent_id = '')").all(sessionId) as unknown as SessionRow[]
    )[0];
    if (!row) throw new Error(`ZCode session not found: ${sessionId}`);
    const parse = parseSession(row, db);
    return { ...parse.summary, items: parse.items, turns: parse.turns };
  });
}

/** ZCode implementation of the local harness thread source port. */
export const zcodeThreadSource: LocalHarnessThreadSource = {
  kind: "zcode",
  listThreads: (filter) => listZcodeSessions(filter),
  readThread: (threadId) => readZcodeSession(threadId),
};
