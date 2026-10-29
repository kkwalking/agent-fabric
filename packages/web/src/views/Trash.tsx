import { useState } from "react";
import { get, post } from "../api";
import { useAsync, ErrorBox } from "../components";
import { useT } from "../i18n-react";
import type { Translate } from "../i18n";

/**
 * Trash (deleted tasks): soft-deleted tasks live here for their 30-day
 * retention window and can be restored — the task returns to Tasks with
 * all of its runs and history. Once the window expires the server's
 * purge pass removes the task physically.
 */

/** Relative timestamp in the interface language (`fmtRelative` is shared, so it is not translated in place). */
function relativeLabel(t: Translate, iso?: string): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const diff = Date.now() - at;
  if (diff < 60_000) return t("status.justNow");
  if (diff < 3_600_000) return t("status.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("status.hoursAgo", { n: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("status.daysAgo", { n: Math.floor(diff / 86_400_000) });
  return new Date(at).toLocaleDateString();
}

export function TrashView({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const tasks = useAsync<any[]>(() => get("/api/tasks?deleted=true"), []);
  const [error, setError] = useState<string | null>(null);
  // A restore in flight; the row buttons stay disabled until it lands.
  const [busy, setBusy] = useState<string | null>(null);

  if (tasks.error) return <ErrorBox message={tasks.error} />;

  // `[...]` on purpose: the array comes from the shared API cache, and sorting
  // it in place would reorder what every other view reads.
  const entries = [...(tasks.data ?? [])].sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));

  const restore = async (task: any) => {
    setError(null);
    setBusy(task.id);
    try {
      await post(`/api/tasks/${task.id}/restore`);
      tasks.reload();
    } catch (e) {
      // A failed restore (e.g. the retention window expired mid-click)
      // must not look like nothing happened.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {!embedded && (
        <>
          <div className="row" style={{ marginBottom: 4 }}>
            <h1>{t("trash.title")}</h1>
            <span className="right">
              <button className="small" onClick={tasks.reload}>{t("common.refresh")}</button>
            </span>
          </div>
          <p className="sub">{t("trash.sub")}</p>
        </>
      )}
      {embedded && (
        <div className="settings-inline-actions settings-trash-actions">
          <button className="btn-outline" onClick={tasks.reload}>{t("common.refresh")}</button>
        </div>
      )}
      <ErrorBox message={error} />

      {entries.length === 0 ? (
        <div className="card muted">{t("trash.empty")}</div>
      ) : (
        <div className="task-list">
          {entries.map((task) => (
            <div key={task.id} className="task-item card">
              <div className="task-item-main">
                <div className="task-item-head">
                  <strong className="task-item-title">{task.title}</strong>
                </div>
                <div className="task-item-meta">
                  <span className="meta-chip">{t("trash.deletedAt", { when: relativeLabel(t, task.deletedAt) })}</span>
                </div>
              </div>
              <div className="task-item-side">
                <button className="small" disabled={busy !== null} onClick={() => restore(task)}>{t("trash.restore")}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
