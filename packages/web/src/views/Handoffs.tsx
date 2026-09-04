import { useState } from "react";
import { get, fmtTime, shortId } from "../api";
import { useAsync, ErrorBox } from "../components";

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
  const [selected, setSelected] = useState<string | null>(null);
  const { data: detail } = useAsync<any>(
    () => (selected ? get(`/api/handoffs/${selected}`) : Promise.resolve(null)),
    [selected]
  );

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
                  <td className="mono">{shortId(h.id)}</td>
                  <td className="mono">{shortId(h.taskId)}</td>
                  <td>{h.fromRuntimeName ?? h.fromRuntimeKind ?? "-"}</td>
                  <td>{h.toRuntimeName ?? h.toRuntimeKind ?? "-"}</td>
                  <td><SourceBadge source={h.source} /></td>
                  <td className="muted">{fmtTime(h.createdAt)}</td>
                  <td><button className="small" onClick={() => setSelected(h.id === selected ? null : h.id)}>{selected === h.id ? "hide" : "view"}</button></td>
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

      {detail && (
        <div className="card">
          <div className="row">
            <h2>Handoff <span className="mono">{detail.id}</span></h2>
            <span className="right">
              {(detail.sources ?? [detail.source]).map((s: string) => <SourceBadge key={s} source={s} />)}
            </span>
          </div>
          <p className="sub">
            Run <span className="mono">{shortId(detail.fromRunId)}</span>
            {" "}· {detail.fromRuntimeName ?? detail.fromRuntimeKind ?? "unknown"} → {detail.toRuntimeName ?? detail.toRuntimeKind ?? "(next agent picks)"}
            {detail.workspaceId ? <> · Workspace <span className="mono">{shortId(detail.workspaceId)}</span></> : null}
          </p>
          {CONTENT_SECTIONS.map(({ key, label }) => (
            <HandoffSection key={key} label={label} value={(detail.content ?? {})[key]} />
          ))}
          {detail.userNotes && <HandoffSection label="User notes (verbatim)" value={detail.userNotes} />}
        </div>
      )}
    </div>
  );
}
