import { useEffect, useState } from "react";
import { get, post, fmtRelative, shortId } from "../api";
import { CopyButton, ErrorBox, Icon, StatusBadge, useAsync } from "../components";
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

  const inFlight = detail.data && ["preparing", "running", "validating", "finalizing", "publishing"].includes(detail.data.status);

  // Poll while the lifecycle is in flight so the phase advances visibly.
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setInterval(() => detail.reload(), 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight]);

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
      <button className="back-btn" onClick={() => navigate(`/tasks/${taskId}`)}>
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
                  ? "retry validation re-runs the checks only — the agent is not re-run"
                  : "retry starts a new run on the same workspace"}
            </span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="detail-list">
          <div><span className="muted">Project</span><span>{d.project ? <a onClick={() => navigate(`/projects/${d.project.id}`)}>{d.project.name}</a> : "-"}</span></div>
          <div><span className="muted">Source</span><span>{d.source?.remoteUrl ?? "-"}</span></div>
          <div>
            <span className="muted">Credential</span>
            <span>{d.source?.credential ? `${d.source.credential.name} (${d.source.credential.type})` : "public — no credential"}</span>
          </div>
          <div><span className="muted">Base ref</span><span>{d.baseRef ?? "-"}</span></div>
          <div>
            <span className="muted">Base commit</span>
            <span>
              {d.baseCommitSha ? shortId(d.baseCommitSha) : "-"}
              {d.baseCommitSha ? <> <CopyButton text={d.baseCommitSha} label="copy" /></> : null}
            </span>
          </div>
          <div><span className="muted">Working branch</span><span>{d.workingBranch ?? "-"}</span></div>
          <div><span className="muted">Workspace</span><span>{d.workspace ? `${d.workspace.name} · ${d.workspace.ownership ?? "external"}` : "-"}</span></div>
          <div><span className="muted">Workspace path</span><span className="muted">{d.workspace?.path ?? "-"}</span></div>
          <div>
            <span className="muted">Runtime</span>
            <span>
              {d.runtime ? `${d.runtime.name} (${d.runtime.kind})` : "-"}
              {d.isolation ? (
                <>
                  {" · "}
                  <span className={d.isolation.sandboxed ? "muted" : "fail-reason"}>
                    {d.isolation.sandboxed ? "isolated" : "host execution"}
                  </span>
                </>
              ) : null}
            </span>
          </div>
          <div><span className="muted">Current phase</span><span>{d.phase}</span></div>
          <div><span className="muted">Agent</span><span>{d.agent?.status ?? "-"}{d.agent?.attempts ? ` · ${d.agent.attempts} attempt(s)` : ""}</span></div>
          <div>
            <span className="muted">Validation</span>
            <span>{d.validation.status}{d.validation.steps?.length ? ` · ${d.validation.steps.length} step(s)` : ""}</span>
          </div>
          <div>
            <span className="muted">Publish</span>
            <span>
              {d.publish.status}
              {d.publish.remote ? ` → ${d.publish.remote}/${d.publish.remoteBranch ?? "?"}` : ""}
              {d.publish.pushedAt ? ` · ${fmtRelative(d.publish.pushedAt)}` : ""}
            </span>
          </div>
          <div>
            <span className="muted">Final commit</span>
            <span>
              {d.finalCommitSha ? shortId(d.finalCommitSha) : "-"}
              {d.finalCommitSha ? <> <CopyButton text={d.finalCommitSha} label="copy" /></> : null}
            </span>
          </div>
          <div><span className="muted">Remote branch</span><span>{d.remoteBranch ?? "-"}</span></div>
        </div>
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
                    {stage === "validation" && d.validation.execution
                      ? `ran in ${d.validation.execution.containerized ? "an isolated container" : "an isolated runtime"}${d.validation.execution.image ? ` (${d.validation.execution.image})` : ""}`
                      : ""}
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

      {d.validation.steps?.length ? (
        <>
          <h2 style={{ marginTop: 20 }}>Validation steps</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Step</th><th>Command</th><th>Status</th><th>Exit</th><th>Duration</th><th>Output</th></tr>
              </thead>
              <tbody>
                {d.validation.steps.map((step: any, index: number) => (
                  <tr key={`${step.name}-${index}`}>
                    <td>{step.name}</td>
                    <td className="muted"><code>{step.command}</code></td>
                    <td>{step.status}</td>
                    <td>{step.exitCode ?? "-"}</td>
                    <td>{step.durationMs != null ? `${step.durationMs}ms` : "-"}</td>
                    <td className="muted" style={{ maxWidth: 420, whiteSpace: "pre-wrap" }}>{step.output ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2 style={{ marginTop: 20 }}>Runs</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Run</th><th>Status</th><th>Phase</th><th>Continuity</th><th>Runtime</th><th>Started</th><th /></tr>
          </thead>
          <tbody>
            {(d.runs ?? []).map((run: any) => (
              <tr key={run.id}>
                <td>{shortId(run.id)}</td>
                <td>{run.status}</td>
                <td>{run.phase ?? "-"}</td>
                <td>{run.continuity ?? "new"}</td>
                <td>{run.runtimeName ?? "-"}</td>
                <td className="muted">{fmtRelative(run.startTime ?? run.createdAt)}</td>
                <td className="actions">
                  <button className="small" onClick={() => navigate(`/runs/${run.id}`)}>inspect</button>
                  {["pending", "starting", "running"].includes(run.status) && (
                    <> <button className="small danger" onClick={() => act("cancel", "cancel")}>cancel</button></>
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
