import { useEffect, useState } from "react";
import { get, subscribeSSE } from "../api";
import { useAsync, ErrorBox } from "../components";

interface DashboardData {
  counts: Record<string, number>;
  usage: any;
}

export function Dashboard() {
  const { data, error } = useAsync<DashboardData>(() => get("/api/dashboard"), []);
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

      <h2>Live event stream</h2>
      <div className="card">
        <pre>{live.length === 0 ? "(waiting for events…)" : live.map((e) => `${e.timestamp}  ${e.type}  ${JSON.stringify(e.data)}`).join("\n")}</pre>
      </div>
    </div>
  );
}
