/**
 * Tests for the v2 spec (v2.md):
 * 1. The unified AgentFabric Session abstraction is gone (types, store,
 *    services) and legacy data is migrated away.
 * 2. Containerized native resume is a closed loop: structured harness
 *    output survives the container boundary, the opaque native state is
 *    mounted/preserved/reattached, and ephemeral containers can still
 *    native-resume (OpenCode and Pi).
 * 3. Handoff behavior across harnesses is unchanged.
 *
 * The containerized tests run against a fake `docker` CLI shim (see
 * fakes.ts) that parses `docker run …` invocations, records the argv,
 * writes a cidfile and executes the in-container command locally — no
 * real Docker needed. The fake harnesses model their real CLIs' wire
 * protocols and session stores, so native resume only succeeds when the
 * mounted state really contains the session (v3 §3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveCapabilities, type AgentRuntimeAdapter } from "./runtime.js";
import { Store } from "./store.js";
import { opencodeAdapter } from "../../runtimes/src/opencode.js";
import { piAdapter } from "../../runtimes/src/pi.js";
import { dockerCalls, freshHarness, makeFixtures, useBins, waitForRun } from "./testkit.js";
import type { Fixtures, Harness } from "./testkit.js";
import type { Run } from "./types.js";

/* ------------------------------------------------------------------ */
/* v2 §1–§5: unified Session model removal                             */
/* ------------------------------------------------------------------ */

test("legacy unified session data is dropped when the store loads (v2 §3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-v2-mig-"));
  writeFileSync(
    join(dir, "db.json"),
    JSON.stringify({
      providers: [],
      models: [],
      runtimes: [],
      workspaces: [],
      artifacts: [],
      secrets: [],
      profiles: [],
      handoffs: [],
      runtimeSessions: [],
      sessions: [{ id: "ses_1", status: "active", runIds: ["run_1"] }],
      tasks: [{ id: "task_1", title: "t", prompt: "p", sessionId: "ses_1", createdAt: "" }],
      runs: [
        {
          id: "run_1",
          taskId: "task_1",
          status: "completed",
          sessionId: "ses_1",
          artifactIds: [],
          eventCount: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      events: [{ id: "evt_1", runId: "run_1", sessionId: "ses_1", seq: 1, type: "log", timestamp: "", data: {} }],
      config: {},
    })
  );
  const store = await Store.open(dir);
  const snap = store.snapshot() as Record<string, any>;
  assert.equal(snap.sessions, undefined, "the sessions collection is gone");
  assert.ok(Array.isArray(snap.nativeStates), "the nativeStates collection exists");
  assert.equal(snap.tasks[0].sessionId, undefined, "tasks no longer carry a unified sessionId");
  assert.equal(snap.runs[0].sessionId, undefined, "runs no longer carry a unified sessionId");
  assert.equal(snap.events[0].sessionId, undefined, "events no longer carry a unified sessionId");
});

test("native state service creates, preserves, updates and deletes opaque state (v2 §13/§14)", async () => {
  const h = await freshHarness();
  const runtime = await h.runtimes.create({ name: "oc-c", kind: "opencode", containerized: true });

  const s1 = await h.nativeStates.ensureForRuntime(runtime, "/root/.local/share/opencode");
  const s2 = await h.nativeStates.ensureForRuntime(runtime, "/root/.local/share/opencode");
  assert.equal(s1.id, s2.id, "the same runtime maps to the same state directory");
  assert.ok(existsSync(s1.path), "the opaque directory exists on the host");
  assert.equal(h.nativeStates.list({ runtimeId: runtime.id }).length, 1);

  // Mount-path changes (e.g. runtime config update) reuse the directory.
  const s3 = await h.nativeStates.ensureForRuntime(runtime, "/root/.pi");
  assert.equal(s3.id, s1.id);
  assert.equal(s3.mountPath, "/root/.pi");

  await h.nativeStates.markUsed(s1.id, "run_x");
  assert.equal(h.nativeStates.get(s1.id)?.lastUsedRunId, "run_x");

  assert.equal(await h.nativeStates.remove(s1.id), true);
  assert.ok(!existsSync(s1.path), "delete removes the directory");
  assert.equal(h.nativeStates.get(s1.id), undefined);
});

/* ------------------------------------------------------------------ */
/* v2 §11: capabilities reflect the real execution backend             */
/* ------------------------------------------------------------------ */

test("effective capabilities reflect the containerized execution backend (v2 §11)", () => {
  const narrowed: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Narrowed Harness",
    capabilities: { supportsNativeSession: true, supportsNativeResume: true, supportsStreamingEvents: true },
    containerizedCapabilities: { supportsNativeSession: false, supportsNativeResume: false, supportsStreamingEvents: true },
    async run() {
      return {};
    },
  };
  const local = effectiveCapabilities(narrowed, { kind: "custom" } as any);
  assert.equal(local.supportsNativeResume, true, "local backend supports what the harness supports");

  const containerized = effectiveCapabilities(
    narrowed,
    { kind: "custom", containerized: true, image: "fake/harness:1" } as any
  );
  assert.equal(containerized.supportsNativeResume, false, "declared capability must be true under the backend in use");
  assert.equal(containerized.supportsNativeSession, false);
  assert.equal(containerized.supportsStreamingEvents, true);

  // v3 §16/§17: a containerized runtime without a usable image cannot
  // execute at all, so execution-dependent capabilities are narrowed.
  const noImage = effectiveCapabilities(narrowed, { kind: "custom", containerized: true } as any);
  assert.equal(noImage.supportsNativeResume, false, "no image → no native resume");
  assert.equal(noImage.supportsNativeSession, false, "no image → no native sessions");
  assert.equal(noImage.supportsStreamingEvents, false, "no image → no streaming");

  // An explicit runtime record override still wins over both layers.
  const overridden = effectiveCapabilities(
    narrowed,
    { kind: "custom", containerized: true, image: "fake/harness:1", capabilities: { supportsNativeResume: true } } as any
  );
  assert.equal(overridden.supportsNativeResume, true);

  // The real harness adapters now declare containerized parity — truthfully,
  // because the backend streams raw output to the adapter and mounts state.
  // (Pi needs an explicit image per v3 §10; OpenCode falls back to its
  // maintained official default image per v3 §11.)
  for (const adapter of [opencodeAdapter, piAdapter]) {
    const caps = effectiveCapabilities(
      adapter,
      { kind: adapter.kind, containerized: true, ...(adapter.kind === "pi" ? { image: "fake/pi:1" } : {}) } as any
    );
    assert.equal(caps.supportsNativeSession, true, `${adapter.kind} keeps native sessions behind docker`);
    assert.equal(caps.supportsNativeResume, true, `${adapter.kind} keeps native resume behind docker`);
    assert.equal(caps.supportsStreamingEvents, true, `${adapter.kind} keeps structured streaming behind docker`);
  }
  // Containerized pi without an image cannot run (v3 §10 plan A).
  const piNoImage = effectiveCapabilities(piAdapter, { kind: "pi", containerized: true } as any);
  assert.equal(piNoImage.supportsNativeResume, false);
  // Containerized opencode defaults to the maintained official image.
  const ocDefault = effectiveCapabilities(opencodeAdapter, { kind: "opencode", containerized: true } as any);
  assert.equal(ocDefault.supportsNativeResume, true);
});

/* ------------------------------------------------------------------ */
/* v2 §6/§8: local execution keeps the shared parser semantics         */
/* ------------------------------------------------------------------ */

test("local opencode captures the native session through the shared parser (v2 §8)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "local-ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const runtime = await h.runtimes.create({
      name: "oc-local",
      kind: "opencode",
      // Keep the fake harness's session store isolated from the real one.
      env: { XDG_DATA_HOME: join(fx.dir, "oc-local-xdg") },
    });

    const { task, run } = await h.runService.submit({
      prompt: "do local work",
      runtimeId: runtime.id,
      workspaceId: ws.id,
    });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.containerId, undefined, "local runs have no container");
    assert.ok(!("sessionId" in finished), "runs no longer reference a unified session");

    const ref = h.runtimeSessions.list({ taskId: task.id })[0];
    assert.ok(ref, "a native session reference is persisted");
    assert.ok(ref.nativeSessionRef.startsWith("ses_"), `opencode session ids are ses_-prefixed, got ${ref.nativeSessionRef}`);
    assert.equal(ref.executionBackend, "local");
    assert.equal(ref.nativeStateId, undefined, "local harness state lives in its own home — nothing to manage");

    const messages = h.runService.events(run.id).filter((e) => e.type === "agent.message");
    assert.ok(messages.length >= 1, "structured opencode output must be parsed, not logged as shell output");
    assert.ok(h.runService.events(run.id).some((e) => e.type === "runtime.session.created"));
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* v2 §9/§15: containerized OpenCode native resume closed loop         */
/* ------------------------------------------------------------------ */

test("containerized opencode native-resumes across destroyed ephemeral containers (v2 §9/§15)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "oc-ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const runtime = await h.runtimes.create({
      name: "oc-docker",
      kind: "opencode",
      containerized: true,
      image: "fake/opencode:1",
      config: { containerCommand: ["node", fx.fakeOpenCode] },
    });

    /* ---- Run #1: fresh ephemeral container ---- */
    const { task, run } = await h.runService.submit({
      prompt: "implement the refund feature",
      runtimeId: runtime.id,
      workspaceId: ws.id,
    });
    const first = await waitForRun(h.runService, run.id);
    assert.equal(first.status, "completed");
    assert.match(first.containerId ?? "", /^fakectr_/, "container id captured from the containerized backend");

    // Structured protocol survived the container boundary (v2 §7/§8).
    const events1 = h.runService.events(run.id);
    const types1 = events1.map((e) => e.type);
    assert.ok(types1.includes("runtime.session.created"));
    assert.ok(types1.includes("native.state.attached"));
    assert.ok(types1.includes("native.state.persisted"));
    assert.ok(types1.includes("container.destroyed"), "ephemeral container is disposed");
    assert.ok(
      events1.some((e) => e.type === "agent.message" && e.source === "opencode"),
      "containerized JSONL must reach the harness parser, not become shell logs"
    );

    // The native session reference is persisted with its state.
    const ref = h.runtimeSessions.list({ taskId: task.id })[0];
    const refId = ref.nativeSessionRef;
    assert.ok(refId.startsWith("ses_"), `opencode session ids are ses_-prefixed, got ${refId}`);
    assert.equal(ref.executionBackend, "docker");
    assert.ok(ref.nativeStateId, "the reference records the state it depends on");
    const state = h.nativeStates.get(ref.nativeStateId!)!;
    assert.equal(state.mountPath, "/root/.local/share/opencode");
    assert.ok(existsSync(state.path), "the harness state directory persists on the host");
    // The fake harness really persisted the session into the mounted
    // opaque state directory (v3 §3 — sessions survive on disk).
    assert.ok(existsSync(join(state.path, "storage", "session", `${refId}.json`)), "native session file exists in native state");
    assert.equal(state.lastUsedRunId, run.id);
    assert.equal(first.nativeStateId, state.id, "the run records the attached native state");

    // The container invocation mounted workspace + native state.
    const run1Call = dockerCalls(fx).find((c) => c.includes("fake/opencode:1"))!;
    assert.ok(run1Call.includes("--rm"), "ephemeral lifecycle");
    assert.ok(run1Call.includes(`${ws.path}:/workspace:rw`), "workspace mounted read-write");
    assert.ok(run1Call.includes(`${state.path}:/root/.local/share/opencode:rw`), "opaque native state mounted");
    assert.ok(!run1Call.includes("--session"), "the first run starts a fresh native session");

    /* ---- the ephemeral container is gone between runs ---- */
    await h.store.update<Run>("runs", run.id, { containerId: undefined });

    /* ---- Run #2: new ephemeral container, native resume ---- */
    const cont = await h.runService.continueTask(task.id, { prompt: "keep going on the refund" });
    assert.equal(cont.continuity, "resume");
    assert.equal(cont.runtimeSessionRef?.nativeSessionRef, refId);
    const second = await waitForRun(h.runService, cont.run.id);
    assert.equal(second.status, "completed");
    assert.match(second.containerId ?? "", /^fakectr_/);
    assert.notEqual(second.containerId, first.containerId, "a new disposable container is used");

    const types2 = h.runService.events(cont.run.id).map((e) => e.type);
    assert.ok(types2.includes("runtime.session.resumed"));
    assert.ok(types2.includes("native.state.attached"));
    assert.equal(second.nativeStateId, state.id, "run #2 reattached the exact native state (v2 §15)");
    assert.equal(h.nativeStates.get(state.id)?.lastUsedRunId, cont.run.id);

    // The resume really reached the harness with its own session ref.
    const ocCalls = dockerCalls(fx).filter((c) => c.includes("fake/opencode:1"));
    const run2Call = ocCalls[ocCalls.length - 1];
    const sessionIdx = run2Call.indexOf("--session");
    assert.notEqual(sessionIdx, -1, "resume passes the native session reference into the container");
    assert.equal(run2Call[sessionIdx + 1], refId);
    assert.ok(run2Call.includes(`${state.path}:/root/.local/share/opencode:rw`), "native state reattached");
    const resumedMessages = h.runService
      .events(cont.run.id)
      .filter((e) => e.type === "agent.message")
      .map((e) => String(e.data?.content ?? ""));
    assert.ok(
      resumedMessages.some((c) => c.includes(`opencode resumed session ${refId}`)),
      `the harness must confirm the resumed session, got: ${JSON.stringify(resumedMessages)}`
    );
    assert.ok(
      resumedMessages.some((c) => c.includes("implement the refund feature")),
      "the resumed harness continues Run #1's context"
    );
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* v2 §10: containerized Pi keeps the same native-session semantics    */
/* ------------------------------------------------------------------ */

test("containerized pi native-resumes with the same semantics as local (v2 §10)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "pi-ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const runtime = await h.runtimes.create({
      name: "pi-docker",
      kind: "pi",
      containerized: true,
      image: "fake/pi:1",
      config: { containerCommand: ["node", fx.fakePi] },
    });

    const { task, run } = await h.runService.submit({
      prompt: "start the pi task",
      runtimeId: runtime.id,
      workspaceId: ws.id,
    });
    const first = await waitForRun(h.runService, run.id);
    assert.equal(first.status, "completed");
    assert.match(first.containerId ?? "", /^fakectr_/);

    const ref = h.runtimeSessions.list({ taskId: task.id })[0];
    const refId = ref.nativeSessionRef;
    assert.equal(ref.executionBackend, "docker");
    const state = h.nativeStates.get(ref.nativeStateId!)!;
    assert.equal(state.mountPath, "/root/.pi");
    assert.ok(existsSync(state.path));

    const piCalls1 = dockerCalls(fx).filter((c) => c.includes("fake/pi:1"));
    // v3 §1/§2: a fresh pi run uses *normal* session mode — never
    // --no-session — and therefore persists a resumable native session.
    assert.ok(!piCalls1[piCalls1.length - 1].includes("--no-session"), "fresh pi runs persist a native session");
    assert.ok(
      existsSync(join(state.path, "agent", "sessions")),
      "pi wrote its session store into the mounted native state"
    );

    // Containerized structured output is parsed by the same mapper.
    const messages1 = h.runService
      .events(run.id)
      .filter((e) => e.type === "agent.message")
      .map((e) => String(e.data?.content ?? ""));
    assert.ok(messages1.some((c) => c.includes("pi fresh session")));

    // Container destroyed; resume on a new ephemeral one.
    await h.store.update<Run>("runs", run.id, { containerId: undefined });
    const cont = await h.runService.continueTask(task.id, { prompt: "continue the pi task" });
    assert.equal(cont.continuity, "resume");
    const second = await waitForRun(h.runService, cont.run.id);
    assert.equal(second.status, "completed");
    assert.equal(second.nativeStateId, state.id);

    const piCalls2 = dockerCalls(fx).filter((c) => c.includes("fake/pi:1"));
    const run2Call = piCalls2[piCalls2.length - 1];
    const sessionIdx = run2Call.indexOf("--session");
    assert.notEqual(sessionIdx, -1);
    assert.equal(run2Call[sessionIdx + 1], refId);
    assert.ok(!run2Call.includes("--no-session"), "resume replaces the no-session default");

    const messages2 = h.runService
      .events(cont.run.id)
      .filter((e) => e.type === "agent.message")
      .map((e) => String(e.data?.content ?? ""));
    assert.ok(messages2.some((c) => c.includes(`pi resumed session ${refId}`)));
    assert.ok(messages2.some((c) => c.includes("start the pi task")), "the resumed harness continues Run #1's context");
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* v2 §16: cross-harness handoff behavior is unchanged                 */
/* ------------------------------------------------------------------ */

test("cross-harness switch still handoffs, never migrates sessions (v2 §16)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "hoff-ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const piRuntime = await h.runtimes.create({
      name: "pi-h",
      kind: "pi",
      containerized: true,
      image: "fake/pi:1",
      config: { containerCommand: ["node", fx.fakePi] },
    });
    const ocRuntime = await h.runtimes.create({
      name: "oc-h",
      kind: "opencode",
      containerized: true,
      image: "fake/oc:1",
      config: { containerCommand: ["node", fx.fakeOpenCode] },
    });

    const { task, run } = await h.runService.submit({
      prompt: "start the feature on pi",
      runtimeId: piRuntime.id,
      workspaceId: ws.id,
    });
    await waitForRun(h.runService, run.id);

    const options = h.runService.continueOptions(task.id, ocRuntime.id);
    assert.equal(options.resumeAvailable, false, "different harness can never native-resume");
    assert.equal(options.suggestedMode, "handoff");

    const switched = await h.runService.continueTask(task.id, {
      prompt: "continue on opencode",
      runtimeId: ocRuntime.id,
    });
    assert.equal(switched.continuity, "handoff");
    assert.ok(switched.handoff);
    const secondRun = h.runService.get(switched.run.id)!;
    assert.ok(secondRun.previousHandoffId);
    assert.equal(secondRun.runtimeSessionRefId, undefined, "handoff runs start without a previous native session");
    assert.match(secondRun.inputInstruction!, /# Handoff from/);

    const finished = await waitForRun(h.runService, switched.run.id);
    assert.equal(finished.status, "completed");

    // The new harness created its own new native session; the pi session
    // was never converted or passed along.
    const ocRef = h.runtimeSessions.list({ taskId: task.id }).find((r) => r.runtimeKind === "opencode");
    assert.ok(ocRef, "the new harness created its own session");
    assert.ok(ocRef!.nativeSessionRef.startsWith("ses_"), `opencode session ids are ses_-prefixed, got ${ocRef!.nativeSessionRef}`);
    const ocCalls = dockerCalls(fx).filter((c) => c.includes("fake/oc:1"));
    assert.ok(ocCalls.length >= 1);
    assert.ok(!ocCalls[ocCalls.length - 1].includes("--session"), "the old harness session must not leak into the new one");
  } finally {
    restore();
  }
});
