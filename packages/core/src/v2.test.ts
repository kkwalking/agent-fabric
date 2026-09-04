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
 * The containerized tests run against a fake `docker` CLI shim that
 * parses `docker run …` invocations, records the argv, writes a cidfile
 * and executes the in-container command locally — no real Docker needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry, effectiveCapabilities, type AgentRuntimeAdapter } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import { NativeStateService, RuntimeService, RuntimeSessionService, WorkspaceService, seedDefaults } from "./services.js";
import { opencodeAdapter } from "../../runtimes/src/opencode.js";
import { piAdapter } from "../../runtimes/src/pi.js";
import { mockAdapter } from "../../runtimes/src/mock.js";
import type { Run } from "./types.js";

/* ------------------------------------------------------------------ */
/* Fake harness binaries + fake docker CLI                             */
/* ------------------------------------------------------------------ */

const FAKE_OPENCODE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const i = args.indexOf("--session");
const resumed = i !== -1 ? args[i + 1] : undefined;
const sessionID = resumed ?? "ses_oc_1";
console.log(JSON.stringify({ type: "message.info", sessionID }));
console.log(JSON.stringify({
  type: "message",
  sessionID,
  message: { role: "assistant", text: resumed ? \`opencode resumed session \${resumed}\` : "opencode fresh session" },
}));
`;

const FAKE_PI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const i = args.indexOf("--session");
const resumed = i !== -1 ? args[i + 1] : undefined;
const id = resumed ?? "ses_pi_1";
console.log(JSON.stringify({ type: "session", id }));
console.log(JSON.stringify({
  type: "message",
  role: "assistant",
  text: resumed ? \`pi resumed session \${resumed}\` : "pi fresh session",
}));
`;

const FAKE_DOCKER = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");

const VALUE_FLAGS = new Set([
  "--name", "--cidfile", "-w", "--workdir", "-e", "--env", "-v", "--volume",
  "--cpus", "--memory", "--pids-limit", "--network", "--label", "--entrypoint", "--user", "-u",
]);

function passthrough(command, extraEnv, cidfile) {
  const cid = "fakectr_" + Math.random().toString(36).slice(2, 10);
  if (cidfile) { try { writeFileSync(cidfile, cid); } catch {} }
  const child = spawn(command[0], command.slice(1), {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (err) => { console.error(String(err)); process.exit(127); });
  child.on("close", (code) => process.exit(code ?? 0));
}

const sub = args[0];
if (sub === "run" || sub === "exec") {
  const extraEnv = {};
  let cidfile;
  let firstPositional;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { firstPositional = i + 1; break; }
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) {
        const v = args[++i];
        if (a === "-e" || a === "--env") {
          const idx = v.indexOf("=");
          extraEnv[v.slice(0, idx)] = v.slice(idx + 1);
        } else if (a === "--cidfile") {
          cidfile = v;
        }
      }
      continue;
    }
    firstPositional = i;
    break;
  }
  // run: <image> <command…>   exec: <container> <command…>
  const command = args.slice((firstPositional ?? args.length - 1) + 1);
  passthrough(command, extraEnv, cidfile);
} else if (sub === "inspect") {
  console.log("true");
}
// ps / rm / start: succeed silently.
`;

interface Fixtures {
  dir: string;
  fakeOpenCode: string;
  fakePi: string;
  fakeDocker: string;
  dockerLog: string;
}

let fixtures: Fixtures | undefined;

function writeExecutable(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  chmodSync(p, 0o755);
  return p;
}

function makeFixtures(): Fixtures {
  if (!fixtures) {
    const dir = mkdtempSync(join(tmpdir(), "af-v2-fixtures-"));
    fixtures = {
      dir,
      fakeOpenCode: writeExecutable(dir, "fake-opencode.mjs", FAKE_OPENCODE),
      fakePi: writeExecutable(dir, "fake-pi.mjs", FAKE_PI),
      fakeDocker: writeExecutable(dir, "fake-docker.mjs", FAKE_DOCKER),
      dockerLog: join(dir, "docker-calls.log"),
    };
    writeFileSync(fixtures.dockerLog, "");
  }
  return fixtures;
}

/** Point the adapters at the fakes and reset the docker call log. */
function useBins(fx: Fixtures): () => void {
  const saved = {
    AGENTFABRIC_OPENCODE_BIN: process.env.AGENTFABRIC_OPENCODE_BIN,
    AGENTFABRIC_PI_BIN: process.env.AGENTFABRIC_PI_BIN,
    AGENTFABRIC_DOCKER_BIN: process.env.AGENTFABRIC_DOCKER_BIN,
    FAKE_DOCKER_LOG: process.env.FAKE_DOCKER_LOG,
  };
  process.env.AGENTFABRIC_OPENCODE_BIN = fx.fakeOpenCode;
  process.env.AGENTFABRIC_PI_BIN = fx.fakePi;
  process.env.AGENTFABRIC_DOCKER_BIN = fx.fakeDocker;
  process.env.FAKE_DOCKER_LOG = fx.dockerLog;
  writeFileSync(fx.dockerLog, "");
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function dockerCalls(fx: Fixtures): string[][] {
  return readFileSync(fx.dockerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface Harness {
  store: Store;
  runService: RunService;
  runtimes: RuntimeService;
  workspaces: WorkspaceService;
  runtimeSessions: RuntimeSessionService;
  nativeStates: NativeStateService;
}

async function freshHarness(): Promise<Harness> {
  const store = await Store.open(mkdtempSync(join(tmpdir(), "af-v2-")));
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  registry.register(opencodeAdapter);
  registry.register(piAdapter);
  await seedDefaults(store);
  const runService = new RunService(store, bus, registry);
  return {
    store,
    runService,
    runtimes: new RuntimeService(store),
    workspaces: new WorkspaceService(store),
    runtimeSessions: new RuntimeSessionService(store),
    nativeStates: new NativeStateService(store),
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

  const containerized = effectiveCapabilities(narrowed, { kind: "custom", containerized: true } as any);
  assert.equal(containerized.supportsNativeResume, false, "declared capability must be true under the backend in use");
  assert.equal(containerized.supportsNativeSession, false);
  assert.equal(containerized.supportsStreamingEvents, true);

  // An explicit runtime record override still wins over both layers.
  const overridden = effectiveCapabilities(
    narrowed,
    { kind: "custom", containerized: true, capabilities: { supportsNativeResume: true } } as any
  );
  assert.equal(overridden.supportsNativeResume, true);

  // The real harness adapters now declare containerized parity — truthfully,
  // because the backend streams raw output to the adapter and mounts state.
  for (const adapter of [opencodeAdapter, piAdapter]) {
    const caps = effectiveCapabilities(adapter, { kind: adapter.kind, containerized: true } as any);
    assert.equal(caps.supportsNativeSession, true, `${adapter.kind} keeps native sessions behind docker`);
    assert.equal(caps.supportsNativeResume, true, `${adapter.kind} keeps native resume behind docker`);
    assert.equal(caps.supportsStreamingEvents, true, `${adapter.kind} keeps structured streaming behind docker`);
  }
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
    const runtime = await h.runtimes.create({ name: "oc-local", kind: "opencode" });

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
    assert.equal(ref.nativeSessionRef, "ses_oc_1");
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
    assert.equal(ref.nativeSessionRef, "ses_oc_1");
    assert.equal(ref.executionBackend, "docker");
    assert.ok(ref.nativeStateId, "the reference records the state it depends on");
    const state = h.nativeStates.get(ref.nativeStateId!)!;
    assert.equal(state.mountPath, "/root/.local/share/opencode");
    assert.ok(existsSync(state.path), "the harness state directory persists on the host");
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
    assert.equal(cont.runtimeSessionRef?.nativeSessionRef, "ses_oc_1");
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
    assert.equal(run2Call[sessionIdx + 1], "ses_oc_1");
    assert.ok(run2Call.includes(`${state.path}:/root/.local/share/opencode:rw`), "native state reattached");
    const resumedMessages = h.runService
      .events(cont.run.id)
      .filter((e) => e.type === "agent.message")
      .map((e) => String(e.data?.content ?? ""));
    assert.ok(
      resumedMessages.some((c) => c.includes("resumed session ses_oc_1")),
      `the harness must confirm the resumed session, got: ${JSON.stringify(resumedMessages)}`
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
    assert.equal(ref.nativeSessionRef, "ses_pi_1");
    assert.equal(ref.executionBackend, "docker");
    const state = h.nativeStates.get(ref.nativeStateId!)!;
    assert.equal(state.mountPath, "/root/.pi");
    assert.ok(existsSync(state.path));

    const piCalls1 = dockerCalls(fx).filter((c) => c.includes("fake/pi:1"));
    assert.ok(piCalls1[piCalls1.length - 1].includes("--no-session"), "fresh pi runs opt out of a session");

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
    assert.equal(run2Call[sessionIdx + 1], "ses_pi_1");
    assert.ok(!run2Call.includes("--no-session"), "resume replaces the no-session default");

    const messages2 = h.runService
      .events(cont.run.id)
      .filter((e) => e.type === "agent.message")
      .map((e) => String(e.data?.content ?? ""));
    assert.ok(messages2.some((c) => c.includes("pi resumed session ses_pi_1")));
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
    assert.ok(ocRef!.nativeSessionRef.startsWith("ses_oc_"));
    const ocCalls = dockerCalls(fx).filter((c) => c.includes("fake/oc:1"));
    assert.ok(ocCalls.length >= 1);
    assert.ok(!ocCalls[ocCalls.length - 1].includes("--session"), "the old harness session must not leak into the new one");
  } finally {
    restore();
  }
});
