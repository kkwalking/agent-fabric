import { useEffect, useState } from "react";
import { get, post, fmtTime, shortId } from "../api";
import { StatusBadge, useAsync, ErrorBox } from "../components";

interface ContinueOptions {
  task: { id: string; title: string; prompt: string; workspaceId?: string };
  latestRun?: { id: string; status: string; runtimeName?: string; continuity?: string; endTime?: string };
  currentRuntime?: { id: string; name: string; kind: string };
  targetRuntime?: { id: string; name: string; kind: string; capabilities: Record<string, boolean> };
  resumeAvailable: boolean;
  suggestedMode: "resume" | "handoff";
  resumableSession?: { id: string; nativeSessionRef: string; runtimeKind: string };
  handoffPreview?: Record<string, unknown>;
  explanation: string;
}

function ContinuityBanner({ opts, mode, selectedRuntime }: { opts: ContinueOptions; mode: string; selectedRuntime?: { id: string; name: string; kind: string } }) {
  const effective = mode === "auto" ? opts.suggestedMode : mode;
  const target = selectedRuntime ?? opts.targetRuntime;
  const current = opts.currentRuntime;
  if (effective === "resume") {
    return (
      <div className="card" style={{ borderColor: "var(--green, #3ecf8e)", background: "rgba(62,207,142,.08)" }}>
        <strong>▶ Resume</strong> — same harness ({target?.name}); AgentFabric will resume its native session{" "}
        <span className="mono">{opts.resumableSession?.nativeSessionRef}</span>. No handoff is created; the harness keeps its own context.
      </div>
    );
  }
  return (
    <div className="card" style={{ borderColor: "var(--amber, #e2b93b)", background: "rgba(226,185,59,.08)" }}>
      <strong>⇄ Handoff</strong>{" "}
      {current && target && current.kind !== target.kind ? (
        <>— switching harness {current.name} → {target.name}. <strong>Sessions are NOT migrated across harnesses.</strong>{" "}</>
      ) : (
        <>— {target?.name} cannot natively resume, so a <strong>new native session</strong> is created.{" "}</>
      )}
      The new agent continues from a generated Handoff plus the shared Workspace — not from the previous session's internal state.
    </div>
  );
}

function ContinuePanel({ taskId, onOpenRun, onClose }: { taskId: string; onOpenRun: (id: string) => void; onClose: () => void }) {
  const { data: opts, error } = useAsync<ContinueOptions>(() => get(`/api/tasks/${taskId}/continue-options`), [taskId]);
  const runtimes = useAsync<any[]>(() => get("/api/runtimes"), []);
  const [runtimeId, setRuntimeId] = useState("");
  const [mode, setMode] = useState<"auto" | "resume" | "handoff">("auto");
  const [prompt, setPrompt] = useState("");
  const [notes, setNotes] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (opts?.targetRuntime) setRuntimeId(opts.targetRuntime.id);
  }, [opts?.targetRuntime?.id]);

  const selectedRuntime = runtimeId
    ? (runtimes.data ?? []).find((r) => r.id === runtimeId)
    : opts?.targetRuntime;

  const submit = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const r = await post<any>(`/api/tasks/${taskId}/continue`, {
        prompt: prompt.trim(),
        runtimeId: runtimeId || undefined,
        mode,
        userNotes: notes.trim() || undefined,
        lifecycle: lifecycle ? { mode: lifecycle } : undefined,
      });
      onOpenRun(r.run.id);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox message={error} />;
  if (!opts) return <div className="muted">Loading…</div>;

  return (
    <div className="card">
      <div className="row">
        <h2>Continue task</h2>
        <span className="right"><button className="small" onClick={onClose}>close</button></span>
      </div>
      <ContinuityBanner opts={opts} mode={mode} selectedRuntime={selectedRuntime} />
      <p className="sub">{opts.explanation}</p>
      <div className="composer">
        <textarea
          rows={3}
          placeholder="What should the agent do next?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="composer-bar">
          <select className="pill" value={mode} onChange={(e) => setMode(e.target.value as any)} title="Continuity mode">
            <option value="auto">Continuity: auto ({opts.suggestedMode})</option>
            <option value="resume">Continuity: resume</option>
            <option value="handoff">Continuity: handoff</option>
          </select>
          <select
            className="pill"
            value={runtimeId}
            onChange={(e) => setRuntimeId(e.target.value)}
            title="Target runtime — switching harness turns this into a handoff"
          >
            {(runtimes.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                Runtime: {r.name} ({r.kind}){opts.currentRuntime && r.kind !== opts.currentRuntime.kind ? " ⇄ handoff" : " • resume"}
              </option>
            ))}
          </select>
          <select className="pill" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)} title="Container lifecycle for the next run">
            <option value="">Lifecycle: runtime default</option>
            <option value="ephemeral">Lifecycle: ephemeral</option>
            <option value="keep-alive">Lifecycle: keep-alive</option>
            <option value="persistent">Lifecycle: persistent</option>
          </select>
          <button className="send" title="Continue task" disabled={busy || !prompt.trim()} onClick={submit}>▶</button>
        </div>
        <input
          placeholder='Optional notes for the next agent, e.g. "继续修剩下的两个测试，不要修改现有 API"'
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      {submitError && <ErrorBox message={submitError} />}
      {opts.handoffPreview && (
        <details>
          <summary className="muted">Preview the handoff the next agent will receive</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(opts.handoffPreview, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export function TasksView({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { data, error, reload } = useAsync<any[]>(() => get("/api/tasks"), []);
  const handoffs = useAsync<any[]>(() => get("/api/handoffs"), []);
  const [continueId, setContinueId] = useState<string | null>(null);

  const handoffCount = (taskId: string) => (handoffs.data ?? []).filter((h) => h.taskId === taskId).length;

  return (
    <div>
      <h1>Tasks</h1>
      <p className="sub">
        A Task is the long-term goal. It persists across Runs, harnesses and containers — continuity comes from
        native Resume (same harness) or Handoff + Workspace (across harnesses).
      </p>
      <ErrorBox message={error} />

      {continueId && (
        <ContinuePanel taskId={continueId} onOpenRun={(id) => onOpenRun(id)} onClose={() => setContinueId(null)} />
      )}

      <div className="card">
        {data && data.length > 0 ? (
          <table>
            <thead>
              <tr><th>Task</th><th>Title</th><th>Runtime</th><th>Workspace</th><th>Handoffs</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{shortId(t.id)}</td>
                  <td>{t.title}</td>
                  <td>{t.runtimeId ? shortId(t.runtimeId) : "-"}</td>
                  <td>{t.workspaceId ? shortId(t.workspaceId) : "-"}</td>
                  <td>{handoffCount(t.id)}</td>
                  <td className="muted">{fmtTime(t.createdAt)}</td>
                  <td>
                    <button className="small primary" onClick={() => setContinueId(t.id === continueId ? null : t.id)}>
                      continue
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No tasks yet — submit a run first.</div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="small" onClick={() => { reload(); handoffs.reload(); }}>refresh</button>
        </div>
      </div>
    </div>
  );
}
