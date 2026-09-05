import { get, fmtRelative } from "../api";
import { StatusBadge, useAsync, ErrorBox } from "../components";
import { navigate } from "../router";

/**
 * Task List (v5 §16/§32): Tasks are the user's long-lived work threads;
 * Runs are executions inside them. Clicking a task opens its thread —
 * the primary surface — not a run page.
 */
export function TasksView() {
  const tasks = useAsync<any[]>(() => get("/api/tasks"), []);
  const runs = useAsync<any[]>(() => get("/api/runs"), []);
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);

  if (tasks.error) return <ErrorBox message={tasks.error} />;

  const runsByTask = new Map<string, any[]>();
  for (const r of runs.data ?? []) {
    const list = runsByTask.get(r.taskId) ?? [];
    list.push(r);
    runsByTask.set(r.taskId, list);
  }
  const wsName = (id?: string) => (workspaces.data ?? []).find((w) => w.id === id)?.name;
  const isLive = (s: string) => ["pending", "starting", "running"].includes(s);

  const entries = (tasks.data ?? [])
    .map((t) => {
      const taskRuns = (runsByTask.get(t.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const last = taskRuns[taskRuns.length - 1];
      return {
        task: t,
        runs: taskRuns,
        last,
        status: taskRuns.some((r) => isLive(r.status)) ? "running" : (last?.status ?? "pending"),
        lastActivity: last?.endTime ?? last?.createdAt ?? t.createdAt,
      };
    })
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  return (
    <div>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>Tasks</h1>
        <span className="right">
          <button className="small" onClick={() => { tasks.reload(); runs.reload(); }}>refresh</button>{" "}
          <button className="small primary" onClick={() => navigate("/new")}>New task</button>
        </span>
      </div>
      <p className="sub">
        A Task is your long-term work thread. The system executes each step as a Run — resume or hand off
        between agents without leaving the thread.
      </p>

      {entries.length === 0 ? (
        <div className="card muted">
          No tasks yet — create one with <a onClick={() => navigate("/new")}>New task</a>.
        </div>
      ) : (
        <div className="task-list">
          {entries.map(({ task, runs: taskRuns, last, status, lastActivity }) => (
            <div key={task.id} className="task-item card" onClick={() => navigate(`/tasks/${task.id}`)}>
              <div className="task-item-head">
                <strong className="task-item-title">{task.title}</strong>
                <StatusBadge status={status} />
              </div>
              <div className="task-item-meta">
                <span className="meta-chip">
                  {last?.runtimeName ? `${last.runtimeName}` : "—"}
                  {last ? ` · last run ${last.status}` : " · no runs"}
                </span>
                <span className="meta-chip"><span className="muted">workspace</span> {wsName(last?.workspaceId ?? task.workspaceId) ?? "—"}</span>
                <span className="meta-chip">{taskRuns.length} {taskRuns.length === 1 ? "run" : "runs"}</span>
                <span className="meta-chip muted right">{fmtRelative(lastActivity)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
