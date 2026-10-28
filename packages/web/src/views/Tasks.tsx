import { useEffect, useState } from "react";
import { del, get, fmtRelative } from "../api";
import { Icon, Modal, Pager, StatusBadge, clickableRow, useMinuteClock, useAsync, ErrorBox } from "../components";
import { statusLabel, type Translate } from "../i18n";
import { useT } from "../i18n-react";
import { navigate } from "../router";

// Per-browser UI preference: when set, deleting a task skips the confirm modal.
const SUPPRESS_DELETE_CONFIRM_KEY = "agentfabric.deleteTaskConfirmSuppressed";

/**
 * Task List (v5 §16/§32): Tasks are the user's long-lived work threads;
 * Runs are executions inside them. Clicking a task opens its thread —
 * the primary surface — not a run page. The three-dot menu soft-deletes:
 * the task stays recoverable for 30 days, and the Trash entry in this page's
 * header is where it is restored from.
 */
/** Rows per page. */
const TASKS_PAGE_SIZE = 50;

/**
 * Relative timestamp in the interface language. `fmtRelative` is deliberately
 * not translated in place: it is shared with views this module does not own.
 */
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

export function TasksView() {
  const t = useT();
  const tasks = useAsync<any[]>(() => get("/api/tasks"), []);
  const runs = useAsync<any[]>(() => get("/api/runs"), []);
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);
  // The Trash entry used to live on the Dashboard. It needs the number of
  // soft-deleted tasks, which is what `/api/dashboard` reports; nothing else on
  // this page uses that endpoint.
  const summary = useAsync<{ counts: Record<string, number>; usage: { estimatedCost: number } }>(
    () => get("/api/dashboard"),
    []
  );
  // Which task's action menu is open (one at a time).
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  // Task awaiting confirmation in the delete modal.
  const [confirmTask, setConfirmTask] = useState<any | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // "3m ago" labels move on their own (see `useMinuteClock`).
  useMinuteClock();
  // Page through a long list instead of mounting every row: a thread list grows
  // without bound, and each row is a card with chips and a menu.
  const [page, setPage] = useState(0);

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
  // A lookup map, not a per-row `find`: the list re-renders on every menu open
  // and the workspaces array is scanned once per visible row otherwise.
  const deletedCount = summary.data?.counts.deletedTasks ?? 0;
  const wsById = new Map<string, any>((workspaces.data ?? []).map((w: any) => [w.id, w]));
  const wsName = (id?: string) => (id ? wsById.get(id)?.name : undefined);
  const isLive = (s: string) => ["pending", "starting", "running"].includes(s);

  // `[...]`: the source array is the shared API cache; sorting it in place would
  // reorder what other views read.
  const entries = [...(tasks.data ?? [])]
    .map((t) => {
      const taskRuns = [...(runsByTask.get(t.id) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

  const pageCount = Math.max(1, Math.ceil(entries.length / TASKS_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageEntries = entries.slice(currentPage * TASKS_PAGE_SIZE, (currentPage + 1) * TASKS_PAGE_SIZE);

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
        <h1>{t("tasks.title")}</h1>
        <span className="right">
          {deletedCount > 0 && (
            <button className="small" onClick={() => navigate("/trash")} title={t("tasks.trashTitle")}>
              {t("tasks.trash", { n: deletedCount })}
            </button>
          )}{" "}
          <button className="small" onClick={() => { tasks.reload(); runs.reload(); summary.reload(); }}>{t("common.refresh")}</button>{" "}
          <button className="small primary" onClick={() => navigate("/new")}>{t("tasks.new")}</button>
        </span>
      </div>
      <p className="sub">
        {t("tasks.sub")}
        {/* The Dashboard used to show the total cost; it lives on the Usage page
            in full, and one line here keeps it from becoming invisible. */}
        {typeof summary.data?.usage?.estimatedCost === "number" && (
          <> {t("tasks.spent", { cost: `$${summary.data.usage.estimatedCost.toFixed(4)}` })}
            <a onClick={() => navigate("/usage")}>{t("tasks.spentLink")}</a>
            {t("tasks.spentAfter")}
          </>
        )}
      </p>

      <ErrorBox message={actionError} />

      {entries.length === 0 ? (
        <div className="card muted">
          {t("tasks.empty")}
          <a onClick={() => navigate("/new")}>{t("tasks.new")}</a>
          {t("tasks.emptyAfter")}
        </div>
      ) : (
        <>
        <div className="task-list">
          {pageEntries.map(({ task, runs: taskRuns, last, status, lastActivity }) => (
            <div key={task.id} className="task-item card" {...clickableRow(() => navigate(`/tasks/${task.id}`))}>
              <div className="task-item-main">
                <div className="task-item-head">
                  <strong className="task-item-title">{task.title}</strong>
                </div>
                <div className="task-item-meta">
                  <span className="meta-chip">
                    {last?.runtimeName ? `${last.runtimeName}` : "—"}
                    {last ? ` · ${t("tasks.lastRun", { status: statusLabel(t, last.status) })}` : ` · ${t("tasks.noRuns")}`}
                  </span>
                  <span className="meta-chip"><span className="muted">{t("tasks.label.workspace")}</span> {wsName(last?.workspaceId ?? task.workspaceId) ?? "—"}</span>
                  <span className="meta-chip">{t("tasks.runCount", { n: taskRuns.length })}</span>
                </div>
              </div>
              {/* Status and recency answer the same question from the same
                  edge of the row, so they stack there instead of flanking
                  the title. */}
              <div className="task-item-side">
                <StatusBadge status={status} />
                <span className="muted task-item-time">{relativeLabel(t, lastActivity)}</span>
              </div>
              <div className="task-item-menu" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn"
                  title={t("tasks.actions")}
                  onClick={() => setMenuTaskId((open) => (open === task.id ? null : task.id))}
                >
                  <Icon name="more" />
                </button>
                {menuTaskId === task.id && (
                  <div className="menu">
                    <button className="menu-item" onClick={() => navigate(`/tasks/${task.id}/lifecycle`)}>{t("tasks.lifecycle")}</button>
                    <button className="menu-item danger" onClick={() => requestDelete(task)}>{t("tasks.delete")}</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <Pager page={currentPage} pageCount={pageCount} total={entries.length} pageSize={TASKS_PAGE_SIZE} onChange={setPage} />
        </>
      )}

      {confirmTask && (
        <Modal title={t("tasks.deleteTitle")} onClose={() => setConfirmTask(null)}>
          <div className="delete-confirm">
            <p className="delete-confirm-question">
              {t("tasks.deleteQuestion", { title: confirmTask.title })}
            </p>
            <p className="muted">
              {t("tasks.deleteBody")}
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              {t("tasks.dontAsk")}
            </label>
            <div className="modal-actions">
              <button onClick={() => setConfirmTask(null)}>{t("common.cancel")}</button>
              <button className="danger" onClick={confirmDelete}>{t("common.delete")}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
