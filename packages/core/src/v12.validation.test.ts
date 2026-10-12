/**
 * v12 — the Validation Agent and the rework loop, as a whole lifecycle.
 *
 * The promises under test (spec v12 §2/§3/§4/§6):
 *
 *   Validation is a config: absent → skipped; present → a prompt is required.
 *   The judge is a normal Run: its own container, read-only workspace, its
 *   own secrets, the verdict tool provisioned into it.
 *   A failed verdict sends the work back to the development agent (same
 *   workspace, the verdict's conclusion — never the validation prompt) and
 *   the loop repeats, at most `maxAttempts` verdicts before the Task ends.
 *   The verdict is frozen at generation time; every reader returns the
 *   record verbatim.
 *
 * The completion pin, workspace replay and crash recovery have their own
 * suite (`v12.validationPin.test.ts`).
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactService } from "./services.js";
import { DomainError } from "./errors.js";
import { resolveValidationConfig } from "./validation.js";
import { buildJudgeInstruction, buildReworkInstruction } from "./validation.js";
import {
  failedVerdict,
  git,
  judgeScript,
  judgeVerdictPath,
  makeHarness,
  makeRemote,
  setGitIdentity,
  startTask,
  tempDir,
  verdict,
  writeFiles,
  type Harness,
} from "./v12.harness.js";
import type { Project } from "./types.js";

before(() => setGitIdentity());

/* ================================================================== */
/* 1. Validation as a config (v12 §3)                                  */
/* ================================================================== */

describe("v12 validation: configuration", () => {
  test("no validation configured → the stage is skipped, no pin, no judge", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.validation!.status, "skipped");
    assert.equal(task.execution!.stages!.validation!.status, "skipped");
    assert.equal(task.execution!.validation!.rounds, undefined);
    assert.equal(h.judgeRuns, 0);
    // No pin commit: the frozen revision is the only commit (v12 §4.5 —
    // the pin runs only when validation is configured).
    const log = await git(h.workspaces.get(task.workspaceId!)!.path!, ["log", "--oneline"]);
    assert.equal(log.includes("af-pin"), false, "no completion pin was created");
  });

  test("an empty validation prompt is a configuration error, never a silent skip (v12 §3.1)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    await assert.rejects(
      () => h.projects.create({ name: "Demo", source: { remoteUrl: remote }, validation: { prompt: "   " } }),
      (err: unknown) => (err as DomainError).code === "config-invalid"
    );
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    assert.equal(h.projects.list().length, 1, "the invalid project was never created");
    assert.ok(project.id);
  });

  test("a task-level validation override replaces the project default entirely (v12 §3)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the project standard", maxAttempts: 5 },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [verdict()]));
    const { task } = await startTask(h, project, { validation: { prompt: "the task standard" } });

    const judgeRun = h.runService.forTask(task.id).find((r) => r.purpose === "validation")!;
    assert.match(judgeRun.inputInstruction!, /the task standard/);
    assert.equal(judgeRun.inputInstruction!.includes("the project standard"), false, "the project default is replaced, not merged");
    assert.equal(task.execution!.validation!.status, "passed");
  });

  test("resolveValidationConfig: task wins, absence falls back, absence of both is undefined", () => {
    assert.deepEqual(resolveValidationConfig({ prompt: "t" }, { prompt: "p" }), { prompt: "t" });
    assert.deepEqual(resolveValidationConfig(undefined, { prompt: "p" }), { prompt: "p" });
    assert.equal(resolveValidationConfig(undefined, undefined), undefined);
  });
});

/* ================================================================== */
/* 2. The judge run (v12 §4.1/§4.2)                                    */
/* ================================================================== */

describe("v12 validation: the judge run", () => {
  test("the judge is a normal Run: own container, read-only workspace, ephemeral lifecycle", async () => {
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

    assert.equal(h.judgeContexts.length, 1);
    const ctx = h.judgeContexts[0];
    assert.equal(ctx.run.purpose, "validation");
    // The workspace is mounted read-only (v12 §9.1)…
    assert.equal(ctx.policy?.filesystem?.readOnly, true);
    // …in a fresh, disposable container: a keep-alive lease would hand the
    // judge the development agent's read-write container.
    assert.equal(ctx.lifecycle.mode, "ephemeral");
    // The judge run is a distinct record; the task's agent runId is not it.
    assert.notEqual(ctx.run.id, task.execution!.agent!.runId);
    assert.equal(h.runs, 1, "no extra development run was launched");
    assert.equal(h.judgeRuns, 1);
  });

  test("the judge's instruction carries the acceptance standard, the pin and the tool contract", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "go build ./... exits 0" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [verdict()]));
    const { task } = await startTask(h, project);

    const judgeRun = h.runService.forTask(task.id).find((r) => r.purpose === "validation")!;
    const instruction = judgeRun.inputInstruction!;
    assert.match(instruction, /go build \.\/\.\.\. exits 0/, "the acceptance standard is stated verbatim");
    assert.match(instruction, /Add a feature/, "the original task instruction is included");
    assert.match(instruction, new RegExp(`node /root/.agentfabric/validation-tool\\.mjs`), "the tool invocation is exact");
    assert.match(instruction, /READ-ONLY/, "the read-only constraint is stated");
    const pinned = task.execution!.validation!.rounds![0].pinnedRevision!;
    assert.match(instruction, new RegExp(pinned.commitSha), "the pinned commit is named");
    // The judge's own conversation is not polluted by the development run.
    assert.equal(instruction.includes("verdict submitted"), false);
  });

  test("the verdict is frozen at generation time with round/judgeRunId, and read back verbatim", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the acceptance standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const payload = verdict({ summary: "Everything checks out.", evidence: ["`go vet ./...` → clean"] });
    h.setJudge(judgeScript(h, [payload]));
    const { task, run } = await startTask(h, project);

    const frozen = task.execution!.validation!.verdict!;
    assert.deepEqual(
      { passed: frozen.passed, summary: frozen.summary, unmet: frozen.unmet, evidence: frozen.evidence },
      payload,
      "the payload is stored verbatim"
    );
    assert.equal(frozen.round, 1);
    assert.equal(frozen.judgeRunId, task.execution!.validation!.rounds![0].judgeRunId);
    assert.ok(frozen.at, "the freeze instant is recorded");
    // The same verdict is attached as an artifact on the development run.
    const artifact = new ArtifactService(h.store)
      .list(run.id)
      .find((a) => a.name === "validation-verdict.json");
    assert.ok(artifact, "the verdict artifact exists");
    assert.deepEqual(JSON.parse(artifact.content! as string), frozen);
  });

  test("the judge gets no development skills and no MCP configuration", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const skillDir = tempDir("af-v12-skill-");
    writeFileSync(join(skillDir, "run.sh"), "#!/bin/sh\nexit 0\n");
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      skills: [{ name: "developer-tool", path: skillDir }],
      mcpServers: [{ name: "dev-mcp", command: "dev-mcp" }],
      validation: { prompt: "the acceptance standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [verdict()]));
    await startTask(h, project);

    const ctx = h.judgeContexts[0];
    const mounts = JSON.stringify(ctx.extraMounts ?? []);
    assert.equal(mounts.includes("skills"), false, "no skills mount in the judge container");
    assert.equal(mounts.includes("mcp"), false, "no MCP configuration in the judge container");
    // The only extra mount is the verdict tool (v12 §4.1).
    assert.equal((ctx.extraMounts ?? []).length, 1);
  });

  test("a judge that produces no verdict consumes no attempt and settles as a runtime failure", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the acceptance standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    // A judge handler that exits without writing verdict.json.
    h.setJudge(async () => ({ exitCode: 0 }));
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.code, "validation-verdict-missing");
    assert.equal(task.execution!.failure!.stage, "validation");
    assert.equal(task.execution!.validation!.attempts, 0, "a verdict-less judge consumes no attempt");
    assert.equal(task.execution!.agent!.status, "completed", "the agent itself succeeded");
    assert.equal(task.execution!.validation!.rounds!.length, 1);
    assert.equal(task.execution!.validation!.rounds![0].status, "interrupted");
    assert.equal(task.execution!.publish!.status, "pending");
  });

  test("a judge run that errors out without a verdict is not an attempt either", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the acceptance standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(async () => ({ exitCode: 1, error: "judge runtime blew up" }));
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.failure!.code, "validation-runtime-failed");
    assert.equal(task.execution!.validation!.attempts, 0);
    assert.equal(task.execution!.validation!.status, "interrupted");
  });

  test("a malformed verdict file is treated as no verdict (the contract is the parser)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the acceptance standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(async (ctx) => {
      const file = judgeVerdictPath(h.dataDir, ctx.run.id);
      mkdirSync(join(file, ".."), { recursive: true });
      // `unmet` is required on a failure, and evidence may not be empty:
      // this payload violates the contract.
      writeFileSync(file, JSON.stringify({ passed: false, summary: "nope", unmet: [], evidence: [] }));
      return { exitCode: 0 };
    });
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.failure!.code, "validation-verdict-missing");
    assert.equal(task.execution!.validation!.attempts, 0);
  });
});

/* ================================================================== */
/* 3. The rework loop (v12 §4.3/§4.4/§6.1)                             */
/* ================================================================== */

describe("v12 validation: the rework loop", () => {
  test("a failed verdict starts a rework run judged again; round 2 can pass", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the ready flag file exists" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    // Round 1 fails, round 2 passes. The rework agent fixes the workspace.
    h.setJudge(
      judgeScript(h, [
        failedVerdict("The ready flag is missing.", ["ready.flag exists"]),
        verdict(),
      ])
    );
    const originalHandler = writeFiles({ "x.txt": "x\n" });
    h.setAgent(async (ctx) => {
      await originalHandler(ctx);
      // The rework run is the second development run: do what the verdict said.
      if (h.runs >= 2) writeFileSync(join(ctx.workspacePath!, "ready.flag"), "ok\n");
      return { exitCode: 0 };
    });
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.status, "completed");
    assert.equal(task.execution!.validation!.status, "passed");
    assert.equal(task.execution!.validation!.attempts, 2);
    assert.deepEqual(
      task.execution!.validation!.rounds!.map((r) => [r.round, r.verdict!.passed]),
      [
        [1, false],
        [2, true],
      ]
    );
    assert.equal(h.runs, 2, "one initial + one rework development run");
    assert.equal(h.judgeRuns, 2);
    // Round 1's record links the rework; round 2's pin comes from it.
    const [round1, round2] = task.execution!.validation!.rounds!;
    assert.ok(round1.reworkRunId, "round 1 records its rework run");
    assert.equal(round2.pinnedRevision!.runId, round1.reworkRunId, "round 2 judged the rework's output");
  });

  test("the rework instruction carries the verdict's conclusion — never the validation prompt", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "MAGIC-STANDARD-SENTENCE tests pass", maxAttempts: 2 },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [failedVerdict("Two tests still fail.", ["suite/a passes", "suite/b passes"])]));
    const { task } = await startTask(h, project);

    const rework = h.runService.forTask(task.id).find((r) => r.purpose === "rework")!;
    const instruction = rework.inputInstruction!;
    assert.match(instruction, /Add a feature/, "the original task instruction is the base");
    assert.match(instruction, /Two tests still fail\./, "the verdict's conclusion is injected");
    assert.match(instruction, /suite\/a passes/, "the unmet findings are injected");
    assert.equal(instruction.includes("MAGIC-STANDARD-SENTENCE"), false, "the validation prompt is never injected");
  });

  test("the rework run is a development run: it counts as an agent attempt and updates stages.agent", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met", maxAttempts: 2 },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [failedVerdict("Not yet.", ["x"]), verdict()]));
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.agent!.attempts, 2, "the rework run is a second agent attempt");
    assert.equal(task.execution!.agent!.status, "completed");
    // Stage monotonicity is deliberately relaxed for the loop (v12 §6.2):
    // stages.agent reflects the latest development run.
    assert.equal(task.execution!.stages!.agent!.status, "completed");
    assert.equal(task.execution!.stages!.validation!.status, "completed");
  });

  test("the budget is 3 verdicts by default: two reworks, then the task terminates", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [failedVerdict("Still failing.", ["the standard"])]));
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.code, "validation-failed");
    assert.equal(task.execution!.validation!.attempts, 3, "three verdicts were produced");
    assert.equal(h.judgeRuns, 3);
    assert.equal(h.runs, 3, "one initial + two rework runs");
    assert.deepEqual(
      task.execution!.validation!.rounds!.map((r) => [r.round, r.verdict!.passed]),
      [
        [1, false],
        [2, false],
        [3, false],
      ]
    );
    assert.equal(task.execution!.validation!.rounds![2].reworkRunId, undefined, "the last failure starts no rework");
    assert.equal(task.execution!.publish!.status, "pending", "nothing was published");
    assert.equal(task.execution!.agent!.status, "completed", "the agent's own work is not retroactively failed");
    // The task offers Retry Validation (a fresh cycle), not a generic retry.
    const detail = h.supervisor.taskDetail(task.id);
    assert.equal(detail.retry.kind, "validation");
    assert.equal(detail.retry.validation, true);
  });

  test("maxAttempts is configurable per config (v12 §2)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met", maxAttempts: 2 },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(judgeScript(h, [failedVerdict("Still failing.", ["the standard"])]));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.validation!.attempts, 2);
    assert.equal(h.runs, 2, "one initial + one rework");
  });

  test("a rework run that fails terminates the task immediately (v12 已定决策 4)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the standard is met" },
    });
    // The initial run succeeds; the rework run fails.
    h.setAgent(async (ctx) => {
      if (h.runs >= 2) return { exitCode: 1, error: "the rework agent blew up" };
      writeFileSync(join(ctx.workspacePath!, "x.txt"), "x\n");
      return { exitCode: 0 };
    });
    h.setJudge(judgeScript(h, [failedVerdict("Not yet.", ["the standard"])]));
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.code, "agent-failed", "the rework run's own failure classification");
    assert.equal(task.execution!.failure!.stage, "agent");
    assert.equal(h.judgeRuns, 1, "no second judgement was made");
    assert.equal(task.execution!.validation!.attempts, 1);
    assert.equal(task.execution!.stages!.agent!.status, "failed", "the agent stage reflects the failed rework");
  });
});

/* ================================================================== */
/* 4. Retry Validation = a new cycle with a fresh budget (v12 §6.4)   */
/* ================================================================== */

describe("v12 validation: retry validation", () => {
  test("Retry Validation re-judges the same workspace, keeps history, resets the budget", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { prompt: "the ready flag exists" },
    });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    h.setJudge(
      judgeScript(h, [
        failedVerdict("The flag is missing.", ["ready.flag exists"]),
        failedVerdict("The flag is still missing.", ["ready.flag exists"]),
        failedVerdict("The flag is still missing.", ["ready.flag exists"]),
        verdict(),
      ])
    );
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.validation!.attempts, 3, "budget exhausted");

    // A human fixes the workspace out of band and retries validation: the
    // agent does not run again, the budget is fresh, the history is kept.
    writeFileSync(join(h.workspaces.get(task.workspaceId!)!.path!, "ready.flag"), "ok\n");
    const after = await h.supervisor.retryValidation(task.id);

    assert.equal(h.runs, 3, "the development agent did not run again");
    assert.equal(after!.execution!.status, "completed");
    assert.equal(after!.execution!.validation!.status, "passed");
    assert.equal(after!.execution!.validation!.attempts, 1, "the fresh cycle counts its own attempts");
    assert.equal(after!.execution!.validation!.rounds!.length, 4, "the round history is appended, never reset");
    assert.deepEqual(
      after!.execution!.validation!.rounds!.map((r) => [r.round, r.status]),
      [
        [1, "failed"],
        [2, "failed"],
        [3, "failed"],
        [4, "passed"],
      ]
    );
  });

  test("Retry Validation without a configured prompt is refused (v12 §6.4)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    await assert.rejects(
      () => h.supervisor.retryValidation(task.id),
      (err: unknown) => (err as DomainError).code === "task-state-invalid"
    );
  });
});

/* ================================================================== */
/* 5. Instruction builders, as pure functions (v12 §4.2/§4.3)          */
/* ================================================================== */

describe("v12 validation: instruction builders", () => {
  test("the judge instruction names the tool, the output path, the pin and the round", () => {
    const instruction = buildJudgeInstruction({
      taskInstruction: "Add a feature",
      validationPrompt: "the build passes",
      pinnedCommitSha: "a".repeat(40),
      baseCommitSha: "b".repeat(40),
      toolPath: "/root/.agentfabric/validation-tool.mjs",
      outputPath: "/root/.agentfabric/validation-output/verdict.json",
      workspacePath: "/workspace",
      round: 2,
      maxAttempts: 3,
    });
    assert.match(instruction, /node \/root\/\.agentfabric\/validation-tool\.mjs --passed --summary/);
    assert.match(instruction, /node \/root\/\.agentfabric\/validation-tool\.mjs --failed --summary/);
    assert.match(instruction, /\/root\/\.agentfabric\/validation-output\/verdict\.json/);
    assert.match(instruction, new RegExp("a".repeat(12)), "the pin appears (abbreviated) in the diff hint");
    assert.match(instruction, /round 2 of at most 3/);
    assert.match(instruction, /READ-ONLY/);
    assert.match(instruction, /do not fix anything/i);
  });

  test("the rework instruction carries the verdict and never the acceptance standard", () => {
    const instruction = buildReworkInstruction({
      taskInstruction: "Add a feature",
      verdict: {
        passed: false,
        summary: "The tests fail.",
        unmet: ["suite/a passes", "suite/b passes"],
        evidence: ["`npm test` → 2 failures"],
        round: 1,
        judgeRunId: "run_j",
        at: new Date().toISOString(),
      },
      round: 1,
      maxAttempts: 3,
    });
    assert.match(instruction, /^Add a feature/);
    assert.match(instruction, /The tests fail\./);
    assert.match(instruction, /- suite\/a passes/);
    assert.match(instruction, /`npm test` → 2 failures/);
    assert.match(instruction, /continue from it/);
  });
});
