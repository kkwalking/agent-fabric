import { get, del, fmtTime, shortId } from "../api";
import { useAsync, ErrorBox } from "../components";
import { HANDOFF_TRIGGERS } from "../presentation";
import { navigate } from "../router";

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

/** Why a slice survived selection — the same enum the selector writes. */
const RETENTION_LABELS: Record<string, string> = {
  pinned: "pinned — historical user context, kept verbatim",
  recent: "recent — part of the working trajectory",
  paired: "paired — kept so its tool result/call stays readable",
  "oversized-truncated": "oversized — head+tail kept, middle dropped",
};

interface ContextSlice {
  kind: string;
  text: string;
  runId?: string;
  toolName?: string;
  reconstructable?: boolean;
  retention: string;
}

interface ContextBundle {
  version: number;
  checkpoint?: string;
  pinnedContext: ContextSlice[];
  retainedContext: ContextSlice[];
  budget: {
    contextWindow: number;
    maxTokens: number;
    estimatedTokens: number;
    checkpointTokens: number;
    pinnedTokens: number;
    retainedTokens: number;
    metadataTokens?: number;
    userNotesTokens?: number;
    charsPerToken: number;
  };
}

/** One retained/pinned slice: what it is, why it stayed, and its text. */
function ContextSliceRow({ slice }: { slice: ContextSlice }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="muted">
        <span className="mono">[{slice.kind}]</span>
        {slice.toolName ? <> <span className="mono">{slice.toolName}</span></> : null}
        {" · "}
        <span title={RETENTION_LABELS[slice.retention] ?? slice.retention}>{slice.retention}</span>
        {slice.reconstructable ? <> · reconstructable from the workspace</> : null}
        {slice.runId ? <> · <span className="mono">{shortId(slice.runId)}</span></> : null}
      </div>
      <pre style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", margin: "4px 0 0" }}>
        {slice.text}
      </pre>
    </div>
  );
}

/**
 * The context bundle: what crossed the session boundary, and how much of the
 * handoff budget each class of context spent. A handoff is not a summary — the
 * checkpoint here is only the fallback representation of what did not fit
 * verbatim.
 */
function ContextBundleCard({ bundle }: { bundle: ContextBundle }) {
  const b = bundle.budget;
  const rows: Array<[string, string]> = [
    ["Target context window", `${b.contextWindow.toLocaleString()} tok`],
    ["Handoff budget", `${b.maxTokens.toLocaleString()} tok`],
    ["Estimated size", `${b.estimatedTokens.toLocaleString()} tok`],
    ["Checkpoint", `${b.checkpointTokens.toLocaleString()} tok`],
    ["Pinned user context", `${b.pinnedTokens.toLocaleString()} tok`],
    ["Recent working context", `${b.retainedTokens.toLocaleString()} tok`],
    ["Render + run metadata", `${(b.metadataTokens ?? 0).toLocaleString()} tok`],
    ["User notes", `${(b.userNotesTokens ?? 0).toLocaleString()} tok`],
    ["Estimator", `${b.charsPerToken} chars/token`],
  ];
  return (
    <>
      <h2>Context bundle — what crossed the session boundary</h2>
      <p className="sub">
        A Handoff is not a summary. The checkpoint is only the state index over the history that did not fit; the
        recent working trajectory and the user's own instructions are carried over word for word. Every slice below
        records why it survived selection.
      </p>
      <div className="card">
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", maxWidth: 460 }}>
            <span className="muted">{label}</span>
            <span className="mono">{value}</span>
          </div>
        ))}
      </div>

      <h3>Preserved user context ({bundle.pinnedContext.length})</h3>
      <div className="card">
        {bundle.pinnedContext.length === 0 ? (
          <div className="muted">
            Nothing pinned: every user instruction the handoff covers is already in the recent working context below.
          </div>
        ) : (
          bundle.pinnedContext.map((s, i) => <ContextSliceRow key={i} slice={s} />)
        )}
      </div>

      <h3>Recent working context ({bundle.retainedContext.length})</h3>
      <div className="card">
        {bundle.retainedContext.length === 0 ? (
          <div className="muted">No verbatim context was retained — the checkpoint carries the whole handoff.</div>
        ) : (
          bundle.retainedContext.map((s, i) => <ContextSliceRow key={i} slice={s} />)
        )}
      </div>
    </>
  );
}

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

/** One read-only provenance row on the handoff page (audit, not content). */
function AuditRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** Download the rendered handoff body — exactly what the next agent receives — as a .md file. */
function downloadMarkdown(filename: string, markdown: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function HandoffsView() {
  const { data, error, reload } = useAsync<any[]>(() => get("/api/handoffs"), []);

  return (
    <div>
      <h1>Handoffs</h1>
      <p className="sub">
        A Handoff is a semantic work handover: it carries a task's context into a NEW native session — on the
        same harness or a different one — and generating it is an explicit action. Sessions are never migrated.
      </p>
      <ErrorBox message={error} />

      <div className="card">
        {data && data.length > 0 ? (
          <table>
            <thead>
              <tr><th>ID</th><th>Task</th><th>Source</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((h) => (
                <tr key={h.id}>
                  <td className="mono"><a onClick={() => navigate(`/handoffs/${h.id}`)}>{shortId(h.id)}</a></td>
                  <td className="mono">{shortId(h.taskId)}</td>
                  <td><SourceBadge source={h.source} /></td>
                  <td className="muted">{fmtTime(h.createdAt)}</td>
                  <td><button className="small" onClick={() => navigate(`/handoffs/${h.id}`)}>view</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No handoffs yet. Open a task thread and generate one from there.</div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="small" onClick={reload}>refresh</button>
        </div>
      </div>
    </div>
  );
}

export function HandoffDetailView({ handoffId }: { handoffId: string }) {
  const { data: detail, error } = useAsync<any>(() => get(`/api/handoffs/${handoffId}`), [handoffId]);

  if (error) return <ErrorBox message={error} />;
  if (!detail) return <div className="muted">Loading…</div>;
  const consumedBy: string[] = detail.consumedByRunIds ?? [];
  const g = detail.generation as
    | {
        method?: string;
        trigger?: string;
        detail?: string;
        chunks?: number;
        modelName?: string;
        providerName?: string;
        coveredRunIds?: string[];
        durationMs?: number;
        usage?: { inputTokens: number; outputTokens: number };
      }
    | undefined;
  const bundle = (detail.content?.contextBundle ?? undefined) as ContextBundle | undefined;
  const degraded = g?.method === "heuristic";
  const writtenBy = g?.modelName ? (g.providerName ? `${g.providerName}/${g.modelName}` : g.modelName) : undefined;
  const covered = g?.coveredRunIds ?? [];
  const tokens = g?.usage ? g.usage.inputTokens + g.usage.outputTokens : 0;

  return (
    <div>
      <div className="row">
        <a onClick={() => navigate("/handoffs")}>← handoffs</a>
        <a onClick={() => navigate(`/tasks/${detail.taskId}`)}>task thread ↗</a>
        <a onClick={() => navigate(`/runs/${detail.fromRunId}`)}>source run ↗</a>
        <span className="right">
          {(detail.sources ?? [detail.source]).map((s: string) => <SourceBadge key={s} source={s} />)}
        </span>
      </div>
      <h1 className="mono">{detail.id}</h1>
      <p className="sub">
        Run <span className="mono">{shortId(detail.fromRunId)}</span>
        {detail.workspaceId ? <> · Workspace <span className="mono">{shortId(detail.workspaceId)}</span></> : null}
        {" "}· {fmtTime(detail.createdAt)}
      </p>
      <div className="row">
        {/* The exported file is the same rendered body shown below — a pure
            download of what the record already carries, nothing re-rendered. */}
        <button
          className="small"
          onClick={() => downloadMarkdown(`handoff-${shortId(detail.id)}.md`, detail.renderedPrompt)}
        >
          Export as Markdown
        </button>
        {/* Wrong context is discarded, never repaired in place: a handoff is
            whatever the model produced at generation time, so a bad one is
            deleted and regenerated from the task thread (AGENTS.md). */}
        <button
          className="small"
          onClick={async () => {
            if (!confirm(`Discard ${detail.id}? It cannot be recovered — generate a new handoff instead.`)) return;
            await del(`/api/handoffs/${detail.id}`);
            navigate("/handoffs");
          }}
        >
          Discard handoff
        </button>
      </div>
      {degraded && (
        <div className="card handoff-degraded-card">
          <b>⚠ Degraded context — not a model-written checkpoint.</b>{" "}
          {g?.detail ?? "The model was unavailable."}{" "}
          The next agent receives a structured digest of the run records (task, changed files, tools, last
          message) rather than a checkpoint plus preserved context.
        </div>
      )}

      {/* How this context was produced — written once at generation and
          carried by the record, with the same facts riding the
          `handoff.generated` event so the task timeline shows identical
          provenance where it happened. */}
      <h2>Generation — how this context was produced</h2>
      <div className="card">
        <AuditRow label="Trigger">
          {g?.trigger ? (
            <>
              <span className="mono">{g.trigger}</span>{" "}
              <span className="muted">— {HANDOFF_TRIGGERS[g.trigger] ?? "recorded reason"}</span>
            </>
          ) : (
            <span className="muted">not recorded (generated before this was tracked)</span>
          )}
        </AuditRow>
        <AuditRow label="Method">
          <span className="mono">{g?.method ?? "unknown"}</span>
          {g?.chunks && g.chunks > 1 ? <span className="muted"> · {g.chunks} summarization calls</span> : null}
        </AuditRow>
        <AuditRow label="Written by">
          {writtenBy ? (
            <span className="mono">{writtenBy}</span>
          ) : (
            <span className="muted">
              no model —{" "}
              {g?.method === "harness"
                ? "the previous harness wrote this content"
                : g?.method === "context-bundle"
                  ? "the whole covered history fit in the preserved context, so no checkpoint was needed"
                  : "degraded digest"}
            </span>
          )}
        </AuditRow>
        <AuditRow label="Covers">
          {covered.length > 0 ? (
            <>
              {covered.map((id, i) => (
                <span key={id}>
                  {i > 0 ? ", " : ""}
                  <a className="mono" onClick={() => navigate(`/runs/${id}`)}>{shortId(id)} ↗</a>
                </span>
              ))}{" "}
              <span className="muted">
                — the runs this handoff carries; runs already inside an earlier checkpoint are not re-covered.
              </span>
            </>
          ) : (
            <span className="muted">no run (nothing had been executed when this was written)</span>
          )}
        </AuditRow>
        {(g?.durationMs || tokens > 0) && (
          <AuditRow label="Cost">
            {g?.durationMs ? <>{g.durationMs} ms</> : null}
            {g?.durationMs && tokens > 0 ? <span className="muted"> · </span> : null}
            {tokens > 0 ? <>{tokens.toLocaleString()} tok</> : null}
          </AuditRow>
        )}
      </div>

      {bundle && <ContextBundleCard bundle={bundle} />}

      <h2>Rendered handoff — what the next agent receives</h2>
      <div className="card">
        <pre style={{ whiteSpace: "pre-wrap", maxHeight: "none" }}>{detail.renderedPrompt}</pre>
        <p className="muted" style={{ margin: "10px 0 0" }}>
          {consumedBy.length > 0 ? (
            <>
              The consuming turn's user input is appended under <span className="mono"># Your instruction</span>. Consumed by{" "}
              {consumedBy.map((id: string, i: number) => (
                <span key={id}>
                  {i > 0 ? ", " : ""}
                  <a className="mono" onClick={() => navigate(`/runs/${id}`)}>{shortId(id)} ↗</a>
                </span>
              ))}
              {" "}— open the run inspector for the full input instruction.
            </>
          ) : detail.awaitingNextTurn ? (
            <>Armed for the next turn: the user input of that turn is appended under <span className="mono"># Your instruction</span> when it runs.</>
          ) : (
            <>Not consumed by any run yet; the consuming turn's user input is appended under <span className="mono"># Your instruction</span>.</>
          )}
        </p>
      </div>

      <h2>Parsed fields (for inspection)</h2>
      <p className="sub">
        The handoff content broken into structured fields for inspection. When the handoff carries a written
        checkpoint, these fields are parsed out of it at generation time and the rendered prompt above embeds
        the checkpoint verbatim — the fields below are not sent to the next agent.
      </p>
      <div className="card">
        {CONTENT_SECTIONS.map(({ key, label }) => (
          <HandoffSection key={key} label={label} value={(detail.content ?? {})[key]} />
        ))}
        {detail.userNotes && <HandoffSection label="User notes (verbatim)" value={detail.userNotes} />}
      </div>
    </div>
  );
}
