/**
 * Tests for the v1 spec (v1.md): runtime container lifecycle,
 * workspaces, harness-native session resume, and handoffs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import {
  RuntimeService,
  WorkspaceService,
  RuntimeSessionService,
  seedDefaults,
} from "./services.js";
import { HandoffService } from "./handoff.js";
import { ContainerLeaseManager, resolveLifecycle, type ContainerOps } from "./lifecycle.js";
import { buildAssistedHandoffContent, renderHandoffPrompt } from "./handoff.js";
import { mockAdapter } from "../../runtimes/src/mock.js";
import type { AgentRuntimeAdapter, RuntimeContext, RuntimeResult } from "./runtime.js";
import type { Run } from "./types.js";

async function freshStore(): Promise<Store> {
  const dir = mkdtempSync(join(tmpdir(), "af-v1-"));
  return Store.open(dir);
}

/* ------------------------------------------------------------------ */
/* A second "harness" for cross-harness handoff tests                  */
/* ------------------------------------------------------------------ */

const customAdapter: AgentRuntimeAdapter = {
  kind: "custom",
  name: "Custom Harness",
  capabilities: {
    supportsNativeSession: true,
    supportsNativeResume: true,
    supportsStreamingEvents: true,
    supportsHandoffGeneration: false,
    supportsWorkspace: true,
    supportsInteractiveExecution: false,
  },
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    await ctx.log(`Custom harness ran task (continuity=${ctx.continuity})`);
    // Echo the instruction this run was given so tests can assert the
    // handoff content actually reaches the new harness.
    const instruction = ctx.run.inputInstruction ?? ctx.task.prompt;
    await ctx.emit("agent.message", { role: "user", content: instruction });
    await ctx.emit("agent.message", { role: "assistant", content: "custom harness did some work. Next: finish the remaining parts." });
    return {
      exitCode: 0,
      nativeSessionRef: `custom-ses-${ctx.task.id.slice(-6)}`,
      runtimeVersion: "custom-2.1",
    };
  },
};

interface Harness {
  store: Store;
  runService: RunService;
  workspaces: WorkspaceService;
  runtimes: RuntimeService;
  runtimeSessions: RuntimeSessionService;
  handoffs: HandoffService;
}

async function freshHarness(): Promise<Harness> {
  const store = await freshStore();
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  registry.register(customAdapter);
  await seedDefaults(store);
  const runService = new RunService(store, bus, registry);
  return {
    store,
    runService,
    workspaces: new WorkspaceService(store),
    runtimes: new RuntimeService(store),
    runtimeSessions: new RuntimeSessionService(store),
    handoffs: new HandoffService(store),
  };
}

async function waitForRun(runService: RunService, runId: string): Promise<Run> {
  const deadline = Date.now() + 10000;
  let current = runService.get(runId)!;
  while (["pending", "starting", "running"].includes(current.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
    current = runService.get(runId)!;
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* Lifecycle policy resolution (spec v1 §1)                            */
/* ------------------------------------------------------------------ */

test("lifecycle resolution: default ephemeral, legacy persistent, keep-alive, override", async () => {
  const h = await freshHarness();
  const ephemeral = await h.runtimes.create({ name: "e", kind: "mock" });
  assert.equal(resolveLifecycle(ephemeral).mode, "ephemeral");

  const legacy = await h.runtimes.create({ name: "l", kind: "mock", ephemeral: false });
  assert.equal(resolveLifecycle(legacy).mode, "persistent");

  const keepAlive = await h.runtimes.create({
    name: "k",
    kind: "mock",
    lifecycle: { mode: "keep-alive", idleTimeoutMs: 1234 },
  });
  const resolved = resolveLifecycle(keepAlive);
  assert.equal(resolved.mode, "keep-alive");
  assert.equal(resolved.idleTimeoutMs, 1234);

  // Per-run override wins over the runtime default.
  const override = resolveLifecycle(keepAlive, { mode: "ephemeral" });
  assert.equal(override.mode, "ephemeral");
});

test("keep-alive lease is destroyed after idle timeout and reusable before", async () => {
  const destroyed: string[] = [];
  const ops: ContainerOps = {
    destroy: async (id) => destroyed.push(id),
  };
  const manager = new ContainerLeaseManager(ops);

  await manager.retain({
    containerId: "ctr_1",
    runtimeId: "rt_1",
    workspaceId: "ws_1",
    runId: "run_1",
    idleTimeoutMs: 80,
  });
  assert.equal(manager.list().length, 1);

  // Acquire before timeout: lease consumed, container reused, no destroy.
  const lease = manager.acquire("rt_1", "ws_1");
  assert.equal(lease?.containerId, "ctr_1");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(destroyed, []);

  // Retain again but let it expire this time.
  await manager.retain({
    containerId: "ctr_2",
    runtimeId: "rt_1",
    workspaceId: "ws_1",
    runId: "run_2",
    idleTimeoutMs: 80,
  });
  assert.equal(manager.list().length, 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(destroyed, ["ctr_2"]);
  assert.equal(manager.list().length, 0);
});

test("lease recovery after restart destroys expired and re-arms live containers", async () => {
  const destroyed: string[] = [];
  const ops: ContainerOps = { destroy: async (id) => destroyed.push(id) };
  const manager = new ContainerLeaseManager(ops);

  await manager.recover([
    {
      containerId: "ctr_expired",
      runtimeId: "rt_1",
      runId: "run_1",
      idleTimeoutMs: 0,
      retainedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30_000).toISOString(),
    },
    {
      containerId: "ctr_live",
      runtimeId: "rt_2",
      runId: "run_2",
      idleTimeoutMs: 60_000,
      retainedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  ]);
  assert.deepEqual(destroyed, ["ctr_expired"]);
  assert.equal(manager.peek("rt_2")?.containerId, "ctr_live");
});

/* ------------------------------------------------------------------ */
/* Workspace durability (spec v1 §10–§14)                              */
/* ------------------------------------------------------------------ */

test("workspace save records durability and outlives task and containers", async () => {
  const h = await freshHarness();
  const wsDir = mkdtempSync(join(tmpdir(), "af-ws-"));
  writeFileSync(join(wsDir, "file.txt"), "work content");

  // Import an existing directory (spec v1 §11 Import).
  const ws = await h.workspaces.import({ name: "imported", type: "local", path: wsDir });
  assert.equal(ws.source, "import");
  assert.equal(ws.status, "ready");
  assert.ok(existsSync(ws.path!));

  // Task references (not owns) the workspace.
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const { task, run } = await h.runService.submit({
    prompt: "workspace durability test",
    runtimeId: mockRuntime.id,
    workspaceId: ws.id,
  });
  const finished = await waitForRun(h.runService, run.id);
  assert.equal(finished.status, "completed");

  // Save happened automatically after the run (spec v1 §11 Save).
  const saved = h.workspaces.get(ws.id)!;
  assert.ok(saved.lastSavedAt, "workspace should have lastSavedAt after the run");
  assert.equal(saved.lastSavedRunId, run.id);

  // Workspace + artifacts + logs survive; deleting the task does not
  // touch the workspace (independent lifecycle, spec v1 §13).
  await h.store.remove("tasks", task.id);
  assert.ok(h.workspaces.get(ws.id));
  assert.ok(h.runService.get(run.id));
  const usage = h.workspaces.usage(ws.id);
  assert.equal(usage.runs.length, 1);
});

test("importing a non-existent directory fails with a clear error", async () => {
  const h = await freshHarness();
  await assert.rejects(
    () => h.workspaces.import({ name: "ghost", type: "local", path: "/definitely/not/here-12345" }),
    /does not exist/
  );
});

test("saving a workspace whose directory vanished marks it missing", async () => {
  const h = await freshHarness();
  const wsDir = mkdtempSync(join(tmpdir(), "af-gone-"));
  const ws = await h.workspaces.import({ name: "gone", type: "local", path: wsDir });
  const { rmSync } = await import("node:fs");
  rmSync(wsDir, { recursive: true });
  await assert.rejects(() => h.workspaces.save(ws.id), /missing/);
  assert.equal(h.workspaces.get(ws.id)?.status, "missing");
});

/* ------------------------------------------------------------------ */
/* Resume: same harness, native session (spec v1 §3/§4/§20)            */
/* ------------------------------------------------------------------ */

async function startTaskOn(h: Harness, runtimeId: string, workspaceId?: string): Promise<{ taskId: string; firstRun: Run }> {
  const { task, run } = await h.runService.submit({
    prompt: "implement the payment refund feature",
    title: "Payment Refund",
    runtimeId,
    workspaceId,
  });
  await waitForRun(h.runService, run.id);
  return { taskId: task.id, firstRun: h.runService.get(run.id)! };
}

test("continue on the same harness resumes the native session", async () => {
  const h = await freshHarness();
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const { taskId } = await startTaskOn(h, mockRuntime.id);

  // A native session reference was persisted after run #1.
  const refs = h.runtimeSessions.list({ taskId });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].runtimeKind, "mock");
  assert.equal(refs[0].resumeSupported, true);
  assert.ok(refs[0].nativeSessionRef.startsWith("mock-ses-"));

  // Continue options predict a Resume.
  const options = h.runService.continueOptions(taskId);
  assert.equal(options.resumeAvailable, true);
  assert.equal(options.suggestedMode, "resume");
  assert.match(options.explanation, /Resume/);

  // Continue → run #2 with resume continuity.
  const result = await h.runService.continueTask(taskId, { prompt: "keep going" });
  assert.equal(result.continuity, "resume");
  assert.ok(result.runtimeSessionRef);
  assert.equal(result.run.previousHandoffId, undefined, "resume must not create a handoff");
  assert.equal(result.run.inputInstruction, "keep going");
  const second = await waitForRun(h.runService, result.run.id);
  assert.equal(second.status, "completed");

  const events = h.runService.events(second.id).map((e) => e.type);
  assert.ok(events.includes("runtime.session.resumed"), `expected runtime.session.resumed in ${events.join(",")}`);
});

test("continue on the same harness without a resumable session falls back to handoff", async () => {
  const h = await freshHarness();
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const { taskId } = await startTaskOn(h, mockRuntime.id);
  // Simulate session loss: expire the reference.
  const refs = h.runtimeSessions.list({ taskId });
  await h.runtimeSessions.expire(refs[0].id);

  const result = await h.runService.continueTask(taskId, { prompt: "continue after restart" });
  assert.equal(result.continuity, "handoff");
  assert.ok(result.handoff);
  assert.match(result.explanation, /Handoff/);
});

/* ------------------------------------------------------------------ */
/* Handoff: cross-harness continuation (spec v1 §4–§8/§14/§20)          */
/* ------------------------------------------------------------------ */

test("switching harness performs a handoff, not a session migration", async () => {
  const h = await freshHarness();
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const customRuntime = await h.runtimes.create({ name: "Custom B", kind: "custom" });
  const wsDir = mkdtempSync(join(tmpdir(), "af-hoff-"));
  const ws = await h.workspaces.import({ name: "payment-service", type: "local", path: wsDir });

  const { taskId } = await startTaskOn(h, mockRuntime.id, ws.id);

  // The mock harness generated its own handoff after run #1.
  const firstRun = h.runService.forTask(taskId)[0];
  assert.ok(firstRun.generatedHandoffId, "mock harness handoff should be stored on the run");
  const harnessHandoff = h.handoffs.get(firstRun.generatedHandoffId!);
  assert.equal(harnessHandoff?.source, "harness");

  // Continue on the other harness → Handoff.
  const options = h.runService.continueOptions(taskId, customRuntime.id);
  assert.equal(options.resumeAvailable, false);
  assert.equal(options.suggestedMode, "handoff");
  assert.ok(options.handoffPreview);

  const result = await h.runService.continueTask(taskId, {
    prompt: "continue with two failing tests",
    runtimeId: customRuntime.id,
    userNotes: "切换到 Custom，继续修剩下的两个测试，不要修改现有 API。",
  });
  assert.equal(result.continuity, "handoff");
  const handoff = result.handoff!;
  assert.equal(handoff.fromRuntimeKind, "mock");
  assert.equal(handoff.toRuntimeKind, "custom");
  assert.ok(handoff.sources!.includes("user"));
  assert.match(handoff.userNotes!, /不要修改现有 API/);

  // Run #2 received the handoff via its input instruction.
  const secondRun = h.runService.get(result.run.id)!;
  assert.equal(secondRun.previousHandoffId, handoff.id);
  assert.match(secondRun.inputInstruction!, /# Handoff from/);
  assert.match(secondRun.inputInstruction!, /不要修改现有 API/);
  assert.equal(secondRun.runtimeSessionRefId, undefined, "handoff runs start without a previous native session");

  const finished = await waitForRun(h.runService, result.run.id);
  assert.equal(finished.status, "completed");

  // The handoff content must actually reach the new harness as its
  // instruction (spec v1 §20 Inject Handoff) — not stay a stored field.
  const userMessages = h.runService.events(finished.id)
    .filter((e) => e.type === "agent.message" && e.data?.role === "user")
    .map((e) => String(e.data?.content ?? ""));
  assert.ok(
    userMessages.some((c) => c.includes("# Handoff from") && c.includes("不要修改现有 API")),
    `expected the rendered handoff in the harness input, got: ${JSON.stringify(userMessages)}`
  );

  // The new harness created its own new native session:
  const newRefs = h.runtimeSessions.list({ taskId }).filter((r) => r.runtimeKind === "custom");
  assert.equal(newRefs.length, 1);
  assert.ok(newRefs[0].nativeSessionRef.startsWith("custom-ses-"));

  // ...and switching back to pi-like harness produces a second handoff
  // from execution records (AgentFabric-assisted, since the custom
  // harness cannot generate handoffs).
  const back = await h.runService.continueTask(taskId, { prompt: "switch back", runtimeId: mockRuntime.id });
  assert.equal(back.continuity, "handoff");
  assert.equal(back.handoff!.source, "agentfabric");
  assert.equal(back.handoff!.fromRuntimeKind, "custom");
  assert.ok(back.handoff!.content.originalTask);
  assert.ok(back.handoff!.content.remainingWork!.length >= 1);

  // The whole chain is traceable (spec v1 §8): the harness handoff from
  // run #1 mediated the switch to Custom; an assisted handoff mediated
  // the switch back. Runs record the exact continuity of each hop.
  const all = h.handoffs.list({ taskId });
  assert.equal(all.length, 2);
  const runs = h.runService.forTask(taskId);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((r) => r.continuity), ["new", "handoff", "handoff"]);
  assert.ok(runs[1].previousHandoffId);
  assert.ok(runs[2].previousHandoffId);
  assert.notEqual(runs[1].previousHandoffId, runs[2].previousHandoffId);
});

test("assisted handoff generator extracts files, tests and run result", async () => {
  const h = await freshHarness();
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const { taskId } = await startTaskOn(h, mockRuntime.id);
  const run = h.runService.forTask(taskId)[0];
  const content = buildAssistedHandoffContent({
    task: h.store.get("tasks", taskId) as any,
    run,
    events: h.runService.events(run.id),
    artifacts: h.store.list("artifacts").filter((a: any) => a.runId === run.id),
  });
  assert.match(content.originalTask!, /Payment Refund|implement the payment refund feature/);
  assert.match(content.previousRunResult!, /completed/);
  assert.ok(content.notesForNextAgent!.includes("no shared session"));
});

test("rendered handoff prompt instructs a new session explicitly", async () => {
  const h = await freshHarness();
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const customRuntime = await h.runtimes.create({ name: "Custom B", kind: "custom" });
  const { taskId } = await startTaskOn(h, mockRuntime.id);
  const result = await h.runService.continueTask(taskId, { prompt: "go", runtimeId: customRuntime.id });
  const prompt = renderHandoffPrompt(result.handoff!, "go");
  assert.match(prompt, /NO shared session/);
  assert.match(prompt, /# Your instruction/, "must end with the new instruction");
});

/* ------------------------------------------------------------------ */
/* Containers are disposable; state is not (spec v1 §2)                */
/* ------------------------------------------------------------------ */

test("task, run history, artifacts, logs, handoff and session refs outlive container records", async () => {
  const h = await freshHarness();
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const { taskId } = await startTaskOn(h, mockRuntime.id);
  const run = h.runService.forTask(taskId)[0];

  // Simulate the container record disappearing entirely.
  await h.store.update<Run>("runs", run.id, { containerId: undefined });
  assert.ok(h.store.get("tasks", taskId));
  assert.equal(h.runService.forTask(taskId).length, 1);
  assert.ok(h.runService.events(run.id).length > 5);
  assert.ok(h.runService.logs(run.id).length > 0);
  assert.ok(h.runtimeSessions.list({ taskId }).length === 1);
  assert.ok(h.handoffs.list({ taskId }).length >= 1);
});

/* ------------------------------------------------------------------ */
/* Runtime capabilities (spec v1 §17)                                  */
/* ------------------------------------------------------------------ */

test("effective capabilities merge adapter declaration with runtime overrides", async () => {
  const { effectiveCapabilities } = await import("./runtime.js");
  const caps = effectiveCapabilities(mockAdapter, undefined);
  assert.equal(caps.supportsNativeResume, true);
  assert.equal(caps.supportsHandoffGeneration, true);
  // A runtime record can narrow (override) the adapter's declaration.
  const overridden = effectiveCapabilities(customAdapter, {
    capabilities: { supportsNativeResume: false },
  } as any);
  assert.equal(overridden.supportsNativeResume, false);
  assert.equal(overridden.supportsStreamingEvents, true, "non-overridden fields fall back to the adapter");
});

/* ------------------------------------------------------------------ */
/* Per-run lifecycle overrides & keep-alive recovery wiring            */
/* ------------------------------------------------------------------ */

test("submit honors per-run lifecycle overrides (spec v1 §1)", async () => {
  const h = await freshHarness();
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const { run } = await h.runService.submit({
    prompt: "lifecycle override",
    runtimeId: mockRuntime.id,
    lifecycle: { mode: "keep-alive", idleTimeoutMs: 4321 },
  });
  await waitForRun(h.runService, run.id);
  const stored = h.runService.get(run.id)!;
  assert.equal(stored.lifecycle?.mode, "keep-alive");
  assert.equal(stored.lifecycle?.idleTimeoutMs, 4321);
});

test("keep-alive containers are re-armed from docker labels after a restart", async () => {
  const destroyed: string[] = [];
  const ops: ContainerOps = {
    destroy: async (id) => destroyed.push(id),
    listKeepAlive: async () => [
      {
        containerId: "ctr_live",
        name: "af-keep-rt_1",
        labels: {
          "agentfabric.keepalive": "true",
          "agentfabric.runtime": "rt_1",
          "agentfabric.workspace": "ws_1",
          "agentfabric.task": "task_1",
          "agentfabric.run": "run_1",
          "agentfabric.expires": new Date(Date.now() + 60_000).toISOString(),
        },
      },
      {
        containerId: "ctr_stale",
        name: "af-keep-rt_2",
        labels: {
          "agentfabric.keepalive": "true",
          "agentfabric.runtime": "rt_2",
          "agentfabric.run": "run_2",
          "agentfabric.expires": new Date(Date.now() - 30_000).toISOString(),
        },
      },
    ],
  };
  const h = await freshHarness();
  const runService = new RunService(h.store, new EventBus(), new RuntimeRegistry(), ops);
  await runService.recoverKeepAliveContainers();

  // Expired container destroyed, live container re-armed with its lease.
  assert.deepEqual(destroyed, ["ctr_stale"]);
  const kept = runService.keptContainers();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].containerId, "ctr_live");
  assert.equal(kept[0].runtimeId, "rt_1");
  assert.equal(kept[0].workspaceId, "ws_1");
});

test("continuation without any previous run still records an originating handoff", async () => {
  const h = await freshHarness();
  const mockRuntime = h.store.list("runtimes").find((r: any) => r.kind === "mock")!;
  const customRuntime = await h.runtimes.create({ name: "Custom B", kind: "custom" });
  // Create the task via the public API, wait for its run to settle, then
  // remove the runs to simulate a task that has no execution history.
  const { task } = await h.runService.submit({ prompt: "fresh", runtimeId: mockRuntime.id });
  const initialRuns = h.runService.forTask(task.id);
  for (const r of initialRuns) await waitForRun(h.runService, r.id);
  for (const r of initialRuns) await h.store.remove("runs", r.id);

  const result = await h.runService.continueTask(task.id, { prompt: "start over", runtimeId: customRuntime.id });
  assert.equal(result.continuity, "handoff");
  assert.equal(result.handoff!.fromRunId, "none");
  assert.match(result.handoff!.content.notesForNextAgent!, /No previous run exists/);
  const finished = await waitForRun(h.runService, result.run.id);
  assert.equal(finished.status, "completed");
});
