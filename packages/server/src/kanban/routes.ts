/**
 * REST surface for the board (v13 §八).
 *
 * Routes are thin: validation and column rules live in `KanbanService`, the
 * process lifecycle lives in `KanbanSessionRuntime`. Failures are thrown as
 * `DomainError` and reach the app's existing error middleware, so the HTTP
 * status always comes from the code table instead of a per-route guess.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { DomainError } from "@agentfabric/core";
import type { ID, KanbanColumn, KanbanProject, KanbanService } from "@agentfabric/core";
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

/** Per-project column counts, so the project list shows live card totals. */
function projectWithCounts(kanban: KanbanService, project: KanbanProject): KanbanProject & {
  cardCounts: Record<KanbanColumn, number>;
} {
  const counts: Record<KanbanColumn, number> = { backlog: 0, in_progress: 0, review: 0, trash: 0 };
  for (const card of kanban.listCards(project.id)) counts[card.column] += 1;
  return { ...project, cardCounts: counts };
}

export function registerKanbanRoutes(
  app: Express,
  deps: { kanban: KanbanService; runtime: KanbanSessionRuntime }
): void {
  const { kanban, runtime } = deps;
  const ah = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => {
    return (req, res, next: NextFunction) => {
      void handler(req, res).catch(next);
    };
  };

  const projectParams = (req: Request): ID => req.params.id as ID;
  const cardParams = (req: Request): ID => req.params.id as ID;

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

  app.get(
    "/api/kanban/projects",
    ah(async (_req, res) => {
      res.json({ projects: kanban.listProjects().map((project) => projectWithCounts(kanban, project)) });
    })
  );

  /**
   * Adds a board project from a folder (`path`) or a clone URL (`gitUrl`).
   *
   * A folder that is not a Git repository is a valid board project; the
   * response asks the user how to proceed (`gitInit: "init" | "skip"`) instead
   * of guessing or refusing. Any other failure is a typed `DomainError`.
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
      res.status(201).json({ project: projectWithCounts(kanban, result.project) });
    })
  );

  /** Branch list for worktree cards; `git: null` for a non-repository folder. */
  app.get(
    "/api/kanban/projects/:id/git",
    ah(async (req, res) => {
      const project = kanban.getProject(projectParams(req));
      res.json({ git: await readGitInfo(project.rootPath) });
    })
  );

  app.patch(
    "/api/kanban/projects/:id",
    ah(async (req, res) => {
      const project = await kanban.updateProject(projectParams(req), {
        name: req.body?.name,
        defaultAgentId: req.body?.defaultAgentId,
        defaultExecutionMode: req.body?.defaultExecutionMode,
      });
      res.json({ project });
    })
  );

  app.delete(
    "/api/kanban/projects/:id",
    ah(async (req, res) => {
      const projectId = projectParams(req);
      // Kill this project's live PTYs first: deleting records must not leave
      // orphaned agents writing into the user's directory.
      for (const card of kanban.listCards(projectId)) {
        const session = kanban.latestSessionForCard(card.id);
        if (session && runtime.isLive(session.id)) await runtime.stop(session.id);
      }
      await kanban.deleteProject(projectId);
      res.json({ ok: true });
    })
  );

  /* ---------------- cards ---------------- */

  app.get(
    "/api/kanban/projects/:id/cards",
    ah(async (req, res) => {
      res.json({ cards: kanban.listCards(projectParams(req)) });
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
        permissionModeId: req.body?.permissionModeId,
        executionMode: req.body?.executionMode,
        baseRef: req.body?.baseRef,
      });
      res.status(201).json({ card });
    })
  );

  app.patch(
    "/api/kanban/cards/:id",
    ah(async (req, res) => {
      const cardId = cardParams(req);
      const latest = kanban.latestSessionForCard(cardId);
      const running = latest ? runtime.isLive(latest.id) : false;
      if (running && (req.body?.agentId !== undefined || req.body?.executionMode !== undefined || req.body?.model !== undefined || req.body?.permissionModeId !== undefined || req.body?.baseRef !== undefined)) {
        throw new DomainError("kanban-session-not-startable", "Stop the session before changing its agent, model, permission, base ref or execution mode");
      }
      const card = await kanban.updateCard(cardId, {
        title: req.body?.title,
        prompt: req.body?.prompt,
        agentId: req.body?.agentId,
        model: req.body?.model,
        permissionModeId: req.body?.permissionModeId,
        executionMode: req.body?.executionMode,
        baseRef: req.body?.baseRef,
      });
      res.json({ card });
    })
  );

  /**
   * Empties the Done column: the cards and their session records are deleted,
   * never the working directories. Live sessions are stopped first so clearing
   * Done cannot leave an agent writing with no record pointing at it.
   */
  app.post(
    "/api/kanban/projects/:id/trash/clear",
    ah(async (req, res) => {
      const cards = kanban.listCards(projectParams(req)).filter((card) => card.column === "trash");
      for (const card of cards) {
        const latest = kanban.latestSessionForCard(card.id);
        if (latest && runtime.isLive(latest.id)) await runtime.stop(latest.id);
        await kanban.deleteCard(card.id);
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
      if (target === "trash") {
        const latest = kanban.latestSessionForCard(cardId);
        if (latest && runtime.isLive(latest.id)) await runtime.stop(latest.id);
      }
      res.json({ card: await kanban.moveCard(card.id, target) });
    })
  );

  app.delete(
    "/api/kanban/cards/:id",
    ah(async (req, res) => {
      const cardId = cardParams(req);
      const latest = kanban.latestSessionForCard(cardId);
      if (latest && runtime.isLive(latest.id)) await runtime.stop(latest.id);
      await kanban.deleteCard(cardId);
      res.json({ ok: true });
    })
  );

  /* ---------------- sessions ---------------- */

  app.post(
    "/api/kanban/cards/:id/start",
    ah(async (req, res) => {
      const cardId = cardParams(req);
      if (req.body?.restart === true) {
        const latest = kanban.latestSessionForCard(cardId);
        if (latest && runtime.isLive(latest.id)) await runtime.stop(latest.id);
      }
      const session = await runtime.start(cardId);
      res.json({ session });
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
        })
      );
    })
  );
}
