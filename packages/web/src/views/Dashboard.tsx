import { get } from "../api";
import { useAsync, ErrorBox } from "../components";
import { navigate } from "../router";

interface DashboardData {
  counts: Record<string, number>;
  usage: any;
}

export function Dashboard() {
  const { data, error } = useAsync<DashboardData>(() => get("/api/dashboard"), []);

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
        {/* Entry to the Trash: deleted tasks are recoverable for 30 days. */}
        <button className="stat clickable" onClick={() => navigate("/trash")}>
          <div className="num">{data.counts.deletedTasks}</div>
          <div className="lbl">Deleted tasks</div>
        </button>
        <div className="stat">
          <div className="num">${data.usage.estimatedCost.toFixed(4)}</div>
          <div className="lbl">Total cost</div>
        </div>
      </div>
    </div>
  );
}
