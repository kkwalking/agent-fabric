import { useEffect, useState } from "react";
import { get, post, fmtRelative, shortId } from "../api";
import { CopyButton, ErrorBox, Icon, StatusBadge, useAsync, usePolling } from "../components";
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
  if (!detail.data) return <div className="muted">Loading…</div>;
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
        <Icon name="arrowLeft" size={14} /> Task thread
      </button>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>{d.task.title}</h1>
        <span className="right">
          <StatusBadge status={d.status} />
          <button className="small" style={{ marginLeft: 8 }} onClick={() => detail.reload()}>refresh</button>
        </span>
      </div>
      <p className="sub">
        Project lifecycle: {d.phase}
        {d.running ? " · running" : ""}
      </p>
      <ErrorBox message={error} />

      {failure && (
        <div className="card fail-box">
          <div className="fail-title">
            {failure.stage === "publish"
              ? "Development completed — publishing failed"
              : failure.stage === "validation"
                ? "Agent completed — validation failed"
                : `Failed during ${failure.stage}`}
          </div>
          <div className="fail-reason">[{failure.code}] {failure.message}</div>
          {execution.autoRetry?.nextAt && (
            <div className="fail-reason muted">
              Automatic retry {execution.autoRetry.attempts} of [{execution.autoRetry.code}] scheduled — starting in
              about {Math.max(0, Math.round((Date.parse(execution.autoRetry.nextAt) - Date.now()) / 1000))}s. The manual
              actions below stay available.
            </div>
          )}
          <div className="fail-actions">
            {d.retry.agent && (
              <button className="small primary" disabled={busy !== null} onClick={() => act("retry-run", "agent")}>
                Retry agent run
              </button>
            )}{" "}
            {d.retry.validation && (
              <button className="small primary" disabled={busy !== null} onClick={() => act("retry-validation", "validation")}>
                Retry validation
              </button>
            )}{" "}
            {d.retry.publish && (
              <button className="small primary" disabled={busy !== null} onClick={() => act("retry-publish", "publish")}>
                Retry publish
              </button>
            )}
            <span className="muted" style={{ marginLeft: 8 }}>
              {d.retry.kind === "publish"
                ? "retry publish re-pushes the frozen commit — the agent is not re-run, nothing is re-committed"
                : d.retry.kind === "validation"
                  ? "retry validation resets the budget and judges the workspace again — the development agent is not re-run"
                  : "retry starts a new run on the same workspace"}
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
          <dt>Project</dt>
          <dd>{d.project ? <a onClick={() => navigate(`/projects/${d.project.id}`)}>{d.project.name}</a> : "-"}</dd>
          <dt>Source</dt>
          <dd>{d.source?.remoteUrl ?? "-"}</dd>
          <dt>Credential</dt>
          <dd>{d.source?.credential ? `${d.source.credential.name} (${d.source.credential.type})` : "public — no credential"}</dd>
          <dt>Base ref</dt>
          <dd>{d.baseRef ?? "-"}</dd>
          <dt>Base commit</dt>
          <dd>
            {d.baseCommitSha ? shortId(d.baseCommitSha) : "-"}
            {d.baseCommitSha ? <> <CopyButton text={d.baseCommitSha} label="copy" /></> : null}
          </dd>
          <dt>Working branch</dt>
          <dd>{d.workingBranch ?? "-"}</dd>
          <dt>Workspace</dt>
          <dd>{d.workspace ? `${d.workspace.name} · ${d.workspace.ownership ?? "external"}` : "-"}</dd>
          <dt>Workspace path</dt>
          <dd className="muted">{d.workspace?.path ?? "-"}</dd>
          <dt>Runtime</dt>
          <dd>
            {d.runtime ? `${d.runtime.name} (${d.runtime.kind})` : "-"}
            {d.isolation ? (
              <>
                {" · "}
                <span className={d.isolation.sandboxed ? "muted" : "fail-reason"}>
                  {d.isolation.sandboxed ? "isolated" : "host execution"}
                </span>
              </>
            ) : null}
          </dd>
          <dt>Current phase</dt>
          <dd>{d.phase}</dd>
          <dt>Agent</dt>
          <dd>{d.agent?.status ?? "-"}{d.agent?.attempts ? ` · ${d.agent.attempts} attempt(s)` : ""}</dd>
          <dt>Validation</dt>
          <dd>
            {d.validation.status}
            {d.validation.attempts ? ` · ${d.validation.attempts} verdict(s)` : ""}
            {d.validation.rounds?.length ? ` over ${d.validation.rounds.length} round(s)` : ""}
          </dd>
          <dt>Publish</dt>
          <dd>
            {d.publish.status}
            {d.publish.remote ? ` → ${d.publish.remote}/${d.publish.remoteBranch ?? "?"}` : ""}
            {d.publish.pushedAt ? ` · ${fmtRelative(d.publish.pushedAt)}` : ""}
          </dd>
          <dt>Final commit</dt>
          <dd>
            {d.finalCommitSha ? shortId(d.finalCommitSha) : "-"}
            {d.finalCommitSha ? <> <CopyButton text={d.finalCommitSha} label="copy" /></> : null}
          </dd>
          <dt>Remote branch</dt>
          <dd>{d.remoteBranch ?? "-"}</dd>
        </dl>
      </div>

      {/* Stage outcomes (v11 hardening §35/§36): agent / validation /
          finalization / publish each carry their own result, so a failed
          publish never reads as "the task failed". */}
      <h2 style={{ marginTop: 20 }}>Lifecycle stages</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Stage</th><th>Status</th><th>Detail</th><th>At</th></tr>
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
                  <td>{stage}</td>
                  <td>{outcome?.status ?? live ?? "-"}</td>
                  <td className="muted">
                    {stage === "finalization" && d.finalCommitSha ? `commit ${shortId(d.finalCommitSha)}` : ""}
                    {stage === "publish" && d.publish.remoteBranch
                      ? `${d.publish.remote} / ${d.publish.remoteBranch}${d.publish.errorCode ? ` — [${d.publish.errorCode}] ${d.publish.error ?? ""}` : ""}`
                      : ""}
                    {outcome?.errorCode ? `[${outcome.errorCode}]` : ""}
                  </td>
                  <td className="muted">{outcome?.at ? fmtRelative(outcome.at) : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {d.frozenRevision ? (
        <div className="card muted" style={{ marginTop: 12 }}>
          Frozen revision <code>{shortId(d.frozenRevision.finalCommitSha)}</code> on{" "}
          <code>{d.frozenRevision.remote}/{d.frozenRevision.remoteBranch}</code> — retry publish re-pushes exactly
          this commit; it never re-runs the agent, validation or finalization.
        </div>
      ) : null}

      {d.validation.rounds?.length ? (
        <>
          <h2 style={{ marginTop: 20 }}>
            Validation rounds
            <span className="muted" style={{ marginLeft: 8, fontSize: 13, fontWeight: 400 }}>
              {d.validation.attempts ?? 0} verdict(s) in the current cycle
            </span>
          </h2>
          {d.validation.rounds.map((round: any) => (
            <div key={round.round} className="card" style={{ marginBottom: 10 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <strong>Round {round.round}</strong>
                <span className="right muted">
                  {round.status}
                  {round.endedAt ? ` · ${fmtRelative(round.endedAt)}` : ""}
                </span>
              </div>
              <dl className="detail-list">
                <dt>Completion pin</dt>
                <dd>
                  {round.pinnedRevision ? (
                    <>
                      <code>{shortId(round.pinnedRevision.commitSha)}</code>{" "}
                      <CopyButton text={round.pinnedRevision.commitSha} label="copy" />
                      <span className="muted"> · from run {shortId(round.pinnedRevision.runId)}</span>
                    </>
                  ) : (
                    "-"
                  )}
                </dd>
                <dt>Development run</dt>
                <dd>
                  {round.reworkRunId ? (
                    <>
                      rework run{" "}
                      <a onClick={() => navigate(`/runs/${round.reworkRunId}`)}>{shortId(round.reworkRunId)}</a>
                    </>
                  ) : round.agentRunId ? (
                    <>initial run <a onClick={() => navigate(`/runs/${round.agentRunId}`)}>{shortId(round.agentRunId)}</a></>
                  ) : (
                    "-"
                  )}
                </dd>
                <dt>Judge run</dt>
                <dd>
                  {round.judgeRunId ? (
                    <a onClick={() => navigate(`/runs/${round.judgeRunId}`)}>{shortId(round.judgeRunId)}</a>
                  ) : (
                    "-"
                  )}
                </dd>
                <dt>Verdict</dt>
                <dd>
                  {round.verdict ? (
                    <>
                      <strong>{round.verdict.passed ? "passed" : "failed"}</strong> — {round.verdict.summary}
                      {round.verdict.unmet?.length ? (
                        <ul style={{ margin: "6px 0 0 16px" }}>
                          {round.verdict.unmet.map((u: string, i: number) => (
                            <li key={i}>{u}</li>
                          ))}
                        </ul>
                      ) : null}
                      {round.verdict.evidence?.length ? (
                        <details style={{ marginTop: 6 }}>
                          <summary className="muted">Evidence ({round.verdict.evidence.length})</summary>
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
                    "pending"
                  )}
                </dd>
              </dl>
              {round.drift?.detected ? (
                <div className="fail-reason" style={{ marginTop: 6 }}>
                  The validation agent modified the workspace — it was replayed back to the pin
                  {round.drift.driftedPaths?.length ? ` (${round.drift.driftedPaths.join(", ")})` : ""}.
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}

      <h2 style={{ marginTop: 20 }}>Runs</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Run</th><th>Purpose</th><th>Status</th><th>Phase</th><th>Continuity</th><th>Runtime</th><th>Started</th><th /></tr>
          </thead>
          <tbody>
            {(d.runs ?? []).map((run: any) => (
              <tr key={run.id}>
                <td>{shortId(run.id)}</td>
                <td>
                  {run.purpose === "validation"
                    ? `validation (round ${run.round ?? "?"})`
                    : run.purpose === "rework"
                      ? `rework (round ${run.round ?? "?"})`
                      : "development"}
                </td>
                <td>{run.status}</td>
                <td>{run.phase ?? "-"}</td>
                <td>{run.continuity ?? "new"}</td>
                <td>{run.runtimeName ?? "-"}</td>
                <td className="muted">{fmtRelative(run.startTime ?? run.createdAt)}</td>
                <td className="actions">
                  <button className="small" onClick={() => navigate(`/runs/${run.id}`)}>inspect</button>
                  {["pending", "starting", "running"].includes(run.status) && (
                    // Same guard as the task-level Cancel button: `busy` is one
                    // value for the whole view, so a second click would clear
                    // it for whichever action finishes first and re-enable the
                    // rest while that request is still in flight.
                    <> <button className="small danger" disabled={busy !== null} onClick={() => act("cancel", "cancel")}>cancel</button></>
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
            Cancel task (the workspace is preserved)
          </button>
        </div>
      )}
    </div>
  );
}
