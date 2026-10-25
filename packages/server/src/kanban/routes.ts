/**
 * REST surface for the board (v13 §八, unified with Projects in v14).
 *
 * Routes are thin: validation and column rules live in `KanbanService`, the
 * process lifecycle lives in `KanbanSessionRuntime`. Failures are thrown as
 * `DomainError` and reach the app's existing error middleware, so the HTTP
 * status always comes from the code table instead of a per-route guess.
 *
 * **Projects are not a board-owned collection.** Listing, renaming and deleting
 * a board project is the plain `/api/projects` API. The single board-specific
 * project route is the "pick a folder / clone a URL → add it as a Project"
 * entry point, because the Git question it asks is board-specific.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { DomainError } from "@agentfabric/core";
import type { ID, KanbanColumn, KanbanService, Project, ProjectService, WorkspaceService } from "@agentfabric/core";
import { listKanbanAgents } from "./agents.js";
import { listKanbanDirectories } from "./fs.js";
import { readGitInfo } from "./git.js";
import { addKanbanProject, type KanbanGitInitChoice } from "./projects.js";
import type { KanbanSessionRuntime } from "./sessions.js";

const COLUMNS: readonly KanbanColumn[] = ["backlog", "in_progress", "review", "trash"];

function asColumn(value: unknown): KanbanColumn {
  if (typeof value === "string" && (COLUMNS as readonly string[]).includes(value)) return value as KanbanColumn;
  throw new DomainError("kanban-session-not-startable", `Unknown board column "${String(value)}"`);
}

function asGitInit(value: unknown): KanbanGitInitChoice {
  if (value === "init" || value === "skip") return value;
  return "ask";
}

/**
 * The board fields a project list row adds to a `Project`: how many cards it
 * has and how many of them are running. Computed for this response only; the
 * Project record itself stays the plain record.
 */
export interface BoardProjectRow extends Project {
  cardCounts: Record<KanbanColumn, number>;
  /** Cards whose latest session still owns a live process. */
  runningCards: number;
}

function projectWithCounts(
  kanban: KanbanService,
  project: Project,
  isLive: (sessionId: ID) => boolean
): BoardProjectRow {
  const counts: Record<KanbanColumn, number> = { backlog: 0, in_progress: 0, review: 0, trash: 0 };
  let runningCards = 0;
  for (const card of kanban.listCards(project.id)) {
    counts[card.column] += 1;
    const session = kanban.latestSessionForCard(card.id);
    if (session && isLive(session.id)) runningCards += 1;
  }
  return { ...project, cardCounts: counts, runningCards };
}

export interface KanbanRouteDeps {
  kanban: KanbanService;
  runtime: KanbanSessionRuntime;
  projects: ProjectService;
  workspaces: WorkspaceService;
}

export function registerKanbanRoutes(app: Express, deps: KanbanRouteDeps): void {
  const { kanban, runtime, projects, workspaces } = deps;
  const ah = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => {
    return (req, res, next: NextFunction) => {
      void handler(req, res).catch(next);
    };
  };

  const projectParams = (req: Request): ID => req.params.id as ID;
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
   * Directory suggestions for the project picker. `path` is a folder to list;
   * omitted means the user's home directory. Read-only.
   */
  app.get(
    "/api/kanban/fs",
    ah(async (req, res) => {
      const path = typeof req.query.path === "string" ? req.query.path : undefined;
      res.json({ listing: await listKanbanDirectories(path) });
    })
  );

  /* ---------------- projects ---------------- */

  /**
   * Adds a board project from a folder (`path`) or a clone URL (`gitUrl`).
   *
   * A folder that is not a Git repository is a valid board project; the
   * response asks the user how to proceed (`gitInit: "init" | "skip"`) instead
   * of guessing or refusing. Any other failure is a typed `DomainError`.
   *
   * The result is an ordinary `Project`; listing, renaming and deleting it
   * afterwards is `/api/projects`.
   */
  app.post(
    "/api/kanban/projects",
    ah(async (req, res) => {
      const result = await addKanbanProject(kanban, {
        path: req.body?.path,
        gitUrl: req.body?.gitUrl,
        folderName: req.body?.folderName,
        name: req.body?.name,
        gitInit: asGitInit(req.body?.gitInit),
      });
      if (result.kind === "requires-git-init") {
        res.status(409).json({
          error:
            "This folder is not a Git repository. Kanban works with plain folders — add it as-is, or initialize a repository first.",
          code: "kanban-project-not-git",
          requiresGitInitialization: true,
          path: result.path,
        });
        return;
      }
      res.status(201).json({ project: projectWithCounts(kanban, result.project, (id) => runtime.isLive(id)) });
    })
  );

  /** Branch list for worktree cards; `git: null` for a non-repository folder. */
  app.get(
    "/api/kanban/projects/:id/git",
    ah(async (req, res) => {
      const project = kanban.getProject(projectParams(req));
      res.json({ git: await readGitInfo(kanban.rootOf(project)) });
    })
  );

  /* ---------------- cards ---------------- */

  app.get(
    "/api/kanban/projects/:id/cards",
    ah(async (req, res) => {
      const project = kanban.getProject(projectParams(req));
      res.json({ cards: kanban.listCards(project.id) });
    })
  );

  app.post(
    "/api/kanban/projects/:id/cards",
    ah(async (req, res) => {
      const card = await kanban.createCard(projectParams(req), {
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
    "/api/kanban/projects/:id/trash/clear",
    ah(async (req, res) => {
      const project = kanban.getProject(projectParams(req));
      const cards = kanban.listCards(project.id).filter((card) => card.column === "trash");
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
