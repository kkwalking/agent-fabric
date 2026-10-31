import { useEffect, useState } from "react";
import { get, post, fmtRelative, shortId } from "../api";
import { ErrorBox, Icon, StatusBadge, useAsync, usePolling } from "../components";
import { statusLabel, phaseLabel } from "../i18n";
import { useT } from "../i18n-react";
import { navigate } from "../router";
import { onAppEvent, TASKS_CHANGED_EVENT } from "../appEvents";

/**
 * Task detail view.
 *
 * Answers where the task runs and how far it has got: workspace, runtime,
 * current phase, agent status and its runs. Retry actions are offered per
 * failure stage, never as one generic "retry task".
 */
export function TaskLifecycleView({ taskId }: { taskId: string }) {
  const t = useT();
  const detail = useAsync<any>(() => get(`/api/tasks/${taskId}/detail`), [taskId]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // App renders <TaskLifecycleView taskId=… /> with no key, so this component is
  // reused when the user switches tasks. Carrying `busy` over would leave the
  // next task's buttons disabled until the previous task's request settled.
  useEffect(() => {
    setBusy(null);
    setError(null);
  }, [taskId]);
  // This page is about one task: only a change to that task is news. Before the
  // event carried an id, deleting any other task from the rail re-read this
  // whole page for nothing.
  useEffect(
    () => onAppEvent(TASKS_CHANGED_EVENT, () => detail.reload(), (c) => c.taskId === undefined || c.taskId === taskId),
    [taskId, detail.reload]
  );

  const inFlight = detail.data && ["preparing", "running"].includes(detail.data.status);
  // A failed task with a retry scheduled is still moving: poll it too, so the
  // retry starting (and the phase advancing past "failed") shows up.
  const retryPending = Boolean(detail.data?.task?.execution?.autoRetry?.nextAt);

  // Poll while the lifecycle is in flight so the phase advances visibly — and
  // only while the window is visible (see `usePolling`).
  usePolling(detail.reload, 2000, Boolean(inFlight || retryPending));

  if (detail.error) return <ErrorBox message={detail.error} />;
  if (!detail.data) return <div className="muted">{t("common.loading")}</div>;
  const d = detail.data;
  const execution = d.task.execution ?? {};
  const failure = execution.failure;

  const act = async (action: string, label: string) => {
    setBusy(label);
    setError(null);
    try {
      await post(`/api/tasks/${taskId}/${action}`, {});
      detail.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <button className="back-btn with-label" onClick={() => navigate(`/tasks/${taskId}`)}>
        <Icon name="arrowLeft" size={14} /> {t("lifecycle.backToThread")}
      </button>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>{d.task.title}</h1>
        <span className="right">
          <StatusBadge status={d.status} />
          <button className="small" style={{ marginLeft: 8 }} onClick={() => detail.reload()}>{t("common.refresh")}</button>
        </span>
      </div>
      <p className="sub">
        {t("lifecycle.sub", { phase: phaseLabel(t, d.phase) })}
        {d.running ? t("lifecycle.runningSuffix") : ""}
      </p>
      <ErrorBox message={error} />

      {failure && (
        <div className="card fail-box">
          <div className="fail-title">{t("lifecycle.failStage", { stage: failure.stage })}</div>
          <div className="fail-reason">[{failure.code}] {failure.message}</div>
          {execution.autoRetry?.nextAt && (
            <div className="fail-reason muted">
              {t("lifecycle.autoRetry", {
                n: execution.autoRetry.attempts,
                code: execution.autoRetry.code,
                seconds: Math.max(0, Math.round((Date.parse(execution.autoRetry.nextAt) - Date.now()) / 1000)),
              })}
            </div>
          )}
          <div className="fail-actions">
            {d.retry.agent && (
              <button className="small primary" disabled={busy !== null} onClick={() => act("retry-run", "agent")}>
                {t("lifecycle.retryAgent")}
              </button>
            )}
            <span className="muted" style={{ marginLeft: 8 }}>
              {t("lifecycle.retryHintAgent")}
            </span>
          </div>
        </div>
      )}

      <div className="card">
        {/* dl/dt/dd, not div>span: `.detail-list` is a two-column grid whose
            label/value split comes from the dt/dd elements themselves. A
            wrapper div per row collapses label and value into a single
            150px cell, which is what made long values overlap the next
            column. */}
        <dl className="detail-list">
          <dt>{t("lifecycle.field.workspace")}</dt>
          <dd>{d.workspace?.name ?? "-"}</dd>
          <dt>{t("lifecycle.field.workspacePath")}</dt>
          <dd className="muted">{d.workspace?.path ?? "-"}</dd>
          <dt>{t("lifecycle.field.runtime")}</dt>
          <dd>{d.runtime ? `${d.runtime.name} (${d.runtime.kind})` : "-"}</dd>
          <dt>{t("lifecycle.field.phase")}</dt>
          <dd>{phaseLabel(t, d.phase)}</dd>
          <dt>{t("lifecycle.field.agent")}</dt>
          <dd>{statusLabel(t, d.agent?.status)}{d.agent?.attempts ? t("lifecycle.agentAttempts", { n: d.agent.attempts }) : ""}</dd>
        </dl>
      </div>

      <h2 style={{ marginTop: 20 }}>{t("lifecycle.runs")}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">{t("lifecycle.thRun")}</th><th scope="col">{t("lifecycle.thStatus")}</th><th scope="col">{t("lifecycle.thPhase")}</th><th scope="col">{t("lifecycle.thContinuity")}</th><th scope="col">{t("lifecycle.thRuntime")}</th><th scope="col">{t("lifecycle.thStarted")}</th><th /></tr>
          </thead>
          <tbody>
            {(d.runs ?? []).map((run: any) => (
              <tr key={run.id}>
                <td>{shortId(run.id)}</td>
                <td>{statusLabel(t, run.status)}</td>
                <td>{phaseLabel(t, run.phase)}</td>
                <td>{run.continuity ? statusLabel(t, run.continuity) : t("lifecycle.continuity.new")}</td>
                <td>{run.runtimeName ?? "-"}</td>
                <td className="muted">{fmtRelative(t, run.startTime ?? run.createdAt)}</td>
                <td className="actions">
                  <button className="small" onClick={() => navigate(`/runs/${run.id}`)}>{t("lifecycle.inspect")}</button>
                  {["pending", "starting", "running"].includes(run.status) && (
                    // Same guard as the task-level Cancel button: `busy` is one
                    // value for the whole view, so a second click would clear
                    // it for whichever action finishes first and re-enable the
                    // rest while that request is still in flight.
                    <> <button className="small danger" disabled={busy !== null} onClick={() => act("cancel", "cancel")}>{t("lifecycle.cancelRun")}</button></>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.running && (
        <div className="card muted" style={{ marginTop: 12 }}>
          <button className="small danger" disabled={busy !== null} onClick={() => act("cancel", "cancel")}>
            {t("lifecycle.cancelTask")}
          </button>
        </div>
      )}
    </div>
  );
}
