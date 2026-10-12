/**
 * v12 §6.2/§6.4/§6.6 — the rework run, interrupted.
 *
 * A rework run is a development run (v12 §4.3), so a cancel or a crash that
 * lands during it must settle the same way one that lands during the initial
 * run would — with one twist the cycle itself introduces: `stages.agent` has
 * already been written `completed` by the initial run, and the loop's
 * re-entry (v12 §6.2) is what lets the rework's own outcome replace it.
 *
 * The promises under test:
 *
 *   A cancel during a rework run settles as a cancellation: the validation
 *   cycle is interrupted (not failed), the workspace survives, nothing is
 *   published.
 *   A crash during `validation.reworking` recovers as a *validation*
 *   interruption — Retry Validation re-judges the half-reworked workspace
 *   without consuming an attempt (§6.4).
 *   Stage monotonicity's revision (v12 §6.2) is exact: the loop alone may
 *   rewrite a completed `stages.agent`; every non-loop path still may not.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  failedVerdict,
  git,
  judgeScript,
  judgeVerdictPath,
  makeHarness,
  makeRemote,
  setGitIdentity,
  startTask,
  verdict,
  writeFiles,
  type Harness,
} from "./v12.harness.js";
import { mkdirSync } from "node:fs";
import type { Task } from "./types.js";

before(() => setGitIdentity());

/** A judge that blocks until its run is aborted — the cancel window. */
function blockingJudge(h: Harness): { started: Promise<void> } {
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolvePromise) => (signalStarted = resolvePromise));
  h.setJudge(async (ctx) => {
    signalStarted();
    await new Promise<void>((resolvePromise) => {
      ctx.signal.addEventListener("abort", () => resolvePromise(), { once: true });
      if (ctx.signal.aborted) resolvePromise();
    });
    return { exitCode: -1, error: "The judge run was cancelled" };
  });
  return { started };
}

/** An agent that blocks on its second (rework) invocation. */
function blockingReworkAgent(h: Harness): { started: Promise<void> } {
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolvePromise) => (signalStarted = resolvePromise));
  h.setAgent(async (ctx) => {
    if (h.runs >= 2) {
      writeFileSync(join(ctx.workspacePath!, "half-reworked.txt"), "partial\n");
      signalStarted();
      await new Promise<void>((resolvePromise) => {
        ctx.signal.addEventListener("abort", () => resolvePromise(), { once: true });
        if (ctx.signal.aborted) resolvePromise();
      });
      return { exitCode: -1, error: "The rework run was cancelled" };
    }
    writeFileSync(join(ctx.workspacePath!, "x.txt"), "x\n");
    return { exitCode: 0 };
  });
  return { started };
}

/* ================================================================== */
/* 1. Cancel landing on the rework run (v12 §6.6)                      */
/* ================================================================== */

describe("v12 rework interruption: cancel", () => {
  test("cancelling during the rework run interrupts the cycle and keeps the workspace", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    const rework = blockingReworkAgent(h);
    h.setJudge(judgeScript(h, [failedVerdict("Not yet.", ["the standard"])]));

    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await rework.started;
    const running = h.tasks.get(started.task.id)!;
    assert.equal(running.execution!.phase, "validation.reworking");
    assert.equal(running.execution!.agent!.status, "running", "the rework run is the live development run");

    const cancelled = await h.supervisor.cancelTask(started.task.id);

    assert.equal(cancelled!.execution!.status, "cancelled");
    assert.equal(cancelled!.execution!.failure!.code, "agent-cancelled");
    // The cycle — not just the agent — reports the interruption.
    assert.equal(cancelled!.execution!.validation!.status, "interrupted");
    assert.equal(cancelled!.execution!.publish!.status, "pending", "nothing was published");
    // The half-reworked workspace survives for the human (v11 §32).
    const workspacePath = h.workspaces.get(cancelled!.workspaceId!)!.path!;
    assert.equal(existsSync(join(workspacePath, "half-reworked.txt")), true);
    // No branch reached the remote.
    const branches = await git(remote, ["branch", "--list", started.task.workingBranch!]);
    assert.equal(branches.trim(), "");
  });

  test("cancelling during the judge of round 2 interrupts the cycle, not the completed rework", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    h.setAgent(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, h.runs >= 2 ? "reworked.txt" : "x.txt"), "x\n");
      return { exitCode: 0 };
    });
    // Round 1 fails; round 2's judge blocks until cancelled.
    let judgeCount = 0;
    let signalRoundTwo: () => void = () => {};
    const roundTwoStarted = new Promise<void>((resolvePromise) => (signalRoundTwo = resolvePromise));
    h.setJudge(async (ctx) => {
      judgeCount += 1;
      if (judgeCount === 1) {
        const file = judgeVerdictPath(h.dataDir, ctx.run.id);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, `${JSON.stringify(failedVerdict("Not yet.", ["the standard"]), null, 2)}\n`);
        return { exitCode: 0 };
      }
      signalRoundTwo();
      await new Promise<void>((resolvePromise) => {
        ctx.signal.addEventListener("abort", () => resolvePromise(), { once: true });
        if (ctx.signal.aborted) resolvePromise();
      });
      return { exitCode: -1, error: "The judge run was cancelled" };
    });

    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await roundTwoStarted;
    const before = h.tasks.get(started.task.id)!;
    assert.equal(before.execution!.phase, "validation.running");
    assert.equal(before.execution!.agent!.status, "completed", "the rework run finished before the round-2 judge");

    const cancelled = await h.supervisor.cancelTask(started.task.id);
    assert.equal(cancelled!.execution!.status, "cancelled");
    assert.equal(cancelled!.execution!.validation!.status, "interrupted");
    assert.equal(cancelled!.execution!.agent!.status, "completed", "the rework's completion survives the cancel");
    assert.equal(cancelled!.execution!.publish!.status, "pending");
  });
});

/* ================================================================== */
/* 2. Crash landing in the rework run (v12 §6.4)                       */
/* ================================================================== */

describe("v12 rework interruption: crash recovery", () => {
  test("a crash during validation.reworking recovers as a validation interruption", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [failedVerdict("Not yet.", ["the standard"]), verdict()]));
    const { task } = await startTask(h, project);
    // The first cycle exhausted nothing; rewind to a crash mid-rework: the
    // record says round 1 failed and a rework was started (and its id is
    // recorded on round 1), the process died before the rework finished.
    const round1 = task.execution!.validation!.rounds![0];

    // Build the crash shape by hand: the cycle's own record after round 1
    // failed and its rework was started, but before the rework finished.
    const crashedTask: Task = {
      ...task,
      execution: {
        ...task.execution!,
        phase: "validation.reworking",
        status: "running",
        failure: undefined,
        validation: {
          ...task.execution!.validation!,
          status: "running",
          attempts: 1,
          rounds: [{ ...round1, status: "failed", reworkRunId: "run_ghost_rework", endedAt: round1.endedAt }],
        },
      },
    };
    await h.store.update<Task>("tasks", task.id, { execution: crashedTask.execution });

    const recovered = await h.supervisor.recoverInterrupted();
    assert.ok(recovered.tasks.includes(task.id));
    const after = h.tasks.get(task.id)!;
    assert.equal(after.execution!.status, "failed");
    assert.equal(after.execution!.failure!.code, "supervisor-restarted");
    assert.equal(after.execution!.failure!.stage, "validation", "a crash during a rework is a validation interruption (v12 §6.4)");
    // The completed initial run is not walked back.
    assert.equal(after.execution!.stages!.agent!.status, "completed");
    const detail = h.supervisor.taskDetail(task.id);
    assert.equal(detail.retry.kind, "validation", "the offered retry is Retry Validation, not Retry Agent");
  });

  test("Retry Validation after a rework crash re-judges the half-reworked workspace without consuming an attempt", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    h.setAgent(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, h.runs >= 2 ? "reworked.txt" : "x.txt"), "x\n");
      return { exitCode: 0 };
    });
    h.setJudge(judgeScript(h, [failedVerdict("Not yet.", ["the standard"]), verdict()]));
    const { task } = await startTask(h, project);
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    // Rewind to the crash-mid-rework window; the half-rework's output is
    // still in the workspace (that is exactly what the spec calls an
    // acceptable recovery subject).
    const round1 = task.execution!.validation!.rounds![0];
    const crashedTask: Task = {
      ...task,
      execution: {
        ...task.execution!,
        phase: "validation.reworking",
        status: "running",
        failure: undefined,
        validation: {
          ...task.execution!.validation!,
          status: "running",
          attempts: 1,
          rounds: [{ ...round1, status: "failed", reworkRunId: "run_ghost_rework", endedAt: round1.endedAt }],
        },
      },
    };
    await h.store.update<Task>("tasks", task.id, { execution: crashedTask.execution });
    await h.supervisor.recoverInterrupted();

    const before = h.tasks.get(task.id)!;
    assert.equal(before.execution!.validation!.status, "interrupted");
    const devRunsBefore = h.runs;

    // The retry re-judges what is on disk — the agent is not re-run.
    const after = await h.supervisor.retryValidation(task.id);

    assert.equal(h.runs, devRunsBefore, "no development run was launched to 'finish' the rework");
    assert.equal(after!.execution!.status, "completed");
    assert.equal(after!.execution!.validation!.status, "passed");
    // The failed round survives as history; the recovery round is appended.
    const rounds = after!.execution!.validation!.rounds!;
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0].status, "failed");
    assert.equal(rounds[1].verdict!.passed, true);
    // The new pin froze whatever was on disk, rework included.
    const tree = await git(workspacePath, ["ls-tree", "-r", "--name-only", rounds[1].pinnedRevision!.commitSha]);
    assert.ok(tree.includes("x.txt"));
  });
});

/* ================================================================== */
/* 3. Stage monotonicity, revised for the loop (v12 §6.2)              */
/* ================================================================== */

describe("v12 rework interruption: stage monotonicity", () => {
  test("the loop alone may rewrite a completed stages.agent — a rework's failure replaces it", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    // The initial run completes; the rework run fails.
    h.setAgent(async (ctx) => {
      if (h.runs >= 2) return { exitCode: 1, error: "the rework agent blew up" };
      writeFileSync(join(ctx.workspacePath!, "x.txt"), "x\n");
      return { exitCode: 0 };
    });
    h.setJudge(judgeScript(h, [failedVerdict("Not yet.", ["the standard"])]));
    const { task } = await startTask(h, project);

    // The revision is precise: the loop's re-entry replaced the initial
    // run's `completed` with the rework's `failed` — the one sanctioned
    // exception (v12 §6.2) — while `execution.agent` agrees.
    assert.equal(task.execution!.stages!.agent!.status, "failed");
    assert.equal(task.execution!.agent!.status, "failed");
    assert.equal(task.execution!.agent!.attempts, 2, "the rework is the second development attempt");
    assert.equal(task.execution!.failure!.code, "agent-failed");
  });

  test("the same interruption without the loop would not have been allowed to rewrite it", async () => {
    // The containment side of the revision: `stagePatch` — every writer
    // except the loop's re-entry — still refuses to touch a completed stage.
    // This is what makes the loop's exception an exception rather than the
    // beginning of monotonicity's erosion, and v11.publish.test.ts holds the
    // behavior this pins (a failed publish leaves agent/validation
    // completed). Here it is exercised directly through the supervisor's
    // public surface: a cancel landing while only the *judge* is running
    // must not rewrite `stages.agent`.
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const judge = blockingJudge(h);

    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await judge.started;
    const cancelled = await h.supervisor.cancelTask(started.task.id);

    // The judge was interrupted; the development stage was not.
    assert.equal(cancelled!.execution!.status, "cancelled");
    assert.equal(cancelled!.execution!.failure!.stage, "validation", "the cancel landed in the validation stage");
    assert.equal(cancelled!.execution!.stages!.agent!.status, "completed", "a cancel outside the loop cannot rewrite it");
    assert.equal(cancelled!.execution!.agent!.status, "completed");
  });

  test("the rerun path (Retry Agent Run) enters a new cycle without rewriting settled history", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [verdict()]));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.status, "completed");

    // A fresh agent run is a fresh lifecycle: stages return to their
    // pending/running shapes naturally, and the previous cycle's rounds
    // remain visible as history.
    h.setAgent(writeFiles({ "y.txt": "y\n" }));
    h.setJudge(judgeScript(h, [verdict()]));
    const roundsBefore = task.execution!.validation!.rounds!.length;
    await h.supervisor.retryRun(task.id);
    await h.supervisor.whenSettled(task.id);
    const after = h.tasks.get(task.id)!;

    assert.equal(after.execution!.status, "completed");
    assert.equal(after.execution!.agent!.attempts, 2);
    assert.equal(
      after.execution!.validation!.rounds!.length,
      roundsBefore + 1,
      "the new cycle appends to the round history"
    );
    assert.equal((await git(h.workspaces.get(task.workspaceId!)!.path!, ["status", "--porcelain"])).trim(), "");
  });
});
