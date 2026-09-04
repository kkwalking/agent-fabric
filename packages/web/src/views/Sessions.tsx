import { useState } from "react";
import { get, post, fmtTime, fmtCost, shortId } from "../api";
import { StatusBadge, useAsync, ErrorBox } from "../components";

export function SessionsView({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { data, error, reload } = useAsync<any[]>(() => get("/api/sessions"), []);
  const nativeSessions = useAsync<any[]>(() => get("/api/runtime-sessions"), []);
  const [name, setName] = useState("");
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await post("/api/sessions", { name: name || undefined });
      setName("");
      reload();
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!resumeId || !prompt) return;
    setBusy(true);
    try {
      const r = await post<any>(`/api/sessions/${resumeId}/resume`, { prompt });
      onOpenRun(r.run.id);
      setResumeId(null);
      setPrompt("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>Sessions</h1>
      <p className="sub">
        Runtime-native sessions are private to each harness — AgentFabric only stores opaque references so the
        <em> same harness</em> can Resume. Different harnesses continue via <strong>Handoff</strong>, never session migration.
      </p>
      <ErrorBox message={error} />

      <div className="card">
        <h2>Runtime-native session references</h2>
        <p className="sub">Opaque references into each harness's own session store. AgentFabric never reads or converts them.</p>
        {nativeSessions.data && nativeSessions.data.length > 0 ? (
          <table>
            <thead><tr><th>ID</th><th>Runtime</th><th>Kind</th><th>Native reference</th><th>Resume</th><th>Run</th><th>Created</th></tr></thead>
            <tbody>
              {nativeSessions.data.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{shortId(s.id)}</td>
                  <td>{s.runtimeName ?? "-"}</td>
                  <td>{s.runtimeKind}</td>
                  <td className="mono">{s.nativeSessionRef}</td>
                  <td>{s.resumeSupported ? "yes" : "no"}</td>
                  <td className="mono"><a onClick={() => onOpenRun(s.runId)}>{shortId(s.runId)}</a></td>
                  <td className="muted">{fmtTime(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No native session references yet.</div>
        )}
      </div>

      <div className="card">
        <h2>AgentFabric sessions (conversation grouping)</h2>
        <div className="row">
          <input style={{ width: 280 }} placeholder="session name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={busy} onClick={create}>create</button>
        </div>
      </div>

      <div className="card">
        {data && data.length > 0 ? (
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Runs</th><th>Cost</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{shortId(s.id)}</td>
                  <td>{s.name ?? "-"}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{s.runIds.length}</td>
                  <td>{fmtCost(s.cost)}</td>
                  <td className="muted">{fmtTime(s.createdAt)}</td>
                  <td>
                    <button className="small" onClick={() => { setResumeId(s.id); setPrompt(""); }}>resume</button>{" "}
                    <button className="small" onClick={async () => { await post(`/api/sessions/${s.id}/close`); reload(); }}>close</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No sessions yet.</div>
        )}
      </div>

      {resumeId && (
        <div className="card">
          <h2>Continue session <span className="mono">{resumeId}</span></h2>
          <textarea rows={4} placeholder="What should the agent do next?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="row">
            <button className="primary" disabled={busy || !prompt} onClick={resume}>submit on session</button>
            <button onClick={() => setResumeId(null)}>cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
