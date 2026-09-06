import { useEffect, useMemo, useRef, useState } from "react";
import { get, post, subscribeSSE, fmtCostShort, fmtDuration, fmtTokens } from "../api";
import { ErrorBox, Icon, Modal, StatusBadge, useAsync } from "../components";
import { Markdown } from "../markdown";
import {
  findHarnessCommand,
  projectTimeline,
  type AgentMessageItem,
  type CommandActivity,
  type ErrorItem,
  type FileActivity,
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
  runs: ThreadTurn[];
}

/**
 * Optimistic handoff marker shown in the timeline. It appears the moment the
 * user confirms a harness switch (or submits into a handoff) and tracks the
 * generation until the run consuming it lands.
 */
interface PendingHandoff {
  stage: "generating" | "ready";
  from: string;
  to: string;
  /** Runs present in the thread when the handoff started; the marker clears once a new run lands. */
  baseRuns: number;
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const composerPromptRef = useRef<HTMLTextAreaElement>(null);
  const composerRuntimeRef = useRef<HTMLSelectElement>(null);

  const bump = () => setReloadTick((t) => t + 1);

  // Reset only when switching tasks — a refresh (bump) refetches in the
  // background so the timeline stays put while the new state arrives.
  useEffect(() => {
    setThread(null);
    setError(null);
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

  const retryRun = async (runId: string) => {
    await post(`/api/runs/${runId}/rerun`).catch(() => {});
    bump();
  };

  return (
    <div className="task-thread">
      {/* ---------- Thread header (v5 §3/§22/§23) ---------- */}
      <header className="thread-header">
        <div className="thread-title-row">
          <h1 className="thread-title">{thread.task.title}</h1>
          <StatusBadge status={taskStatus} />
          <span className="right thread-actions">
            <button className="icon-btn" title="Refresh" onClick={bump}><Icon name="refresh" /></button>
          </span>
        </div>
        <div className="thread-meta">
          <span className="meta-chip" title={`Workspace ${thread.workspace?.path ?? ""}`}>
            <Icon name="folder" size={13} /> {thread.workspace?.name ?? "no workspace"}
          </span>
          <span className="meta-chip"><Icon name="box" size={13} /> {lastTurn?.run.runtimeName ?? "—"}</span>
          <span className="meta-chip"><Icon name="cpu" size={13} /> {lastTurn?.run.modelName ?? "—"}</span>
          <a className="switch-link" onClick={() => { focusComposer(); composerRuntimeRef.current?.focus(); }}>
            <Icon name="refresh" size={12} /> Switch runtime
          </a>
          <span className="meta-chip muted">{thread.runs.length} {thread.runs.length === 1 ? "run" : "runs"}</span>
        </div>
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
              onRetry={retryRun}
              onContinue={focusComposer}
              onSwitchRuntime={() => { focusComposer(); composerRuntimeRef.current?.focus(); }}
              onStop={stopRun}
            />
          ))}

          {/* Handoff confirmed by the user: generation runs up-front so the
              next submit can go straight to the new harness (v5 §20) */}
          {pendingHandoff && (
            <div className="handoff-banner handoff-pending" aria-live="polite">
              <div className="handoff-line">
                <span className="handoff-mark">
                  {pendingHandoff.stage === "generating" ? <span className="spinner" /> : <span className="handoff-done">✓</span>}
                  Handoff
                </span>
                <strong>{pendingHandoff.from} → {pendingHandoff.to}</strong>
                <span className="muted">
                  {pendingHandoff.stage === "generating"
                    ? `generating context summary · new ${pendingHandoff.to} session…`
                    : `context summary ready — send a message to continue with ${pendingHandoff.to}`}
                </span>
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
        promptRef={composerPromptRef}
        runtimeRef={composerRuntimeRef}
        onStop={stopRun}
        onSubmitted={bump}
        handoffPending={Boolean(pendingHandoff)}
        onHandoffStart={(info) =>
          setPendingHandoff({ stage: "generating", ...info, baseRuns: thread?.runs.length ?? 0 })
        }
        onHandoffReady={() => setPendingHandoff((p) => (p ? { ...p, stage: "ready" } : p))}
        onHandoffAbort={() => setPendingHandoff(null)}
      />
    </div>
  );
}

/* ================================================================== */
/* Turn: User Message → Agent Work → Agent Response (v5 §11)           */
/* ================================================================== */

function TurnView({
  turn,
  task,
  onRetry,
  onContinue,
  onSwitchRuntime,
  onStop,
}: {
  turn: ThreadTurn;
  task: any;
  onRetry: (runId: string) => void;
  onContinue: () => void;
  onSwitchRuntime: () => void;
  onStop: (runId: string) => void;
}) {
  const run = turn.run;
  const live = LIVE_STATUSES.has(run.status);
  const items = useMemo(
    () => projectTimeline(turn.events, { live }),
    [turn.events, live]
  );
  const userPrompt = displayUserPrompt(run, task);
  const harnessCommand = useMemo(() => findHarnessCommand(turn.events), [turn.events]);
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
          {live && <span className="spinner" title="Run in progress" />}
          <span className="agent-badge">{run.runtimeName ?? "Agent"}</span>
          {harnessCommand && (
            <code className="harness-cmd" title={`Launch command · ${harnessCommand.command}`}>
              {harnessCommand.command}
            </code>
          )}
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
            />
          ))}

          {live && items.length > 0 && (
            <div className="live-row"><span className="spinner" /> Working…</div>
          )}

          {/* Failure surface (v5 §29) */}
          {(run.status === "failed" || run.status === "timeout") && (
            <div className="fail-box">
              <div className="fail-title">Agent run failed{run.status === "timeout" ? " (timeout)" : ""}</div>
              {run.error && <div className="fail-reason">{run.error}</div>}
              <div className="row fail-actions">
                <button className="small primary" onClick={() => onRetry(run.id)}>Retry</button>
                <button className="small" onClick={onContinue}>Continue</button>
                <button className="small" onClick={onSwitchRuntime}>Switch runtime</button>
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
                {run.modelName && <span>{run.modelName}</span>}
                {run.usage?.durationMs != null && <span>{fmtDuration(run.usage.durationMs)}</span>}
                {run.usage && (
                  <span>{fmtTokens((run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0))} tokens</span>
                )}
                {run.cost ? <span>{fmtCostShort(run.cost)}</span> : null}
                {turn.artifacts.length > 0 && <span>{turn.artifacts.length} artifact{turn.artifacts.length > 1 ? "s" : ""}</span>}
                <a onClick={() => navigate(`/runs/${run.id}`)}>View run ↗</a>
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
  const from = handoff.fromRuntimeName ?? handoff.fromRuntimeKind ?? "previous agent";
  const to = handoff.toRuntimeName ?? handoff.toRuntimeKind ?? "new runtime";
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
        <strong>{from} → {to}</strong>
        <span className="muted">workspace preserved · new {to} session</span>
        <button className="small right" onClick={() => setOpen(!open)}>{open ? "Hide handoff" : "View handoff"}</button>
      </div>
      {open && (
        <div className="handoff-detail">
          <Section title="Previous agent">{from}</Section>
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
}: {
  item: TimelineItem;
  live: boolean;
  thinkingActive: boolean;
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
  promptRef,
  runtimeRef,
  onStop,
  onSubmitted,
  handoffPending,
  onHandoffStart,
  onHandoffReady,
  onHandoffAbort,
}: {
  taskId: string;
  live: boolean;
  liveRunId?: string;
  defaultModelId?: string;
  previousRuntimeId?: string;
  promptRef: React.RefObject<HTMLTextAreaElement>;
  runtimeRef: React.RefObject<HTMLSelectElement>;
  onStop: (runId: string) => void;
  onSubmitted: () => void;
  handoffPending: boolean;
  onHandoffStart: (info: { from: string; to: string }) => void;
  onHandoffReady: () => void;
  onHandoffAbort: () => void;
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
  /** Runtime picked in the select whose harness differs — awaiting handoff confirmation. */
  const [pendingRuntime, setPendingRuntime] = useState<any | null>(null);

  const runtimeList = runtimes.data ?? [];
  const modelList = models.data ?? [];
  const providerList = providers.data ?? [];
  const profile = (profiles.data ?? []).find((p: any) => p.id === profileId);
  const inList = (list: any[], id?: string) => Boolean(id && list.some((x) => x.id === id));

  // Resume vs Handoff preview for the selected runtime (v5 §18/§19).
  // Untouched, the preview (and the submit below) use the task's default
  // chain; the resolved target runtime is preselected visibly.
  // previousRuntimeId doubles as "latest run changed" — refresh the preview
  // after a run lands so the suggestion never goes stale mid-thread.
  const options = useAsync<any>(
    () => get(`/api/tasks/${taskId}/continue-options${runtimeTouched && runtimeChoice ? `?runtimeId=${runtimeChoice}` : ""}`),
    [taskId, runtimeTouched, runtimeChoice, previousRuntimeId]
  );
  const suggested = options.data?.suggestedMode;

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

  // Switching to a different harness means the next submit performs a
  // handoff, so the selection only commits after explicit confirmation.
  // Cancel is a no-op: the controlled select snaps back to the old value.
  const selectRuntime = (nextId: string) => {
    if (!nextId || nextId === effectiveRuntimeId) return;
    const target = runtimeList.find((r: any) => r.id === nextId);
    const current = options.data?.currentRuntime;
    if (current && target && target.kind !== current.kind) {
      setPendingRuntime(target);
      return;
    }
    // Committing a same-harness selection abandons any prepared handoff.
    if (handoffPending) onHandoffAbort();
    setRuntimeChoice(nextId);
    setRuntimeTouched(true);
  };
  const confirmSwitch = () => {
    if (!pendingRuntime) return;
    const target = pendingRuntime;
    const current = options.data?.currentRuntime;
    setRuntimeChoice(target.id);
    setRuntimeTouched(true);
    setPendingRuntime(null);
    // Confirmed: kick off handoff generation right away so the next submit
    // doesn't stall on it. The marker makes that work visible in the thread.
    onHandoffStart({ from: current?.name ?? current?.kind ?? "current", to: target.name ?? target.kind });
    post(`/api/tasks/${taskId}/handoff`, { runtimeId: target.id })
      .then(() => onHandoffReady())
      .catch(() => onHandoffAbort());
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

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    // Without a confirmed pre-generation, announce the handoff here — it is
    // generated server-side before the run exists, which can take a while.
    const opts = options.data;
    const willHandoff = opts?.suggestedContinuity === "handoff" && opts.currentRuntime && opts.targetRuntime;
    const announceHere = willHandoff && !handoffPending;
    if (announceHere) {
      onHandoffStart({ from: opts.currentRuntime.name ?? opts.currentRuntime.kind, to: opts.targetRuntime.name ?? opts.targetRuntime.kind });
    }
    try {
      await post(`/api/tasks/${taskId}/continue`, {
        prompt: prompt.trim(),
        runtimeId: effectiveRuntimeId || undefined,
        modelId: effectiveModelId || undefined,
        profileId: profileId || undefined,
      });
      setPrompt("");
      onSubmitted();
    } catch (e) {
      if (announceHere) onHandoffAbort();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thread-composer-wrap">
      <ErrorBox message={error} />
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
            title="Target runtime — same harness resumes, different harness hands off"
          >
            {runtimeList.map((r: any) => (
              <option key={r.id} value={r.id}>Runtime: {r.name} ({r.kind})</option>
            ))}
          </select>
          <select
            className="pill"
            value={effectiveModelId}
            onChange={(e) => { setModelChoice(e.target.value); setModelTouched(true); }}
            title="Model"
          >
            {modelList.map((m: any) => (
              <option key={m.id} value={m.id}>Model: {m.alias ?? m.name}</option>
            ))}
          </select>
          <select className="pill" value={profileId} onChange={(e) => setProfileId(e.target.value)} title="Agent profile">
            <option value="">Agent: none</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>Agent: {p.name}</option>
            ))}
          </select>
          {suggested === "resume" && <span className="continuity resume" title={options.data?.explanation}>▶ Resume</span>}
          {suggested === "handoff" && <span className="continuity handoff" title={options.data?.explanation}>⇄ Handoff</span>}
          {live && liveRunId && (
            <button className="small danger" onClick={() => onStop(liveRunId)} title="Stop the current run — the task stays open">
              <Icon name="stop" size={11} /> Stop
            </button>
          )}
          <button className="send" title="Continue task (⌘↵)" disabled={busy || live || !prompt.trim()} onClick={submit}>
            {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={16} />}
          </button>
        </div>
      </div>

      {/* Harness-switch confirmation (v5 §18: continuity explicit before executing) */}
      {pendingRuntime && (
        <Modal title="Switch harness and hand off?" onClose={() => setPendingRuntime(null)}>
          <div className="handoff-confirm">
            <div className="handoff-switch">
              <span className="from" title={options.data?.currentRuntime?.kind}>{options.data?.currentRuntime?.name ?? "Current"}</span>
              <span className="arrow">→</span>
              <span className="to" title={pendingRuntime.kind}>{pendingRuntime.name}</span>
            </div>
            <p>
              Confirming starts the handoff right away: {pendingRuntime.name} will continue in a new session seeded
              with a summary of this task's history. The workspace is preserved — you can type your next message
              while the summary is being generated.
            </p>
            <div className="modal-actions">
              <button onClick={() => setPendingRuntime(null)}>Cancel</button>
              <button className="primary" autoFocus onClick={confirmSwitch}>Switch & hand off</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
