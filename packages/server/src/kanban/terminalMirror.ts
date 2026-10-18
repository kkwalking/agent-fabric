/**
 * Server-side terminal state mirror (v13).
 *
 * A PTY emits a byte stream, not lines: an agent TUI (Claude, OpenCode, Pi)
 * redraws itself with absolute cursor positioning and lives on the alternate
 * screen, so the raw bytes of an hour-long session cannot be replayed into a
 * fresh xterm and scrolled back. Keeping a byte ring buffer makes that worse:
 * dropping the oldest bytes cuts escape sequences in half and the "history"
 * a client gets back is shredded fragments.
 *
 * So the server runs a headless xterm and feeds it the same bytes the client
 * gets. Its scrollback therefore *is* the session history. When a client
 * attaches we serialize that state (`@xterm/addon-serialize`) instead of
 * replaying bytes: the client restores a complete terminal, including the
 * lines the TUI has already scrolled away, and its own scrollback becomes the
 * history the user expects to scroll through.
 *
 * The mirror also answers terminal queries (cursor position, device
 * attributes). Agents ask these while drawing; with no client attached nobody
 * would answer and the renderer would stall waiting on a reply.
 */
import headlessTerminal from "@xterm/headless";
import serializeAddon from "@xterm/addon-serialize";

const { Terminal } = headlessTerminal;
const { SerializeAddon } = serializeAddon;

/** Lines of history kept per session; matches what a client can scroll. */
export const TERMINAL_SCROLLBACK_LINES = 10_000;

export interface TerminalMirrorSnapshot {
  /** Serialized terminal state the client can `write()` directly. */
  snapshot: string;
  cols: number;
  rows: number;
}

export class TerminalMirror {
  private readonly terminal: InstanceType<typeof Terminal>;
  private readonly serialize = new SerializeAddon();
  /** Number of chunks handed to the parser but not yet rendered. */
  private pending = 0;
  /** Resolves once `pending` drops back to zero. */
  private drained: (() => void) | undefined;
  private disposed = false;

  constructor(
    cols: number,
    rows: number,
    options: { onResponse?: (data: string) => void } = {}
  ) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: Math.max(1, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
      scrollback: TERMINAL_SCROLLBACK_LINES,
    });
    this.terminal.loadAddon(this.serialize);
    // A terminal answers its own queries: forward the replies to the agent,
    // otherwise a TUI that asked for the cursor position waits forever.
    this.terminal.onData((data) => options.onResponse?.(data));
  }

  /** Bytes from the PTY, exactly as a client would receive them. */
  write(chunk: Uint8Array): void {
    if (this.disposed) return;
    this.pending += 1;
    // Copy: the caller may reuse its buffer, and the parser reads later.
    this.terminal.write(new Uint8Array(chunk), () => {
      this.pending -= 1;
      if (this.pending === 0) {
        const resolve = this.drained;
        this.drained = undefined;
        resolve?.();
      }
    });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (c === this.terminal.cols && r === this.terminal.rows) return;
    this.terminal.resize(c, r);
  }

  /**
   * Serialized state for a client that just attached.
   *
   * Waits for the chunks already handed to the parser, but not for output that
   * is still arriving: a busy agent would otherwise push the restore frame
   * back indefinitely. Bytes that land after the snapshot follow on the live
   * socket, in order.
   */
  async snapshot(): Promise<TerminalMirrorSnapshot | undefined> {
    if (this.disposed) return undefined;
    if (this.pending > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    }
    if (this.disposed) return undefined;
    return {
      snapshot: this.serialize.serialize(),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  dispose(): void {
    this.disposed = true;
    const resolve = this.drained;
    this.drained = undefined;
    resolve?.();
    this.terminal.dispose();
  }
}
