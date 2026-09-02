import { useState } from "react";
import { get, post, fmtTime, fmtCost, shortId } from "../api";
import { StatusBadge, useAsync, ErrorBox } from "../components";

export function SessionsView({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { data, error, reload } = useAsync<any[]>(() => get("/api/sessions"), []);
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
      <p className="sub">Sessions keep an agent's execution context so you can continue a conversation after a run completes.</p>
      <ErrorBox message={error} />

      <div className="card">
        <h2>Create session</h2>
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
