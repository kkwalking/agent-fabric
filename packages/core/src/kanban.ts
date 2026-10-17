/**
 * Kanban domain service (v13).
 *
 * The board is deliberately **not** the Project Coding Task: a board project is
 * an arbitrary local directory (Git optional, folder-first) and a card is a
 * prompt + an agent + a workspace mode. Nothing here starts a process — the
 * server's session runtime owns PTYs. This layer owns records, column rules and
 * the facts a card is allowed to expose.
 */
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { DomainError } from "./errors.js";
import { newId, type Store } from "./store.js";
import type {
  ID,
  KanbanAgentKind,
  KanbanCard,
  KanbanColumn,
  KanbanExecutionMode,
  KanbanProject,
  KanbanSession,
  KanbanSessionStatus,
  KanbanWorkspaceType,
} from "./types.js";

/** Every agent id the board accepts. Adding one here is a product decision. */
export const KANBAN_AGENT_KINDS: readonly KanbanAgentKind[] = ["claude", "pi", "opencode", "dsh"];

/** Sessions that still own a live process (or an idle TUI awaiting input). */
export const KANBAN_ACTIVE_STATUSES: readonly KanbanSessionStatus[] = [
  "starting",
  "running",
  "awaiting_review",
  "needs_attention",
];

function now(): string {
  return new Date().toISOString();
}

function isAgentKind(value: unknown): value is KanbanAgentKind {
  return typeof value === "string" && (KANBAN_AGENT_KINDS as readonly string[]).includes(value);
}

function assertAgentKind(value: unknown): KanbanAgentKind {
  if (!isAgentKind(value)) {
    throw new DomainError(
      "kanban-agent-unknown",
      `Unknown kanban agent "${String(value)}" — expected one of ${KANBAN_AGENT_KINDS.join(", ")}`
    );
  }
  return value;
}

function assertExecutionMode(value: unknown): KanbanExecutionMode {
  if (value !== "direct" && value !== "worktree") {
    throw new DomainError("kanban-execution-mode-unavailable", `Unknown execution mode "${String(value)}"`);
  }
  return value;
}

/**
 * Worktree execution needs a Git repository rooted exactly at the board
 * folder. A plain folder, a multi-repo parent or a Google repo checkout has no
 * single worktree root; refusing here is louder than creating something the
 * user did not ask for.
 */
function assertExecutionModeForProject(value: unknown, project: KanbanProject): KanbanExecutionMode {
  const mode = assertExecutionMode(value);
  if (mode === "worktree" && project.workspaceType !== "git") {
    throw new DomainError(
      "kanban-worktree-unavailable",
      `Worktree mode requires a Git repository rooted at the board project folder (workspaceType: ${project.workspaceType})`
    );
  }
  return mode;
}

/** Bounded scan for `.git` directories below a folder (never throws). */
function countNestedGitRepos(rootPath: string, maxEntries = 512, maxDepth = 2): number {
  let seen = 0;
  const walk = (dir: string, depth: number): number => {
    if (seen >= maxEntries || depth > maxDepth) return 0;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let count = 0;
    for (const entry of entries) {
      if (++seen >= maxEntries) break;
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const full = resolve(dir, entry.name);
      if (entry.name === ".git") {
        count += 1;
        continue;
      }
      if (existsSync(resolve(full, ".git"))) {
        count += 1;
        continue;
      }
      count += walk(full, depth + 1);
    }
    return count;
  };
  return walk(rootPath, 1);
}

/**
 * Classifies a project root for display and optional Git features.
 *
 * Discovery is total: a failure degrades to `none` with a warning. It never
 * blocks project creation or a task (v13 §2.1, carrying the fork's fix).
 */
export function detectKanbanWorkspaceType(rootPath: string): {
  workspaceType: KanbanWorkspaceType;
  warning?: string;
} {
  try {
    if (existsSync(resolve(rootPath, ".repo", "manifests", "default.xml"))) {
      return { workspaceType: "google-repo" };
    }
    if (existsSync(resolve(rootPath, ".git"))) return { workspaceType: "git" };
    const nested = countNestedGitRepos(rootPath);
    if (nested >= 1) return { workspaceType: "multi-git" };
    return { workspaceType: "none" };
  } catch (err) {
    return {
      workspaceType: "none",
      warning: `Workspace discovery failed (${err instanceof Error ? err.message : String(err)}); continuing without Git features`,
    };
  }
}

export interface NewKanbanProjectInput {
  name?: string;
  rootPath: string;
}

/**
 * The card title the board generates from a prompt.
 *
 * Mirrors the fork's task-title rule so cards look the same however they were
 * created: first non-empty line, outer XML-ish tags stripped, cut at the first
 * sentence, hard limit 80 characters. The stored title is the source of truth
 * afterwards; this only runs at creation time.
 */
export function deriveKanbanCardTitle(prompt: string, maxChars = 80): string {
  const firstLine =
    prompt
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const stripped = firstLine.replace(/^<[^>]+>/u, "").replace(/<\/[^>]+>$/u, "");
  const normalized = stripped.replaceAll(/\s+/gu, " ").trim();
  if (!normalized) return "";
  const sentence = normalized.match(/^(.+?[.!?])(?:\s|$)/u)?.[1] ?? normalized;
  if (sentence.length <= maxChars) return sentence;
  return `${sentence.slice(0, maxChars).trimEnd()}…`;
}

export interface NewKanbanCardInput {
  title?: string;
  prompt: string;
  agentId: KanbanAgentKind;
  model?: string;
  permissionModeId?: string;
  executionMode?: KanbanExecutionMode;
  baseRef?: string;
}

export type KanbanCardPatch = Partial<
  Pick<KanbanCard, "title" | "prompt" | "agentId" | "model" | "permissionModeId" | "executionMode" | "baseRef">
>;

/**
 * The user-movable column transitions (v13 §六). Everything else is driven by
 * the session runtime; the API never accepts a user "move" for those, because a
 * card in `review` means "a session said it finished", not "the user decided".
 */
const USER_MOVES: Record<KanbanColumn, readonly KanbanColumn[]> = {
  backlog: ["trash"],
  // Without harness hooks (v13 M3) an interactive TUI never reports
  // "ready for review": the explicit Mark for review action is what makes the
  // first phase usable. Drag rules in the UI still keep in_progress ↔ review
  // off the drag path so a stray drag cannot fake a review.
  in_progress: ["trash", "review"],
  review: ["trash"],
  trash: ["review"],
};

export class KanbanService {
  constructor(private store: Store) {}

  listProjects(): KanbanProject[] {
    return this.store.list<KanbanProject>("kanbanProjects");
  }

  getProject(id: ID): KanbanProject {
    const project = this.store.get<KanbanProject>("kanbanProjects", id);
    if (!project) throw new DomainError("kanban-project-not-found", `Board project not found: ${id}`);
    return project;
  }

  async createProject(input: NewKanbanProjectInput): Promise<KanbanProject> {
    if (typeof input.rootPath !== "string" || input.rootPath.trim() === "") {
      throw new DomainError("kanban-project-path-invalid", "A board project needs an absolute directory path");
    }
    const rootPath = resolve(input.rootPath.trim());
    if (!isAbsolute(input.rootPath.trim())) {
      throw new DomainError("kanban-project-path-invalid", `Board project path must be absolute: ${input.rootPath}`);
    }
    let stat;
    try {
      stat = statSync(rootPath);
      accessSync(rootPath, constants.R_OK);
    } catch (err) {
      throw new DomainError(
        "kanban-project-path-invalid",
        `Board project path is not a readable directory: ${rootPath} (${err instanceof Error ? err.message : String(err)})`
      );
    }
    if (!stat.isDirectory()) {
      throw new DomainError("kanban-project-path-invalid", `Board project path is not a directory: ${rootPath}`);
    }
    // One board per folder: two boards over the same tree would show the same
    // working directory twice and make "which board owns this card" ambiguous.
    const existing = this.listProjects().find((project) => resolve(project.rootPath) === rootPath);
    if (existing) {
      throw new DomainError(
        "kanban-project-duplicate",
        `This folder is already a board project: ${existing.name} (${existing.rootPath})`
      );
    }
    const discovery = detectKanbanWorkspaceType(rootPath);
    const project: KanbanProject = {
      id: newId("kbproj"),
      name:
        (typeof input.name === "string" && input.name.trim()) ||
        basename(rootPath) ||
        rootPath,
      rootPath,
      workspaceType: discovery.workspaceType,
      ...(discovery.warning ? { discoveryWarning: discovery.warning } : {}),
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("kanbanProjects", project);
  }

  async updateProject(id: ID, patch: Partial<Pick<KanbanProject, "name" | "defaultAgentId" | "defaultExecutionMode">>): Promise<KanbanProject> {
    const project = this.getProject(id);
    const next: Partial<KanbanProject> = { updatedAt: now() };
    if (patch.name !== undefined) next.name = String(patch.name);
    if (patch.defaultAgentId !== undefined) next.defaultAgentId = assertAgentKind(patch.defaultAgentId);
    if (patch.defaultExecutionMode !== undefined) {
      next.defaultExecutionMode = assertExecutionModeForProject(patch.defaultExecutionMode, project);
    }
    return (await this.store.update<KanbanProject>("kanbanProjects", project.id, next))!;
  }

  async deleteProject(id: ID): Promise<void> {
    this.getProject(id);
    const cards = this.listCards(id);
    for (const card of cards) {
      for (const session of this.listSessions(card.id)) {
        await this.store.remove("kanbanSessions", session.id);
      }
      await this.store.remove("kanbanCards", card.id);
    }
    await this.store.remove("kanbanProjects", id);
  }

  listCards(projectId: ID): KanbanCard[] {
    return this.store
      .list<KanbanCard>("kanbanCards")
      .filter((card) => card.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getAllCards(): KanbanCard[] {
    return this.store.list<KanbanCard>("kanbanCards");
  }

  getCard(id: ID): KanbanCard {
    const card = this.store.get<KanbanCard>("kanbanCards", id);
    if (!card) throw new DomainError("kanban-card-not-found", `Kanban card not found: ${id}`);
    return card;
  }

  async createCard(projectId: ID, input: NewKanbanCardInput): Promise<KanbanCard> {
    const project = this.getProject(projectId);
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new DomainError("kanban-session-not-startable", "A card needs a prompt");
    const agentId = assertAgentKind(input.agentId ?? project.defaultAgentId ?? "claude");
    const executionMode = assertExecutionModeForProject(
      input.executionMode ?? project.defaultExecutionMode ?? "direct",
      project
    );
    const card: KanbanCard = {
      id: newId("kbcard"),
      projectId,
      title: (typeof input.title === "string" && input.title.trim()) || deriveKanbanCardTitle(prompt) || prompt.slice(0, 80),
      prompt,
      column: "backlog",
      agentId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.permissionModeId ? { permissionModeId: input.permissionModeId } : {}),
      executionMode,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("kanbanCards", card);
  }

  async updateCard(id: ID, patch: KanbanCardPatch): Promise<KanbanCard> {
    const card = this.getCard(id);
    const next: Partial<KanbanCard> = { updatedAt: now() };
    if (patch.title !== undefined) next.title = String(patch.title);
    if (patch.prompt !== undefined) {
      if (!String(patch.prompt).trim()) throw new DomainError("kanban-session-not-startable", "A card needs a prompt");
      next.prompt = String(patch.prompt);
    }
    if (patch.agentId !== undefined) next.agentId = assertAgentKind(patch.agentId);
    if (patch.model !== undefined) next.model = patch.model || undefined;
    if (patch.permissionModeId !== undefined) next.permissionModeId = patch.permissionModeId || undefined;
    if (patch.executionMode !== undefined) {
      next.executionMode = assertExecutionModeForProject(patch.executionMode, this.getProject(card.projectId));
    }
    if (patch.baseRef !== undefined) next.baseRef = String(patch.baseRef).trim() || undefined;
    return (await this.store.update<KanbanCard>("kanbanCards", id, next))!;
  }

  /**
   * A user move. Only the transitions in `USER_MOVES` are accepted; the
   * session-driven moves (in_progress ↔ review) go through `setColumn`.
   */
  async moveCard(id: ID, column: KanbanColumn): Promise<KanbanCard> {
    const card = this.getCard(id);
    if (!(USER_MOVES[card.column] ?? []).includes(column)) {
      throw new DomainError(
        "kanban-session-not-startable",
        `Cannot move a card from ${card.column} to ${column}: in_progress/review are driven by the session`
      );
    }
    return (await this.store.update<KanbanCard>("kanbanCards", id, { column, updatedAt: now() }))!;
  }

  /** Internal, session-driven column write. No user-rule check. */
  async setColumn(id: ID, column: KanbanColumn): Promise<KanbanCard> {
    this.getCard(id);
    return (await this.store.update<KanbanCard>("kanbanCards", id, { column, updatedAt: now() }))!;
  }

  async deleteCard(id: ID): Promise<void> {
    this.getCard(id);
    for (const session of this.listSessions(id)) {
      await this.store.remove("kanbanSessions", session.id);
    }
    await this.store.remove("kanbanCards", id);
  }

  listSessions(cardId?: ID): KanbanSession[] {
    const all = this.store.list<KanbanSession>("kanbanSessions");
    return cardId ? all.filter((s) => s.cardId === cardId) : all;
  }

  getSession(id: ID): KanbanSession {
    const session = this.store.get<KanbanSession>("kanbanSessions", id);
    if (!session) throw new DomainError("kanban-session-not-found", `Kanban session not found: ${id}`);
    return session;
  }

  /** The card's most recent session, if it was ever started. */
  latestSessionForCard(cardId: ID): KanbanSession | undefined {
    const card = this.store.get<KanbanCard>("kanbanCards", cardId);
    if (card?.sessionId) {
      const session = this.store.get<KanbanSession>("kanbanSessions", card.sessionId);
      if (session) return session;
    }
    const sessions = this.listSessions(cardId);
    return sessions[sessions.length - 1];
  }

  async createSession(
    card: KanbanCard,
    input: { cwd: string; interactiveTui: boolean }
  ): Promise<KanbanSession> {
    const session: KanbanSession = {
      id: newId("kbsess"),
      cardId: card.id,
      agentId: card.agentId,
      cwd: input.cwd,
      executionMode: card.executionMode,
      status: "starting",
      interactiveTui: input.interactiveTui,
      startedAt: now(),
    };
    await this.store.insert("kanbanSessions", session);
    await this.store.update<KanbanCard>("kanbanCards", card.id, {
      column: "in_progress",
      sessionId: session.id,
      updatedAt: now(),
    });
    return session;
  }

  async updateSession(id: ID, patch: Partial<KanbanSession>): Promise<KanbanSession> {
    this.getSession(id);
    return (await this.store.update<KanbanSession>("kanbanSessions", id, patch))!;
  }

  /**
   * Settles a session and applies its board consequence in one place:
   * a clean finish moves the card to `review`; anything else leaves it in
   * `in_progress` with the session status carrying the detail.
   */
  async settleSession(
    id: ID,
    input: { status: KanbanSessionStatus; exitCode?: number; error?: string }
  ): Promise<KanbanSession> {
    const session = await this.updateSession(id, {
      status: input.status,
      endedAt: now(),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    });
    if (input.status === "awaiting_review") {
      await this.setColumn(session.cardId, "review");
    }
    return session;
  }

  /** Mark every non-terminal session interrupted after a restart (v13 §3.4). */
  async recoverInterrupted(): Promise<ID[]> {
    const interrupted: ID[] = [];
    for (const session of this.listSessions()) {
      if (!KANBAN_ACTIVE_STATUSES.includes(session.status)) continue;
      await this.updateSession(session.id, {
        status: "interrupted",
        endedAt: now(),
        error: "AgentFabric restarted while this session was running",
      });
      interrupted.push(session.id);
    }
    return interrupted;
  }
}
