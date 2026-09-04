import { useEffect, useState } from "react";
import { get, fmtTime, fmtCost, shortId, subscribeSSE } from "../api";
import { StatusBadge, useAsync, ErrorBox } from "../components";

interface DashboardData {
  counts: Record<string, number>;
  recentRuns: any[];
  usage: any;
}

export function Dashboard({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { data, error, reload } = useAsync<DashboardData>(() => get("/api/dashboard"), []);
  const [live, setLive] = useState<any[]>([]);

  useEffect(() => {
    const unsub = subscribeSSE("/api/events/stream", (evt) => {
      setLive((prev) => [evt, ...prev].slice(0, 30));
    });
    return unsub;
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <div className="muted">Loading…</div>;

  const stats = [
    ["Providers", data.counts.providers],
    ["Models", data.counts.models],
    ["Runtimes", data.counts.runtimes],
    ["Tasks", data.counts.tasks],
    ["Runs", data.counts.runs],
    ["Workspaces", data.counts.workspaces],
    ["Handoffs", data.counts.handoffs],
    ["Native sessions", data.counts.runtimeSessions],
    ["Artifacts", data.counts.artifacts],
  ];

  return (
    <div>
      <h1>Dashboard</h1>
      <p className="sub">Run any agent, on any model, in any environment.</p>

      <div className="grid">
        {stats.map(([label, num]) => (
          <div className="stat" key={label as string}>
            <div className="num">{num}</div>
            <div className="lbl">{label}</div>
          </div>
        ))}
        <div className="stat">
          <div className="num">${data.usage.estimatedCost.toFixed(4)}</div>
          <div className="lbl">Total cost</div>
        </div>
      </div>

      <h2>Recent runs</h2>
      <div className="card">
        <table>
          <thead>
            <tr><th>Run</th><th>Title</th><th>Status</th><th>Runtime</th><th>Model</th><th>Cost</th><th>Created</th></tr>
          </thead>
          <tbody>
            {data.recentRuns.length === 0 && (
              <tr><td colSpan={7} className="muted">No runs yet — submit one with <span className="mono">af run "…"</span> or the Runs page.</td></tr>
            )}
            {data.recentRuns.map((r) => (
              <tr key={r.id}>
                <td className="mono"><a onClick={() => onOpenRun(r.id)}>{shortId(r.id)}</a></td>
                <td>{r.taskTitle}</td>
                <td><StatusBadge status={r.status} /></td>
                <td>{r.runtimeName ?? "-"}</td>
                <td>{r.modelName ?? "-"}</td>
                <td>{fmtCost(r.cost)}</td>
                <td className="muted">{fmtTime(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="small" onClick={reload}>refresh</button>
        </div>
      </div>

      <h2>Live event stream</h2>
      <div className="card">
        <pre>{live.length === 0 ? "(waiting for events…)" : live.map((e) => `${e.timestamp}  ${e.type}  ${JSON.stringify(e.data)}`).join("\n")}</pre>
      </div>
    </div>
  );
}
