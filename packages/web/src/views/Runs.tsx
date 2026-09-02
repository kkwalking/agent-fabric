import { useEffect, useState } from "react";
import { del, get, post, fmtTime, fmtCost, shortId, subscribeSSE } from "../api";
import { StatusBadge, useAsync, ErrorBox, Icon } from "../components";

function NewRunForm({ onCreated }: { onCreated: (runId: string) => void }) {
  const runtimes = useAsync<any[]>(() => get("/api/runtimes"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);
  const [prompt, setPrompt] = useState("");
  const [runtimeId, setRuntimeId] = useState("");
  const [modelId, setModelId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const r = await post<any>("/api/runs", {
        prompt: prompt.trim(),
        runtimeId: runtimeId || undefined,
        modelId: modelId || undefined,
        workspaceId: workspaceId || undefined,
      });
      setPrompt("");
      onCreated(r.run.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        rows={3}
        placeholder="Describe the task for the agent…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      <div className="composer-bar">
        <select className="pill" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)}>
          <option value="">Runtime: default</option>
          {(runtimes.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.kind})</option>)}
        </select>
        <select className="pill" value={modelId} onChange={(e) => setModelId(e.target.value)}>
          <option value="">Model: default</option>
          {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.alias ?? m.name}</option>)}
        </select>
        <select className="pill" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">Workspace: none</option>
          {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button className="send" title="Run task" disabled={busy || !prompt.trim()} onClick={submit}>
          <Icon name="arrowUp" size={16} />
        </button>
      </div>
    </div>
  );
}

export function RunsView({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { data, error, loading, reload } = useAsync<any[]>(() => get("/api/runs"), []);
  return (
    <div>
      <h1>Runs</h1>
      <p className="sub">Every task execution produces an independent Run with its own lifecycle, events, usage and artifacts.</p>
      <ErrorBox message={error} />
      <NewRunForm onCreated={onOpenRun} />
      <div className="card">
        {data && data.length > 0 ? (
          <table>
            <thead>
              <tr><th>Run</th><th>Title</th><th>Status</th><th>Runtime</th><th>Model</th><th>Cost</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td className="mono"><a onClick={() => onOpenRun(r.id)}>{shortId(r.id)}</a></td>
                  <td>{r.taskTitle}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.runtimeName ?? "-"}</td>
                  <td>{r.modelName ?? "-"}</td>
                  <td>{fmtCost(r.cost)}</td>
                  <td className="muted">{fmtTime(r.createdAt)}</td>
                  <td>
                    {["pending", "starting", "running"].includes(r.status) && (
                      <button className="small danger" onClick={async () => { await post(`/api/runs/${r.id}/cancel`); reload(); }}>cancel</button>
                    )}{" "}
                    {["completed", "failed", "cancelled", "timeout"].includes(r.status) && (
                      <button className="small" onClick={async () => { await post(`/api/runs/${r.id}/rerun`); reload(); }}>rerun</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">{loading ? "Loading…" : "No runs yet."}</div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="small" onClick={reload}>refresh</button>
        </div>
      </div>
    </div>
  );
}

export function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { data: run, error, reload } = useAsync<any>(() => get(`/api/runs/${runId}`), [runId]);
  const [events, setEvents] = useState<any[]>([]);
  const [tab, setTab] = useState<"events" | "logs" | "artifacts">("events");
  const [artifacts, setArtifacts] = useState<any[]>([]);

  useEffect(() => {
    let unsub: () => void = () => {};
    if (runId) {
      get<any[]>(`/api/runs/${runId}/events`).then(setEvents).catch(() => {});
      get<any[]>(`/api/artifacts?runId=${runId}`).then(setArtifacts).catch(() => {});
      unsub = subscribeSSE(`/api/runs/${runId}/events/stream`, (evt) => {
        setEvents((prev) => {
          if (prev.some((e) => e.id === (evt as any).id)) return prev;
          return [...prev, evt];
        });
      });
    }
    return unsub;
  }, [runId]);

  useEffect(() => {
    if (!run) return;
    const id = setInterval(() => {
      get(`/api/runs/${runId}`).then((r: any) => {
        if (r.status !== run.status) reload();
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  if (error) return <ErrorBox message={error} />;
  if (!run) return <div className="muted">Loading…</div>;

  const isLive = ["pending", "starting", "running"].includes(run.status);
  const logs = events
    .filter((e) => ["log", "shell.output", "agent.message"].includes(e.type))
    .map((e) => {
      const line = e.data?.line ?? e.data?.message ?? e.data?.text ?? e.data?.content ?? "";
      const prefix = e.type === "agent.message" ? "[agent] " : e.type === "shell.output" ? "[shell] " : "";
      return prefix + line;
    })
    .filter((l) => l !== "");

  return (
    <div>
      <div className="row">
        <a onClick={onBack}>← back to runs</a>
        <span className="right">
          {isLive && <button className="danger" onClick={async () => { await post(`/api/runs/${runId}/cancel`); reload(); }}>cancel</button>}
          {" "}
          <button className="small" onClick={reload}>refresh</button>
        </span>
      </div>
      <h1 className="mono">{runId}</h1>
      <p className="sub">{run.taskTitle}</p>

      <div className="grid">
        <div className="stat"><div className="num"><StatusBadge status={run.status} /></div><div className="lbl">status</div></div>
        <div className="stat"><div className="num">{run.runtimeName ?? "-"}</div><div className="lbl">runtime</div></div>
        <div className="stat"><div className="num">{run.modelName ?? "-"}</div><div className="lbl">model</div></div>
        <div className="stat"><div className="num">{fmtCost(run.cost)}</div><div className="lbl">cost</div></div>
        <div className="stat"><div className="num">{(run.usage?.modelRequests ?? 0)}</div><div className="lbl">model calls</div></div>
        <div className="stat"><div className="num">{(run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0)}</div><div className="lbl">tokens</div></div>
      </div>

      {run.error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>Error: {run.error}</div>
      )}

      <div className="row" style={{ margin: "16px 0" }}>
        {(["events", "logs", "artifacts"] as const).map((t) => (
          <button key={t} className={tab === t ? "primary" : ""} onClick={() => setTab(t)}>
            {t} {t === "events" ? `(${events.length})` : t === "artifacts" ? `(${artifacts.length})` : ""}
          </button>
        ))}
      </div>

      <div className="card">
        {tab === "events" && (
          <div style={{ maxHeight: 520, overflow: "auto" }}>
            {events.length === 0 && <div className="muted">No events yet.</div>}
            {events.map((e) => (
              <div key={e.id} className={`event-line ${e.level === "error" ? "error" : ""}`}>
                <span className="t">{fmtTime(e.timestamp)}</span>
                <span className="type">{e.type}</span>
                {e.type === "log" || e.type === "shell.output" || e.type === "agent.message" ? (
                  String(e.data?.line ?? e.data?.message ?? e.data?.text ?? e.data?.content ?? "")
                ) : (
                  <span className="muted">{JSON.stringify(e.data)}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {tab === "logs" && (
          <pre>{logs.length ? logs.join("\n") : "(no log lines)"}</pre>
        )}
        {tab === "artifacts" && (
          <div>
            {artifacts.length === 0 && <div className="muted">No artifacts for this run.</div>}
            <table>
              <thead><tr><th>Name</th><th>Kind</th><th>Size</th><th>ID</th></tr></thead>
              <tbody>
                {artifacts.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.name}</td>
                    <td>{a.kind}</td>
                    <td>{a.size}</td>
                    <td className="mono">{a.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
