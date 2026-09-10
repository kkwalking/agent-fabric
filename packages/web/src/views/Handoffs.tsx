import { get, fmtTime, shortId } from "../api";
import { useAsync, ErrorBox } from "../components";
import { navigate } from "../router";

const CONTENT_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "originalTask", label: "Original task" },
  { key: "currentObjective", label: "Current objective" },
  { key: "progressSummary", label: "Progress summary" },
  { key: "completedWork", label: "Completed work" },
  { key: "remainingWork", label: "Remaining work" },
  { key: "importantDecisions", label: "Important decisions" },
  { key: "userConstraints", label: "User constraints" },
  { key: "relevantFiles", label: "Relevant files" },
  { key: "workspaceStatus", label: "Workspace status" },
  { key: "artifacts", label: "Artifacts" },
  { key: "testBuildStatus", label: "Test / build status" },
  { key: "previousRunResult", label: "Previous run result" },
  { key: "notesForNextAgent", label: "Notes for the next agent" },
];

function SourceBadge({ source }: { source: string }) {
  const label = source === "harness" ? "harness-generated" : source === "agentfabric" ? "AgentFabric-assisted" : "user-provided";
  return <span className="badge running" title={`Handoff source: ${label}`}>{label}</span>;
}

function HandoffSection({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  const body = Array.isArray(value)
    ? value.map((v, i) => <div key={i}>• {String(v)}</div>)
    : <div style={{ whiteSpace: "pre-wrap" }}>{String(value)}</div>;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted">{label}</div>
      <div>{body}</div>
    </div>
  );
}

export function HandoffsView() {
  const { data, error, reload } = useAsync<any[]>(() => get("/api/handoffs"), []);

  return (
    <div>
      <h1>Handoffs</h1>
      <p className="sub">
        A Handoff is a semantic work handover between two agent harnesses — the new harness always starts its own
        new native session; sessions are never migrated. Same harness → Resume, different harness → Handoff.
      </p>
      <ErrorBox message={error} />

      <div className="card">
        {data && data.length > 0 ? (
          <table>
            <thead>
              <tr><th>ID</th><th>Task</th><th>From</th><th>To</th><th>Source</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((h) => (
                <tr key={h.id}>
                  <td className="mono"><a onClick={() => navigate(`/handoffs/${h.id}`)}>{shortId(h.id)}</a></td>
                  <td className="mono">{shortId(h.taskId)}</td>
                  <td>{h.fromRuntimeName ?? h.fromRuntimeKind ?? "-"}</td>
                  <td>{h.toRuntimeName ?? h.toRuntimeKind ?? "-"}</td>
                  <td><SourceBadge source={h.source} /></td>
                  <td className="muted">{fmtTime(h.createdAt)}</td>
                  <td><button className="small" onClick={() => navigate(`/handoffs/${h.id}`)}>view</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No handoffs yet. Continue a task on a different harness to create one.</div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="small" onClick={reload}>refresh</button>
        </div>
      </div>
    </div>
  );
}

export function HandoffDetailView({ handoffId }: { handoffId: string }) {
  const { data: detail, error } = useAsync<any>(() => get(`/api/handoffs/${handoffId}`), [handoffId]);

  if (error) return <ErrorBox message={error} />;
  if (!detail) return <div className="muted">Loading…</div>;
  const consumedBy: string[] = detail.consumedByRunIds ?? [];

  return (
    <div>
      <div className="row">
        <a onClick={() => navigate("/handoffs")}>← handoffs</a>
        <a onClick={() => navigate(`/tasks/${detail.taskId}`)}>task thread ↗</a>
        <a onClick={() => navigate(`/runs/${detail.fromRunId}`)}>source run ↗</a>
        <span className="right">
          {(detail.sources ?? [detail.source]).map((s: string) => <SourceBadge key={s} source={s} />)}
        </span>
      </div>
      <h1 className="mono">{detail.id}</h1>
      <p className="sub">
        {detail.fromRuntimeName ?? detail.fromRuntimeKind ?? "unknown"} → {detail.toRuntimeName ?? detail.toRuntimeKind ?? "(next agent picks)"}
        {" "}· Run <span className="mono">{shortId(detail.fromRunId)}</span>
        {detail.workspaceId ? <> · Workspace <span className="mono">{shortId(detail.workspaceId)}</span></> : null}
        {" "}· {fmtTime(detail.createdAt)}
      </p>

      <h2>Rendered handoff — what the next agent receives</h2>
      <div className="card">
        <pre style={{ whiteSpace: "pre-wrap", maxHeight: "none" }}>{detail.renderedPrompt}</pre>
        <p className="muted" style={{ margin: "10px 0 0" }}>
          {consumedBy.length > 0 ? (
            <>
              The consuming turn's user input is appended under <span className="mono"># Your instruction</span>. Consumed by{" "}
              {consumedBy.map((id: string, i: number) => (
                <span key={id}>
                  {i > 0 ? ", " : ""}
                  <a className="mono" onClick={() => navigate(`/runs/${id}`)}>{shortId(id)} ↗</a>
                </span>
              ))}
              {" "}— open the run inspector for the full input instruction.
            </>
          ) : detail.awaitingNextTurn ? (
            <>Armed for the next turn: the user input of that turn is appended under <span className="mono"># Your instruction</span> when it runs.</>
          ) : (
            <>Not consumed by any run yet; the consuming turn's user input is appended under <span className="mono"># Your instruction</span>.</>
          )}
        </p>
      </div>

      <h2>Parsed fields (for inspection)</h2>
      <p className="sub">
        The same handoff content broken into structured fields for inspection. When the handoff carries a
        compaction checkpoint, these fields are parsed out of it and the rendered prompt above embeds the
        checkpoint verbatim — the fields below are not sent to the next agent.
      </p>
      <div className="card">
        {CONTENT_SECTIONS.map(({ key, label }) => (
          <HandoffSection key={key} label={label} value={(detail.content ?? {})[key]} />
        ))}
        {detail.userNotes && <HandoffSection label="User notes (verbatim)" value={detail.userNotes} />}
      </div>
    </div>
  );
}
