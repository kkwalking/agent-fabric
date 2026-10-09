/**
 * v11 §31 — automatic retry of transient failures.
 *
 * The promises under test:
 *
 *   an infrastructure failure is retried once, through the stage's own
 *   operation; the work itself failing is not; a cancelled task is never
 *   resurrected; and every decision is visible on the run's event stream.
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
import { ProjectService, RuntimeService, TaskService, WorkspaceService } from "./services.js";
import { DomainError } from "./errors.js";
import { createGitOps, type GitOps } from "./git.js";
import type { Project, Run, Task } from "./types.js";

const execFileAsync = promisify(execFile);

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

async function makeRemote(): Promise<{ remote: string; seed: string; baseSha: string }> {
  const root = tempDir("af-retry-remote-");
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
  runService: RunService;
  supervisor: ExecutionSupervisor;
  supervisedWith: (git: GitOps, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>) => ExecutionSupervisor;
  projects: ProjectService;
  runtimes: RuntimeService;
  tasks: TaskService;
  workspaces: WorkspaceService;
  runtimeId: string;
  agentRuns: number;
  setAgent: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
  /** The backoff waits the supervisor asked for, instead of waiting them out. */
  waits: number[];
  setValidation: (executor: () => Promise<{ exitCode: number | null; timedOut: boolean; output: string; error?: string; errorCode?: "validation-failed" | "validation-timeout" | "validation-runtime-failed" | "validation-runtime-unavailable" }>) => void;
  validationRuns: number;
}

/**
 * The publish harness (v11.publish.test.ts) with the two additions the retry
 * policy needs: a recorder `sleep` — backoff must never cost wall clock — and
 * a scriptable validation executor, so an environment failure can be injected
 * into the validation stage without docker.
 */
async function makeHarness(): Promise<Harness> {
  const dataDir = tempDir("af-retry-data-");
  const store = await Store.open(dataDir);
  const bus = new EventBus();
  const state = {
    agentRuns: 0,
    handler: async () => ({ exitCode: 0 }) as RuntimeResult,
    validationRuns: 0,
    validator: async () => ({ exitCode: 0, timedOut: false, output: "" }),
  };
  const adapter: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Scripted harness",
    capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
    async run(ctx) {
      state.agentRuns += 1;
      return state.handler(ctx);
    },
  };
  const registry = new RuntimeRegistry();
  registry.register(adapter);
  const runService = new RunService(store, bus, registry, { destroy: async () => {} }, undefined, {});
  const waits: number[] = [];
  const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    waits.push(ms);
    if (signal?.aborted) return;
  };
  const validationExecutor = () => async () => {
    state.validationRuns += 1;
    return state.validator();
  };
  const supervisedWith = (gitOps: GitOps, sleepImpl = sleep): ExecutionSupervisor =>
    new ExecutionSupervisor(store, bus, runService, { git: gitOps, validationExecutor, sleep: sleepImpl });
  const supervisor = new ExecutionSupervisor(store, bus, runService, { validationExecutor, sleep });
  const runtimes = new RuntimeService(store);
  const runtime = await runtimes.create({
    name: "Isolated",
    kind: "custom",
    usableInTask: true,
    enabled: true,
    containerized: true,
    executionBackend: "isolated",
    image: "af-test:latest",
  });
  return {
    store,
    bus,
    runService,
    supervisor,
    supervisedWith,
    projects: new ProjectService(store),
    runtimes,
    tasks: new TaskService(store),
    workspaces: new WorkspaceService(store),
    runtimeId: runtime.id,
    get agentRuns() {
      return state.agentRuns;
    },
    setAgent: (handler) => {
      state.handler = handler;
    },
    waits,
    setValidation: (executor) => {
      state.validator = executor;
    },
    get validationRuns() {
      return state.validationRuns;
    },
  };
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

/** Fails the first `failures` pushes with `error`, then behaves normally. */
function flakyPushGit(inner: GitOps, failures: number, error: DomainError): GitOps {
  let remaining = failures;
  const maybeFail = async (): Promise<void> => {
    if (remaining > 0) {
      remaining -= 1;
      throw error;
    }
  };
  return {
    ...inner,
    async push(opts) {
      await maybeFail();
      return inner.push(opts);
    },
    async pushRevision(opts) {
      await maybeFail();
      return inner.pushRevision(opts);
    },
  };
}

async function startTask(h: Harness, project: Project, input: Record<string, unknown> = {}): Promise<{ task: Task; run: Run }> {
  const result = await h.supervisor.startTask({
    projectId: project.id,
    instruction: "Add a feature",
    runtimeId: h.runtimeId,
    ...input,
  } as Parameters<ExecutionSupervisor["startTask"]>[0]);
  await h.supervisor.whenSettled(result.task.id);
  return { task: h.tasks.get(result.task.id)!, run: h.runService.get(result.run.id)! };
}

async function eventTypes(h: Harness, runId: string): Promise<string[]> {
  const events = await h.runService.events(runId);
  return events.map((e) => e.type);
}

const pushFailed = () => new DomainError("git-push-failed", "push failed");
const networkDown = () => new DomainError("source-network-failed", "network unreachable");

describe("v11 automatic retry: transient failures retry once through their own operation", () => {
  test("a failed push is re-pushed automatically, without re-running the agent", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 1, pushFailed()));
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.status, "completed");
    assert.equal(task.execution!.publish!.status, "pushed");
    assert.equal(task.execution!.failure, undefined);
    assert.equal(h.agentRuns, 1, "the agent is never re-run for a publish failure");
    assert.equal(task.execution!.publish!.attempts, 2, "the push was attempted twice");
    assert.equal(task.execution!.autoRetry!.attempts, 1);
    assert.equal(h.waits.length, 1, "one backoff wait, then the retry");
    assert.equal(h.waits[0], 30_000);
    // The remote really has the frozen revision.
    assert.equal(
      (await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim(),
      task.execution!.frozenRevision!.finalCommitSha
    );

    const types = await eventTypes(h, result.run.id);
    assert.ok(types.includes("task.retry.scheduled"), `missing scheduled (${types.join(",")})`);
    assert.ok(types.includes("task.retry.started"), "missing started");
    assert.ok(!types.includes("task.retry.skipped"), "nothing was skipped");
  });

  test("a network failure during the push retries the publish, not the agent", async () => {
    // `source-network-failed` is classified stage "source" (→ retry the
    // agent), but when it came from the push the agent already finished and
    // the revision is frozen: re-pushing it is the honest and cheap recovery.
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 1, networkDown()));
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.status, "completed");
    assert.equal(h.agentRuns, 1, "a push network failure must not re-run the agent");
    assert.equal(task.execution!.publish!.attempts, 2);
    assert.equal(task.execution!.agent!.attempts, 1);
  });

  test("a network failure while preparing the source re-runs the agent on the same workspace", async () => {
    // `source-network-failed` during clone is classified stage "source" →
    // retry kind "agent": the retry is a new Run on the same workspace. The
    // run that failed before the agent ever started must be settled, or the
    // retry would be refused as `task-busy` (see v11.test.ts, "settles its
    // run record").
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    let cloneFailures = 1;
    const flakyClone: GitOps = {
      ...inner,
      async clone(opts) {
        if (cloneFailures > 0) {
          cloneFailures -= 1;
          throw new DomainError("source-network-failed", "connection reset by peer");
        }
        return inner.clone(opts);
      },
    };
    const supervised = h.supervisedWith(flakyClone);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.status, "completed");
    assert.equal(h.agentRuns, 1, "the agent runs once, on the retried run");
    assert.equal(h.runService.forTask(result.task.id).length, 2, "the retry is a new run");
    assert.deepEqual(h.waits, [30_000], "one backoff wait, then the retry");
    assert.equal(h.runService.get(result.run.id)!.status, "failed", "the run that never reached the agent is settled");
    const types = (await h.runService.events(result.run.id)).map((e) => e.type);
    assert.ok(types.includes("task.retry.scheduled"), `missing scheduled (${types.join(",")})`);
    assert.ok(types.includes("task.retry.started"), "missing started");
  });

  test("a validation environment failure re-runs validation only", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "test", command: "test -f x.txt" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    let attempts = 0;
    h.setValidation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          exitCode: -1,
          timedOut: false,
          output: "Cannot connect to the Docker daemon",
          error: "The isolated validation runtime could not start",
          errorCode: "validation-runtime-unavailable",
        };
      }
      return { exitCode: 0, timedOut: false, output: "ok" };
    });

    const { task } = await startTask(h, project);

    assert.equal(task.execution!.status, "completed");
    assert.equal(task.execution!.validation!.status, "passed");
    assert.equal(h.validationRuns, 2, "validation ran again");
    assert.equal(h.agentRuns, 1, "the agent is not re-run for a validation environment failure");
    assert.equal(task.execution!.validation!.attempts, 2);
  });

  test("a genuinely failing validation is not retried", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "test", command: "exit 1" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setValidation(async () => ({ exitCode: 1, timedOut: false, output: "assertion failed" }));

    const { task, run } = await startTask(h, project);

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.code, "validation-failed");
    assert.equal(h.validationRuns, 1, "a failing test is a result, not an environment glitch");
    assert.equal(task.execution!.autoRetry, undefined);
    const types = await eventTypes(h, run.id);
    assert.ok(!types.some((t) => t.startsWith("task.retry.")), `no retry events (${types.join(",")})`);
  });

  test("an agent failure is not retried", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(async () => ({ exitCode: 1, error: "the agent gave up" }));

    const { task, run } = await startTask(h, project);

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.code, "agent-failed");
    assert.equal(h.agentRuns, 1);
    const types = await eventTypes(h, run.id);
    assert.ok(!types.some((t) => t.startsWith("task.retry.")));
  });

  test("a permanent publish failure is not retried", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(
      flakyPushGit(createGitOps(), 1, new DomainError("git-push-auth-failed", "credential rejected"))
    );
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.code, "git-push-auth-failed");
    assert.equal(task.execution!.publish!.attempts, 1, "a credential will not fix itself");
    assert.equal(h.waits.length, 0);
  });
});

describe("v11 automatic retry: budget and visibility", () => {
  test("the budget is one retry by default, then the failure is final and visible", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 5, pushFailed()));
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.code, "git-push-failed");
    assert.equal(task.execution!.publish!.attempts, 2, "first attempt + exactly one retry");
    assert.equal(task.execution!.autoRetry!.attempts, 1);

    const events = await h.runService.events(result.run.id);
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === "task.retry.started").length, 1);
    const skipped = events.find((e) => e.type === "task.retry.skipped");
    assert.ok(skipped, `missing skip (${types.join(",")})`);
    assert.equal(skipped.data.reason, "budget-exhausted");
    assert.equal(skipped.data.code, "git-push-failed");
  });

  test("a larger maxAttempts spends the larger budget", async () => {
    const h = await makeHarness();
    await h.store.updateConfig({ autoRetry: { maxAttempts: 3, baseDelayMs: 1000 } });
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 5, pushFailed()));
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.publish!.attempts, 3, "first attempt + two retries");
    assert.equal(task.execution!.autoRetry!.attempts, 2);
    assert.deepEqual(h.waits, [1000, 2000], "exponential backoff between attempts");
  });

  test("disabled: the failure settles immediately, exactly as before the feature", async () => {
    const h = await makeHarness();
    await h.store.updateConfig({ autoRetry: { enabled: false } });
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 1, pushFailed()));
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.publish!.attempts, 1);
    assert.equal(h.waits.length, 0, "no backoff was scheduled");
    const types = await eventTypes(h, result.run.id);
    assert.ok(!types.some((t) => t.startsWith("task.retry.")));
  });

  test("the scheduled wait is recorded on the task, then replaced by the start", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    // A sleep that lets the test observe the record while the retry waits.
    let observed: Task | undefined;
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 1, pushFailed()), async (ms, signal) => {
      if (signal?.aborted) return;
      observed = h.tasks.get(taskId!)!;
      h.waits.push(ms);
    });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    let taskId: string | undefined;
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    taskId = result.task.id;
    await supervised.whenSettled(result.task.id);

    assert.ok(observed, "the retry waited");
    assert.ok(observed!.execution!.autoRetry!.nextAt, "the record says a retry is scheduled");
    assert.equal(observed!.execution!.autoRetry!.attempts, 1);
    const after = h.tasks.get(result.task.id)!;
    assert.equal(after.execution!.autoRetry!.nextAt, undefined, "the schedule marker is cleared once it runs");
    assert.ok(after.execution!.autoRetry!.at, "the start is recorded");
  });
});

describe("v11 automatic retry: cancellation", () => {
  test("cancelling during the backoff stops the retry before it starts", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    let duringWait: (() => void) | undefined;
    const waited = new Promise<void>((resolve) => (duringWait = resolve));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 1, pushFailed()), async (ms, signal) => {
      h.waits.push(ms);
      duringWait!();
      await gate;
      void signal;
    });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await waited;
    // The task failed and a retry is scheduled — the user cancels now. The
    // failure itself stands (the work did fail); the cancel stops the retry.
    await supervised.cancelTask(result.task.id);
    release!();
    await supervised.whenSettled(result.task.id);

    const task = h.tasks.get(result.task.id)!;
    assert.equal(task.execution!.status, "failed", "the failure is the record; only the retry was stopped");
    assert.equal(task.execution!.publish!.attempts, 1, "the retry never pushed");
    assert.equal(task.execution!.autoRetry!.nextAt, undefined, "the schedule is cleared");
    const events = await h.runService.events(result.run.id);
    const skipped = events.find((e) => e.type === "task.retry.skipped");
    assert.ok(skipped, "the withheld retry is visible");
    assert.equal(skipped.data.reason, "cancelled");
  });

  test("a cancelled task is never retried, whatever the failure code says", async () => {
    // The validation executor reports an aborted run as a runtime failure; the
    // policy must not read that transient-looking code as an environment
    // glitch and resurrect work the user stopped.
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "test", command: "sleep 60" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    let validationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (validationStarted = resolve));
    h.setValidation(async () => {
      validationStarted!();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return { exitCode: -1, timedOut: false, output: "killed", error: "Validation was cancelled", errorCode: "validation-runtime-failed" };
    });

    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await started;
    await h.supervisor.cancelTask(result.task.id);
    await h.supervisor.whenSettled(result.task.id);

    const task = h.tasks.get(result.task.id)!;
    assert.equal(task.execution!.status, "cancelled");
    assert.equal(task.execution!.failure!.code, "agent-cancelled", "a cancel is reported as one, not as a sandbox failure");
    assert.equal(task.execution!.validation!.attempts, 1, "the validation was never re-run");
    assert.equal(h.waits.length, 0, "no retry was ever scheduled");
    const types = await eventTypes(h, result.run.id);
    assert.ok(!types.includes("task.retry.scheduled"), `no retry (${types.join(",")})`);
  });
});

const originalFetch = globalThis.fetch;

describe("v11 automatic retry: restart", () => {
  test("a scheduled retry does not survive a restart, and its withheld webhook is delivered", async () => {
    const h = await makeHarness();
    await h.store.updateConfig({ notifications: { enabled: true, url: "https://webhook.invalid/hooks/team/supersecretpath" } });
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 1, pushFailed()), async (ms, signal) => {
      // Never finish the wait: the process "dies" mid-backoff.
      if (signal?.aborted) return;
      h.waits.push(ms);
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as typeof fetch;

    try {
      const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
      // Wait until the retry is scheduled (the backoff is entered), then treat
      // the process as dead: a fresh supervisor recovers the store.
      for (let i = 0; i < 200 && !h.tasks.get(result.task.id)?.execution?.autoRetry?.nextAt; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const scheduled = h.tasks.get(result.task.id)!;
      assert.ok(scheduled.execution!.autoRetry!.nextAt, "the retry is scheduled");
      assert.equal(calls.length, 0, "the intermediate failure was not announced");

      const restarted = new ExecutionSupervisor(h.store, h.bus, h.runService, { sleep: async () => {} });
      await restarted.recoverInterrupted();

      const after = h.tasks.get(result.task.id)!;
      assert.equal(after.execution!.autoRetry!.nextAt, undefined, "the pending marker is cleared");
      assert.equal(after.execution!.autoRetry!.attempts, 1, "the spend stays recorded");
      assert.equal(after.execution!.status, "failed", "the failure stands; the manual retry is the next step");
      assert.equal(calls.length, 1, "the withheld webhook is delivered by recovery");
      assert.equal(calls[0].event, "task.failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("v11 automatic retry: notification", () => {
  const WEBHOOK = "https://webhook.invalid/hooks/team/supersecretpath";
  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("the intermediate failure is not announced — the final outcome is", async () => {
    const h = await makeHarness();
    await h.store.updateConfig({ notifications: { enabled: true, url: WEBHOOK } });
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 1, pushFailed()));
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as typeof fetch;

    try {
      const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
      await supervised.whenSettled(result.task.id);

      assert.equal(h.tasks.get(result.task.id)!.execution!.status, "completed");
      assert.equal(calls.length, 1, "exactly one webhook, for the end of the story");
      assert.equal(calls[0].event, "task.completed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a retry the budget refused still announces the final failure", async () => {
    const h = await makeHarness();
    await h.store.updateConfig({ notifications: { enabled: true, url: WEBHOOK } });
    const { remote } = await makeRemote();
    const supervised = h.supervisedWith(flakyPushGit(createGitOps(), 5, pushFailed()));
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as typeof fetch;

    try {
      const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
      await supervised.whenSettled(result.task.id);

      assert.equal(h.tasks.get(result.task.id)!.execution!.status, "failed");
      assert.equal(calls.length, 1, "the exhausted budget is a final outcome, announced once");
      assert.equal(calls[0].event, "task.failed");
      assert.equal((calls[0].failure as { code?: string }).code, "git-push-failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
