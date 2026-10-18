/**
 * ACP transport tests (v13).
 *
 * The driver is exercised against a fake `dsh --profile acp`: a tiny stdio
 * JSON-RPC peer with the same shape as DSH's app (initialize, session/new,
 * streamed updates, a permission request, prompt settlement). That keeps the
 * wire contract tested without a harness install, credentials, or a model call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSession, type AcpPermissionRequest, type AcpUpdate } from "./kanban/acp.js";
import { AcpChatProjector, type ChatItem } from "./kanban/acpChat.js";

const FAKE_ACP = String.raw`
import readline from "node:readline";
// Real DSH writes a non-protocol line on stdout; the driver must tolerate it.
process.stdout.write("not a json-rpc frame\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let pendingPrompt;
let permissionId = 9001;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentInfo: { name: "fake", version: "0" },
      agentCapabilities: process.env.FAKE_ACP_NO_RESUME === "1"
        ? { sessionCapabilities: { close: {} } }
        : { sessionCapabilities: { close: {}, list: {}, resume: {} } },
    } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "fake-session",
      configOptions: [{
        id: "model", name: "Model", type: "select", currentValue: "a",
        options: [{ value: "a", name: "A" }, { value: "b", name: "B" }],
      }],
    } });
    return;
  }
  if (message.method === "session/set_config_option") {
    const value = message.params.value;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [{
      id: "model", name: "Model", type: "select", currentValue: value,
      options: [{ value: "a", name: "A" }, { value: "b", name: "B" }],
    }] } });
    return;
  }
  if (message.method === "session/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
    return;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/cancel") {
    if (pendingPrompt !== undefined) {
      send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "cancelled" } });
      pendingPrompt = undefined;
    }
    return;
  }
  if (message.method === "session/prompt") {
    if (process.env.FAKE_ACP_SIMPLE === "1") {
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    pendingPrompt = message.id;
    const sessionId = message.params.sessionId;
    const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
    update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hello " } });
    update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "world" } });
    update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", kind: "execute", status: "in_progress", rawInput: { command: "ls" } });
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
  if (message.id === permissionId && message.result) {
    const sessionId = "fake-session";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
        },
      },
    });
    send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn" } });
    pendingPrompt = undefined;
  }
});
rl.on("close", () => process.exit(0));
`;

interface FakeHarness {
  session: AcpSession;
  dir: string;
  updates: AcpUpdate[];
  permissions: AcpPermissionRequest[];
  dispose: () => Promise<void>;
}

async function startFake(
  options: { env?: Record<string, string>; newSession?: boolean } = {}
): Promise<FakeHarness> {
  const dir = mkdtempSync(join(tmpdir(), "kanban-acp-test-"));
  const entry = join(dir, "fake-acp.mjs");
  writeFileSync(entry, FAKE_ACP);
  const session = new AcpSession({
    file: process.execPath,
    args: [entry],
    cwd: dir,
    env: options.env,
  });
  const updates: AcpUpdate[] = [];
  const permissions: AcpPermissionRequest[] = [];
  session.on("update", (update: AcpUpdate) => updates.push(update));
  session.on("permission", (request: AcpPermissionRequest) => permissions.push(request));
  await session.initialize();
  if (options.newSession !== false) await session.newSession(dir);
  return {
    session,
    dir,
    updates,
    permissions,
    dispose: async () => {
      const exited = new Promise<void>((resolve) => session.once("exit", () => resolve()));
      session.stop("SIGKILL");
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("ACP driver streams updates, asks for permission, and settles the turn", { timeout: 20_000 }, async () => {
  const harness = await startFake();
  const projector = new AcpChatProjector(() => "2026-01-01T00:00:00.000Z");
  harness.session.on("update", (update: AcpUpdate) => {
    projector.applyUpdate(update);
  });
  const prompt = harness.session.prompt("run it");
  // The fake parks the turn on a permission request; answer it like a user would.
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("no permission request")), 5_000);
    harness.session.on("permission", (request: AcpPermissionRequest) => {
      clearTimeout(deadline);
      assert.equal(request.title, "bash");
      assert.deepEqual(
        request.options.map((option) => option.kind),
        ["allow_once", "reject_once"]
      );
      harness.session.respondPermission(request.requestId, "allow");
      resolve();
    });
  });
  const result = await prompt;
  assert.equal(result.stopReason, "end_turn");

  const items = [...projector.snapshot];
  const agent = items.find((item) => item.kind === "agent");
  assert.equal(agent && agent.kind === "agent" ? agent.text : "", "hello world");
  const tool = items.find((item) => item.kind === "tool");
  assert.equal(tool && tool.kind === "tool" ? tool.status : "", "done");
  assert.equal(tool && tool.kind === "tool" ? tool.output : "", "a.txt");

  await harness.dispose();
});

test("ACP cancel settles the prompt as cancelled", { timeout: 20_000 }, async () => {
  const harness = await startFake();
  const prompt = harness.session.prompt("long task");
  await new Promise<void>((resolve) => {
    harness.session.on("permission", () => resolve());
  });
  harness.session.cancel();
  const result = await prompt;
  assert.equal(result.stopReason, "cancelled");
  await harness.dispose();
});

test("ACP resume attaches to a saved session and keeps prompting", { timeout: 20_000 }, async () => {
  const first = await startFake();
  assert.equal(first.session.sessionId, "fake-session");
  assert.equal(first.session.supportsResume, true);
  await first.dispose();

  // A new process, as after a server restart: no session/new, only resume.
  const second = await startFake({ env: { FAKE_ACP_SIMPLE: "1" }, newSession: false });
  assert.equal(second.session.supportsResume, true);
  const resumed = await second.session.resumeSession("fake-session", second.dir);
  assert.deepEqual(resumed.configOptions, []);
  assert.equal(second.session.sessionId, "fake-session");
  const result = await second.session.prompt("continue");
  assert.equal(result.stopReason, "end_turn");
  await second.dispose();
});

test("ACP resume is refused up front when the app does not advertise it", { timeout: 20_000 }, async () => {
  const harness = await startFake({ env: { FAKE_ACP_NO_RESUME: "1" }, newSession: false });
  assert.equal(harness.session.supportsResume, false);
  await assert.rejects(
    () => harness.session.resumeSession("fake-session", harness.dir),
    /does not advertise session\/resume/
  );
  await harness.dispose();
});

test("ACP projector restores a saved transcript without reusing ids", () => {
  const saved: ChatItem[] = [
    { id: "user:7", kind: "user", text: "earlier prompt", at: "t0" },
    { id: "error:9", kind: "error", message: "earlier error", at: "t1" },
  ];
  const projector = new AcpChatProjector(
    () => "2026-01-01T00:00:00.000Z",
    saved
  );
  assert.deepEqual(projector.snapshot, saved);
  const user = projector.addUser("continue");
  assert.equal(user.id, "user:10");
  assert.equal(projector.snapshot.length, 3);
});

test("ACP projector merges chunks and tool updates by id", () => {
  const projector = new AcpChatProjector(() => "t");
  projector.addUser("do it");
  projector.applyUpdate({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "a" } });
  projector.applyUpdate({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "b" } });
  projector.applyUpdate({ sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "think" } });
  projector.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "x", title: "read", kind: "read", status: "pending", rawInput: { path: "a" } });
  projector.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed", content: [{ type: "content", content: { type: "text", text: "boom" } }] });
  const items = [...projector.snapshot];
  assert.deepEqual(
    items.map((item) => item.kind),
    ["user", "agent", "reasoning", "tool"]
  );
  assert.equal(items[1]!.kind === "agent" ? items[1]!.text : "", "ab");
  assert.equal(items[2]!.kind === "reasoning" ? items[2]!.text : "", "think");
  const tool = items[3]!;
  assert.equal(tool.kind === "tool" ? tool.toolKind : "", "read");
  assert.equal(tool.kind === "tool" ? tool.status : "", "error");
  assert.equal(tool.kind === "tool" ? tool.error : "", "boom");
});

test("ACP initialize rejects loudly when the app cannot start", { timeout: 20_000 }, async () => {
  const session = new AcpSession({ file: join(tmpdir(), "does-not-exist-acp"), args: [], cwd: tmpdir() });
  await assert.rejects(() => session.initialize());
  session.stop("SIGKILL");
});

test("ACP keeps the advertised config options and applies changes", { timeout: 20_000 }, async () => {
  const harness = await startFake();
  assert.deepEqual(
    harness.session.configOptions.map((option) => [option.id, option.currentValue]),
    [["model", "a"]]
  );
  const next = await harness.session.setConfigOption("model", "b");
  assert.equal(next.find((option) => option.id === "model")?.currentValue, "b");
  assert.equal(harness.session.configOptions[0]?.currentValue, "b");
  await harness.dispose();
});
