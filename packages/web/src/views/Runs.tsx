import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, post, fmtTime, fmtCost, shortId, subscribeSSE } from "../api";
import { StatusBadge, useMinuteClock, useAsync, ErrorBox, CopyButton, Pager, usePolling } from "../components";
import { useI18n } from "../i18n-react";
import { navigate } from "../router";

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

export function RunsView() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useAsync<any[]>((force) => get("/api/runs", undefined, force), []);
  // Runs accumulate one per execution: page them, for the same reason the task
  // list is paged (flat DOM and re-render cost).
  const [page, setPage] = useState(0);
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
  const pageCount = Math.max(1, Math.ceil((data?.length ?? 0) / RUNS_PAGE_SIZE));
  // Clamped: a refresh can shrink the list (a run deleted elsewhere) while the
  // view is on the last page, which would otherwise show an empty table.
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = (data ?? []).slice(currentPage * RUNS_PAGE_SIZE, (currentPage + 1) * RUNS_PAGE_SIZE);
  return (
    <div>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>{t("runs.title")}</h1>
        <span className="right"><button className="small" onClick={reloadAll}>{t("common.refresh")}</button></span>
      </div>
      <p className="sub">
        {t("runs.subtitle")} 
        <a onClick={() => navigate("/tasks")}>{t("runs.subtitle.threadLink")}</a>
        {"。"}
      </p>
      <ErrorBox message={actionError ?? error} />
      {data && data.length > 0 ? (
      <div className="card">
          <table>
            <thead>
              <tr>
                <th>{t("runs.col.run")}</th><th>{t("runs.col.task")}</th><th>{t("runs.col.status")}</th>
                <th>{t("runs.col.runtime")}</th><th>{t("runs.col.continuity")}</th><th>{t("runs.col.model")}</th>
                <th>{t("runs.col.cost")}</th><th>{t("runs.col.created")}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r: any) => {
                const sessionRef = r.runtimeSessionRefId ? sessionById.get(r.runtimeSessionRefId) : undefined;
                const resumeCmd = sessionRef && NATIVE_RESUME_CMD[sessionRef.runtimeKind];
                return (
                <tr key={r.id}>
                  <td className="mono"><a onClick={() => navigate(`/runs/${r.id}`)}>{shortId(r.id)}</a></td>
                  <td><a onClick={() => navigate(`/tasks/${r.taskId}`)}>{r.taskTitle}</a></td>
                  <td><StatusBadge status={r.status} /></td>
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
          <Pager page={currentPage} pageCount={pageCount} total={data?.length ?? 0} pageSize={RUNS_PAGE_SIZE} onChange={setPage} />
      </div>
      ) : (
        <div className="card muted">{loading ? t("common.loading") : t("runs.empty")}</div>
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
        <a onClick={() => navigate("/runs")}>{t("runs.detail.back")}</a>
        <a onClick={() => navigate(`/tasks/${run.taskId}`)}>{t("runs.detail.thread")}</a>
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
        <a onClick={() => navigate(`/tasks/${run.taskId}`)}>{t("runs.subtitle.threadLink")}</a>
        {t("runs.detail.inspectorTail")}
      </p>

      <div className="grid">
        <div className="stat"><div className="num"><StatusBadge status={run.status} /></div><div className="lbl">{t("runs.stat.status")}</div></div>
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

      {run.error && <ErrorBox message={String(run.error)} />}

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
            <table>
              <thead>
                <tr>
                  <th>{t("runs.artifacts.name")}</th><th>{t("runs.artifacts.kind")}</th>
                  <th>{t("runs.artifacts.size")}</th><th>{t("runs.artifacts.id")}</th>
                </tr>
              </thead>
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
        {tab === "continuity" && (
          <div>
            <p className="sub">{t("runs.continuity.how", { label: continuity })}</p>
            {previousHandoff && (
              <>
                <h2 style={{ marginTop: 14 }}>{t("runs.continuity.consumed")}</h2>
                <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(previousHandoff.content, null, 2)}</pre>
              </>
            )}
            {generatedHandoff && (
              <>
                <h2 style={{ marginTop: 14 }}>{t("runs.continuity.generated")}</h2>
                <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(generatedHandoff.content, null, 2)}</pre>
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
    </div>
  );
}

/** `label: value` lines aligned in two columns, for the inspector's raw blocks. */
function rawLines(t: ReturnType<typeof useI18n>["t"], rows: Array<[Parameters<typeof t>[0], string]>): string {
  const width = Math.max(...rows.map(([key]) => t(key).length));
  return rows.map(([key, value]) => `${t(key).padEnd(width)} : ${value}`).join("\n");
}
