/**
 * Tests for the v3 spec (v3.md): real Pi / OpenCode protocol adaptation
 * and containerized native-resume correctness.
 *
 * - §1/§2: pi fresh runs persist native sessions (never --no-session).
 * - §3: the fake harnesses only resume sessions that really exist in
 *   the mounted native state — resume cannot be faked into success.
 * - §4–§6: event mapping follows the real wire protocols (pi
 *   snake_case agent/turn/message/tool_execution events; opencode
 *   run --format json step_start/text/tool_use/step_finish/error).
 * - §7: local and docker share one parser (same event sets).
 * - §8/§9: real harness usage feeds Run Usage (tokens + cost).
 * - §10/§11: container image policy (pi refuses without an image;
 *   opencode defaults to the maintained official image).
 * - §13–§15: native resume requires same harness + same workspace +
 *   valid ref + existing native state + capability.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerCalls, freshHarness, makeFixtures, useBins, waitForRun, type Harness } from "./testkit.js";
import { mapOpenCodeEvent, extractOpenCodeSessionRef, parseOpenCodeUsage } from "../../runtimes/src/opencode.js";
import {
  mapPiEvent,
  extractPiSessionRef,
  parsePiUsage,
  PI_IMAGE_CONTRACT_HINT,
} from "../../runtimes/src/pi.js";
import type { Run, RunEvent } from "./types.js";

/* ------------------------------------------------------------------ */
/* §4/§5: pi event mapping follows the real wire protocol              */
/* ------------------------------------------------------------------ */

const seq = (() => {
  let n = 0;
  return () => ++n;
})();

function mapPi(raw: string): RunEvent | null {
  return mapPiEvent(raw, "run_test", seq);
}

test("pi session header maps to run progress and yields the session id (v3 §4)", () => {
  const evt = mapPi('{"type":"session","version":3,"id":"0192abc","timestamp":"2026-09-05T00:00:00Z","cwd":"/workspace"}');
  assert.ok(evt);
  assert.equal(evt.type, "run.progress");
  assert.equal(evt.data.sessionId, "0192abc");
  assert.equal(extractPiSessionRef('{"type":"session","version":3,"id":"0192abc"}'), "0192abc");
  assert.equal(extractPiSessionRef('{"type":"message_end","message":{}}'), undefined);
  assert.equal(extractPiSessionRef("not json"), undefined);
});

test("pi agent/turn lifecycle events map to run progress (v3 §4)", () => {
  for (const raw of ['{"type":"agent_start"}', '{"type":"agent_end","messages":[{},{}]}', '{"type":"turn_start"}', '{"type":"turn_end","toolResults":[{}]}']) {
    const evt = mapPi(raw);
    assert.ok(evt, `${raw} must be recognized`);
    assert.equal(evt.type, "run.progress");
  }
  assert.equal(mapPi('{"type":"agent_end","messages":[{},{}]}')?.data.phase, "agent_end");
  assert.equal(mapPi('{"type":"agent_end","messages":[{},{}]}')?.data.messageCount, 2);
});

test("pi message events map to agent messages, thinking and errors (v3 §4/§5)", () => {
  // text deltas stream through message_update — recognized, not persisted
  assert.equal(
    mapPi('{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"He"}}'),
    null
  );
  // stream errors surface as runtime errors
  const streamErr = mapPi('{"type":"message_update","assistantMessageEvent":{"type":"error","error":"boom"}}');
  assert.equal(streamErr?.type, "runtime.error");
  // final assistant message → agent.message with the joined text
  const msg = mapPi(
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"Hello"},{"type":"text","text":" world"}],"model":"claude-sonnet-4-5","usage":{"input":1,"output":2},"stopReason":"stop"}}'
  );
  assert.equal(msg?.type, "agent.message");
  assert.equal(msg?.data.content, "Hello world");
  assert.equal(msg?.data.model, "claude-sonnet-4-5");
  assert.equal(msg?.data.thinking, "plan");
  // thinking-only message → agent.thinking
  const think = mapPi(
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}'
  );
  assert.equal(think?.type, "agent.thinking");
  // failed message → runtime error
  const failed = mapPi(
    '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"rate limited"}}'
  );
  assert.equal(failed?.type, "runtime.error");
});

test("pi tool execution events map to started/progress/completed (v3 §4/§5)", () => {
  const started = mapPi('{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}');
  assert.equal(started?.type, "tool.started");
  assert.equal(started?.data.tool, "bash");
  assert.equal(started?.data.toolCallId, "c1");

  const progress = mapPi('{"type":"tool_execution_update","toolCallId":"c1","toolName":"bash","partialResult":"READ"}');
  assert.equal(progress?.type, "tool.progress");
  assert.equal(progress?.data.partialResult, "READ");

  const done = mapPi('{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"output":"x"},"isError":false}');
  assert.equal(done?.type, "tool.completed");
  assert.equal(done?.data.isError, false);
  const failed = mapPi('{"type":"tool_execution_end","toolCallId":"c2","toolName":"bash","result":"nope","isError":true}');
  assert.equal(failed?.type, "tool.completed");
  assert.equal(failed?.level, "warn");
});

test("unrecognized pi events are preserved as raw debug events (v3 §5)", () => {
  const raw = '{"type":"compaction_start","reason":"threshold"}';
  const evt = mapPi(raw);
  assert.equal(evt?.type, "log");
  assert.equal(evt?.level, "debug");
  assert.equal(evt?.data.line, raw);
});

test("pi usage parsing reads authoritative message_end usage (v3 §8)", () => {
  const usage = parsePiUsage(
    '{"type":"message_end","message":{"role":"assistant","model":"m1","usage":{"input":525,"output":64,"cacheRead":1200,"cacheWrite":80,"reasoning":12,"totalTokens":1869,"cost":{"input":0.0012,"output":0.0007,"cacheRead":0.0001,"cacheWrite":0.0001,"total":0.0021}}}}'
  );
  assert.deepEqual(usage, {
    inputTokens: 525,
    outputTokens: 64,
    cachedTokens: 1280,
    reasoningTokens: 12,
    modelRequests: 1,
    estimatedCost: 0.0021,
    byModel: { m1: { inputTokens: 525, outputTokens: 64, cachedTokens: 1280, reasoningTokens: 12, requests: 1, cost: 0.0021 } },
  });
  // Cumulative message_update usage must NOT be counted (v3 §8).
  assert.equal(parsePiUsage('{"type":"message_update","usage":{"input":999}}'), undefined);
  assert.equal(parsePiUsage('{"type":"message_end","message":{"role":"user"}}'), undefined);
  assert.equal(parsePiUsage("not json"), undefined);
});

/* ------------------------------------------------------------------ */
/* §6: OpenCode event mapping follows run --format json                 */
/* ------------------------------------------------------------------ */

function mapOc(raw: string): RunEvent | null {
  return mapOpenCodeEvent(raw, "run_test", seq);
}

test("opencode native events map to AgentFabric events (v3 §6)", () => {
  const stepStart = mapOc('{"type":"step_start","timestamp":1757070000000,"sessionID":"ses_1","part":{"type":"step-start"}}');
  assert.equal(stepStart?.type, "run.progress");

  const text = mapOc('{"type":"text","timestamp":1757070000000,"sessionID":"ses_1","part":{"type":"text","text":"Here is the answer"}}');
  assert.equal(text?.type, "agent.message");
  assert.equal(text?.data.content, "Here is the answer");

  const reasoning = mapOc('{"type":"reasoning","timestamp":1,"sessionID":"ses_1","part":{"type":"reasoning","text":"hmm"}}');
  assert.equal(reasoning?.type, "agent.thinking");

  const tool = mapOc(
    '{"type":"tool_use","timestamp":1,"sessionID":"ses_1","part":{"type":"tool","callID":"call_1","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"README.md","title":"Bash","metadata":{"exit":0}}}}'
  );
  assert.equal(tool?.type, "tool.completed");
  assert.equal(tool?.data.tool, "bash");
  assert.equal(tool?.data.output, "README.md");
  assert.equal(tool?.data.status, "completed");

  const toolErr = mapOc(
    '{"type":"tool_use","timestamp":1,"sessionID":"ses_1","part":{"type":"tool","tool":"bash","state":{"status":"error","input":{},"error":"exit 1"}}}'
  );
  assert.equal(toolErr?.type, "tool.completed");
  assert.equal(toolErr?.data.error, "exit 1");
  assert.equal(toolErr?.level, "warn");

  const finish = mapOc('{"type":"step_finish","timestamp":1,"sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","cost":0.01}}');
  assert.equal(finish?.type, "run.progress");
  assert.equal(finish?.data.reason, "stop");

  const err = mapOc('{"type":"error","timestamp":1,"sessionID":"ses_1","error":{"name":"APIError","data":{"message":"429"}}}');
  assert.equal(err?.type, "runtime.error");
  assert.equal(err?.data.error, "429");

  // Legacy AgentFabric-style names (message.*, tool.started, shell.*) are
  // NOT opencode events — they must not be special-cased (v3 §6).
  const legacy = mapOc('{"type":"tool.started","tool":{"name":"bash"}}');
  assert.equal(legacy?.type, "log");
  assert.equal(legacy?.level, "debug");

  assert.equal(extractOpenCodeSessionRef('{"type":"text","sessionID":"ses_abc","part":{}}'), "ses_abc");
  assert.equal(extractOpenCodeSessionRef('{"type":"text","part":{}}'), undefined);
});

test("opencode usage parsing reads step_finish tokens and cost (v3 §8)", () => {
  const usage = parseOpenCodeUsage(
    '{"type":"step_finish","timestamp":1,"sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","cost":0.0031,"tokens":{"total":2450,"input":1200,"output":300,"reasoning":50,"cache":{"read":800,"write":100}}}}'
  );
  assert.deepEqual(usage, {
    inputTokens: 1200,
    outputTokens: 300,
    cachedTokens: 900,
    reasoningTokens: 50,
    modelRequests: 1,
    estimatedCost: 0.0031,
  });
  assert.equal(parseOpenCodeUsage('{"type":"text","part":{}}'), undefined);
  assert.equal(parseOpenCodeUsage('{"type":"step_finish","part":{"type":"step-finish"}}'), undefined);
});

/* ------------------------------------------------------------------ */
/* §1/§2/§8/§23: full-loop pi — persisted sessions + real usage        */
/* ------------------------------------------------------------------ */

test("pi local run persists a native session, resumes it, and records real usage (v3 §1/§2/§8/§23)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const agentDir = join(fx.dir, "pi-local-agent");
    const ws = await h.workspaces.create({ name: "pi-ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const runtime = await h.runtimes.create({
      name: "pi-local",
      kind: "pi",
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    /* ---- Run #1: fresh session in normal mode ---- */
    const { task, run } = await h.runService.submit({
      prompt: "remember the secret word BANANA-7",
      runtimeId: runtime.id,
      workspaceId: ws.id,
    });
    const first = await waitForRun(h.runService, run.id);
    assert.equal(first.status, "completed");

    // The native session really exists in the harness's own store.
    const sessionsDir = join(agentDir, "sessions");
    assert.ok(existsSync(sessionsDir), "pi persisted its session store");
    const ref = h.runtimeSessions.list({ taskId: task.id })[0];
    assert.ok(ref);
    assert.ok(existsSync(join(sessionsDir, ...readdirSync(sessionsDir), `${ref.nativeSessionRef}.jsonl`)));

    // Real usage landed in the Run (two assistant messages → 2 requests).
    assert.equal(first.usage?.inputTokens, 525 + 1100);
    assert.equal(first.usage?.outputTokens, 64 + 96);
    assert.equal(first.usage?.cachedTokens, 1280 + 800);
    assert.equal(first.usage?.reasoningTokens, 32);
    assert.equal(first.usage?.modelRequests, 2);
    assert.ok(Math.abs((first.usage?.estimatedCost ?? 0) - 0.0055) < 1e-9, `cost ${first.usage?.estimatedCost}`);
    assert.equal(first.usage?.byModel?.["fake-pi-model"]?.requests, 2);

    // Structured events were produced (v3 §5), including usage.updated.
    const types = h.runService.events(run.id).map((e) => e.type);
    for (const expected of ["agent.message", "tool.started", "tool.progress", "tool.completed", "run.progress", "usage.updated"]) {
      assert.ok(types.includes(expected as never), `pi must produce ${expected}, got: ${types.join(",")}`);
    }
    const usageEvents = h.runService.events(run.id).filter((e) => e.type === "usage.updated");
    assert.equal(usageEvents.length, 2, "one usage event per model request");

    /* ---- Run #2: native resume on the same harness + workspace ---- */
    const cont = await h.runService.continueTask(task.id, { prompt: "what was the secret word?" });
    assert.equal(cont.continuity, "resume");
    const second = await waitForRun(h.runService, cont.run.id);
    assert.equal(second.status, "completed");
    const messages = h.runService
      .events(cont.run.id)
      .filter((e) => e.type === "agent.message")
      .map((e) => String(e.data?.content ?? ""));
    assert.ok(messages.some((c) => c.includes("pi resumed session " + ref.nativeSessionRef)));
    assert.ok(messages.some((c) => c.includes("remember the secret word BANANA-7")), "context from Run #1 continues");
  } finally {
    restore();
  }
});

test("opencode local run persists a native session, resumes it, and records real usage (v3 §8/§23)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const xdg = join(fx.dir, "oc-local-xdg");
    const ws = await h.workspaces.create({ name: "oc-ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const runtime = await h.runtimes.create({
      name: "oc-local",
      kind: "opencode",
      env: { XDG_DATA_HOME: xdg },
    });

    const { task, run } = await h.runService.submit({
      prompt: "remember the code word MANGO-3",
      runtimeId: runtime.id,
      workspaceId: ws.id,
    });
    const first = await waitForRun(h.runService, run.id);
    assert.equal(first.status, "completed");

    const ref = h.runtimeSessions.list({ taskId: task.id })[0];
    assert.ok(ref);
    assert.ok(existsSync(join(xdg, "opencode", "storage", "session", `${ref.nativeSessionRef}.json`)));

    // step_finish tokens/cost feed Run Usage (one step → 1 request).
    assert.equal(first.usage?.inputTokens, 1200);
    assert.equal(first.usage?.outputTokens, 300);
    assert.equal(first.usage?.cachedTokens, 900);
    assert.equal(first.usage?.reasoningTokens, 50);
    assert.equal(first.usage?.modelRequests, 1);
    assert.ok(Math.abs((first.usage?.estimatedCost ?? 0) - 0.0031) < 1e-9);

    const types = h.runService.events(run.id).map((e) => e.type);
    for (const expected of ["agent.message", "tool.completed", "run.progress", "usage.updated"]) {
      assert.ok(types.includes(expected as never), `opencode must produce ${expected}, got: ${types.join(",")}`);
    }

    const cont = await h.runService.continueTask(task.id, { prompt: "what was the code word?" });
    assert.equal(cont.continuity, "resume");
    const second = await waitForRun(h.runService, cont.run.id);
    assert.equal(second.status, "completed");
    const messages = h.runService
      .events(cont.run.id)
      .filter((e) => e.type === "agent.message")
      .map((e) => String(e.data?.content ?? ""));
    assert.ok(messages.some((c) => c.includes(`opencode resumed session ${ref.nativeSessionRef}`)));
    assert.ok(messages.some((c) => c.includes("remember the code word MANGO-3")));
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §3: resume correctness follows real harness state                   */
/* ------------------------------------------------------------------ */

async function piDockerHarness(fx: ReturnType<typeof makeFixtures>): Promise<{ h: Harness; runtimeId: string; wsId: string }> {
  const h = await freshHarness();
  const ws = await h.workspaces.create({ name: "pi-ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
  const runtime = await h.runtimes.create({
    name: "pi-docker",
    kind: "pi",
    containerized: true,
    image: "fake/pi:1",
    config: { containerCommand: ["node", fx.fakePi] },
  });
  return { h, runtimeId: runtime.id, wsId: ws.id };
}

test("pi resume fails when the native state lost the session — success cannot be faked (v3 §3)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const { h, runtimeId, wsId } = await piDockerHarness(fx);
    const { task, run } = await h.runService.submit({
      prompt: "start the work",
      runtimeId,
      workspaceId: wsId,
    });
    const first = await waitForRun(h.runService, run.id);
    assert.equal(first.status, "completed");
    const ref = h.runtimeSessions.list({ taskId: task.id })[0];
    const state = h.nativeStates.get(ref.nativeStateId!)!;

    // Wipe the session files but keep the state directory itself, so the
    // resume gate still allows the attempt — the harness must then fail
    // for real because its store no longer has the session.
    rmSync(join(state.path, "agent"), { recursive: true, force: true });
    assert.ok(existsSync(state.path));

    const cont = await h.runService.continueTask(task.id, { prompt: "continue the work" });
    assert.equal(cont.continuity, "resume");
    const second = await waitForRun(h.runService, cont.run.id);
    assert.equal(second.status, "failed");
    // The harness itself rejected the resume — its stderr is captured in
    // the run logs (success cannot be faked, v3 §3).
    const logLines = h.runService.logs(cont.run.id).join("\n");
    assert.match(logLines, /Session not found/);
    assert.ok(h.runService.events(cont.run.id).some((e) => e.type === "run.failed"));
  } finally {
    restore();
  }
});

test("native resume is unavailable when the native state directory vanished (v3 §13)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const { h, runtimeId, wsId } = await piDockerHarness(fx);
    const { task, run } = await h.runService.submit({ prompt: "p1", runtimeId, workspaceId: wsId });
    await waitForRun(h.runService, run.id);
    const ref = h.runtimeSessions.list({ taskId: task.id })[0];
    rmSync(h.nativeStates.get(ref.nativeStateId!)!.path, { recursive: true, force: true });

    const options = h.runService.continueOptions(task.id);
    assert.equal(options.resumeAvailable, false, "missing native state blocks resume");
    assert.equal(options.suggestedMode, "handoff");
    assert.match(options.explanation, /no runtime native state/);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §13/§14/§23: workspace participates in resume compatibility         */
/* ------------------------------------------------------------------ */

test("a different workspace never auto-resumes the old native session (v3 §14/§23)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const { h, runtimeId, wsId } = await piDockerHarness(fx);
    const { task, run } = await h.runService.submit({ prompt: "work in workspace A", runtimeId, workspaceId: wsId });
    await waitForRun(h.runService, run.id);

    // Same harness, DIFFERENT workspace → must not resume session X.
    const wsB = await h.workspaces.create({ name: "ws-b", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const options = h.runService.continueOptions(task.id);
    assert.equal(options.resumeAvailable, true, "same workspace still resumes");

    const switched = await h.runService.continueTask(task.id, {
      prompt: "continue in workspace B",
      workspaceId: wsB.id,
    });
    assert.equal(switched.continuity, "handoff", "different workspace → handoff, not resume");
    assert.match(switched.explanation, /workspace changed/);

    // The old session ref never reached the new run's harness command.
    const calls = dockerCalls(fx).filter((c) => c.includes("fake/pi:1"));
    const lastCall = calls[calls.length - 1];
    assert.ok(!lastCall.includes("--session"), "workspace B run starts a fresh native session");

    // Same workspace again → resume is chosen.
    const again = await h.runService.continueTask(task.id, { prompt: "continue in workspace A" });
    assert.equal(again.continuity, "resume");
    const finished = await waitForRun(h.runService, again.run.id);
    assert.equal(finished.status, "completed");
  } finally {
    restore();
  }
});

test("a local session cannot be resumed behind docker and vice versa (v3 §13)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const local = await h.runtimes.create({
      name: "pi-local",
      kind: "pi",
      env: { PI_CODING_AGENT_DIR: join(fx.dir, "agent-local") },
    });
    const containerized = await h.runtimes.create({
      name: "pi-docker",
      kind: "pi",
      containerized: true,
      image: "fake/pi:1",
      config: { containerCommand: ["node", fx.fakePi] },
    });

    // Run #1 locally → session in the local harness home.
    const { task, run } = await h.runService.submit({ prompt: "local start", runtimeId: local.id, workspaceId: ws.id });
    await waitForRun(h.runService, run.id);
    const ref = h.runtimeSessions.list({ taskId: task.id })[0];
    assert.equal(ref.executionBackend, "local");

    // Continuing on the containerized runtime cannot attach that session.
    const toDocker = await h.runService.continueTask(task.id, { prompt: "now in docker", runtimeId: containerized.id });
    assert.equal(toDocker.continuity, "handoff");
    assert.match(toDocker.explanation, /no runtime native state/);

    // Run on docker → session in mounted native state.
    const dockerRun = await waitForRun(h.runService, toDocker.run.id);
    assert.equal(dockerRun.status, "completed");
    const dockerRef = h.runtimeSessions.list({ taskId: task.id }).find((r) => r.executionBackend === "docker")!;

    // Continuing back on the local runtime cannot attach it either.
    const toLocal = await h.runService.continueTask(task.id, { prompt: "back to local", runtimeId: local.id });
    assert.equal(toLocal.continuity, "handoff");
    assert.match(toLocal.explanation, /containerized native state/);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §10/§11: container image policy                                     */
/* ------------------------------------------------------------------ */

test("containerized pi without an image refuses to run (v3 §10 plan A)", async () => {
  const fx = makeFixtures();
  // Unset image overrides so the no-image policy is actually exercised
  // even when the outer environment provides a default pi image.
  const restore = useBins(fx, {}, ["AGENTFABRIC_PI_IMAGE", "AGENTFABRIC_OPENCODE_IMAGE"]);
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const runtime = await h.runtimes.create({
      name: "pi-no-image",
      kind: "pi",
      containerized: true,
      config: { containerCommand: ["node", fx.fakePi] },
    });

    const { task, run } = await h.runService.submit({ prompt: "should refuse", runtimeId: runtime.id, workspaceId: ws.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.error ?? "", /Pi Runtime Image/);
    assert.ok(h.runService.events(run.id).some((e) => e.type === "runtime.error" && String(e.data?.error ?? "").includes("Pi Runtime Image")));

    // v3 §16/§17: without a usable image the runtime must not claim
    // native-resume capability.
    const options = h.runService.continueOptions(task.id);
    assert.equal(options.resumeAvailable, false);
    assert.ok(dockerCalls(fx).every((c) => !c.includes("run")), "no container was started");
  } finally {
    restore();
  }
});

test("AGENTFABRIC_PI_IMAGE provides the containerized pi image (v3 §10)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { AGENTFABRIC_PI_IMAGE: "env/pi:9" });
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const runtime = await h.runtimes.create({
      name: "pi-env-image",
      kind: "pi",
      containerized: true,
      config: { containerCommand: ["node", fx.fakePi] },
    });
    const { run } = await h.runService.submit({ prompt: "p", runtimeId: runtime.id, workspaceId: ws.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "completed");
    assert.ok(dockerCalls(fx).some((c) => c.includes("env/pi:9")));
  } finally {
    restore();
  }
});

test("containerized opencode defaults to the maintained official image (v3 §11)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const runtime = await h.runtimes.create({
      name: "oc-default-image",
      kind: "opencode",
      containerized: true,
      config: { containerCommand: ["node", fx.fakeOpenCode] },
    });
    const { run } = await h.runService.submit({ prompt: "p", runtimeId: runtime.id, workspaceId: ws.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "completed");
    const call = dockerCalls(fx).find((c) => c.includes("ghcr.io/anomalyco/opencode"));
    assert.ok(call, "the default image is the current official opencode image");
    // The stale image name must not be used anywhere.
    assert.ok(dockerCalls(fx).every((c) => !c.some((a) => String(a).includes("ghcr.io/sst/opencode"))));
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §7: local and docker share the same harness parser                  */
/* ------------------------------------------------------------------ */

test("pi produces the same structured events on local and docker execution (v3 §7)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const ws = await h.workspaces.create({ name: "ws", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
    const local = await h.runtimes.create({
      name: "pi-l",
      kind: "pi",
      env: { PI_CODING_AGENT_DIR: join(fx.dir, "agent-l") },
    });
    const containerized = await h.runtimes.create({
      name: "pi-d",
      kind: "pi",
      containerized: true,
      image: "fake/pi:1",
      config: { containerCommand: ["node", fx.fakePi] },
    });

    const eventsOf = (run: Run): Set<string> =>
      new Set(h.runService.events(run.id).filter((e) => e.source === "pi").map((e) => e.type));

    const a = await h.runService.submit({ prompt: "local", runtimeId: local.id, workspaceId: ws.id });
    await waitForRun(h.runService, a.run.id);
    const b = await h.runService.submit({ prompt: "docker", runtimeId: containerized.id, workspaceId: ws.id });
    await waitForRun(h.runService, b.run.id);

    const localEvents = eventsOf(a.run);
    const dockerEvents = eventsOf(b.run);
    assert.deepEqual(
      [...localEvents].sort(),
      [...dockerEvents].sort(),
      "both backends stream through one parser — identical event sets"
    );
    for (const expected of ["agent.message", "tool.started", "tool.progress", "tool.completed", "run.progress", "usage.updated"]) {
      assert.ok(localEvents.has(expected), `missing ${expected}`);
    }
  } finally {
    restore();
  }
});

test("pi image contract hint documents the harness execution contract (v3 §10/§12)", () => {
  assert.ok(PI_IMAGE_CONTRACT_HINT.includes("Pi Runtime Image"));
  assert.ok(PI_IMAGE_CONTRACT_HINT.includes("docker/pi.Dockerfile"));
});
