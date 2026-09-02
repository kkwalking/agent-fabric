import { useState } from "react";
import { get, del, fmtTime, shortId } from "../api";
import { useAsync, ErrorBox } from "../components";

export function ArtifactsView() {
  const { data, error, reload } = useAsync<any[]>(() => get("/api/artifacts"), []);
  const [selected, setSelected] = useState<any | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async (a: any) => {
    setSelected(a);
    setLoading(true);
    setContent(null);
    try {
      const text = await get<string>(`/api/artifacts/${a.id}/content`);
      setContent(text);
    } catch (e) {
      setContent(`(cannot render: ${e instanceof Error ? e.message : e})`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Artifacts</h1>
      <p className="sub">Files, diffs, patches, reports and outputs produced by agent runs.</p>
      <ErrorBox message={error} />

      <div className="card">
        {data && data.length > 0 ? (
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Run</th><th>Size</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td className="mono"><a onClick={() => open(a)}>{a.name}</a></td>
                  <td>{a.kind}</td>
                  <td className="mono">{shortId(a.runId)}</td>
                  <td>{a.size}</td>
                  <td className="muted">{fmtTime(a.createdAt)}</td>
                  <td><button className="small danger" onClick={async () => { await del(`/api/artifacts/${a.id}`); reload(); }}>delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No artifacts yet.</div>
        )}
      </div>

      {selected && (
        <div className="card">
          <div className="row">
            <h2 className="mono">{selected.name}</h2>
            <span className="right muted">{selected.kind} · {selected.mime ?? "text/plain"} · {selected.id}</span>
          </div>
          <pre>{loading ? "loading…" : content}</pre>
        </div>
      )}
    </div>
  );
}
