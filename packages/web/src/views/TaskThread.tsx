import { useEffect, useMemo, useRef, useState } from "react";
import { get, post, subscribeSSE, fmtCostShort, fmtDuration, fmtTime, fmtTokens, ApiError } from "../api";
import { ErrorBox, Icon, Modal, StatusBadge, useAsync } from "../components";
import { Markdown } from "../markdown";
import {
  modelLabel,
  modelOptionLabel,
  projectTimeline,
  type AgentMessageItem,
  type CommandActivity,
  type ErrorItem,
  type FileActivity,
  HANDOFF_TRIGGERS,
  type HandoffActivity,
  type RawEvent,
  type ThinkingItem,
  type TimelineItem,
  type ToolActivity,
} from "../presentation";
import { navigate } from "../router";

/**
 * Task Thread (v5 §2/§3): the primary interaction surface.
 *
 * Task + Runs + User Prompts + Agent Events, projected into a
 * conversation — this is a *presentation* of existing records, not a new
 * chat/session domain model (v5 §34/§35). Users operate Tasks; the
 * system executes Runs. Run details live behind "View run" (v5 §12).
 */

const LIVE_STATUSES = new Set(["pending", "starting", "running"]);
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled", "run.timeout"]);

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

export function TaskThreadView({ taskId }: { taskId: string }) {
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
  const composerPromptRef = useRef<HTMLTextAreaElement>(null);
  const composerRuntimeRef = useRef<HTMLSelectElement>(null);
  /** Handoff opened in the quick-view modal (from the ready banner). */
  const [viewHandoffId, setViewHandoffId] = useState<string | null>(null);
  /** Banner-side handle: the Cancel button aborts the pre-generation request. */
  const handoffCancelRef = useRef<() => void>(() => {});
  /** In-flight pre-generation request, so the banner Cancel can abort it. */
  const handoffAbortRef = useRef<AbortController | null>(null);
  const runtimeCatalog = useAsync<any[]>(() => get("/api/runtimes"), [taskId]);
  const providers = useAsync<any[]>(() => get("/api/providers"), []);
  const providerList = providers.data ?? [];

  const bump = () => setReloadTick((t) => t + 1);
  const [syncError, setSyncError] = useState<string | null>(null);
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
        <p><a onClick={() => navigate("/tasks")}>← back to tasks</a></p>
      </div>
    );
  }
  if (!thread) return <div className="page-pad muted">Loading task…</div>;

  const taskStatus = isLive ? "running" : (lastTurn?.run.status ?? "pending");

  const focusComposer = () => {
    composerPromptRef.current?.focus();
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const stopRun = async (runId: string) => {
    await post(`/api/runs/${runId}/cancel`).catch(() => {});
    bump();
  };

  // "Continue with Pi / OpenCode" (v6 §10): open the handoff confirmation,
  // then re-aim the composer at that harness once confirmed — handoff
  // generation itself stays harness-agnostic.
  const handoffViaRuntime = (runtimeId: string) => {
    setHandoffDialog({ aimRuntimeId: runtimeId });
  };

  // Cross-harness escape hatches offered when the current harness cannot
  // continue (v6 §10, v7 §14): the other coding harnesses registered on
  // this box. Each turn filters out its own harness kind.
  const switchTargets = (runtimeCatalog.data ?? [])
    .filter((r: any) => r.enabled && ["pi", "opencode", "codex", "claude-code"].includes(r.kind))
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
          setError(e instanceof Error ? e.message : String(e));
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
              title={thread.task.metadata?.importedFromHarness ? "Refresh — re-reads the adopted native session first" : "Refresh"}
              onClick={refresh}
            >
              <Icon name="refresh" />
            </button>
          </span>
        </div>
        <div className="thread-meta">
          <span className="meta-chip" title={`Workspace ${thread.workspace?.path ?? ""}`}>
            <Icon name="folder" size={13} /> {thread.workspace?.name ?? "no workspace"}
          </span>
          <span className="meta-chip"><Icon name="box" size={13} /> {lastTurn?.run.runtimeName ?? "—"}</span>
          <span className="meta-chip" title={lastModelLabel ?? "—"}>
            <Icon name="cpu" size={13} /> {lastModelLabel ?? "—"}
          </span>
          <a className="switch-link" onClick={() => { focusComposer(); composerRuntimeRef.current?.focus(); }}>
            <Icon name="refresh" size={12} /> Switch runtime
          </a>
          <span className="meta-chip muted">{thread.runs.length} {thread.runs.length === 1 ? "run" : "runs"}</span>
        </div>
        {syncError && <ErrorBox message={`Native session sync failed: ${syncError}`} />}
      </header>

      {/* ---------- Timeline (v5 §11: each run is one assistant turn) ---------- */}
      <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread-list">
          {thread.runs.length === 0 && (
            <div className="muted" style={{ padding: "24px 0" }}>No runs yet.</div>
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
                  <span className="handoff-done">✓</span> Handoff
                </span>
                <span
                  className="muted"
                  title="context summary ready — your next message, on any harness, starts a fresh session seeded with it as the only context"
                >
                  context summary ready — your next message, on any harness, starts a fresh session seeded with it
                  as the only context
                </span>
                <button
                  className="handoff-view"
                  title="See the context the next session will receive"
                  onClick={() => setViewHandoffId(armedHandoff.id)}
                >
                  View handoff
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
                  Handoff
                </span>
                <span
                  className="muted"
                  title={
                    pendingHandoff.stage === "generating"
                      ? "generating context summary from this thread…"
                      : "context summary ready — your next message, on any harness, starts a fresh session seeded with it as the only context"
                  }
                >
                  {pendingHandoff.stage === "generating"
                    ? "generating context summary from this thread…"
                    : "context summary ready — your next message, on any harness, starts a fresh session seeded with it as the only context"}
                </span>
                {pendingHandoff.stage === "generating" && pendingHandoff.cancellable && (
                  <button
                    className="handoff-cancel"
                    title="Cancel handoff generation"
                    onClick={() => handoffCancelRef.current()}
                  >
                    Cancel
                  </button>
                )}
                {pendingHandoff.stage === "ready" && pendingHandoff.handoffId && (
                  <button
                    className="handoff-view"
                    title="See the context the next session will receive"
                    onClick={() => setViewHandoffId(pendingHandoff.handoffId!)}
                  >
                    View handoff
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating scroll-to-bottom (Codex style) */}
      {showJump && (
        <button className="jump-down" title="Scroll to latest" onClick={jumpToBottom}>
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
  const { data, error } = useAsync<any>(() => get(`/api/handoffs/${handoffId}`), [handoffId]);
  const generation = data?.generation as { method?: string; detail?: string; chunks?: number } | undefined;
  const degraded = generation?.method === "heuristic";
  return (
    <Modal title="Handoff context" onClose={onClose}>
      <div className="handoff-quickview">
        {error && <ErrorBox message={error} />}
        {!data && !error && <div className="muted">Loading…</div>}
        {data && (
          <>
            <p className="sub" style={{ margin: "0 0 10px" }}>
              {data.fromRuntimeName ?? data.fromRuntimeKind ?? "previous agent"} →{" "}
              {data.toRuntimeName ?? data.toRuntimeKind ?? "(next agent picks)"} · {fmtTime(data.createdAt)}
              {generation?.method ? (
                <>
                  {" "}· context: <span className="mono">{generation.method}</span>
                  {generation.chunks && generation.chunks > 1 ? <> ({generation.chunks} chunks)</> : null}
                </>
              ) : null}
            </p>
            {degraded && (
              <p className="handoff-degraded-detail" style={{ margin: "0 0 10px" }}>
                ⚠ Degraded context — not a model summary.{" "}
                {generation?.detail ?? "The summarization model was unavailable."}
              </p>
            )}
            <pre className="handoff-quickview-body">{data.renderedPrompt}</pre>
            <p className="muted" style={{ margin: "10px 0 0" }}>
              This is what the next session receives; your message is appended under{" "}
              <span className="mono"># Your instruction</span> when you send it.
            </p>
            <div className="modal-actions">
              <button
                onClick={() => {
                  onClose();
                  navigate(`/handoffs/${handoffId}`);
                }}
              >
                Open full page ↗
              </button>
              <button className="primary" autoFocus onClick={onClose}>
                Close
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
  return (
    <Modal title={thenSubmit ? "Generate a handoff for this message?" : "Generate handoff context?"} onClose={onClose}>
      <div className="handoff-confirm">
        {thenSubmit ? (
          <p>
            Sending this message starts a <b>new native session</b>
            {targetName ? <> on <b>{targetName}</b></> : null}, because the current one cannot be resumed. That
            needs a handoff context — and a handoff is an <b>explicit action</b>: confirm to summarize this thread,
            then your message is sent into the new session with that summary as its only context. The workspace is
            preserved.
          </p>
        ) : (
          <p>
            This generates a context summary of the task so far as a standalone action — it is not tied to any
            harness. Once ready it stays in this thread: your next message, on any harness including the current
            one, starts a fresh session that uses this summary as its only context. The workspace is preserved.
          </p>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" autoFocus onClick={onConfirm}>
            {thenSubmit ? "Generate handoff and send" : "Generate handoff"}
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
  return (
    <Modal title="Handoff summary unavailable" onClose={onClose}>
      <div className="handoff-confirm">
        <p className="handoff-degraded-reason">{message}</p>
        <p>
          You can still continue in a new native session, but the next agent would receive a{" "}
          <b>structured digest</b> instead of a model-written summary: the original task, the files that changed,
          the tools used and the last agent message — without synthesized decisions or a coherent progress
          narrative. This handoff is marked as degraded so it is never mistaken for a summary.
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" autoFocus onClick={onConfirm}>
            Continue with degraded context
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
  const run = turn.run;
  const live = LIVE_STATUSES.has(run.status);
  const runtimeKindOfRun = run.runtimeId ? runtimeKinds[run.runtimeId] : undefined;
  const otherHarnessTargets = switchTargets.filter((t) => t.kind !== runtimeKindOfRun);
  const items = useMemo(
    () => projectTimeline(turn.events, { live }),
    [turn.events, live]
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
        <div className="agent-name" title={run.runtimeName ?? "agent"}>
          <span className="agent-badge">{run.runtimeName ?? "Agent"}</span>
        </div>
        <div className="agent-body">
          {/* Lightweight resume status (v5 §19) */}
          {run.continuity === "resume" && (
            <div className="resume-chip">▶ {run.runtimeName ?? "agent"} · resumed native session</div>
          )}

          {items.length === 0 && live && <div className="live-row"><span className="spinner" /> Starting…</div>}

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
            <div className="live-row"><span className="spinner" /> Working…</div>
          )}

          {/* Failure surface (v5 §29) */}
          {(run.status === "failed" || run.status === "timeout") && run.errorKind !== "usage-limit" && (
            <div className="fail-box">
              <div className="fail-title">Agent run failed{run.status === "timeout" ? " (timeout)" : ""}</div>
              {run.error && <div className="fail-reason">{run.error}</div>}
              <div className="row fail-actions">
                <button className="small" onClick={onContinue}>Continue</button>
                <button className="small" onClick={onSwitchRuntime}>Switch runtime</button>
                <button className="small" onClick={() => navigate(`/runs/${run.id}`)}>View run</button>
              </div>
            </div>
          )}
          {/* Quota exhaustion is a switch-harness scenario, not a plain
              failure (v6 §10, v7 §14): the workspace and the harness's own
              session survive, so offer the other harnesses directly. */}
          {(run.status === "failed" || run.status === "timeout") && run.errorKind === "usage-limit" && (
            <div className="fail-box quota-box">
              <div className="fail-title">{run.runtimeName ?? "Harness"} usage limit reached.</div>
              {run.error && <div className="fail-reason">{run.error}</div>}
              <p className="muted">
                The workspace and the {run.runtimeName ?? "harness"} session are preserved. Continue on another
                harness: after you confirm, a handoff summary is generated (an explicit action — it is never
                produced implicitly) and the new agent continues in a new native session.
              </p>
              <div className="row fail-actions">
                {otherHarnessTargets.map((t) => (
                  <button key={t.id} className="small primary" onClick={() => onHandoffRequest(t.id)}>
                    Continue with {t.name}
                  </button>
                ))}
                {otherHarnessTargets.length === 0 && (
                  <span className="muted">No other coding harness is enabled — enable a Codex, Claude Code, Pi or OpenCode runtime first.</span>
                )}
                <button className="small" onClick={() => navigate(`/runs/${run.id}`)}>View run</button>
              </div>
            </div>
          )}
          {run.status === "cancelled" && (
            <div className="cancelled-note">Run stopped — the task stays open; send a new instruction below.</div>
          )}

          {/* Artifacts (v5 §31) */}
          {turn.artifacts.length > 0 && (
            <div className="artifact-row">
              <span className="muted artifact-label">Created:</span>
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
                  <Icon name="stop" size={11} /> Stop
                </button>
              </>
            ) : (
              <>
                <StatusBadge status={run.status} />
                <span>{run.runtimeName ?? "—"}</span>
                {turnModelLabel && <span>{turnModelLabel}</span>}
                {run.usage?.durationMs != null && <span>{fmtDuration(run.usage.durationMs)}</span>}
                {run.usage && (
                  <span>{fmtTokens((run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0))} tokens</span>
                )}
                {run.cost ? <span>{fmtCostShort(run.cost)}</span> : null}
                {turn.artifacts.length > 0 && <span>{turn.artifacts.length} artifact{turn.artifacts.length > 1 ? "s" : ""}</span>}
                <a onClick={() => navigate(`/runs/${run.id}`)}>View run ↗</a>
                <button
                  className="turn-handoff"
                  title="Generate a handoff summary so a new native session can continue this task"
                  disabled={handoffDisabled}
                  onClick={onHandoff}
                >
                  ⇄ Handoff
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
        <span className="handoff-mark">⇄ Handoff</span>
        {degraded ? (
          <span className="handoff-degraded" title={handoff.generation?.detail ?? undefined}>
            ⚠ 结构化降级（非模型摘要）
          </span>
        ) : (
          <span className="muted">workspace preserved · new native session</span>
        )}
        <button className="small right" onClick={() => setOpen(!open)}>{open ? "Hide handoff" : "View handoff"}</button>
      </div>
      {degraded && handoff.generation?.detail && (
        <div className="handoff-degraded-detail">原因：{handoff.generation.detail}</div>
      )}
      {open && (
        <div className="handoff-detail">
          <Section title="Current progress">{c.progressSummary}</Section>
          <Section title="Completed work">
            {(c.completedWork ?? []).map((w: string, i: number) => <div key={i}>✓ {w}</div>)}
          </Section>
          <Section title="Remaining work">
            {(c.remainingWork ?? []).map((w: string, i: number) => <div key={i}>• {w}</div>)}
          </Section>
          <Section title="Important decisions">
            {(c.importantDecisions ?? []).map((w: string, i: number) => <div key={i}>• {w}</div>)}
          </Section>
          <Section title="Relevant files">
            {(c.relevantFiles ?? []).map((w: string, i: number) => <code key={i}>{w}</code>)}
          </Section>
          {handoff.userNotes && (
            <Section title="Notes from the user">{handoff.userNotes}</Section>
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
  const [open, setOpen] = useState(false);
  return (
    <div className={`activity thinking${item.content ? " clickable" : ""}`} onClick={() => item.content && setOpen(!open)}>
      <div className="act-head">
        <span className="act-icon">{active ? <span className="spinner" /> : "◍"}</span>
        <span className="act-label">Thinking…</span>
        {item.content && <span className="act-detail-hint">{open ? "hide" : "reasoning"}</span>}
      </div>
      {open && item.content && <pre className="act-detail">{item.content}</pre>}
    </div>
  );
}

function ToolRow({ item, open, onToggle }: { item: ToolActivity; open: boolean; onToggle: () => void }) {
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
              (no arguments or result recorded for this tool call)
            </div>
          )}
          {item.args != null && (
            <>
              <div className="detail-title">Arguments</div>
              <pre>{typeof item.args === "string" ? item.args : JSON.stringify(item.args, null, 2)}</pre>
            </>
          )}
          {item.result != null && (
            <>
              <div className="detail-title">Result</div>
              <pre>{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre>
            </>
          )}
          {item.error && (
            <>
              <div className="detail-title">Error</div>
              <pre className="err">{String(item.error)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CommandRow({ item, open, onToggle }: { item: CommandActivity; open: boolean; onToggle: () => void }) {
  return (
    <div className={`activity clickable command`} onClick={onToggle}>
      <div className="act-head">
        <span className="act-icon">{item.running ? <span className="spinner" /> : <Icon name="terminal" size={13} />}</span>
        <span className="act-label mono-target">Ran <code>{item.command}</code></span>
        {item.summary && (
          <span className={`cmd-summary ${item.summaryOk === false ? "bad" : "good"}`}>{item.summary}</span>
        )}
      </div>
      {open && (
        <div className="act-detail" onClick={(e) => e.stopPropagation()}>
          <div className="detail-title">
            Command {item.cwd ? `· ${item.cwd}` : ""} {item.backend ? `· ${item.backend}` : ""}
          </div>
          <pre>{item.command}</pre>
          <div className="detail-title">
            Output {item.cwd ? `· ${item.cwd}` : ""} {item.backend ? `· ${item.backend}` : ""}
          </div>
          <pre>{item.outputs.length ? item.outputs.join("\n") : "(no output)"}</pre>
        </div>
      )}
    </div>
  );
}

function FileRow({ item }: { item: FileActivity }) {
  return (
    <div className="activity file">
      <div className="act-head">
        <span className="act-icon">{item.action === "created" ? "+" : "±"}</span>
        <span className="act-label">{item.action === "created" ? "Created" : "Modified"} <code>{item.path}</code></span>
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
  const facts: string[] = [];
  if (item.trigger) facts.push(HANDOFF_TRIGGERS[item.trigger] ?? item.trigger);
  facts.push(item.fromHarness ? "harness-generated" : item.method);
  if (item.model) facts.push(item.model);
  if (item.coveredRunIds?.length) {
    facts.push(`covers ${item.coveredRunIds.length} run${item.coveredRunIds.length === 1 ? "" : "s"}`);
  }
  if (item.chunks && item.chunks > 1) facts.push(`${item.chunks} chunks`);
  if (item.usage) facts.push(`${(item.usage.inputTokens + item.usage.outputTokens).toLocaleString()} tok`);
  if (item.durationMs) facts.push(`${(item.durationMs / 1000).toFixed(1)}s`);
  if (item.toRuntime) facts.push(`→ ${item.toRuntime}`);
  if (item.detail) facts.push("⚠ degraded");
  const title = [facts.join(" · "), item.detail ? `Degraded: ${item.detail}` : ""].filter(Boolean).join("\n");
  return (
    <div className="activity handoff">
      <div className="act-head">
        <span className="act-icon">⇄</span>
        <span className="act-label">Handoff generated</span>
        <span className="handoff-facts" title={title}>{facts.join(" · ")}</span>
        <button className="small" onClick={onView}>view</button>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Artifacts (v5 §31)                                                  */
/* ================================================================== */

function ArtifactChip({ artifact }: { artifact: any }) {
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
        setContent("(content unavailable)");
      }
    }
  };
  return (
    <span className="artifact-chip-wrap">
      <button className="artifact-chip" onClick={toggle} title={`${artifact.kind} artifact`}>
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
  const runtimes = useAsync<any[]>(() => get("/api/runtimes"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const providers = useAsync<any[]>(() => get("/api/providers"), []);
  const profiles = useAsync<any[]>(() => get("/api/agents"), []);
  const [prompt, setPrompt] = useState("");
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
  // screen: same-runtime continue when possible, else the built-in Pi
  // runtime; last used model, else first model of the first provider.
  const effectiveRuntimeId = runtimeTouched
    ? runtimeChoice
    : inList(runtimeList, options.data?.targetRuntime?.id)
      ? options.data.targetRuntime.id
      : inList(runtimeList, previousRuntimeId)
        ? previousRuntimeId
        : runtimeList.find((r: any) => r.kind === "pi")?.id ?? runtimeList[0]?.id ?? "";
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
      await post(`/api/tasks/${taskId}/handoff`, {});
      onSubmitted();
      await postContinue(false);
      setPrompt("");
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
          placeholder={live ? "Agent 正在工作 — 可先停止或等待后再继续…" : "随心输入，继续这个任务…"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <div className="composer-bar">
          <select
            ref={runtimeRef}
            className="pill"
            value={effectiveRuntimeId}
            onChange={(e) => selectRuntime(e.target.value)}
            title="Target runtime for the next message"
          >
            {runtimeList.map((r: any) => (
              <option key={r.id} value={r.id}>Runtime: {r.name} ({r.kind})</option>
            ))}
          </select>
          {harnessNativeTarget ? (
            <span
              className="pill harness-native-note"
              title="Harness-native credentials (v6): this runtime runs on its own logged-in account (Codex + ChatGPT) and its own default model."
            >
              Model: harness account (no AgentFabric model)
            </span>
          ) : (
            <select
              className="pill"
              value={effectiveModelId}
              onChange={(e) => { setModelChoice(e.target.value); setModelTouched(true); }}
              title="Model"
            >
              {modelList.map((m: any) => (
                <option key={m.id} value={m.id}>Model: {modelOptionLabel(providerList, m)}</option>
              ))}
            </select>
          )}
          <select className="pill" value={profileId} onChange={(e) => setProfileId(e.target.value)} title="Agent profile">
            <option value="">Agent: none</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>Agent: {p.name}</option>
            ))}
          </select>
          {live && liveRunId && (
            <button className="small danger" onClick={() => onStop(liveRunId)} title="Stop the current run — the task stays open">
              <Icon name="stop" size={11} /> Stop
            </button>
          )}
          <button className="send" title="Continue task (⌘↵)" disabled={busy || live || !prompt.trim()} onClick={() => submit()}>
            {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
