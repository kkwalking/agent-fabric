/**
 * One PTY-backed agent session (v13).
 *
 * The unit is deliberately small: spawn a CLI in a pty, mirror its output for
 * terminal restore, forward input/resize, and report the exit. All
 * board/session/agent policy lives one layer up — this module does not know
 * what an "agent" or a "card" is. That keeps the risky part (a live child
 * process) testable with a plain shell.
 *
 * Output is mirrored into a headless xterm (see terminalMirror.ts) rather than
 * a byte ring buffer: an agent TUI redraws with cursor positioning instead of
 * appending lines, so raw bytes cannot be replayed into a scrollable history
 * and any byte-boundary truncation shreds escape sequences. The mirror's own
 * scrollback is the history a reattaching client restores.
 */
import { EventEmitter } from "node:events";
import pty from "node-pty";
import { TerminalMirror, type TerminalMirrorSnapshot } from "./terminalMirror.js";

export interface TerminalSessionOptions {
  /** Stable id used by the HTTP/WS layer; not interpreted here. */
  id: string;
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number;
}

export interface TerminalSnapshot {
  /**
   * Serialized terminal state (screen + scrollback). Empty when the mirror
   * could not be built; clients then start a blank terminal.
   */
  data: string;
  cols: number;
  rows: number;
  /** False once the process has exited; the snapshot is still restorable. */
  running: boolean;
  /**
   * True when this snapshot is plain serialized text rather than base64 of raw
   * PTY bytes. Always true for current sessions; the field exists so the frame
   * is self-describing.
   */
  serialized: boolean;
}

export class TerminalSession extends EventEmitter {
  readonly id: string;
  private readonly proc: pty.IPty;
  private readonly mirror: TerminalMirror;
  private colsValue: number;
  private rowsValue: number;
  private exitValue: TerminalExit | undefined;

  constructor(options: TerminalSessionOptions) {
    super();
    this.id = options.id;
    this.colsValue = options.cols ?? 80;
    this.rowsValue = options.rows ?? 24;

    // The prompt is delivered by the caller as an argv element; a PTY is a
    // terminal, not a shell string. `--` style separators are the caller's
    // job (agent catalog).
    this.proc = pty.spawn(options.file, options.args, {
      name: "xterm-256color",
      cols: this.colsValue,
      rows: this.rowsValue,
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>,
    });

    // The mirror sees every byte the PTY emits, so its scrollback is the
    // session history a reattaching client restores. Replies to terminal
    // queries go straight back to the agent: without a client attached nobody
    // else would answer them.
    this.mirror = new TerminalMirror(this.colsValue, this.rowsValue, {
      onResponse: (data) => this.write(data),
    });

    this.proc.onData((chunk) => {
      this.mirror.write(Buffer.from(chunk, "utf8"));
      this.emit("data", chunk);
    });
    this.proc.onExit((event) => {
      this.exitValue = { exitCode: event.exitCode, signal: event.signal };
      this.emit("exit", this.exitValue);
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  get running(): boolean {
    return this.exitValue === undefined;
  }

  get exit(): TerminalExit | undefined {
    return this.exitValue;
  }

  get cols(): number {
    return this.colsValue;
  }

  get rows(): number {
    return this.rowsValue;
  }

  /** Forward keyboard/paste bytes from a terminal client. */
  write(data: string): void {
    if (!this.running) return;
    this.proc.write(data);
  }

  /** Keep the PTY's window size in lockstep with the visible xterm. */
  resize(cols: number, rows: number): void {
    if (!this.running) return;
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (c === this.colsValue && r === this.rowsValue) return;
    this.colsValue = c;
    this.rowsValue = r;
    // The mirror must follow the geometry, or the restored screen has the
    // wrong width and wraps every line the TUI drew.
    this.mirror.resize(c, r);
    try {
      this.proc.resize(c, r);
    } catch {
      // A resize racing process exit is not a session failure; the exit
      // event is already on its way and the snapshot stays restorable.
    }
  }

  /**
   * Restore state for a client that just attached. The serialized terminal is
   * the whole session history: screen plus scrollback.
   */
  async snapshot(): Promise<TerminalSnapshot> {
    const snap: TerminalMirrorSnapshot | undefined = await this.mirror.snapshot();
    return {
      data: snap?.snapshot ?? "",
      cols: snap?.cols ?? this.colsValue,
      rows: snap?.rows ?? this.rowsValue,
      running: this.running,
      serialized: true,
    };
  }

  /**
   * Stop the whole process group, not just the harness parent: agents spawn
   * children (MCP servers, test runners) that would otherwise outlive the
   * session as orphans. Falls back to the PTY's own kill when the negative
   * pid is not usable (already reaped).
   */
  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.running) return;
    try {
      process.kill(-this.proc.pid, signal);
    } catch {
      try {
        this.proc.kill(signal);
      } catch {
        // Already gone; the exit event is authoritative.
      }
    }
  }

  /** Release the mirror. The serialized state cannot be read after this. */
  dispose(): void {
    this.mirror.dispose();
  }
}
