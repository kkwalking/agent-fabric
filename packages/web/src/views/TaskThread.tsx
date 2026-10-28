import { useEffect, useMemo, useRef, useState } from "react";
import { get, post, subscribeSSE, fmtCostShort, fmtDuration, fmtTime, fmtTokens, ApiError } from "../api";
import { ErrorBox, Icon, Modal, StatusBadge, useAsync } from "../components";
import { AcpChat } from "../components/AcpChat";
import { BoardTerminal } from "../components/BoardTerminal";
import { Markdown } from "../markdown";
import {
  modelLabel,
  modelOptionLabel,
  projectTimeline,
  type AgentMessageItem,
  type CommandActivity,
  type ErrorItem,
  type FileActivity,
  type HandoffActivity,
  type RawEvent,
  type ThinkingItem,
  type TimelineItem,
  type ToolActivity,
} from "../presentation";
import { statusLabel, type MessageKey } from "../i18n";
import { useT } from "../i18n-react";
import { navigate } from "../router";

/**
 * Task Thread (v5 §2/§3): the primary interaction surface.
 *
 * Task + Runs + User Prompts + Agent Events, projected into a
 * conversation — this is a *presentation* of existing records, not a new
 * chat/session domain model (v5 §34/§35). Users operate Tasks; the
 * system executes Runs. Run detail stays a debug surface (Run Inspector,
 * reached from the Runs page or a failure card) — normal turns never
 * advertise it.
 */

const LIVE_STATUSES = new Set(["pending", "starting", "running"]);
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled", "run.timeout"]);
/** Handoff triggers the timeline knows how to label (see `thread.handoffTrigger.*`). */
const TRIGGER_KEYS = ["explicit", "targeted", "continuation", "harness"];

interface ThreadTurn {
  run: any;
  events: RawEvent[];
  artifacts: any[];
  previousHandoff: any;
}

interface ThreadData {
  task: any;
  workspace: any | null;
  /** Explicitly requested handoff waiting in the thread — the next turn (any harness) consumes it. */
  pendingHandoff: any | null;
  runs: ThreadTurn[];
}

/**
 * Optimistic handoff marker shown in the timeline. It appears the moment the
 * user confirms handoff generation from a turn's Handoff button (or submits
 * into a fresh handoff) and tracks the generation until the run consuming it
 * lands.
 */
interface PendingHandoff {
  stage: "generating" | "ready";
  /** Runs present in the thread when the handoff started; the marker clears once a new run lands. */
  baseRuns: number;
  /** True for the UI pre-generation (confirmed handoff) — its request can be aborted. */
  cancellable?: boolean;
  /** Generated record, once known — lets the banner open its quick view. */
  handoffId?: string;
}

/** The User Message is the user's bare input — never the stitched harness prompt (v5 §4/§5). */
function displayUserPrompt(run: any, task: any): string {
  if (run.userPrompt) return run.userPrompt;
  // Legacy runs recorded before userPrompt existed: recover the bare
  // instruction from the rendered handoff prompt when possible.
  if (run.continuity === "new") return task.prompt;
  const instr: string = run.inputInstruction ?? "";
  const marker = instr.lastIndexOf("# Your instruction");
  if (marker >= 0) return instr.slice(marker + "# Your instruction".length).trim();
  return instr || task.prompt;
}

/** Where a task's unsent composer text lives. */
const draftKey = (taskId: string) => `af.composer.draft.${taskId}`;

function readDraft(taskId: string): string {
  try {
    return window.localStorage.getItem(draftKey(taskId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(taskId: string, text: string): void {
  try {
    if (text) window.localStorage.setItem(draftKey(taskId), text);
    else window.localStorage.removeItem(draftKey(taskId));
  } catch {
    /* a draft that cannot be stored must not break the composer */
  }
}

export function TaskThreadView({ taskId }: { taskId: string }) {
  const t = useT();
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [showJump, setShowJump] = useState(false);
  const [pendingHandoff, setPendingHandoff] = useState<PendingHandoff | null>(null);
  /** Composer runtime preselection requested from outside (quota flow aim). */
  const [runtimeRequest, setRuntimeRequest] = useState<{ id: string; n: number } | null>(null);
  /** Handoff confirmation dialog; `aimRuntimeId` re-aims the composer after confirming (quota flow). */
  const [handoffDialog, setHandoffDialog] = useState<{ aimRuntimeId?: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  /**
   * The view is one component reused for every task (App renders
   * <TaskThreadView taskId=… /> with no key), so a ref survives a task switch.
   * Having scrolled up in the previous thread would then open the next one at
   * the top, with the newest message off-screen — so re-stick on every switch.
   */
  useEffect(() => {
    stickBottom.current = true;
  }, [taskId]);
  const composerPromptRef = useRef<HTMLTextAreaElement>(null);
  const composerRuntimeRef = useRef<HTMLSelectElement>(null);
  /** Handoff opened in the quick-view modal (from the ready banner). */
  const [viewHandoffId, setViewHandoffId] = useState<string | null>(null);
  /** Banner-side handle: the Cancel button aborts the pre-generation request. */
  const handoffCancelRef = useRef<() => void>(() => {});
  /** In-flight pre-generation request, so the banner Cancel can abort it. */
  const handoffAbortRef = useRef<AbortController | null>(null);
  const runtimeCatalog = useAsync<any[]>(() => get("/api/runtimes"), [taskId]);
  // The server's decision on which runtimes may execute a task — the pool
  // the "Continue with X" escape hatches draw from.
  const usableRuntimes = useAsync<any[]>(() => get("/api/runtimes?usableInTask=true"), [taskId]);
  const providers = useAsync<any[]>(() => get("/api/providers"), []);
  const providerList = providers.data ?? [];

  const bump = () => setReloadTick((t) => t + 1);
  const [syncError, setSyncError] = useState<string | null>(null);
  // A handoff generation failure is an action failure, not a load failure:
  // it must not go through `error`, whose early return replaces the whole
  // thread with an error page (the thread is still perfectly readable — the
  // generation just did not happen).
  const [handoffError, setHandoffError] = useState<string | null>(null);
  /** Guards the refresh button against a second sync while one is in flight. */
  const syncingRef = useRef(false);

  // Refresh is explicit on an adopted task: it first re-reads the native
  // session in the harness (appending turns that happened there since
  // adoption), then refetches the stored thread. A sync failure stays
  // visible but never blocks the local refetch.
  const refresh = async () => {
    if (syncingRef.current) return;
    if (thread?.task?.metadata?.importedFromHarness) {
      syncingRef.current = true;
      try {
        await post(`/api/tasks/${taskId}/sync-thread`);
        setSyncError(null);
      } catch (e) {
        setSyncError(e instanceof Error ? e.message : String(e));
      } finally {
        syncingRef.current = false;
      }
    }
    bump();
  };

  // Reset only when switching tasks — a refresh (bump) refetches in the
  // background so the timeline stays put while the new state arrives.
  useEffect(() => {
    setThread(null);
    setError(null);
    setSyncError(null);
  }, [taskId]);
  useEffect(() => {
    let alive = true;
    get<ThreadData>(`/api/tasks/${taskId}/thread`)
      .then((d) => alive && setThread(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [taskId, reloadTick]);

  // The optimistic handoff marker lives until the run it precedes shows up.
  useEffect(() => {
    if (pendingHandoff && thread && thread.runs.length > pendingHandoff.baseRuns) {
      setPendingHandoff(null);
    }
  }, [thread, pendingHandoff]);

  // Banner Cancel: abort the pre-generation request and drop the marker. The
  // composer runtime is left untouched — harness choice and handoff are
  // independent now.
  useEffect(() => {
    handoffCancelRef.current = () => {
      handoffAbortRef.current?.abort();
      handoffAbortRef.current = null;
      setPendingHandoff(null);
    };
  });

  const turnIds = useMemo(() => new Set((thread?.runs ?? []).map((t) => t.run.id)), [thread]);
  // The card this task came from, when it was started on the board. Recorded
  // on the task itself at creation, so it survives restarts and reruns.
  const boardCardId = (thread?.task?.metadata as { board?: { cardId?: string } } | undefined)?.board?.cardId;
  // A board task's agent output lives in its KanbanSession transcript, not in
  // Run events: a board card owns an interactive PTY/ACP process. Read the
  // card's latest session here so the task view can show the same output.
  const boardSessionData = useAsync<any>(
    () => (boardCardId ? get(`/api/kanban/cards/${boardCardId}/session`) : Promise.resolve({ session: null })),
    [boardCardId]
  );
  const boardSession = boardSessionData.data?.session ?? null;
  const visibleBoardSession =
    boardSession && thread?.runs.some((turn) => turn.run.id === boardSession.runId) ? boardSession : null;

  // Real-time updates ride the existing global SSE stream, filtered to
  // this task's runs (v5 §27).
  useEffect(() => {
    const unsub = subscribeSSE("/api/events/stream", (raw) => {
      const evt = raw as RawEvent;
      setThread((prev) => {
        if (!prev || !prev.runs.some((t) => t.run.id === evt.runId)) return prev;
        const runs = prev.runs.map((t) =>
          t.run.id === evt.runId && !t.events.some((e) => e.id === evt.id)
            ? { ...t, events: [...t.events, evt] }
            : t
        );
        return { ...prev, runs };
      });
      if (TERMINAL_EVENTS.has(evt.type)) setTimeout(bump, 500);
    });
    return unsub;
  }, [taskId]);

  const isLive = Boolean(thread?.runs.some((t) => LIVE_STATUSES.has(t.run.status)));
  const liveRun = thread?.runs.find((t) => LIVE_STATUSES.has(t.run.status))?.run;
  const lastTurn = thread?.runs[thread.runs.length - 1];
  const totalEvents = thread?.runs.reduce((n, t) => n + t.events.length, 0) ?? 0;

  // Safety-net poll while a run is executing (catches status changes and
  // runs created outside this page even if an SSE frame is missed).
  const sigRef = useRef("");
  useEffect(() => {
    sigRef.current = (thread?.runs ?? []).map((t) => `${t.run.id}:${t.run.status}`).join("|") ?? "";
  }, [thread]);
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(async () => {
      try {
        const runs = await get<any[]>(`/api/tasks/${taskId}/runs`);
        const sig = runs.map((r) => `${r.id}:${r.status}`).join("|");
        if (sig !== sigRef.current) bump();
      } catch {
        /* ignore */
      }
    }, 4000);
    return () => clearInterval(id);
  }, [isLive, taskId]);

  // Stick to the bottom while the agent works, unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [totalEvents, thread?.runs.length, pendingHandoff, taskId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    stickBottom.current = nearBottom;
    setShowJump(!nearBottom);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  if (error) {
    return (
      <div className="page-pad">
        <ErrorBox message={error} />
        <p><a onClick={() => navigate("/tasks")}>{t("thread.backToTasks")}</a></p>
      </div>
    );
  }
  if (!thread) return <div className="page-pad muted">{t("thread.loading")}</div>;

  const taskStatus = isLive ? "running" : (lastTurn?.run.status ?? "pending");

  const focusComposer = () => {
    composerPromptRef.current?.focus();
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const stopRun = async (runId: string) => {
    // A failed stop used to be swallowed, so pressing Stop on a running (and
    // billing) session looked like it worked while the run carried on. Say what
    // happened instead, and still refresh: the run may have ended anyway.
    try {
      await post(`/api/runs/${runId}/cancel`);
      setError(null);
    } catch (e) {
      setError(t("thread.stopFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      bump();
    }
  };

  // "Continue with Pi / OpenCode" (v6 §10): open the handoff confirmation,
  // then re-aim the composer at that harness once confirmed — handoff
  // generation itself stays harness-agnostic.
  const handoffViaRuntime = (runtimeId: string) => {
    setHandoffDialog({ aimRuntimeId: runtimeId });
  };

  // Cross-harness escape hatches offered when the current harness cannot
  // continue (v6 §10, v7 §14): drawn from the runtime list the server
  // serves as usable for tasks. Each turn filters out its own harness kind.
  const switchTargets = (usableRuntimes.data ?? [])
    .map((r: any) => ({ id: r.id, name: r.name, kind: r.kind }));
  // runtimeId → kind lookup so each turn can exclude its own harness.
  const runtimeKinds = Object.fromEntries(
    (runtimeCatalog.data ?? []).map((r: any) => [r.id, r.kind as string])
  );
  const lastModelLabel = modelLabel(providerList, lastTurn?.run ?? {});

  // Confirmed handoff: generate the context summary as a standalone action —
  // it binds no harness. Once ready it waits in the thread and the next
  // message (any harness) consumes it as the sole context. `aimRuntimeId`
  // optionally re-aims the composer afterwards (quota escape hatch).
  const confirmHandoff = (aimRuntimeId?: string) => {
    setHandoffDialog(null);
    if (!thread) return;
    setHandoffError(null);
    setPendingHandoff({ stage: "generating", baseRuns: thread.runs.length, cancellable: true });
    if (aimRuntimeId) setRuntimeRequest((prev) => ({ id: aimRuntimeId, n: (prev?.n ?? 0) + 1 }));
    const controller = new AbortController();
    handoffAbortRef.current = controller;
    post<{ id?: string }>(`/api/tasks/${taskId}/handoff`, {}, controller.signal)
      .then((h) => {
        setPendingHandoff((p) => (p ? { ...p, stage: "ready", handoffId: h?.id } : p));
        bump();
      })
      .catch((e) => {
        setPendingHandoff((p) => (p ? null : p));
        // An explicit handoff never degrades: surface why it could not be
        // generated instead of silently dropping the request.
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setHandoffError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (handoffAbortRef.current === controller) handoffAbortRef.current = null;
      });
  };
  // Armed on the server (loaded or regenerated elsewhere): shown as a
  // ready banner until a run consumes it.
  const armedHandoff = thread.pendingHandoff ?? null;

  return (
    <div className="task-thread">
      {/* ---------- Thread header (v5 §3/§22/§23) ---------- */}
      <header className="thread-header">
        <div className="thread-title-row">
          <h1 className="thread-title">{thread.task.title}</h1>
          <StatusBadge status={taskStatus} />
          <span className="right thread-actions">
            <button
              className="icon-btn"
              title={thread.task.metadata?.importedFromHarness ? t("thread.refreshAdopted") : t("thread.refresh")}
              onClick={refresh}
            >
              <Icon name="refresh" />
            </button>
          </span>
        </div>
        <div className="thread-meta">
          <span className="meta-chip" title={t("thread.workspaceTitle", { path: thread.workspace?.path ?? "" })}>
            <Icon name="folder" size={13} /> {thread.workspace?.name ?? t("thread.noWorkspace")}
          </span>
          <span className="meta-chip"><Icon name="box" size={13} /> {lastTurn?.run.runtimeName ?? "—"}</span>
          <span className="meta-chip" title={lastModelLabel ?? "—"}>
            <Icon name="cpu" size={13} /> {lastModelLabel ?? "—"}
          </span>
          <a className="switch-link" onClick={() => { focusComposer(); composerRuntimeRef.current?.focus(); }}>
            <Icon name="refresh" size={12} /> {t("thread.switchRuntime")}
          </a>
          {/* The lifecycle page is a detail view of this task: workspace,
              runtime, current phase, agent status and its runs. The entry
              point lives here rather than being the page the composer lands
              on. */}
          <a className="switch-link" onClick={() => navigate(`/tasks/${thread.task.id}/lifecycle`)}>
            <Icon name="box" size={12} /> {t("thread.lifecycle")}
          </a>
          {/* A board card's Task keeps living on the board it came from: the
              card owns the column, the terminal and the chat. Without this
              link the board conversation would be a dead end from the task
              side, since the thread only shows run events. */}
          {boardCardId && (
            <a className="switch-link" onClick={() => navigate("/kanban")} title={t("thread.boardCardTitle")}>
              <Icon name="grid" size={12} /> {t("thread.boardCard")}
            </a>
          )}
        </div>
        {syncError && <ErrorBox message={t("thread.syncFailed", { error: syncError })} />}
        {handoffError && <ErrorBox message={t("thread.handoffFailed", { error: handoffError })} />}
      </header>

      {visibleBoardSession ? (
        <div className="thread-board-session">
          {visibleBoardSession.transport === "acp" ? (
            <AcpChat key={visibleBoardSession.id} sessionId={visibleBoardSession.id} />
          ) : (
            <BoardTerminal
              key={visibleBoardSession.id}
              sessionId={visibleBoardSession.id}
              interactive={visibleBoardSession.interactiveTui}
            />
          )}
        </div>
      ) : (
        <>
      {/* ---------- Timeline (v5 §11: each run is one assistant turn) ---------- */}
      <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread-list">
          {thread.runs.length === 0 && (
            <div className="muted" style={{ padding: "24px 0" }}>{t("thread.noActivity")}</div>
          )}
          {thread.runs.map((turn) => (
            <TurnView
              key={turn.run.id}
              turn={turn}
              task={thread.task}
              runtimeKinds={runtimeKinds}
              providers={providerList}
              onContinue={focusComposer}
              onSwitchRuntime={() => { focusComposer(); composerRuntimeRef.current?.focus(); }}
              onHandoffRequest={handoffViaRuntime}
              onHandoff={() => setHandoffDialog({})}
              onViewHandoff={setViewHandoffId}
              handoffDisabled={Boolean(pendingHandoff) || Boolean(armedHandoff)}
              switchTargets={switchTargets}
              onStop={stopRun}
            />
          ))}

          {/* Explicitly requested handoff waiting in the thread: the next
              message (any harness) starts a fresh session from it */}
          {!pendingHandoff && armedHandoff && (
            <div className="handoff-banner handoff-pending" aria-live="polite">
              <div className="handoff-line">
                <span className="handoff-mark">
                  <span className="handoff-done">✓</span> {t("thread.handoff")}
                </span>
                <span
                  className="muted"
                  title={t("thread.handoffReady")}
                >
                  {t("thread.handoffReady")}
                </span>
                <button
                  className="handoff-view"
                  title={t("thread.viewHandoffTitle")}
                  onClick={() => setViewHandoffId(armedHandoff.id)}
                >
                  {t("thread.viewHandoff")}
                </button>
              </div>
            </div>
          )}

          {/* Handoff being generated after explicit confirmation (v5 §20) */}
          {pendingHandoff && (
            <div className="handoff-banner handoff-pending" aria-live="polite">
              <div className="handoff-line">
                <span className="handoff-mark">
                  {pendingHandoff.stage === "generating" ? <span className="spinner" /> : <span className="handoff-done">✓</span>}
                  {t("thread.handoff")}
                </span>
                <span
                  className="muted"
                  title={
                    pendingHandoff.stage === "generating"
                      ? t("thread.handoffGenerating")
                      : t("thread.handoffReady")
                  }
                >
                  {pendingHandoff.stage === "generating"
                    ? t("thread.handoffGenerating")
                    : t("thread.handoffReady")}
                </span>
                {pendingHandoff.stage === "generating" && pendingHandoff.cancellable && (
                  <button
                    className="handoff-cancel"
                    title={t("thread.cancelHandoffTitle")}
                    onClick={() => handoffCancelRef.current()}
                  >
                    {t("thread.cancelHandoff")}
                  </button>
                )}
                {pendingHandoff.stage === "ready" && pendingHandoff.handoffId && (
                  <button
                    className="handoff-view"
                    title={t("thread.viewHandoffTitle")}
                    onClick={() => setViewHandoffId(pendingHandoff.handoffId!)}
                  >
                    {t("thread.viewHandoff")}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating scroll-to-bottom (Codex style) */}
      {showJump && (
        <button className="jump-down" title={t("thread.jumpLatest")} onClick={jumpToBottom}>
          <Icon name="arrowDown" size={16} />
        </button>
      )}

      {/* ---------- Continue composer (v5 §17/§18) ---------- */}
      <Composer
        taskId={taskId}
        live={isLive}
        liveRunId={liveRun?.id}
        defaultModelId={lastTurn?.run.modelId}
        previousRuntimeId={lastTurn?.run.runtimeId}
        previousRunStatus={lastTurn?.run.status}
        promptRef={composerPromptRef}
        runtimeRef={composerRuntimeRef}
        runtimeRequest={runtimeRequest}
        onStop={stopRun}
        onSubmitted={bump}
        handoffState={pendingHandoff?.stage ?? (armedHandoff ? "ready" : undefined)}
      />
        </>
      )}

      {/* ---------- Handoff confirmation (the only trigger of generation) ---------- */}
      {handoffDialog && (
        <HandoffConfirmModal
          onConfirm={() => confirmHandoff(handoffDialog.aimRuntimeId)}
          onClose={() => setHandoffDialog(null)}
        />
      )}

      {/* ---------- Quick look at a generated handoff ---------- */}
      {viewHandoffId && (
        <HandoffQuickView handoffId={viewHandoffId} onClose={() => setViewHandoffId(null)} />
      )}
    </div>
  );
}

/**
 * Quick look at a generated handoff, without leaving the thread: exactly
 * what the next session receives ahead of your message (the rendered
 * prompt), plus how it was produced. The full page — parsed fields,
 * consumed-by runs — stays one link away.
 */
function HandoffQuickView({ handoffId, onClose }: { handoffId: string; onClose: () => void }) {
  const t = useT();
  const { data, error } = useAsync<any>(() => get(`/api/handoffs/${handoffId}`), [handoffId]);
  const generation = data?.generation as { method?: string; detail?: string; chunks?: number } | undefined;
  const degraded = generation?.method === "heuristic";
  return (
    <Modal title={t("thread.handoffContext")} onClose={onClose}>
      <div className="handoff-quickview">
        {error && <ErrorBox message={error} />}
        {!data && !error && <div className="muted">{t("common.loading")}</div>}
        {data && (
          <>
            <p className="sub" style={{ margin: "0 0 10px" }}>
              {data.fromRuntimeName ?? data.fromRuntimeKind ?? t("thread.previousAgent")} →{" "}
              {data.toRuntimeName ?? data.toRuntimeKind ?? t("thread.nextAgentPicks")} · {fmtTime(data.createdAt)}
              {generation?.method ? (
                <>
                  {" · "}{t("thread.contextMethod")} <span className="mono">{generation.method}</span>
                  {generation.chunks && generation.chunks > 1 ? <> {t("thread.contextChunks", { n: generation.chunks })}</> : null}
                </>
              ) : null}
            </p>
            {degraded && (
              <p className="handoff-degraded-detail" style={{ margin: "0 0 10px" }}>
                {t("thread.degradedBanner")}{" "}
                {generation?.detail ?? t("thread.degradedNoModel")}
              </p>
            )}
            <pre className="handoff-quickview-body">{data.renderedPrompt}</pre>
            <p className="muted" style={{ margin: "10px 0 0" }}>
              {t("thread.quickviewNote")}{" "}
              <span className="mono"># Your instruction</span> {t("thread.quickviewNoteAfter")}
            </p>
            <div className="modal-actions">
              <button
                onClick={() => {
                  onClose();
                  navigate(`/handoffs/${handoffId}`);
                }}
              >
                {t("thread.openFull")}
              </button>
              <button className="primary" autoFocus onClick={onClose}>
                {t("common.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Handoff confirmation — the single gate in front of generation       */
/* ================================================================== */

function HandoffConfirmModal({
  onConfirm,
  onClose,
  thenSubmit = false,
  targetName,
}: {
  onConfirm: () => void;
  onClose: () => void;
  /** The message is waiting to be sent: generate the handoff, then send it. */
  thenSubmit?: boolean;
  targetName?: string;
}) {
  const t = useT();
  // The sentence lives in the dictionary; only the emphasised fragments are laid
  // out here, so word order stays the translator's choice.
  const sendPrefix = t("thread.confirmHandoffSendPrefix");
  const sendSuffix = t("thread.confirmHandoffSendSuffix");
  return (
    <Modal title={thenSubmit ? t("thread.confirmHandoffForMessage") : t("thread.confirmHandoff")} onClose={onClose}>
      <div className="handoff-confirm">
        {thenSubmit ? (
          <p>
            {sendPrefix}
            <b>{t("thread.confirmHandoffNewSession")}</b>
            {targetName ? t("thread.confirmHandoffSendTarget", { name: targetName }) : ""}
            {sendSuffix}
          </p>
        ) : (
          <p>{t("thread.confirmHandoffBody")}</p>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" autoFocus onClick={onConfirm}>
            {thenSubmit ? t("thread.generateHandoffAndSend") : t("thread.generateHandoff")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The model summary for the handoff failed. Degrading is a choice, never a
 * silent substitution: the user sees the reason and explicitly accepts a
 * structured digest (marked as degraded on the handoff) or cancels.
 */
function DegradedHandoffModal({
  message,
  onConfirm,
  onClose,
}: {
  message: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal title={t("thread.degradedTitle")} onClose={onClose}>
      <div className="handoff-confirm">
        <p className="handoff-degraded-reason">{message}</p>
        <p>
          {t("thread.degradedPrefix")}
          <b>{t("thread.degradedDigest")}</b>
          {t("thread.degradedSuffix")}
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" autoFocus onClick={onConfirm}>
            {t("thread.continueDegraded")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Turn: User Message → Agent Work → Agent Response (v5 §11)           */
/* ================================================================== */

function TurnView({
  turn,
  task,
  runtimeKinds,
  providers,
  onContinue,
  onSwitchRuntime,
  onHandoff,
  onHandoffRequest,
  handoffDisabled,
  switchTargets,
  onStop,
  onViewHandoff,
}: {
  turn: ThreadTurn;
  task: any;
  runtimeKinds: Record<string, string>;
  providers: any[];
  onContinue: () => void;
  onSwitchRuntime: () => void;
  /** Turn-footer Handoff button: open the handoff confirmation unpicked. */
  onHandoff: () => void;
  /** Quota escape hatch: open the handoff confirmation with a pre-picked target. */
  onHandoffRequest: (runtimeId: string) => void;
  /** Open the quick view for a handoff generated from this turn. */
  onViewHandoff: (handoffId: string) => void;
  handoffDisabled: boolean;
  switchTargets: Array<{ id: string; name: string; kind: string }>;
  onStop: (runId: string) => void;
}) {
  const t = useT();
  const run = turn.run;
  const live = LIVE_STATUSES.has(run.status);
  const runtimeKindOfRun = run.runtimeId ? runtimeKinds[run.runtimeId] : undefined;
  const otherHarnessTargets = switchTargets.filter((t) => t.kind !== runtimeKindOfRun);
  const items = useMemo(
    () => projectTimeline(t, turn.events, { live }),
    // `t` changes with the language, so the labels have to be rebuilt then.
    [t, turn.events, live]
  );
  const userPrompt = displayUserPrompt(run, task);
  const turnModelLabel = modelLabel(providers, run);
  // A thinking row spins only while it is still the timeline's last item.
  // Both harnesses emit agent.thinking post-hoc (pi at message_end,
  // opencode with the step parts), so the row is a finished record the
  // moment anything lands after it — spinning it there would claim the
  // agent is reasoning while later tool calls already completed.
  const activeThinkingKey = useMemo(() => {
    const last = items[items.length - 1];
    return last?.kind === "thinking" ? last.key : undefined;
  }, [items]);

  return (
    <article className="turn">
      {/* Handoff divider between harnesses (v5 §20/§21) */}
      {run.continuity === "handoff" && turn.previousHandoff && (
        <HandoffBanner handoff={turn.previousHandoff} />
      )}

      {/* User message (v5 §4) — right-aligned bubble, no label (Codex style) */}
      <div className="user-msg">
        <div className="user-bubble">{userPrompt}</div>
      </div>

      {/* Agent turn */}
      <div className="agent-turn">
        <div className="agent-name" title={run.runtimeName ?? t("thread.agentFallback")}>
          <span className="agent-badge">{run.runtimeName ?? t("thread.agentFallback")}</span>
        </div>
        <div className="agent-body">
          {/* Lightweight resume status (v5 §19) */}
          {run.continuity === "resume" && (
            <div className="resume-chip">▶ {t("thread.resumed", { name: run.runtimeName ?? t("thread.agentFallback") })}</div>
          )}

          {items.length === 0 && live && <div className="live-row"><span className="spinner" /> {t("thread.starting")}</div>}

          {items.map((item) => (
            <ActivityRow
              key={item.key}
              item={item}
              live={live}
              thinkingActive={live && item.kind === "thinking" && item.key === activeThinkingKey}
              onViewHandoff={onViewHandoff}
            />
          ))}

          {live && items.length > 0 && (
            <div className="live-row"><span className="spinner" /> {t("thread.working")}</div>
          )}

          {/* Failure surface (v5 §29) */}
          {(run.status === "failed" || run.status === "timeout") && run.errorKind !== "usage-limit" && (
            <div className="fail-box">
              <div className="fail-title">{run.status === "timeout" ? t("thread.agentRunFailedTimeout") : t("thread.agentRunFailed")}</div>
              {run.error && <div className="fail-reason">{run.error}</div>}
              <div className="row fail-actions">
                <button className="small" onClick={onContinue}>{t("thread.continue")}</button>
                <button className="small" onClick={onSwitchRuntime}>{t("thread.switchRuntime")}</button>
                <button className="small" onClick={() => navigate(`/runs/${run.id}`)}>{t("thread.viewRun")}</button>
              </div>
            </div>
          )}
          {/* Quota exhaustion is a switch-harness scenario, not a plain
              failure (v6 §10, v7 §14): the workspace and the harness's own
              session survive, so offer the other harnesses directly. */}
          {(run.status === "failed" || run.status === "timeout") && run.errorKind === "usage-limit" && (
            <div className="fail-box quota-box">
              <div className="fail-title">{t("thread.usageLimit", { name: run.runtimeName ?? t("thread.harnessFallback") })}</div>
              {run.error && <div className="fail-reason">{run.error}</div>}
              <p className="muted">
                {t("thread.quotaHint", { name: run.runtimeName ?? t("thread.harnessFallback") })}
              </p>
              <div className="row fail-actions">
                {otherHarnessTargets.map((target) => (
                  <button key={target.id} className="small primary" onClick={() => onHandoffRequest(target.id)}>
                    {t("thread.continueWith", { name: target.name })}
                  </button>
                ))}
                {otherHarnessTargets.length === 0 && (
                  <span className="muted">{t("thread.noOtherHarness")}</span>
                )}
                <button className="small" onClick={() => navigate(`/runs/${run.id}`)}>{t("thread.viewRun")}</button>
              </div>
            </div>
          )}
          {run.status === "cancelled" && (
            <div className="cancelled-note">{t("thread.stopped")}</div>
          )}

          {/* Artifacts (v5 §31) */}
          {turn.artifacts.length > 0 && (
            <div className="artifact-row">
              <span className="muted artifact-label">{t("thread.created")}</span>
              {turn.artifacts.map((a) => <ArtifactChip key={a.id} artifact={a} />)}
            </div>
          )}

          {/* Lightweight turn metadata (v5 §11/§23/§28) */}
          <footer className="turn-meta">
            {live ? (
              <>
                <StatusBadge status={run.status} />
                <span>{run.runtimeName ?? "—"}</span>
                <button className="small danger stop-btn" onClick={() => onStop(run.id)}>
                  <Icon name="stop" size={11} /> {t("thread.stop")}
                </button>
              </>
            ) : (
              <>
                <StatusBadge status={run.status} />
                <span>{run.runtimeName ?? "—"}</span>
                {turnModelLabel && <span>{turnModelLabel}</span>}
                {run.usage?.durationMs != null && <span>{fmtDuration(run.usage.durationMs)}</span>}
                {run.usage && (
                  <span>{t("thread.tokens", { n: fmtTokens((run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)) })}</span>
                )}
                {run.cost ? <span>{fmtCostShort(run.cost)}</span> : null}
                {turn.artifacts.length > 0 && <span>{t("thread.artifacts", { n: turn.artifacts.length })}</span>}
                <button
                  className="turn-handoff"
                  title={t("thread.handoffBtnTitle")}
                  disabled={handoffDisabled}
                  onClick={onHandoff}
                >
                  ⇄ {t("thread.handoff")}
                </button>
              </>
            )}
          </footer>
        </div>
      </div>
    </article>
  );
}

/* ================================================================== */
/* Handoff divider (v5 §20/§21)                                        */
/* ================================================================== */

function HandoffBanner({ handoff }: { handoff: any }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const c = handoff.content ?? {};
  // A degraded handoff (`generation.method: "heuristic"`) is a structured
  // digest, not a model summary — say so instead of letting the next agent
  // (and the user) assume otherwise.
  const degraded = handoff.generation?.method === "heuristic";
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) =>
    children ? (
      <div className="handoff-section">
        <div className="handoff-section-title">{title}</div>
        {children}
      </div>
    ) : null;
  return (
    <div className="handoff-banner">
      <div className="handoff-line">
        <span className="handoff-mark">⇄ {t("thread.handoff")}</span>
        {degraded ? (
          <span className="handoff-degraded" title={handoff.generation?.detail ?? undefined}>
            {t("thread.handoffDegraded")}
          </span>
        ) : (
          <span className="muted">{t("thread.handoffWorkspaceKept")}</span>
        )}
        <button className="small right" onClick={() => setOpen(!open)}>{open ? t("common.hide") : t("thread.viewHandoff")}</button>
      </div>
      {degraded && handoff.generation?.detail && (
        <div className="handoff-degraded-detail">{t("thread.handoffReason", { detail: handoff.generation.detail })}</div>
      )}
      {open && (
        <div className="handoff-detail">
          <Section title={t("thread.handoffProgress")}>{c.progressSummary}</Section>
          <Section title={t("thread.handoffCompleted")}>
            {(c.completedWork ?? []).map((w: string, i: number) => <div key={i}>✓ {w}</div>)}
          </Section>
          <Section title={t("thread.handoffRemaining")}>
            {(c.remainingWork ?? []).map((w: string, i: number) => <div key={i}>• {w}</div>)}
          </Section>
          <Section title={t("thread.handoffDecisions")}>
            {(c.importantDecisions ?? []).map((w: string, i: number) => <div key={i}>• {w}</div>)}
          </Section>
          <Section title={t("thread.handoffFiles")}>
            {(c.relevantFiles ?? []).map((w: string, i: number) => <code key={i}>{w}</code>)}
          </Section>
          {handoff.userNotes && (
            <Section title={t("thread.handoffNotes")}>{handoff.userNotes}</Section>
          )}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* Activity rows — readable, collapsed by default (v5 §7/§8/§9/§10)    */
/* ================================================================== */

function ActivityRow({
  item,
  live,
  thinkingActive,
  onViewHandoff,
}: {
  item: TimelineItem;
  live: boolean;
  thinkingActive: boolean;
  onViewHandoff: (handoffId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case "agent-message":
      return <AgentMessage item={item} />;
    case "thinking":
      return <ThinkingRow item={item} active={thinkingActive} />;
    case "tool":
      return <ToolRow item={item} open={open} onToggle={() => setOpen(!open)} />;
    case "command":
      return <CommandRow item={item} open={open} onToggle={() => setOpen(!open)} />;
    case "file":
      return <FileRow item={item} />;
    case "error":
      return <ErrorRow item={item} />;
    case "handoff":
      return <HandoffRow item={item} onView={() => onViewHandoff(item.handoffId)} />;
  }
}

/** The Agent's response is the primary content (v5 §6). */
function AgentMessage({ item }: { item: AgentMessageItem }) {
  return (
    <div className="agent-message">
      <div className="agent-message-text">
        <Markdown text={item.content} />
      </div>
      {item.model && <div className="agent-message-model muted">{item.model}</div>}
    </div>
  );
}

/**
 * One row per thinking block. `active` marks the newest block on a live
 * run that nothing has followed yet — it alone spins; every earlier block
 * is finished reasoning and shows ◍.
 */
function ThinkingRow({ item, active }: { item: ThinkingItem; active: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className={`activity thinking${item.content ? " clickable" : ""}`} onClick={() => item.content && setOpen(!open)}>
      <div className="act-head">
        <span className="act-icon">{active ? <span className="spinner" /> : "◍"}</span>
        <span className="act-label">{t("thread.thinking")}</span>
        {item.content && <span className="act-detail-hint">{open ? t("common.hide") : t("thread.reasoning")}</span>}
      </div>
      {open && item.content && <pre className="act-detail">{item.content}</pre>}
    </div>
  );
}

function ToolRow({ item, open, onToggle }: { item: ToolActivity; open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <div className={`activity clickable ${item.status}`} onClick={onToggle}>
      <div className="act-head">
        <span className="act-icon">
          {item.status === "running" ? <span className="spinner" /> : item.status === "error" ? "✗" : "✓"}
        </span>
        <span className="act-label mono-target">{item.label}</span>
        <span className={`chev ${open ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
      </div>
      {open && (
        <div className="act-detail" onClick={(e) => e.stopPropagation()}>
          {item.args == null && item.result == null && item.error == null && (
            <div className="muted detail-title" style={{ textTransform: "none", letterSpacing: 0 }}>
              {t("thread.toolNoDetail")}
            </div>
          )}
          {item.args != null && (
            <>
              <div className="detail-title">{t("thread.arguments")}</div>
              <pre>{typeof item.args === "string" ? item.args : JSON.stringify(item.args, null, 2)}</pre>
            </>
          )}
          {item.result != null && (
            <>
              <div className="detail-title">{t("thread.result")}</div>
              <pre>{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre>
            </>
          )}
          {item.error && (
            <>
              <div className="detail-title">{t("thread.errorLabel")}</div>
              <pre className="err">{String(item.error)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CommandRow({ item, open, onToggle }: { item: CommandActivity; open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <div className={`activity clickable command`} onClick={onToggle}>
      <div className="act-head">
        <span className="act-icon">{item.running ? <span className="spinner" /> : <Icon name="terminal" size={13} />}</span>
        <span className="act-label mono-target">{t("thread.ranPre")}<code>{item.command}</code></span>
        {item.summary && (
          <span className={`cmd-summary ${item.summaryOk === false ? "bad" : "good"}`}>{item.summary}</span>
        )}
      </div>
      {open && (
        <div className="act-detail" onClick={(e) => e.stopPropagation()}>
          <div className="detail-title">
            {t("thread.command")} {item.cwd ? `· ${item.cwd}` : ""} {item.backend ? `· ${item.backend}` : ""}
          </div>
          <pre>{item.command}</pre>
          <div className="detail-title">
            {t("thread.output")} {item.cwd ? `· ${item.cwd}` : ""} {item.backend ? `· ${item.backend}` : ""}
          </div>
          <pre>{item.outputs.length ? item.outputs.join("\n") : t("thread.noOutput")}</pre>
        </div>
      )}
    </div>
  );
}

function FileRow({ item }: { item: FileActivity }) {
  const t = useT();
  return (
    <div className="activity file">
      <div className="act-head">
        <span className="act-icon">{item.action === "created" ? "+" : "±"}</span>
        <span className="act-label">{item.action === "created" ? t("thread.fileCreated") : t("thread.fileModified")} <code>{item.path}</code></span>
      </div>
    </div>
  );
}

function ErrorRow({ item }: { item: ErrorItem }) {
  return (
    <div className="activity error">
      <div className="act-head">
        <span className="act-icon">✗</span>
        <span className="act-label">{item.message}</span>
      </div>
    </div>
  );
}

/**
 * The timeline's record that this turn handed the task over: one line with
 * the provenance of the generated handoff (why, how, what it covers, what
 * it cost) and the way into its full text.
 */
function HandoffRow({ item, onView }: { item: HandoffActivity; onView: () => void }) {
  const t = useT();
  const facts: string[] = [];
  // An unknown trigger value is data, not a missing translation: show it as-is.
  if (item.trigger) {
    const triggerKey = `thread.handoffTrigger.${item.trigger}`;
    facts.push(TRIGGER_KEYS.includes(item.trigger) ? t(triggerKey as MessageKey) : item.trigger);
  }
  facts.push(item.fromHarness ? t("thread.harnessGenerated") : item.method);
  if (item.model) facts.push(item.model);
  if (item.coveredRunIds?.length) {
    facts.push(t("thread.handoffCovers", { n: item.coveredRunIds.length }));
  }
  if (item.chunks && item.chunks > 1) facts.push(t("thread.handoffChunks", { n: item.chunks }));
  if (item.usage) facts.push(t("thread.handoffTokens", { n: (item.usage.inputTokens + item.usage.outputTokens).toLocaleString() }));
  if (item.durationMs) facts.push(`${(item.durationMs / 1000).toFixed(1)}s`);
  if (item.toRuntime) facts.push(`→ ${item.toRuntime}`);
  if (item.detail) facts.push(t("thread.handoffDegradedFact"));
  const title = [facts.join(" · "), item.detail ? t("thread.handoffDegradedTitle", { detail: item.detail }) : ""].filter(Boolean).join("\n");
  return (
    <div className="activity handoff">
      <div className="act-head">
        <span className="act-icon">⇄</span>
        <span className="act-label">{t("thread.handoffGenerated")}</span>
        <span className="handoff-facts" title={title}>{facts.join(" · ")}</span>
        <button className="small" onClick={onView}>{t("common.view")}</button>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Artifacts (v5 §31)                                                  */
/* ================================================================== */

function ArtifactChip({ artifact }: { artifact: any }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && content === null) {
      try {
        const c = await get<any>(`/api/artifacts/${artifact.id}/content`);
        setContent(typeof c === "string" ? c : JSON.stringify(c, null, 2));
      } catch {
        setContent(t("thread.artifactUnavailable"));
      }
    }
  };
  return (
    <span className="artifact-chip-wrap">
      <button className="artifact-chip" onClick={toggle} title={t("thread.artifactTitle", { kind: artifact.kind })}>
        <Icon name="archive" size={12} /> <code>{artifact.name}</code>
      </button>
      {open && content !== null && <pre className="artifact-detail">{content}</pre>}
    </span>
  );
}

/* ================================================================== */
/* Continue composer (v5 §17/§18)                                      */
/* ================================================================== */

function Composer({
  taskId,
  live,
  liveRunId,
  defaultModelId,
  previousRuntimeId,
  previousRunStatus,
  promptRef,
  runtimeRef,
  runtimeRequest,
  onStop,
  onSubmitted,
  handoffState,
}: {
  taskId: string;
  live: boolean;
  liveRunId?: string;
  defaultModelId?: string;
  previousRuntimeId?: string;
  /** Latest run's status: the resume/handoff preview changes when a run finishes. */
  previousRunStatus?: string;
  promptRef: React.RefObject<HTMLTextAreaElement>;
  runtimeRef: React.RefObject<HTMLSelectElement>;
  /** External runtime preselection (quota flow aim) — applied directly, no confirmation attached. */
  runtimeRequest?: { id: string; n: number } | null;
  onStop: (runId: string) => void;
  onSubmitted: () => void;
  /** Armed/generating handoff lifecycle, so the resume-vs-handoff preview stays truthful. */
  handoffState?: "generating" | "ready";
}) {
  const t = useT();
  // The composer's runtime list is served, not derived: `?usableInTask=true`
  // returns the enabled runtimes the product allows to execute a task.
  // Submit and continue enforce the same rule server-side.
  const runtimes = useAsync<any[]>(() => get("/api/runtimes?usableInTask=true"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const providers = useAsync<any[]>(() => get("/api/providers"), []);
  // AGENT_UI_HIDDEN: composer 里的 Agent 选择器已注释。这个请求与 profileId
  // 相关的逻辑（effectiveModelId 的 profile 分支、postContinue 里的 profileId
  // 字段）原样保留——选择器隐藏期间 profileId 恒为 ""，这些分支不会命中；
  // 恢复入口只需取消注释带 AGENT_UI_HIDDEN 标记的块。
  const profiles = useAsync<any[]>(() => get("/api/agents"), []);
  // The message being written survives leaving the thread (switching task,
  // opening another view, reloading): losing a half-written follow-up is the
  // one thing a user cannot undo. Stored per task, dropped on submit.
  const [prompt, setPrompt] = useState(() => readDraft(taskId));
  /**
   * Set once a handoff has been generated for the prompt currently in the box.
   *
   * `generateThenSubmit` does two things the server does not make idempotent:
   * it generates a handoff (a new record and a model call) and then submits.
   * If the submit fails, the old code asked again on retry and generated a
   * *second* handoff for the same message. With this flag the retry goes
   * straight to the submit it was trying to do.
   */
  const [handoffReady, setHandoffReady] = useState(false);
  useEffect(() => {
    setPrompt(readDraft(taskId));
    // Same reused-component problem as the scroll ref: a handoff generated for
    // the previous task's message must not make this task's first send skip the
    // one it needs.
    setHandoffReady(false);
  }, [taskId]);
  useEffect(() => {
    writeDraft(taskId, prompt);
  }, [taskId, prompt]);
  const [runtimeChoice, setRuntimeChoice] = useState("");
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [modelChoice, setModelChoice] = useState("");
  const [modelTouched, setModelTouched] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Model summary unavailable: the user must accept a degraded context or cancel. */
  const [degradedError, setDegradedError] = useState<string | null>(null);
  /** Send was gated: a handoff must be generated explicitly before this message. */
  const [handoffGate, setHandoffGate] = useState(false);

  const runtimeList = runtimes.data ?? [];
  const inSelectable = (id?: string) => Boolean(id && runtimeList.some((r: any) => r.id === id));
  const modelList = models.data ?? [];
  const providerList = providers.data ?? [];
  const profile = (profiles.data ?? []).find((p: any) => p.id === profileId);
  const inList = (list: any[], id?: string) => Boolean(id && list.some((x) => x.id === id));

  // Resume vs Handoff preview for the selected runtime (v5 §18/§19).
  // Untouched, the preview (and the submit below) use the task's default
  // chain; the resolved target runtime is preselected visibly.
  // previousRuntimeId doubles as "latest run changed" — refresh the preview
  // after a run lands so the suggestion never goes stale mid-thread;
  // previousRunStatus refreshes it when that run finishes (its native
  // session ref only exists once the run is done); handoffState re-runs it
  // when a handoff is armed or consumed.
  const options = useAsync<any>(
    () => get(`/api/tasks/${taskId}/continue-options${runtimeTouched && runtimeChoice ? `?runtimeId=${runtimeChoice}` : ""}`),
    [taskId, runtimeTouched, runtimeChoice, previousRuntimeId, previousRunStatus, handoffState]
  );

  // Visible defaults — the submitted ids are always the concrete values on
  // screen: same-runtime continue when possible (and only ever a runtime
  // that may execute tasks), else the first usable runtime; last used
  // model, else first model of the first provider.
  const effectiveRuntimeId = runtimeTouched
    ? runtimeChoice
    : inSelectable(options.data?.targetRuntime?.id)
      ? options.data.targetRuntime.id
      : inSelectable(previousRuntimeId)
        ? previousRuntimeId
        : runtimeList[0]?.id ?? "";
  const effectiveRuntime = runtimeList.find((r: any) => r.id === effectiveRuntimeId);
  // Harness-native targets (v6 §3, v7 §3) run on their own account/model
  // — the AgentFabric model selector does not apply.
  const harnessNativeTarget =
    effectiveRuntime?.credentialSource === "harness-native" ||
    ["codex", "claude-code"].includes(effectiveRuntime?.kind ?? "");

  // External preselection (post-handoff aim, v6 §10 "Continue with X"):
  // apply it directly — harness choice carries no confirmation of its own.
  useEffect(() => {
    if (!runtimeRequest) return;
    selectRuntime(runtimeRequest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeRequest?.n]);

  // Harness choice is fully independent of handoff: switching never starts,
  // confirms, or cancels one — it only re-aims the next submit. Whether that
  // submit resumes or continues from an armed handoff is decided server-side.
  const selectRuntime = (nextId: string) => {
    if (!nextId || nextId === effectiveRuntimeId) return;
    setRuntimeChoice(nextId);
    setRuntimeTouched(true);
  };
  const firstProviderWithModels = (() => {
    const withModels = providerList.filter((p: any) => modelList.some((m: any) => m.providerId === p.id));
    return withModels.find((p: any) => p.enabled) ?? withModels[0];
  })();
  const providerDefaultModelId = firstProviderWithModels
    ? modelList.find((m: any) => m.providerId === firstProviderWithModels.id)?.id ?? ""
    : "";
  const effectiveModelId = modelTouched
    ? modelChoice
    : inList(modelList, profile?.modelId)
      ? profile.modelId
      : inList(modelList, defaultModelId)
        ? defaultModelId
        : providerDefaultModelId || (modelList[0]?.id ?? "");

  /** POST /continue with the composer's current selections. */
  const postContinue = (allowDegraded: boolean) =>
    post(`/api/tasks/${taskId}/continue`, {
      prompt: prompt.trim(),
      runtimeId: effectiveRuntimeId || undefined,
      // Harness-native targets never bind an AgentFabric model (v6 §3).
      modelId: harnessNativeTarget ? undefined : effectiveModelId || undefined,
      profileId: profileId || undefined,
      // Set only after the user explicitly accepts a degraded context.
      allowDegradedHandoff: allowDegraded || undefined,
    });

  const submit = async (allowDegraded = false) => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await postContinue(allowDegraded);
      setPrompt("");
      setDegradedError(null);
      onSubmitted();
    } catch (e) {
      // The server owns the resume-vs-handoff decision: the preview shown
      // here can be a stale snapshot (e.g. taken while the previous run was
      // still starting, before its native session ref existed), so the client
      // must never refuse to send on its own. The server refuses with
      // `handoff-required` when a handoff genuinely does not exist yet —
      // then we ask, generate, and send.
      if (e instanceof ApiError && e.code === "handoff-required") {
        setHandoffGate(true);
      } else if (e instanceof ApiError && e.allowDegraded) {
        // The model summary is unavailable: do not silently degrade — ask.
        setDegradedError(e.message);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  /** Explicit gate confirmed: generate the handoff, then send the message. */
  const generateThenSubmit = async () => {
    setHandoffGate(false);
    setBusy(true);
    setError(null);
    try {
      if (!handoffReady) {
        await post(`/api/tasks/${taskId}/handoff`, {});
        // The handoff exists now. Anything that fails from here on must not
        // send the user back through generation.
        setHandoffReady(true);
        onSubmitted();
      }
      await postContinue(false);
      setPrompt("");
      setHandoffReady(false);
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thread-composer-wrap">
      <ErrorBox message={error} />
      {handoffGate && (
        <HandoffConfirmModal
          thenSubmit
          targetName={effectiveRuntime?.name}
          onClose={() => setHandoffGate(false)}
          onConfirm={() => void generateThenSubmit()}
        />
      )}
      {degradedError && (
        <DegradedHandoffModal
          message={degradedError}
          onClose={() => setDegradedError(null)}
          onConfirm={() => {
            setDegradedError(null);
            void submit(true);
          }}
        />
      )}
      <div className="composer thread-composer">
        <textarea
          ref={promptRef}
          rows={2}
          placeholder={live ? t("thread.placeholderLive") : t("thread.placeholderIdle")}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            // Editing the message means the generated handoff no longer
            // describes what the user is about to send: the next send must be
            // allowed to generate a fresh one.
            if (handoffReady) setHandoffReady(false);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // Enter sends, Shift+Enter breaks the line — what a chat composer
            // is expected to do, and what this textarea looked like it did
            // (it only sent on Cmd/Ctrl+Enter, so a typed message silently did
            // nothing when Enter was pressed). Cmd/Ctrl+Enter still sends.
            if (e.metaKey || e.ctrlKey || !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-bar">
          <select
            ref={runtimeRef}
            className="pill"
            value={effectiveRuntimeId}
            onChange={(e) => selectRuntime(e.target.value)}
            title={t("thread.runtimeTitle")}
          >
            {runtimeList.map((r: any) => (
              <option key={r.id} value={r.id}>{r.name} ({r.kind})</option>
            ))}
          </select>
          {harnessNativeTarget ? (
            <span
              className="pill harness-native-note"
              title={t("thread.modelHarnessTitle")}
            >
              {t("thread.modelHarness")}
            </span>
          ) : (
            <select
              className="pill"
              value={effectiveModelId}
              onChange={(e) => { setModelChoice(e.target.value); setModelTouched(true); }}
              title={t("thread.modelLabel")}
            >
              {modelList.map((m: any) => (
                <option key={m.id} value={m.id}>{modelOptionLabel(providerList, m)}</option>
              ))}
            </select>
          )}
          {/* AGENT_UI_HIDDEN: Agent Profile 选择器，恢复入口时取消注释。
          <select className="pill" value={profileId} onChange={(e) => setProfileId(e.target.value)} title={t("common.agentProfile")}>
            <option value="">Agent: none</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>Agent: {p.name}</option>
            ))}
          </select>
          */}
          {live && liveRunId && (
            <button className="small danger" onClick={() => onStop(liveRunId)} title={t("thread.stopTitle")}>
              <Icon name="stop" size={11} /> {t("thread.stop")}
            </button>
          )}
          <button className="send" title={t("thread.sendTitle")} disabled={busy || live || !prompt.trim()} onClick={() => submit()}>
            {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
