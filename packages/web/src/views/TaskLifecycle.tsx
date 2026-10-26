import { useEffect, useState } from "react";
import { get, post, fmtRelative, shortId } from "../api";
import { CopyButton, ErrorBox, Icon, StatusBadge, useAsync, usePolling } from "../components";
import { statusLabel } from "../i18n";
import { useT } from "../i18n-react";
import { navigate } from "../router";

/**
 * Task Detail / lifecycle view (v11 §40).
 *
 * Answers the question the spec puts at the centre: "is the agent developing,
 * testing, committing or pushing?" — Project and Source, base ref and base
 * commit, working branch, workspace, current phase, the three independent
 * statuses (agent / validation / publish), the final commit and the remote
 * branch. Retry actions are offered per failure stage, never as one generic
 * "retry task" (v11 §31).
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

  const inFlight = detail.data && ["preparing", "running", "validating", "finalizing", "publishing"].includes(detail.data.status);
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
        {t("lifecycle.sub", { phase: d.phase })}
        {d.running ? t("lifecycle.runningSuffix") : ""}
      </p>
      <ErrorBox message={error} />

      {failure && (
        <div className="card fail-box">
          <div className="fail-title">
            {failure.stage === "publish"
              ? t("lifecycle.failPublish")
              : failure.stage === "validation"
                ? t("lifecycle.failValidation")
                : t("lifecycle.failStage", { stage: failure.stage })}
          </div>
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
            )}{" "}
            {d.retry.validation && (
              <button className="small primary" disabled={busy !== null} onClick={() => act("retry-validation", "validation")}>
                {t("lifecycle.retryValidation")}
              </button>
            )}{" "}
            {d.retry.publish && (
              <button className="small primary" disabled={busy !== null} onClick={() => act("retry-publish", "publish")}>
                {t("lifecycle.retryPublish")}
              </button>
            )}
            <span className="muted" style={{ marginLeft: 8 }}>
              {d.retry.kind === "publish"
                ? t("lifecycle.retryHintPublish")
                : d.retry.kind === "validation"
                  ? t("lifecycle.retryHintValidation")
                  : t("lifecycle.retryHintAgent")}
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
          <dt>{t("lifecycle.field.project")}</dt>
          <dd>{d.project ? <a onClick={() => navigate(`/projects/${d.project.id}`)}>{d.project.name}</a> : "-"}</dd>
          <dt>{t("lifecycle.field.source")}</dt>
          <dd>{d.source?.remoteUrl ?? "-"}</dd>
          <dt>{t("lifecycle.field.credential")}</dt>
          <dd>{d.source?.credential ? `${d.source.credential.name} (${d.source.credential.type})` : t("lifecycle.publicNoCredential")}</dd>
          <dt>{t("lifecycle.field.baseRef")}</dt>
          <dd>{d.baseRef ?? "-"}</dd>
          <dt>{t("lifecycle.field.baseCommit")}</dt>
          <dd>
            {d.baseCommitSha ? shortId(d.baseCommitSha) : "-"}
            {d.baseCommitSha ? <> <CopyButton text={d.baseCommitSha} label={t("common.copy")} /></> : null}
          </dd>
          <dt>{t("lifecycle.field.workingBranch")}</dt>
          <dd>{d.workingBranch ?? "-"}</dd>
          <dt>{t("lifecycle.field.workspace")}</dt>
          <dd>{d.workspace ? `${d.workspace.name} · ${d.workspace.ownership ?? t("lifecycle.external")}` : "-"}</dd>
          <dt>{t("lifecycle.field.workspacePath")}</dt>
          <dd className="muted">{d.workspace?.path ?? "-"}</dd>
          <dt>{t("lifecycle.field.runtime")}</dt>
          <dd>
            {d.runtime ? `${d.runtime.name} (${d.runtime.kind})` : "-"}
            {d.isolation ? (
              <>
                {" · "}
                <span className={d.isolation.sandboxed ? "muted" : "fail-reason"}>
                  {d.isolation.sandboxed ? t("lifecycle.isolated") : t("lifecycle.hostExecution")}
                </span>
              </>
            ) : null}
          </dd>
          <dt>{t("lifecycle.field.phase")}</dt>
          <dd>{d.phase}</dd>
          <dt>{t("lifecycle.field.agent")}</dt>
          <dd>{statusLabel(t, d.agent?.status)}{d.agent?.attempts ? t("lifecycle.agentAttempts", { n: d.agent.attempts }) : ""}</dd>
          <dt>{t("lifecycle.field.validation")}</dt>
          <dd>
            {statusLabel(t, d.validation.status)}
            {d.validation.attempts ? t("lifecycle.verdicts", { n: d.validation.attempts }) : ""}
            {d.validation.rounds?.length ? t("lifecycle.roundsOver", { n: d.validation.rounds.length }) : ""}
          </dd>
          <dt>{t("lifecycle.field.publish")}</dt>
          <dd>
            {statusLabel(t, d.publish.status)}
            {d.publish.remote ? ` → ${d.publish.remote}/${d.publish.remoteBranch ?? "?"}` : ""}
            {d.publish.pushedAt ? ` · ${fmtRelative(t, d.publish.pushedAt)}` : ""}
          </dd>
          <dt>{t("lifecycle.field.finalCommit")}</dt>
          <dd>
            {d.finalCommitSha ? shortId(d.finalCommitSha) : "-"}
            {d.finalCommitSha ? <> <CopyButton text={d.finalCommitSha} label={t("common.copy")} /></> : null}
          </dd>
          <dt>{t("lifecycle.field.remoteBranch")}</dt>
          <dd>{d.remoteBranch ?? "-"}</dd>
        </dl>
      </div>

      {/* Stage outcomes (v11 hardening §35/§36): agent / validation /
          finalization / publish each carry their own result, so a failed
          publish never reads as "the task failed". */}
      <h2 style={{ marginTop: 20 }}>{t("lifecycle.stages")}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>{t("lifecycle.thStage")}</th><th>{t("lifecycle.thStatus")}</th><th>{t("lifecycle.thDetail")}</th><th>{t("lifecycle.thAt")}</th></tr>
          </thead>
          <tbody>
            {(["agent", "validation", "finalization", "publish"] as const).map((stage) => {
              const outcome = d.stages?.[stage];
              const live =
                stage === "agent"
                  ? d.agent?.status
                  : stage === "validation"
                    ? d.validation.status
                    : stage === "finalization"
                      ? d.finalCommitSha
                        ? "completed"
                        : undefined
                      : d.publish.status;
              return (
                <tr key={stage}>
                  <td>{t(`lifecycle.stage.${stage}`)}</td>
                  <td>{statusLabel(t, outcome?.status ?? live)}</td>
                  <td className="muted">
                    {stage === "finalization" && d.finalCommitSha ? t("lifecycle.commitDetail", { sha: shortId(d.finalCommitSha) }) : ""}
                    {stage === "publish" && d.publish.remoteBranch
                      ? `${d.publish.remote} / ${d.publish.remoteBranch}${d.publish.errorCode ? ` — [${d.publish.errorCode}] ${d.publish.error ?? ""}` : ""}`
                      : ""}
                    {outcome?.errorCode ? `[${outcome.errorCode}]` : ""}
                  </td>
                  <td className="muted">{outcome?.at ? fmtRelative(t, outcome.at) : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {d.frozenRevision ? (
        <div className="card muted" style={{ marginTop: 12 }}>
          {t("lifecycle.frozen", {
            sha: shortId(d.frozenRevision.finalCommitSha),
            ref: `${d.frozenRevision.remote}/${d.frozenRevision.remoteBranch}`,
          })}
        </div>
      ) : null}

      {d.validation.rounds?.length ? (
        <>
          <h2 style={{ marginTop: 20 }}>
            {t("lifecycle.validationRounds")}
            <span className="muted" style={{ marginLeft: 8, fontSize: 13, fontWeight: 400 }}>
              {t("lifecycle.verdictsInCycle", { n: d.validation.attempts ?? 0 })}
            </span>
          </h2>
          {d.validation.rounds.map((round: any) => (
            <div key={round.round} className="card" style={{ marginBottom: 10 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <strong>{t("lifecycle.round", { n: round.round })}</strong>
                <span className="right muted">
                  {statusLabel(t, round.status)}
                  {round.endedAt ? ` · ${fmtRelative(t, round.endedAt)}` : ""}
                </span>
              </div>
              <dl className="detail-list">
                <dt>{t("lifecycle.pinnedRevision")}</dt>
                <dd>
                  {round.pinnedRevision ? (
                    <>
                      <code>{shortId(round.pinnedRevision.commitSha)}</code>{" "}
                      <CopyButton text={round.pinnedRevision.commitSha} label={t("common.copy")} />
                      <span className="muted">{t("lifecycle.pinnedFromRun", { id: shortId(round.pinnedRevision.runId) })}</span>
                    </>
                  ) : (
                    "-"
                  )}
                </dd>
                <dt>{t("lifecycle.field.agent")}</dt>
                <dd>
                  {round.reworkRunId ? (
                    <>
                      {t("lifecycle.reworkRun")}{" "}
                      <a onClick={() => navigate(`/runs/${round.reworkRunId}`)}>{shortId(round.reworkRunId)}</a>
                    </>
                  ) : round.agentRunId ? (
                    <>{t("lifecycle.initialRun")} <a onClick={() => navigate(`/runs/${round.agentRunId}`)}>{shortId(round.agentRunId)}</a></>
                  ) : (
                    "-"
                  )}
                </dd>
                <dt>{t("lifecycle.judgeRun")}</dt>
                <dd>
                  {round.judgeRunId ? (
                    <a onClick={() => navigate(`/runs/${round.judgeRunId}`)}>{shortId(round.judgeRunId)}</a>
                  ) : (
                    "-"
                  )}
                </dd>
                <dt>{t("lifecycle.verdict")}</dt>
                <dd>
                  {round.verdict ? (
                    <>
                      <strong>{round.verdict.passed ? t("lifecycle.verdictPassed") : t("lifecycle.verdictFailed")}</strong> — {round.verdict.summary}
                      {round.verdict.unmet?.length ? (
                        <ul style={{ margin: "6px 0 0 16px" }}>
                          {round.verdict.unmet.map((u: string, i: number) => (
                            <li key={i}>{u}</li>
                          ))}
                        </ul>
                      ) : null}
                      {round.verdict.evidence?.length ? (
                        <details style={{ marginTop: 6 }}>
                          <summary className="muted">{t("lifecycle.evidence", { n: round.verdict.evidence.length })}</summary>
                          <ul style={{ margin: "6px 0 0 16px" }}>
                            {round.verdict.evidence.map((e: string, i: number) => (
                              <li key={i} className="muted"><code>{e}</code></li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </>
                  ) : round.error ? (
                    <span className="fail-reason">[{round.errorCode}] {round.error}</span>
                  ) : (
                    t("lifecycle.roundPending")
                  )}
                </dd>
              </dl>
              {round.drift?.detected ? (
                <div className="fail-reason" style={{ marginTop: 6 }}>
                  {t("lifecycle.drift", {
                    paths: round.drift.driftedPaths?.length ? `（${round.drift.driftedPaths.join(", ")}）` : "",
                  })}
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}

      <h2 style={{ marginTop: 20 }}>{t("lifecycle.runs")}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>{t("lifecycle.thRun")}</th><th>{t("lifecycle.thPurpose")}</th><th>{t("lifecycle.thStatus")}</th><th>{t("lifecycle.thPhase")}</th><th>{t("lifecycle.thContinuity")}</th><th>{t("lifecycle.thRuntime")}</th><th>{t("lifecycle.thStarted")}</th><th /></tr>
          </thead>
          <tbody>
            {(d.runs ?? []).map((run: any) => (
              <tr key={run.id}>
                <td>{shortId(run.id)}</td>
                <td>
                  {run.purpose === "validation"
                    ? t("lifecycle.purpose.validation", { round: run.round ?? "?" })
                    : run.purpose === "rework"
                      ? t("lifecycle.purpose.rework", { round: run.round ?? "?" })
                      : t("lifecycle.purpose.development")}
                </td>
                <td>{statusLabel(t, run.status)}</td>
                <td>{run.phase ?? "-"}</td>
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
