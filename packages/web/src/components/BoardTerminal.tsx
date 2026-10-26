import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import { useT } from "../i18n-react";
import type { MessageKey } from "../i18n";

/**
 * xterm terminal for one kanban session (v13 §五/§七).
 *
 * One PTY per session, one xterm per open CardDetail: the server replays a
 * `restore` snapshot on every attach, so closing the detail and re-opening it
 * is a clean detach/attach rather than a lost terminal. No auto-reconnect —
 * matches the server's "no auto recapture" rule; the user restarts the card.
 *
 * Frame split: binary frames are raw PTY bytes (both directions), text
 * frames are JSON control messages (`restore` / `exit` / `error`).
 */

/**
 * Terminal typography, copied verbatim from bruce-kanban's
 * `web-ui/src/terminal/terminal-options.ts` so the same Claude Code TUI looks
 * the same in both boards.
 *
 * Two details are easy to get wrong:
 *
 * - `JetBrainsMono Nerd Font` is a *separate family* from `JetBrains Mono`.
 *   Nerd Font builds ship under that name, and only their patched glyphs draw
 *   the powerline separators and icons agent CLIs emit. Without it, machines
 *   that have just the patched build installed silently fall back to Menlo.
 * - The size/line-height pair is not a style preference. xterm derives the cell
 *   height from the font's own bounding box, not from the font size: JetBrains
 *   Mono's box is 1.32em where Menlo's is 1.17em. `lineHeight: 1` therefore
 *   already produces the roomy spacing bruce-kanban shows, and raising it to
 *   1.25 (what this file used with Menlo) would add another 25% of leading.
 */
const TERM_FONT_FAMILY =
  "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'JetBrainsMono Nerd Font', 'SF Mono', Menlo, Monaco, 'Courier New', monospace";
const TERM_FONT_SIZE = 13;
const TERM_LINE_HEIGHT = 1;
const TERM_LETTER_SPACING = 0;

/** Explicit ANSI palette: the app is light-themed, and xterm's defaults are
 *  designed for dark backgrounds. No `invert` — colors are chosen, not
 *  flipped. */
const TERM_THEME = {
  background: "#fbfbfa",
  foreground: "#211f1a",
  cursor: "#211f1a",
  cursorAccent: "#fbfbfa",
  selectionBackground: "rgba(32, 31, 28, 0.18)",
  black: "#211f1a",
  red: "#d1242f",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#2563eb",
  magenta: "#8250df",
  cyan: "#0969da",
  white: "#6e6b62",
  brightBlack: "#a5a296",
  brightRed: "#cf222e",
  brightGreen: "#2da44e",
  brightYellow: "#bf8700",
  brightBlue: "#0969da",
  brightMagenta: "#a475f9",
  brightCyan: "#1b7c83",
  brightWhite: "#211f1a",
};

type TermState = "connecting" | "live" | "exited" | "closed" | "error";

const STATE_LABEL_KEY: Record<TermState, MessageKey> = {
  connecting: "board.term.connecting",
  live: "board.term.live",
  exited: "board.term.exited",
  closed: "board.term.disconnected",
  error: "board.term.error",
};

/**
 * Must match the server's TERMINAL_SCROLLBACK_LINES: the restore payload is
 * the server's scrollback, and a smaller client buffer would silently drop the
 * oldest part of the history the user is trying to scroll to.
 */
const SCROLLBACK_LINES = 10_000;

export interface BoardTerminalProps {
  sessionId: string;
  /** False for agents without an interactive TUI (DSH headless): output only. */
  interactive: boolean;
  /** Fired when the PTY process exits (control frame or socket close after run). */
  onExit?: (info: { exitCode?: number; signal?: string | number }) => void;
}

export function BoardTerminal({ sessionId, interactive, onExit }: BoardTerminalProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<TermState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  /** The effect's socket handlers are created once; they read the live translator. */
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: TERM_FONT_FAMILY,
      fontSize: TERM_FONT_SIZE,
      fontWeight: "normal",
      fontWeightBold: "bold",
      letterSpacing: TERM_LETTER_SPACING,
      lineHeight: TERM_LINE_HEIGHT,
      scrollback: SCROLLBACK_LINES,
      theme: TERM_THEME,
      // Non-interactive agents get a read-only terminal: typing into a
      // headless JSONL stream would go nowhere and mislead the user.
      disableStdin: !interactiveRef.current,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon());

    let disposed = false;
    let size = { cols: 0, rows: 0 };
    let fitTimer: number | undefined;
    let sawExit = false;

    const sendJson = (message: unknown) => {
      const ws = socket;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    /** Fit only when the container is actually laid out: `display:none` or a
     *  0×0 box would propose a bogus 2×1 geometry and corrupt the TUI. */
    const doFit = () => {
      if (disposed || !host.isConnected) return;
      if (host.getClientRects().length === 0) return;
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
      } catch {
        return; // xterm rejects non-positive geometry; the next resize retries
      }
      const cols = term.cols;
      const rows = term.rows;
      if (cols === size.cols && rows === size.rows) return;
      size = { cols, rows };
      sendJson({ type: "resize", cols, rows });
    };

    // 50ms debounce per v13 §七: a drag-resize otherwise floods the PTY.
    const scheduleFit = () => {
      if (fitTimer !== undefined) window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(doFit, 50);
    };

    term.open(host);
    const encoder = new TextEncoder();
    term.onData((data) => {
      const ws = socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Binary frames carry raw PTY input: xterm gives us decoded text, the
      // server's PTY expects UTF-8 bytes (v13 §5.2).
      ws.send(encoder.encode(data));
    });

    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);

    // Fonts settle after first paint; line metrics drive the cell size, so
    // re-fit once they are ready.
    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!disposed) scheduleFit();
      });
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Same-origin socket: the af_token cookie rides along automatically.
    const wsUrl = `${protocol}//${window.location.host}/api/kanban/sessions/${encodeURIComponent(
      sessionId
    )}/terminal`;
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";

    const markExited = (exitCode?: number, signal?: string | number) => {
      if (disposed || sawExit) return;
      sawExit = true;
      setState("exited");
      term.options.disableStdin = true;
      const code =
        exitCode == null ? "" : tRef.current("board.term.exitedCode", { code: exitCode });
      const sig =
        signal == null ? "" : tRef.current("board.term.exitedSignal", { signal: String(signal) });
      term.write(
        `\r\n\x1b[2m${tRef.current("board.term.exitedLine", { code, signal: sig })}\x1b[0m\r\n`
      );
      onExitRef.current?.({ exitCode, signal });
    };

    socket.onopen = () => {
      if (disposed) return;
      // The PTY started at some default size; sync it to the visible terminal.
      size = { cols: 0, rows: 0 };
      doFit();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (disposed) return;
      const data: unknown = event.data;
      if (typeof data === "string") {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return; // ignore unknown text frames rather than crash the terminal
        }
        if (message.type === "restore") {
          if (typeof message.data === "string" && message.data.length > 0) {
            // The server serializes a headless xterm (screen + scrollback), so
            // the payload is terminal text already — not base64 PTY bytes.
            // Writing it restores the whole history the user can scroll.
            term.write(message.data);
          }
          if (message.running === false) {
            markExited();
          } else {
            setState((current) => (current === "exited" || current === "error" ? current : "live"));
          }
          // Restore may have arrived before the first layout pass.
          scheduleFit();
        } else if (message.type === "exit") {
          markExited(
            typeof message.exitCode === "number" ? message.exitCode : undefined,
            (message.signal as string | number | undefined) ?? undefined
          );
        } else if (message.type === "error") {
          const code = typeof message.code === "string" ? message.code : undefined;
          const text =
            typeof message.message === "string"
              ? message.message
              : tRef.current("board.term.genericError");
          setError(code ? `${text} (${code})` : text);
          setState("error");
          term.options.disableStdin = true;
        }
      } else if (data instanceof ArrayBuffer) {
        term.write(new Uint8Array(data));
        if (!sawExit) setState((current) => (current === "connecting" ? "live" : current));
      } else if (data instanceof Blob) {
        // Some browsers deliver binary WS frames as Blobs despite binaryType.
        void data.arrayBuffer().then((buffer) => {
          if (disposed) return;
          term.write(new Uint8Array(buffer));
          if (!sawExit) setState((current) => (current === "connecting" ? "live" : current));
        });
      }
    };

    socket.onerror = () => {
      if (disposed) return;
      setError(tRef.current("board.term.connectFailed"));
      setState("error");
    };

    socket.onclose = () => {
      if (disposed) return;
      setState((current) => (current === "exited" || current === "error" ? current : "closed"));
    };

    return () => {
      disposed = true;
      if (fitTimer !== undefined) window.clearTimeout(fitTimer);
      resizeObserver.disconnect();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="board-term">
      <div className="board-term-bar">
        <span className={`board-term-state ${state}`}>{t(STATE_LABEL_KEY[state])}</span>
        {!interactive && <span className="board-term-note">{t("board.term.outputOnly")}</span>}
        {error && <span className="board-term-err">{error}</span>}
      </div>
      <div className="board-term-host" ref={hostRef} />
    </div>
  );
}
