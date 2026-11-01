import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionSupervisor } from "./supervisor.js";
import { TaskService, WorkspaceService } from "./services.js";
import { isDomainError } from "./errors.js";
import type { Task, TaskExecution } from "./types.js";
import { freshHarness, mkdtempSync, join, tmpdir } from "./testkit.js";

/**
 * The two writes `ExecutionSupervisor` makes about a Task's execution, and the
 * one it must not make.
 *
 * These are the paths the board never touches: a classical Task's cancel and
 * retry. The board card path writes its own projection (`KanbanService`), and
 * because it does, nobody noticed that these two did not.
 */

/** A workspace directory a Run could execute in (no execution happens here). */
function workspaceDir(): string {
  return mkdtempSync(join(tmpdir(), "af-sup-ws-"));
}

/** A Task with a settled `execution`, as a failed first attempt leaves it. */
async function settledTask(
  store: Awaited<ReturnType<typeof freshHarness>>["store"],
  options: { execution?: TaskExecution } = {}
): Promise<Task> {
  const workspaces = new WorkspaceService(store);
  const workspace = await workspaces.create({ name: "sup", type: "local", path: workspaceDir() });
  const tasks = new TaskService(store);
  return tasks.create({
    title: "supervised task",
    prompt: "do the work",
    workspaceId: workspace.id,
    execution: options.execution,
  });
}

const FAILED_EXECUTION: TaskExecution = {
  phase: "failed",
  status: "failed",
  failure: {
    stage: "agent",
    code: "agent-failed",
    message: "the agent died",
    at: "2026-01-01T00:00:00.000Z",
  },
  agent: { status: "failed", runId: "run_prev", attempts: 1 },
  stages: { agent: { status: "failed", at: "2026-01-01T00:00:00.000Z", errorCode: "agent-failed" } },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("cancelling a task with nothing in flight reports no cancellation", async () => {
  const h = await freshHarness();
  const task = await settledTask(h.store, { execution: FAILED_EXECUTION });
  const supervisor = new ExecutionSupervisor(h.store, (await import("./eventbus.js")).EventBus.prototype as never, h.runService);

  // A second Cancel click (or a Cancel after the run already settled) used to
  // rewrite the record to `cancelled` + `agent-cancelled`, turning a finished
  // task into a user-cancelled failure it never was.
  const before = new TaskService(h.store).get(task.id)!;
  const after = await supervisor.cancelTask(task.id);
  assert.ok(after);
  assert.equal(after.execution?.status, before.execution?.status, "the stored execution is left as it was");
  assert.equal(after.execution?.failure?.code, "agent-failed", "the real failure is not replaced by a fabricated cancel");
});

test("cancelling a task whose live run belongs to the board says where to stop it", async () => {
  const h = await freshHarness();
  const task = await settledTask(h.store, { execution: { ...FAILED_EXECUTION, status: "running", phase: "agent.running" } });
  const tasks = new TaskService(h.store);

  // A board card's Run is created `running` and its agent is a child process,
  // so it is never a supervisor run. Cancel must refuse loudly rather than
  // claim a cancellation it cannot perform while the agent keeps writing.
  await h.runService.recordRunForTask(tasks.get(task.id)!, {
    runtimeId: "rt_dsh",
    workspaceId: tasks.get(task.id)!.workspaceId!,
    phase: "agent.running",
    status: "running",
    purpose: "development",
    runtimeName: "dsh",
  });

  const supervisor = new ExecutionSupervisor(h.store, (await import("./eventbus.js")).EventBus.prototype as never, h.runService);
  const before = tasks.get(task.id)!.execution;
  await assert.rejects(
    () => supervisor.cancelTask(task.id),
    (err: unknown) => {
      assert.ok(isDomainError(err));
      assert.equal(err.code, "task-not-cancellable");
      assert.match(err.message, /kanban\/cards\/:id\/stop/);
      return true;
    }
  );

  // And the record was not rewritten on the way out.
  assert.deepEqual(tasks.get(task.id)!.execution, before);
});

test("retrying projects the new attempt onto the task before it runs", async () => {
  const h = await freshHarness();
  const task = await settledTask(h.store, { execution: FAILED_EXECUTION });
  const supervisor = new ExecutionSupervisor(h.store, (await import("./eventbus.js")).EventBus.prototype as never, h.runService);

  const { run } = await supervisor.retryRun(task.id);
  const after = new TaskService(h.store).get(task.id)!;

  // `execution.agent.runId` used to keep naming the previous attempt, so the
  // task page stopped polling a live retry and its Cancel button pointed at the
  // finished Run.
  assert.equal(after.execution?.agent?.runId, run.id, "the execution names the run that is in flight");
  assert.equal(after.execution?.status, "running");
  assert.equal(after.execution?.phase, "agent.running");
  // The superseded attempt's failure is gone: it is not the state of the task.
  assert.equal(after.execution?.failure, undefined);
  assert.equal(after.execution?.agent?.attempts, 2, "a retry is the second attempt");
  // A stage that already finished is not forgotten by the retry.
  assert.ok(after.execution?.stages?.agent, "recorded stages carry forward");
});
