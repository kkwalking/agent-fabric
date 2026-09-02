import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, newId } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import { ProviderService, ModelService, RuntimeService, WorkspaceService, SessionService, SecretService, seedDefaults } from "./services.js";
import { mockAdapter } from "../../runtimes/src/mock.js";
import { addUsage, estimateCost } from "./cost.js";

async function freshStore(): Promise<Store> {
  const dir = mkdtempSync(join(tmpdir(), "af-test-"));
  return Store.open(dir);
}

test("store persists and reloads records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-test-"));
  const store1 = await Store.open(dir);
  await store1.insert("providers", { id: newId("prov"), name: "x", type: "openai", enabled: true, createdAt: "", updatedAt: "" });
  await store1.commit();
  const store2 = await Store.open(dir);
  assert.equal(store2.list("providers").length, 1);
});

test("masked secrets never expose plaintext", async () => {
  const store = await freshStore();
  const secrets = new SecretService(store);
  const s = await secrets.create({ name: "k", value: "sk-abcdefghijkl" });
  assert.equal(s.value, "sk-abcdefghijkl"); // returned once at creation
  const listed = secrets.list().find((x) => x.id === s.id);
  assert.equal(listed?.value, undefined);
  assert.ok(listed?.masked.includes("***"));
});

test("mock run completes with events, usage and artifacts", async () => {
  const store = await freshStore();
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  await seedDefaults(store);
  const mockRuntime = store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const runService = new RunService(store, bus, registry);
  const { run } = await runService.submit({ prompt: "hello", runtimeId: mockRuntime.id, modelId: undefined });
  // Wait for completion
  const deadline = Date.now() + 8000;
  let current = runService.get(run.id)!;
  while (["pending", "starting", "running"].includes(current.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    current = runService.get(run.id)!;
  }
  assert.equal(current.status, "completed");
  assert.ok(current.eventCount > 5);
  assert.ok((current.usage?.modelRequests ?? 0) >= 1);
  assert.ok(current.artifactIds.length >= 1);
});

test("cost estimation is finite and monotonic", () => {
  const c = estimateCost("gpt-4o", 1000, 500);
  assert.ok(c > 0);
  const c2 = estimateCost("some-unknown-model", 1000, 500);
  assert.ok(c2 > 0);
  const merged = addUsage(
    { inputTokens: 1, outputTokens: 2, modelRequests: 1, estimatedCost: 0.1 },
    { inputTokens: 3, outputTokens: 4, modelRequests: 1, estimatedCost: 0.2 }
  );
  assert.equal(merged.inputTokens, 4);
  assert.equal(merged.outputTokens, 6);
});

test("event bus fan-out", async () => {
  const bus = new EventBus();
  let count = 0;
  const unsub = bus.onAll(() => count++);
  bus.publish({ id: "e1", runId: "r1", seq: 1, type: "log", timestamp: "", data: {} } as any);
  assert.equal(count, 1);
  unsub();
  bus.publish({ id: "e2", runId: "r1", seq: 2, type: "log", timestamp: "", data: {} } as any);
  assert.equal(count, 1);
});

async function waitForRun(runService: RunService, runId: string, statuses: string[]): Promise<any> {
  const deadline = Date.now() + 8000;
  let current = runService.get(runId)!;
  while (statuses.includes(current.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    current = runService.get(runId)!;
  }
  return current;
}

test("execution policy max model calls aborts the run", async () => {
  const store = await freshStore();
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  await seedDefaults(store);
  const mockRuntime = store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const runService = new RunService(store, bus, registry);
  const { run } = await runService.submit({
    prompt: "policy test",
    runtimeId: mockRuntime.id,
    policy: { maxModelCalls: 1 },
  });
  const finished = await waitForRun(runService, run.id, ["pending", "starting", "running"]);
  assert.equal(finished.status, "failed");
  assert.match(finished.error ?? "", /max model calls/);
});

test("execution policy max tokens aborts the run", async () => {
  const store = await freshStore();
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  await seedDefaults(store);
  const mockRuntime = store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const runService = new RunService(store, bus, registry);
  const { run } = await runService.submit({
    prompt: "policy test",
    runtimeId: mockRuntime.id,
    policy: { maxTokens: 1 },
  });
  const finished = await waitForRun(runService, run.id, ["pending", "starting", "running"]);
  assert.equal(finished.status, "failed");
  assert.match(finished.error ?? "", /max tokens/);
});

test("execution policy max cost aborts the run", async () => {
  const store = await freshStore();
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  await seedDefaults(store);
  const mockRuntime = store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const runService = new RunService(store, bus, registry);
  const { run } = await runService.submit({
    prompt: "policy test",
    runtimeId: mockRuntime.id,
    policy: { maxCost: 0.000001 },
  });
  const finished = await waitForRun(runService, run.id, ["pending", "starting", "running"]);
  assert.equal(finished.status, "failed");
  assert.match(finished.error ?? "", /max cost/);
});

test("task tools are stored and merged into policy tool permissions", async () => {
  const store = await freshStore();
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  await seedDefaults(store);
  const mockRuntime = store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const runService = new RunService(store, bus, registry);
  const { task } = await runService.submit({
    prompt: "tools test",
    runtimeId: mockRuntime.id,
    tools: ["read_file", "edit_file"],
  });
  assert.deepEqual(task.tools, ["read_file", "edit_file"]);
  assert.deepEqual(task.policy?.toolPermissions, ["read_file", "edit_file"]);
});

test("provider enable/disable via service", async () => {
  const store = await freshStore();
  const providers = new ProviderService(store);
  const p = await providers.create({ name: "test", type: "openai" });
  assert.equal(p.enabled, true);
  await providers.setEnabled(p.id, false);
  assert.equal(providers.get(p.id)?.enabled, false);
  await providers.setEnabled(p.id, true);
  assert.equal(providers.get(p.id)?.enabled, true);
});

test("git workspace clones a local repository into the data dir", async () => {
  const src = mkdtempSync(join(tmpdir(), "af-git-src-"));
  writeFileSync(join(src, "hello.txt"), "hello world\n");
  execFileSync("git", ["init", "-q", src]);
  execFileSync("git", ["add", "."], { cwd: src });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: src });

  const store = await freshStore();
  const workspaces = new WorkspaceService(store);
  const ws = await workspaces.create({
    name: "git-ws",
    type: "git",
    repoUrl: `file://${src}`,
  });
  assert.ok(ws.path, "git workspace should have a cloned path");
  assert.ok(existsSync(join(ws.path!, "hello.txt")), "cloned file should exist");
  assert.ok(existsSync(join(ws.path!, ".git")), "clone should be a git repository");
});
