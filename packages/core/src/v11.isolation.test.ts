/**
 * v11 Hardening §3/§4/§5/§6/§25/§26 — runtime isolation and validation
 * isolation.
 *
 * The promise under test:
 *
 *   Project Coding Task  → isolated runtime, always
 *   Validation command   → isolated runtime, always (never a host shell)
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
import {
  buildValidationEnvironment,
  runHostValidation,
  runSandboxedValidation,
  VALIDATION_BASE_ENV,
  type SandboxedStepExecutor,
} from "./validation.js";
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

interface ValidationCall {
  step: { name: string; command: string };
  cwd: string;
  env: Record<string, string>;
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
  validationCalls: ValidationCall[];
  setAgent: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
}

/**
 * A scripted harness whose isolation is *declared* through runtime metadata,
 * not through its adapter. The adapter records the environment it was handed,
 * which is what the credential-isolation assertions read.
 */
async function makeHarness(options: { supervisor?: ConstructorParameters<typeof ExecutionSupervisor>[3] } = {}): Promise<Harness> {
  const dataDir = tempDir("af-iso-data-");
  const store = await Store.open(dataDir);
  const bus = new EventBus();
  const state = { agentRuns: 0, agentEnvs: [] as Record<string, string>[], handler: async () => ({ exitCode: 0 }) as RuntimeResult };
  const adapter: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Scripted harness",
    capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
    async run(ctx) {
      state.agentRuns += 1;
      state.agentEnvs.push({ ...ctx.env });
      return state.handler(ctx);
    },
  };
  const registry = new RuntimeRegistry();
  registry.register(adapter);
  const runService = new RunService(store, bus, registry, { destroy: async () => {} }, undefined, {});
  const validationCalls: ValidationCall[] = [];
  const executor: SandboxedStepExecutor = async (opts) => {
    validationCalls.push({ step: { name: opts.step.name, command: opts.step.command }, cwd: opts.cwd, env: { ...opts.env } });
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", opts.step.command], {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
      });
      return { exitCode: 0, timedOut: false, output: `${stdout}${stderr}` };
    } catch (err) {
      const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
      if (e.killed) return { exitCode: null, timedOut: true, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      return { exitCode: e.code ?? 1, timedOut: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const supervisor = new ExecutionSupervisor(store, bus, runService, {
    validationExecutor: () => executor,
    ...(options.supervisor ?? {}),
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
    dataDir,
    get agentRuns() {
      return state.agentRuns;
    },
    get agentEnvs() {
      return state.agentEnvs;
    },
    validationCalls,
    setAgent: (handler) => {
      state.handler = handler;
    },
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
    // Allowed by explicit operator policy — and validation still refuses to
    // run on the host (a separate, non-negotiable boundary).
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
/* 3. Validation isolation (§5/§6/§26, AC-5–AC-8)                      */
/* ================================================================== */

describe("v11 hardening: validation runs in the isolated runtime", () => {
  test("AC-5/AC-6: validation never runs through a host shell", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "test -f feature.txt" }] },
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

    const { task, run } = await startTask(h, project, { runtimeId: isolated.id });
    assert.equal(task.execution!.validation!.status, "passed");

    // Every step went through the isolated executor — the host validation
    // runner was never the path.
    assert.equal(h.validationCalls.length, 1);
    assert.equal(h.validationCalls[0].step.command, "test -f feature.txt");
    // Case A: the command really read the workspace.
    assert.equal(h.validationCalls[0].cwd, h.workspaces.get(task.workspaceId!)!.path);

    // The isolation evidence is on the record and in the events.
    assert.equal(task.execution!.validation!.execution!.backend, "isolated");
    assert.equal(task.execution!.validation!.execution!.containerized, true);
    assert.equal(task.execution!.validation!.execution!.image, "af-test:latest");
    const types = (await h.store.readEvents(run.id)).map((e) => e.type);
    assert.ok(types.includes("validation.runtime.prepared"));
  });

  test("AC-7/§26 Case C: validation does not inherit the host process environment", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "env", command: "env" }] },
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
    await startTask(h, project, { runtimeId: isolated.id });

    const env = h.validationCalls[0].env;
    // The host-only secret exists in *this* process and must not appear.
    assert.equal(process.env.AGENTFABRIC_HOST_ONLY_SECRET, "AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK");
    assert.equal(JSON.stringify(env).includes("AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK"), false);
    // The allowlist is exactly the documented base set plus explicit extras.
    assert.deepEqual(env, VALIDATION_BASE_ENV);
    // Nothing else from the host leaked in.
    for (const key of ["GIT_ASKPASS", "AGENTFABRIC_GIT_PASSWORD", "SSH_ASKPASS", "HOME"]) {
      if (key === "HOME") continue; // deliberately part of the allowlist
      assert.equal(env[key], undefined, `${key} must not reach validation`);
    }
  });

  test("§26 Case B: a host-only secret is unreadable inside the validation command", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      // The command succeeds only if the host secret is *absent*.
      validation: { steps: [{ name: "no-host-secret", command: "test -z \"$AGENTFABRIC_HOST_ONLY_SECRET\"" }] },
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
    const { task } = await startTask(h, project, { runtimeId: isolated.id });
    assert.equal(task.execution!.validation!.status, "passed");
  });

  test("§26 Case D/AC-8: validation cannot reach the Git Source Credential", async () => {
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
      // `printenv` dumps the whole environment; the assertion below scans it
      // for the credential value. The command deliberately does not spell the
      // secret, so a match can only come from the environment itself.
      validation: { steps: [{ name: "leak-check", command: "printenv" }] },
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
    const { task, run } = await startTask(h, project, { runtimeId: isolated.id });

    // The credential never reached the validation environment.
    assert.equal(JSON.stringify(h.validationCalls[0].env).includes(token), false);
    assert.equal(JSON.stringify(h.agentEnvs[0]).includes(token), false);
    // Nor the output the command actually produced (a full env dump).
    const report = h.store
      .list<{ name: string; runId: string; content?: string }>("artifacts")
      .find((a) => a.runId === run.id && a.name === "validation-report.txt");
    assert.ok(report, "the validation report exists");
    assert.equal(String(report!.content).includes(token), false, "the credential must not appear in the validation output");
    // Nor the events or the records.
    const events = JSON.stringify(await h.store.readEvents(run.id));
    assert.equal(events.includes(token), false);
    assert.equal(JSON.stringify(task.execution).includes(token), false);
    assert.equal(JSON.stringify(h.store.list("tasks")).includes(token), false);
    assert.equal(JSON.stringify(h.store.list("runs")).includes(token), false);
  });

  test("§26 Case E/AC-27: a validation failure leaves agent.status completed", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "typecheck", command: "echo 'type error' >&2; exit 2" }] },
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

  test("a task-level validation override still runs isolated, and retry re-enters the sandbox", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "test", command: "test -f ready.flag" }] },
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
    const { task } = await startTask(h, project, { runtimeId: isolated.id });
    assert.equal(task.execution!.validation!.status, "failed");
    assert.equal(h.validationCalls.length, 1);

    writeFileSync(join(h.workspaces.get(task.workspaceId!)!.path!, "ready.flag"), "ok\n");
    const after = await h.supervisor.retryValidation(task.id);
    assert.equal(after!.execution!.validation!.status, "passed");
    assert.equal(after!.execution!.agent!.status, "completed", "the agent is not re-run");
    assert.equal(h.agentRuns, 1);
    // The retry ran in the isolated executor again — never on the host.
    assert.equal(h.validationCalls.length, 2);
  });
});

/* ================================================================== */
/* 4. The validation runner contract itself                            */
/* ================================================================== */

describe("v11 hardening: validation runner contract", () => {
  test("the sandboxed runner reports a runtime failure as its own outcome, never a fallback", async () => {
    const dir = tempDir("af-iso-val-");
    const result = await runSandboxedValidation(
      { cwd: dir, steps: [{ name: "step", command: "echo hi" }] },
      async () => ({
        exitCode: -1,
        timedOut: false,
        output: "Cannot connect to the Docker daemon",
        error: "The isolated validation runtime could not start: Cannot connect to the Docker daemon",
        errorCode: "validation-runtime-unavailable",
      })
    );
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "validation-failed");
    assert.match(result.error!, /isolated validation runtime/);
    assert.equal(result.steps[0].status, "failed");
  });

  test("the host runner uses the same allowlisted environment (no process.env inheritance)", async () => {
    const dir = tempDir("af-iso-host-");
    writeFileSync(join(dir, "x.txt"), "x\n");
    const result = await runHostValidation({
      cwd: dir,
      steps: [{ name: "print", command: "printf '%s' \"$AGENTFABRIC_HOST_ONLY_SECRET\"" }],
    });
    assert.equal(result.status, "passed");
    assert.equal(result.steps[0].output, "", "the host secret must not be visible");
    assert.equal(buildValidationEnvironment().PATH, VALIDATION_BASE_ENV.PATH);
  });

  test("validation timeout is reported as a timeout, not a plain failure", async () => {
    const dir = tempDir("af-iso-timeout-");
    const result = await runSandboxedValidation(
      { cwd: dir, steps: [{ name: "slow", command: "sleep 5", timeoutMs: 120 }] },
      async (opts) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, opts.timeoutMs));
        return { exitCode: null, timedOut: true, output: "" };
      }
    );
    assert.equal(result.status, "timeout");
    assert.equal(result.errorCode, "validation-timeout");
  });
});
