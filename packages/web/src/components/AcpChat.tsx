import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../components";
import { Markdown } from "../markdown";
import type { ChatItem, PermissionRequest } from "./board/types";

/**
 * Interactive chat for one DSH kanban session, spoken over ACP.
 *
 * The server owns the agent process (`dsh --profile acp`) and exposes it on
 * `/api/kanban/sessions/:id/agent` as JSON text frames: a replay snapshot on
 * attach, then item/status/permission/error frames. One socket per open card
 * detail — closing the detail detaches, the server keeps the session. No
 * auto-reconnect: same rule as BoardTerminal, and a session that died with
 * the server process must read as an error rather than a silent empty chat.
 */

/** Socket lifecycle, distinct from the agent's own session status. */
type LinkState = "connecting" | "open" | "closed" | "error";

/** What the header pill shows, mirroring BoardTerminal's dot vocabulary. */
type PillState =
  | "connecting"
  | "live"
  | "working"
  | "idle"
  | "attention"
  | "exited"
  | "disconnected"
  | "error";

const PILL_LABEL: Record<PillState, string> = {
  connecting: "connecting…",
  live: "live",
  working: "working",
  idle: "idle",
  attention: "needs attention",
  exited: "exited",
  disconnected: "disconnected",
  error: "error",
};

type ClientFrame =
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  | { type: "permission"; requestId: string; optionId: string | null }
  | { type: "stop" };

type ServerFrame =
  | {
      type: "agent_snapshot";
      items: ChatItem[];
      status: string;
      running: boolean;
      nativeSessionId?: string;
      permissions: PermissionRequest[];
    }
  | { type: "agent_item"; item: ChatItem }
  | { type: "agent_status"; status: string; running: boolean }
  | { type: "agent_permission"; request: PermissionRequest }
  | { type: "agent_permission_answered"; requestId: string }
  | { type: "agent_error"; code?: string; message: string };

/** Unknown or malformed frames are ignored, like the terminal's WS handler. */
function parseFrame(raw: string): ServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  switch (type) {
    case "agent_snapshot":
    case "agent_item":
    case "agent_status":
    case "agent_permission":
    case "agent_permission_answered":
    case "agent_error":
      return value as ServerFrame;
    default:
      return null;
  }
}

/** ISO `at` → ms; an unparseable timestamp sorts last instead of jumping up. */
function atMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function pillState(link: LinkState, running: boolean, status: string | null): PillState {
  if (link === "error") return "error";
  if (link === "closed") return "disconnected";
  if (link === "connecting") return "connecting";
  // The snapshot is the attach confirmation; don't claim "live" before it.
  if (status === null) return "connecting";
  // A turn blocked on a permission answer is waiting on the human, not busy.
  if (status === "needs_attention") return "attention";
  if (running) return "working";
  switch (status) {
    case "starting":
      return "connecting";
    case "awaiting_review":
      return "idle";
    case "failed":
    case "interrupted":
    case "stopped":
      return "exited";
    default:
      return "live";
  }
}

type TimelineEntry =
  | { key: string; at: number; kind: "item"; item: ChatItem }
  | { key: string; at: number; kind: "permission"; request: PermissionRequest };

/**
 * Items arrive in replay/arrival order and must not be re-sorted; permissions
 * only carry their own `at`, so splice each one in before the first item that
 * started later. That keeps a prompt where it interrupted the conversation
 * instead of pinning every answered prompt to the bottom forever.
 */
function buildTimeline(items: ChatItem[], permissions: PermissionRequest[]): TimelineEntry[] {
  const entries: TimelineEntry[] = items.map((item) => ({
    key: `item:${item.id}`,
    at: atMs(item.at),
    kind: "item",
    item,
  }));
  const requests = [...permissions].sort((a, b) => atMs(a.at) - atMs(b.at));
  for (const request of requests) {
    const at = atMs(request.at);
    const index = entries.findIndex((entry) => entry.at > at);
    entries.splice(index === -1 ? entries.length : index, 0, {
      key: `permission:${request.requestId}`,
      at,
      kind: "permission",
      request,
    });
  }
  return entries;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export interface AcpChatProps {
  sessionId: string;
}

export function AcpChat({ sessionId }: AcpChatProps) {
  const [link, setLink] = useState<LinkState>("connecting");
  /** Server-side session status (starting/running/awaiting_review/…). */
  const [status, setStatus] = useState<string | null>(null);
  /** Whether a turn is in flight — the composer is locked while it is. */
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  /** Requests already answered locally: buttons stay disabled until replay. */
  const [answered, setAnswered] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Mirrors `error` so the socket-close handler can pick the right pill. */
  const errorRef = useRef<string | null>(null);
  const showError = (message: string) => {
    errorRef.current = message;
    setError(message);
  };
  const clearError = () => {
    if (errorRef.current === null) return;
    errorRef.current = null;
    setError(null);
  };

  const socketRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  /** Auto-scroll only while the reader is at the bottom; reading history must
   *  not be yanked away by streaming items. */
  const stickRef = useRef(true);

  useEffect(() => {
    let disposed = false;

    const handle = (frame: ServerFrame) => {
      switch (frame.type) {
        case "agent_snapshot":
          // Frames only flow while attached; a later frame means the error was
          // not fatal (the server keeps the socket open for a rejected prompt).
          clearError();
          setItems(Array.isArray(frame.items) ? frame.items : []);
          setPermissions(Array.isArray(frame.permissions) ? frame.permissions : []);
          setAnswered({});
          setStatus(frame.status);
          setRunning(frame.running);
          break;
        case "agent_item":
          clearError();
          // Contract upsert: a chunk update replaces the same item wholesale.
          setItems((current) => {
            const index = current.findIndex((item) => item.id === frame.item.id);
            if (index === -1) return [...current, frame.item];
            const next = current.slice();
            next[index] = frame.item;
            return next;
          });
          break;
        case "agent_status":
          clearError();
          setStatus(frame.status);
          setRunning(frame.running);
          break;
        case "agent_permission":
          clearError();
          setPermissions((current) => [
            ...current.filter((request) => request.requestId !== frame.request.requestId),
            frame.request,
          ]);
          break;
        case "agent_permission_answered":
          // Another tab answered it; keep the card as history but disable it.
          setAnswered((current) => ({ ...current, [frame.requestId]: true }));
          break;
        case "agent_error":
          // Reported as a message now; `onclose` decides whether the link is
          // dead, because this frame is not always followed by a close.
          showError(frame.code ? `${frame.message} (${frame.code})` : frame.message);
          // "busy" only rejects a prompt while a turn is still running.
          if (frame.code !== "kanban-agent-busy") setRunning(false);
          break;
      }
    };

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Same-origin socket: the af_token cookie rides along automatically.
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api/kanban/sessions/${encodeURIComponent(sessionId)}/agent`
    );
    socketRef.current = socket;

    socket.onopen = () => {
      if (!disposed) setLink("open");
    };

    socket.onmessage = (event: MessageEvent) => {
      if (disposed || typeof event.data !== "string") return;
      const frame = parseFrame(event.data);
      if (frame) handle(frame);
    };

    socket.onerror = () => {
      if (disposed) return;
      // The browser hides the reason; surface a failed attach instead of
      // showing an empty chat as if the session were healthy.
      showError(errorRef.current ?? "chat connection failed");
      setLink("error");
    };

    socket.onclose = () => {
      if (disposed) return;
      setRunning(false);
      // A close after an error frame is that error; a plain close is a detach.
      setLink(errorRef.current === null ? "closed" : "error");
    };

    return () => {
      disposed = true;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const log = logRef.current;
    if (!log || !stickRef.current) return;
    log.scrollTop = log.scrollHeight;
  }, [items, permissions]);

  const send = (frame: ClientFrame) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const onLogScroll = () => {
    const log = logRef.current;
    if (!log) return;
    stickRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  };

  const pill = pillState(link, running, status);
  const dead = link === "error" || link === "closed" || pill === "exited";
  const live = link === "open" && !dead;
  const canPrompt = live && !running && draft.trim().length > 0;

  const submit = () => {
    const text = draft.trim();
    if (!text || !live || running) return;
    send({ type: "prompt", text });
    setDraft("");
  };

  const onDraftKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a newline; Cmd/Ctrl+Enter arrives here as
    // plain Enter and therefore sends too.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const answerPermission = (request: PermissionRequest, optionId: string) => {
    if (request.requestId in answered) return;
    send({ type: "permission", requestId: request.requestId, optionId });
    setAnswered((current) => ({ ...current, [request.requestId]: true }));
  };

  const timeline = useMemo(() => buildTimeline(items, permissions), [items, permissions]);

  return (
    <div className="acp-chat">
      <div className="acp-bar">
        <span className={`acp-state ${pill}`}>{PILL_LABEL[pill]}</span>
        {running && <span className="spinner" aria-hidden />}
        <span className="acp-note">DSH · interactive session</span>
        {live && (
          <button
            className="small acp-bar-stop"
            title="Stop the agent process for this card"
            onClick={() => send({ type: "stop" })}
          >
            Stop
          </button>
        )}
      </div>

      <div className="acp-log" ref={logRef} onScroll={onLogScroll}>
        {timeline.length === 0 && link === "connecting" && (
          <div className="acp-empty muted">Connecting to the session…</div>
        )}
        {timeline.length === 0 && link === "open" && (
          <div className="acp-empty muted">No messages yet.</div>
        )}
        {timeline.map((entry) =>
          entry.kind === "item" ? (
            <ChatItemRow key={entry.key} item={entry.item} />
          ) : (
            <PermissionCard
              key={entry.key}
              request={entry.request}
              answered={entry.request.requestId in answered}
              disabled={dead}
              onAnswer={(optionId) => answerPermission(entry.request, optionId)}
            />
          )
        )}
      </div>

      <div className="acp-composer">
        {error && (
          <div className="acp-error-line" role="alert">
            {error}
          </div>
        )}
        {dead && (
          <div className="acp-dead">
            This session is not live in this server process — start a new session from the card
            actions.
          </div>
        )}
        <textarea
          className="acp-input"
          value={draft}
          rows={3}
          placeholder={
            live ? "Reply to the agent…" : dead ? "Session is not live" : "Waiting for the session…"
          }
          disabled={!live || running}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onDraftKeyDown}
        />
        <div className="acp-actions">
          <span className="acp-hint">
            {running
              ? "The agent is working…"
              : dead
                ? ""
                : "Enter to send · Shift+Enter for a new line"}
          </span>
          {running ? (
            <button
              className="danger"
              onClick={() => send({ type: "cancel" })}
              title="Cancel the running turn"
            >
              Cancel
            </button>
          ) : (
            <button className="primary" disabled={!canPrompt} onClick={submit}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Conversation rows                                                   */
/* ------------------------------------------------------------------ */

function ChatItemRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="acp-user">
          <div className="user-bubble">{item.text}</div>
        </div>
      );
    case "agent":
      return (
        <div className="acp-agent">
          <Markdown text={item.text} />
        </div>
      );
    case "reasoning":
      // Collapsed by default: reasoning is context, not the answer.
      return (
        <details className="acp-reasoning">
          <summary>Thinking</summary>
          <Markdown text={item.text} />
        </details>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "error":
      return <div className="acp-item-error">{item.message}</div>;
  }
}

function ToolRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const input = item.input == null ? "" : jsonText(item.input);
  const hasDetail = input !== "" || Boolean(item.output) || Boolean(item.error);

  // `summary` only allows phrasing content, so the flex row is a span.
  const head = (
    <span className="acp-tool-head">
      {item.status === "running" ? (
        <span className="spinner acp-tool-spin" aria-hidden />
      ) : (
        <span className={`acp-tool-dot ${item.status}`} aria-hidden />
      )}
      <span className="acp-tool-title">{item.title || item.toolCallId}</span>
      {item.toolKind && <span className="acp-tool-kind">{item.toolKind}</span>}
      {hasDetail && (
        <span className="acp-tool-chev" aria-hidden>
          <Icon name="chevron" size={12} />
        </span>
      )}
    </span>
  );

  if (!hasDetail) return <div className={`acp-tool ${item.status}`}>{head}</div>;

  return (
    <details className={`acp-tool ${item.status}`}>
      <summary>{head}</summary>
      <div className="acp-tool-body">
        {input !== "" && (
          <>
            <div className="acp-tool-label">Input</div>
            <pre>{input}</pre>
          </>
        )}
        {item.output && (
          <>
            <div className="acp-tool-label">Output</div>
            <pre>{item.output}</pre>
          </>
        )}
        {item.error && (
          <>
            <div className="acp-tool-label">Error</div>
            <pre className="err">{item.error}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function PermissionCard({
  request,
  answered,
  disabled,
  onAnswer,
}: {
  request: PermissionRequest;
  answered: boolean;
  disabled: boolean;
  onAnswer: (optionId: string) => void;
}) {
  return (
    <div className={`acp-permission${answered ? " answered" : ""}`}>
      <div className="acp-permission-title">
        <Icon name="key" size={14} />
        <span>{request.title}</span>
      </div>
      {request.toolCallId && <div className="acp-permission-tool mono">{request.toolCallId}</div>}
      <div className="acp-permission-actions">
        {request.options.map((option) => (
          <button
            key={option.optionId}
            // allow_* is the safe/expected choice; reject_*/cancel_* is not.
            className={/^(reject|cancel)/.test(option.kind) ? "danger" : "primary"}
            disabled={answered || disabled}
            onClick={() => onAnswer(option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
      <div className="acp-permission-note">
        {answered ? "Answer sent." : disabled ? "Session is not live." : "Waiting for your answer."}
      </div>
    </div>
  );
}
