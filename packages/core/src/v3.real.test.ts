/**
 * REAL harness integration tests (v3 §18–§20) — the final acceptance
 * for Containerized Native Resume. Unlike the fake-harness suites these
 * run actual `pi` / `opencode` CLIs against a real model provider and
 * (for the docker variants) real containers.
 *
 * Gated: they only run when the environment actually supports them.
 *   AGENTFABRIC_REAL_INTEGRATION=1        — master switch
 *   pi / opencode on PATH                 — local variants
 *   docker daemon reachable               — containerized variants
 *   a DeepSeek API key (env AGENTFABRIC_REAL_DEEPSEEK_KEY /
 *   DEEPSEEK_API_KEY, or the local opencode auth.json) — model calls
 *   AGENTFABRIC_PI_IMAGE (optional)       — prebuilt pi runtime image;
 *                                           otherwise built from
 *                                           docker/pi.Dockerfile
 *
 * Each scenario proves the v3 §19/§20 loop:
 *   Run #1 (create session + use workspace + persist native state +
 *   destroy container) → Run #2 (new container, same workspace + state,
 *   resume via the native ref) → the harness explicitly continues
 * Run #1's context (the secret word).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Store } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import {
  ModelService,
  NativeStateService,
  ProviderService,
  RuntimeService,
  RuntimeSessionService,
  WorkspaceService,
} from "./services.js";
import { opencodeAdapter } from "../../runtimes/src/opencode.js";
import { piAdapter } from "../../runtimes/src/pi.js";
import type { Run } from "./types.js";

const exec = promisify(execFile);
const RUN_TIMEOUT_MS = 5 * 60_000;

const enabled = process.env.AGENTFABRIC_REAL_INTEGRATION === "1";

async function binaryWorks(bin: string, args = ["--version"]): Promise<boolean> {
  try {
    await exec(bin, args, { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function dockerReady(): Promise<boolean> {
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** DeepSeek key for real model calls (never printed). */
function deepseekKey(): string | undefined {
  if (process.env.AGENTFABRIC_REAL_DEEPSEEK_KEY) return process.env.AGENTFABRIC_REAL_DEEPSEEK_KEY;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"));
    const key = auth?.deepseek?.key;
    return typeof key === "string" && key ? key : undefined;
  } catch {
    return undefined;
  }
}

/** opencode auth.json content, reused for isolated/containerized runs. */
function opencodeAuthJson(): string | undefined {
  const custom = process.env.AGENTFABRIC_OPENCODE_AUTH_JSON;
  if (custom) return custom;
  try {
    return readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8");
  } catch {
    return undefined;
  }
}

const piOk = enabled && (await binaryWorks("pi"));
const opencodeOk = enabled && (await binaryWorks("opencode"));
const dockerOk = enabled && (await dockerReady());
const key = enabled ? deepseekKey() : undefined;

/** pi runtime image: prebuilt via env, or built from the reference Dockerfile. */
async function ensurePiImage(): Promise<string | undefined> {
  if (process.env.AGENTFABRIC_PI_IMAGE) return process.env.AGENTFABRIC_PI_IMAGE;
  if (!dockerOk) return undefined;
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const tag = "agentfabric-pi-itest:latest";
  try {
    await exec("docker", ["build", "-t", tag, "-f", join(repoRoot, "docker", "pi.Dockerfile"), join(repoRoot, "docker")], {
      timeout: 10 * 60_000,
    });
    return tag;
  } catch {
    return undefined;
  }
}
const piImage = enabled && dockerOk && key ? await ensurePiImage() : undefined;

/**
 * Gate for node:test's skip option: `false` means run (an empty string
 * would be treated as a skip reason by the runner).
 */
function gate(ready: boolean, missing: string): string | false {
  if (ready) return false;
  if (!enabled) return "set AGENTFABRIC_REAL_INTEGRATION=1 to run real-harness integration tests";
  return `missing requirements: ${missing}`;
}

/**
 * True when the harness's own state directory holds session data.
 * OpenCode 1.x persists sessions in a SQLite database (opencode.db);
 * older layouts used storage/session/. Both are opaque to AgentFabric —
 * the assertion only proves the state really persisted.
 */
function harnessStatePersisted(dir: string): boolean {
  return existsSync(join(dir, "opencode.db")) || existsSync(join(dir, "storage", "session"));
}

/* ------------------------------------------------------------------ */
/* Real harness plumbing                                               */
/* ------------------------------------------------------------------ */

interface RealHarness {
  store: Store;
  runService: RunService;
  runtimes: RuntimeService;
  providers: ProviderService;
  models: ModelService;
  workspaces: WorkspaceService;
  nativeStates: NativeStateService;
}

/** No seedDefaults: no phantom models — the runs use real providers only. */
async function realHarness(): Promise<RealHarness> {
  const store = await Store.open(mkdtempSync(join(tmpdir(), "af-real-")));
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(piAdapter);
  registry.register(opencodeAdapter);
  const runService = new RunService(store, bus, registry);
  return {
    store,
    runService,
    runtimes: new RuntimeService(store),
    providers: new ProviderService(store),
    models: new ModelService(store),
    workspaces: new WorkspaceService(store),
    nativeStates: new NativeStateService(store),
  };
}

async function waitForRunReal(runService: RunService, runId: string): Promise<Run> {
  const deadline = Date.now() + 6 * 60_000;
  let current = runService.get(runId)!;
  while (["pending", "starting", "running"].includes(current.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    current = runService.get(runId)!;
  }
  return current;
}

function agentMessages(runService: RunService, runId: string): string {
  return runService
    .events(runId)
    .filter((e) => e.type === "agent.message")
    .map((e) => String(e.data?.content ?? ""))
    .join("\n");
}

/** Registers the deepseek provider/model pair pi understands natively. */
async function ensurePiProviderModel(h: RealHarness): Promise<void> {
  const provider = await h.providers.create({ name: "deepseek", type: "openai-completions" });
  await h.models.create({ providerId: provider.id, name: "deepseek-v4-flash", alias: "deepseek-v4-flash" });
}

/* ------------------------------------------------------------------ */
/* Pi Local Native Resume (v3 §19 / §23)                               */
/* ------------------------------------------------------------------ */

test("REAL: pi local native resume continues Run #1's context (v3 §19/§23)", { skip: gate(piOk && Boolean(key), "pi CLI + DeepSeek key") }, async () => {
  const h = await realHarness();
  await ensurePiProviderModel(h);
  const ws = await h.workspaces.create({ name: "pi-real", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
  const agentDir = join(tmpdir(), `af-pi-agent-${Date.now()}`);
  const runtime = await h.runtimes.create({
    name: "pi-real",
    kind: "pi",
    env: { PI_CODING_AGENT_DIR: agentDir, DEEPSEEK_API_KEY: key! },
  });

  const { task, run } = await h.runService.submit({
    prompt: "Remember the secret word ZEPHYR-42. Reply with exactly: OK",
    runtimeId: runtime.id,
    workspaceId: ws.id,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const first = await waitForRunReal(h.runService, run.id);
  assert.equal(first.status, "completed", first.error);

  // Native session reference + real usage (v3 §8).
  const rs = new RuntimeSessionService(h.store);
  const refRec = rs.list({ taskId: task.id })[0];
  assert.ok(refRec, "pi persisted a native session reference");
  assert.ok(existsSync(join(agentDir, "sessions")), "pi wrote its session store");
  assert.ok((first.usage?.inputTokens ?? 0) > 0, "real input tokens recorded");
  assert.ok((first.usage?.modelRequests ?? 0) >= 1, "real model requests recorded");
  assert.ok((first.usage?.estimatedCost ?? 0) > 0, "real cost recorded");

  const cont = await h.runService.continueTask(task.id, { prompt: "What was the secret word I told you? Reply with just the word." });
  assert.equal(cont.continuity, "resume");
  const second = await waitForRunReal(h.runService, cont.run.id);
  assert.equal(second.status, "completed", second.error);
  assert.match(agentMessages(h.runService, cont.run.id), /ZEPHYR-42/, "resumed pi continues Run #1's context");
});

/* ------------------------------------------------------------------ */
/* Pi Docker Native Resume (v3 §19 / §23)                              */
/* ------------------------------------------------------------------ */

test("REAL: pi docker native resume across destroyed containers (v3 §19/§23)", { skip: gate(Boolean(piImage), "docker daemon + pi runtime image (build docker/pi.Dockerfile)") }, async () => {
  const h = await realHarness();
  await ensurePiProviderModel(h);
  const ws = await h.workspaces.create({ name: "pi-docker-real", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
  const runtime = await h.runtimes.create({
    name: "pi-docker-real",
    kind: "pi",
    containerized: true,
    image: piImage!,
    env: { DEEPSEEK_API_KEY: key! },
  });

  /* Run #1: fresh ephemeral container creates + persists the session. */
  const { task, run } = await h.runService.submit({
    prompt: "Remember the secret word ORBIT-17. Reply with exactly: OK",
    runtimeId: runtime.id,
    workspaceId: ws.id,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const first = await waitForRunReal(h.runService, run.id);
  assert.equal(first.status, "completed", first.error);
  assert.ok(first.containerId, "ran inside a container");

  const rs = new (await import("./services.js")).RuntimeSessionService(h.store);
  const ref = rs.list({ taskId: task.id })[0];
  assert.ok(ref, "native session reference captured from the container stream");
  assert.equal(ref.executionBackend, "docker");
  const state = h.nativeStates.get(ref.nativeStateId!)!;
  assert.ok(existsSync(join(state.path, "agent", "sessions")), "session persisted in the opaque native state");
  assert.ok((first.usage?.inputTokens ?? 0) > 0, "usage survived the container boundary");
  assert.ok(h.runService.events(run.id).some((e) => e.type === "agent.message" && e.source === "pi"));

  /* Run #2: a NEW container attaches workspace + state and resumes. */
  const cont = await h.runService.continueTask(task.id, { prompt: "What was the secret word I told you? Reply with just the word." });
  assert.equal(cont.continuity, "resume");
  const second = await waitForRunReal(h.runService, cont.run.id);
  assert.equal(second.status, "completed", second.error);
  assert.notEqual(second.containerId, first.containerId, "containers are disposable — a new one ran Run #2");
  assert.equal(second.nativeStateId, state.id, "Run #2 reattached the exact native state");
  assert.match(agentMessages(h.runService, cont.run.id), /ORBIT-17/, "containerized pi native resume continues Run #1's context");
});

/* ------------------------------------------------------------------ */
/* OpenCode Local Native Resume (v3 §20 / §23)                         */
/* ------------------------------------------------------------------ */

test("REAL: opencode local native resume continues Run #1's context (v3 §20/§23)", { skip: gate(opencodeOk && Boolean(opencodeAuthJson()), "opencode CLI + auth") }, async () => {
  const h = await realHarness();
  const xdg = mkdtempSync(join(tmpdir(), "af-oc-xdg-"));
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  writeFileSync(join(xdg, "opencode", "auth.json"), opencodeAuthJson()!);
  const ws = await h.workspaces.create({ name: "oc-real", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
  const runtime = await h.runtimes.create({ name: "oc-real", kind: "opencode", env: { XDG_DATA_HOME: xdg } });

  const { task, run } = await h.runService.submit({
    prompt: "Remember the secret word MANGO-9. Reply with exactly: OK",
    runtimeId: runtime.id,
    workspaceId: ws.id,
    timeoutMs: RUN_TIMEOUT_MS,
    policy: { autoApprove: true },
  });
  const first = await waitForRunReal(h.runService, run.id);
  assert.equal(first.status, "completed", first.error);

  const rs = new (await import("./services.js")).RuntimeSessionService(h.store);
  const ref = rs.list({ taskId: task.id })[0];
  assert.ok(ref, "opencode persisted a native session reference");
  assert.ok(ref.nativeSessionRef.startsWith("ses_"));
  assert.ok(harnessStatePersisted(join(xdg, "opencode")), "opencode persisted its session state (opencode.db)");
  assert.ok((first.usage?.inputTokens ?? 0) > 0, "step_finish tokens reached Run Usage");
  assert.ok((first.usage?.modelRequests ?? 0) >= 1);

  const cont = await h.runService.continueTask(task.id, { prompt: "What was the secret word I told you? Reply with just the word." });
  assert.equal(cont.continuity, "resume");
  const second = await waitForRunReal(h.runService, cont.run.id);
  assert.equal(second.status, "completed", second.error);
  assert.match(agentMessages(h.runService, cont.run.id), /MANGO-9/, "resumed opencode continues Run #1's context");
});

/* ------------------------------------------------------------------ */
/* OpenCode Docker Native Resume (v3 §20 / §23)                        */
/* ------------------------------------------------------------------ */

test("REAL: opencode docker native resume across destroyed containers (v3 §20/§23)", { skip: gate(dockerOk && Boolean(opencodeAuthJson()), "docker daemon + opencode auth") }, async () => {
  const h = await realHarness();
  const ws = await h.workspaces.create({ name: "oc-docker-real", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
  const runtime = await h.runtimes.create({
    name: "oc-docker-real",
    kind: "opencode",
    containerized: true, // default image: ghcr.io/anomalyco/opencode (v3 §11)
  });

  // Pre-provision auth inside the opaque native state the container
  // will mount ($XDG_DATA_HOME/opencode → /root/.local/share/opencode).
  const state = await h.nativeStates.ensureForRuntime(
    (await h.runtimes.get(runtime.id))!,
    "/root/.local/share/opencode"
  );
  writeFileSync(join(state.path, "auth.json"), opencodeAuthJson()!);

  const { task, run } = await h.runService.submit({
    prompt: "Remember the secret word NEBULA-5. Reply with exactly: OK",
    runtimeId: runtime.id,
    workspaceId: ws.id,
    timeoutMs: RUN_TIMEOUT_MS,
    policy: { autoApprove: true },
  });
  const first = await waitForRunReal(h.runService, run.id);
  assert.equal(first.status, "completed", first.error);
  assert.ok(first.containerId);

  const rs = new (await import("./services.js")).RuntimeSessionService(h.store);
  const ref = rs.list({ taskId: task.id })[0];
  assert.ok(ref, "session reference captured from the container stream");
  assert.ok(harnessStatePersisted(state.path), "session persisted in the opaque native state");
  assert.ok((first.usage?.inputTokens ?? 0) > 0, "usage survived the container boundary");

  const cont = await h.runService.continueTask(task.id, { prompt: "What was the secret word I told you? Reply with just the word." });
  assert.equal(cont.continuity, "resume");
  const second = await waitForRunReal(h.runService, cont.run.id);
  assert.equal(second.status, "completed", second.error);
  assert.notEqual(second.containerId, first.containerId);
  assert.equal(second.nativeStateId, state.id);
  assert.match(agentMessages(h.runService, cont.run.id), /NEBULA-5/, "containerized opencode resume continues Run #1's context");
});

/* ------------------------------------------------------------------ */
/* Cross-harness: always Handoff (v3 §21/§23)                          */
/* ------------------------------------------------------------------ */

test("REAL: pi → opencode cross-harness continuation is a handoff (v3 §21/§23)", { skip: gate(piOk && opencodeOk && Boolean(key && opencodeAuthJson()), "pi + opencode + auth") }, async () => {
  const h = await realHarness();
  await ensurePiProviderModel(h);
  const xdg = mkdtempSync(join(tmpdir(), "af-oc-xdg2-"));
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  writeFileSync(join(xdg, "opencode", "auth.json"), opencodeAuthJson()!);
  const ws = await h.workspaces.create({ name: "cross-real", type: "local", path: mkdtempSync(join(tmpdir(), "af-ws-")) });
  const piRuntime = await h.runtimes.create({
    name: "pi-cross",
    kind: "pi",
    env: { PI_CODING_AGENT_DIR: join(tmpdir(), `af-pi-agent-cross-${Date.now()}`), DEEPSEEK_API_KEY: key! },
  });
  const ocRuntime = await h.runtimes.create({ name: "oc-cross", kind: "opencode", env: { XDG_DATA_HOME: xdg } });

  const { task, run } = await h.runService.submit({
    prompt: "Create a file named marker.txt containing the word HARBOR-21. Reply OK when done.",
    runtimeId: piRuntime.id,
    workspaceId: ws.id,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const first = await waitForRunReal(h.runService, run.id);
  assert.equal(first.status, "completed", first.error);

  const switched = await h.runService.continueTask(task.id, {
    prompt: "Read marker.txt in the workspace and tell me the word it contains. Reply with just the word.",
    runtimeId: ocRuntime.id,
    policy: { autoApprove: true },
  });
  assert.equal(switched.continuity, "handoff", "cross-harness continuation is always a handoff");
  assert.ok(switched.handoff);
  const second = await waitForRunReal(h.runService, switched.run.id);
  assert.equal(second.status, "completed", second.error);
  // The handoff prompt plus the shared workspace carried the context.
  assert.match(agentMessages(h.runService, switched.run.id), /HARBOR-21/);
});
