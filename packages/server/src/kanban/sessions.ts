/**
 * Server-side owner of live kanban PTY sessions (v13 §3/§5).
 *
 * The service layer owns records; this layer owns processes. One session is one
 * PTY at a time; clients attach/detach freely, and the PTY keeps running when
 * the browser closes (a card's agent must survive a page refresh).
 *
 * Two execution modes share this path:
 * - `direct`: the agent runs in the board project folder itself. Multiple
 *   cards may run at once by design (the user asked for it); concurrent edits
 *   are the agents' problem, not a platform lock.
 * - `worktree`: a detached `git worktree` checkout under the data directory,
 *   so parallel cards do not share a working tree.
 *
 * Hooks (Claude / OpenCode) call back with a per-session capability token; the
 * token only moves its own card and is dropped with the session.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { DomainError } from "@agentfabric/core";
import type { ID, KanbanSession, KanbanSessionStatus } from "@agentfabric/core";
import type { KanbanService } from "@agentfabric/core";
import { assertKanbanAgentAvailable, buildKanbanLaunch } from "./agents.js";
import { cleanupKanbanHooks, prepareKanbanHooks } from "./hooks.js";
import { TerminalSession, type TerminalSnapshot } from "./terminal.js";
import { createKanbanWorktree, kanbanWorktreePath, removeKanbanWorktree } from "./worktree.js";

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

export class KanbanSessionRuntime {
  private readonly terminals = new Map<ID, TerminalSession>();
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
    return terminal !== undefined && terminal.running;
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

  async stop(sessionId: ID): Promise<KanbanSession> {
    const session = this.kanban.getSession(sessionId);
    const terminal = this.terminals.get(sessionId);
    if (terminal?.running) {
      this.stopping.add(sessionId);
      terminal.stop("SIGTERM");
    }
    if (this.kanban.getSession(sessionId).status === "stopped") return this.kanban.getSession(sessionId);
    return this.kanban.settleSession(sessionId, { status: "stopped" });
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
   * Attaches a websocket client. The first frame is a replay snapshot; live
   * output follows as binary frames. Detaching never stops the PTY.
   */
  attach(sessionId: ID, socket: WebSocket): void {
    let session: KanbanSession;
    try {
      session = this.kanban.getSession(sessionId);
    } catch {
      this.sendJson(socket, { type: "error", code: "kanban-session-not-found", message: "Session not found" });
      socket.close(1011, "session not found");
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

  /** Kill every PTY this process owns. Records are reconciled on next boot. */
  stopAll(): void {
    this.shuttingDown = true;
    for (const terminal of this.terminals.values()) {
      terminal.stop("SIGTERM");
    }
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

  private sendJson(socket: WebSocket, value: unknown): void {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      // The client is already gone; there is nothing left to tell it.
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
