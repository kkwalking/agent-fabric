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
   */
  async cancelTask(taskId: ID): Promise<Task | undefined> {
    const task = this.tasks().get(taskId);
    if (!task) return undefined;
    const active = this.runService
      .forTask(taskId)
      .find((run) => this.runService.isExecuting(run.id) || run.status === "pending" || run.status === "starting");
    if (active) await this.runService.cancel(active.id);
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
