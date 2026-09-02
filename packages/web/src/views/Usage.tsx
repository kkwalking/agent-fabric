import { get } from "../api";
import { useAsync, ErrorBox } from "../components";

export function UsageView() {
  const { data, error } = useAsync<any>(() => get("/api/usage"), []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <div className="muted">Loading…</div>;

  const maxHistory = Math.max(1, ...data.history.map((h: any) => h.cost));

  return (
    <div>
      <h1>Usage & Cost</h1>
      <p className="sub">Unified tracking across providers and models.</p>

      <div className="grid">
        <div className="stat"><div className="num">{data.runs}</div><div className="lbl">runs</div></div>
        <div className="stat"><div className="num">{data.inputTokens.toLocaleString()}</div><div className="lbl">input tokens</div></div>
        <div className="stat"><div className="num">{data.outputTokens.toLocaleString()}</div><div className="lbl">output tokens</div></div>
        <div className="stat"><div className="num">{data.modelRequests}</div><div className="lbl">model requests</div></div>
        <div className="stat"><div className="num">${data.estimatedCost.toFixed(6)}</div><div className="lbl">estimated cost</div></div>
      </div>

      <h2>Cost history</h2>
      <div className="card">
        {data.history.length === 0 && <div className="muted">No history yet.</div>}
        <div className="hist-bar">
          {data.history.map((h: any) => (
            <div key={h.date} style={{ display: "flex", flexDirection: "column", flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
              <div className="bar" style={{ height: `${(h.cost / maxHistory) * 100}%`, minHeight: h.cost > 0 ? 4 : 0 }} title={`$${h.cost}`} />
              <div className="bar-label">{h.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>

      <h2>By model</h2>
      <div className="card">
        {Object.entries(data.byModel ?? {}).length === 0 && <div className="muted">No model usage yet.</div>}
        <table>
          <thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cached</th><th>Cost</th></tr></thead>
          <tbody>
            {Object.entries(data.byModel ?? {}).map(([name, m]: [string, any]) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td>{m.requests}</td>
                <td>{m.inputTokens}</td>
                <td>{m.outputTokens}</td>
                <td>{m.cachedTokens}</td>
                <td>${m.cost.toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>By provider</h2>
      <div className="card">
        {Object.entries(data.byProvider ?? {}).length === 0 && <div className="muted">No provider usage yet.</div>}
        <table>
          <thead><tr><th>Provider</th><th>Requests</th><th>Cost</th></tr></thead>
          <tbody>
            {Object.entries(data.byProvider ?? {}).map(([id, p]: [string, any]) => (
              <tr key={id}>
                <td className="mono">{id}</td>
                <td>{p.requests}</td>
                <td>${p.cost.toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
