import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, post, fmtTime, fmtCost, shortId, subscribeSSE } from "../api";
import { StatusBadge, useMinuteClock, useAsync, ErrorBox, CopyButton, Modal, Pager, usePolling, AppLink } from "../components";
import { phaseLabel } from "../i18n";
import { useI18n } from "../i18n-react";
import { navigate } from "../router";
import { RUNS_CHANGED_EVENT, onAppEvent, notifyRunsChanged } from "../appEvents";

/** How each harness resumes a native session by id (matches runtimes' buildArgs). */
const NATIVE_RESUME_CMD: Record<string, string> = {
  "claude-code": "claude --resume <id>",
  codex: "codex exec resume <id>",
  pi: "pi --session <id>",
  opencode: "opencode --session <id>",
};

/**
 * Runs (v5 §33): the operations / run-history view. Users create Tasks,
 * not Runs — creation lives in New task; this page lists every execution
 * for inspection and operations (cancel / open inspector).
 */
/** Rows per page: one row per execution, and executions accumulate. */
const RUNS_PAGE_SIZE = 50;

/**
 * The status groups the list can be narrowed to.
 *
 * Executions accumulate for the life of the install, so "where is the run I
 * just started" and "what failed last night" — the two questions this page
 * exists to answer — otherwise mean scrolling past hundreds of finished rows.
 * The groups are coarse on purpose: they follow what a person is looking for,
 * not the record's exact status value.
 */
const STATUS_FILTERS = ["all", "active", "failed", "completed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** A run counts as active while it can still move: the same set Cancel offers for. */
const ACTIVE_STATUSES = ["pending", "starting", "running"];

function matchesFilter(run: any, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return ACTIVE_STATUSES.includes(run.status);
  if (filter === "failed") return run.status === "failed" || run.status === "timeout";
  return run.status === "completed";
}

export function RunsView() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useAsync<any[]>((force) => get("/api/runs", undefined, force), []);
  // A run started, cancelled or finished elsewhere: read again now instead of
  // waiting for the next poll (which only runs while something is active).
  useEffect(() => onAppEvent(RUNS_CHANGED_EVENT, reload), [reload]);
  // Runs accumulate one per execution: page them, for the same reason the task
  // list is paged (flat DOM and re-render cost).
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>("all");
  // Cancel in flight per run, and the last failure. A cancel that fails used to
  // be an unhandled rejection: the row simply stayed there with nothing said.
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const cancelRun = async (runId: string) => {
    if (cancelling[runId]) return;
    setCancelling((prev) => ({ ...prev, [runId]: true }));
    setActionError(null);
    try {
      await post(`/api/runs/${runId}/cancel`);
      notifyRunsChanged({ runId });
      reloadAll();
    } catch (e) {
      setActionError(t("runs.cancelFailed", { id: runId, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCancelling((prev) => ({ ...prev, [runId]: false }));
    }
  };
  // "3m ago" labels move on their own (see `useMinuteClock`).
  useMinuteClock();
  const { data: sessionRefs, reload: reloadSessions } = useAsync<any[]>((force) => get("/api/runtime-sessions", undefined, force), []);
  const sessionById = useMemo(
    () => new Map((sessionRefs ?? []).map((s) => [s.id as string, s])),
    [sessionRefs]
  );
  const reloadAll = () => { reload(); reloadSessions(); };
  // A run's status and phase move while it executes. The Board and the task
  // lifecycle both refresh on their own; this list used to sit still until the
  // user pressed Refresh, so a starting run looked stuck at "starting".
  const activeCount = (data ?? []).filter((r: any) => ACTIVE_STATUSES.includes(r.status)).length;
  usePolling(reloadAll, 3000, activeCount > 0);
  const filtered = (data ?? []).filter((r: any) => matchesFilter(r, filter));
  const pageCount = Math.max(1, Math.ceil(filtered.length / RUNS_PAGE_SIZE));
  // Clamped: a refresh can shrink the list (a run deleted elsewhere) while the
  // view is on the last page, which would otherwise show an empty table.
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(currentPage * RUNS_PAGE_SIZE, (currentPage + 1) * RUNS_PAGE_SIZE);
  return (
    <div>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>{t("runs.title")}</h1>
        <span className="right"><button className="small" onClick={reloadAll}>{t("common.refresh")}</button></span>
      </div>
      <p className="sub">
        {t("runs.subtitle")} 
        <AppLink href={"/tasks"}>{t("runs.subtitle.threadLink")}</AppLink>
        {"。"}
      </p>
      <ErrorBox message={actionError ?? error} />
      <div className="runs-filters" role="group" aria-label={t("runs.filterLabel")}>
        {STATUS_FILTERS.map((option) => {
          const count =
            option === "all"
              ? (data?.length ?? 0)
              : (data ?? []).filter((r: any) => matchesFilter(r, option)).length;
          return (
            <button
              key={option}
              className={`runs-filter ${filter === option ? "active" : ""}`}
              aria-pressed={filter === option}
              onClick={() => {
                setFilter(option);
                setPage(0);
              }}
            >
              {t(`runs.filter.${option}` as Parameters<typeof t>[0])}
              <span className="runs-filter-count">{count}</span>
            </button>
          );
        })}
        {activeCount > 0 && <span className="runs-live">{t("runs.live", { n: activeCount })}</span>}
      </div>
      {data && data.length > 0 ? (
      <div className="card">
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("runs.col.run")}</th><th scope="col">{t("runs.col.task")}</th><th scope="col">{t("runs.col.status")}</th>
                <th scope="col">{t("runs.col.phase")}</th>
                <th scope="col">{t("runs.col.runtime")}</th><th scope="col">{t("runs.col.continuity")}</th><th scope="col">{t("runs.col.model")}</th>
                <th scope="col">{t("runs.col.cost")}</th><th scope="col">{t("runs.col.created")}</th><th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r: any) => {
                const sessionRef = r.runtimeSessionRefId ? sessionById.get(r.runtimeSessionRefId) : undefined;
                const resumeCmd = sessionRef && NATIVE_RESUME_CMD[sessionRef.runtimeKind];
                return (
                <tr key={r.id}>
                  <td className="mono"><AppLink href={`/runs/${r.id}`}>{shortId(r.id)}</AppLink></td>
                  <td><AppLink href={`/tasks/${r.taskId}`}>{r.taskTitle}</AppLink></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="muted">{phaseLabel(t, r.phase)}</td>
                  <td>{r.runtimeName ?? "-"}</td>
                  <td className="muted">{continuityLabel(t, r.continuity ?? "new")}</td>
                  <td>{r.modelName ?? "-"}</td>
                  <td>{fmtCost(r.cost)}</td>
                  <td className="muted">{fmtTime(r.createdAt)}</td>
                  <td>
                    {sessionRef && (
                      <CopyButton
                        label={t("runs.copySessionId")}
                        text={sessionRef.nativeSessionRef}
                        title={
                          t("runs.sessionTip", { ref: sessionRef.nativeSessionRef, kind: sessionRef.runtimeKind }) +
                          (resumeCmd
                            ? `\n${t("runs.sessionTip.resume", { cmd: resumeCmd.replace("<id>", sessionRef.nativeSessionRef) })}`
                            : "")
                        }
                      />
                    )}{" "}
                    {["pending", "starting", "running"].includes(r.status) && (
                      <button
                        className="small danger"
                        disabled={Boolean(cancelling[r.id])}
                        onClick={() => void cancelRun(r.id)}
                      >
                        {cancelling[r.id] ? t("runs.cancelling") : t("runs.cancel")}
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {pageRows.length === 0 && (
            <div className="muted table-empty-hint">{t("runs.emptyFilter")}</div>
          )}
          <Pager page={currentPage} pageCount={pageCount} total={filtered.length} pageSize={RUNS_PAGE_SIZE} onChange={setPage} />
      </div>
      ) : (
        <div className="card muted">
          {loading
            ? t("common.loading")
            : (data?.length ?? 0) > 0
              ? // Rows exist, this filter just matches none of them: saying "no
                // runs yet" here would be false.
                t("runs.emptyFilter")
              : (
                  <>
                    {t("runs.empty")}{" "}
                    <AppLink href="/tasks">{t("runs.empty.link")}</AppLink>
                  </>
                )}
        </div>
      )}
    </div>
  );
}

/** "new" / "resume" / "handoff" → its label; anything else is shown as-is. */
function continuityLabel(t: ReturnType<typeof useI18n>["t"], continuity: string): string {
  if (continuity === "new") return t("runs.continuity.new");
  if (continuity === "resume") return t("runs.continuity.resume");
  if (continuity === "handoff") return t("runs.continuity.handoff");
  return continuity;
}

/** Container lifecycle mode: known modes are translated, anything else as-is. */
function lifecycleLabel(t: ReturnType<typeof useI18n>["t"], mode?: string): string {
  if (!mode || mode === "ephemeral") return t("runs.lifecycle.ephemeral");
  if (mode === "persistent") return t("runs.lifecycle.persistent");
  return mode;
}

/**
 * Run Inspector (v5 §12/§13): the advanced execution-detail, debugging
 * and audit page for a single Run — raw events, logs, artifacts, usage,
 * runtime session, native state, handoff and the full input instruction.
 * It is deliberately NOT the user's primary interaction surface.
 */
export function RunDetailView({ runId }: { runId: string }) {
  const { t } = useI18n();
  const { data: run, error, reload } = useAsync<any>((force) => get(`/api/runs/${runId}`, undefined, force), [runId]);
  const [events, setEvents] = useState<any[]>([]);
  // Same reasoning as the list page: a cancel that fails must say so, and a
  // second click while the first is in flight must not start another request.
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<"events" | "logs" | "artifacts" | "continuity">("events");
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [previousHandoff, setPreviousHandoff] = useState<any>(null);
  const [generatedHandoff, setGeneratedHandoff] = useState<any>(null);
  const [sessionRef, setSessionRef] = useState<any>(null);
  const [nativeState, setNativeState] = useState<any>(null);
  // The artifact whose inline content is open in a dialog.
  const [previewArtifact, setPreviewArtifact] = useState<any | null>(null);

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

  // Continuity detail: handoffs, native session reference, native state.
  // Guarded against stale responses: switching runs quickly would otherwise
  // let the previous run's slower fetch resolve last and overwrite the newly
  // selected run's continuity data.
  useEffect(() => {
    let alive = true;
    const set = <T,>(setter: (v: T | null) => void, id: string | undefined, path: string) => {
      if (!id) {
        setter(null);
        return;
      }
      get<T>(`${path}/${id}`)
        .then((v) => alive && setter(v))
        .catch(() => {});
    };
    set(setPreviousHandoff, run?.previousHandoffId, "/api/handoffs");
    set(setGeneratedHandoff, run?.generatedHandoffId, "/api/handoffs");
    set(setSessionRef, run?.runtimeSessionRefId, "/api/runtime-sessions");
    set(setNativeState, run?.nativeStateId, "/api/native-states");
    return () => {
      alive = false;
    };
  }, [run?.previousHandoffId, run?.generatedHandoffId, run?.runtimeSessionRefId, run?.nativeStateId]);

  // Watch for a terminal status change while the run is live — only while the
  // window is visible: a run detail left open in the background does not need
  // a request every three seconds.
  const statusRef = useRef<string | undefined>(run?.status);
  statusRef.current = run?.status;
  const pollStatus = useCallback(() => {
    get<any>(`/api/runs/${runId}`, undefined, true)
      .then((r) => {
        if (r.status !== statusRef.current) reload();
      })
      .catch(() => {});
  }, [runId, reload]);
  usePolling(pollStatus, 3000, Boolean(run));

  if (error) return <ErrorBox message={error} />;
  if (!run) return <div className="muted">{t("common.loading")}</div>;
  // Declared after the early returns so the block below can render it. A failed
  // cancel is not a load error: the run is still there and still yours to read.

  const isLive = ["pending", "starting", "running"].includes(run.status);
  const logs = events
    .filter((e) => ["log", "shell.output", "agent.message"].includes(e.type))
    .map((e) => {
      const line = e.data?.line ?? e.data?.message ?? e.data?.text ?? e.data?.content ?? "";
      const prefix = e.type === "agent.message" ? "[agent] " : e.type === "shell.output" ? "[shell] " : "";
      return prefix + line;
    })
    .filter((l) => l !== "");

  const continuity = continuityLabel(t, run.continuity ?? "new");
  const purpose =
    run.purpose === "validation"
      ? t("runs.purpose.validation")
      : run.purpose === "rework"
        ? t("runs.purpose.rework")
        : t("runs.purpose.development");

  return (
    <div>
      {actionError && <ErrorBox message={actionError} />}
      <div className="row">
        <AppLink href={"/runs"}>{t("runs.detail.back")}</AppLink>
        <AppLink href={`/tasks/${run.taskId}`}>{t("runs.detail.thread")}</AppLink>
        <span className="right">
          {isLive && (
            <button
              className="danger"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                setActionError(null);
                try {
                  await post(`/api/runs/${runId}/cancel`);
                  notifyRunsChanged({ runId });
                  reload();
                } catch (e) {
                  setActionError(t("runs.cancelFailed", { id: runId, error: e instanceof Error ? e.message : String(e) }));
                } finally {
                  setCancelling(false);
                }
              }}
            >
              {cancelling ? t("runs.cancelling") : t("runs.cancel")}
            </button>
          )}
          {" "}
          <button className="small" onClick={reload}>{t("common.refresh")}</button>
        </span>
      </div>
      <h1 className="mono">{runId}</h1>
      <p className="sub">
        <strong>{t("runs.detail.inspector")}</strong>{" "}
        <AppLink href={`/tasks/${run.taskId}`}>{t("runs.subtitle.threadLink")}</AppLink>
        {t("runs.detail.inspectorTail")}
      </p>

      <div className="grid">
        <div className="stat"><div className="num"><StatusBadge status={run.status} /></div><div className="lbl">{t("runs.stat.status")}</div></div>
        {/* The inspector is where "what is it doing right now" gets answered:
            status is the coarse verdict, the phase is the step it is on. It was
            missing here entirely while the task page had it. */}
        <div className="stat"><div className="num">{phaseLabel(t, run.phase)}</div><div className="lbl">{t("runs.stat.phase")}</div></div>
        <div className="stat">
          <div className="num">
            {purpose}
            {run.round ? ` · r${run.round}` : ""}
          </div>
          <div className="lbl">{t("runs.stat.purpose")}</div>
        </div>
        <div className="stat"><div className="num">{run.runtimeName ?? "-"}</div><div className="lbl">{t("runs.stat.runtime")}</div></div>
        <div className="stat"><div className="num">{run.modelName ?? "-"}</div><div className="lbl">{t("runs.stat.model")}</div></div>
        <div className="stat"><div className="num">{continuity}</div><div className="lbl">{t("runs.stat.continuity")}</div></div>
        <div className="stat"><div className="num">{lifecycleLabel(t, run.lifecycle?.mode)}</div><div className="lbl">{t("runs.stat.lifecycle")}</div></div>
        <div className="stat"><div className="num">{fmtCost(run.cost)}</div><div className="lbl">{t("runs.stat.cost")}</div></div>
        <div className="stat"><div className="num">{(run.usage?.modelRequests ?? 0)}</div><div className="lbl">{t("runs.stat.modelCalls")}</div></div>
        <div className="stat"><div className="num">{(run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0)}</div><div className="lbl">{t("runs.stat.tokens")}</div></div>
      </div>

      {/* Full harness instruction — inspector-only (v5 §5/§12). */}
      <details className="card instruction-details">
        <summary>{t("runs.instruction.summary", { n: (run.inputInstruction ?? "").length })}</summary>
        <p className="muted" style={{ margin: "8px 0" }}>
          {t("runs.instruction.note")}
        </p>
        {run.userPrompt && (
          <p style={{ margin: "0 0 8px" }}><span className="muted">{t("runs.instruction.userPrompt")}</span>{run.userPrompt}</p>
        )}
        <pre style={{ whiteSpace: "pre-wrap" }}>{run.inputInstruction ?? run.taskTitle}</pre>
      </details>

      {(previousHandoff || generatedHandoff || sessionRef || nativeState || run.workspaceId) && (
        <div className="card">
          <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
            {run.workspaceId && (
              <span title={run.workspaceId}>{t("runs.refs.workspace", { id: shortId(run.workspaceId) })}</span>
            )}
            {previousHandoff && (
              <span>{t("runs.refs.consumedHandoff", { id: shortId(previousHandoff.id) })}</span>
            )}
            {generatedHandoff && (
              <span>{t("runs.refs.generatedHandoff", { id: shortId(generatedHandoff.id), source: generatedHandoff.source })}</span>
            )}
            {sessionRef && (
              <span>
                {t("runs.refs.nativeSession", { ref: sessionRef.nativeSessionRef })}{" "}
                <CopyButton
                  label={t("common.copy")}
                  text={sessionRef.nativeSessionRef}
                  title={
                    NATIVE_RESUME_CMD[sessionRef.runtimeKind]
                      ? t("runs.copyNativeSession.resume", { cmd: NATIVE_RESUME_CMD[sessionRef.runtimeKind] })
                      : t("runs.copyNativeSession")
                  }
                />{" "}
                <span className="muted">
                  ({sessionRef.runtimeKind}
                  {sessionRef.runtimeVersion ? ` ${sessionRef.runtimeVersion}` : ""}
                  {sessionRef.executionBackend ? `, ${sessionRef.executionBackend}` : ""}
                  {sessionRef.resumeSupported ? `, ${t("runs.refs.runtimeMeta.resumable")}` : ""})
                </span>
              </span>
            )}
            {nativeState && (
              <span>{t("runs.refs.nativeState", { id: shortId(nativeState.id), path: nativeState.mountPath })}</span>
            )}
          </div>
        </div>
      )}

      {/* A failed run's reason is the first thing this page is opened for. It
          used to be a bare string in the same red box every other error uses;
          now it names what happened and puts the two places that explain it one
          click away, instead of making the reader hunt through the tabs. */}
      {run.error && (
        <div className="card run-error">
          <div className="run-error-title">{t("runs.error.title")}</div>
          <pre className="run-error-body">{String(run.error)}</pre>
          <div className="run-error-actions">
            <button className="small" onClick={() => setTab("logs")}>
              {t("runs.error.openLogs")}
            </button>
            <button className="small" onClick={() => setTab("events")}>
              {t("runs.error.openEvents")}
            </button>
          </div>
        </div>
      )}

      <div className="row" style={{ margin: "16px 0" }}>
        {(["events", "logs", "artifacts", "continuity"] as const).map((entry) => (
          <button key={entry} className={tab === entry ? "primary" : ""} onClick={() => setTab(entry)}>
            {t(`runs.tab.${entry}` as const)}
            {entry === "events" ? ` (${events.length})` : entry === "artifacts" ? ` (${artifacts.length})` : ""}
          </button>
        ))}
      </div>

      <div className="card">
        {tab === "events" && (
          <div style={{ maxHeight: 520, overflow: "auto" }}>
            {events.length === 0 && <div className="muted">{t("runs.events.empty")}</div>}
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
          <pre>{logs.length ? logs.join("\n") : t("runs.logs.empty")}</pre>
        )}
        {tab === "artifacts" && (
          <div>
            {artifacts.length === 0 && <div className="muted">{t("runs.artifacts.empty")}</div>}
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("runs.artifacts.name")}</th><th scope="col">{t("runs.artifacts.kind")}</th>
                  <th scope="col">{t("runs.artifacts.size")}</th><th scope="col">{t("runs.artifacts.id")}</th><th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.name}</td>
                    <td>
                      {a.kind}
                      {!a.content && a.path && <div className="muted">{t("runs.artifacts.onDisk")}</div>}
                    </td>
                    <td>{a.size ?? "-"}</td>
                    <td className="mono">{a.id}</td>
                    <td>
                      {a.content != null ? (
                        <>
                          <button className="small" onClick={() => setPreviewArtifact(a)}>
                            {t("runs.artifacts.open")}
                          </button>{" "}
                          <a
                            className="small"
                            href={`/api/artifacts/${encodeURIComponent(a.id)}/content`}
                            download={a.name}
                          >
                            {t("runs.artifacts.download")}
                          </a>
                        </>
                      ) : (
                        <span className="muted" title={a.path ?? ""}>{a.path ?? "-"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
        {tab === "continuity" && (
          <div>
            <p className="sub">{t("runs.continuity.how", { label: continuity })}</p>
            {previousHandoff && (
              <>
                <h2 style={{ marginTop: 14 }}>{t("runs.continuity.consumed")}</h2>
                <HandoffBody content={previousHandoff.content} />
              </>
            )}
            {generatedHandoff && (
              <>
                <h2 style={{ marginTop: 14 }}>{t("runs.continuity.generated")}</h2>
                <HandoffBody content={generatedHandoff.content} />
              </>
            )}
            {sessionRef && (
              <>
                <h2 style={{ marginTop: 14 }}>{t("runs.continuity.sessionRef")}</h2>
                <pre style={{ whiteSpace: "pre-wrap" }}>
{rawLines(t, [
  ["runs.raw.harnessType", sessionRef.runtimeKind],
  ["runs.raw.ref", sessionRef.nativeSessionRef],
  ["runs.raw.runtimeVersion", sessionRef.runtimeVersion ?? "-"],
  ["runs.raw.resume", sessionRef.resumeSupported ? t("runs.raw.resume.yes") : t("runs.raw.resume.no")],
  ["runs.raw.backend", sessionRef.executionBackend ?? "-"],
  ["runs.raw.createdBy", sessionRef.runId],
  ["runs.raw.status", sessionRef.status],
])}
                </pre>
                <p className="muted">{t("runs.continuity.sessionRef.note")}</p>
              </>
            )}
            {nativeState && (
              <>
                <h2 style={{ marginTop: 14 }}>{t("runs.continuity.nativeState")}</h2>
                <pre style={{ whiteSpace: "pre-wrap" }}>
{rawLines(t, [
  ["runs.raw.stateId", nativeState.id],
  ["runs.raw.runtime", `${nativeState.runtimeKind} (${nativeState.runtimeId})`],
  ["runs.raw.hostPath", nativeState.path],
  ["runs.raw.mountedAt", nativeState.mountPath],
  ["runs.raw.lastUsedBy", nativeState.lastUsedRunId ?? "-"],
  ["runs.raw.lastUsedAt", nativeState.lastUsedAt ?? "-"],
])}
                </pre>
                <p className="muted">{t("runs.continuity.nativeState.note")}</p>
              </>
            )}
            {!previousHandoff && !generatedHandoff && !sessionRef && !nativeState && (
              <div className="muted">{t("runs.continuity.empty")}</div>
            )}
          </div>
        )}
      </div>

      {previewArtifact && (
        <Modal title={previewArtifact.name} onClose={() => setPreviewArtifact(null)}>
          <p className="muted" style={{ margin: "0 0 8px" }}>
            {t("runs.artifacts.preview")} · {previewArtifact.kind}
            {previewArtifact.mime ? ` · ${previewArtifact.mime}` : ""}
          </p>
          <pre className="artifact-preview" style={{ whiteSpace: "pre-wrap" }}>
            {String(previewArtifact.content)}
          </pre>
        </Modal>
      )}
    </div>
  );
}

/**
 * A handoff's content, shown as the three things it carries instead of as the
 * JSON the record is stored in: the summary the reader is looking for, the
 * context bundle's checkpoint sections, and every other field folded away.
 *
 * The content is projected exactly once, when the handoff is generated (see
 * AGENTS.md); this only chooses how to display what is already there, and falls
 * back to the raw JSON for a record whose shape it does not recognise.
 */
function HandoffBody({ content }: { content: unknown }) {
  const { t } = useI18n();
  if (content == null) return <div className="muted">-</div>;
  if (typeof content === "string") return <pre style={{ whiteSpace: "pre-wrap" }}>{content}</pre>;
  if (typeof content !== "object") return <pre style={{ whiteSpace: "pre-wrap" }}>{String(content)}</pre>;
  const record = content as Record<string, any>;
  const summary: string | undefined =
    typeof record.summary === "string"
      ? record.summary
      : typeof record.summary?.summary === "string"
        ? record.summary.summary
        : undefined;
  const checkpoint: string | undefined =
    record.contextBundle?.checkpoint ?? record.checkpoint ?? undefined;
  const sections = checkpoint ? splitCheckpoint(checkpoint) : [];
  const rest = { ...record };
  delete rest.summary;
  delete rest.contextBundle;
  if (record.checkpoint) delete rest.checkpoint;
  const hasRest = Object.keys(rest).length > 0;
  return (
    <div className="handoff-body">
      {summary && (
        <section>
          <h3>{t("runs.handoff.summary")}</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{summary}</p>
        </section>
      )}
      {sections.map((section) => (
        <section key={section.title}>
          <h3>{section.title}</h3>
          <pre style={{ whiteSpace: "pre-wrap" }}>{section.body}</pre>
        </section>
      ))}
      {(hasRest || !summary) && (
        <details>
          <summary>{t("runs.handoff.raw")}</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(content, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * A checkpoint is Markdown whose `## Heading` lines are its sections. Splitting
 * on them is display only: the text of each section is shown verbatim, never
 * re-summarised or re-ordered.
 */
function splitCheckpoint(checkpoint: string): Array<{ title: string; body: string }> {
  const lines = checkpoint.split("\n");
  const out: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line.trim());
    if (heading) {
      if (current && (current.body.length > 0 || current.title)) {
        out.push({ title: current.title, body: current.body.join("\n").trim() });
      }
      current = { title: heading[1]!.trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) out.push({ title: current.title, body: current.body.join("\n").trim() });
  return out.filter((section) => section.title || section.body);
}

/** `label: value` lines aligned in two columns, for the inspector's raw blocks. */
function rawLines(t: ReturnType<typeof useI18n>["t"], rows: Array<[Parameters<typeof t>[0], string]>): string {
  const width = Math.max(...rows.map(([key]) => t(key).length));
  return rows.map(([key, value]) => `${t(key).padEnd(width)} : ${value}`).join("\n");
}
