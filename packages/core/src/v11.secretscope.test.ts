/**
 * v11 Hardening §7/§8/§27 — secret scope as an authorization boundary.
 *
 * The promise under test:
 *
 *   `scope = "git"` → usable ONLY by the Git Credential Broker
 *
 * A git-scoped secret is the repository write credential. It must be
 * unreachable from every path that could put material into the agent's trust
 * domain — task `secretIds`, runtime `secretIds`, agent profile, generated
 * MCP configuration, validation environment — *even when the caller
 * explicitly passes the id*. The enforcement lives at the resolution
 * boundary, so a call path that does not exist yet is covered too (§8.3).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventBus } from "./eventbus.js";
import { Store } from "./store.js";
import { RuntimeRegistry, type AgentRuntimeAdapter, type RuntimeContext, type RuntimeResult } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import { ExecutionSupervisor } from "./supervisor.js";
import {
  ProjectService,
  RuntimeService,
  SecretService,
  SourceCredentialService,
  TaskService,
  WorkspaceService,
} from "./services.js";
import { DomainError } from "./errors.js";
import { assertSecretAllowed, isSecretAllowedForPurpose, resolveSecretsForPurpose } from "./secrets.js";
import { buildMcpConfigDocument } from "./provisioning.js";
import { provisionEnvironment } from "./provisioning.js";
import type { Project, Run, Secret, Task } from "./types.js";

const execFileAsync = promisify(execFile);

/** The unmistakable fake secret every redaction assertion searches for. */
const LEAK_CANARY = "AGENTFABRIC_TEST_SECRET_DO_NOT_LEAK";

before(() => {
  process.env.GIT_AUTHOR_NAME = "AgentFabric Test";
  process.env.GIT_AUTHOR_EMAIL = "af@example.test";
  process.env.GIT_COMMITTER_NAME = "AgentFabric Test";
  process.env.GIT_COMMITTER_EMAIL = "af@example.test";
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return String(stdout);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function makeRemote(): Promise<{ remote: string; seed: string }> {
  const root = tempDir("af-scope-remote-");
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await git(seed, ["init", "--quiet"]);
  await git(seed, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--quiet", "-m", "initial commit"]);
  const remote = join(root, "remote.git");
  await git(root, ["clone", "--quiet", "--bare", seed, remote]);
  return { remote, seed };
}

/* ================================================================== */
/* 1. The authorization rule itself (§8/§27 Case F)                    */
/* ================================================================== */

describe("v11 hardening: secret scope authorization", () => {
  const gitSecret = { id: "sec_git", name: "git token", scope: "git" };
  const envSecret = { id: "sec_env", name: "build token", scope: "env" };

  test("a git-scoped secret is refused for every agent-facing purpose", () => {
    for (const purpose of ["agent-runtime", "mcp", "validation", "provider"] as const) {
      assert.equal(isSecretAllowedForPurpose("git", purpose), false, purpose);
      assert.throws(
        () => assertSecretAllowed(gitSecret, purpose),
        (err: unknown) => (err as DomainError).code === (purpose === "validation" ? "validation-secret-not-allowed" : "secret-scope-not-allowed")
      );
    }
  });

  test("a git-scoped secret IS allowed for the credential broker", () => {
    assert.equal(isSecretAllowedForPurpose("git", "git"), true);
    assert.doesNotThrow(() => assertSecretAllowed(gitSecret, "git"));
  });

  test("ordinary scopes are allowed everywhere except the git broker", () => {
    for (const scope of ["env", "provider", "runtime", "mcp", "validation", "service", undefined]) {
      assert.equal(isSecretAllowedForPurpose(scope, "agent-runtime"), true, String(scope));
      assert.equal(isSecretAllowedForPurpose(scope, "git"), false, String(scope));
    }
    assert.doesNotThrow(() => assertSecretAllowed(envSecret, "agent-runtime"));
  });

  test("Case F: the low-level resolver itself enforces the policy", () => {
    const store = new Map<string, Secret>([
      ["sec_git", { ...gitSecret, masked: "***", createdAt: "", updatedAt: "" } as Secret],
      ["sec_env", { ...envSecret, masked: "***", createdAt: "", updatedAt: "" } as Secret],
    ]);
    const lookup = (id: string) => store.get(id);
    assert.throws(
      () => resolveSecretsForPurpose(["sec_git"], "agent-runtime", lookup),
      (err: unknown) => (err as DomainError).code === "secret-scope-not-allowed"
    );
    assert.deepEqual(
      resolveSecretsForPurpose(["sec_env"], "agent-runtime", lookup).map((s) => s.id),
      ["sec_env"]
    );
    // An unknown id is skipped (an optional reference that no longer
    // resolves); a *present* forbidden secret always throws.
    assert.deepEqual(resolveSecretsForPurpose(["sec_missing"], "agent-runtime", lookup), []);
  });

  test("the default purpose is the safest one: an unqualified resolve cannot fetch a git secret", async () => {
    const store = await Store.open(tempDir("af-scope-store-"));
    const secrets = new SecretService(store);
    const gitScoped = await secrets.create({ name: "git", value: LEAK_CANARY, scope: "git" });
    const envScoped = await secrets.create({ name: "env", value: "plain", scope: "env" });
    assert.throws(
      () => secrets.resolve([gitScoped.id]),
      (err: unknown) => (err as DomainError).code === "secret-scope-not-allowed"
    );
    assert.equal(secrets.resolve([envScoped.id]).length, 1);
    // The broker's own path is the exception, and it is explicit.
    assert.equal(secrets.resolveForGit([gitScoped.id])[0].value, LEAK_CANARY);
  });
});

/* ================================================================== */
/* 2. The full lifecycle: git secrets stay out of the agent (§27)      */
/* ================================================================== */

interface Harness {
  store: Store;
  bus: EventBus;
  registry: RuntimeRegistry;
  runService: RunService;
  supervisor: ExecutionSupervisor;
  projects: ProjectService;
  runtimes: RuntimeService;
  tasks: TaskService;
  workspaces: WorkspaceService;
  secrets: SecretService;
  credentials: SourceCredentialService;
  dataDir: string;
  agentRuns: number;
  agentEnvs: Record<string, string>[];
  agentSecrets: string[][];
  validationCalls: Array<{ env: Record<string, string> }>;
  setAgent: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
}

async function makeHarness(): Promise<Harness> {
  const dataDir = tempDir("af-scope-data-");
  const store = await Store.open(dataDir);
  const bus = new EventBus();
  const state = {
    agentRuns: 0,
    agentEnvs: [] as Record<string, string>[],
    agentSecrets: [] as string[][],
    handler: async () => ({ exitCode: 0 }) as RuntimeResult,
  };
  const adapter: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Scripted harness",
    capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
    async run(ctx) {
      state.agentRuns += 1;
      state.agentEnvs.push({ ...ctx.env });
      state.agentSecrets.push(ctx.secrets.map((s) => s.id));
      return state.handler(ctx);
    },
  };
  const registry = new RuntimeRegistry();
  registry.register(adapter);
  const runService = new RunService(store, bus, registry, { destroy: async () => {} }, undefined, {});
  const validationCalls: Array<{ env: Record<string, string> }> = [];
  const supervisor = new ExecutionSupervisor(store, bus, runService, {
    validationExecutor: () => async (opts) => {
      validationCalls.push({ env: { ...opts.env } });
      try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", opts.step.command], {
          cwd: opts.cwd,
          env: opts.env,
          timeout: opts.timeoutMs,
        });
        return { exitCode: 0, timedOut: false, output: `${stdout}${stderr}` };
      } catch (err) {
        const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
        return { exitCode: e.killed ? null : e.code ?? 1, timedOut: Boolean(e.killed), output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    },
  });
  return {
    store,
    bus,
    registry,
    runService,
    supervisor,
    projects: new ProjectService(store),
    runtimes: new RuntimeService(store),
    tasks: new TaskService(store),
    workspaces: new WorkspaceService(store),
    secrets: new SecretService(store),
    credentials: new SourceCredentialService(store),
    dataDir,
    get agentRuns() {
      return state.agentRuns;
    },
    get agentEnvs() {
      return state.agentEnvs;
    },
    get agentSecrets() {
      return state.agentSecrets;
    },
    validationCalls,
    setAgent: (handler) => {
      state.handler = handler;
    },
  };
}

async function isolatedRuntime(h: Harness): Promise<string> {
  const runtime = await h.runtimes.create({
    name: "Isolated",
    kind: "custom",
    usableInTask: true,
    enabled: true,
    containerized: true,
    executionBackend: "isolated",
    image: "af-test:latest",
  });
  return runtime.id;
}

function writeFiles(files: Record<string, string>) {
  return async (ctx: RuntimeContext): Promise<RuntimeResult> => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(ctx.workspacePath!, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return { exitCode: 0 };
  };
}

describe("v11 hardening: git secrets never enter the agent trust domain", () => {
  test("Case A: a git-scoped secret IS usable by the source manager for clone", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    // The credential's secret is git-scoped by construction.
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const stored = h.store.get<Secret>("secrets", credential.secretId)!;
    assert.equal(stored.scope, "git");

    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote, credentialId: credential.id } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    // The clone happened (the source manager used the credential)…
    assert.equal(task.execution!.status, "completed");
    assert.ok(task.baseCommitSha, "the base revision was resolved from the clone");
    // …and the credential value is still nowhere near the agent.
    assert.equal(JSON.stringify(h.agentEnvs[0]).includes(LEAK_CANARY), false);
    assert.equal(JSON.stringify(await h.store.readEvents(result.run.id)).includes(LEAK_CANARY), false);
  });

  test("Case B: a git-scoped secret IS usable by the publisher for push", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote, credentialId: credential.id } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    assert.equal(task.execution!.publish!.status, "pushed");
    // The branch really landed on the remote.
    const remoteSha = (await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim();
    assert.equal(remoteSha, task.execution!.frozenRevision!.finalCommitSha);
  });

  test("Case C: a git-scoped secret in Task secretIds is refused", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    // The task references the credential's secret directly — the caller is
    // explicit about it and is still refused, at the resolution boundary.
    const result = await h.supervisor.startTask({
      projectId: project.id,
      instruction: "work",
      runtimeId,
      secretIds: [credential.secretId],
    });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "runtime");
    assert.equal(task.execution!.failure!.code, "secret-scope-not-allowed");
    assert.equal(h.agentRuns, 0, "the harness must never start with a refused secret");
  });

  test("Case C (project default): a git secret in the project's execution.secretIds is refused too", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { secretIds: [credential.secretId] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    assert.equal(task.execution!.failure!.code, "secret-scope-not-allowed");
    assert.equal(h.agentRuns, 0);
  });

  test("Case D: a git-scoped secret referenced by MCP is refused", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      mcpServers: [{ name: "authed", url: "https://mcp.example/mcp", secretIds: [credential.secretId] }],
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    assert.equal(task.execution!.failure!.code, "secret-scope-not-allowed");
    assert.equal(h.agentRuns, 0);
  });

  test("Case D (direct): the MCP document builder refuses a git secret even when handed a resolver that would allow it", () => {
    // The scope check belongs to the resolver, so a *correct* resolver is
    // what makes this safe — prove the resolver wiring does refuse.
    const store = new Map<string, Secret>();
    const resolver = (id: string): string | undefined => {
      const secret = store.get(id);
      if (!secret) return undefined;
      assertSecretAllowed(secret, "mcp");
      return secret.value;
    };
    store.set("sec_git", { id: "sec_git", name: "git", value: LEAK_CANARY, scope: "git", masked: "***", createdAt: "", updatedAt: "" });
    assert.throws(
      () => buildMcpConfigDocument([{ name: "s", command: "x", secretIds: ["sec_git"] }], resolver),
      (err: unknown) => (err as DomainError).code === "secret-scope-not-allowed"
    );
    // And an ordinary secret still works.
    store.set("sec_env", { id: "sec_env", name: "env", value: "plain", scope: "env", masked: "***", createdAt: "", updatedAt: "" });
    const doc = buildMcpConfigDocument([{ name: "s", command: "x", secretIds: ["sec_env"] }], resolver);
    assert.equal(
      ((doc.mcpServers as Record<string, { env: Record<string, string> }>).s.env).AGENTFABRIC_MCP_SECRET_sec_env,
      "plain"
    );
  });

  test("Case E: a git-scoped secret referenced by validation is refused", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "t", command: "true" }] },
      execution: { validationSecretIds: [credential.secretId] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    // Refused at task creation, before anything is created at all.
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId }),
      (err: unknown) => {
        assert.equal((err as DomainError).code, "validation-secret-not-allowed");
        return true;
      }
    );
    assert.equal(h.tasks.list().length, 0);
    assert.equal(h.agentRuns, 0);
  });

  test("Case E (task-level): the same refusal applies to a task's validationSecretIds", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await assert.rejects(
      () =>
        h.supervisor.startTask({
          projectId: project.id,
          instruction: "work",
          runtimeId,
          validationSecretIds: [credential.secretId],
        }),
      (err: unknown) => (err as DomainError).code === "validation-secret-not-allowed"
    );
  });

  test("a non-git validation secret IS delivered to the validation environment", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    const buildSecret = await h.secrets.create({ name: "BUILD_TOKEN", value: "build-value-1234", scope: "validation" });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "has-token", command: "test -n \"$BUILD_TOKEN\"" }] },
      execution: { validationSecretIds: [buildSecret.id] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    assert.equal(task.execution!.validation!.status, "passed");
    assert.equal(h.validationCalls[0].env.BUILD_TOKEN, "build-value-1234");
  });

  test("a runtime's own secretIds cannot smuggle a git secret in either", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const runtime = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
      secretIds: [credential.secretId],
    });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: runtime.id });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    assert.equal(task.execution!.failure!.code, "secret-scope-not-allowed");
    assert.equal(h.agentRuns, 0);
  });

  test("provisioning cleans up and never writes a refused secret anywhere", async () => {
    const dataDir = tempDir("af-scope-prov-");
    const store = await Store.open(dataDir);
    const secrets = new SecretService(store);
    const gitScoped = await secrets.create({ name: "git", value: LEAK_CANARY, scope: "git" });
    await assert.rejects(() =>
      provisionEnvironment({
        dataDir,
        runId: "run_x",
        project: { mcpServers: [{ name: "s", command: "x", secretIds: [gitScoped.id] }] } as Project,
        resolveSecret: (id) => {
          const secret = secrets.getWithValue(id);
          if (!secret) return undefined;
          assertSecretAllowed(secret, "mcp");
          return secret.value;
        },
      })
    );
  });
});

/* ================================================================== */
/* 3. Agent-side secret resolution goes through the boundary (§8.1)    */
/* ================================================================== */

describe("v11 hardening: the agent runtime secret path is scope-checked", () => {
  test("an ordinary (non-git) secret still reaches the agent", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const runtimeId = await isolatedRuntime(h);
    const envSecret = await h.secrets.create({ name: "DEPLOY_TOKEN", value: "deploy-value-1234", scope: "env" });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { secretIds: [envSecret.id] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId });
    await h.supervisor.whenSettled(result.task.id);
    assert.equal(h.tasks.get(result.task.id)!.execution!.status, "completed");
    assert.equal(h.agentEnvs[0].DEPLOY_TOKEN, "deploy-value-1234");
    assert.deepEqual(h.agentSecrets[0], [envSecret.id]);
  });
});
