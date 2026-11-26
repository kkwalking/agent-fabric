import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { RuntimeService, Store, WorkspaceService, seedDefaults } from "@agentfabric/core";
import { makeFixtures, useBins } from "@agentfabric/core/testkit";
import { createServer } from "./app.js";

const token = "a".repeat(64);
const modern = "2026-07-28";
const legacy = "2025-11-25";
const prefix = "io.modelcontextprotocol/";
const skillUri = "skill://delegate-to-fabric/SKILL.md";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function start(dataDir: string) {
  const handle = await createServer({ dataDir });
  const server = await new Promise<ReturnType<typeof handle.app.listen>>((resolve) => {
    const socket = handle.app.listen(0, "127.0.0.1", () => resolve(socket));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    admin: readFileSync(join(dataDir, "token"), "utf8").trim(),
    async close() {
      handle.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function rpc(base: string, method: string, params: Record<string, unknown> = {}, options: {
  modern?: boolean; authorization?: string; headers?: Record<string, string>; path?: string;
} = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    Authorization: options.authorization ?? `Bearer ${token}`,
    "MCP-Protocol-Version": options.modern ? modern : legacy,
  };
  if (options.modern) {
    headers["Mcp-Method"] = method;
    if (method === "tools/call") headers["Mcp-Name"] = String(params.name);
    if (method === "resources/read") headers["Mcp-Name"] = String(params.uri);
    params = {
      ...params,
      _meta: {
        [prefix + "protocolVersion"]: modern,
        [prefix + "clientInfo"]: { name: "test", version: "1" },
        [prefix + "clientCapabilities"]: {},
      },
    };
  }
  const response = await fetch(base + (options.path ?? "/mcp"), {
    method: "POST",
    headers: { ...headers, ...options.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? await response.json() : null };
}

test("delegates real adapter runs through HTTP to Codex, Claude Code and Pi fixtures", { timeout: 30_000 }, async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { PI_CODING_AGENT_DIR: join(fx.dir, "pi-state"), FAKE_PI_SLEEP_MS: "600" });
  const dataDir = join(fx.dir, "fabric");
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const store = await Store.open(dataDir);
    await seedDefaults(store);
    const ws = new WorkspaceService(store);
    const visibleDir = join(fx.dir, "visible");
    const hiddenDir = join(fx.dir, "hidden");
    mkdirSync(visibleDir); mkdirSync(hiddenDir);
    const workspace = await ws.create({ type: "local", name: "Visible", path: visibleDir });
    const hidden = await ws.create({ type: "local", name: "Private", path: hiddenDir });
    const runtimes = new RuntimeService(store).list();
    const options = runtimes.filter((r) => ["codex", "claude-code", "pi"].includes(r.kind));
    assert.equal(options.length, 3);

    server = await start(dataDir);
    assert.equal((await rpc(server.base, "tools/list")).status, 404);
    await server.close(); server = undefined;
    writeFileSync(join(dataDir, "mcp-delegation.json"), JSON.stringify({
      tokenSha256: sha256(token), workspaceIds: [workspace.id], runtimeIds: runtimes.map((r) => r.id),
    }), { mode: 0o600 });
    server = await start(dataDir);
    assert.equal((await rpc(server.base, "tools/list", {}, { authorization: `Bearer ${server.admin}` })).status, 401);
    assert.equal((await rpc(server.base, "tools/list", {}, { authorization: "", headers: { Cookie: `af_token=${server.admin}` }, path: "/MCP" })).status, 401);
    assert.equal((await rpc(server.base, "tools/list", {}, { headers: { Origin: "https://example.invalid" } })).status, 403);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(server!.base + "/mcp", { headers: { Host: "example.invalid" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(server.base + "/api/tasks", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    const init = await rpc(server.base, "initialize", { protocolVersion: legacy, capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.body.result.protocolVersion, legacy);
    assert.equal(init.body.result.capabilities.extensions, undefined);
    assert.equal((await rpc(server.base, "tools/list")).body.result.tools.length, 4);

    const discovery = await rpc(server.base, "server/discover", {}, { modern: true });
    assert.equal(discovery.status, 200);
    assert.deepEqual(discovery.body.result.capabilities.extensions[prefix + "skills"], {});
    assert.equal((await rpc(server.base, "tools/list", {}, { modern: true, headers: { "Mcp-Method": "ping" } })).body.error.code, -32020);
    const listed = (await rpc(server.base, "skills/list", {}, { modern: true })).body.result.skills[0];
    const loaded = (await rpc(server.base, "skills/get", { uri: skillUri }, { modern: true })).body.result.skill;
    assert.deepEqual(loaded, listed);
    const content = (await rpc(server.base, "resources/read", { uri: skillUri }, { modern: true })).body.result.contents[0].text;
    assert.equal(loaded.resources[0].digest, "sha256:" + sha256(content));
    assert.equal(loaded.resources[0].size, Buffer.byteLength(content));

    const call = async (name: string, args?: object, useModern = false) => {
      const res = await rpc(server!.base, "tools/call", { name, arguments: args }, { modern: useModern });
      assert.equal(res.status, 200);
      return res.body.result.structuredContent;
    };
    const inventory = await call("list_workspaces");
    assert.deepEqual(inventory.workspaces, [{ id: workspace.id, name: "Visible" }]);
    assert.deepEqual(inventory.runtimes.map((r: { kind: string }) => r.kind).sort(), ["claude-code", "codex", "pi"]);
    const baseArgs = { workspaceId: workspace.id, runtimeId: options[0].id, requestId: "test", goal: "Summarize a fixture." };
    assert.equal((await call("submit_task", { ...baseArgs, workspaceId: hidden.id })).code, "workspace-not-allowed");
    assert.equal((await call("submit_task", { ...baseArgs, cwd: "/tmp" })).code, "invalid-arguments");
    assert.equal((await call("submit_task", { ...baseArgs, runtimeId: runtimes.find((r) => r.kind === "opencode")!.id })).code, "runtime-not-allowed");
    assert.equal((await call("get_task", { runId: "missing" })).code, "run-not-found");

    const settled = async (runId: string) => {
      for (let i = 0; i < 160; i++) {
        const result = await call("get_task", { runId });
        if (!["pending", "starting", "running"].includes(result.status)) return result;
        await delay(50);
      }
      assert.fail("Run did not reach a terminal state");
    };
    const adminGet = async (path: string) => {
      const response = await fetch(server!.base + path, { headers: { Authorization: `Bearer ${server!.admin}` } });
      assert.equal(response.status, 200);
      return response.json();
    };
    const accepted = [];
    for (const runtime of options) {
      const args = { ...baseArgs, requestId: runtime.kind, runtimeId: runtime.id };
      const [first, retry] = await Promise.all([call("submit_task", args, true), call("submit_task", args)]);
      assert.ok(first.runId, JSON.stringify(first));
      assert.equal(first.runId, retry.runId);
      assert.equal((await call("submit_task", { ...args, goal: "Different" })).code, "request-id-conflict");
      const done = await settled(first.runId);
      assert.equal(done.status, "completed", JSON.stringify(await adminGet(`/api/runs/${first.runId}`)));
      assert.match(done.answer, runtime.kind === "pi" ? /^pi fresh session/ : /^(codex|claude) ok:/);
      const runs = await adminGet(`/api/tasks/${first.taskId}/runs`);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].continuity, "new");
      assert.equal(runs[0].runtimeId, runtime.id);
      accepted.push({ args, runId: first.runId });
    }

    const pi = options.find((r) => r.kind === "pi")!;
    const pending = await call("submit_task", { ...baseArgs, requestId: "cancel-me", runtimeId: pi.id });
    assert.ok(pending.runId);
    assert.equal((await call("cancel_task", { runId: pending.runId })).cancellationRequested, true);
    assert.equal((await settled(pending.runId)).status, "cancelled");
    await server.close(); server = await start(dataDir);
    for (const { args, runId } of accepted) {
      const retry = await call("submit_task", args);
      assert.equal(retry.runId, runId);
      assert.equal(retry.status, "completed");
    }
  } finally {
    await server?.close();
    restore();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
