/**
 * v11 Hardening §12–§18/§30–§33/§36 — frozen final revision, pure Retry
 * Publish, stage-specific crash recovery and state monotonicity.
 *
 * The promises under test:
 *
 *   Retry Publish  ≠  Re-finalize Task
 *   Agent Completed ≠  Task Fully Completed
 *   A completed stage is never walked back by a later failure.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  const root = tempDir("af-pub-remote-");
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
  /**
   * Builds a supervisor over this harness's store with a different `GitOps` —
   * always with the sandboxed validation executor, so a test that injects a
   * failing git never accidentally falls through to the real Docker one.
   */
  supervisedWith: (git: GitOps) => ExecutionSupervisor;
  projects: ProjectService;
  runtimes: RuntimeService;
  tasks: TaskService;
  workspaces: WorkspaceService;
  dataDir: string;
  runtimeId: string;
  agentRuns: number;
  setAgent: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
}

/** Every git call the supervisor made, so "no new commit" is provable. */
interface GitRecorder {
  git: GitOps;
  pushes: Array<{ branch: string; remote: string; revision?: string }>;
  commits: number;
  finalizations: number;
  reset: () => void;
}

function recordingGit(inner: GitOps): GitRecorder {
  const pushes: Array<{ branch: string; remote: string; revision?: string }> = [];
  const state = { commits: 0 };
  const git: GitOps = {
    ...inner,
    async commit(opts) {
      state.commits += 1;
      return inner.commit(opts);
    },
    async push(opts) {
      pushes.push({ branch: opts.branch, remote: opts.remote });
      return inner.push(opts);
    },
    async pushRevision(opts) {
      pushes.push({ branch: opts.branch, remote: opts.remote, revision: opts.revision });
      return inner.pushRevision(opts);
    },
  };
  return {
    git,
    pushes,
    get commits() {
      return state.commits;
    },
    get finalizations() {
      // A finalization is the "git.finalized" write; counting commits is not
      // enough (a clean tree finalizes without committing).
      return 0;
    },
    reset: () => {
      pushes.length = 0;
    },
  } as GitRecorder;
}

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

async function makeHarness(git?: GitOps): Promise<Harness> {
  const dataDir = tempDir("af-pub-data-");
  const store = await Store.open(dataDir);
  const bus = new EventBus();
  const state = { agentRuns: 0, handler: async () => ({ exitCode: 0 }) as RuntimeResult };
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
  // The stand-in isolation carrier for validation (v11 hardening §6): the
  // same `runSandboxedValidation` seam the production Docker executor
  // implements, with the allowlisted environment the supervisor builds.
  const validationExecutor = () => async (opts: {
    step: { name: string; command: string };
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  }) => {
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
  };
  const supervisedWith = (gitOps: GitOps): ExecutionSupervisor =>
    new ExecutionSupervisor(store, bus, runService, { git: gitOps, validationExecutor });
  const supervisor = new ExecutionSupervisor(store, bus, runService, {
    ...(git ? { git } : {}),
    validationExecutor,
  });
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
    dataDir,
    runtimeId: runtime.id,
    get agentRuns() {
      return state.agentRuns;
    },
    setAgent: (handler) => {
      state.handler = handler;
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

/* ================================================================== */
/* 1. Frozen final revision (§13, AC-17/AC-18)                         */
/* ================================================================== */

describe("v11 hardening: the final revision is frozen", () => {
  test("AC-17: a successful finalization records an explicit frozen revision", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "src/a.ts": "export const a = 1;\n" }));
    const { task, run } = await startTask(h, project);

    const frozen = task.execution!.frozenRevision!;
    assert.ok(frozen, "the revision is frozen");
    assert.equal(frozen.finalCommitSha, task.execution!.publish!.finalCommitSha);
    assert.equal(frozen.baseCommitSha, task.baseCommitSha);
    assert.equal(frozen.workingBranch, task.workingBranch);
    assert.equal(frozen.remoteBranch, task.workingBranch);
    assert.equal(frozen.remote, "origin");
    assert.equal(frozen.finalizations, 1);
    assert.ok(frozen.workspaceFingerprint);

    // The real branch tip equals the frozen SHA.
    const branchSha = (await git(h.workspaces.get(task.workspaceId!)!.path!, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim();
    assert.equal(branchSha, frozen.finalCommitSha);
    // …and so does the remote.
    const remoteSha = (await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim();
    assert.equal(remoteSha, frozen.finalCommitSha);

    const types = (await h.store.readEvents(run.id)).map((e) => e.type);
    assert.ok(types.includes("git.revision.frozen"));
  });

  test("AC-18: publish pushes the frozen revision by SHA, not a branch ref", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const recorder = recordingGit(createGitOps());
    const supervised = h.supervisedWith(recorder.git);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(recorder.pushes.length, 1);
    assert.equal(recorder.pushes[0].revision, task.execution!.frozenRevision!.finalCommitSha);
    assert.equal(recorder.pushes[0].branch, task.workingBranch);
  });
});

/* ================================================================== */
/* 2. Retry Publish is a pure publish operation (§12/§14/§30)          */
/* ================================================================== */

describe("v11 hardening: retry publish never re-finalizes", () => {
  test("§30 Case A: a failed push is retried with the SAME commit, not a new one", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    const failing = flakyPushGit(inner, 1, new DomainError("git-push-auth-failed", "credential rejected by the remote"));
    const recorder = recordingGit(failing);
    const supervised = h.supervisedWith(recorder.git);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    // Development completed; publishing failed. Both facts are visible.
    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.validation!.status, "skipped");
    assert.equal(task.execution!.stages!.agent!.status, "completed");
    assert.equal(task.execution!.stages!.finalization!.status, "completed");
    assert.equal(task.execution!.stages!.publish!.status, "failed");
    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "publish");

    const commitA = task.execution!.frozenRevision!.finalCommitSha;
    const commitsAfterFinalization = recorder.commits;

    // Retry Publish: the exact same revision, no agent, no validation, no commit.
    const after = await supervised.retryPublish(task.id);
    assert.equal(after!.execution!.publish!.status, "pushed");
    assert.equal(after!.execution!.status, "completed");
    assert.equal(after!.execution!.failure, undefined);
    assert.equal(after!.execution!.frozenRevision!.finalCommitSha, commitA, "the frozen SHA is unchanged");
    assert.equal(recorder.commits, commitsAfterFinalization, "no new commit was created");
    assert.equal(h.agentRuns, 1, "the agent did not run again");
    // The push that succeeded carried commit A explicitly.
    assert.equal(recorder.pushes.at(-1)!.revision, commitA);
    // And the remote really has commit A.
    assert.equal((await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim(), commitA);
    assert.equal(after!.execution!.publish!.attempts, 2);
  });

  test("§30 Case B/AC-24: workspace changes after finalization are never published", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    const failing = flakyPushGit(inner, 1, new DomainError("source-network-failed", "network unreachable"));
    const recorder = recordingGit(failing);
    const supervised = h.supervisedWith(recorder.git);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "committed.txt": "committed\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    const commitA = task.execution!.frozenRevision!.finalCommitSha;
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;

    // Someone modifies the workspace after finalization.
    writeFileSync(join(workspacePath, "sneaky.txt"), "must not be published\n");
    const commitsBefore = recorder.commits;
    recorder.reset();

    const after = await supervised.retryPublish(task.id);

    // The retry refuses: the workspace diverged from the frozen revision.
    assert.equal(after!.execution!.publish!.status, "failed");
    assert.equal(after!.execution!.failure!.code, "workspace-diverged-after-finalization");
    assert.equal(recorder.commits, commitsBefore, "no new commit was created");
    assert.equal(recorder.pushes.length, 0, "nothing was pushed");
    assert.equal(after!.execution!.frozenRevision!.finalCommitSha, commitA);
    // The remote never received the sneaky file.
    const tree = await git(remote, ["ls-tree", "-r", "--name-only", task.workingBranch!]).catch(() => "");
    assert.equal(tree.includes("sneaky.txt"), false);
  });

  test("a workspace that drifted only by an untracked file is still detected", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    writeFileSync(join(workspacePath, "untracked.txt"), "drift\n");

    const after = await h.supervisor.retryPublish(task.id);
    assert.equal(after!.execution!.publish!.status, "failed");
    assert.equal(after!.execution!.failure!.code, "workspace-diverged-after-finalization");
    assert.equal(after!.execution!.publish!.attempts, 1, "the push was never attempted");
  });

  test("§30 Case C: retry publish leaves agent / validation / finalization counts untouched", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    const failing = flakyPushGit(inner, 1, new DomainError("git-push-failed", "push failed"));
    const recorder = recordingGit(failing);
    const supervised = h.supervisedWith(recorder.git);
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "test -f x.txt" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const before = h.tasks.get(result.task.id)!;
    const agentAttempts = before.execution!.agent!.attempts;
    const validationAttempts = before.execution!.validation!.attempts;
    const commits = recorder.commits;
    const runsBefore = h.runService.forTask(result.task.id).length;

    await supervised.retryPublish(result.task.id);
    const after = h.tasks.get(result.task.id)!;

    assert.equal(after.execution!.agent!.attempts, agentAttempts, "agent run count unchanged");
    assert.equal(after.execution!.validation!.attempts, validationAttempts, "validation run count unchanged");
    assert.equal(recorder.commits, commits, "finalization count unchanged");
    assert.equal(h.runService.forTask(result.task.id).length, runsBefore, "no new run was created");
    assert.equal(h.agentRuns, 1);
  });

  test("§30 Case D: the frozen SHA survives a successful retry publish unchanged", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    const failing = flakyPushGit(inner, 1, new DomainError("git-push-auth-failed", "nope"));
    const supervised = h.supervisedWith(failing);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    const frozenBefore = task.execution!.frozenRevision!;

    const after = await supervised.retryPublish(task.id);
    assert.deepEqual(after!.execution!.frozenRevision, frozenBefore, "the frozen revision is byte-identical");
    assert.equal(after!.execution!.publish!.finalCommitSha, frozenBefore.finalCommitSha);
  });

  test("retry publish without a frozen revision fails with publish-revision-missing", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(async () => ({ exitCode: 1, error: "agent blew up" }));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.frozenRevision, undefined);
    await assert.rejects(
      () => h.supervisor.retryPublish(task.id),
      (err: unknown) => (err as DomainError).code === "publish-revision-missing"
    );
  });

  test("retry publish is idempotent when the remote already has the revision", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    const frozen = task.execution!.frozenRevision!.finalCommitSha;

    const recorder = recordingGit(createGitOps());
    const supervised = h.supervisedWith(recorder.git);
    const after = await supervised.retryPublish(task.id);
    assert.equal(recorder.pushes.length, 0, "the remote already has the revision — nothing to push");
    assert.equal(after!.execution!.publish!.status, "pushed");
    assert.equal(after!.execution!.frozenRevision!.finalCommitSha, frozen);
  });

  test("AC-25/AC-26: publish only ever targets this task's branch, never force, never a tag", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const recorder = recordingGit(createGitOps());
    const supervised = h.supervisedWith(recorder.git);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    for (const push of recorder.pushes) {
      assert.equal(push.branch, task.workingBranch);
      assert.equal(push.remote, "origin");
      assert.equal(push.branch.startsWith("refs/tags/"), false);
      assert.equal(push.branch.includes("main"), false);
    }
    // The GitOps contract itself has no force parameter and no arbitrary refspec.
    assert.equal(createGitOps().push.length, 1);
    assert.equal(createGitOps().pushRevision.length, 1);
    // No tag was created on the remote.
    const tags = await git(remote, ["tag", "--list"]);
    assert.equal(tags.trim(), "");
  });

  test("a protected branch is never a publish target", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "x", runtimeId: h.runtimeId, workingBranch: "main" }),
      (err: unknown) => (err as DomainError).code === "branch-invalid"
    );
  });
});

/* ================================================================== */
/* 3. Crash recovery is stage-specific (§16/§17/§18/§31/§42)           */
/* ================================================================== */

/**
 * Simulates a supervisor crash at `phase`: the task record is rewound to the
 * exact stage state a lifecycle would have had when it died there, the run
 * record is left "running" (as a crash leaves it) and a stale workspace lock
 * is planted. This is the input `recoverInterrupted()` has to reason about.
 */
async function crashAt(h: Harness, taskId: string, phase: string): Promise<void> {
  const task = h.tasks.get(taskId)!;
  const execution = task.execution!;
  const stages = { ...(execution.stages ?? {}) };
  const patch: Record<string, unknown> = { phase, status: "running", failure: undefined };

  // Everything *before* the crashed phase had already succeeded — the
  // lifecycle only advances its phase after a stage completes.
  const reachedValidation = ["validation.preparing", "validation.running", "git.finalizing", "git.pushing", "cleanup"].includes(phase);
  const reachedFinalization = ["git.finalizing", "git.pushing", "cleanup"].includes(phase);
  const reachedPublish = ["git.pushing", "cleanup"].includes(phase);

  if (reachedValidation) {
    patch.agent = { ...execution.agent!, status: "completed" };
    stages.agent = { status: "completed", at: new Date().toISOString() };
    delete stages.validation;
  } else {
    patch.agent = { ...execution.agent!, status: "running" };
    delete stages.agent;
  }
  if (reachedFinalization) {
    stages.validation = execution.validation?.status === "skipped"
      ? { status: "skipped", at: new Date().toISOString() }
      : { status: "completed", at: new Date().toISOString() };
    patch.validation = { ...execution.validation!, status: execution.validation?.status === "skipped" ? "skipped" : "passed" };
    delete stages.finalization;
  } else if (reachedValidation) {
    patch.validation = { ...execution.validation!, status: "running", steps: [], error: undefined, errorCode: undefined };
    delete stages.validation;
  }
  if (reachedPublish) {
    stages.finalization = {
      status: "completed",
      at: new Date().toISOString(),
      commitSha: execution.frozenRevision?.finalCommitSha,
    };
    delete stages.publish;
  } else {
    // The crash happened before publishing, so nothing was published yet.
    delete stages.finalization;
    delete stages.publish;
  }
  if (phase === "cleanup") {
    // Cleanup runs *after* publishing: the publish already landed and only
    // the terminal write was lost.
    stages.publish = { status: "completed", at: new Date().toISOString(), commitSha: execution.frozenRevision?.finalCommitSha };
  } else {
    patch.publish = { ...execution.publish!, status: "pending", pushedAt: undefined, error: undefined, errorCode: undefined };
    // A crash before finalization cannot have produced a frozen revision.
    if (!reachedPublish) patch.frozenRevision = undefined;
  }
  patch.stages = stages;

  await h.store.update<Task>("tasks", taskId, { execution: { ...execution, ...patch } as never });
  await h.store.update<Run>("runs", execution.agent!.runId!, { phase: phase as never, status: "running" });
  // A lock whose run is not executing is stale — exactly what a crash leaves.
  await h.store.insert("workspaceLocks", {
    id: `wslock_${Date.now()}`,
    workspaceId: task.workspaceId!,
    taskId,
    runId: "run_ghost",
    acquiredAt: new Date().toISOString(),
  });
}

describe("v11 hardening: stage-specific crash recovery", () => {
  test("§31 crash during Agent: agent != completed, retry agent is offered", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    await crashAt(h, task.id, "agent.running");

    const recovered = await h.supervisor.recoverInterrupted();
    assert.ok(recovered.tasks.includes(task.id));
    const after = h.tasks.get(task.id)!;
    assert.notEqual(after.execution!.agent!.status, "completed");
    assert.equal(after.execution!.stages!.agent!.status, "interrupted");
    assert.equal(after.execution!.failure!.code, "supervisor-restarted");
    assert.equal(after.execution!.failure!.stage, "agent");
    const detail = h.supervisor.taskDetail(task.id);
    assert.equal(detail.retry.kind, "agent");
    assert.equal(detail.retry.agent, true);
    assert.equal(detail.retry.validation, false);
    assert.equal(detail.retry.publish, false);
    // The workspace is intact.
    assert.equal(existsSync(h.workspaces.get(task.workspaceId!)!.path!), true);
  });

  test("AC-27/§31 crash during Validation: agent stays completed, retry validation is offered", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "true" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.agent!.status, "completed");
    await crashAt(h, task.id, "validation.running");

    await h.supervisor.recoverInterrupted();
    const after = h.tasks.get(task.id)!;

    // The agent's completed state is NOT walked back.
    assert.equal(after.execution!.agent!.status, "completed");
    assert.equal(after.execution!.stages!.agent!.status, "completed");
    // Validation is the interrupted stage.
    assert.equal(after.execution!.validation!.status, "interrupted");
    assert.equal(after.execution!.stages!.validation!.status, "interrupted");
    assert.equal(after.execution!.failure!.stage, "validation");
    assert.equal(after.execution!.publish!.status, "pending", "nothing was published");
    // The correct retry is offered — not a generic "retry task".
    const detail = h.supervisor.taskDetail(task.id);
    assert.equal(detail.retry.kind, "validation");
    assert.equal(detail.retry.validation, true);
    assert.equal(detail.retry.agent, false);
  });

  test("§31 crash during Finalization: agent and validation stay completed", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "true" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    await crashAt(h, task.id, "git.finalizing");

    await h.supervisor.recoverInterrupted();
    const after = h.tasks.get(task.id)!;
    assert.equal(after.execution!.agent!.status, "completed");
    assert.equal(after.execution!.stages!.agent!.status, "completed");
    assert.equal(after.execution!.stages!.validation!.status, "completed");
    assert.equal(after.execution!.stages!.finalization!.status, "interrupted");
    assert.equal(after.execution!.failure!.stage, "finalization");
    assert.equal(h.supervisor.taskDetail(task.id).retry.kind, "agent");
  });

  test("AC-28/§31/§42 crash during Publish: agent, validation and finalization all stay completed", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "true" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task, run } = await startTask(h, project);
    const frozen = task.execution!.frozenRevision!;
    await crashAt(h, task.id, "git.pushing");

    const recovered = await h.supervisor.recoverInterrupted();
    assert.ok(recovered.tasks.includes(task.id));
    const after = h.tasks.get(task.id)!;

    assert.equal(after.execution!.agent!.status, "completed");
    assert.equal(after.execution!.validation!.status, "passed");
    assert.equal(after.execution!.stages!.agent!.status, "completed");
    assert.equal(after.execution!.stages!.validation!.status, "completed");
    assert.equal(after.execution!.stages!.finalization!.status, "completed");
    assert.equal(after.execution!.stages!.publish!.status, "interrupted");
    assert.equal(after.execution!.publish!.status, "failed");
    assert.equal(after.execution!.failure!.stage, "publish");
    assert.equal(after.execution!.failure!.code, "supervisor-restarted");
    // The frozen revision survived the crash untouched.
    assert.deepEqual(after.execution!.frozenRevision, frozen);

    const detail = h.supervisor.taskDetail(task.id);
    assert.equal(detail.retry.kind, "publish");
    assert.equal(detail.retry.publish, true);
    assert.equal(detail.retry.agent, false);
    assert.equal(detail.retry.validation, false);

    // §42: Retry Publish then completes without re-running the agent.
    const agentRunsBefore = h.agentRuns;
    const repaired = await h.supervisor.retryPublish(task.id);
    assert.equal(repaired!.execution!.publish!.status, "pushed");
    assert.equal(repaired!.execution!.status, "completed");
    assert.equal(h.agentRuns, agentRunsBefore, "the agent was not re-run");
    assert.equal(repaired!.execution!.frozenRevision!.finalCommitSha, frozen.finalCommitSha);
    assert.equal((await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim(), frozen.finalCommitSha);
    assert.ok((await h.store.readEvents(run.id)).some((e) => e.type === "task.recovered"));
  });

  test("§31 recovery never re-runs the agent automatically", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    const runsBefore = h.agentRuns;
    await crashAt(h, task.id, "git.pushing");

    await h.supervisor.recoverInterrupted();
    // Give any (incorrect) automatic execution a chance to happen.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(h.agentRuns, runsBefore, "recovery must not re-execute the agent");
    assert.equal(h.runService.forTask(task.id).length, 1, "no new run was created");
  });

  test("recovery reclaims the workspace lock and preserves the workspace", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    writeFileSync(join(workspacePath, "uncommitted.txt"), "kept\n");
    await crashAt(h, task.id, "git.pushing");

    const recovered = await h.supervisor.recoverInterrupted();
    assert.ok(recovered.workspaces.includes(task.workspaceId!));
    assert.equal(h.store.list("workspaceLocks").length, 0, "the stale lock was reclaimed");
    assert.equal(existsSync(join(workspacePath, "uncommitted.txt")), true, "uncommitted work survives recovery");
  });

  test("recovery leaves settled tasks alone", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    const before = JSON.stringify(h.tasks.get(task.id)!.execution);
    const recovered = await h.supervisor.recoverInterrupted();
    assert.deepEqual(recovered.tasks, []);
    assert.equal(JSON.stringify(h.tasks.get(task.id)!.execution), before, "a completed task is untouched");
  });

  test("recovery never walks a completed stage back, whatever the phase says", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "true" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    // A crash *after* publishing but before the terminal write.
    await crashAt(h, task.id, "cleanup");

    await h.supervisor.recoverInterrupted();
    const after = h.tasks.get(task.id)!;
    assert.equal(after.execution!.stages!.agent!.status, "completed");
    assert.equal(after.execution!.stages!.validation!.status, "completed");
    assert.equal(after.execution!.stages!.finalization!.status, "completed");
    assert.equal(after.execution!.stages!.publish!.status, "completed");
    assert.equal(after.execution!.agent!.status, "completed");
    assert.equal(after.execution!.validation!.status, "passed");
  });
});

/* ================================================================== */
/* 4. State monotonicity (§36)                                         */
/* ================================================================== */

describe("v11 hardening: completed stages are never walked back", () => {
  test("a failed publish leaves agent completed and validation passed", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    const failing = flakyPushGit(inner, 1, new DomainError("git-push-auth-failed", "auth failed"));
    const supervised = h.supervisedWith(failing);
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "test -f x.txt" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "publish", JSON.stringify(task.execution!.failure));
    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.validation!.status, "passed", JSON.stringify(task.execution!.validation));
    assert.equal(task.execution!.stages!.agent!.status, "completed");
    assert.equal(task.execution!.stages!.validation!.status, "completed");
    assert.equal(task.execution!.stages!.finalization!.status, "completed");
    assert.equal(task.execution!.stages!.publish!.status, "failed");
  });

  test("a task that opts out of publishing records publish as skipped, not completed", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote }, git: { push: false } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.status, "completed");
    assert.equal(task.execution!.publish!.status, "skipped");
    assert.equal(task.execution!.stages!.publish!.status, "skipped", "a skipped stage stays skipped");
    // The revision is still frozen — finalization ran, publishing did not.
    assert.ok(task.execution!.frozenRevision!.finalCommitSha);
  });

  test("a task with no validation steps records validation as skipped", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.validation!.status, "skipped");
    assert.equal(task.execution!.stages!.validation!.status, "skipped");
  });

  test("a failed retry publish leaves validation completed", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    const failing = flakyPushGit(inner, 2, new DomainError("git-push-auth-failed", "auth failed"));
    const supervised = h.supervisedWith(failing);
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "test -f x.txt" }] },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);

    const after = await supervised.retryPublish(result.task.id);
    assert.equal(after!.execution!.publish!.status, "failed", "the second push attempt failed too");
    assert.equal(after!.execution!.validation!.status, "passed", "validation is untouched");
    assert.equal(after!.execution!.stages!.validation!.status, "completed");
    assert.equal(after!.execution!.agent!.status, "completed");
    assert.equal(after!.execution!.stages!.agent!.status, "completed");
    // The frozen revision is still there for the next attempt.
    assert.ok(after!.execution!.frozenRevision!.finalCommitSha);
  });

  test("a new agent run after a failed publish keeps the frozen revision's history visible", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    const failing = flakyPushGit(inner, 1, new DomainError("git-push-auth-failed", "auth failed"));
    const supervised = h.supervisedWith(failing);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "a.txt": "a\n" }));
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const firstFrozen = h.tasks.get(result.task.id)!.execution!.frozenRevision!.finalCommitSha;

    // A new agent run re-finalizes; the frozen revision advances to the new one.
    h.setAgent(writeFiles({ "b.txt": "b\n" }));
    await supervised.retryRun(result.task.id);
    await supervised.whenSettled(result.task.id);
    const after = h.tasks.get(result.task.id)!;
    assert.equal(after.execution!.status, "completed");
    assert.notEqual(after.execution!.frozenRevision!.finalCommitSha, firstFrozen, "a new agent run produces a new revision");
    assert.equal(after.execution!.frozenRevision!.finalizations, 2, "the finalization count is auditable");
    assert.equal(after.execution!.agent!.attempts, 2);
    // Both files are published.
    const tree = await git(remote, ["ls-tree", "-r", "--name-only", after.workingBranch!]);
    assert.match(tree, /a\.txt/);
    assert.match(tree, /b\.txt/);
  });
});

/* ================================================================== */
/* 5. Cancellation and concurrency (§32/§33)                           */
/* ================================================================== */

describe("v11 hardening: cancellation and concurrency", () => {
  test("§33 cancelling during validation.running stops cleanly, keeps the workspace and never publishes", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "slow", command: "sleep 30", timeoutMs: 60_000 }] },
    });
    h.setAgent(writeFiles({ "partial.txt": "partial\n" }));
    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });

    // Wait until validation is the running phase, then cancel.
    for (let i = 0; i < 200; i++) {
      const phase = h.tasks.get(started.task.id)?.execution?.phase;
      if (phase === "validation.running") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.equal(h.tasks.get(started.task.id)!.execution!.phase, "validation.running");
    const cancelled = await h.supervisor.cancelTask(started.task.id);

    assert.equal(cancelled!.execution!.status, "cancelled");
    assert.equal(cancelled!.execution!.agent!.status, "completed", "the agent's completed state survives the cancel");
    assert.equal(cancelled!.execution!.publish!.status, "pending", "nothing was published");
    // The workspace keeps the agent's uncommitted work.
    const workspacePath = h.workspaces.get(cancelled!.workspaceId!)!.path!;
    assert.equal(existsSync(join(workspacePath, "partial.txt")), true);
    assert.equal(h.store.list("workspaceLocks").length, 0, "the lock was released");
    // No branch was published.
    const branches = await git(remote, ["branch", "--list", started.task.workingBranch!]);
    assert.equal(branches.trim(), "");
  });

  test("§32 concurrency: two tasks on one project stay fully independent", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, `${ctx.task.id}.txt`), "work\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      return { exitCode: 0 };
    });

    const [a, b] = await Promise.all([
      h.supervisor.startTask({ projectId: project.id, instruction: "A", runtimeId: h.runtimeId, workingBranch: "af/iso-a" }),
      h.supervisor.startTask({ projectId: project.id, instruction: "B", runtimeId: h.runtimeId, workingBranch: "af/iso-b" }),
    ]);
    await Promise.all([h.supervisor.whenSettled(a.task.id), h.supervisor.whenSettled(b.task.id)]);
    const taskA = h.tasks.get(a.task.id)!;
    const taskB = h.tasks.get(b.task.id)!;

    assert.notEqual(taskA.workspaceId, taskB.workspaceId);
    assert.notEqual(taskA.execution!.frozenRevision!.finalCommitSha, taskB.execution!.frozenRevision!.finalCommitSha);
    // Each task's frozen revision is what landed on its own branch.
    assert.equal(
      (await git(remote, ["rev-parse", "refs/heads/af/iso-a"])).trim(),
      taskA.execution!.frozenRevision!.finalCommitSha
    );
    assert.equal(
      (await git(remote, ["rev-parse", "refs/heads/af/iso-b"])).trim(),
      taskB.execution!.frozenRevision!.finalCommitSha
    );
  });

  test("§32 retry publish on Task A does not block or pollute Task B's workspace", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    // Task A's first push fails; Task B's does not.
    let failures = 1;
    const flaky: GitOps = {
      ...inner,
      async pushRevision(opts) {
        if (failures > 0) {
          failures -= 1;
          throw new DomainError("git-push-failed", "transient");
        }
        return inner.pushRevision(opts);
      },
    };
    const supervised = h.supervisedWith(flaky);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));

    const a = await supervised.startTask({ projectId: project.id, instruction: "A", runtimeId: h.runtimeId, workingBranch: "af/conc-a" });
    await supervised.whenSettled(a.task.id);
    const b = await supervised.startTask({ projectId: project.id, instruction: "B", runtimeId: h.runtimeId, workingBranch: "af/conc-b" });
    await supervised.whenSettled(b.task.id);

    const taskA = h.tasks.get(a.task.id)!;
    const taskB = h.tasks.get(b.task.id)!;
    assert.equal(taskA.execution!.publish!.status, "failed");
    assert.equal(taskB.execution!.publish!.status, "pushed");

    // The retry touches A's workspace only.
    const wsBBefore = JSON.stringify(h.workspaces.get(taskB.workspaceId!));
    const bPath = h.workspaces.get(taskB.workspaceId!)!.path!;
    const bHeadBefore = (await git(bPath, ["rev-parse", "HEAD"])).trim();
    const repaired = await supervised.retryPublish(a.task.id);

    assert.equal(repaired!.execution!.publish!.status, "pushed");
    assert.equal(JSON.stringify(h.workspaces.get(taskB.workspaceId!)), wsBBefore, "Task B's workspace record is untouched");
    assert.equal((await git(bPath, ["rev-parse", "HEAD"])).trim(), bHeadBefore, "Task B's working tree is untouched");
    assert.equal(
      (await git(remote, ["rev-parse", "refs/heads/af/conc-b"])).trim(),
      taskB.execution!.frozenRevision!.finalCommitSha
    );
  });

  test("§14.2 retry publish takes the workspace lock and refuses a concurrent writer", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);

    // Another run is genuinely in flight on the same workspace: its record is
    // active, so its lock is live and must not be reclaimed.
    const workspaceId = task.workspaceId!;
    const activeRun = h.runService.forTask(task.id)[0];
    await h.store.update<Run>("runs", activeRun.id, { status: "running", endTime: undefined });
    await h.store.insert("workspaceLocks", {
      id: "wslock_live",
      workspaceId,
      taskId: task.id,
      runId: activeRun.id,
      acquiredAt: new Date().toISOString(),
    });
    // The retry is refused outright: an in-flight run on the same task means
    // there is a live writer, so publish must not interleave with it.
    await assert.rejects(
      () => h.supervisor.retryPublish(task.id),
      (err: unknown) => (err as DomainError).code === "task-busy"
    );
    // The live lock is still the other run's — the refusal did not steal it.
    assert.equal(h.store.list<{ runId: string }>("workspaceLocks")[0].runId, activeRun.id);
  });

  test("§14.2 a lock held by an active run blocks the publish lease itself", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);

    // A *different* task's run holds this workspace's lease and is active.
    await h.store.insert("workspaceLocks", {
      id: "wslock_other",
      workspaceId: task.workspaceId!,
      taskId: "task_other",
      runId: "run_other_active",
      acquiredAt: new Date().toISOString(),
    });
    await h.store.insert("runs", {
      id: "run_other_active",
      taskId: "task_other",
      taskTitle: "other",
      status: "running",
      lifecycle: { mode: "ephemeral" },
      artifactIds: [],
      eventCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Run);

    const after = await h.supervisor.retryPublish(task.id);
    assert.equal(after!.execution!.publish!.status, "failed");
    assert.equal(after!.execution!.failure!.code, "workspace-locked");
    assert.equal(after!.execution!.frozenRevision!.finalCommitSha, task.execution!.frozenRevision!.finalCommitSha);
    // The other run's lock is intact.
    assert.equal(h.store.list<{ runId: string }>("workspaceLocks")[0].runId, "run_other_active");
  });
});
