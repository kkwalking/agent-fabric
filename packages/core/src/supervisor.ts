/**
 * Task lifecycle helpers.
 *
 * Tasks run in a workspace directory in place: the Runtime adapter executes
 * the prompt, the Run records what happened, and there is no platform-managed
 * clone, branch, validation judge or publish stage. The supervisor therefore
 * only exposes the generic reads and recovery hooks the server needs around
 * those Runs.
 */
import { EventBus } from "./eventbus.js";
import { Store } from "./store.js";
import { DomainError, retryKindForFailure, type RetryKind } from "./errors.js";
import { RunService } from "./orchestrator.js";
import { RuntimeService, TaskService, WorkspaceService, now } from "./services.js";
import type { ID, Run, RunPhase, Runtime, Task, TaskExecution, TaskFailure, TaskStageStates, Workspace } from "./types.js";

/** Aggregated read model behind the Task Detail view. */
export interface TaskDetailView {
  task: Task;
  workspace: Workspace | null;
  runtime: Runtime | null;
  phase: RunPhase;
  status: TaskExecution["status"];
  failure?: TaskFailure;
  agent?: TaskExecution["agent"];
  /** Per-stage outcomes recorded on the Task, when a board session projected them. */
  stages?: TaskStageStates;
  runs: Run[];
  /** Which retry the current state permits. */
  retry: { agent: boolean; kind: RetryKind };
  /** Set while a Run of this Task is executing in this process. */
  running: boolean;
}

export class ExecutionSupervisor {
  constructor(
    private store: Store,
    private bus: EventBus,
    private runService: RunService
  ) {}

  private tasks(): TaskService {
    return new TaskService(this.store);
  }

  private workspaces(): WorkspaceService {
    return new WorkspaceService(this.store);
  }

  private runtimes(): RuntimeService {
    return new RuntimeService(this.store);
  }

  /** True while a Run of this Task is executing in this process. */
  isRunning(taskId: ID): boolean {
    return this.runService.forTask(taskId).some((run) => this.runService.isExecuting(run.id));
  }

  /** Waits for the task's in-flight Run (tests and API callers). */
  async whenSettled(taskId: ID): Promise<void> {
    const active = this.runService.forTask(taskId).filter((run) => this.runService.isExecuting(run.id));
    await Promise.all(active.map((run) => this.runService.executeRun(run.id).catch(() => {})));
  }

  /**
   * Cancels the Task's in-flight Run. The workspace and every uncommitted
   * modification in it are preserved.
   *
   * Reporting is gated on a cancellation actually happening. The write used to
   * be unconditional, which produced two lies:
   *
   * - a **board card** has no supervisor Run at all — its Run is created
   *   `running` and the agent is a PTY/ACP child — so `active` was always
   *   absent, nothing was stopped, and the Task was still rewritten to
   *   `cancelled` / `failure.code: "agent-cancelled"` while the agent kept
   *   writing. A board card is stopped through the board
   *   (`POST /api/kanban/cards/:id/stop`), so this says so instead;
   * - clicking Cancel a second time, or after the Run already settled,
   *   relaunched a finished Task's report as a user-cancelled failure.
   */
  async cancelTask(taskId: ID): Promise<Task | undefined> {
    const task = this.tasks().get(taskId);
    if (!task) return undefined;
    const active = this.runService
      .forTask(taskId)
      .find((run) => this.runService.isExecuting(run.id) || run.status === "pending" || run.status === "starting");
    if (!active) {
      // Nothing of ours was in flight, so nothing may be reported as cancelled.
      // A live board session is a different cancellation path, named here so
      // the caller learns where the stop actually lives.
      const live = this.runService
        .forTask(taskId)
        .find((run) => run.status === "running");
      if (live) {
        throw new DomainError(
          "task-not-cancellable",
          `Run ${live.id} is not a supervisor run — a board session is stopped with POST /api/kanban/cards/:id/stop`
        );
      }
      return this.tasks().get(taskId);
    }
    await this.runService.cancel(active.id);
    if (task.execution) {
      await this.tasks().update(taskId, {
        execution: {
          ...task.execution,
          phase: "cancelled",
          status: "cancelled",
          failure: { stage: "agent", code: "agent-cancelled", message: "Cancelled by user", at: now() },
          updatedAt: now(),
        },
      });
    }
    return this.tasks().get(taskId);
  }

  /**
   * Retry Agent Run: a **new** Run continues on the same Workspace. The
   * workspace keeps every modification made so far, so the new Run picks the
   * work up where it stopped.
   *
   * The new attempt is projected onto the Task immediately, before the Run is
   * handed to the executor. Without that write `Task.execution.agent.runId` kept
   * naming the *previous* attempt, and every reader of the stored record went
   * wrong in a different way: the task page's `status` stayed at whatever the
   * old attempt ended as (so it stopped polling a live retry), the per-Run
   * Cancel button pointed at the finished Run, and `retry.agent` could be `true`
   * while a Run was executing — offering a button that the server then refused
   * with `task-busy`.
   */
  async retryRun(
    taskId: ID,
    input: { instruction?: string; runtimeId?: ID; modelId?: ID } = {}
  ): Promise<{ task: Task; run: Run }> {
    const task = this.tasks().get(taskId);
    if (!task) throw new DomainError("task-not-found", `Task not found: ${taskId}`);
    if (this.isRunning(taskId)) throw new DomainError("task-busy", "This task still has a run in flight");
    if (!task.workspaceId) throw new DomainError("workspace-invalid", "This task has no workspace to run in");
    const instruction = input.instruction?.trim() || task.prompt;
    const run = await this.runService.createRunForTask(task, {
      runtimeId: input.runtimeId ?? task.runtimeId,
      modelId: input.modelId ?? task.modelId,
      workspaceId: task.workspaceId,
      continuity: "new",
      inputInstruction: instruction,
      userPrompt: instruction,
    });
    const at = now();
    const previous = task.execution;
    await this.tasks().update(taskId, {
      execution: {
        phase: "agent.running",
        status: "running",
        // The superseded attempt's failure is gone: it is no longer the state of
        // the Task. `stages` carries forward, like the board's projection does.
        failure: undefined,
        agent: {
          status: "pending",
          runId: run.id,
          attempts: (previous?.agent?.attempts ?? 0) + 1,
        },
        stages: { ...(previous?.stages ?? {}) },
        updatedAt: at,
      },
    });
    void this.runService.executeRun(run.id).catch(() => {});
    return { task: this.tasks().get(taskId)!, run };
  }

  /** The aggregated Task Detail read model. */
  taskDetail(taskId: ID): TaskDetailView {
    const task = this.tasks().get(taskId);
    if (!task) throw new DomainError("task-not-found", `Task not found: ${taskId}`);
    const runs = this.runService.forTask(taskId);
    const latest = runs[runs.length - 1];
    const execution = task.execution;
    const failure = execution?.failure;
    const running = this.isRunning(taskId);
    const status: TaskExecution["status"] =
      execution?.status ??
      (running
        ? "running"
        : latest?.status === "completed"
          ? "completed"
          : latest?.status === "failed"
            ? "failed"
            : latest?.status === "cancelled"
              ? "cancelled"
              : "created");
    return {
      task,
      workspace: task.workspaceId ? this.workspaces().get(task.workspaceId) ?? null : null,
      runtime: task.runtimeId ? this.runtimes().get(task.runtimeId) ?? null : null,
      phase: execution?.phase ?? latest?.phase ?? "task.created",
      status,
      failure,
      agent: execution?.agent,
      stages: execution?.stages,
      runs,
      retry: {
        agent: !running && failure !== undefined,
        kind: retryKindForFailure(failure?.stage),
      },
      running,
    };
  }

  /**
   * A classic Task has no persisted lifecycle to recover: its Run record is
   * the source of truth and a restart leaves it non-terminal. Nothing to mark.
   */
  async recoverInterrupted(): Promise<{ tasks: ID[]; workspaces: ID[] }> {
    return { tasks: [], workspaces: [] };
  }
}
