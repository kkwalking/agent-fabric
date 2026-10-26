import { useState } from "react";
import { get, del, put, fmtTime, shortId } from "../api";
import { useAsync, ErrorBox, CopyButton, Modal } from "../components";
import { useI18n, useT } from "../i18n-react";
import { navigate } from "../router";
import type { MessageKey, Translate } from "../i18n";

const CONTENT_SECTIONS: Array<{ key: string; label: MessageKey }> = [
  { key: "originalTask", label: "handoffs.field.originalTask" },
  { key: "currentObjective", label: "handoffs.field.currentObjective" },
  { key: "progressSummary", label: "handoffs.field.progressSummary" },
  { key: "completedWork", label: "handoffs.field.completedWork" },
  { key: "remainingWork", label: "handoffs.field.remainingWork" },
  { key: "importantDecisions", label: "handoffs.field.importantDecisions" },
  { key: "userConstraints", label: "handoffs.field.userConstraints" },
  { key: "relevantFiles", label: "handoffs.field.relevantFiles" },
  { key: "workspaceStatus", label: "handoffs.field.workspaceStatus" },
  { key: "artifacts", label: "handoffs.field.artifacts" },
  { key: "testBuildStatus", label: "handoffs.field.testBuildStatus" },
  { key: "previousRunResult", label: "handoffs.field.previousRunResult" },
  { key: "notesForNextAgent", label: "handoffs.field.notesForNextAgent" },
];

/** Why a slice survived selection — the same enum the selector writes. */
const RETENTION_LABELS: Record<string, MessageKey> = {
  pinned: "handoffs.retention.pinned",
  recent: "handoffs.retention.recent",
  paired: "handoffs.retention.paired",
  "oversized-truncated": "handoffs.retention.oversized",
};

/** Where the budget's target context window came from (v10 §23). */
const WINDOW_SOURCE_LABELS: Record<string, MessageKey> = {
  "runtime-capability": "handoffs.window.runtime",
  "configured-model": "handoffs.window.configured",
  default: "handoffs.window.default",
};

/** Why a handoff was generated — the enum the generator records. */
const TRIGGER_LABELS: Record<string, MessageKey> = {
  explicit: "handoffs.trigger.explicit",
  targeted: "handoffs.trigger.targeted",
  continuation: "handoffs.trigger.continuation",
  harness: "handoffs.trigger.harness",
};

interface ContextSlice {
  kind: string;
  text: string;
  runId?: string;
  toolName?: string;
  provenance?: string;
  harnessWrapper?: boolean;
  outcome?: string;
  reconstructable?: boolean;
  mutationProjected?: boolean;
  retention: string;
}

interface ContextBundle {
  version: number;
  checkpoint?: string;
  frontier?: string;
  pinnedContext: ContextSlice[];
  retainedContext: ContextSlice[];
  budget: {
    contextWindow: number;
    contextWindowSource?: string;
    maxTokens: number;
    estimatedTokens: number;
    checkpointTokens: number;
    pinnedTokens: number;
    retainedTokens: number;
    frontierTokens?: number;
    metadataTokens?: number;
    userNotesTokens?: number;
    charsPerToken: number;
  };
}

/** One retained/pinned slice: what it is, why it stayed, and its text. */
function ContextSliceRow({ slice }: { slice: ContextSlice }) {
  const { t } = useI18n();
  const retention = RETENTION_LABELS[slice.retention];
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="muted">
        <span className="mono">[{slice.kind}]</span>
        {slice.toolName ? <> <span className="mono">{slice.toolName}</span></> : null}
        {" · "}
        <span title={retention ? t(retention) : slice.retention}>{slice.retention}</span>
        {slice.provenance ? (
          <> · {slice.provenance === "user-context" ? t("handoffs.slice.userContext") : t("handoffs.slice.userAuthored")}</>
        ) : null}
        {slice.harnessWrapper ? (
          <> · <span title={t("handoffs.slice.wrapper")}>{t("handoffs.slice.wrapperLabel")}</span></>
        ) : null}
        {slice.outcome ? <> · {t("handoffs.slice.outcome", { outcome: slice.outcome })}</> : null}
        {slice.mutationProjected ? <> · {t("handoffs.slice.mutation")}</> : null}
        {slice.reconstructable ? <> · {t("handoffs.slice.reconstructable")}</> : null}
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
  const { t } = useI18n();
  const b = bundle.budget;
  const tok = (n: number) => t("handoffs.bundle.tok", { n: n.toLocaleString() });
  const windowSource = WINDOW_SOURCE_LABELS[b.contextWindowSource ?? "default"];
  const rows: Array<[string, string]> = [
    [t("handoffs.bundle.window"), tok(b.contextWindow)],
    [t("handoffs.bundle.windowSource"), windowSource ? t(windowSource) : b.contextWindowSource ?? "—"],
    [t("handoffs.bundle.max"), tok(b.maxTokens)],
    [t("handoffs.bundle.estimated"), tok(b.estimatedTokens)],
    [t("handoffs.bundle.checkpoint"), tok(b.checkpointTokens)],
    [t("handoffs.bundle.pinned"), tok(b.pinnedTokens)],
    [t("handoffs.bundle.retained"), tok(b.retainedTokens)],
    [t("handoffs.bundle.frontier"), tok(b.frontierTokens ?? 0)],
    [t("handoffs.bundle.metadata"), tok(b.metadataTokens ?? 0)],
    [t("handoffs.bundle.userNotes"), tok(b.userNotesTokens ?? 0)],
    [t("handoffs.bundle.estimator"), t("handoffs.bundle.charsPerToken", { n: b.charsPerToken })],
  ];
  return (
    <>
      <h2>{t("handoffs.bundle.title")}</h2>
      <p className="sub">{t("handoffs.bundle.desc")}</p>
      <div className="card">
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", maxWidth: 460 }}>
            <span className="muted">{label}</span>
            <span className="mono">{value}</span>
          </div>
        ))}
      </div>

      {bundle.frontier && (
        <>
          <h3>{t("handoffs.bundle.frontierTitle")}</h3>
          <div className="card">
            <p className="muted" style={{ margin: "0 0 6px" }}>{t("handoffs.bundle.frontierNote")}</p>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{bundle.frontier}</pre>
          </div>
        </>
      )}

      <h3>{t("handoffs.bundle.pinnedTitle", { n: bundle.pinnedContext.length })}</h3>
      <div className="card">
        {bundle.pinnedContext.length === 0 ? (
          <div className="muted">{t("handoffs.bundle.pinnedEmpty")}</div>
        ) : (
          bundle.pinnedContext.map((s, i) => <ContextSliceRow key={i} slice={s} />)
        )}
      </div>

      <h3>{t("handoffs.bundle.retainedTitle", { n: bundle.retainedContext.length })}</h3>
      <div className="card">
        {bundle.retainedContext.length === 0 ? (
          <div className="muted">{t("handoffs.bundle.retainedEmpty")}</div>
        ) : (
          bundle.retainedContext.map((s, i) => <ContextSliceRow key={i} slice={s} />)
        )}
      </div>
    </>
  );
}

/** Where a written checkpoint's model came from (audit, not content). */
const MODEL_SOURCE_LABELS: Record<string, MessageKey> = {
  configured: "handoffs.modelSource.configured",
  "previous-run": "handoffs.modelSource.previousRun",
  "first-enabled": "handoffs.modelSource.firstEnabled",
};

function SourceBadge({ source }: { source: string }) {
  const t = useT();
  const label =
    source === "harness"
      ? t("handoffs.source.harness")
      : source === "agentfabric"
        ? t("handoffs.source.agentfabric")
        : t("handoffs.source.user");
  return <span className="badge running" title={t("handoffs.source.title", { label })}>{label}</span>;
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

interface ModelRow {
  id: string;
  providerId: string;
  name: string;
  alias?: string;
  enabled: boolean;
}

interface ProviderRow {
  id: string;
  name: string;
  enabled: boolean;
}

/** GET/PUT /api/handoffs/model — the summarizer model for handoff generation. */
interface HandoffModelConfig {
  modelId: string | null;
  modelName?: string;
  providerName?: string;
  usable?: boolean;
}

/**
 * Which model writes handoff checkpoints. An explicit choice is strict: if
 * it turns unusable (model/provider disabled or deleted), generation fails
 * loudly instead of silently using another model — the warning here says so.
 */
function HandoffModelCard() {
  const t = useT();
  const models = useAsync<ModelRow[]>(() => get("/api/models"), []);
  const providers = useAsync<ProviderRow[]>(() => get("/api/providers"), []);
  const current = useAsync<HandoffModelConfig>(() => get("/api/handoffs/model"), []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const enabledModels = (models.data ?? []).filter((m) => m.enabled);
  const providerName = (id: string) => providers.data?.find((p) => p.id === id)?.name;
  const configuredId = current.data?.modelId ?? null;
  const configuredUnavailable =
    configuredId != null && !enabledModels.some((m) => m.id === configuredId);

  const select = async (value: string) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await put("/api/handoffs/model", { modelId: value || null });
      setSaved(true);
      current.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h2>{t("handoffs.model.title")}</h2>
      <p className="sub" style={{ marginBottom: 10 }}>{t("handoffs.model.desc")}</p>
      <div className="row">
        <select
          value={configuredId ?? ""}
          disabled={saving || models.data == null || current.data == null}
          onChange={(e) => void select(e.target.value)}
          style={{ minWidth: 320 }}
        >
          <option value="">{t("handoffs.model.auto")}</option>
          {enabledModels.map((m) => (
            <option key={m.id} value={m.id}>
              {providerName(m.providerId) ?? "?"} · {m.alias || m.name}
            </option>
          ))}
          {/* A configured model that has become unusable still represents the
              stored choice — hiding it would make the select disagree with
              what generation will actually do. */}
          {configuredUnavailable && (
            <option value={configuredId}>
              {t("handoffs.model.unavailable", { name: current.data?.modelName ?? configuredId })}
            </option>
          )}
        </select>
        {saved && <span className="muted">{t("common.saved")}</span>}
        {saving && <span className="muted">{t("common.saving")}</span>}
      </div>
      {configuredUnavailable && (
        <p className="hint" style={{ color: "var(--red)" }}>{t("handoffs.model.warn")}</p>
      )}
      <ErrorBox message={error} />
    </div>
  );
}

export function HandoffsView() {
  const t = useT();
  const { data, error, reload } = useAsync<any[]>((force) => get("/api/handoffs", undefined, force), []);

  return (
    <div>
      <h1>{t("handoffs.title")}</h1>
      <p className="sub">{t("handoffs.subtitle")}</p>
      <ErrorBox message={error} />

      <HandoffModelCard />

      <div className="card">
        {data && data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>{t("handoffs.col.id")}</th><th>{t("handoffs.col.task")}</th><th>{t("handoffs.col.source")}</th>
                <th>{t("handoffs.col.created")}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((h) => (
                <tr key={h.id}>
                  <td className="mono"><a onClick={() => navigate(`/handoffs/${h.id}`)}>{shortId(h.id)}</a></td>
                  <td className="mono">{shortId(h.taskId)}</td>
                  <td><SourceBadge source={h.source} /></td>
                  <td className="muted">{fmtTime(h.createdAt)}</td>
                  <td><button className="small" onClick={() => navigate(`/handoffs/${h.id}`)}>{t("handoffs.view")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">{t("handoffs.empty")}</div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="small" onClick={reload}>{t("common.refresh")}</button>
        </div>
      </div>
    </div>
  );
}

export function HandoffDetailView({ handoffId }: { handoffId: string }) {
  const t = useT();
  const { data: detail, error } = useAsync<any>(() => get(`/api/handoffs/${handoffId}`), [handoffId]);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  if (error) return <ErrorBox message={error} />;
  if (!detail) return <div className="muted">{t("common.loading")}</div>;
  const consumedBy: string[] = detail.consumedByRunIds ?? [];
  const g = detail.generation as
    | {
        method?: string;
        trigger?: string;
        detail?: string;
        chunks?: number;
        modelName?: string;
        providerName?: string;
        modelSource?: string;
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
        <a onClick={() => navigate("/handoffs")}>{t("handoffs.detail.back")}</a>
        <a onClick={() => navigate(`/tasks/${detail.taskId}`)}>{t("handoffs.detail.thread")}</a>
        <a onClick={() => navigate(`/runs/${detail.fromRunId}`)}>{t("handoffs.detail.sourceRun")}</a>
        <span className="right">
          {(detail.sources ?? [detail.source]).map((s: string) => <SourceBadge key={s} source={s} />)}
        </span>
      </div>
      <h1 className="mono">{detail.id}</h1>
      <p className="sub">
        {t("handoffs.detail.run")} <span className="mono">{shortId(detail.fromRunId)}</span>
        {detail.workspaceId ? (
          <> · {t("handoffs.detail.workspace")} <span className="mono">{shortId(detail.workspaceId)}</span></>
        ) : null}
        {" "}· {fmtTime(detail.createdAt)}
      </p>
      <div className="row">
        {/* The exported file is the same rendered body shown below — a pure
            download of what the record already carries, nothing re-rendered. */}
        <button
          className="small"
          onClick={() => downloadMarkdown(`handoff-${shortId(detail.id)}.md`, detail.renderedPrompt)}
        >
          {t("handoffs.detail.export")}
        </button>
        {/* Same rendered body the export downloads and the card below shows —
            copying it hands the next agent exactly what this record carries. */}
        <CopyButton
          label={t("handoffs.detail.copy")}
          text={detail.renderedPrompt}
          title={t("handoffs.detail.copyTip")}
        />
        {/* Wrong context is discarded, never repaired in place: a handoff is
            whatever the model produced at generation time, so a bad one is
            deleted and regenerated from the task thread (AGENTS.md). Destructive,
            so it lives alone on the right behind an explicit confirmation. */}
        <button
          className="small danger-prominent right"
          onClick={() => setConfirmingDiscard(true)}
        >
          {t("handoffs.discard")}
        </button>
      </div>
      {confirmingDiscard && (
        <Modal title={t("handoffs.discard")} onClose={() => setConfirmingDiscard(false)}>
          <div className="delete-confirm">
            <p className="delete-confirm-question">
              {t("handoffs.discard.question", { id: detail.id })}
            </p>
            <p className="muted">{t("handoffs.discard.body")}</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmingDiscard(false)}>{t("common.cancel")}</button>
              <button
                className="danger"
                onClick={async () => {
                  setConfirmingDiscard(false);
                  await del(`/api/handoffs/${detail.id}`);
                  navigate("/handoffs");
                }}
              >
                {t("handoffs.discard")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {degraded && (
        <div className="card handoff-degraded-card">
          <b>{t("handoffs.degraded.title")}</b>{" "}
          {g?.detail ?? t("handoffs.degraded.modelMissing")}{" "}
          {t("handoffs.degraded.body")}
        </div>
      )}

      {/* How this context was produced — written once at generation and
          carried by the record, with the same facts riding the
          `handoff.generated` event so the task timeline shows identical
          provenance where it happened. */}
      <h2>{t("handoffs.gen.title")}</h2>
      <div className="card">
        <AuditRow label={t("handoffs.gen.trigger")}>
          {g?.trigger ? (
            <>
              <span className="mono">{g.trigger}</span>{" "}
              <span className="muted">
                — {TRIGGER_LABELS[g.trigger] ? t(TRIGGER_LABELS[g.trigger]) : t("handoffs.gen.triggerFallback")}
              </span>
            </>
          ) : (
            <span className="muted">{t("handoffs.gen.triggerMissing")}</span>
          )}
        </AuditRow>
        <AuditRow label={t("handoffs.gen.method")}>
          <span className="mono">{g?.method ?? t("handoffs.gen.methodUnknown")}</span>
          {g?.chunks && g.chunks > 1 ? (
            <span className="muted"> · {t("handoffs.gen.chunks", { n: g.chunks })}</span>
          ) : null}
        </AuditRow>
        <AuditRow label={t("handoffs.gen.writtenBy")}>
          {writtenBy ? (
            <>
              <span className="mono">{writtenBy}</span>
              {g?.modelSource ? (
                <span className="muted">
                  {" · "}
                  {MODEL_SOURCE_LABELS[g.modelSource] ? t(MODEL_SOURCE_LABELS[g.modelSource]) : g.modelSource}
                </span>
              ) : null}
            </>
          ) : (
            <span className="muted">
              {t("handoffs.gen.noModel")}{" "}
              {g?.method === "harness"
                ? t("handoffs.gen.noModel.harness")
                : g?.method === "context-bundle"
                  ? t("handoffs.gen.noModel.bundle")
                  : t("handoffs.gen.noModel.digest")}
            </span>
          )}
        </AuditRow>
        <AuditRow label={t("handoffs.gen.covers")}>
          {covered.length > 0 ? (
            <>
              {covered.map((id, i) => (
                <span key={id}>
                  {i > 0 ? ", " : ""}
                  <a className="mono" onClick={() => navigate(`/runs/${id}`)}>{shortId(id)} ↗</a>
                </span>
              ))}{" "}
              <span className="muted">— {t("handoffs.gen.coversNote")}</span>
            </>
          ) : (
            <span className="muted">{t("handoffs.gen.coversNone")}</span>
          )}
        </AuditRow>
        {(g?.durationMs || tokens > 0) && (
          <AuditRow label={t("handoffs.gen.cost")}>
            {g?.durationMs ? <>{g.durationMs} ms</> : null}
            {g?.durationMs && tokens > 0 ? <span className="muted"> · </span> : null}
            {tokens > 0 ? <>{tokens.toLocaleString()} tok</> : null}
          </AuditRow>
        )}
      </div>

      {bundle && <ContextBundleCard bundle={bundle} />}

      <h2>{t("handoffs.rendered.title")}</h2>
      <div className="card">
        <pre style={{ whiteSpace: "pre-wrap", maxHeight: "none" }}>{detail.renderedPrompt}</pre>
        <p className="muted" style={{ margin: "10px 0 0" }}>
          {consumedBy.length > 0 ? (
            <>
              {t("handoffs.rendered.consumed", {
                runs: consumedBy.map((id: string) => shortId(id)).join(", "),
              })}{" "}
              {t("handoffs.rendered.consumedTail")}
            </>
          ) : detail.awaitingNextTurn ? (
            <>{t("handoffs.rendered.armed")}</>
          ) : (
            <>{t("handoffs.rendered.pending")}</>
          )}
        </p>
      </div>

      <h2>{t("handoffs.fields.title")}</h2>
      <p className="sub">{t("handoffs.fields.desc")}</p>
      <div className="card">
        {CONTENT_SECTIONS.map(({ key, label }) => (
          <HandoffSection key={key} label={t(label)} value={(detail.content ?? {})[key]} />
        ))}
        {detail.userNotes && <HandoffSection label={t("handoffs.field.userNotes")} value={detail.userNotes} />}
      </div>
    </div>
  );
}
