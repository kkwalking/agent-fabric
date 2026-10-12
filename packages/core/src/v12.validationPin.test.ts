/**
 * v12 §4.5/§6.4 — the completion pin, workspace replay and crash recovery.
 *
 * The promises under test (the outer, mechanism-level containment of
 * "the Validation Agent can never get code into the final product"):
 *
 *   Every development run's output is frozen into a commit (the pin) before
 *   judging; the judge validates that revision.
 *   Any drift a judge leaves behind — a commit, dirty files, untracked
 *   files, a switched branch — is detected after the judgement and replayed
 *   away with `reset --hard <pin>` + `clean -fd`, loudly.
 *   The replay targets exactly the recorded pin, never an arbitrary ref, and
 *   restores HEAD, branch and porcelain.
 *   After a rework, the next round pins anew; the old pin is history.
 *   A crash between the pin and the verdict leaves a recorded anchor that
 *   recovery replays to before the tree is re-pinned.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitOps, type GitOps } from "./git.js";
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
import type { Task } from "./types.js";

before(() => setGitIdentity());

/**
 * A fake git recording the exact argv the supervisor issues for the two
 * replay primitives. Every other operation delegates to the real GitOps
 * (the pin must be a real commit; drift must be real drift).
 */
interface ReplayRecorder {
  /** The wrapped GitOps to hand to the supervisor. */
  git: GitOps;
  /** argv of every reset issued, e.g. ["reset", "--hard", sha]. */
  resets: string[][];
  /** argv of every clean issued, e.g. ["clean", "-fd"]. */
  cleans: string[][];
}

function recordingGit(inner: GitOps): ReplayRecorder {
  const resets: string[][] = [];
  const cleans: string[][] = [];
  const git: GitOps = {
    ...inner,
    async resetHard(opts) {
      resets.push(["reset", "--hard", opts.revision]);
      return inner.resetHard(opts);
    },
    async cleanUntracked(opts) {
      cleans.push(["clean", "-fd"]);
      return inner.cleanUntracked(opts);
    },
  };
  return { git, resets, cleans };
}

/** A project with validation configured, an agent, and one judge that drifts. */
type DriftAction = (workspacePath: string, judgeRunId: string) => Promise<void>;

async function withDriftingJudge(h: Harness, drift: DriftAction): Promise<{ task: Task; workspacePath: string }> {
  const { remote } = await makeRemote();
  const project = await h.projects.create({
    name: "Demo",
    source: { remoteUrl: remote },
    validation: { prompt: "the acceptance standard is met" },
  });
  h.setAgent(writeFiles({ "x.txt": "x\n" }));
  h.setJudge(judgeScript(h, [verdict()], async (ctx) => drift(ctx.workspacePath!, ctx.run.id)));
  const { task } = await startTask(h, project);
  return { task, workspacePath: h.workspaces.get(task.workspaceId!)!.path! };
}

async function makeDriftHarness(): Promise<{ h: Harness; recorder: ReplayRecorder }> {
  const recorder = recordingGit(createGitOps());
  const h = await makeHarness({ git: recorder.git });
  return { h, recorder };
}

/* ================================================================== */
/* 1. Pin creation (v12 §4.5)                                          */
/* ================================================================== */

describe("v12 pin: the completion pin", () => {
  test("the dirty development output is committed as the pin before judging", async () => {
    const h = await makeHarness();
    const { task, workspacePath } = await withDriftingJudge(h, async () => {});
    const pin = task.execution!.validation!.rounds![0].pinnedRevision!;

    // The pin is a real commit holding the agent's work, and its body names
    // the development run it froze (spec §4.5: `af-pin: <runId>`).
    const show = await git(workspacePath, ["show", "--stat", "--format=%B", pin.commitSha]);
    assert.match(show, /x\.txt/, "the pin carries the agent's output");
    assert.match(show, /af-pin/, "the pin is annotated with its run");
    assert.notEqual(pin.commitSha, task.baseCommitSha, "the pin is a new commit");
    // The pin event is on the development run's stream.
    const types = (await h.store.readEvents(task.execution!.agent!.runId!)).map((e) => e.type);
    assert.ok(types.includes("validation.pinned"), "validation.pinned was emitted");
    // Finalization creates no further commit: the pin *is* the published
    // revision (spec §4.5 — the commit moves earlier, to the pin).
    assert.equal(task.execution!.frozenRevision!.finalCommitSha, pin.commitSha);
  });

  test("a clean workspace pins the current HEAD without creating a commit", async () => {
    const h = await makeHarness();
    const { remote, baseSha } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the acceptance standard is met" },
    });
    // This agent commits its own work and leaves a clean tree.
    h.setAgent(async (ctx) => {
      const dir = ctx.workspacePath!;
      writeFileSync(join(dir, "committed.txt"), "done\n");
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "--quiet", "-m", "agent work"]);
      return { exitCode: 0 };
    });
    h.setJudge(judgeScript(h, [verdict()]));
    const { task } = await startTask(h, project);

    const pin = task.execution!.validation!.rounds![0].pinnedRevision!;
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    assert.notEqual(pin.commitSha, baseSha);
    assert.equal((await git(workspacePath, ["rev-parse", "HEAD"])).trim(), pin.commitSha);
    const log = await git(workspacePath, ["log", "--format=%B"]);
    assert.ok(log.includes("agent work"), "the agent's commit is the pin");
    assert.equal(log.includes("af-pin"), false, "a clean tree creates no pin commit");
  });

  test("the pin commit honors the configured commit message template", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      git: { commitMessage: "feat: {title}" },
      validation: { prompt: "the acceptance standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [verdict()]));
    const { task } = await startTask(h, project);
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    const head = await git(workspacePath, ["log", "-1", "--format=%B"]);
    assert.match(head, /feat: /, "the template renders as the subject");
    assert.match(head, /af-pin/, "the annotation is appended to the body");
  });
});

/* ================================================================== */
/* 2. Drift detection and replay (v12 §4.5)                            */
/* ================================================================== */

describe("v12 pin: drift detection and replay", () => {
  test("a judge that commits is detected, replayed to the pin, and its verdict still counts", async () => {
    const { h, recorder } = await makeDriftHarness();
    const { task, workspacePath } = await withDriftingJudge(h, async (path) => {
      writeFileSync(join(path, "judge-commit.txt"), "judge wrote this\n");
      await git(path, ["add", "-A"]);
      await git(path, ["commit", "--quiet", "-m", "sneaky commit by the judge"]);
    });

    const round = task.execution!.validation!.rounds![0];
    const pin = round.pinnedRevision!;
    // The drift was detected and recorded on the round…
    assert.ok(round.drift, "the drift is recorded");
    assert.equal(round.drift!.detected, true);
    assert.notEqual(round.drift!.observedHead, pin.commitSha, "the observed HEAD is the judge's commit");
    // …the replay issued exactly the pin — never an arbitrary ref…
    assert.deepEqual(recorder.resets, [["reset", "--hard", pin.commitSha]]);
    assert.deepEqual(recorder.cleans, [["clean", "-fd"]]);
    // …and the workspace is exactly back at the pin.
    assert.equal((await git(workspacePath, ["rev-parse", "HEAD"])).trim(), pin.commitSha);
    assert.equal((await git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), task.workingBranch);
    assert.equal((await git(workspacePath, ["status", "--porcelain"])).trim(), "");
    assert.equal(existsSync(join(workspacePath, "judge-commit.txt")), false);
    // The verdict remains valid — it judged the pin, not the drifted tree —
    // and the judge's commit is not in the published revision.
    assert.equal(round.verdict!.passed, true);
    assert.equal(task.execution!.status, "completed");
    const published = await git(workspacePath, ["ls-tree", "-r", "--name-only", task.execution!.frozenRevision!.finalCommitSha]);
    assert.equal(published.includes("judge-commit.txt"), false);
    // The replay is loud.
    const types = (await h.store.readEvents(task.execution!.agent!.runId!)).map((e) => e.type);
    assert.ok(types.includes("validation.workspace.replayed"), "the replay is a visible event");
  });

  test("a judge that only dirties tracked files is replayed away", async () => {
    const { h, recorder } = await makeDriftHarness();
    const { task, workspacePath } = await withDriftingJudge(h, async (path) => {
      writeFileSync(join(path, "x.txt"), "the judge edited the agent's file\n");
    });

    const round = task.execution!.validation!.rounds![0];
    assert.ok(round.drift, "the dirty tree is detected as drift");
    assert.deepEqual(recorder.resets, [["reset", "--hard", round.pinnedRevision!.commitSha]]);
    assert.equal(readFileSync(join(workspacePath, "x.txt"), "utf8"), "x\n", "the edit was replayed away");
    assert.equal(task.execution!.status, "completed");
  });

  test("a judge that leaves untracked files is replayed away (clean -fd)", async () => {
    const { h, recorder } = await makeDriftHarness();
    const { task, workspacePath } = await withDriftingJudge(h, async (path) => {
      writeFileSync(join(path, "judge-scratch.txt"), "leftover\n");
    });

    const round = task.execution!.validation!.rounds![0];
    assert.ok(round.drift, "untracked files are drift");
    assert.ok(round.drift!.driftedPaths?.includes("judge-scratch.txt"), "the drift record names the path");
    assert.deepEqual(recorder.cleans, [["clean", "-fd"]]);
    assert.equal(existsSync(join(workspacePath, "judge-scratch.txt")), false);
  });

  test("a judge that switches branches is replayed back onto the task branch at the pin", async () => {
    const { h, recorder } = await makeDriftHarness();
    const { task, workspacePath } = await withDriftingJudge(h, async (path) => {
      await git(path, ["checkout", "--quiet", "-b", "judge-side-branch"]);
    });

    const round = task.execution!.validation!.rounds![0];
    const pin = round.pinnedRevision!;
    assert.ok(round.drift, "a switched branch is drift even without dirty files");
    // `reset --hard` moves the branch you are standing on; it does not
    // switch back. The replay must restore the branch too (spec §11.2:
    // HEAD + branch + porcelain all match the pin's state exactly).
    assert.equal((await git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), task.workingBranch);
    assert.equal((await git(workspacePath, ["rev-parse", "HEAD"])).trim(), pin.commitSha);
    assert.equal((await git(workspacePath, ["status", "--porcelain"])).trim(), "");
    // Whatever argv shape the replay needs, every reset names the recorded
    // pin — never an arbitrary ref (spec §4.5).
    assert.ok(recorder.resets.length >= 1, "the replay ran");
    for (const argv of recorder.resets) {
      assert.deepEqual(argv.slice(0, 2), ["reset", "--hard"]);
      assert.equal(argv[2], pin.commitSha);
    }
    assert.equal(task.execution!.status, "completed");
  });

  test("a judge that behaves is not replayed", async () => {
    const { h, recorder } = await makeDriftHarness();
    const { task } = await withDriftingJudge(h, async () => {});

    const round = task.execution!.validation!.rounds![0];
    assert.equal(round.drift, undefined, "no drift was recorded");
    assert.deepEqual(recorder.resets, [], "no reset was issued");
    assert.deepEqual(recorder.cleans, [], "no clean was issued");
  });

  test("a rework re-pins: round 2 judges and replays to the new pin, not round 1's", async () => {
    const { h, recorder } = await makeDriftHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the flag exists" },
    });
    // The rework run produces new work (a distinct revision to pin).
    let devRuns = 0;
    h.setAgent(async (ctx) => {
      devRuns += 1;
      const dir = ctx.workspacePath!;
      writeFileSync(join(dir, "x.txt"), "x\n");
      if (devRuns > 1) writeFileSync(join(dir, "rework.txt"), "rework\n");
      return { exitCode: 0 };
    });
    let judgeIndex = 0;
    h.setJudge(async (ctx) => {
      judgeIndex += 1;
      // Round 1's judge fails the work and leaves a sneaky file behind.
      if (judgeIndex === 1) writeFileSync(join(ctx.workspacePath!, "sneaky.txt"), "from round 1 judge\n");
      const file = judgeVerdictPath(h.dataDir, ctx.run.id);
      mkdirSync(join(file, ".."), { recursive: true });
      const payload = judgeIndex === 1 ? failedVerdict("no flag", ["flag"]) : verdict();
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
      return { exitCode: 0 };
    });
    const { task } = await startTask(h, project);

    const [round1, round2] = task.execution!.validation!.rounds!;
    assert.ok(round1.drift, "round 1's drift was detected and replayed");
    // The rework run re-pinned: round 2's subject is a new revision, and the
    // round-1 judge's residue did not survive into it.
    assert.notEqual(round2.pinnedRevision!.commitSha, round1.pinnedRevision!.commitSha);
    assert.equal(round2.pinnedRevision!.runId, round1.reworkRunId, "the new pin names the rework run");
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    const tree = await git(workspacePath, ["ls-tree", "-r", "--name-only", round2.pinnedRevision!.commitSha]);
    assert.equal(tree.includes("sneaky.txt"), false, "the judge's residue is not in the next pin");
    assert.ok(tree.includes("rework.txt"), "the new pin carries the rework's output");
    assert.equal(task.execution!.status, "completed");
    // Every replay named a pin recorded for its time — never an arbitrary ref.
    for (const argv of recorder.resets) {
      const sha = argv[2];
      assert.ok(
        sha === round1.pinnedRevision!.commitSha || sha === round2.pinnedRevision!.commitSha,
        `replay named a recorded pin: ${sha}`
      );
    }
  });
});

/* ================================================================== */
/* 3. Crash recovery: pin written, verdict never frozen (v12 §6.4)     */
/* ================================================================== */

describe("v12 pin: crash recovery re-enters through the pin", () => {
  test("a crash in the pin-then-judge window replays residue before re-judging", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the acceptance standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [verdict()]));
    const { task } = await startTask(h, project);
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    const round = task.execution!.validation!.rounds![0];

    // Rewind to the crash window: the process died while the judge was
    // running — the pin is recorded, the round is still "judging".
    const crashed: Task = {
      ...task,
      execution: {
        ...task.execution!,
        phase: "validation.running",
        status: "validating",
        failure: undefined,
        validation: {
          ...task.execution!.validation!,
          status: "running",
          rounds: [{ ...round, status: "judging", judgeRunId: undefined, verdict: undefined, drift: undefined, endedAt: undefined }],
        },
      },
    };
    await h.store.update<Task>("tasks", task.id, { execution: crashed.execution });
    // Residue that appeared while "no one was watching" (the dead process, a
    // tool the judge spawned): an untracked file on top of the pin. It must
    // be replayed away before judging resumes, never laundered in.
    const residue = join(workspacePath, "leftover-from-dead-judge.txt");
    writeFileSync(residue, "residue\n");

    // Restart recovery marks the stage interrupted…
    await h.supervisor.recoverInterrupted();
    const afterRecovery = h.tasks.get(task.id)!;
    assert.equal(afterRecovery.execution!.failure!.code, "supervisor-restarted");
    assert.equal(afterRecovery.execution!.failure!.stage, "validation");

    // …and the sanctioned retry (Retry Validation) re-enters the cycle,
    // replays to the recorded pin, then re-judges.
    let residueSeenByJudge = true;
    h.setJudge(async (ctx) => {
      residueSeenByJudge = existsSync(residue);
      const file = judgeVerdictPath(h.dataDir, ctx.run.id);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `${JSON.stringify(verdict({ summary: "Recovered and judged." }), null, 2)}\n`);
      return { exitCode: 0 };
    });
    const after = await h.supervisor.retryValidation(task.id);

    assert.equal(after!.execution!.status, "completed");
    const rounds = after!.execution!.validation!.rounds!;
    // The stale round was resolved as interrupted, with its drift recorded.
    assert.equal(rounds.length, 2, "the interrupted round is kept, the recovery round is appended");
    assert.equal(rounds[0].status, "interrupted");
    assert.equal(rounds[0].errorCode, "supervisor-restarted");
    assert.equal(rounds[0].drift!.detected, true, "the residue was detected as drift");
    assert.ok(rounds[0].drift!.driftedPaths?.includes("leftover-from-dead-judge.txt"));
    // The recovery round judged a clean tree at the pin — replay ran *before*
    // the judge, so the residue could not ride into the new pin.
    assert.equal(residueSeenByJudge, false, "the residue was replayed before re-judging");
    const recovery = rounds[1];
    assert.equal(recovery.verdict!.passed, true);
    assert.equal(existsSync(residue), false);
    assert.equal((await git(workspacePath, ["status", "--porcelain"])).trim(), "");
    const tree = await git(workspacePath, ["ls-tree", "-r", "--name-only", recovery.pinnedRevision!.commitSha]);
    assert.equal(tree.includes("leftover-from-dead-judge.txt"), false);
  });
});
