import { useState } from "react";
import { get, post, fmtRelative } from "../api";
import { useAsync, ErrorBox } from "../components";

/**
 * Trash (deleted tasks): soft-deleted tasks live here for their 30-day
 * retention window and can be restored — the task returns to Tasks with
 * all of its runs and history. Once the window expires the server's
 * purge pass removes the task physically.
 */
export function TrashView() {
  const tasks = useAsync<any[]>(() => get("/api/tasks?deleted=true"), []);
  const [error, setError] = useState<string | null>(null);

  if (tasks.error) return <ErrorBox message={tasks.error} />;

  const entries = (tasks.data ?? []).sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));

  const restore = async (task: any) => {
    setError(null);
    try {
      await post(`/api/tasks/${task.id}/restore`);
      tasks.reload();
    } catch (e) {
      // A failed restore (e.g. the retention window expired mid-click)
      // must not look like nothing happened.
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>Deleted tasks</h1>
        <span className="right">
          <button className="small" onClick={tasks.reload}>refresh</button>
        </span>
      </div>
      <p className="sub">
        Deleted tasks are kept here for 30 days, then permanently removed together with their runs and history.
        Restore puts a task back on the Tasks page with everything it had.
      </p>
      <ErrorBox message={error} />

      {entries.length === 0 ? (
        <div className="card muted">No deleted tasks.</div>
      ) : (
        <div className="task-list">
          {entries.map((task) => (
            <div key={task.id} className="task-item card">
              <div className="task-item-main">
                <div className="task-item-head">
                  <strong className="task-item-title">{task.title}</strong>
                </div>
                <div className="task-item-meta">
                  <span className="meta-chip">deleted {fmtRelative(task.deletedAt)}</span>
                </div>
              </div>
              <div className="task-item-side">
                <button className="small" onClick={() => restore(task)}>restore</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
