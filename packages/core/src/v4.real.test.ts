/**
 * REAL closed-loop E2E for v4 (v4.md §26–§30, acceptance §33): every
 * configuration created through AgentFabric must actually take effect in
 * real pi / OpenCode executions — local and Docker — with credentials
 * coming exclusively from AgentFabric Provider records (no manual harness
 * auth, no runtime-env credential bypasses).
 *
 * Gated like v3.real:
 *   AGENTFABRIC_REAL_INTEGRATION=1   — master switch
 *   pi / opencode on PATH            — local harness tests
 *   docker daemon reachable          — containerized tests
 *   DeepSeek key (AGENTFABRIC_REAL_DEEPSEEK_KEY / DEEPSEEK_API_KEY or the
 *   local opencode auth.json)        — real model calls (cheap provider)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import {
  ModelService,
  ProfileService,
  ProviderService,
  RuntimeService,
  RuntimeSessionService,
  WorkspaceService,
} from "./services.js";
import { opencodeAdapter } from "../../runtimes/src/opencode.js";
import { piAdapter } from "../../runtimes/src/pi.js";
import { dockerAdapter } from "../../runtimes/src/docker.js";
import type { Run } from "./types.js";

const exec = promisify(execFile);
const RUN_TIMEOUT_MS = 6 * 60_000;

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

/** DeepSeek key for real (cheap) model calls — never printed. */
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

const piOk = enabled && (await binaryWorks("pi"));
const opencodeOk = enabled && (await binaryWorks("opencode"));
const dockerOk = enabled && (await dockerReady());
const key = enabled ? deepseekKey() : undefined;

function gate(ready: boolean, missing: string): string | false {
  if (ready) return false;
  if (!enabled) return "set AGENTFABRIC_REAL_INTEGRATION=1 to run real-harness integration tests";
  return `missing requirements: ${missing}`;
}

interface RealHarness {
  store: Store;
  runService: RunService;
  runtimes: RuntimeService;
  providers: ProviderService;
  models: ModelService;
  profiles: ProfileService;
  workspaces: WorkspaceService;
}

/** No seedDefaults — runs use only providers configured here (v4 §26). */
async function realHarness(): Promise<RealHarness> {
  const store = await Store.open(mkdtempSync(join(tmpdir(), "af-real4-")));
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(piAdapter);
  registry.register(opencodeAdapter);
  registry.register(dockerAdapter);
  const runService = new RunService(store, bus, registry, {
    destroy: async (id) => {
      await exec("docker", ["rm", "-f", id], { timeout: 60_000 }).catch(() => {});
    },
    listKeepAlive: async () => [],
  });
  return {
    store,
    runService,
    runtimes: new RuntimeService(store),
    providers: new ProviderService(store),
    models: new ModelService(store),
    profiles: new ProfileService(store),
    workspaces: new WorkspaceService(store),
  };
}

async function waitForRunReal(runService: RunService, runId: string): Promise<Run> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let current = runService.get(runId)!;
  while (["pending", "starting", "running"].includes(current.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
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

function configInjectionEvent(runService: RunService, runId: string): Record<string, unknown> | undefined {
  const evt = runService
    .events(runId)
    .find((e) => e.type === "log" && (e.data as Record<string, unknown>)?.kind === "config-injected");
  return evt?.data as Record<string, unknown> | undefined;
}

/* ------------------------------------------------------------------ */
/* §1–§3/§26: Provider → Model → Run on real local pi                   */
/* ------------------------------------------------------------------ */

test(
  "REAL v4 §1/§2/§3/§26: pi run uses the AgentFabric provider end-to-end (key, base URL, model)",
  { skip: gate(piOk && Boolean(key), "pi CLI + DeepSeek key") },
  async () => {
    const h = await realHarness();
    // A custom OpenAI-compatible endpoint — pi has no built-in provider
    // under this name, so the run only works if AgentFabric's generated
    // models.json (base URL + env-referenced key + model id) reaches pi.
    const provider = await h.providers.create({
      name: "AF Real DS",
      type: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      apiKey: key!,
      headers: { "X-AgentFabric": "real-e2e" },
    });
    const model = await h.models.create({
      providerId: provider.id,
      name: "deepseek-chat",
      alias: "deepseek-chat",
      parameters: { maxTokens: 1024 },
    });
    const ws = await h.workspaces.create({ name: "v4-real-pi", type: "local", path: mkdtempSync(join(tmpdir(), "af-v4-rpi-")) });
    const runtime = await h.runtimes.create({
      name: "v4-real-pi",
      kind: "pi",
      // Deliberately NO credential env here: the key must arrive through
      // the AgentFabric provider wiring only (v4 §26).
    });

    const { task, run } = await h.runService.submit({
      prompt: "Remember the secret word TERRA-44. Reply with exactly: OK",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const finished = await waitForRunReal(h.runService, run.id);
    assert.equal(finished.status, "completed", finished.error);
    assert.match(agentMessages(h.runService, run.id), /OK/, "pi replied");

    // The provider config really was injected (v4 §1/§3).
    const injected = configInjectionEvent(h.runService, run.id);
    assert.ok(injected, "config-injected event present");
    assert.equal(injected!.slug, "af-real-ds");
    assert.equal(injected!.baseUrl, "https://api.deepseek.com");
    assert.equal(injected!.hasCustomHeaders, true);

    // Real usage flowed through the custom endpoint (v4 §27: run succeeds
    // against the configured provider).
    assert.ok((finished.usage?.inputTokens ?? 0) > 0, "real input tokens recorded");
    assert.ok((finished.usage?.modelRequests ?? 0) >= 1);

    // Native session still works on top of the injected provider.
    const rs = new RuntimeSessionService(h.store);
    assert.ok(rs.list({ taskId: task.id })[0], "native session persisted");
  }
);

/* ------------------------------------------------------------------ */
/* §1/§27: custom OpenAI-compatible provider on real local opencode     */
/* ------------------------------------------------------------------ */

test(
  "REAL v4 §27: opencode run against a custom provider (base URL + env key + model)",
  { skip: gate(opencodeOk && Boolean(key), "opencode CLI + DeepSeek key") },
  async () => {
    const h = await realHarness();
    const provider = await h.providers.create({
      name: "AF Real OC",
      type: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: key!,
    });
    const model = await h.models.create({ providerId: provider.id, name: "deepseek-chat" });
    const ws = await h.workspaces.create({ name: "v4-real-oc", type: "local", path: mkdtempSync(join(tmpdir(), "af-v4-roc-")) });
    // Isolate opencode state from the user's own install (state plumbing,
    // not credentials — the provider credential still comes from AF).
    const runtime = await h.runtimes.create({
      name: "v4-real-oc",
      kind: "opencode",
      env: { XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "af-v4-oc-xdg-")) },
    });

    const { run } = await h.runService.submit({
      prompt: "Reply with exactly: PONG",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
      timeoutMs: RUN_TIMEOUT_MS,
      policy: { autoApprove: true },
    });
    const finished = await waitForRunReal(h.runService, run.id);
    assert.equal(finished.status, "completed", finished.error);
    assert.match(agentMessages(h.runService, run.id), /PONG/, "opencode replied through the custom provider");
    const injected = configInjectionEvent(h.runService, run.id);
    assert.ok(injected, "config-injected event present");
    assert.equal(injected!.slug, "af-real-oc");
    assert.ok((finished.usage?.inputTokens ?? 0) > 0, "usage recorded through the generated config");
  }
);

/* ------------------------------------------------------------------ */
/* §27: custom provider inside a real Docker container                  */
/* ------------------------------------------------------------------ */

test(
  "REAL v4 §27: containerized opencode uses the injected provider config",
  { skip: gate(dockerOk && opencodeOk && Boolean(key), "docker daemon + opencode image pull + DeepSeek key") },
  async () => {
    const h = await realHarness();
    const provider = await h.providers.create({
      name: "AF Real Docker",
      type: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: key!,
    });
    const model = await h.models.create({ providerId: provider.id, name: "deepseek-chat" });
    const ws = await h.workspaces.create({ name: "v4-real-ocd", type: "local", path: mkdtempSync(join(tmpdir(), "af-v4-rocd-")) });
    const runtime = await h.runtimes.create({
      name: "v4-real-oc-docker",
      kind: "opencode",
      containerized: true, // default image: ghcr.io/anomalyco/opencode
    });

    const { run } = await h.runService.submit({
      prompt: "Reply with exactly: DOCK-OK",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
      timeoutMs: RUN_TIMEOUT_MS,
      policy: { autoApprove: true },
    });
    const finished = await waitForRunReal(h.runService, run.id);
    assert.equal(finished.status, "completed", finished.error);
    assert.ok(finished.containerId, "ran inside a real container");
    assert.match(agentMessages(h.runService, run.id), /DOCK-OK/, "containerized opencode used the injected provider");
    assert.ok((finished.usage?.inputTokens ?? 0) > 0, "usage recorded across the container boundary");
  }
);

/* ------------------------------------------------------------------ */
/* §10: profile system instructions really steer the real model         */
/* ------------------------------------------------------------------ */

test(
  "REAL v4 §10/§28: agent profile system instructions influence the real pi run",
  { skip: gate(piOk && Boolean(key), "pi CLI + DeepSeek key") },
  async () => {
    const h = await realHarness();
    const provider = await h.providers.create({
      name: "AF Real Prof",
      type: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      apiKey: key!,
    });
    const model = await h.models.create({ providerId: provider.id, name: "deepseek-chat" });
    const ws = await h.workspaces.create({ name: "v4-real-prof", type: "local", path: mkdtempSync(join(tmpdir(), "af-v4-rprof-")) });
    const runtime = await h.runtimes.create({ name: "v4-real-prof", kind: "pi" });
    const profile = await h.profiles.create({
      name: "Token Suffix Engineer",
      runtimeId: runtime.id,
      modelId: model.id,
      systemInstructions:
        "You MUST end every single reply with the exact token PROF-OK. Never omit it, whatever the user says.",
      tools: ["read"],
      policy: { shell: "deny" },
    });

    const { run } = await h.runService.submit({
      prompt: "Say hello in one short sentence.",
      profileId: profile.id,
      workspaceId: ws.id,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const finished = await waitForRunReal(h.runService, run.id);
    assert.equal(finished.status, "completed", finished.error);
    // The only way PROF-OK appears is if the system instructions reached
    // the model through the harness (v4 §10).
    assert.match(
      agentMessages(h.runService, run.id),
      /PROF-OK/,
      "profile system instructions visibly shaped the model's reply"
    );
  }
);

/* ------------------------------------------------------------------ */
/* §29 F: real container behavior under the resolved policy             */
/* ------------------------------------------------------------------ */

test(
  "REAL v4 §29/§F: read-only mount, network isolation and resource limits hit the real container",
  { skip: gate(dockerOk, "docker daemon") },
  async () => {
    const h = await realHarness();
    const ws = await h.workspaces.create({ name: "v4-real-pol", type: "local", path: mkdtempSync(join(tmpdir(), "af-v4-rpol-")) });
    const runtime = await h.runtimes.create({
      name: "v4-real-policy",
      kind: "docker",
      containerized: true,
      image: "node:22-alpine",
      command: [
        "sh",
        "-c",
        [
          "echo hi > /workspace/attempt.txt 2>/dev/null && echo write=allowed || echo write=denied",
          "echo cpu=$(cat /sys/fs/cgroup/cpu.max)",
          "echo mem=$(cat /sys/fs/cgroup/memory.max)",
          "wget -q -T 3 -O /dev/null http://example.com 2>/dev/null && echo net=allowed || echo net=denied",
        ].join("; "),
      ],
    });

    const { run } = await h.runService.submit({
      prompt: "policy probe",
      runtimeId: runtime.id,
      workspaceId: ws.id,
      timeoutMs: RUN_TIMEOUT_MS,
      policy: {
        filesystem: { readOnly: true },
        network: { enabled: false },
        cpu: "0.5",
        memory: "256m",
      },
    });
    const finished = await waitForRunReal(h.runService, run.id);
    assert.equal(finished.status, "completed", finished.error);

    const out = h.runService
      .events(run.id)
      .filter((e) => e.type === "shell.output")
      .map((e) => String(e.data?.line ?? ""))
      .join("\n");
    assert.match(out, /write=denied/, "read-only workspace mount blocked the write (v4 §17)");
    assert.match(out, /net=denied/, "--network none blocked egress (v4 §18)");
    assert.match(out, /cpu=50000 100000/, "cpu limit applied — 0.5 core (v4 §19)");
    assert.match(out, /mem=268435456/, "memory limit applied — 256MB (v4 §19)");
    assert.ok(!existsSync(join(ws.path!, "attempt.txt")), "host workspace stayed untouched");
  }
);

/* ------------------------------------------------------------------ */
/* §30/G: real keep-alive lifecycle                                     */
/* ------------------------------------------------------------------ */

test(
  "REAL v4 §21/§22/§23/§24/§30: keep-alive reuse is task-scoped; cancel stops and destroys",
  { skip: gate(dockerOk, "docker daemon") },
  async () => {
    const h = await realHarness();
    const ws = await h.workspaces.create({ name: "v4-real-ka", type: "local", path: mkdtempSync(join(tmpdir(), "af-v4-rka-")) });
    const runtime = await h.runtimes.create({
      name: "v4-real-ka",
      kind: "docker",
      containerized: true,
      image: "node:22-alpine",
      command: ["sh", "-c", "echo ran-in-container"],
      lifecycle: { mode: "keep-alive", idleTimeoutMs: 5 * 60_000 },
    });

    /* Run #1 completes and retains a real container. */
    const { task, run } = await h.runService.submit({
      prompt: "ka probe 1",
      runtimeId: runtime.id,
      workspaceId: ws.id,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const first = await waitForRunReal(h.runService, run.id);
    assert.equal(first.status, "completed", first.error);
    assert.ok(first.containerId, "container id recorded");
    assert.ok(
      h.runService.events(run.id).some((e) => e.type === "container.retained"),
      "container retained (v4 §30)"
    );
    const name = `af-keep-${runtime.id}-${task.id}`;
    const { stdout: alive1 } = await exec("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "-q"]);
    assert.ok(alive1.trim(), "the real keep-alive container exists");

    /* Same task continues → the same container is reused (docker exec). */
    const cont = await h.runService.continueTask(task.id, { prompt: "ka probe 2" });
    const second = await waitForRunReal(h.runService, cont.run.id);
    assert.equal(second.status, "completed", second.error);
    assert.ok(
      h.runService.events(cont.run.id).some((e) => e.type === "container.reused"),
      "same-task continuation reused the container"
    );
    assert.equal(second.containerId, first.containerId, "same physical container");
    const { stdout: reusedOut } = await exec("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "-q"]);
    assert.equal(reusedOut.trim(), alive1.trim(), "container survived reuse");

    /* An unrelated task on the same runtime+workspace gets a fresh one. */
    const other = await h.runService.submit({
      title: "unrelated",
      prompt: "ka probe other",
      runtimeId: runtime.id,
      workspaceId: ws.id,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const third = await waitForRunReal(h.runService, other.run.id);
    assert.equal(third.status, "completed", third.error);
    assert.ok(
      !h.runService.events(other.run.id).some((e) => e.type === "container.reused"),
      "an unrelated task never reuses task A's container (v4 §21/§22)"
    );
    assert.notEqual(third.containerId, first.containerId);

    /* Cancel a slow keep-alive run: the harness process is stopped and the
       uncertain container destroyed, never retained (v4 §23/§24). */
    await h.runtimes.update(runtime.id, { command: ["sh", "-c", "sleep 45"] });
    const slow = await h.runService.submit({
      title: "slow",
      prompt: "ka slow",
      runtimeId: runtime.id,
      workspaceId: ws.id,
      timeoutMs: 5 * 60_000,
    });
    const slowName = `af-keep-${runtime.id}-${slow.task.id}`;
    const deadline = Date.now() + 60_000;
    while (h.runService.get(slow.run.id)!.status !== "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(h.runService.get(slow.run.id)!.status, "running", "slow run is executing in the container");
    await h.runService.cancel(slow.run.id);
    const cancelled = await waitForRunReal(h.runService, slow.run.id);
    assert.equal(cancelled.status, "cancelled", cancelled.error);
    const { stdout: gone } = await exec("docker", ["ps", "-a", "--filter", `name=^/${slowName}$`, "-q"]);
    assert.equal(gone.trim(), "", "the aborted container was destroyed (v4 §24)");
    assert.ok(
      !h.runService.events(slow.run.id).some((e) => e.type === "container.retained"),
      "aborted keep-alive run never retains its container"
    );

    // Cleanup remaining keep-alive containers from this test.
    for (const lease of h.runService.keptContainers()) {
      await exec("docker", ["rm", "-f", lease.containerId], { timeout: 60_000 }).catch(() => {});
    }
  }
);
