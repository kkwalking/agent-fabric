/**
 * v4 closed-loop E2E tests (v4.md §26–§30): every user configuration
 * surface — Provider, Model, Agent Profile, Execution Policy, Runtime,
 * Workspace, Keep-Alive — must genuinely reach the harness execution.
 *
 * The fakes are observation-instrumented: the fake pi/opencode CLIs dump
 * the env, argv and generated harness config they actually received, and
 * the fake docker CLI records every invocation. Credentials are never
 * hand-injected into the harness — they must arrive through AgentFabric's
 * provider wiring (v4 §26: no manual harness auth.json / runtime env
 * credential bypasses).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dockerCalls,
  freshHarness,
  makeFixtures,
  useBins,
  waitForRun,
  type Fixtures,
  type Harness,
} from "./testkit.js";
import { ProfileService, ProviderService, ModelService, SecretService } from "./services.js";
import type { Run } from "./types.js";

interface HarnessDump {
  harness: "pi" | "opencode";
  argv: string[];
  env: Record<string, string>;
  modelsJson?: { providers?: Record<string, Record<string, unknown>> };
  config?: Record<string, any>;
  cwd?: string;
}

function readDumps(path: string): HarnessDump[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HarnessDump);
}

/** One provider→model→runtime stack wired like a real user would. */
async function setupStack(
  h: Harness,
  fx: Fixtures,
  dumpPath: string,
  overrides: {
    provider?: Partial<Parameters<ProviderService["create"]>[0]>;
    modelParams?: Record<string, unknown>;
    runtimeEnv?: Record<string, string>;
    containerized?: boolean;
    lifecycle?: { mode: "ephemeral" | "keep-alive"; idleTimeoutMs?: number };
    networkPolicy?: { enabled: boolean };
  } = {}
) {
  const providers = new ProviderService(h.store);
  const models = new ModelService(h.store);
  const provider = await providers.create({
    name: "Custom Endpoïnt",
    type: "openai-completions",
    baseUrl: "https://api.custom-example.dev/v1",
    apiKey: "sk-live-e2e-key-42",
    headers: { "X-Org-Tag": "agentfabric-e2e" },
    ...overrides.provider,
  });
  const model = await models.create({
    providerId: provider.id,
    name: "ds-flash-e2e",
    alias: "ds-flash-e2e",
    parameters: { maxTokens: 4096, temperature: 0.7, ...overrides.modelParams },
  });
  const ws = await h.workspaces.create({
    name: "v4-e2e",
    type: "local",
    path: mkdtempSync(join(tmpdir(), "af-v4-ws-")),
  });
  const runtime = await h.runtimes.create({
    name: `v4-${overrides.containerized ? "docker" : "local"}-${Date.now()}`,
    kind: "pi",
    containerized: overrides.containerized ?? false,
    image: overrides.containerized ? "fake-harness-image:latest" : undefined,
    // The fake docker has no harness entrypoint — run the fake CLI via an
    // explicit in-container command (real harness images don't need this;
    // their entrypoint is the harness itself).
    config: overrides.containerized ? { containerCommand: ["node", fx.fakePi] } : undefined,
    lifecycle: overrides.lifecycle ?? { mode: "ephemeral" },
    networkPolicy: overrides.networkPolicy,
    env: {
      // Local runs get an isolated pi agent dir; containerized runs read
      // the mounted native state at pi's in-container default path.
      ...(overrides.containerized ? {} : { PI_CODING_AGENT_DIR: join(fx.dir, "pi-agent") }),
      FAKE_HARNESS_DUMP: dumpPath,
      ...overrides.runtimeEnv,
    },
  });
  return { provider, model, ws, runtime };
}

async function waitCompleted(h: Harness, runId: string): Promise<Run> {
  const run = await waitForRun(h.runService, runId);
  assert.equal(run.status, "completed", run.error ?? "run should complete");
  return run;
}

test("v4 §26: Provider → Model → Run — key, base URL and headers reach the pi harness", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "pi-dump.jsonl");
  try {
    const h = await freshHarness();
    const { model, ws, runtime } = await setupStack(h, fx, dumpPath);

    const { run } = await h.runService.submit({
      prompt: "Reply with exactly: OK",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, run.id);

    const dumps = readDumps(dumpPath);
    assert.equal(dumps.length, 1, "the fake pi harness ran exactly once");
    const dump = dumps[0];

    // The provider API key arrived via AgentFabric's own wiring (v4 §2) —
    // the test never configured any harness credential itself.
    assert.equal(dump.env.AGENTFABRIC_PROVIDER_API_KEY, "sk-live-e2e-key-42");
    assert.equal(dump.env.AGENTFABRIC_PROVIDER, "Custom Endpoïnt");
    assert.equal(dump.env.AGENTFABRIC_MODEL, "ds-flash-e2e");

    // Provider selection uses the AgentFabric slug; models.json carries
    // the exact base URL, key reference, custom headers and the model
    // (v4 §1/§3/§4/§7).
    const argv = dump.argv;
    assert.ok(argv.includes("--provider"));
    assert.equal(argv[argv.indexOf("--provider") + 1], "custom-endpo-nt");
    assert.ok(argv.includes("--model"));
    assert.equal(argv[argv.indexOf("--model") + 1], "ds-flash-e2e");

    const entry = dump.modelsJson?.providers?.["custom-endpo-nt"];
    assert.ok(entry, "models.json holds the AgentFabric provider entry");
    assert.equal(entry!.baseUrl, "https://api.custom-example.dev/v1");
    assert.equal(entry!.apiKey, "$AGENTFABRIC_PROVIDER_API_KEY");
    assert.deepEqual(entry!.headers, { "X-Org-Tag": "agentfabric-e2e" });
    assert.equal(entry!.api, "openai-completions");
    assert.deepEqual(entry!.models, [{ id: "ds-flash-e2e", maxTokens: 4096 }]);

    // Unsupported model parameters are warned about, never silent (v4 §8).
    const warned = h.runService
      .events(run.id)
      .some(
        (e) =>
          e.type === "log" &&
          e.level === "warn" &&
          (e.data as any)?.kind === "config-warning" &&
          Array.isArray((e.data as any)?.unsupported) &&
          (e.data as any).unsupported.includes("temperature")
      );
    assert.ok(warned, "temperature is explicitly reported as unsupported");
  } finally {
    restore();
  }
});

test("v4 §27: custom OpenAI-compatible provider reaches containerized opencode", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "oc-dump.jsonl");
  try {
    const h = await freshHarness();
    const providers = new ProviderService(h.store);
    const models = new ModelService(h.store);
    const provider = await providers.create({
      name: "Edge Proxy",
      type: "openai-compatible",
      baseUrl: "https://proxy.internal.example/v3",
      apiKey: "sk-proxy-e2e-77",
      headers: { "X-Proxy-Auth": "tok" },
    });
    const model = await models.create({
      providerId: provider.id,
      name: "gpt-custom-e2e",
      parameters: { maxTokens: 2048 },
    });
    const ws = await h.workspaces.create({
      name: "v4-docker-ws",
      type: "local",
      path: mkdtempSync(join(tmpdir(), "af-v4-dws-")),
    });
    const runtime = await h.runtimes.create({
      name: `v4-oc-docker-${Date.now()}`,
      kind: "opencode",
      containerized: true,
      image: "fake-opencode-image:latest",
      config: { containerCommand: ["node", fx.fakeOpenCode] },
      env: { FAKE_HARNESS_DUMP: dumpPath },
    });

    const { run } = await h.runService.submit({
      prompt: "Reply with exactly: OK",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, run.id);

    // The generated opencode.json was mounted into the container and its
    // path exported (v4 §1/§3).
    const runs = dockerCalls(fx).filter((c) => c[0] === "run");
    assert.equal(runs.length, 1, "one ephemeral container ran the harness");
    const runArgs = runs[0];
    assert.ok(
      runArgs.some((a, i) => a === "-v" && runArgs[i + 1]?.endsWith(":/root/.agentfabric/opencode.json:ro")),
      "generated config is mounted read-only"
    );
    assert.ok(
      runArgs.some((a, i) => a === "-e" && runArgs[i + 1] === "OPENCODE_CONFIG=/root/.agentfabric/opencode.json"),
      "OPENCODE_CONFIG points at the container path"
    );

    const dumps = readDumps(dumpPath);
    assert.equal(dumps.length, 1);
    const dump = dumps[0];
    assert.equal(dump.harness, "opencode");
    assert.equal(dump.env.AGENTFABRIC_PROVIDER_API_KEY, "sk-proxy-e2e-77");
    const modelIdx = dump.argv.indexOf("-m");
    assert.equal(dump.argv[modelIdx + 1], "edge-proxy/gpt-custom-e2e");

    const cfg = dump.config!;
    assert.ok(cfg, "the harness really loaded the generated config (via the emulated mount)");
    const entry = cfg.provider?.["edge-proxy"];
    assert.ok(entry, "provider entry present");
    assert.equal(entry.npm, "@ai-sdk/openai-compatible");
    assert.equal(entry.options.baseURL, "https://proxy.internal.example/v3");
    assert.equal(entry.options.apiKey, "{env:AGENTFABRIC_PROVIDER_API_KEY}");
    assert.deepEqual(entry.options.headers, { "X-Proxy-Auth": "tok" });
    assert.equal(entry.models?.["gpt-custom-e2e"]?.limit?.output, 2048);
  } finally {
    restore();
  }
});

test("v4 §5: a disabled provider blocks new runs with a clear error", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const h = await freshHarness();
    const dumpPath = join(fx.dir, "noop.jsonl");
    const { provider, model, ws, runtime } = await setupStack(h, fx, dumpPath);
    const providers = new ProviderService(h.store);
    await providers.setEnabled(provider.id, false);

    await assert.rejects(
      () =>
        h.runService.submit({
          prompt: "should not start",
          runtimeId: runtime.id,
          modelId: model.id,
          workspaceId: ws.id,
        }),
      /Provider "Custom Endpoïnt" is disabled/
    );
    // No run record was created for the blocked submission.
    assert.equal(h.runService.list().filter((r) => r.modelId === model.id).length, 0);
    // Re-enabling unblocks the same submission path.
    await providers.setEnabled(provider.id, true);
    const { run } = await h.runService.submit({
      prompt: "now it works",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, run.id);
  } finally {
    restore();
  }
});

test("v4 §28: agent profile — system instructions, tools, env and secrets enter the pi harness", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "profile-dump.jsonl");
  try {
    const h = await freshHarness();
    const { model, ws, runtime } = await setupStack(h, fx, dumpPath);
    const secrets = new SecretService(h.store);
    const secret = await secrets.create({ name: "PROFILE_TOKEN", value: "sec-val-991", scope: "env" });
    const profiles = new ProfileService(h.store);
    const profile = await profiles.create({
      name: "Senior Engineer",
      description: "v4 e2e profile",
      runtimeId: runtime.id,
      modelId: model.id,
      systemInstructions: "You are a senior engineer; always cite file paths.",
      tools: ["read", "edit"],
      env: { PROFILE_ENV_VAR: "profile-value" },
      secretIds: [secret.id],
      policy: { shell: "deny" },
    });

    const { task, run } = await h.runService.submit({
      prompt: "Review the repo.",
      profileId: profile.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, run.id);

    assert.equal(run.profileId, profile.id);
    assert.equal(run.systemInstructions, "You are a senior engineer; always cite file paths.");
    assert.equal(task.runtimeId, runtime.id, "profile preset the runtime");
    assert.equal(task.modelId, model.id, "profile preset the model");

    const dump = readDumps(dumpPath).at(-1)!;
    // System instructions really entered the harness input (v4 §10)…
    const sysIdx = dump.argv.indexOf("--append-system-prompt");
    assert.ok(sysIdx !== -1, "--append-system-prompt passed");
    assert.match(dump.argv[sysIdx + 1], /senior engineer/);
    // …the tool allowlist was honored (v4 §11)…
    const toolsIdx = dump.argv.indexOf("--tools");
    assert.equal(dump.argv[toolsIdx + 1], "read,edit");
    // …and shell=deny removed the execution tool (v4 §15).
    const exclIdx = dump.argv.indexOf("--exclude-tools");
    assert.equal(dump.argv[exclIdx + 1], "bash");
    // Env + secrets from the profile reached the process env (v4 §12).
    assert.equal(dump.env.PROFILE_ENV_VAR, "profile-value");
    assert.equal(dump.env.PROFILE_TOKEN, "sec-val-991");
  } finally {
    restore();
  }
});

test("v4 §28/§15/§16: agent profile drives the opencode config (agent, permission, tools)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "oc-profile-dump.jsonl");
  try {
    const h = await freshHarness();
    const providers = new ProviderService(h.store);
    const models = new ModelService(h.store);
    const provider = await providers.create({
      name: "OC Profile Prov",
      type: "openai-completions",
      baseUrl: "https://ocp.example/v1",
      apiKey: "sk-ocp-1",
    });
    const model = await models.create({ providerId: provider.id, name: "m1" });
    const ws = await h.workspaces.create({
      name: "oc-profile-ws",
      type: "local",
      path: mkdtempSync(join(tmpdir(), "af-v4-opws-")),
    });
    const runtime = await h.runtimes.create({
      name: `v4-oc-profile-${Date.now()}`,
      kind: "opencode",
      env: { XDG_DATA_HOME: join(fx.dir, "oc-xdg"), FAKE_HARNESS_DUMP: dumpPath },
    });
    const profiles = new ProfileService(h.store);
    const profile = await profiles.create({
      name: "Reviewer",
      runtimeId: runtime.id,
      modelId: model.id,
      systemInstructions: "You are a meticulous code reviewer.",
      tools: ["read", "grep"],
      policy: { shell: "deny" },
    });

    const { run } = await h.runService.submit({
      prompt: "Review everything.",
      profileId: profile.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, run.id);

    const dump = readDumps(dumpPath).at(-1)!;
    const cfg = dump.config!;
    // The generated agent carries the profile's system prompt (v4 §10)…
    assert.equal(cfg.agent?.agentfabric?.prompt, "You are a meticulous code reviewer.");
    assert.equal(cfg.agent?.agentfabric?.model, "oc-profile-prov/m1");
    // …the resolved tool allowlist (v4 §11/§16)…
    assert.deepEqual(
      {
        read: cfg.agent.agentfabric.tools.read,
        grep: cfg.agent.agentfabric.tools.grep,
        edit: cfg.agent.agentfabric.tools.edit,
        bash: cfg.agent.agentfabric.tools.bash,
      },
      { read: true, grep: true, edit: false, bash: false }
    );
    // …and shell=deny became an explicit harness permission (v4 §15).
    assert.equal(cfg.permission?.bash, "deny");
    const agentIdx = dump.argv.indexOf("--agent");
    assert.equal(dump.argv[agentIdx + 1], "agentfabric");
  } finally {
    restore();
  }
});

test("v4 §17/§18/§19: resolved policy drives docker mounts, network and resource limits", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "policy-dump.jsonl");
  try {
    const h = await freshHarness();
    const { model, ws, runtime } = await setupStack(h, fx, dumpPath, {
      containerized: true,
      provider: { name: "Policy Prov", apiKey: "sk-pol-1" },
    });

    const { run } = await h.runService.submit({
      prompt: "Reply OK",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
      policy: {
        filesystem: { readOnly: true },
        network: { enabled: false },
        cpu: "0.75",
        memory: "512m",
      },
    });
    await waitCompleted(h, run.id);

    const runArgs = dockerCalls(fx).filter((c) => c[0] === "run")[0];
    assert.ok(
      runArgs.some((a, i) => a === "-v" && runArgs[i + 1]?.endsWith(":/workspace:ro")),
      "read-only filesystem policy → workspace mounted :ro (v4 §17)"
    );
    assert.ok(runArgs.includes("--network"), "network policy reached docker (v4 §18)");
    assert.equal(runArgs[runArgs.indexOf("--network") + 1], "none");
    assert.equal(runArgs[runArgs.indexOf("--cpus") + 1], "0.75", "cpu limit (v4 §19)");
    assert.equal(runArgs[runArgs.indexOf("--memory") + 1], "512m", "memory limit (v4 §19)");
  } finally {
    restore();
  }
});

test("v4 §18: a continuation override of the network policy really takes effect", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "cont-dump.jsonl");
  try {
    const h = await freshHarness();
    const { model, ws, runtime } = await setupStack(h, fx, dumpPath, {
      containerized: true,
      provider: { name: "Cont Prov", apiKey: "sk-cont-1" },
    });

    // Task-level policy allows networking.
    const { task, run } = await h.runService.submit({
      prompt: "Remember CODEX-8. Reply OK.",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, run.id);
    const firstArgs = dockerCalls(fx).filter((c) => c[0] === "run").at(-1)!;
    assert.ok(!firstArgs.includes("--network"), "first run had network access");

    // The continuation overrides the network policy — the new setting
    // must reach the container (v4 §18), not the task's original one.
    const cont = await h.runService.continueTask(task.id, {
      prompt: "And the code?",
      policy: { network: { enabled: false } },
    });
    const second = await waitCompleted(h, cont.run.id);
    assert.equal(second.status, "completed");
    const secondArgs = dockerCalls(fx).filter((c) => c[0] === "run").at(-1)!;
    assert.equal(secondArgs[secondArgs.indexOf("--network") + 1], "none", "continuation override applied");
  } finally {
    restore();
  }
});

test("v4 §30: keep-alive — same task reuses the container, another task does not", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "ka-dump.jsonl");
  try {
    const h = await freshHarness();
    const { model, ws, runtime } = await setupStack(h, fx, dumpPath, {
      containerized: true,
      provider: { name: "KA Prov", apiKey: "sk-ka-1" },
      lifecycle: { mode: "keep-alive", idleTimeoutMs: 60_000 },
    });

    /* Run #1: fresh keep-alive container, retained after success. */
    const { task, run } = await h.runService.submit({
      prompt: "Remember ORBIT-31. Reply OK.",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, run.id);
    assert.ok(
      h.runService.events(run.id).some((e) => e.type === "container.retained"),
      "container retained after run #1"
    );
    assert.equal(h.runService.keptContainers().length, 1);
    const runCalls1 = dockerCalls(fx).filter((c) => c[0] === "run" && c.includes("-d")).length;
    assert.equal(runCalls1, 1, "exactly one container was created");
    const containerName = `af-keep-${runtime.id}-${task.id}`;
    assert.ok(
      dockerCalls(fx).some((c) => c[0] === "run" && c[c.indexOf("--name") + 1] === containerName),
      "keep-alive container is scoped to runtime + task (v4 §21)"
    );

    /* Same task continues → the retained container is reused via exec. */
    const cont = await h.runService.continueTask(task.id, { prompt: "The word?" });
    await waitCompleted(h, cont.run.id);
    assert.ok(
      h.runService.events(cont.run.id).some((e) => e.type === "container.reused"),
      "same-task continuation reused the container"
    );
    assert.equal(
      dockerCalls(fx).filter((c) => c[0] === "run" && c.includes("-d")).length,
      1,
      "no second container was created for the same task"
    );
    assert.ok(
      dockerCalls(fx).some((c) => c[0] === "exec" && c.includes(containerName)),
      "the harness ran inside the kept container"
    );

    /* A different task on the same runtime+workspace never inherits it. */
    const other = await h.runService.submit({
      title: "Unrelated task",
      prompt: "Fresh start. Reply OK.",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, other.run.id);
    assert.ok(
      !h.runService.events(other.run.id).some((e) => e.type === "container.reused"),
      "an unrelated task must not reuse task A's container (v4 §21/§22)"
    );
    assert.equal(
      dockerCalls(fx).filter((c) => c[0] === "run" && c.includes("-d")).length,
      2,
      "the unrelated task created its own container"
    );
  } finally {
    restore();
  }
});

test("v4 §23/§24: cancelling a keep-alive run stops the in-container harness and destroys the container", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "cancel-dump.jsonl");
  try {
    const h = await freshHarness();
    const { model, ws, runtime } = await setupStack(h, fx, dumpPath, {
      containerized: true,
      provider: { name: "Cancel Prov", apiKey: "sk-cxl-1" },
      lifecycle: { mode: "keep-alive", idleTimeoutMs: 60_000 },
      runtimeEnv: { FAKE_PI_SLEEP_MS: "12000" },
    });

    // Run the slow harness inside the keep-alive container (the fake pi
    // holds the run open via FAKE_PI_SLEEP_MS).
    const { task, run } = await h.runService.submit({
      prompt: "Remember VEGA-9. Reply OK.",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
      timeoutMs: 60_000,
    });
    // Wait until the harness process is genuinely running, then cancel.
    const deadline = Date.now() + 15_000;
    while (h.runService.get(run.id)!.status !== "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(h.runService.get(run.id)!.status, "running");
    await h.runService.cancel(run.id);

    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "cancelled", finished.error);

    const calls = dockerCalls(fx);
    // The platform killed the harness process *inside* the container,
    // not just the local docker exec client (v4 §23)…
    const pkill = calls.find((c) => c[0] === "exec" && c.includes("pkill"));
    assert.ok(pkill, "docker exec pkill was issued against the container");
    assert.ok(pkill!.includes("-9"));
    // …and the uncertain-state container was destroyed, never retained
    // as reusable (v4 §24).
    const rm = calls.find((c) => c[0] === "rm" && c.includes("-f"));
    assert.ok(rm, "the keep-alive container was destroyed after the abort");
    assert.ok(
      !h.runService.events(run.id).some((e) => e.type === "container.retained"),
      "an aborted keep-alive run never retains its container"
    );
    assert.equal(h.runService.keptContainers().length, 0, "no lease left behind");
  } finally {
    restore();
  }
});

test("v4 §23: timeout aborts a keep-alive run the same way as cancel", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "timeout-dump.jsonl");
  try {
    const h = await freshHarness();
    const { model, ws, runtime } = await setupStack(h, fx, dumpPath, {
      containerized: true,
      provider: { name: "Timeout Prov", apiKey: "sk-tmo-1" },
      lifecycle: { mode: "keep-alive", idleTimeoutMs: 60_000 },
      runtimeEnv: { FAKE_PI_SLEEP_MS: "12000" },
    });

    const { run } = await h.runService.submit({
      prompt: "Remember LYRA-3. Reply OK.",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
      timeoutMs: 1_500,
    });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "timeout", finished.error);
    const calls = dockerCalls(fx);
    assert.ok(calls.find((c) => c[0] === "exec" && c.includes("pkill")), "harness process killed in-container");
    assert.ok(calls.find((c) => c[0] === "rm" && c.includes("-f")), "container destroyed");
    assert.equal(h.runService.keptContainers().length, 0);
  } finally {
    restore();
  }
});

test("v4 §7: supported model parameters reach the pi harness", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const dumpPath = join(fx.dir, "params-dump.jsonl");
  try {
    const h = await freshHarness();
    const { model, ws, runtime } = await setupStack(h, fx, dumpPath, {
      provider: { name: "Param Prov", apiKey: "sk-par-1" },
      modelParams: { maxTokens: 777, contextWindow: 200000, thinking: "high", temperature: 0.9 },
    });

    const { run } = await h.runService.submit({
      prompt: "Reply OK",
      runtimeId: runtime.id,
      modelId: model.id,
      workspaceId: ws.id,
    });
    await waitCompleted(h, run.id);

    const dump = readDumps(dumpPath).at(-1)!;
    const entry = dump.modelsJson!.providers!["param-prov"]!;
    const modelEntry = (entry.models as Array<Record<string, unknown>>).find((m) => m.id === "ds-flash-e2e")!;
    assert.equal(modelEntry.maxTokens, 777);
    assert.equal(modelEntry.contextWindow, 200000);
    const thinkIdx = dump.argv.indexOf("--thinking");
    assert.equal(dump.argv[thinkIdx + 1], "high");
    // temperature remains explicitly warned (never silently ignored).
    assert.ok(
      h.runService
        .events(run.id)
        .some((e) => e.level === "warn" && ((e.data as any)?.unsupported ?? []).includes("temperature"))
    );
  } finally {
    restore();
  }
});
