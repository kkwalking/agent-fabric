/**
 * Tests for the v5 spec (v5.md): the Web UX refactor's only core-model
 * change — every Run records the user's actual input separately from the
 * full instruction sent to the harness.
 *
 * - §5: `run.userPrompt` is the bare user input; `run.inputInstruction`
 *   stays the complete execution instruction (handoff context included).
 * - submit / resume / handoff / rerun all record the correct userPrompt.
 * - The Task Thread never has to show the rendered handoff prompt as a
 *   User Message (§4/§21), and the Run Inspector still can (§12).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshHarness, waitForRun, type Harness } from "./testkit.js";

function mockRuntimeOf(h: Harness): { id: string } {
  const rt = h.store.list("runtimes").find((r: any) => r.kind === "mock");
  assert.ok(rt, "seeded mock runtime must exist");
  return rt;
}

test("submit records userPrompt identical to the task prompt (v5 §5)", async () => {
  const h = await freshHarness();
  const { task, run } = await h.runService.submit({
    prompt: "介绍一下当前项目",
    runtimeId: mockRuntimeOf(h).id,
  });
  assert.equal(run.userPrompt, "介绍一下当前项目");
  assert.equal(run.inputInstruction, "介绍一下当前项目");
  assert.equal(task.prompt, "介绍一下当前项目");
  const finished = await waitForRun(h.runService, run.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.userPrompt, "介绍一下当前项目");
});

test("resume continuation keeps the bare prompt out of harness context (v5 §5)", async () => {
  const h = await freshHarness();
  const mock = mockRuntimeOf(h);
  const first = await h.runService.submit({ prompt: "介绍一下当前项目", runtimeId: mock.id });
  await waitForRun(h.runService, first.run.id);

  const result = await h.runService.continueTask(first.task.id, { prompt: "那它现在的 runtime 设计是什么？" });
  assert.equal(result.continuity, "resume");
  assert.equal(result.run.userPrompt, "那它现在的 runtime 设计是什么？");
  assert.equal(result.run.inputInstruction, "那它现在的 runtime 设计是什么？");
  await waitForRun(h.runService, result.run.id);
});

test("handoff continuation separates userPrompt from the rendered handoff instruction (v5 §5/§21)", async () => {
  const h = await freshHarness();
  const mock = mockRuntimeOf(h);
  const first = await h.runService.submit({ prompt: "介绍一下当前项目", runtimeId: mock.id });
  await waitForRun(h.runService, first.run.id);

  // Simulate session loss so continuation falls back to a handoff.
  const refs = h.runtimeSessions.list({ taskId: first.task.id });
  await h.runtimeSessions.expire(refs[0].id);

  const result = await h.runService.continueTask(first.task.id, { prompt: "换一个思路继续" });
  assert.equal(result.continuity, "handoff");
  assert.ok(result.handoff);

  // The User Message shown in the Task Thread is the bare prompt…
  assert.equal(result.run.userPrompt, "换一个思路继续");
  // …while the harness received the full handoff briefing around it.
  assert.notEqual(result.run.inputInstruction, result.run.userPrompt);
  assert.match(result.run.inputInstruction!, /Handoff from/);
  assert.match(result.run.inputInstruction!, /换一个思路继续/);
  const finished = await waitForRun(h.runService, result.run.id);
  assert.equal(finished.userPrompt, "换一个思路继续");
});

test("rerun records the original user prompt as userPrompt (v5 §5)", async () => {
  const h = await freshHarness();
  const mock = mockRuntimeOf(h);
  const first = await h.runService.submit({ prompt: "介绍一下当前项目", runtimeId: mock.id });
  const finished = await waitForRun(h.runService, first.run.id);
  assert.equal(finished.status, "completed");

  const again = await h.runService.rerun(finished.id);
  assert.equal(again.run.userPrompt, "介绍一下当前项目");
  assert.equal(again.run.inputInstruction, "介绍一下当前项目");
  assert.notEqual(again.run.id, finished.id, "rerun creates a fresh run on the same task");
  const done = await waitForRun(h.runService, again.run.id);
  assert.equal(done.status, "completed");
});
