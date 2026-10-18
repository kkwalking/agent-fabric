/**
 * Board session runtime over a fake DSH ACP app (v13).
 *
 * `dsh` is faked on PATH (same technique as the PTY tests' fake `claude`), so
 * this exercises the real runtime path — availability check, ACP handshake,
 * session/new, first prompt, permission request/answer, turn settlement, the
 * chat websocket, follow-up turns and stop — without a harness install or a
 * model call. It pins the lifecycle QA found untested.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createServer } from "./app.js";

const FAKE_DSH = String.raw`#!/usr/bin/env node
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("Usage: dsh --profile acp [options]\n");
  process.exit(0);
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptId;
let promptCount = 0;
const permissionId = 9001;

const update = (sessionId, value) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (message.method === "initialize") {
    // Delay the handshake so the test can attach while the card is starting.
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentInfo: { name: "fake-dsh", version: "0" },
      agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
    }}), 250);
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-dsh-session" } });
    return;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/cancel") {
    if (promptId !== undefined) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
      promptId = undefined;
    }
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    promptCount += 1;
    const sessionId = message.params.sessionId;
    if (promptCount === 1) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "working on it" } });
      send({
        jsonrpc: "2.0",
        id: permissionId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "c1", title: "bash" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "second reply" } });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    promptId = undefined;
    return;
  }
  if (message.id === permissionId && message.result) {
    const sessionId = "fake-dsh-session";
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", kind: "execute", status: "in_progress", rawInput: { command: "ls" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "a.txt" } }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: " first reply" } });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    promptId = undefined;
  }
});
rl.on("close", () => process.exit(0));
`;

interface Harness {
  dir: string;
  baseUrl: string;
  token: string;
  server: Server;
  shutdown: () => void;
  cleanup: () => Promise<void>;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "af-kanban-acp-runtime-"));
  const bin = join(dir, "bin");
  const project = join(dir, "project");
  mkdirSync(bin);
  mkdirSync(project);
  const fakeDsh = join(bin, "dsh");
  writeFileSync(fakeDsh, FAKE_DSH);
  chmodSync(fakeDsh, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const port = await getFreePort();
    const { app, shutdown, upgrade } = await createServer({
      dataDir: dir,
      hookBaseUrl: `http://127.0.0.1:${port}/kanban-hooks/ingest`,
    });
    const server = createHttpServer(app);
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", upgrade);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const token = readFileSync(join(dir, "token"), "utf8").trim();
    return {
      dir,
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      server,
      shutdown,
      cleanup: async () => {
        shutdown();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        process.env.PATH = previousPath;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    process.env.PATH = previousPath;
    throw err;
  }
}

async function api<T>(h: Harness, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${h.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${res.status} ${data?.code ?? ""} ${data?.error ?? text}`);
  return data as T;
}

interface AgentSocket {
  frames: Array<Record<string, unknown>>;
  waitFor: (
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number,
    since?: number
  ) => Promise<Record<string, unknown>>;
  send: (frame: unknown) => void;
  closed: Promise<void>;
  close: () => void;
}

async function openAgentSocket(h: Harness, sessionId: string): Promise<AgentSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/${encodeURIComponent(sessionId)}/agent`,
    { headers: { authorization: `Bearer ${h.token}` } }
  );
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = [];
  ws.on("message", (raw) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  return {
    frames,
    waitFor: (predicate, timeoutMs = 10_000, since = 0) =>
      new Promise((resolve, reject) => {
        const existing = frames.slice(since).find(predicate);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error("agent frame timeout")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      }),
    send: (frame) => ws.send(JSON.stringify(frame)),
    closed,
    close: () => ws.close(),
  };
}

function itemsOf(socket: AgentSocket): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const frame of socket.frames) {
    // The snapshot is the replay of everything that happened before attach.
    if (frame.type === "agent_snapshot") {
      for (const item of (frame.items as Array<Record<string, unknown>>) ?? []) byId.set(String(item.id), item);
    }
    if (frame.type !== "agent_item") continue;
    const item = frame.item as Record<string, unknown>;
    byId.set(String(item.id), item);
  }
  return [...byId.values()];
}

test("a DSH card runs an interactive ACP turn, answers permission, continues, and stops", { timeout: 40_000 }, async () => {
  const h = await makeHarness();
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "list the files",
      agentId: "dsh",
      permissionModeId: "default",
    });
    const startPromise = api<{ session: { id: string; transport: string; status: string } }>(
      h,
      "POST",
      `/api/kanban/cards/${card.id}/start`,
      {}
    );
    // The record exists before the handshake; a card opened that early gets a
    // snapshot and a refusal for prompts instead of a phantom user turn.
    let earlyId: string | undefined;
    for (let i = 0; i < 100 && !earlyId; i += 1) {
      const current = await api<{ session: { id: string } | null }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
      earlyId = current.session?.id;
      if (!earlyId) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(earlyId);
    const earlySocket = await openAgentSocket(h, earlyId!);
    await earlySocket.waitFor((frame) => frame.type === "agent_snapshot");
    earlySocket.send({ type: "prompt", text: "too early" });
    const earlyError = await earlySocket.waitFor((frame) => frame.type === "agent_error");
    assert.equal(earlyError.code, "kanban-agent-starting");
    earlySocket.close();

    const { session } = await startPromise;
    assert.equal(session.transport, "acp");

    // The handshake is async; wait until the native session id is recorded.
    let current: { session: { id: string; nativeSessionId?: string; status: string } } = { session: { id: session.id, status: session.status } };
    for (let i = 0; i < 100; i += 1) {
      current = await api(h, "GET", `/api/kanban/cards/${card.id}/session`);
      if (current.session.nativeSessionId) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(current.session.nativeSessionId, "fake-dsh-session");

    const socket = await openAgentSocket(h, session.id);
    const snapshot = await socket.waitFor((frame) => frame.type === "agent_snapshot");
    assert.equal(snapshot.running, true);

    // The fake parks the first turn on a permission request; the board marks
    // the session needs_attention and lets the chat answer it.
    const permission = await socket.waitFor((frame) => frame.type === "agent_permission");
    const request = permission.request as { requestId: string; options: Array<{ optionId: string; kind: string }> };
    assert.equal(request.options[0]?.kind, "allow_once");
    await socket.waitFor((frame) => frame.type === "agent_status" && frame.status === "needs_attention");
    socket.send({ type: "permission", requestId: request.requestId, optionId: "allow" });

    const answered = await socket.waitFor((frame) => frame.type === "agent_permission_answered");
    assert.equal(answered.requestId, request.requestId);
    await socket.waitFor((frame) => frame.type === "agent_status" && frame.status === "awaiting_review");
    // The transcript carries the prompt, the streamed answer, and the tool.
    let items = itemsOf(socket);
    const user = items.filter((item) => item.kind === "user");
    assert.equal(user.length, 1);
    assert.equal(user[0]?.text, "list the files");
    const agentText = items
      .filter((item) => item.kind === "agent")
      .map((item) => item.text)
      .join("");
    assert.match(agentText, /first reply/);
    const tool = items.find((item) => item.kind === "tool");
    assert.equal(tool?.status, "done");
    assert.match(String(tool?.output ?? ""), /a\.txt/);
    const afterTurn = await api<{ session: { status: string } }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
    assert.equal(afterTurn.session.status, "awaiting_review");
    const column = await api<{ cards: Array<{ id: string; column: string }> }>(h, "GET", `/api/kanban/projects/${project.id}/cards`);
    assert.equal(column.cards.find((entry) => entry.id === card.id)?.column, "review");

    // The process stays alive: a second prompt is a new turn in the same session.
    const secondTurn = socket.frames.length;
    socket.send({ type: "prompt", text: "say second" });
    await socket.waitFor((frame) => frame.type === "agent_status" && frame.status === "running", 10_000, secondTurn);
    await socket.waitFor(
      (frame) => frame.type === "agent_status" && frame.status === "awaiting_review",
      10_000,
      secondTurn
    );
    items = itemsOf(socket);
    assert.equal(items.filter((item) => item.kind === "user").length, 2);
    assert.match(items.filter((item) => item.kind === "agent").map((item) => item.text).join(""), /second reply/);

    // Stop settles the record, closes the chat, and the session is no longer live.
    const stopped = await api<{ session: { status: string } }>(h, "POST", `/api/kanban/cards/${card.id}/stop`, {});
    assert.equal(stopped.session.status, "stopped");
    await socket.closed;

    const dead = new WebSocket(
      `ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/${encodeURIComponent(session.id)}/agent`,
      { headers: { authorization: `Bearer ${h.token}` } }
    );
    const frames: Array<Record<string, unknown>> = [];
    dead.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve) => {
      dead.once("close", () => resolve());
      dead.once("error", () => resolve());
    });
    const error = frames.find((frame) => frame.type === "agent_error");
    assert.equal(error?.code, "kanban-session-not-live");
  } finally {
    await h.cleanup();
  }
});
