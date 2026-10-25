/**
 * ACP transport for one board session (v13).
 *
 * DSH has no interactive TUI, so the board cannot hand its screen to xterm.
 * What it does have is an Agent Client Protocol stdio app (`dsh --profile
 * acp`): newline-delimited JSON-RPC 2.0 that creates a session for an
 * absolute cwd, streams committed assistant text / thought chunks / tool
 * lifecycle updates, asks the client for tool permissions, and cancels or
 * closes the turn. This module owns exactly that wire — no board policy.
 *
 * A client speaks JSON-RPC lines on stdout; DSH writes diagnostics to stderr,
 * which is kept as a tail so a failed handshake can explain itself. The
 * process is spawned detached so stopping it kills the harness's own children
 * (MCP servers, subprocesses) with the process group.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/** One permission option as ACP presents it (allow_once, reject_always, …). */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/** A `session/request_permission` the board must answer or show to the user. */
export interface AcpPermissionRequest {
  requestId: string;
  title: string;
  toolCallId?: string;
  options: AcpPermissionOption[];
  /** Server clock at request time; the chat splices the card in order. */
  at: string;
}

/**
 * One `SessionConfigOption` as ACP advertises it: a `select` whose values are
 * either a flat list or one level of groups (DSH groups models by provider).
 * The board renders these as pickers and sends the chosen `value` back
 * verbatim — the wire format is the agent's, not ours.
 */
export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOptionGroup {
  group: string;
  name?: string;
  options: AcpConfigOptionValue[];
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options?: Array<AcpConfigOptionValue | AcpConfigOptionGroup>;
}

/** The subset of `session/update` the board renders; unknown fields pass through. */
export interface AcpUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpSessionOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface AcpExit {
  exitCode: number | null;
  signal: string | null;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const INITIALIZE_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 2_500;

/**
 * One `dsh --profile acp` child process and the JSON-RPC conversation on it.
 *
 * Events:
 * - `update` (AcpUpdate): one session/update notification
 * - `permission` (AcpPermissionRequest): a server→client permission request
 * - `exit` (AcpExit): the process ended (also rejects every pending call)
 */
export class AcpSession extends EventEmitter {
  readonly file: string;
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  /** ACP request ids may be numbers or strings; keep the raw value for answers. */
  private readonly serverRequests = new Map<string, number | string>();
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private sessionIdValue: string | undefined;
  /** The agent advertised `session/resume` in its initialize response. */
  private resumeCapable = false;
  /** Latest configuration the agent advertised (model, reasoning effort, …). */
  private configOptionList: AcpConfigOption[] = [];
  private readonly stderrTail: string[] = [];

  constructor(options: AcpSessionOptions) {
    super();
    this.file = options.file;
    this.child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Separate process group so stop() reaps the harness's children too.
      detached: process.platform !== "win32",
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => this.onStderr(chunk));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code, signal) => this.onClose(code, signal));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return !this.closed;
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  /** Whether this ACP app can attach to a persisted session (`session/resume`). */
  get supportsResume(): boolean {
    return this.resumeCapable;
  }

  /** The configuration options as of the last advertised/updated state. */
  get configOptions(): readonly AcpConfigOption[] {
    return this.configOptionList;
  }

  /** Last few stderr lines, for failure messages. */
  get stderr(): string {
    return this.stderrTail.join("\n");
  }

  async initialize(): Promise<void> {
    const result = (await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          // This client renders and types text only: claiming fs/terminal
          // support would invite server→client requests we cannot answer.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "agent-fabric", title: "AgentFabric", version: "0.1.0" },
      },
      INITIALIZE_TIMEOUT_MS
    )) as
      | { agentCapabilities?: { sessionCapabilities?: { resume?: unknown } } }
      | undefined;
    // Capability presence is the protocol's signal; an app that omits it must
    // not be offered as resumable (the attempt would fail with a JSON-RPC
    // "method not found" instead of a clear board message).
    const resume = result?.agentCapabilities?.sessionCapabilities?.resume;
    this.resumeCapable = resume !== undefined && resume !== null;
  }

  /**
   * Attach to a session persisted by an earlier process. The agent restores
   * the conversation log but does not replay it (that is `session/load`, which
   * DSH does not implement); the board shows its own saved transcript and
   * continues the same model context.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<{ configOptions: AcpConfigOption[] }> {
    if (!this.resumeCapable) {
      throw new Error("This ACP app does not advertise session/resume");
    }
    const result = (await this.request(
      "session/resume",
      { sessionId, cwd, mcpServers: [] },
      SESSION_TIMEOUT_MS
    )) as { configOptions?: unknown } | undefined;
    this.sessionIdValue = sessionId;
    this.setConfigOptions(result?.configOptions);
    return { configOptions: this.configOptionList };
  }

  /** Create a session for an absolute workspace and remember its id. */
  async newSession(cwd: string): Promise<{ sessionId: string; configOptions: AcpConfigOption[] }> {
    const result = (await this.request("session/new", { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS)) as {
      sessionId?: unknown;
      configOptions?: unknown;
    };
    if (typeof result?.sessionId !== "string" || !result.sessionId) {
      throw new Error("ACP session/new returned no sessionId");
    }
    this.sessionIdValue = result.sessionId;
    this.setConfigOptions(result.configOptions);
    return { sessionId: result.sessionId, configOptions: this.configOptionList };
  }

  /**
   * Send one user turn and resolve when the agent settles it. No timeout: a
   * coding turn can legitimately run for a long time; the board's Stop path
   * cancels or stops the process instead.
   */
  async prompt(text: string): Promise<{ stopReason: string }> {
    const sessionId = this.requireSession();
    const result = (await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason?: unknown };
    return { stopReason: typeof result?.stopReason === "string" ? result.stopReason : "unknown" };
  }

  /** Ask the agent to stop the running turn (notification, per ACP). */
  cancel(): void {
    const sessionId = this.sessionIdValue;
    if (!sessionId || this.closed) return;
    this.notify("session/cancel", { sessionId });
  }

  /**
   * Change a model / reasoning effort selection advertised by the session.
   * ACP answers with the complete resulting option state, which is what the
   * board keeps (a concurrent update from the agent wins by arriving last).
   */
  async setConfigOption(configId: string, value: string): Promise<AcpConfigOption[]> {
    const sessionId = this.requireSession();
    const result = (await this.request(
      "session/set_config_option",
      { sessionId, configId, value },
      SESSION_TIMEOUT_MS
    )) as { configOptions?: unknown } | undefined;
    this.setConfigOptions(result?.configOptions);
    return this.configOptionList;
  }

  /**
   * Answer a permission request. `optionId: null` is ACP's cancelled outcome;
   * the prompt turn then settles with `stopReason: "cancelled"`.
   */
  respondPermission(requestId: string, optionId: string | null): void {
    const rawId = this.serverRequests.get(requestId);
    if (rawId === undefined) return;
    this.serverRequests.delete(requestId);
    const result = optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } };
    this.send({ jsonrpc: "2.0", id: rawId, result });
  }

  /** Best-effort ACP close; failure means the process is going away anyway. */
  async close(): Promise<void> {
    const sessionId = this.sessionIdValue;
    if (!sessionId || this.closed) return;
    try {
      await this.request("session/close", { sessionId }, CLOSE_TIMEOUT_MS);
    } catch {
      // Closing is advisory here: stop() terminates the process regardless.
    }
  }

  /** Terminate the process group; SIGKILL if it ignores SIGTERM. */
  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    const pid = this.child.pid;
    if (pid === undefined || this.closed) return;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone; the close event is authoritative.
      }
    }
    const timer = setTimeout(() => {
      if (this.closed) return;
      try {
        if (process.platform === "win32") this.child.kill("SIGKILL");
        else process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    timer.unref();
  }

  /** Replaces the advertised state; malformed entries are dropped, not guessed. */
  private setConfigOptions(value: unknown): void {
    if (!Array.isArray(value)) return;
    this.configOptionList = value.filter((option): option is AcpConfigOption => {
      if (!option || typeof option !== "object") return false;
      const entry = option as { id?: unknown; currentValue?: unknown; type?: unknown };
      return (
        typeof entry.id === "string" &&
        entry.id !== "" &&
        typeof entry.currentValue === "string" &&
        typeof entry.type === "string"
      );
    });
  }

  private requireSession(): string {
    if (!this.sessionIdValue) throw new Error("ACP session is not created yet");
    return this.sessionIdValue;
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP process is not running"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: (result) => {
          if (entry.timer) clearTimeout(entry.timer);
          resolve(result);
        },
        reject: (error) => {
          if (entry.timer) clearTimeout(entry.timer);
          reject(error);
        },
      };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        entry.timer.unref();
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    if (this.closed) return;
    try {
      const written = this.child.stdin?.write(`${JSON.stringify(message)}\n`);
      // `write` on a pipe reports a dead peer asynchronously: the return value is
      // false and the stream emits `error` (EPIPE) on the next tick, which an
      // unhandled stream error turns into a process-level throw. The close event
      // is what actually settles the session, so the write failure itself is not
      // actionable — but it must not escape as an uncaught exception.
      if (written === false) this.child.stdin?.once("error", () => undefined);
    } catch {
      // A closed stdin is reported by the close event; nothing to recover.
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Non-protocol stdout is untrusted noise; ignore it rather than crash.
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    // Server → client request: answer it, never resolve one of our calls.
    if (typeof message.method === "string" && message.id !== undefined && message.id !== null) {
      this.handleServerRequest(message);
      return;
    }
    // Server → client notification.
    if (typeof message.method === "string") {
      if (message.method === "session/update") {
        const params = message.params as { update?: AcpUpdate } | undefined;
        if (params?.update && typeof params.update.sessionUpdate === "string") {
          // A config change can be announced by the agent itself (a preset
          // switch, a route fallback); keep our copy current before emitting.
          if (params.update.sessionUpdate === "config_option_update") {
            this.setConfigOptions(params.update.configOptions);
          }
          this.emit("update", params.update);
        }
      }
      return;
    }
    // Response to one of our requests.
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      const data = message.error.data === undefined ? "" : ` (${JSON.stringify(message.error.data)})`;
      entry.reject(new Error(`${message.error.message ?? "ACP request failed"}${data}`));
      return;
    }
    entry.resolve(message.result);
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    const requestId = String(message.id);
    if (message.method !== "session/request_permission") {
      // We advertise no fs/terminal capabilities, so anything else is either
      // a protocol extension we do not implement or a server bug.
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported ACP client method: ${message.method}` },
      });
      return;
    }
    const params = message.params as
      | {
          toolCall?: { toolCallId?: unknown; title?: unknown };
          options?: unknown;
        }
      | undefined;
    const options = Array.isArray(params?.options)
      ? params!.options
          .map((option) => {
            const value = option as { optionId?: unknown; name?: unknown; kind?: unknown };
            if (typeof value.optionId !== "string" || typeof value.name !== "string") return undefined;
            return {
              optionId: value.optionId,
              name: value.name,
              kind: typeof value.kind === "string" ? value.kind : "unknown",
            };
          })
          .filter((option): option is AcpPermissionOption => option !== undefined)
      : [];
    const toolCall = params?.toolCall;
    const request: AcpPermissionRequest = {
      requestId,
      title: typeof toolCall?.title === "string" && toolCall.title ? toolCall.title : "Tool permission",
      ...(typeof toolCall?.toolCallId === "string" ? { toolCallId: toolCall.toolCallId } : {}),
      options,
      at: new Date().toISOString(),
    };
    this.serverRequests.set(requestId, message.id!);
    this.emit("permission", request);
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.emit("stderr", line);
    }
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.closed = true;
    this.failAll(new Error(`ACP process exited (code ${code ?? "none"}${signal ? `, signal ${signal}` : ""})`));
    this.emit("exit", { exitCode: code, signal } satisfies AcpExit);
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
    for (const requestId of this.serverRequests.keys()) {
      this.serverRequests.delete(requestId);
    }
  }
}
