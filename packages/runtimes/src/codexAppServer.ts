import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import type {
  HarnessThreadDetail,
  HarnessThreadFilter,
  HarnessThreadItem,
  HarnessThreadSummary,
  LocalHarnessThreadSource,
} from "@agentfabric/core";
import { codexBin } from "./codex.js";
import { isTempDirPath } from "./tempDirs.js";

/**
 * Codex app-server client (v6 §6/§7).
 *
 * Codex's supported surface for discovering and reading existing threads
 * is the local app-server (`codex app-server`): a JSON-RPC 2.0 server
 * over stdio. This client speaks just enough of that protocol:
 *
 * - `initialize` handshake,
 * - `thread/list` (sortKey updated_at, optional exact-cwd filter),
 * - `thread/turns/list` (paginated, chronological) with a fallback to
 *   `thread/read` + includeTurns on older servers.
 *
 * AgentFabric deliberately does NOT parse `~/.codex` session files (v6
 * §6/§12) — everything here flows through Codex's own interfaces, and
 * the process is short-lived: connect, read, exit.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function rpcError(resp: JsonRpcResponse): string {
  return resp.error?.message ?? `JSON-RPC error ${resp.error?.code ?? "(unknown)"}`;
}

/** Drives one short-lived `codex app-server` child process. */
class CodexAppServerSession {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (err) => this.failAll(err));
    this.child.on("close", () => this.failAll(new Error("codex app-server exited unexpectedly")));
  }

  static async start(bin: string): Promise<CodexAppServerSession> {
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    const session = new CodexAppServerSession(child);
    try {
      await session.rpc(
        "initialize",
        { clientInfo: { name: "agent-fabric", title: "AgentFabric", version: "0.1.0" } },
        10_000
      );
    } catch (err) {
      session.close();
      throw err instanceof Error ? err : new Error(String(err));
    }
    return session;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // non-JSON noise on stdout
      }
      if (msg.id !== undefined && typeof msg.id === "number" && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        entry.resolve(msg);
      }
      // Notifications (no id) are ignored — we only issue reads.
    }
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("codex app-server session is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          if (resp.error) reject(new Error(rpcError(resp)));
          else resolve(resp.result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.closed = true;
    for (const [, entry] of this.pending) entry.reject(new Error("codex app-server session closed"));
    this.pending.clear();
    this.child.kill();
  }
}

/* ------------------------------------------------------------------ */
/* Wire shapes                                                         */
/* ------------------------------------------------------------------ */

interface WireThread {
  id?: string;
  sessionId?: string;
  name?: string | null;
  preview?: string | null;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  model?: string | null;
  source?: string | null;
  archived?: boolean;
  turns?: WireTurn[];
  [key: string]: unknown;
}

interface WireTurn {
  id?: string;
  items?: WireItem[];
  [key: string]: unknown;
}

interface WireItem {
  type?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string | null;
  query?: string;
  message?: string;
  items?: unknown[];
  [key: string]: unknown;
}

function isoFromEpoch(seconds?: number): string | undefined {
  return typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

function clip(text: string | null | undefined, max = 200): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * Codex records thread cwds as real paths (symlinks resolved — e.g.
 * /private/tmp on macOS where the user passed /tmp). A workspace cwd must
 * therefore be matched in its resolved form too.
 */
function cwdCandidates(cwd: string): string[] {
  const out = new Set<string>([cwd]);
  try {
    out.add(realpathSync(cwd));
  } catch {
    /* path may not exist anymore — match the literal form only */
  }
  return [...out];
}

function summaryFromWire(t: WireThread): HarnessThreadSummary {
  return {
    id: t.id ?? t.sessionId ?? "",
    title: clip(t.name ?? undefined) ?? clip(t.preview ?? undefined, 120),
    preview: clip(t.preview ?? undefined, 400),
    cwd: typeof t.cwd === "string" && t.cwd ? t.cwd : undefined,
    createdAt: isoFromEpoch(t.createdAt),
    updatedAt: isoFromEpoch(t.updatedAt),
    model: typeof t.model === "string" && t.model ? t.model : undefined,
    source: typeof t.source === "string" && t.source ? t.source : undefined,
  };
}

/** Maps one app-server thread item to the flattened port item (v6 §7). */
function itemFromWire(item: WireItem): HarnessThreadItem | null {
  switch (item.type) {
    case "userMessage":
    case "user_message": {
      const text = (item.content ?? [])
        .filter((p) => (p.type ?? "text") === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");
      if (!text.trim()) return null;
      return { kind: "user-message", text };
    }
    case "agentMessage":
    case "agent_message": {
      const text =
        typeof item.text === "string"
          ? item.text
          : (item.content ?? [])
              .filter((p) => (p.type ?? "text") === "text" && typeof p.text === "string")
              .map((p) => p.text as string)
              .join("");
      if (!text.trim()) return null;
      return { kind: "agent-message", text };
    }
    case "reasoning":
    case "agent_reasoning":
      if (typeof item.text !== "string" || !item.text.trim()) return null;
      return { kind: "reasoning", text: item.text };
    case "commandExecution":
    case "command_execution":
      if (typeof item.command !== "string" || !item.command) return null;
      return {
        kind: "command",
        command: item.command,
        exitCode: item.exitCode ?? null,
        output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
      };
    case "fileChange":
    case "file_change": {
      const change = (item.changes ?? []).find((c) => typeof c.path === "string" && Boolean(c.path));
      if (!change?.path) return null;
      return { kind: "file-change", path: change.path, action: (change.kind as "add" | "update" | "delete") ?? "update" };
    }
    case "mcpToolCall":
    case "mcp_tool_call": {
      const tool = item.server && item.tool ? `${item.server}/${item.tool}` : (item.tool ?? "mcp_tool");
      const err = typeof item.error === "string" ? item.error : item.error?.message;
      return {
        kind: "tool-call",
        tool,
        arguments: item.arguments,
        result: item.result ?? item.error ?? undefined,
        isError: Boolean(err),
      };
    }
    case "webSearch":
    case "web_search":
      if (typeof item.query !== "string" || !item.query) return null;
      return { kind: "web-search", query: item.query };
    case "error":
      if (typeof item.message !== "string" && typeof item.error !== "string") return null;
      return { kind: "error", message: (item.message ?? item.error) as string };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Lists local Codex threads (v6 §6) through `thread/list`: newest first,
 * optionally narrowed to an exact working directory (the workspace cwd).
 *
 * Interactive usage (cli/vscode) AND `codex exec` runs are included —
 * work that started outside AgentFabric may come from either surface
 * (the server's default hides exec threads). Sections can duplicate a
 * thread across pages of one response; ids are deduped.
 */
export async function listCodexThreads(
  filter: HarnessThreadFilter = {},
  opts: { bin?: string } = {}
): Promise<HarnessThreadSummary[]> {
  const bin = opts.bin ?? codexBin();
  const session = await CodexAppServerSession.start(bin);
  try {
    const params: Record<string, unknown> = {
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      sourceKinds: ["cli", "vscode", "exec"],
    };
    if (filter.cwd) params.cwd = cwdCandidates(filter.cwd);
    if (filter.limit && filter.limit > 0) params.limit = filter.limit;
    const result = (await session.rpc("thread/list", params)) as { data?: WireThread[] };
    const seen = new Set<string>();
    const out: HarnessThreadSummary[] = [];
    for (const wire of result.data ?? []) {
      const summary = summaryFromWire(wire);
      if (!summary.id || seen.has(summary.id)) continue;
      if (summary.cwd && isTempDirPath(summary.cwd)) continue;
      seen.add(summary.id);
      out.push(summary);
    }
    return out;
  } finally {
    session.close();
  }
}

/**
 * Reads an existing Codex thread (v6 §7) without executing a model
 * request: `thread/read` supplies the metadata (title/cwd — the cwd is
 * what workspace association keys on, v6 §8), and the chronological
 * items come from `thread/turns/list` (falling back to
 * `thread/read` + includeTurns on servers without the turns endpoint).
 */
export async function readCodexThread(threadId: string, opts: { bin?: string } = {}): Promise<HarnessThreadDetail> {
  const bin = opts.bin ?? codexBin();
  const session = await CodexAppServerSession.start(bin);
  try {
    const items: HarnessThreadItem[] = [];
    const turns: Array<{ userText?: string; items: HarnessThreadItem[] }> = [];
    let turnCount: number | undefined;

    // 1. Metadata (thread/read never loads the thread into memory nor
    //    emits thread/started — it is the official read-only surface).
    const meta = (await session.rpc("thread/read", { threadId })) as { thread?: WireThread };
    const thread = meta.thread;
    if (!thread) throw new Error(`Codex thread not found: ${threadId}`);
    const summary = summaryFromWire(thread);

    const absorbTurn = (wireTurn: WireTurn): void => {
      const group: { userText?: string; items: HarnessThreadItem[] } = { items: [] };
      for (const item of wireTurn.items ?? []) {
        const mapped = itemFromWire(item);
        if (!mapped) continue;
        items.push(mapped);
        if (mapped.kind === "user-message" && group.userText === undefined) group.userText = mapped.text;
        else group.items.push(mapped);
      }
      turns.push(group);
    };

    // 2. Chronological items with turn boundaries.
    const readViaTurnsList = async (): Promise<void> => {
      let cursor: string | undefined;
      let seen = 0;
      // Page oldest → newest until the server stops handing out cursors.
      for (let page = 0; page < 200; page++) {
        const params: Record<string, unknown> = {
          threadId,
          sortDirection: "asc",
          limit: 100,
          itemsView: "full",
        };
        if (cursor) params.cursor = cursor;
        const result = (await session.rpc("thread/turns/list", params)) as {
          data?: WireTurn[];
          nextCursor?: string | null;
        };
        for (const turn of result.data ?? []) absorbTurn(turn);
        seen += (result.data ?? []).length;
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      turnCount = seen;
    };

    const readViaThreadRead = async (): Promise<void> => {
      const result = (await session.rpc("thread/read", { threadId, includeTurns: true })) as { thread?: WireThread };
      turnCount = result.thread?.turns?.length;
      for (const turn of result.thread?.turns ?? []) absorbTurn(turn);
    };

    try {
      await readViaTurnsList();
    } catch {
      // Older servers without thread/turns/list — read everything at once.
      await readViaThreadRead();
    }

    return {
      ...summary,
      turnCount,
      items,
      turns,
    };
  } finally {
    session.close();
  }
}

/**
 * Codex implementation of the local harness thread source port (v6 §6–§8).
 */
export const codexThreadSource: LocalHarnessThreadSource = {
  kind: "codex",
  listThreads: (filter) => listCodexThreads(filter),
  readThread: (threadId) => readCodexThread(threadId),
};
