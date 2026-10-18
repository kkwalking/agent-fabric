/**
 * Server-side owner of live kanban sessions (v13).
 *
 * The service layer owns records; this layer owns processes. One session is one
 * agent process at a time; clients attach/detach freely, and the process keeps
 * running when the browser closes (a card's agent must survive a page refresh).
 *
 * Two execution modes share this path:
 * - `direct`: the agent runs in the board project folder itself. Multiple
 *   cards may run at once by design (the user asked for it); concurrent edits
 *   are the agents' problem, not a platform lock.
 * - `worktree`: a detached `git worktree` checkout under the data directory,
 *   so parallel cards do not share a working tree.
 *
 * Two transports share it too:
 * - `pty`: the agent is a TUI and its bytes go to xterm (Claude/Pi/OpenCode).
 * - `acp`: the agent is an ACP stdio server and the board renders the
 *   conversation itself (DSH; it ships no TUI).
 *
 * Hooks (Claude / OpenCode) call back with a per-session capability token; the
 * token only moves its own card and is dropped with the session. ACP reports
 * its own turn end, so it needs no external hook.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { DomainError } from "@agentfabric/core";
import type { ID, KanbanCard, KanbanProject, KanbanSession, KanbanSessionStatus } from "@agentfabric/core";
import type { KanbanService } from "@agentfabric/core";
import { assertKanbanAgentAvailable, buildKanbanLaunch, type KanbanLaunch } from "./agents.js";
import { cleanupKanbanHooks, prepareKanbanHooks } from "./hooks.js";
import { TerminalSession, type TerminalSnapshot } from "./terminal.js";
import { createKanbanWorktree, kanbanWorktreePath, removeKanbanWorktree } from "./worktree.js";
import { AcpSession, type AcpExit, type AcpPermissionRequest, type AcpUpdate } from "./acp.js";
import { AcpChatProjector } from "./acpChat.js";

export interface KanbanSessionRuntimeOptions {
  dataDir: string;
  /** Absolute callback base, e.g. http://127.0.0.1:7377/kanban-hooks/ingest. */
  hookBaseUrl: string;
}

const ACTIVE_STATUSES: readonly KanbanSessionStatus[] = [
  "starting",
  "running",
  "awaiting_review",
  "needs_attention",
];

export type KanbanHookEvent = "to_review" | "to_in_progress" | "needs_attention";

/** Per-session state of one ACP conversation (in memory only). */
interface AcpState {
  session: KanbanSession;
  card: KanbanCard;
  acp: AcpSession;
  projector: AcpChatProjector;
  sockets: Set<WebSocket>;
  /** Permission requests the agent is waiting on, keyed by the wire request id. */
  permissions: Map<string, AcpPermissionRequest>;
  /** The ACP handshake and session/new completed; prompts are accepted. */
  ready: boolean;
  /** A prompt turn is in flight (the card is "working"). */
  running: boolean;
  /** stop()/shutdown asked this session to end; exit must not rewrite records. */
  stopping: boolean;
  /** The process already exited; late prompt rejections must not settle twice. */
  exited: boolean;
}

export class KanbanSessionRuntime {
  private readonly terminals = new Map<ID, TerminalSession>();
  private readonly acpStates = new Map<ID, AcpState>();
  private readonly stopping = new Set<ID>();
  private readonly hookTokens = new Map<ID, { token: string; dir?: string }>();
  /**
   * Set during process shutdown. A SIGTERM'd PTY reports `exitCode: 0` with
   * `signal: 15` on Unix — indistinguishable from a clean finish unless the
   * runtime knows why it died. During shutdown we must not rewrite records at
   * all: the next boot's recoverInterrupted is what tells the truth.
   */
  private shuttingDown = false;

  constructor(
    private readonly kanban: KanbanService,
    private readonly options: KanbanSessionRuntimeOptions
  ) {}

  /** Live PTY for a session, if this process still owns one. */
  terminalFor(sessionId: ID): TerminalSession | undefined {
    return this.terminals.get(sessionId);
  }

  isLive(sessionId: ID): boolean {
    const terminal = this.terminals.get(sessionId);
    if (terminal !== undefined && terminal.running) return true;
    const acp = this.acpStates.get(sessionId);
    return acp !== undefined && !acp.exited && acp.acp.running;
  }

  async start(cardId: ID): Promise<KanbanSession> {
    const card = this.kanban.getCard(cardId);
    const project = this.kanban.getProject(card.projectId);

    if (card.column === "trash") {
      throw new DomainError("kanban-session-not-startable", "Restore the card from Done before starting it");
    }

    const previous = this.kanban.latestSessionForCard(card.id);
    if (previous && this.isLive(previous.id)) {
      throw new DomainError("kanban-session-not-startable", "This card already has a running session");
    }

    await assertKanbanAgentAvailable(card);

    const launch = buildKanbanLaunch(card, project);
    const pendingWorktree = card.executionMode === "worktree";
    let cwd = project.rootPath;
    let worktreeCreated = false;

    // Create the record first so every subsequent failure has somewhere to be
    // recorded; the worktree path is keyed by the persistent session id.
    const session = await this.kanban.createSession(card, {
      cwd,
      interactiveTui: launch.interactiveTui,
      transport: launch.transport,
    });

    if (pendingWorktree) {
      cwd = kanbanWorktreePath(this.options.dataDir, session.id);
      await this.kanban.updateSession(session.id, { cwd });
      try {
        await createKanbanWorktree({
          rootPath: project.rootPath,
          targetPath: cwd,
          ...(card.baseRef ? { baseRef: card.baseRef } : {}),
        });
        worktreeCreated = true;
      } catch (err) {
        await this.kanban.settleSession(session.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    if (launch.transport === "acp") {
      return this.startAcp({ card, project, launch, session, cwd, worktreeCreated });
    }

    const hookToken = randomBytes(24).toString("hex");
    let hookSetup: Awaited<ReturnType<typeof prepareKanbanHooks>>;
    try {
      hookSetup = await prepareKanbanHooks({
        agentId: card.agentId,
        dataDir: this.options.dataDir,
        sessionId: session.id,
        baseUrl: this.options.hookBaseUrl,
        token: hookToken,
      });
    } catch (err) {
      if (worktreeCreated) await removeKanbanWorktree(project.rootPath, cwd);
      await this.kanban.settleSession(session.id, {
        status: "failed",
        error: `Could not prepare ${card.agentId} hooks: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
    this.hookTokens.set(session.id, { token: hookToken, dir: hookSetup.dir });

    // Mark the session running before spawning: a harness hook can fire the
    // instant the process starts, and it must not be overwritten by a later
    // "running" write. A spawn failure settles the record as failed below.
    await this.kanban.updateSession(session.id, { status: "running" });

    let terminal: TerminalSession;
    try {
      terminal = new TerminalSession({
        id: session.id,
        file: launch.file,
        args: [...launch.args, ...hookSetup.extraArgs],
        cwd,
        env: { ...launch.env, ...hookSetup.extraEnv },
      });
    } catch (err) {
      if (worktreeCreated) await removeKanbanWorktree(project.rootPath, cwd);
      await cleanupKanbanHooks(hookSetup.dir);
      this.hookTokens.delete(session.id);
      await this.kanban.settleSession(session.id, {
        status: "failed",
        error: `Could not start ${launch.file}: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw new DomainError(
        "agent-start-failed",
        `Could not start ${launch.file}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    this.terminals.set(session.id, terminal);
    terminal.on("exit", (event: { exitCode: number; signal?: number }) => {
      void this.onExit(session, event);
    });

    return this.kanban.getSession(session.id);
  }

  /**
   * Boot the ACP app, create its session for the card's working directory and
   * send the card prompt as the first turn. The process stays alive after the
   * turn so the card can continue the conversation; the record is only settled
   * when the process ends or the user stops the card.
   */
  private async startAcp(input: {
    card: KanbanCard;
    project: KanbanProject;
    launch: KanbanLaunch;
    session: KanbanSession;
    cwd: string;
    worktreeCreated: boolean;
  }): Promise<KanbanSession> {
    const { card, project, launch, session, cwd, worktreeCreated } = input;
    const acp = new AcpSession({ file: launch.file, args: launch.args, cwd, env: launch.env });
    const state: AcpState = {
      session,
      card,
      acp,
      projector: new AcpChatProjector(),
      sockets: new Set(),
      permissions: new Map(),
      ready: false,
      running: false,
      stopping: false,
      exited: false,
    };
    this.acpStates.set(session.id, state);
    acp.on("update", (update: AcpUpdate) => {
      const item = state.projector.applyUpdate(update);
      if (item) this.broadcast(state, { type: "agent_item", item });
    });
    acp.on("permission", (request: AcpPermissionRequest) => {
      this.background(this.onAcpPermission(state, request), "ACP permission handling");
    });
    acp.on("exit", (event: AcpExit) => {
      this.background(this.onAcpExit(state, event), "ACP exit handling");
    });

    try {
      await acp.initialize();
      const created = await acp.newSession(cwd);
      state.ready = true;
      state.session = await this.kanban.updateSession(session.id, {
        status: "running",
        nativeSessionId: created.sessionId,
      });
    } catch (err) {
      this.acpStates.delete(session.id);
      acp.stop();
      if (worktreeCreated) await removeKanbanWorktree(project.rootPath, cwd);
      const detail = acp.stderr ? `\n${acp.stderr}` : "";
      const message = `Could not start ${launch.file} over ACP: ${
        err instanceof Error ? err.message : String(err)
      }${detail}`;
      await this.kanban.settleSession(session.id, { status: "failed", error: message });
      throw new DomainError("agent-start-failed", message);
    }

    // The board already knows the prompt; ACP's update stream does not echo it,
    // so the transcript starts with the user's turn.
    this.background(this.runAcpPrompt(state, card.prompt), "ACP first prompt");
    return this.kanban.getSession(session.id);
  }

  /**
   * Runs a driver background task without letting a rejection become an
   * unhandled one (the process may be shutting down under it). The failure is
   * logged; the affected session record is already settled by its own path.
   */
  private background(task: Promise<unknown>, what: string): void {
    void task.catch((err: unknown) => {
      console.warn(`[agent-fabric] ${what} failed:`, err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Send one turn and settle it. ACP permits one in-flight prompt per session,
   * so callers check `state.running` first (the composer is disabled too).
   */
  private async runAcpPrompt(state: AcpState, text: string): Promise<void> {
    if (!state.ready || state.running || state.stopping || state.exited) return;
    state.running = true;
    const userItem = state.projector.addUser(text);
    this.broadcast(state, { type: "agent_item", item: userItem });

    try {
      state.session = await this.kanban.updateSession(state.session.id, {
        status: "running",
        lastHookEvent: "prompt",
        lastHookAt: new Date().toISOString(),
      });
      await this.kanban.setColumn(state.card.id, "in_progress");
      this.broadcastStatus(state);

      const result = await state.acp.prompt(text);
      state.running = false;
      if (state.stopping || state.exited) return;
      if (result.stopReason === "end_turn" || result.stopReason === "cancelled") {
        // A finished (or user-cancelled) turn is the board's "Review" signal.
        // The process stays alive: reopening the card continues the session.
        state.session = await this.kanban.updateSession(state.session.id, {
          status: "awaiting_review",
          lastHookEvent: result.stopReason === "cancelled" ? "turn_cancelled" : "turn_end",
          lastHookAt: new Date().toISOString(),
        });
        await this.kanban.setColumn(state.card.id, "review");
      } else {
        const message = `Turn ended with stop reason "${result.stopReason}"`;
        state.session = await this.kanban.updateSession(state.session.id, {
          status: "failed",
          error: message,
          lastHookEvent: "turn_failed",
          lastHookAt: new Date().toISOString(),
        });
        const item = state.projector.addError(message);
        this.broadcast(state, { type: "agent_item", item });
      }
      this.broadcastStatus(state);
    } catch (err) {
      state.running = false;
      // A process death is reported by onAcpExit with the exit code; settling
      // here too would race it with a less specific message.
      if (state.stopping || state.exited) return;
      const message = err instanceof Error ? err.message : String(err);
      state.session = await this.kanban.updateSession(state.session.id, {
        status: "failed",
        error: message,
        lastHookEvent: "turn_error",
        lastHookAt: new Date().toISOString(),
      });
      const item = state.projector.addError(message);
      this.broadcast(state, { type: "agent_item", item });
      this.broadcastStatus(state);
    }
  }

  /**
   * ACP asks before a sensitive tool runs. "Auto-approve" answers immediately;
   * otherwise the request is exposed to the card and the session is marked
   * `needs_attention` (the spec's "waiting on a human" state, not a finish).
   */
  private async onAcpPermission(state: AcpState, request: AcpPermissionRequest): Promise<void> {
    if (state.stopping || state.exited) return;
    const card = this.kanban.getCard(state.card.id);
    if (card.permissionModeId === "auto") {
      const allow =
        request.options.find((option) => option.kind === "allow_always") ??
        request.options.find((option) => option.kind === "allow_once");
      if (allow) {
        state.acp.respondPermission(request.requestId, allow.optionId);
        return;
      }
    }
    state.permissions.set(request.requestId, request);
    state.session = await this.kanban.updateSession(state.session.id, {
      status: "needs_attention",
      lastHookEvent: "permission_request",
      lastHookAt: new Date().toISOString(),
    });
    this.broadcastStatus(state);
    this.broadcast(state, { type: "agent_permission", request });
  }

  private async onAcpExit(state: AcpState, event: AcpExit): Promise<void> {
    state.exited = true;
    // The turn cannot be in flight once the process is gone: clear the flag
    // before any frame so the UI never shows "working" on a dead session.
    state.running = false;
    this.acpStates.delete(state.session.id);
    state.permissions.clear();
    // stop() records the reason but only the exit proves the process is gone;
    // drop its marker so it cannot outlive the session.
    const wasStopped = this.stopping.delete(state.session.id);
    // During shutdown the next boot's recoverInterrupted owns the record; a
    // stop() already settled the record and only awaits its exit.
    if (this.shuttingDown) return;
    if (state.stopping || wasStopped) return;
    if (state.session.status === "stopped") return;
    const message = `Agent exited (code ${event.exitCode ?? "none"}${event.signal ? `, signal ${event.signal}` : ""})`;
    await this.kanban.settleSession(state.session.id, {
      status: "failed",
      ...(event.exitCode !== null && event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      error: message,
    });
    const item = state.projector.addError(message);
    this.broadcast(state, { type: "agent_item", item });
    this.broadcastStatus(state);
  }

  async stop(sessionId: ID): Promise<KanbanSession> {
    const acp = this.acpStates.get(sessionId);
    if (acp) {
      acp.stopping = true;
      this.stopping.add(sessionId);
      for (const request of acp.permissions.values()) {
        acp.acp.respondPermission(request.requestId, null);
      }
      acp.permissions.clear();
      // Keep the state until the process actually exits: isLive() must not
      // claim the slot is free while the old agent still holds the workspace.
      try {
        await acp.acp.close();
      } catch {
        // The process may already be gone; stop() below is authoritative.
      }
      acp.acp.stop();
    }
    const session = this.kanban.getSession(sessionId);
    const terminal = this.terminals.get(sessionId);
    if (terminal?.running) {
      this.stopping.add(sessionId);
      terminal.stop("SIGTERM");
    }
    if (this.kanban.getSession(sessionId).status === "stopped") return this.kanban.getSession(sessionId);
    const settled = await this.kanban.settleSession(sessionId, { status: "stopped" });
    if (acp) {
      // The chat socket has no process left to read from; tell it how the
      // session ended instead of leaving the composer waiting on a dead peer.
      this.broadcast(acp, { type: "agent_status", status: "stopped", running: false });
      for (const socket of [...acp.sockets]) {
        try {
          socket.close(1000, "session stopped");
        } catch {
          // Already closed.
        }
      }
      acp.sockets.clear();
    }
    return settled;
  }

  /**
   * Applies a harness hook event (v13 M3). The token scopes the call to one
   * session; unknown/expired tokens are refused like any other credential.
   */
  async handleHook(input: {
    sessionId: unknown;
    token: unknown;
    event: unknown;
  }): Promise<{ ok: true; applied: boolean; status: KanbanSessionStatus }> {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    const token = typeof input.token === "string" ? input.token : "";
    const event = input.event;
    const entry = this.hookTokens.get(sessionId);
    if (!entry || !tokenMatches(token, entry.token)) {
      throw new DomainError("kanban-terminal-unauthorized", "Invalid kanban hook token");
    }
    if (event !== "to_review" && event !== "to_in_progress" && event !== "needs_attention") {
      throw new DomainError("config-invalid", `Unknown kanban hook event: ${String(event)}`);
    }
    const session = this.kanban.getSession(sessionId);
    const status = session.status;
    let applied = false;
    let nextStatus = status;

    if (event === "to_review") {
      if (status === "starting" || status === "running" || status === "needs_attention" || status === "awaiting_review") {
        nextStatus = "awaiting_review";
        await this.kanban.setColumn(session.cardId, "review");
        applied = true;
      }
    } else if (event === "to_in_progress") {
      if (status === "awaiting_review" || status === "needs_attention" || status === "running") {
        nextStatus = "running";
        await this.kanban.setColumn(session.cardId, "in_progress");
        applied = true;
      }
    } else if (status === "starting" || status === "running") {
      nextStatus = "needs_attention";
      applied = true;
    }

    if (applied) {
      await this.kanban.updateSession(sessionId, {
        status: nextStatus,
        lastHookEvent: event,
        lastHookAt: new Date().toISOString(),
      });
    }
    return { ok: true, applied, status: nextStatus };
  }

  /**
   * Attaches a websocket client to a PTY session. The first frame is a replay
   * snapshot; live output follows as binary frames. Detaching never stops the
   * PTY.
   */
  attach(sessionId: ID, socket: WebSocket): void {
    const session = this.getSessionOrReject(socket, sessionId);
    if (!session) return;
    if (session.transport === "acp") {
      this.sendJson(socket, {
        type: "error",
        code: "kanban-session-not-terminal",
        message: "This session has no terminal; open its chat instead",
      });
      socket.close(1011, "not a terminal session");
      return;
    }
    const terminal = this.terminals.get(sessionId);
    if (!terminal) {
      this.sendJson(socket, {
        type: "error",
        code: "kanban-session-not-live",
        message: "This session is not live in this server process (restart the card)",
      });
      socket.close(1011, "session not live");
      return;
    }

    const replay: TerminalSnapshot = terminal.snapshot();
    this.sendJson(socket, {
      type: "restore",
      data: Buffer.from(replay.data).toString("base64"),
      cols: replay.cols,
      rows: replay.rows,
      running: replay.running,
      status: this.kanban.getSession(sessionId).status,
    });

    let closed = false;
    const onData = (chunk: string): void => {
      if (closed) return;
      socket.send(Buffer.from(chunk, "utf8"));
    };
    const onExit = (event: { exitCode: number; signal?: number }): void => {
      if (closed) return;
      this.sendJson(socket, {
        type: "exit",
        exitCode: event.exitCode,
        ...(event.signal !== undefined ? { signal: event.signal } : {}),
      });
    };
    terminal.on("data", onData);
    terminal.on("exit", onExit);

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        if (isBinary) {
          const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          terminal.write(buffer.toString("utf8"));
          // Typing into a card that is sitting in Review is a new turn: move
          // it back to In Progress without waiting for a hook.
          const current = this.kanban.getSession(sessionId);
          if (current.status === "awaiting_review" || current.status === "needs_attention") {
            void this.markWorking(sessionId, "user-input");
          }
          return;
        }
        const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
        const message = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
        if (message.type === "resize" && typeof message.cols === "number" && typeof message.rows === "number") {
          terminal.resize(message.cols, message.rows);
        } else if (message.type === "stop") {
          void this.stop(sessionId);
        }
      } catch {
        // A malformed frame never takes the PTY down; the next frame is still valid.
      }
    });

    socket.on("close", () => {
      closed = true;
      terminal.off("data", onData);
      terminal.off("exit", onExit);
    });
    socket.on("error", () => {
      closed = true;
      terminal.off("data", onData);
      terminal.off("exit", onExit);
    });
  }

  /**
   * Attaches a websocket client to an ACP session (v13 chat transport). Every
   * client gets the transcript so far plus pending permission requests, then
   * item/status upserts as the agent works. Detaching never stops the agent.
   */
  attachAgent(sessionId: ID, socket: WebSocket): void {
    let session: KanbanSession;
    try {
      session = this.kanban.getSession(sessionId);
    } catch {
      this.sendJson(socket, {
        type: "agent_error",
        code: "kanban-session-not-found",
        message: "Session not found",
      });
      socket.close(1011, "session not found");
      return;
    }
    if (session.transport !== "acp") {
      this.sendJson(socket, {
        type: "agent_error",
        code: "kanban-session-not-agent",
        message: "This session is a terminal; open the terminal instead",
      });
      socket.close(1011, "not an agent session");
      return;
    }
    const state = this.acpStates.get(sessionId);
    if (!state || state.exited || state.stopping || !state.acp.running) {
      this.sendJson(socket, {
        type: "agent_error",
        code: "kanban-session-not-live",
        message: "This session is not live in this server process (restart the card)",
      });
      socket.close(1011, "session not live");
      return;
    }

    this.sendJson(socket, {
      type: "agent_snapshot",
      items: [...state.projector.snapshot],
      status: session.status,
      running: state.running,
      ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
      permissions: [...state.permissions.values()],
    });
    state.sockets.add(socket);

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return;
      let message: {
        type?: string;
        text?: unknown;
        requestId?: unknown;
        optionId?: unknown;
      };
      try {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8");
        message = JSON.parse(text) as typeof message;
      } catch {
        return;
      }
      if (message.type === "prompt") {
        const prompt = typeof message.text === "string" ? message.text.trim() : "";
        if (!prompt) return;
        if (!state.ready) {
          this.sendJson(socket, {
            type: "agent_error",
            code: "kanban-agent-starting",
            message: "The agent is still starting; wait for the session to become live",
          });
          return;
        }
        if (state.exited || state.stopping) {
          this.sendJson(socket, {
            type: "agent_error",
            code: "kanban-session-not-live",
            message: "This session is no longer live in this server process",
          });
          return;
        }
        if (state.running) {
          this.sendJson(socket, {
            type: "agent_error",
            code: "kanban-agent-busy",
            message: "This session is already working on a turn",
          });
          return;
        }
        this.background(this.runAcpPrompt(state, prompt), "ACP prompt");
      } else if (message.type === "cancel") {
        state.acp.cancel();
      } else if (message.type === "permission") {
        const requestId = typeof message.requestId === "string" ? message.requestId : "";
        const optionId = typeof message.optionId === "string" ? message.optionId : null;
        this.background(this.answerAcpPermission(state, requestId, optionId), "ACP permission answer");
      } else if (message.type === "stop") {
        this.background(this.stop(sessionId), "ACP session stop");
      }
    });

    const detach = (): void => {
      state.sockets.delete(socket);
    };
    socket.on("close", detach);
    socket.on("error", detach);
  }

  /** Kill every process this process owns. Records are reconciled on next boot. */
  stopAll(): void {
    this.shuttingDown = true;
    for (const terminal of this.terminals.values()) {
      terminal.stop("SIGTERM");
    }
    for (const state of this.acpStates.values()) {
      state.stopping = true;
      for (const request of state.permissions.values()) {
        state.acp.respondPermission(request.requestId, null);
      }
      state.permissions.clear();
      state.acp.stop();
    }
    this.acpStates.clear();
    this.terminals.clear();
  }

  private async markWorking(sessionId: ID, reason: string): Promise<void> {
    const session = this.kanban.getSession(sessionId);
    if (!ACTIVE_STATUSES.includes(session.status)) return;
    await this.kanban.updateSession(sessionId, {
      status: "running",
      lastHookEvent: reason,
      lastHookAt: new Date().toISOString(),
    });
    await this.kanban.setColumn(session.cardId, "in_progress");
  }

  private async onExit(session: KanbanSession, event: { exitCode: number; signal?: number }): Promise<void> {
    const hookEntry = this.hookTokens.get(session.id);
    this.hookTokens.delete(session.id);
    if (hookEntry?.dir) await cleanupKanbanHooks(hookEntry.dir);

    // Process shutdown: leave the running record alone so the next boot marks
    // it interrupted. Writing `awaiting_review` here would move the card to
    // Review and lie about why the agent stopped.
    if (this.shuttingDown) return;
    const wasStopped = this.stopping.delete(session.id);
    if (wasStopped) {
      // `stop()` already wrote the stopped record; re-writing it here would
      // race a test/owner that has since torn the data directory down.
      if (this.kanban.getSession(session.id).status !== "stopped") {
        await this.kanban.settleSession(session.id, { status: "stopped", exitCode: event.exitCode });
      }
      return;
    }
    // node-pty reports a normal exit as exitCode 0 + signal 0 (not undefined).
    // Only a real signal makes a clean exit code suspicious.
    const signalled = event.signal !== undefined && event.signal !== 0;
    if (event.exitCode === 0 && !signalled) {
      await this.kanban.settleSession(session.id, { status: "awaiting_review", exitCode: 0 });
      return;
    }
    // A signalled exit is not a clean finish even when node-pty reports
    // exitCode 0. The card stays in_progress so retry is one click.
    await this.kanban.settleSession(session.id, {
      status: "failed",
      exitCode: event.exitCode,
      error: `Agent exited with code ${event.exitCode}${signalled ? ` (signal ${event.signal})` : ""}`,
    });
  }

  /** Session lookup shared by both attach paths; closes the socket on failure. */
  private getSessionOrReject(socket: WebSocket, sessionId: ID): KanbanSession | undefined {
    try {
      return this.kanban.getSession(sessionId);
    } catch {
      this.sendJson(socket, { type: "error", code: "kanban-session-not-found", message: "Session not found" });
      socket.close(1011, "session not found");
      return undefined;
    }
  }

  /** Answer a pending permission request; unknown ids are no-ops. */
  private async answerAcpPermission(state: AcpState, requestId: string, optionId: string | null): Promise<void> {
    if (!state.permissions.delete(requestId)) return;
    state.acp.respondPermission(requestId, optionId);
    // Other tabs (or the same tab after a reattach) still hold the card; tell
    // them it was answered so its buttons don't stay enabled.
    this.broadcast(state, { type: "agent_permission_answered", requestId });
    if (state.exited || state.stopping) return;
    try {
      state.session = await this.kanban.updateSession(state.session.id, {
        status: "running",
        lastHookEvent: "permission_answered",
        lastHookAt: new Date().toISOString(),
      });
      this.broadcastStatus(state);
    } catch {
      // The session may have been deleted while the user was answering.
    }
  }

  private broadcastStatus(state: AcpState): void {
    const session = this.kanban.getSession(state.session.id);
    state.session = session;
    this.broadcast(state, { type: "agent_status", status: session.status, running: state.running });
  }

  private broadcast(state: AcpState, message: unknown): void {
    for (const socket of [...state.sockets]) {
      if (!this.sendJson(socket, message)) state.sockets.delete(socket);
    }
  }

  private sendJson(socket: WebSocket, value: unknown): boolean {
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch {
      // The client is already gone; there is nothing left to tell it.
      return false;
    }
  }
}

/** Constant-time token comparison; unequal lengths answer false immediately. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
