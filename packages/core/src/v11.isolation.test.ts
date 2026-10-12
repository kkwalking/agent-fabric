/**
 * v11 Hardening §3/§4/§5/§6/§25/§26 + v12 §9 — runtime isolation and the
 * Validation Agent's trust boundary.
 *
 * The promise under test:
 *
 *   Project Coding Task  → isolated runtime, always
 *   Validation Agent     → the same isolated runtime path, never more
 *                           privilege than the development agent
 *
 * Nothing here relies on a runtime's *name*: every decision is driven by the
 * declared isolation metadata (`executionBackend` / `containerized` /
 * `image`), which is exactly what the production gate reads.
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
import { createGitOps } from "./git.js";
import { validationJudgePaths } from "./provisioning.js";
import { VALIDATION_TOOL_CONTAINER_PATH, type VerdictPayload } from "./validation.js";
import { executionBackendOf, runtimeIsolation } from "./types.js";
import type { Project, Run, Runtime, Task } from "./types.js";

const execFileAsync = promisify(execFile);

const savedEnv: Record<string, string | undefined> = {};
before(() => {
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    savedEnv[key] = process.env[key];
    process.env[key] = key.includes("AUTHOR") ? "AgentFabric Test" : "af@example.test";
  }
  process.env.GIT_AUTHOR_NAME = "AgentFabric Test";
  process.env.GIT_AUTHOR_EMAIL = "af@example.test";
  process.env.GIT_COMMITTER_NAME = "AgentFabric Test";
  process.env.GIT_COMMITTER_EMAIL = "af@example.test";
  // A host-only secret: the value must never become visible to a validation
  // command (v11 hardening §6.1/AC-7, §26 Case B/C).
  process.env.AGENTFABRIC_HOST_ONLY_SECRET = "AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK";
});
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.AGENTFABRIC_HOST_ONLY_SECRET;
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return String(stdout);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function makeRemote(): Promise<{ remote: string; seed: string; baseSha: string }> {
  const root = tempDir("af-iso-remote-");
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await git(seed, ["init", "--quiet"]);
  await git(seed, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--quiet", "-m", "initial commit"]);
  const baseSha = (await git(seed, ["rev-parse", "HEAD"])).trim();
  const remote = join(root, "remote.git");
  await git(root, ["clone", "--quiet", "--bare", seed, remote]);
  return { remote, seed, baseSha };
}

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
  dataDir: string;
  agentRuns: number;
  agentEnvs: Record<string, string>[];
  /** The judge runs' environments and contexts — the trust-boundary read. */
  judgeEnvs: Record<string, string>[];
  judgeContexts: RuntimeContext[];
  judgeRuns: number;
  setAgent: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
  setJudge: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
}

/**
 * A scripted harness whose isolation is *declared* through runtime metadata,
 * not through its adapter. The adapter records what context it was handed —
 * which is what the credential-isolation assertions read — and dispatches the
 * Validation Agent (v12 §4.1) to its own scripted handler.
 */
async function makeHarness(options: { supervisor?: ConstructorParameters<typeof ExecutionSupervisor>[3] } = {}): Promise<Harness> {
  const dataDir = tempDir("af-iso-data-");
  const store = await Store.open(dataDir);
  const bus = new EventBus();
  const state = {
    agentRuns: 0,
    judgeRuns: 0,
    agentEnvs: [] as Record<string, string>[],
    judgeEnvs: [] as Record<string, string>[],
    judgeContexts: [] as RuntimeContext[],
    handler: async () => ({ exitCode: 0 }) as RuntimeResult,
    judgeHandler: async () => ({ exitCode: 0 }) as RuntimeResult,
  };
  const adapter: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Scripted harness",
    capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
    async run(ctx) {
      if (ctx.run.purpose === "validation") {
        state.judgeRuns += 1;
        state.judgeEnvs.push({ ...ctx.env });
        state.judgeContexts.push(ctx);
        return state.judgeHandler(ctx);
      }
      state.agentRuns += 1;
      state.agentEnvs.push({ ...ctx.env });
      return state.handler(ctx);
    },
  };
  const registry = new RuntimeRegistry();
  registry.register(adapter);
  const runService = new RunService(store, bus, registry, { destroy: async () => {} }, undefined, {});
  const supervisor = new ExecutionSupervisor(store, bus, runService, { ...(options.supervisor ?? {}) });
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
    dataDir,
    get agentRuns() {
      return state.agentRuns;
    },
    get agentEnvs() {
      return state.agentEnvs;
    },
    get judgeEnvs() {
      return state.judgeEnvs;
    },
    get judgeContexts() {
      return state.judgeContexts;
    },
    get judgeRuns() {
      return state.judgeRuns;
    },
    setAgent: (handler) => {
      state.handler = handler;
    },
    setJudge: (handler) => {
      state.judgeHandler = handler;
    },
  };
}

/** Where one judge run's verdict is read from — the provisioning derivation. */
function judgeVerdictPath(dataDir: string, judgeRunId: string): string {
  return join(validationJudgePaths(dataDir, judgeRunId, true).outputHostDir, "verdict.json");
}

/** A scripted judge that writes one payload per run, in order. */
function judgeScript(
  h: { dataDir: string },
  verdicts: VerdictPayload[]
): (ctx: RuntimeContext) => Promise<RuntimeResult> {
  let index = 0;
  return async (ctx) => {
    const payload = verdicts[Math.min(index, verdicts.length - 1)];
    index += 1;
    const file = judgeVerdictPath(h.dataDir, ctx.run.id);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    return { exitCode: 0 };
  };
}

function verdict(overrides: Partial<VerdictPayload> = {}): VerdictPayload {
  return {
    passed: true,
    summary: "The acceptance standard is met.",
    unmet: [],
    evidence: ["`ls` → the expected files are present"],
    ...overrides,
  };
}

async function startTask(
  h: Harness,
  project: Project,
  input: Partial<Parameters<ExecutionSupervisor["startTask"]>[0]> = {}
): Promise<{ task: Task; run: Run }> {
  const result = await h.supervisor.startTask({
    projectId: project.id,
    instruction: "Add a feature",
    ...input,
  });
  await h.supervisor.whenSettled(result.task.id);
  return { task: h.tasks.get(result.task.id)!, run: h.runService.get(result.run.id)! };
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

/* ================================================================== */
/* 1. The isolation verdict itself (§4.2)                              */
/* ================================================================== */

describe("v11 hardening: runtime isolation metadata", () => {
  test("the verdict is read from capability metadata, never from the name", () => {
    const isolated: Pick<Runtime, "name" | "containerized" | "executionBackend" | "image"> = {
      name: "not-docker-but-isolated",
      containerized: true,
      image: "node:22-alpine",
    };
    assert.equal(runtimeIsolation(isolated).sandboxed, true);
    assert.equal(runtimeIsolation(isolated).executionBackend, "isolated");

    // A runtime *named* docker that declares host execution is not isolated.
    const hostNamedDocker: Pick<Runtime, "name" | "containerized" | "executionBackend" | "image"> = {
      name: "docker",
      containerized: false,
      executionBackend: "host",
    };
    assert.equal(runtimeIsolation(hostNamedDocker).sandboxed, false);
  });

  test("a legacy record is read through `containerized` (no migration needed)", () => {
    assert.equal(executionBackendOf({ containerized: true }), "isolated");
    assert.equal(executionBackendOf({ containerized: false }), "host");
    assert.equal(executionBackendOf({ containerized: false, executionBackend: "isolated" }), "isolated");
  });

  test("isolated execution without a container or an image is not an isolation guarantee", () => {
    assert.equal(runtimeIsolation({ name: "a", containerized: true, executionBackend: "isolated" }).sandboxed, false);
    assert.equal(runtimeIsolation({ name: "b", containerized: false, executionBackend: "isolated", image: "x" }).sandboxed, false);
    assert.equal(runtimeIsolation({ name: "c", containerized: true, executionBackend: "isolated", image: "x" }).sandboxed, true);
  });
});

/* ================================================================== */
/* 2. Host Escape Tests (§25, AC-1/AC-2)                               */
/* ================================================================== */

describe("v11 hardening: Project tasks cannot escape to a host runtime", () => {
  test("AC-1/AC-2: a Project Coding Task on a local runtime is rejected before execution", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const local = await h.runtimes.create({
      name: "Local host runtime",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: false,
    });

    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "x", runtimeId: local.id }),
      (err: unknown) => {
        assert.equal((err as DomainError).code, "runtime-not-isolated");
        assert.equal((err as DomainError).stage, "runtime");
        return true;
      }
    );

    // Refused *before* anything ran: no task, no workspace, no run, no agent.
    assert.equal(h.tasks.list().length, 0, "no task was created");
    assert.equal(h.workspaces.list().length, 0, "no workspace was created");
    assert.equal(h.runService.list().length, 0, "no run was created");
    assert.equal(h.agentRuns, 0, "the agent never started");
  });

  test("a containerized runtime with no image is refused too (it cannot start)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const imageless = await h.runtimes.create({
      name: "Containerized but imageless",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
    });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "x", runtimeId: imageless.id }),
      (err: unknown) => (err as DomainError).code === "runtime-not-isolated"
    );
    assert.equal(h.agentRuns, 0);
  });

  test("a project default runtime is gated the same way as an explicit override", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const local = await h.runtimes.create({
      name: "Local host runtime",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: false,
    });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { runtimeId: local.id },
    });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "x" }),
      (err: unknown) => (err as DomainError).code === "runtime-not-isolated"
    );
    assert.equal(h.agentRuns, 0);
  });

  test("with no isolated runtime available, the task is refused rather than silently downgraded", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    await h.runtimes.create({ name: "Only local", kind: "custom", usableInTask: true, enabled: true, containerized: false });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "x" }),
      (err: unknown) => (err as DomainError).code === "runtime-not-isolated"
    );
  });

  test("the isolation gate is not a name check: an isolated runtime of any kind is accepted", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const isolated = await h.runtimes.create({
      name: "Anything at all",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project, { runtimeId: isolated.id });
    assert.equal(task.execution!.status, "completed");
    assert.equal(h.agentRuns, 1);
  });

  test("the advanced policy is the only way to allow host execution, and it is explicit", async () => {
    const h = await makeHarness({ supervisor: { allowHostExecution: true } });
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const local = await h.runtimes.create({
      name: "Local host runtime",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: false,
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project, { runtimeId: local.id });
    // Allowed by explicit operator policy. The judge would run on the same
    // runtime: under v12 §9.3 validation's trust level equals the agent's, so
    // there is deliberately no separate gate left to disagree with this one.
    assert.equal(task.execution!.agent!.status, "completed");
  });

  test("a task request cannot grant itself host execution", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const local = await h.runtimes.create({
      name: "Local host runtime",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: false,
    });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    // `allowHostExecution` on the *project* is the operator surface; the
    // request body has no such field and cannot smuggle one in.
    await assert.rejects(
      () =>
        h.supervisor.startTask({
          projectId: project.id,
          instruction: "x",
          runtimeId: local.id,
          metadata: { allowHostExecution: true },
        } as Parameters<ExecutionSupervisor["startTask"]>[0]),
      (err: unknown) => (err as DomainError).code === "runtime-not-isolated"
    );
  });
});

/* ================================================================== */
/* 3. The Validation Agent's trust boundary (v12 §9)                   */
/* ================================================================== */

describe("v11 hardening: the Validation Agent runs as a normal, no-more-privileged run", () => {
  test("AC-5/AC-6: the judge is a Run through the task's isolated runtime, never a host shell", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the feature file exists" },
    });
    const isolated = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFiles({ "feature.txt": "ok\n" }));
    h.setJudge(judgeScript(h, [verdict()]));

    const { task, run } = await startTask(h, project, { runtimeId: isolated.id });
    assert.equal(task.execution!.validation!.status, "passed");

    // The judge ran exactly once, on the task's own runtime — the same
    // isolation path the development agent uses (v12 §9.3).
    assert.equal(h.judgeRuns, 1);
    const judgeCtx = h.judgeContexts[0];
    assert.equal(judgeCtx.runtime.id, isolated.id);
    assert.equal(judgeCtx.run.purpose, "validation");
    // The judge's subject is the frozen workspace, mounted read-only.
    assert.equal(judgeCtx.workspacePath, h.workspaces.get(task.workspaceId!)!.path);
    assert.equal(judgeCtx.policy?.filesystem?.readOnly, true, "the workspace is read-only for the judge");
    // The judge gets a fresh, disposable container — never a kept one: under
    // keep-alive the lease manager would hand it the development agent's
    // read-write container and the read-only guarantee would be a fiction.
    assert.equal(judgeCtx.lifecycle.mode, "ephemeral");

    // Its verdict output directory is the one write it may make, outside the
    // workspace, mapped read-write (the tool itself stays read-only).
    assert.deepEqual(judgeCtx.writableMounts, [
      {
        hostPath: validationJudgePaths(h.dataDir, judgeCtx.run.id, true).outputHostDir,
        containerPath: "/root/.agentfabric/validation-output",
      },
    ]);
    assert.deepEqual(judgeCtx.extraMounts, [
      { hostPath: join(validationJudgePaths(h.dataDir, judgeCtx.run.id, true).hostDir, "validation-tool.mjs"), containerPath: VALIDATION_TOOL_CONTAINER_PATH },
    ]);

    const types = (await h.store.readEvents(run.id)).map((e) => e.type);
    assert.ok(types.includes("validation.round.started"));
    assert.ok(types.includes("validation.passed"));
  });

  test("AC-7/§26 Case C: the judge does not inherit the host process environment", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "anything" },
    });
    const isolated = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [verdict()]));
    await startTask(h, project, { runtimeId: isolated.id });

    const env = h.judgeEnvs[0];
    // The host-only secret exists in *this* process and must not appear.
    assert.equal(process.env.AGENTFABRIC_HOST_ONLY_SECRET, "AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK");
    assert.equal(JSON.stringify(env).includes("AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK"), false);
    for (const key of ["GIT_ASKPASS", "AGENTFABRIC_GIT_PASSWORD", "SSH_ASKPASS"]) {
      assert.equal(env[key], undefined, `${key} must not reach the judge`);
    }
    // The platform hands the judge the verdict channel it must use.
    assert.equal(env.AGENTFABRIC_VALIDATION_OUTPUT, "/root/.agentfabric/validation-output");
  });

  test("§26 Case D/AC-8: the judge cannot reach the Git Source Credential", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const token = "AGENTFABRIC_TEST_SECRET_DO_NOT_LEAK";
    const credentials = new SourceCredentialService(h.store);
    const view = await credentials.create({
      name: "Private",
      type: "https-token",
      host: "example.test",
      value: token,
    });
    // The remote is a local path, so no host binding applies.
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote, credentialId: view.id },
      validation: { prompt: "anything" },
    });
    const isolated = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    // The judge's own report deliberately echoes its whole environment, so a
    // match could only come from the environment itself.
    h.setJudge(async (ctx) => {
      const file = judgeVerdictPath(h.dataDir, ctx.run.id);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify(verdict({ evidence: [`env dump → ${JSON.stringify(ctx.env)}`] }), null, 2)}\n`
      );
      return { exitCode: 0 };
    });
    const { task, run } = await startTask(h, project, { runtimeId: isolated.id });

    // The credential never reached the judge's environment.
    assert.equal(JSON.stringify(h.judgeEnvs[0]).includes(token), false);
    assert.equal(JSON.stringify(h.agentEnvs[0]).includes(token), false);
    // Nor the judge's own output (a full env dump travels in its verdict).
    assert.equal(JSON.stringify(task.execution).includes(token), false);
    // Nor the events or the records.
    const events = JSON.stringify(await h.store.readEvents(run.id));
    assert.equal(events.includes(token), false);
    assert.equal(JSON.stringify(h.store.list("tasks")).includes(token), false);
    assert.equal(JSON.stringify(h.store.list("runs")).includes(token), false);
  });

  test("§26 Case E/AC-27: a failed verdict leaves agent.status completed", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "no type errors", maxAttempts: 1 },
    });
    const isolated = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(
      judgeScript(h, [
        verdict({ passed: false, summary: "Type errors remain.", unmet: ["no type errors"], evidence: ["`tsc` → 2 errors"] }),
      ])
    );
    const { task } = await startTask(h, project, { runtimeId: isolated.id });

    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.validation!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "validation");
    assert.equal(task.execution!.status, "failed");
    // The stage record says the same thing (v11 hardening §36).
    assert.equal(task.execution!.stages!.agent!.status, "completed");
    assert.equal(task.execution!.stages!.validation!.status, "failed");
    // Nothing was published after a failed validation.
    assert.equal(task.execution!.publish!.status, "pending");
  });

  test("a task-level validation override still uses the isolated runtime, and retry re-judges", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the ready flag exists", maxAttempts: 1 },
    });
    const isolated = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(
      judgeScript(h, [
        verdict({ passed: false, summary: "Flag missing.", unmet: ["ready.flag exists"], evidence: ["`ls` → nothing"] }),
        verdict(),
      ])
    );
    const { task } = await startTask(h, project, { runtimeId: isolated.id });
    assert.equal(task.execution!.validation!.status, "failed");
    assert.equal(h.judgeRuns, 1);

    writeFileSync(join(h.workspaces.get(task.workspaceId!)!.path!, "ready.flag"), "ok\n");
    const after = await h.supervisor.retryValidation(task.id);
    assert.equal(after!.execution!.validation!.status, "passed");
    assert.equal(after!.execution!.agent!.status, "completed", "the agent is not re-run");
    assert.equal(h.agentRuns, 1);
    // The retry ran as another judge Run — never on the host.
    assert.equal(h.judgeRuns, 2);
    assert.equal(h.judgeContexts[1].runtime.id, isolated.id);
    assert.equal(h.judgeContexts[1].policy?.filesystem?.readOnly, true);
  });
});
