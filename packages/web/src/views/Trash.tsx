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

  if (tasks.error) return <ErrorBox message={tasks.error} />;

  const entries = (tasks.data ?? []).sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));

  const restore = async (task: any) => {
    await post(`/api/tasks/${task.id}/restore`);
    tasks.reload();
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
