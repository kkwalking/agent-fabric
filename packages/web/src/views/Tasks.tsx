import { useEffect, useState } from "react";
import { del, get, fmtRelative } from "../api";
import { Icon, Modal, StatusBadge, useAsync, ErrorBox } from "../components";
import { navigate } from "../router";

// Per-browser UI preference: when set, deleting a task skips the confirm modal.
const SUPPRESS_DELETE_CONFIRM_KEY = "agentfabric.deleteTaskConfirmSuppressed";

/**
 * Task List (v5 §16/§32): Tasks are the user's long-lived work threads;
 * Runs are executions inside them. Clicking a task opens its thread —
 * the primary surface — not a run page. The three-dot menu soft-deletes:
 * the task stays recoverable for 30 days from the Dashboard's deleted
 * tasks card.
 */
export function TasksView() {
  const tasks = useAsync<any[]>(() => get("/api/tasks"), []);
  const runs = useAsync<any[]>(() => get("/api/runs"), []);
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);
  // Which task's action menu is open (one at a time).
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  // Task awaiting confirmation in the delete modal.
  const [confirmTask, setConfirmTask] = useState<any | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Clicks outside the menu (and its three-dot button) close it. The
  // opening click itself also bubbles here after the effect attached, so
  // the target is checked instead of relying on propagation ordering.
  useEffect(() => {
    if (!menuTaskId) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest(".task-item-menu")) setMenuTaskId(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuTaskId]);

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

  const deleteTask = async (task: any) => {
    setConfirmTask(null);
    setActionError(null);
    try {
      await del(`/api/tasks/${task.id}`);
      tasks.reload();
      runs.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const requestDelete = (task: any) => {
    setMenuTaskId(null);
    if (localStorage.getItem(SUPPRESS_DELETE_CONFIRM_KEY) === "1") {
      void deleteTask(task);
    } else {
      setDontAskAgain(false);
      setConfirmTask(task);
    }
  };

  const confirmDelete = async () => {
    if (!confirmTask) return;
    if (dontAskAgain) localStorage.setItem(SUPPRESS_DELETE_CONFIRM_KEY, "1");
    await deleteTask(confirmTask);
  };

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

      <ErrorBox message={actionError} />

      {entries.length === 0 ? (
        <div className="card muted">
          No tasks yet — create one with <a onClick={() => navigate("/new")}>New task</a>.
        </div>
      ) : (
        <div className="task-list">
          {entries.map(({ task, runs: taskRuns, last, status, lastActivity }) => (
            <div key={task.id} className="task-item card" onClick={() => navigate(`/tasks/${task.id}`)}>
              <div className="task-item-main">
                <div className="task-item-head">
                  <strong className="task-item-title">{task.title}</strong>
                </div>
                <div className="task-item-meta">
                  <span className="meta-chip">
                    {last?.runtimeName ? `${last.runtimeName}` : "—"}
                    {last ? ` · last run ${last.status}` : " · no runs"}
                  </span>
                  <span className="meta-chip"><span className="muted">workspace</span> {wsName(last?.workspaceId ?? task.workspaceId) ?? "—"}</span>
                  <span className="meta-chip">{taskRuns.length} {taskRuns.length === 1 ? "run" : "runs"}</span>
                </div>
              </div>
              {/* Status and recency answer the same question from the same
                  edge of the row, so they stack there instead of flanking
                  the title. */}
              <div className="task-item-side">
                <StatusBadge status={status} />
                <span className="muted task-item-time">{fmtRelative(lastActivity)}</span>
              </div>
              <div className="task-item-menu" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn"
                  title="Task actions"
                  onClick={() => setMenuTaskId((open) => (open === task.id ? null : task.id))}
                >
                  <Icon name="more" />
                </button>
                {menuTaskId === task.id && (
                  <div className="menu">
                    <button className="menu-item danger" onClick={() => requestDelete(task)}>Delete</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmTask && (
        <Modal title="Delete task" onClose={() => setConfirmTask(null)}>
          <div className="delete-confirm">
            <p className="delete-confirm-question">
              Delete task <strong>{confirmTask.title}</strong>?
            </p>
            <p className="muted">
              It is hidden from Tasks but kept for 30 days — restore it from Dashboard → Deleted tasks.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              Don't ask again
            </label>
            <div className="modal-actions">
              <button onClick={() => setConfirmTask(null)}>Cancel</button>
              <button className="danger" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
