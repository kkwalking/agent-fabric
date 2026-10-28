/**
 * REST surface for the board (v13 §八, unified with Workspaces in v14).
 *
 * Routes are thin: validation and column rules live in `KanbanService`, the
 * process lifecycle lives in `KanbanSessionRuntime`. Failures are thrown as
 * `DomainError` and reach the app's existing error middleware, so the HTTP
 * status always comes from the code table instead of a per-route guess.
 *
 * **Workspaces are not a board-owned collection.** Listing, renaming and deleting
 * a board workspace is the plain `/api/workspaces` API. The single board-specific
 * workspace route is the "pick a folder → add it as a board workspace" entry
 * point, because that is where the board settings are written.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { DomainError } from "@agentfabric/core";
import type { ID, KanbanColumn, KanbanService, Workspace, WorkspaceService } from "@agentfabric/core";
import { listKanbanAgents } from "./agents.js";
import { listKanbanDirectories } from "./fs.js";
import { readGitInfo } from "./git.js";
import { addKanbanWorkspace } from "./workspaces.js";
import type { KanbanSessionRuntime } from "./sessions.js";

const COLUMNS: readonly KanbanColumn[] = ["backlog", "in_progress", "review", "trash"];

function asColumn(value: unknown): KanbanColumn {
  if (typeof value === "string" && (COLUMNS as readonly string[]).includes(value)) return value as KanbanColumn;
  throw new DomainError("kanban-session-not-startable", `Unknown board column "${String(value)}"`);
}

/**
 * The board fields a workspace list row adds to a `Workspace`: how many cards it
 * has and how many of them are running. Computed for this response only; the
 * Workspace record itself stays the plain record.
 */
export interface BoardWorkspaceRow extends Workspace {
  cardCounts: Record<KanbanColumn, number>;
  /** Cards whose latest session still owns a live process. */
  runningCards: number;
}

function workspaceWithCounts(
  kanban: KanbanService,
  workspace: Workspace,
  isLive: (sessionId: ID) => boolean
): BoardWorkspaceRow {
  const counts: Record<KanbanColumn, number> = { backlog: 0, in_progress: 0, review: 0, trash: 0 };
  let runningCards = 0;
  for (const card of kanban.listCards(workspace.id)) {
    counts[card.column] += 1;
    const session = kanban.latestSessionForCard(card.id);
    if (session && isLive(session.id)) runningCards += 1;
  }
  return { ...workspace, cardCounts: counts, runningCards };
}

export interface KanbanRouteDeps {
  kanban: KanbanService;
  runtime: KanbanSessionRuntime;
  workspaces: WorkspaceService;
}

export function registerKanbanRoutes(app: Express, deps: KanbanRouteDeps): void {
  const { kanban, runtime } = deps;
  const ah = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => {
    return (req, res, next: NextFunction) => {
      void handler(req, res).catch(next);
    };
  };

  const workspaceParams = (req: Request): ID => req.params.id as ID;
  const cardParams = (req: Request): ID => req.params.id as ID;

  /**
   * Deletes a card's records and the saved transcripts of its sessions
   * together. The transcripts live beside the store, so nothing else would
   * clean them up.
   */
  const deleteCardWithChats = async (cardId: ID): Promise<void> => {
    const sessionIds = kanban.listSessions(cardId).map((session) => session.id);
    await kanban.deleteCard(cardId);
    await runtime.discardSessionChats(sessionIds);
  };

  app.get(
    "/api/kanban/agents",
    ah(async (_req, res) => {
      res.json({ agents: await listKanbanAgents() });
    })
  );

  /**
   * Directory suggestions for the workspace picker. `path` is a folder to list;
   * omitted means the user's home directory. Read-only.
   */
  app.get(
    "/api/kanban/fs",
    ah(async (req, res) => {
      const path = typeof req.query.path === "string" ? req.query.path : undefined;
      res.json({ listing: await listKanbanDirectories(path) });
    })
  );

  /* ---------------- workspaces ---------------- */

  /**
   * Adds a board workspace from a folder (`rootPath`).
   *
   * Nothing is cloned and no repository is initialised: the board runs local
   * agent CLIs in the folder the user picked, and Git (if that folder has any)
   * stays that folder's own business. The result is an ordinary `Workspace`
   * carrying the board settings; listing, renaming and deleting it afterwards
   * is `/api/workspaces`.
   */
  /** The board's workspaces (every workspace carrying board settings). */
  app.get(
    "/api/kanban/workspaces",
    ah(async (_req, res) => {
      res.json({
        workspaces: kanban
          .listWorkspaces()
          .map((workspace) => workspaceWithCounts(kanban, workspace, (id) => runtime.isLive(id))),
      });
    })
  );

  app.post(
    "/api/kanban/workspaces",
    ah(async (req, res) => {
      const result = await addKanbanWorkspace(kanban, { rootPath: req.body?.rootPath, name: req.body?.name });
      res.status(201).json({ workspace: workspaceWithCounts(kanban, result.workspace, (id) => runtime.isLive(id)) });
    })
  );

  /** Branch list for worktree cards; `git: null` for a non-repository folder. */
  app.get(
    "/api/kanban/workspaces/:id/git",
    ah(async (req, res) => {
      const workspace = kanban.getWorkspace(workspaceParams(req));
      res.json({ git: await readGitInfo(kanban.rootOf(workspace)) });
    })
  );

  /* ---------------- cards ---------------- */

  app.get(
    "/api/kanban/workspaces/:id/cards",
    ah(async (req, res) => {
      const workspace = kanban.getWorkspace(workspaceParams(req));
      res.json({ cards: kanban.listCards(workspace.id) });
    })
  );

  app.post(
    "/api/kanban/workspaces/:id/cards",
    ah(async (req, res) => {
      const card = await kanban.createCard(workspaceParams(req), {
        title: req.body?.title,
        prompt: req.body?.prompt,
        agentId: req.body?.agentId,
        model: req.body?.model,
        reasoningEffort: req.body?.reasoningEffort,
        permissionModeId: req.body?.permissionModeId,
        executionMode: req.body?.executionMode,
        baseRef: req.body?.baseRef,
      });
      res.status(201).json({ card });
    })
  );

  /**
   * Edits a card (v13 §七). Clicking a Backlog card opens this form, and it is
   * the only card that may be edited: once a card leaves Backlog its prompt and
   * agent are what a session ran on, so the board shows that history instead of
   * letting it be rewritten. Live sessions are refused for the same reason —
   * the running agent already read the old values.
   */
  app.patch(
    "/api/kanban/cards/:id",
    ah(async (req, res) => {
      const cardId = cardParams(req);
      const current = kanban.getCard(cardId);
      if (current.column !== "backlog") {
        throw new DomainError(
          "kanban-card-not-editable",
          `Only a Backlog card can be edited; this card is in ${current.column}`
        );
      }
      const latest = kanban.latestSessionForCard(cardId);
      const running = latest ? runtime.isLive(latest.id) : false;
      if (running) {
        throw new DomainError(
          "kanban-session-not-startable",
          "Stop the session before editing this card"
        );
      }
      const card = await kanban.updateCard(cardId, {
        title: req.body?.title,
        prompt: req.body?.prompt,
        agentId: req.body?.agentId,
        model: req.body?.model,
        reasoningEffort: req.body?.reasoningEffort,
        permissionModeId: req.body?.permissionModeId,
        executionMode: req.body?.executionMode,
        baseRef: req.body?.baseRef,
      });
      res.json({ card });
    })
  );

  /**
   * Empties the Done column: the cards are deleted (their Tasks go to the
   * recycle bin, never a physical delete), never the working directories. Live
   * sessions are stopped first so clearing Done cannot leave an agent writing
   * with no record pointing at it.
   */
  app.post(
    "/api/kanban/workspaces/:id/trash/clear",
    ah(async (req, res) => {
      const workspace = kanban.getWorkspace(workspaceParams(req));
      const cards = kanban.listCards(workspace.id).filter((card) => card.column === "trash");
      for (const card of cards) {
        const latest = kanban.latestSessionForCard(card.id);
        if (latest && runtime.isLive(latest.id)) await runtime.stop(latest.id);
        await deleteCardWithChats(card.id);
      }
      res.json({ deleted: cards.length });
    })
  );

  app.post(
    "/api/kanban/cards/:id/move",
    ah(async (req, res) => {
      const cardId = cardParams(req);
      const target = asColumn(req.body?.column);
      const card = kanban.getCard(cardId);
      // Done is an archive: moving a card there releases its process instead of
      // leaving a live agent on an archived card. The harness's own session id
      // is recorded, so restoring the card resumes that conversation rather
      // than starting over. Agents with no resume surface keep their process,
      // because releasing would destroy the only copy of the conversation.
      if (target === "trash") await runtime.releaseSession(cardId);
      res.json({ card: await kanban.moveCard(card.id, target) });
    })
  );

  app.delete(
    "/api/kanban/cards/:id",
    ah(async (req, res) => {
      const cardId = cardParams(req);
      const latest = kanban.latestSessionForCard(cardId);
      if (latest && runtime.isLive(latest.id)) await runtime.stop(latest.id);
      await deleteCardWithChats(cardId);
      res.json({ ok: true });
    })
  );

  /* ---------------- sessions ---------------- */

  app.post(
    "/api/kanban/cards/:id/start",
    ah(async (req, res) => {
      const cardId = cardParams(req);
      const latest = kanban.latestSessionForCard(cardId);
      // Starting a card that is already running is a no-op, not a restart: the
      // board's Start is also the "open the Backlog card and run it" action, and
      // silently replacing a live agent would throw away the turn in progress.
      // An explicit restart (or a stopped/finished session) is what relaunches.
      if (req.body?.restart !== true && latest && runtime.isLive(latest.id)) {
        res.json({ session: latest, card: kanban.getCard(cardId) });
        return;
      }
      if (req.body?.restart === true && latest && runtime.isLive(latest.id)) {
        await runtime.stop(latest.id);
      }
      const session = await runtime.start(cardId);
      res.json({ session, card: kanban.getCard(cardId) });
    })
  );

  app.get(
    "/api/kanban/cards/:id/session",
    ah(async (req, res) => {
      const session = kanban.latestSessionForCard(cardParams(req)) ?? null;
      res.json({ session });
    })
  );

  app.post(
    "/api/kanban/cards/:id/stop",
    ah(async (req, res) => {
      const latest = kanban.latestSessionForCard(cardParams(req));
      if (!latest) throw new DomainError("kanban-session-not-found", "This card has no session to stop");
      res.json({ session: await runtime.stop(latest.id) });
    })
  );

  /* ---------------- harness hooks ---------------- */
  // Deliberately outside `/api`: the global token middleware owns that prefix,
  // and a harness must not need the user's API token. The callback carries a
  // per-session capability token that can only move its own card.
  app.post(
    "/kanban-hooks/ingest",
    ah(async (req, res) => {
      const token = typeof req.get("x-kanban-hook-token") === "string" ? req.get("x-kanban-hook-token")! : "";
      res.json(
        await runtime.handleHook({
          sessionId: req.body?.sessionId,
          token,
          event: req.body?.event,
          nativeSessionId: req.body?.nativeSessionId,
        })
      );
    })
  );
}
