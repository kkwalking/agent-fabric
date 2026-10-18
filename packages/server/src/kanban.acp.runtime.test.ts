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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createServer } from "./app.js";

const FAKE_DSH = String.raw`#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("Usage: dsh --profile acp [options]\n");
  process.exit(0);
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptId;
let promptCount = 0;
let resumed = false;
const permissionId = 9001;
// Mirrors DSH: models grouped by provider, effort as a flat select.
const CATALOG = [
  { value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" },
  { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
];
const EFFORTS = ["off", "low", "high", "max"];
let modelValue = CATALOG[0].value;
let effortValue = "high";
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: modelValue,
    options: [{ group: "deepseek-official", name: "DeepSeek", options: CATALOG }],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    type: "select",
    currentValue: effortValue,
    options: EFFORTS.map((effort) => ({ value: effort, name: effort })),
  },
];
const simple = process.env.FAKE_DSH_SIMPLE === "1";
const logFile = process.env.FAKE_DSH_LOG;
const log = (line) => { if (logFile) appendFileSync(logFile, line + "\n"); };

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
    log("new");
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-dsh-session", configOptions: configOptions() } });
    return;
  }
  if (message.method === "session/resume") {
    log("resume");
    resumed = true;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions() } });
    return;
  }
  if (message.method === "session/set_config_option") {
    log("config " + message.params.configId + "=" + message.params.value);
    if (message.params.configId === "model") modelValue = message.params.value;
    if (message.params.configId === "reasoning_effort") effortValue = message.params.value;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions() } });
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
    update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 1000000 });
    if (resumed || simple) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "s" + promptCount, content: { type: "text", text: (resumed ? "resumed reply" : "first reply") + " on " + modelValue + " @" + effortValue } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      promptId = undefined;
      return;
    }
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
  /** Simulates a server restart on the same data directory and port. */
  restart: () => Promise<void>;
  cleanup: () => Promise<void>;
}

interface BoundServer {
  server: Server;
  shutdown: () => void;
  sockets: Set<Socket>;
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

async function bindServer(dir: string, port: number): Promise<BoundServer> {
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
  return { server, shutdown, sockets };
}

async function closeServer(bound: BoundServer): Promise<void> {
  bound.shutdown();
  for (const socket of bound.sockets) socket.destroy();
  bound.server.closeAllConnections();
  await new Promise<void>((resolve) => bound.server.close(() => resolve()));
}

async function makeHarness(options: { simple?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "af-kanban-acp-runtime-"));
  const bin = join(dir, "bin");
  const project = join(dir, "project");
  mkdirSync(bin);
  mkdirSync(project);
  const fakeDsh = join(bin, "dsh");
  writeFileSync(fakeDsh, FAKE_DSH);
  chmodSync(fakeDsh, 0o755);

  const previousPath = process.env.PATH;
  const previousSimple = process.env.FAKE_DSH_SIMPLE;
  const previousLog = process.env.FAKE_DSH_LOG;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_DSH_LOG = join(dir, "dsh.log");
  if (options.simple) process.env.FAKE_DSH_SIMPLE = "1";
  else delete process.env.FAKE_DSH_SIMPLE;
  try {
    const port = await getFreePort();
    let bound = await bindServer(dir, port);
    const token = readFileSync(join(dir, "token"), "utf8").trim();
    return {
      dir,
      token,
      get baseUrl() {
        return `http://127.0.0.1:${port}`;
      },
      get server() {
        return bound.server;
      },
      get shutdown() {
        return bound.shutdown;
      },
      restart: async () => {
        await closeServer(bound);
        bound = await bindServer(dir, port);
      },
      cleanup: async () => {
        await closeServer(bound);
        // Closing sockets is asynchronous: let the server observe the closes
        // before the data dir goes away, or a late write surfaces as EPIPE
        // after the test has already finished.
        await new Promise((resolve) => setTimeout(resolve, 50));
        process.env.PATH = previousPath;
        if (previousSimple === undefined) delete process.env.FAKE_DSH_SIMPLE;
        else process.env.FAKE_DSH_SIMPLE = previousSimple;
        if (previousLog === undefined) delete process.env.FAKE_DSH_LOG;
        else process.env.FAKE_DSH_LOG = previousLog;
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

/** The column a card sits in, polled until it matches or time runs out. */
async function pollColumn(
  h: Harness,
  projectId: string,
  cardId: string,
  expected: string,
  timeoutMs = 2_000
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let column: string | undefined;
  while (Date.now() < deadline) {
    const cards = await api<{ cards: Array<{ id: string; column: string }> }>(
      h,
      "GET",
      `/api/kanban/projects/${projectId}/cards`
    );
    column = cards.cards.find((card) => card.id === cardId)?.column;
    if (column === expected) return column;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return column;
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
    // The record exists before the handshake. A card opened that early gets a
    // snapshot; a prompt then waits for the attach instead of inventing a
    // second turn (the old "still starting" rejection would now be a lie: the
    // composer accepts input while the agent attaches).
    let earlyId: string | undefined;
    for (let i = 0; i < 100 && !earlyId; i += 1) {
      const current = await api<{ session: { id: string } | null }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
      earlyId = current.session?.id;
      if (!earlyId) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(earlyId);
    const earlySocket = await openAgentSocket(h, earlyId!);
    await earlySocket.waitFor((frame) => frame.type === "agent_snapshot");
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
    // A dialog waiting on the user parks the card in Review.
    assert.equal(await pollColumn(h, project.id, card.id, "review"), "review");
    socket.send({ type: "permission", requestId: request.requestId, optionId: "allow" });

    const answered = await socket.waitFor((frame) => frame.type === "agent_permission_answered");
    assert.equal(answered.requestId, request.requestId);
    // The answer resumes the turn, which finishes into Review. The interim
    // in_progress move is deliberately not asserted: the fake agent can finish
    // the turn before a poll observes it, and the durable outcome is Review.
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

    // Reopening the stopped card replays the saved transcript from disk and
    // offers to resume the agent's own session instead of failing to attach.
    const replay = await openAgentSocket(h, session.id);
    const stoppedSnapshot = await replay.waitFor((frame) => frame.type === "agent_snapshot");
    assert.equal(stoppedSnapshot.status, "stopped");
    assert.equal(stoppedSnapshot.live, false);
    assert.equal(stoppedSnapshot.canResume, true);
    assert.equal(stoppedSnapshot.hasTranscript, true);
    const replayed = itemsOf(replay);
    assert.equal(replayed.filter((item) => item.kind === "user").length, 2);
    assert.match(replayed.filter((item) => item.kind === "agent").map((item) => item.text).join(""), /second reply/);
    replay.close();
  } finally {
    await h.cleanup();
  }
});

test("a restarted server replays the saved transcript and resumes the ACP session", { timeout: 60_000 }, async () => {
  const h = await makeHarness({ simple: true });
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "first turn",
      agentId: "dsh",
    });
    const { session } = await api<{ session: { id: string; status: string } }>(
      h,
      "POST",
      `/api/kanban/cards/${card.id}/start`,
      {}
    );

    // Attach while the first turn runs: the status frame is emitted after the
    // turn-end transcript flush, so it also tells us the file is on disk.
    const first = await openAgentSocket(h, session.id);
    const firstSnapshot = await first.waitFor((frame) => frame.type === "agent_snapshot");
    assert.equal(firstSnapshot.live, true);
    await first.waitFor(
      (frame) => frame.type === "agent_status" && frame.status === "awaiting_review",
      20_000
    );
    const before = itemsOf(first);
    assert.match(before.filter((item) => item.kind === "agent").map((item) => item.text).join(""), /first reply/);
    const running = await api<{ session: { nativeSessionId?: string } }>(
      h,
      "GET",
      `/api/kanban/cards/${card.id}/session`
    );
    assert.equal(running.session.nativeSessionId, "fake-dsh-session");
    first.close();

    // The turn end flushed the transcript to disk.
    const chatFile = join(h.dir, "kanban-chats", `${session.id}.json`);
    assert.equal(existsSync(chatFile), true);

    // Restart: processes die, records become interrupted, the file stays.
    await h.restart();
    const interrupted = await api<{ session: { status: string } }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
    assert.equal(interrupted.session.status, "interrupted");

    const replay = await openAgentSocket(h, session.id);
    const replaySnapshot = await replay.waitFor((frame) => frame.type === "agent_snapshot");
    assert.equal(replaySnapshot.live, false);
    assert.equal(replaySnapshot.canResume, true);
    assert.equal(replaySnapshot.hasTranscript, true);
    assert.equal(replaySnapshot.status, "interrupted");
    assert.deepEqual(
      itemsOf(replay).map((item) => item.kind),
      before.map((item) => item.kind)
    );

    // A prompt on the paused chat attaches first (resume), then runs as a
    // normal turn — the TUI/Desktop behaviour, not a dead-ended composer.
    // "second turn" must be answered by the resumed agent, i.e. wait for the
    // resumed reply itself rather than any status frame that happens to match.
    const typedSent = replay.frames.length;
    replay.send({ type: "prompt", text: "second turn" });
    await replay.waitFor(
      (frame) =>
        frame.type === "agent_item" &&
        String((frame.item as { text?: string }).text ?? "").includes("resumed reply"),
      20_000,
      typedSent
    );
    await replay.waitFor(
      (frame) => frame.type === "agent_status" && frame.status === "awaiting_review",
      20_000,
      typedSent
    );
    assert.match(readFileSync(join(h.dir, "dsh.log"), "utf8"), /resume/);
    const afterTyped = itemsOf(replay);
    assert.equal(afterTyped.filter((item) => item.kind === "user").length, 2);
    assert.match(afterTyped.filter((item) => item.kind === "agent").map((item) => item.text).join(""), /resumed reply/);
    const afterResume = await api<{ session: { status: string } }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
    assert.equal(afterResume.session.status, "awaiting_review");
    replay.close();

    // A second restart still finds both turns in the saved transcript.
    await h.restart();
    const again = await openAgentSocket(h, session.id);
    const againSnapshot = await again.waitFor((frame) => frame.type === "agent_snapshot");
    assert.equal(againSnapshot.hasTranscript, true);
    assert.equal(againSnapshot.canResume, true);
    const finalItems = itemsOf(again);
    assert.equal(finalItems.filter((item) => item.kind === "user").length, 2);
    assert.match(finalItems.filter((item) => item.kind === "agent").map((item) => item.text).join(""), /resumed reply/);
    again.close();
  } finally {
    await h.cleanup();
  }
});

test("a card's model and reasoning effort are applied before the first turn", { timeout: 40_000 }, async () => {
  const h = await makeHarness({ simple: true });
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    // The model is given as a display name; the board maps it onto the value
    // the agent advertises and applies it before the prompt.
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "first turn",
      agentId: "dsh",
      model: "DeepSeek-V4-Pro",
      reasoningEffort: "max",
    });
    const { session } = await api<{ session: { id: string } }>(h, "POST", `/api/kanban/cards/${card.id}/start`, {});

    const chat = await openAgentSocket(h, session.id);
    await chat.waitFor((frame) => frame.type === "agent_snapshot");
    // Wait for the first turn to settle before reading the record.
    await chat.waitFor(
      (frame) => frame.type === "agent_status" && frame.status === "awaiting_review",
      20_000
    );
    // The turn answered on the selected route, and the record mirrors it.
    const record = await api<{
      session: { modelRoute?: { value: string; provider?: string; model?: string; label?: string }; reasoningEffort?: string };
    }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
    assert.equal(record.session.modelRoute?.model, "deepseek-v4-pro");
    assert.equal(record.session.modelRoute?.provider, "deepseek-official");
    assert.equal(record.session.modelRoute?.label, "DeepSeek-V4-Pro");
    assert.equal(record.session.reasoningEffort, "max");
    assert.match(readFileSync(join(h.dir, "dsh.log"), "utf8"), /config model=\["deepseek-official","deepseek-v4-pro"\]/);
    assert.match(readFileSync(join(h.dir, "dsh.log"), "utf8"), /config reasoning_effort=max/);
    chat.close();
  } finally {
    await h.cleanup();
  }
});

test("the chat can switch model and effort on a live session", { timeout: 40_000 }, async () => {
  const h = await makeHarness({ simple: true });
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "first turn",
      agentId: "dsh",
    });
    const { session } = await api<{ session: { id: string } }>(h, "POST", `/api/kanban/cards/${card.id}/start`, {});
    const chat = await openAgentSocket(h, session.id);
    const snapshot = await chat.waitFor((frame) => frame.type === "agent_snapshot");
    const options = snapshot.configOptions as Array<{ id: string; currentValue: string }>;
    assert.deepEqual(options.map((option) => option.id), ["model", "reasoning_effort"]);
    assert.equal(options[0]?.currentValue, '["deepseek-official","deepseek-v4-flash"]');

    const since = chat.frames.length;
    chat.send({ type: "set_config", configId: "model", value: '["deepseek-official","deepseek-v4-pro"]' });
    const composer = await chat.waitFor((frame) => frame.type === "agent_composer", 10_000, since);
    const changed = (composer.configOptions as Array<{ id: string; currentValue: string }>).find(
      (option) => option.id === "model"
    );
    assert.equal(changed?.currentValue, '["deepseek-official","deepseek-v4-pro"]');
    const record = await api<{ session: { modelRoute?: { model?: string } } }>(
      h,
      "GET",
      `/api/kanban/cards/${card.id}/session`
    );
    assert.equal(record.session.modelRoute?.model, "deepseek-v4-pro");
    chat.close();
  } finally {
    await h.cleanup();
  }
});

test("a model the agent does not offer fails the start loudly", { timeout: 40_000 }, async () => {
  const h = await makeHarness({ simple: true });
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "first turn",
      agentId: "dsh",
      model: "no-such-model",
    });
    await assert.rejects(
      () => api(h, "POST", `/api/kanban/cards/${card.id}/start`, {}),
      /does not offer it/
    );
    const record = await api<{ session: { status: string; error?: string } }>(
      h,
      "GET",
      `/api/kanban/cards/${card.id}/session`
    );
    assert.equal(record.session.status, "failed");
    assert.match(record.session.error ?? "", /no-such-model/);
  } finally {
    await h.cleanup();
  }
});
