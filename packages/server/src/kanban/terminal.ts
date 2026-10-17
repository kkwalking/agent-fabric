/**
 * One PTY-backed agent session (v13).
 *
 * The unit is deliberately small: spawn a CLI in a pty, buffer its recent
 * output for terminal replay, forward input/resize, and report the exit. All
 * board/session/agent policy lives one layer up — this module does not know
 * what an "agent" or a "card" is. That keeps the risky part (a live child
 * process) testable with a plain shell.
 *
 * Output is kept as a byte ring buffer, not a string: a chunk can split a
 * UTF-8 sequence, and concatenating decoded chunks would corrupt exactly the
 * glyphs an agent TUI just drew. Replay hands the bytes to xterm, which owns
 * decoding.
 */
import { EventEmitter } from "node:events";
import pty from "node-pty";

/** How much recent output a reattaching client can replay. */
export const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;

export interface TerminalSessionOptions {
  /** Stable id used by the HTTP/WS layer; not interpreted here. */
  id: string;
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  scrollbackBytes?: number;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number;
}

export interface TerminalSnapshot {
  /** Recent PTY output, oldest first. */
  data: Uint8Array;
  cols: number;
  rows: number;
  /** False once the process has exited; the buffer is still replayable. */
  running: boolean;
}

export class TerminalSession extends EventEmitter {
  readonly id: string;
  private readonly proc: pty.IPty;
  private readonly scrollbackBytes: number;
  private buffer: Buffer = Buffer.alloc(0);
  private colsValue: number;
  private rowsValue: number;
  private exitValue: TerminalExit | undefined;

  constructor(options: TerminalSessionOptions) {
    super();
    this.id = options.id;
    this.colsValue = options.cols ?? 80;
    this.rowsValue = options.rows ?? 24;
    this.scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;

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

    this.proc.onData((chunk) => {
      this.append(chunk);
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
    try {
      this.proc.resize(c, r);
    } catch {
      // A resize racing process exit is not a session failure; the exit
      // event is already on its way and the buffer stays replayable.
    }
  }

  /** Replay state for a client that just attached. */
  snapshot(): TerminalSnapshot {
    return {
      data: new Uint8Array(this.buffer),
      cols: this.colsValue,
      rows: this.rowsValue,
      running: this.running,
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

  private append(chunk: string): void {
    const bytes = Buffer.from(chunk, "utf8");
    if (bytes.length >= this.scrollbackBytes) {
      this.buffer = bytes.subarray(bytes.length - this.scrollbackBytes);
      return;
    }
    const merged = Buffer.concat([this.buffer, bytes]);
    this.buffer =
      merged.length > this.scrollbackBytes ? merged.subarray(merged.length - this.scrollbackBytes) : merged;
  }
}
