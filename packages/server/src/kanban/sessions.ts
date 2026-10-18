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
 *
 * ACP conversations outlive the process in two ways: the projected transcript
 * is saved under the data directory (so a restarted server can still show it),
 * and a saved session is resumed with ACP `session/resume` when the user asks
 * for it (so the agent keeps its own context). Neither is automatic: a restart
 * kills the child processes, and reconnecting is an explicit card action.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { DomainError } from "@agentfabric/core";
import type {
  ID,
  KanbanCard,
  KanbanProject,
  KanbanSession,
  KanbanSessionModelRoute,
  KanbanSessionStatus,
} from "@agentfabric/core";
import type { KanbanService } from "@agentfabric/core";
import { assertKanbanAgentAvailable, buildKanbanLaunch, type KanbanLaunch } from "./agents.js";
import { cleanupKanbanHooks, prepareKanbanHooks } from "./hooks.js";
import { TerminalSession, type TerminalSnapshot } from "./terminal.js";
import { createKanbanWorktree, kanbanWorktreePath, removeKanbanWorktree } from "./worktree.js";
import {
  AcpSession,
  type AcpConfigOption,
  type AcpExit,
  type AcpPermissionRequest,
  type AcpUpdate,
} from "./acp.js";
import { AcpChatProjector } from "./acpChat.js";
import { KanbanTranscriptStore } from "./transcript.js";

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

/** Debounce for transcript writes while chunks stream. */
const TRANSCRIPT_SAVE_DELAY_MS = 750;
/** How long stop() waits for the ACP process to actually exit. */
const STOP_EXIT_TIMEOUT_MS = 3_500;

/**
 * Per-session state of one ACP conversation. It exists for a live child
 * process *and* for a saved transcript with no process (after a restart, an
 * exit or a stop): in both cases attached clients read the same projector.
 */
interface AcpState {
  session: KanbanSession;
  card: KanbanCard;
  /** The live ACP child; absent when this state only holds a saved transcript. */
  acp?: AcpSession;
  projector: AcpChatProjector;
  sockets: Set<WebSocket>;
  /** Permission requests the agent is waiting on, keyed by the wire request id. */
  permissions: Map<string, AcpPermissionRequest>;
  /** The ACP handshake and session/new (or session/resume) completed. */
  ready: boolean;
  /** A prompt turn is in flight (the card is "working"). */
  running: boolean;
  /** A session/resume handshake is in flight. */
  resuming: boolean;
  /** A saved transcript exists for this session (or has been written). */
  hasTranscript: boolean;
  /** Latest configuration the agent advertises (model, reasoning effort, …). */
  configOptions: AcpConfigOption[];
  /** Last `usage_update` (tokens in context), mirrored into the composer. */
  usage?: { used: number; size: number };
  /** The card/session was deleted; pending writes must not recreate its files. */
  discarded: boolean;
  /** stop()/shutdown asked this session to end; exit must not rewrite records. */
  stopping: boolean;
  /** The process already exited; late prompt rejections must not settle twice. */
  exited: boolean;
  saveTimer?: NodeJS.Timeout;
  /** Serializes transcript writes so an older snapshot cannot win. */
  saveChain: Promise<void>;
}

export class KanbanSessionRuntime {
  private readonly terminals = new Map<ID, TerminalSession>();
  private readonly acpStates = new Map<ID, AcpState>();
  /** Coalesces concurrent attaches for one session into one transcript load. */
  private readonly stateLoads = new Map<ID, Promise<AcpState>>();
  /** Coalesces concurrent "make sure an agent exists" attempts per session. */
  private readonly agentAttaches = new Map<ID, Promise<boolean>>();
  private readonly transcripts: KanbanTranscriptStore;
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
  ) {
    this.transcripts = new KanbanTranscriptStore(options.dataDir);
  }

  /** Live PTY for a session, if this process still owns one. */
  terminalFor(sessionId: ID): TerminalSession | undefined {
    return this.terminals.get(sessionId);
  }

  isLive(sessionId: ID): boolean {
    const terminal = this.terminals.get(sessionId);
    if (terminal !== undefined && terminal.running) return true;
    const acp = this.acpStates.get(sessionId);
    return acp !== undefined && this.stateLive(acp);
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
      resuming: false,
      hasTranscript: false,
      configOptions: [],
      discarded: false,
      stopping: false,
      exited: false,
      saveChain: Promise.resolve(),
    };
    this.acpStates.set(session.id, state);
    this.wireAcp(state, acp);

    try {
      await acp.initialize();
      const created = await acp.newSession(cwd);
      state.ready = true;
      state.session = await this.kanban.updateSession(session.id, {
        status: "running",
        nativeSessionId: created.sessionId,
      });
      // The card's model/reasoning choice is a preference over the agent's
      // advertised options: apply it before the first turn so the turn runs on
      // the route the user picked (never after the fact).
      await this.applyCardConfig(state, acp);
      await this.syncAcpConfig(state, acp.configOptions);
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
   *
   * A prompt on a session whose process is gone attaches first (resume), then
   * sends — the same "just type" flow a TUI or DSH Desktop gives. The prompt is
   * only accepted into the transcript once an agent exists; otherwise the user
   * would see their own message on a session that cannot answer it.
   */
  private async runAcpPrompt(state: AcpState, text: string): Promise<void> {
    if (state.running || state.stopping || state.discarded) return;
    if (!state.ready || !state.acp) {
      const attached = await this.ensureAgent(state);
      if (!attached) return;
    }
    state.running = true;
    const userItem = state.projector.addUser(text);
    this.broadcast(state, { type: "agent_item", item: userItem });
    this.scheduleTranscriptSave(state);

    try {
      state.session = await this.kanban.updateSession(state.session.id, {
        status: "running",
        lastHookEvent: "prompt",
        lastHookAt: new Date().toISOString(),
      });
      await this.kanban.setColumn(state.card.id, "in_progress");
      this.broadcastStatus(state);

      const result = await state.acp?.prompt(text);
      state.running = false;
      if (state.stopping || state.exited) return;
      if (result === undefined) return;
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
      await this.flushTranscript(state);
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
      await this.flushTranscript(state);
      this.broadcastStatus(state);
    }
  }

  /**
   * ACP asks before a sensitive tool runs. "Auto-approve" answers immediately;
   * otherwise the request is exposed to the card and the session is marked
   * `needs_attention` (the spec's "waiting on a human" state, not a finish).
   */
  private async onAcpPermission(state: AcpState, request: AcpPermissionRequest): Promise<void> {
    if (state.stopping || state.exited || !state.acp) return;
    const card = this.kanban.getCard(state.card.id);
    if (card.permissionModeId === "auto") {
      const allow =
        request.options.find((option) => option.kind === "allow_always") ??
        request.options.find((option) => option.kind === "allow_once");
      if (allow) {
        state.acp?.respondPermission(request.requestId, allow.optionId);
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
    // The pending prompt is part of the conversation a restart must show.
    await this.flushTranscript(state);
  }

  private async onAcpExit(state: AcpState, event: AcpExit): Promise<void> {
    // The card/session was deleted (or replaced) while the process was going
    // away: nothing may recreate its record or transcript file.
    if (this.acpStates.get(state.session.id) !== state || state.discarded) return;
    state.exited = true;
    state.ready = false;
    state.acp = undefined;
    // The turn cannot be in flight once the process is gone: clear the flag
    // before any frame so the UI never shows "working" on a dead session.
    state.running = false;
    state.permissions.clear();
    // stop() records the reason but only the exit proves the process is gone;
    // drop its marker so it cannot outlive the session.
    const wasStopped = this.stopping.delete(state.session.id);
    // During shutdown the next boot's recoverInterrupted owns the record.
    if (this.shuttingDown) {
      this.releaseIdleState(state);
      return;
    }
    if (state.stopping || wasStopped) {
      await this.flushTranscript(state);
      this.broadcastStatus(state);
      // A failed resume uses this path; clear the marker so the user can retry.
      state.stopping = false;
      this.releaseIdleState(state);
      return;
    }
    if (state.session.status === "stopped") {
      await this.flushTranscript(state);
      this.releaseIdleState(state);
      return;
    }
    const message = `Agent exited (code ${event.exitCode ?? "none"}${event.signal ? `, signal ${event.signal}` : ""})`;
    try {
      state.session = await this.kanban.settleSession(state.session.id, {
        status: "failed",
        ...(event.exitCode !== null && event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        error: message,
      });
      const item = state.projector.addError(message);
      this.broadcast(state, { type: "agent_item", item });
    } catch {
      // The session was deleted while the process was exiting.
    }
    await this.flushTranscript(state);
    this.broadcastStatus(state);
    this.releaseIdleState(state);
  }

  async stop(sessionId: ID): Promise<KanbanSession> {
    const acp = this.acpStates.get(sessionId);
    if (acp) {
      acp.stopping = true;
      if (acp.acp) this.stopping.add(sessionId);
      for (const request of acp.permissions.values()) {
        acp.acp?.respondPermission(request.requestId, null);
      }
      acp.permissions.clear();
    }
    const terminal = this.terminals.get(sessionId);
    if (terminal?.running) {
      this.stopping.add(sessionId);
      terminal.stop("SIGTERM");
    }
    if (this.kanban.getSession(sessionId).status === "stopped") {
      const current = this.kanban.getSession(sessionId);
      if (acp) acp.session = current;
      return current;
    }
    const settled = await this.kanban.settleSession(sessionId, { status: "stopped" });
    if (acp) {
      acp.session = settled;
      // ACP gets a deterministic end: settle the record, ask it to close, then
      // wait for the exit (SIGTERM, SIGKILL after the grace period). A client
      // that reattaches right after Stop must not see a half-dead process.
      const child = acp.acp;
      if (child) {
        try {
          await child.close();
        } catch {
          // The process may already be gone; stop() below is authoritative.
        }
        const exited = new Promise<void>((resolve) => {
          if (!child.running) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, STOP_EXIT_TIMEOUT_MS);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        child.stop();
        await exited;
      }
      await this.flushTranscript(acp);
      // The chat socket has no process left to read from; tell it how the
      // session ended instead of leaving the composer waiting on a dead peer.
      this.broadcast(acp, {
        type: "agent_status",
        status: "stopped",
        running: false,
        live: false,
        canResume: this.canResume(acp),
        resuming: false,
      });
      for (const socket of [...acp.sockets]) {
        try {
          socket.close(1000, "session stopped");
        } catch {
          // Already closed.
        }
      }
      acp.sockets.clear();
      this.releaseIdleState(acp);
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
   * client gets the transcript so far (live, or restored from disk) plus
   * pending permission requests, then item/status upserts as the agent works.
   * A session with no live process stays attachable: its saved transcript is
   * replayed and the client may ask to resume it. Detaching never stops the
   * agent.
   */
  async attachAgent(sessionId: ID, socket: WebSocket): Promise<void> {
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

    const state = await this.loadAcpState(session);
    // The record is the truth; a retained state may predate a stop/exit write.
    state.session = this.kanban.getSession(session.id);
    this.sendJson(socket, {
      type: "agent_snapshot",
      items: [...state.projector.snapshot],
      status: state.session.status,
      running: state.running,
      live: this.stateLive(state),
      canResume: this.canResume(state),
      resuming: state.resuming,
      configOptions: state.configOptions,
      ...(state.usage ? { usage: state.usage } : {}),
      hasTranscript: state.hasTranscript,
      ...(state.session.nativeSessionId ? { nativeSessionId: state.session.nativeSessionId } : {}),
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
        configId?: unknown;
        value?: unknown;
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
        if (state.stopping || state.discarded) {
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
        state.acp?.cancel();
      } else if (message.type === "resume") {
        this.background(this.resumeAcpSession(state), "ACP session resume");
      } else if (message.type === "set_config") {
        const configId = typeof message.configId === "string" ? message.configId : "";
        const value = typeof message.value === "string" ? message.value : "";
        if (!configId) return;
        this.background(this.setAcpConfig(state, configId, value), "ACP config change");
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
      this.releaseIdleState(state);
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
        state.acp?.respondPermission(request.requestId, null);
      }
      state.permissions.clear();
      // The process exits right after this synchronous teardown, so the
      // transcript write cannot wait on the event loop.
      this.saveTranscriptSync(state);
      state.acp?.stop();
    }
    this.acpStates.clear();
    this.terminals.clear();
  }

  /**
   * Deletes the saved transcripts of sessions whose card is being removed.
   * Called after the records are gone; the state is dropped first so a late
   * process-exit callback cannot write a file back.
   */
  async discardSessionChats(sessionIds: readonly ID[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const state = this.acpStates.get(sessionId);
      if (state) {
        state.discarded = true;
        if (state.saveTimer) {
          clearTimeout(state.saveTimer);
          state.saveTimer = undefined;
        }
        if (this.acpStates.get(sessionId) === state) this.acpStates.delete(sessionId);
      }
      try {
        await this.transcripts.remove(sessionId);
      } catch (err) {
        console.warn(
          `[agent-fabric] could not remove the saved transcript for ${sessionId}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /**
   * Makes sure this chat has an agent to talk to, attaching one if needed.
   *
   * The order mirrors what a TUI does when you keep typing after it stopped:
   * reuse the live process, else resume the saved DSH session (`session/resume`
   * — same conversation, same model context), else start a fresh session.
   * Returns false when the card cannot be run at all (trashed, agent changed,
   * DSH missing); the failure has already been reported to the chat.
   *
   * Concurrent callers share one attach; a prompt that arrives mid-attach waits
   * for it instead of erroring ("still starting" would be a lie about the UI).
   */
  private async ensureAgent(state: AcpState): Promise<boolean> {
    if (this.stateLive(state) && state.ready) return true;
    const pending = this.agentAttaches.get(state.session.id);
    if (pending) return pending;
    const attaching = (async () => {
      if (state.session.nativeSessionId) {
        // A saved DSH session wins: same conversation, same model context.
        if (await this.resumeAcpSession(state)) return true;
        // The save is not resumable (deleted, moved, or taken by another
        // process). Do not silently open a new one behind the user's back —
        // the chat already shows why the resume failed.
        return false;
      }
      return this.startAcpForState(state);
    })().finally(() => {
      this.agentAttaches.delete(state.session.id);
    });
    this.agentAttaches.set(state.session.id, attaching);
    return attaching;
  }

  /**
   * Re-spawns the ACP app and attaches to the session persisted by the
   * previous process (`session/resume`). The conversation history is the board's
   * own saved transcript; the agent restores its model context without
   * replaying old updates. Explicit on purpose: a restart must not silently
   * boot one harness process per card.
   */
  private async resumeAcpSession(state: AcpState): Promise<boolean> {
    if (state.discarded || state.stopping) return false;
    if (state.resuming || this.stateLive(state)) return false;
    const session = state.session;
    // No saved DSH session (older record, or the handshake never completed):
    // there is nothing to resume — the caller starts a fresh one instead.
    if (!session.nativeSessionId) return false;
    let card: KanbanCard;
    try {
      card = this.kanban.getCard(state.card.id);
    } catch {
      this.broadcast(state, {
        type: "agent_error",
        code: "kanban-session-not-found",
        message: "The card for this session no longer exists",
      });
      return false;
    }
    if (card.column === "trash") {
      this.broadcast(state, {
        type: "agent_error",
        code: "kanban-session-unresumable",
        message: "Restore the card from Done before resuming its session",
      });
      return false;
    }
    if (card.agentId !== session.agentId) {
      this.broadcast(state, {
        type: "agent_error",
        code: "kanban-session-unresumable",
        message: "The card's agent changed since this session; start a new session instead",
      });
      return false;
    }

    state.resuming = true;
    this.broadcastStatus(state);
    try {
      await assertKanbanAgentAvailable(card);
      const project = this.kanban.getProject(card.projectId);
      const launch = buildKanbanLaunch(card, project);
      const acp = new AcpSession({
        file: launch.file,
        args: launch.args,
        cwd: session.cwd,
        env: launch.env,
      });
      state.acp = acp;
      state.exited = false;
      state.stopping = false;
      state.ready = false;
      this.wireAcp(state, acp);
      await acp.initialize();
      if (!acp.supportsResume) {
        throw new Error("This DSH ACP app does not advertise session/resume; upgrade DSH");
      }
      await acp.resumeSession(session.nativeSessionId, session.cwd);
      state.ready = true;
      state.resuming = false;
      await this.syncAcpConfig(state, acp.configOptions);
      state.session = await this.kanban.updateSession(session.id, {
        status: "awaiting_review",
        lastHookEvent: "session_resumed",
        lastHookAt: new Date().toISOString(),
        error: undefined,
        endedAt: undefined,
        exitCode: undefined,
      });
      this.broadcastStatus(state);
      this.broadcastComposer(state);
      return true;
    } catch (err) {
      state.resuming = false;
      state.ready = false;
      // The half-started process is torn down; the exit callback must not
      // settle the record as an unexpected exit.
      state.exited = true;
      state.stopping = true;
      this.stopping.add(session.id);
      const acp = state.acp;
      const detail = acp?.stderr ? `\n${acp.stderr}` : "";
      acp?.stop();
      const message = `Could not resume this session: ${
        err instanceof Error ? err.message : String(err)
      }${detail}`;
      try {
        state.session = await this.kanban.updateSession(session.id, { error: message });
      } catch {
        // The card may have been deleted while the resume was in flight.
      }
      this.sendAll(state, { type: "agent_error", code: "kanban-session-resume-failed", message });
      this.broadcastStatus(state);
      this.broadcastComposer(state);
      return false;
    }
  }

  /**
   * Brings up a brand-new DSH session for a card whose record has none (a
   * record that never completed its handshake). Reuses the card's execution
   * settings, exactly like `start()` does after creating the record.
   */
  private async startAcpForState(state: AcpState): Promise<boolean> {
    const { card } = state;
    if (card.column === "trash") {
      this.sendAll(state, {
        type: "agent_error",
        code: "kanban-session-unresumable",
        message: "Restore the card from Done before using it",
      });
      return false;
    }
    if (card.agentId !== state.session.agentId) {
      this.sendAll(state, {
        type: "agent_error",
        code: "kanban-session-unresumable",
        message: "The card's agent changed since this session; start a new session instead",
      });
      return false;
    }
    state.resuming = true;
    this.broadcastStatus(state);
    this.broadcastComposer(state);
    try {
      await assertKanbanAgentAvailable(card);
      const project = this.kanban.getProject(card.projectId);
      const launch = buildKanbanLaunch(card, project);
      const acp = new AcpSession({
        file: launch.file,
        args: launch.args,
        cwd: state.session.cwd,
        env: launch.env,
      });
      state.acp = acp;
      state.exited = false;
      state.stopping = false;
      state.ready = false;
      this.wireAcp(state, acp);
      await acp.initialize();
      const created = await acp.newSession(state.session.cwd);
      state.ready = true;
      state.resuming = false;
      state.session = await this.kanban.updateSession(state.session.id, {
        status: "running",
        nativeSessionId: created.sessionId,
        error: undefined,
        endedAt: undefined,
        exitCode: undefined,
      });
      await this.applyCardConfig(state, acp);
      await this.syncAcpConfig(state, acp.configOptions);
      this.broadcastStatus(state);
      this.broadcastComposer(state);
      return true;
    } catch (err) {
      state.resuming = false;
      state.ready = false;
      state.exited = true;
      state.stopping = true;
      this.stopping.add(state.session.id);
      const acp = state.acp;
      const detail = acp?.stderr ? `\n${acp.stderr}` : "";
      acp?.stop();
      const message = `Could not start the agent for this session: ${
        err instanceof Error ? err.message : String(err)
      }${detail}`;
      this.sendAll(state, { type: "agent_error", code: "kanban-agent-start-failed", message });
      this.broadcastStatus(state);
      this.broadcastComposer(state);
      return false;
    }
  }

  /**
   * Applies the card's `model` / effort preference to the agent's advertised
   * options. The card stores what the user typed/selected; DSH advertises
   * opaque values, so a card model is accepted either as the exact advertised
   * value (`["provider","model"]`) or as a model id / name that appears in the
   * catalog (the common case: the user picked a name in the create dialog).
   *
   * A model the agent does not offer is a loud failure, not a silent fallback:
   * the card said "run on X" and the board must not pretend it did.
   */
  private async applyCardConfig(state: AcpState, acp: AcpSession): Promise<void> {
    const card = this.kanban.getCard(state.card.id);
    if (card.model) {
      const option = acp.configOptions.find((candidate) => candidate.id === "model");
      const value = option ? matchModelValue(option, card.model) : undefined;
      if (!value) {
        throw new DomainError(
          "kanban-agent-model-unavailable",
          `The card asks for model "${card.model}", but this agent does not offer it`
        );
      }
      if (value !== option?.currentValue) {
        await acp.setConfigOption("model", value);
      }
    }
    const effort = card.reasoningEffort;
    const effortOption = acp.configOptions.find((candidate) => candidate.id === "reasoning_effort");
    if (effort) {
      if (!effortOption) {
        throw new DomainError(
          "kanban-agent-effort-unavailable",
          `The card asks for reasoning effort "${effort}", but this agent does not offer one`
        );
      }
      if (effortOption.currentValue !== effort && !hasOptionValue(effortOption, effort)) {
        throw new DomainError(
          "kanban-agent-effort-unavailable",
          `The card asks for reasoning effort "${effort}", but this agent offers ${advertisedValues(effortOption)}`
        );
      }
      if (effortOption.currentValue !== effort) await acp.setConfigOption("reasoning_effort", effort);
    }
  }

  /**
   * Mirrors the agent's advertised configuration into the session record so a
   * reattached client (or the board's card metadata) shows the real route.
   * Called after every advertised/updated option set.
   */
  private async syncAcpConfig(state: AcpState, options: readonly AcpConfigOption[]): Promise<void> {
    state.configOptions = [...options];
    const modelOption = options.find((option) => option.id === "model");
    const effortOption = options.find((option) => option.id === "reasoning_effort");
    const modelRoute = modelOption ? modelRouteOf(modelOption) : undefined;
    const effort = effortOption?.currentValue;
    const previous = state.session;
    const changed =
      modelRoute?.value !== previous.modelRoute?.value ||
      (effort !== undefined && effort !== previous.reasoningEffort);
    if (!changed) {
      this.broadcastComposer(state);
      return;
    }
    try {
      state.session = await this.kanban.updateSession(state.session.id, {
        ...(modelRoute ? { modelRoute } : {}),
        ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      });
    } catch {
      // The card may have been deleted while the handshake was in flight.
      return;
    }
    this.broadcastComposer(state);
    this.broadcastStatus(state);
  }

  /** Token usage is display-only; it never enters the transcript. */
  private noteAcpUsage(state: AcpState, update: AcpUpdate): void {
    const used = typeof update.used === "number" ? update.used : undefined;
    const size = typeof update.size === "number" ? update.size : undefined;
    if (used === undefined || size === undefined) return;
    state.usage = { used, size };
    this.broadcastComposer(state);
  }

  /**
   * Asks the agent to switch a configuration option. ACP applies the change to
   * the next turn (never to a turn already in flight), and answers with the
   * complete resulting state.
   */
  private async setAcpConfig(state: AcpState, configId: string, value: string): Promise<void> {
    if (!state.acp || !this.stateLive(state)) {
      this.sendAll(state, {
        type: "agent_error",
        code: "kanban-session-not-live",
        message: "Resume this session before changing its model",
      });
      return;
    }
    if (!state.configOptions.some((option) => option.id === configId)) {
      this.sendAll(state, {
        type: "agent_error",
        code: "kanban-agent-option-unknown",
        message: `This agent does not offer the "${configId}" option`,
      });
      return;
    }
    try {
      const options = await state.acp.setConfigOption(configId, value);
      await this.syncAcpConfig(state, options);
    } catch (err) {
      this.sendAll(state, {
        type: "agent_error",
        code: "kanban-agent-option-failed",
        message: `Could not change ${configId}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Composer state: what the chat needs to render its model/effort controls. */
  private broadcastComposer(state: AcpState): void {
    this.broadcast(state, {
      type: "agent_composer",
      live: this.stateLive(state),
      canResume: this.canResume(state),
      resuming: state.resuming,
      configOptions: state.configOptions,
      ...(state.usage ? { usage: state.usage } : {}),
    });
  }

  /** Every client on this state, for direct (non-broadcast) replies. */
  private sendAll(state: AcpState, message: unknown): void {
    this.broadcast(state, message);
  }

  /** True when this state owns a live ACP child process. */
  private stateLive(state: AcpState): boolean {
    return state.acp !== undefined && !state.exited && !state.stopping && state.acp.running;
  }

  /** A saved agent session exists and no process currently owns it. */
  private canResume(state: AcpState): boolean {
    return (
      !this.stateLive(state) &&
      !state.stopping &&
      !state.resuming &&
      !state.discarded &&
      Boolean(state.session.nativeSessionId)
    );
  }

  /**
   * Drops states that exist only to serve saved transcripts once their last
   * client detaches (a later attach reloads the file). Live processes and
   * in-flight resumes stay in memory.
   */
  private releaseIdleState(state: AcpState): void {
    if (state.sockets.size > 0 || state.acp !== undefined || state.resuming) return;
    if (this.acpStates.get(state.session.id) === state) this.acpStates.delete(state.session.id);
  }

  /** Wires one ACP child's events into its chat state (start and resume). */
  private wireAcp(state: AcpState, acp: AcpSession): void {
    acp.on("update", (update: AcpUpdate) => {
      if (update.sessionUpdate === "config_option_update") {
        this.background(this.syncAcpConfig(state, acp.configOptions), "ACP config sync");
      }
      if (update.sessionUpdate === "usage_update") {
        this.noteAcpUsage(state, update);
        return;
      }
      const item = state.projector.applyUpdate(update);
      if (!item) return;
      this.broadcast(state, { type: "agent_item", item });
      this.scheduleTranscriptSave(state);
    });
    acp.on("permission", (request: AcpPermissionRequest) => {
      this.background(this.onAcpPermission(state, request), "ACP permission handling");
    });
    acp.on("exit", (event: AcpExit) => {
      this.background(this.onAcpExit(state, event), "ACP exit handling");
    });
  }

  /**
   * Returns the in-memory state for a session, restoring its saved transcript
   * when the server no longer has a process for it. Concurrent attaches share
   * one load.
   */
  private async loadAcpState(session: KanbanSession): Promise<AcpState> {
    const existing = this.acpStates.get(session.id);
    if (existing) return existing;
    const loading = this.stateLoads.get(session.id);
    if (loading) return loading;

    const promise = (async () => {
      const { items, found } = await this.transcripts.load(session.id);
      const already = this.acpStates.get(session.id);
      if (already) return already;
      const fresh = this.kanban.getSession(session.id);
      const state: AcpState = {
        session: fresh,
        card: this.kanban.getCard(fresh.cardId),
        projector: new AcpChatProjector(undefined, found ? items : []),
        sockets: new Set(),
        permissions: new Map(),
        ready: false,
        running: false,
        resuming: false,
        hasTranscript: found,
        configOptions: [],
        discarded: false,
        stopping: false,
        exited: true,
        saveChain: Promise.resolve(),
      };
      this.acpStates.set(fresh.id, state);
      return state;
    })().finally(() => {
      this.stateLoads.delete(session.id);
    });
    this.stateLoads.set(session.id, promise);
    return promise;
  }

  /** Coalesce chat writes while chunks stream; boundaries flush immediately. */
  private scheduleTranscriptSave(state: AcpState): void {
    if (state.discarded || state.saveTimer) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = undefined;
      this.background(this.persistTranscript(state), "board transcript save");
    }, TRANSCRIPT_SAVE_DELAY_MS);
    state.saveTimer.unref();
  }

  private persistTranscript(state: AcpState): Promise<void> {
    if (state.discarded) return Promise.resolve();
    // The latest mutation must win: snapshot at write time and serialize the
    // writes so a slower, older save cannot overwrite a newer one. A failed
    // save must not poison the chain: the next boundary retries.
    const write = async (): Promise<void> => {
      if (state.discarded) return;
      await this.transcripts.save(state.session.id, state.projector.snapshot);
      state.hasTranscript = true;
    };
    state.saveChain = state.saveChain.then(write, write);
    return state.saveChain;
  }

  /** Writes the current transcript now (turn end, permission, exit, stop). */
  private async flushTranscript(state: AcpState): Promise<void> {
    if (state.discarded) return;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = undefined;
    }
    try {
      await this.persistTranscript(state);
    } catch (err) {
      console.warn(
        `[agent-fabric] board transcript save failed:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /** Synchronous variant for shutdown, where the event loop stops right after. */
  private saveTranscriptSync(state: AcpState): void {
    if (state.discarded) return;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = undefined;
    }
    if (state.projector.snapshot.length === 0 && !state.hasTranscript) return;
    try {
      this.transcripts.saveSync(state.session.id, state.projector.snapshot);
      state.hasTranscript = true;
    } catch (err) {
      console.warn(
        `[agent-fabric] board transcript save failed:`,
        err instanceof Error ? err.message : String(err)
      );
    }
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
    state.acp?.respondPermission(requestId, optionId);
    // Other tabs (or the same tab after a reattach) still hold the card; tell
    // them it was answered so its buttons don't stay enabled.
    this.broadcast(state, { type: "agent_permission_answered", requestId });
    if (state.exited || state.stopping) return;
    try {
      // The answer may resolve after the turn already ended (the agent can
      // finish on its own). Only a turn still waiting on this permission goes
      // back to running; rewriting a later state would resurrect a stale
      // "running"/"awaiting_review" transition out of order.
      if (this.kanban.getSession(state.session.id).status !== "needs_attention") {
        state.session = this.kanban.getSession(state.session.id);
        return;
      }
      const updated = await this.kanban.updateSession(state.session.id, {
        status: "running",
        lastHookEvent: "permission_answered",
        lastHookAt: new Date().toISOString(),
      });
      state.session = updated;
      // The turn can finish between the answer and this write (the agent is
      // free to complete on its own). Broadcasting then would announce a
      // status the column move has not caught up with yet.
      if (updated.status === "running") this.broadcastStatus(state);
    } catch {
      // The session may have been deleted while the user was answering.
    }
  }

  private broadcastStatus(state: AcpState): void {
    let session: KanbanSession;
    try {
      session = this.kanban.getSession(state.session.id);
    } catch {
      // The record was deleted (card removed); nothing left to announce.
      return;
    }
    state.session = session;
    this.broadcast(state, {
      type: "agent_status",
      status: session.status,
      running: state.running,
      live: this.stateLive(state),
      canResume: this.canResume(state),
      resuming: state.resuming,
    });
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

/**
 * Reads one `model` config option into the record's route fields.
 *
 * ACP keeps the value opaque, so the board sends it back verbatim; provider
 * and model are only *display* projections. DSH encodes them as a JSON array
 * `["provider","model"]`; another agent may encode something else, in which
 * case the label alone explains the choice and nothing is guessed.
 */
function modelRouteOf(option: AcpConfigOption): KanbanSessionModelRoute {
  const route: KanbanSessionModelRoute = { value: option.currentValue };
  const selected = findOptionLabel(option.options, option.currentValue);
  if (selected?.name) route.label = selected.name;
  try {
    const parsed: unknown = JSON.parse(option.currentValue);
    if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((part) => typeof part === "string")) {
      route.provider = parsed[0] as string;
      route.model = parsed[1] as string;
    }
  } catch {
    // Not JSON: the opaque value is still valid, it just has no readable parts.
  }
  return route;
}

/** Whether an option advertises a value (flat or grouped). */
function hasOptionValue(option: AcpConfigOption, value: string): boolean {
  return Boolean(findOptionLabel(option.options, value));
}

/** Every advertised value, for a failure message that lists the real choices. */
function advertisedValues(option: AcpConfigOption): string {
  const values: string[] = [];
  for (const entry of option.options ?? []) {
    if ("group" in entry) for (const nested of entry.options) values.push(nested.value);
    else values.push(entry.value);
  }
  return values.join(", ");
}

/**
 * Maps a card's model text onto the agent's advertised `model` values: the
 * exact value wins, then a model-id match (`deepseek-v4-pro`), then a display
 * name match (`DeepSeek-V4-Pro`). Case-insensitive so the dialog is forgiving.
 */
function matchModelValue(option: AcpConfigOption, wanted: string): string | undefined {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return undefined;
  if (option.currentValue.toLowerCase() === needle) return option.currentValue;
  const entries: Array<{ value: string; name?: string }> = [];
  for (const entry of option.options ?? []) {
    if ("group" in entry) entries.push(...entry.options);
    else entries.push(entry);
  }
  const exact = entries.find((entry) => entry.value.toLowerCase() === needle);
  if (exact) return exact.value;
  const byId = entries.find((entry) => modelIdOf(entry.value)?.toLowerCase() === needle);
  if (byId) return byId.value;
  const byName = entries.find((entry) => entry.name?.toLowerCase() === needle);
  return byName?.value;
}

/** The model half of an opaque `["provider","model"]` value, if it is one. */
function modelIdOf(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[1] === "string") return parsed[1];
  } catch {
    // Not a JSON route: no model id to compare.
  }
  return undefined;
}

/** Finds the advertised entry (flat or grouped) carrying `value`. */
function findOptionLabel(
  options: AcpConfigOption["options"],
  value: string
): { name?: string } | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const entry of options) {
    if ("group" in entry) {
      const match = entry.options.find((option) => option.value === value);
      if (match) return match;
      continue;
    }
    if (entry.value === value) return entry;
  }
  return undefined;
}

/** Constant-time token comparison; unequal lengths answer false immediately. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
