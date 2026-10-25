/**
 * Kanban domain service (v13, unified with Projects and Tasks).
 *
 * The board has no project collection of its own: a board project **is** a
 * `Project` (added through `addProject()`), whose root directory comes from the
 * Project's own `source`. A card is a prompt + an agent + a working mode, and
 * the work it produces is a real `Task`: the card's first start creates the
 * Task, every new start adds one `Run` of it, and the live agent process is a
 * `KanbanSession` handle whose id equals that Run's id.
 *
 * Nothing here starts a process — the server's session runtime owns PTYs and
 * ACP children. This layer owns records, column rules, and the **write-time
 * projection** from a board session onto `Task.execution` + `Run`: computed
 * once, when the fact happens, then stored. No read path re-derives it.
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
  KanbanSession,
  KanbanSessionModelRoute,
  KanbanSessionStatus,
  KanbanSessionTransport,
  KanbanWorkspaceType,
  Project,
  ProjectBoardSettings,
  Run,
  RunStatus,
  Runtime,
  RuntimeSessionRef,
  Task,
  TaskAgentState,
  TaskExecution,
  TaskStageStates,
  Workspace,
} from "./types.js";
import type {
  ProjectService,
  RuntimeService,
  RuntimeSessionService,
  TaskService,
  WorkspaceService,
} from "./services.js";
import type { RunService } from "./orchestrator.js";

/** Every agent id the board accepts. Adding one here is a product decision. */
export const KANBAN_AGENT_KINDS: readonly KanbanAgentKind[] = ["claude", "pi", "opencode", "dsh"];

/** Sessions that still own a live process (or an idle TUI awaiting input). */
export const KANBAN_ACTIVE_STATUSES: readonly KanbanSessionStatus[] = [
  "starting",
  "running",
  "awaiting_review",
  "needs_attention",
];

/**
 * The harness `Runtime.kind` each board agent runs on. A board agent without a
 * matching runtime is a configuration error, never a silent fallback.
 */
const RUNTIME_KIND_BY_AGENT: Record<KanbanAgentKind, string> = {
  claude: "claude-code",
  pi: "pi",
  opencode: "opencode",
  dsh: "dsh",
};

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
function assertExecutionModeForProject(value: unknown, workspaceType: KanbanWorkspaceType): KanbanExecutionMode {
  const mode = assertExecutionMode(value);
  if (mode === "worktree" && workspaceType !== "git") {
    throw new DomainError(
      "kanban-worktree-unavailable",
      `Worktree mode requires a Git repository rooted at the board project folder (workspaceType: ${workspaceType})`
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

/**
 * The directory a board project works in, or a loud failure.
 *
 * A `directory` source carries its own path. A `git` source has no directory of
 * its own — the board folder is the clone the user made — so it is resolved
 * from the external Workspace (`projectId`) that the cards record. There is no
 * guessed path and no empty string: an unresolvable board root is an error.
 */
export function boardProjectRoot(project: Project, workspace?: Workspace): string {
  if (project.source.type === "directory") {
    const path = project.source.path;
    if (!path) {
      throw new DomainError(
        "kanban-project-path-invalid",
        `Board project ${project.id} has a directory source without a path`
      );
    }
    return resolve(path);
  }
  if (!workspace?.path) {
    throw new DomainError(
      "kanban-project-path-invalid",
      `Board project ${project.id} works on a git source, so its folder can only come from its external workspace (workspace: ${workspace?.id ?? "none"})`
    );
  }
  return resolve(workspace.path);
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
  /** ACP only: `reasoning_effort` value to select before the first turn. */
  reasoningEffort?: string;
  permissionModeId?: string;
  executionMode?: KanbanExecutionMode;
  baseRef?: string;
}

export type KanbanCardPatch = Partial<
  Pick<
    KanbanCard,
    "title" | "prompt" | "agentId" | "model" | "reasoningEffort" | "permissionModeId" | "executionMode" | "baseRef"
  >
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

/**
 * The services the board writes through. `projects` and `runtimes` cover the
 * board itself; the other three are needed the moment a card is started, which
 * is what makes a card a Task.
 */
export interface KanbanServiceDeps {
  projects: ProjectService;
  runtimes: RuntimeService;
  tasks?: TaskService;
  runs?: RunService;
  workspaces?: WorkspaceService;
  /** Native session records, so a board Run can be resumed like any other. */
  runtimeSessions?: RuntimeSessionService;
}

export interface KanbanSessionPatch {
  status?: KanbanSessionStatus;
  cwd?: string;
  nativeSessionId?: string;
  modelRoute?: KanbanSessionModelRoute;
  reasoningEffort?: string;
  lastHookEvent?: string;
  lastHookAt?: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface KanbanStartInput {
  /** Directory the agent process runs in: board folder, or the card's worktree. */
  cwd: string;
  interactiveTui: boolean;
  transport: KanbanSessionTransport;
  /**
   * Continue the previous attempt instead of recording a new one. The resumed
   * harness process belongs to the Run that already exists, so its handle is
   * reopened and no Run is added.
   */
  resume?: boolean;
}

export interface KanbanStartResult {
  /** The card as written by this start (`taskId` / `runId` / column). */
  card: KanbanCard;
  task: Task;
  run: Run;
  session: KanbanSession;
  /** True when this start created the card's Task. */
  taskCreated: boolean;
  /** True when a previous attempt was reopened (no new Run). */
  resumed: boolean;
}

/** How one session status lands on the Run and the card's Task. */
interface SessionOutcome {
  run: RunStatus;
  phase: TaskExecution["phase"];
  status: TaskExecution["status"];
  agent: TaskAgentState["status"];
  /** `null` = the run is still going; the failure fields stay untouched. */
  stage: TaskStageStates["agent"] | undefined;
  failureCode?: string;
}

/**
 * The projection table (spec kanban-task-unification §2), as data.
 *
 * `awaiting_review` / `needs_attention` complete the **Run**: the agent's turn
 * is over and the work waits for the user. The Task stays `running` — it is
 * not failed, cancelled or done, and the board has no validation or publish
 * stage to advance it to.
 */
function sessionOutcome(status: KanbanSessionStatus, at: string): SessionOutcome {
  switch (status) {
    case "starting":
      return { run: "starting", phase: "agent.running", status: "running", agent: "pending", stage: undefined };
    case "running":
      return { run: "running", phase: "agent.running", status: "running", agent: "running", stage: undefined };
    case "awaiting_review":
    case "needs_attention":
      return {
        run: "completed",
        phase: "agent.running",
        status: "running",
        agent: "completed",
        stage: { status: "completed", at },
      };
    case "failed":
      return {
        run: "failed",
        phase: "failed",
        status: "failed",
        agent: "failed",
        stage: { status: "failed", at, errorCode: "kanban-agent-failed" },
        failureCode: "kanban-agent-failed",
      };
    case "interrupted":
      // A restart cut the process off. That is worth failing loudly for — the
      // agent's turn may have been half done — but the Run is `cancelled`: it
      // was not the agent that failed.
      return {
        run: "cancelled",
        phase: "failed",
        status: "failed",
        agent: "cancelled",
        stage: { status: "interrupted", at, errorCode: "kanban-session-interrupted" },
        failureCode: "kanban-session-interrupted",
      };
    case "stopped":
      // A stop the user asked for is not a failure. Writing `status: "failed"`
      // here (as this used to) left a retry prompt on a task nothing went wrong
      // with, so the task now says what actually happened: the agent was
      // cancelled. `phase`/`status` mirror the pending-agent state a `created`
      // task has, which is honest — the work is paused, not broken.
      return {
        run: "cancelled",
        phase: "agent.running",
        status: "running",
        agent: "cancelled",
        stage: { status: "cancelled", at },
      };
  }
}

/**
 * The complete `Task.execution` a board session change writes: every field is
 * produced here, every time. Only `stages` and the untouched
 * `validation`/`publish` parts carry forward from the previous value — the
 * board never fabricates a validation verdict or a publish result.
 */
function projectExecution(input: {
  previous?: TaskExecution;
  outcome: SessionOutcome;
  runId: ID;
  at: string;
  error?: string;
}): TaskExecution {
  const { previous, outcome, runId, at, error } = input;
  const stages: TaskStageStates = { ...(previous?.stages ?? {}) };
  if (outcome.stage) stages.agent = { ...outcome.stage };
  return {
    phase: outcome.phase,
    status: outcome.status,
    // `failure` is derived from the session's *current* status, never carried
    // over: a card that failed and was then restarted must not keep reporting a
    // failure the new attempt has already superseded.
    ...(outcome.failureCode
      ? {
          failure: {
            stage: "agent" as const,
            code: outcome.failureCode,
            message: error?.trim() || outcome.failureCode,
            at,
          },
        }
      : { failure: undefined }),
    agent: { status: outcome.agent, runId, attempts: 1, ...(error ? { error } : {}) },
    validation: previous?.validation ?? { status: "pending", attempts: 0 },
    publish: previous?.publish ?? { status: "pending", attempts: 0 },
    stages,
    updatedAt: at,
  };
}

function assertSessionPatch(patch: KanbanSessionPatch & Partial<KanbanSession>): void {
  // A handle's identity is fixed at creation: it is the Run's id and it belongs
  // to one card forever. Moving either would orphan the run's events.
  if (patch.id !== undefined) throw new DomainError("kanban-session-not-found", "A board session's id cannot be changed");
  if (patch.cardId !== undefined) throw new DomainError("kanban-session-not-found", "A board session cannot change its card");
  if (patch.runId !== undefined) throw new DomainError("kanban-session-not-found", "A board session's run cannot be changed");
}

export class KanbanService {
  constructor(
    private store: Store,
    private deps: KanbanServiceDeps
  ) {}

  /* ---------------- projects: they are Projects ---------------- */

  /**
   * Adds a folder to the board: validates the directory, discovers its shape
   * and creates a `Project` with a `directory` source plus board settings.
   *
   * Git initialisation (the "this folder is not a repository yet" question) is
   * a board-specific conversation owned by the server; what is stored here is
   * only what the model owns.
   */
  async addProject(input: NewKanbanProjectInput): Promise<Project> {
    if (typeof input.rootPath !== "string" || input.rootPath.trim() === "") {
      throw new DomainError("kanban-project-path-invalid", "A board project needs an absolute directory path");
    }
    if (!isAbsolute(input.rootPath.trim())) {
      throw new DomainError("kanban-project-path-invalid", `Board project path must be absolute: ${input.rootPath}`);
    }
    const rootPath = resolve(input.rootPath.trim());
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
    const existing = this.deps.projects
      .list()
      .find((project) => project.source.path !== undefined && resolve(project.source.path) === rootPath);
    if (existing) {
      throw new DomainError(
        "kanban-project-duplicate",
        `This folder is already a board project: ${existing.name} (${rootPath})`
      );
    }
    const discovery = detectKanbanWorkspaceType(rootPath);
    return this.deps.projects.create({
      name: (typeof input.name === "string" && input.name.trim()) || basename(rootPath) || rootPath,
      // `workTree: true` keeps the board's in-place contract: the card works in
      // the folder the user picked. Without it the platform makes a managed copy
      // per task, and the card's Task never touches that folder.
      source: { type: "directory", path: rootPath, workTree: true },
      board: {
        workspaceType: discovery.workspaceType,
        ...(discovery.warning ? { discoveryWarning: discovery.warning } : {}),
      },
    });
  }

  getProject(id: ID): Project {
    const project = this.deps.projects.get(id);
    if (!project) throw new DomainError("kanban-project-not-found", `Board project not found: ${id}`);
    return project;
  }

  /** The board folder of a project (see `boardProjectRoot`). */
  rootOf(project: Project): string {
    return boardProjectRoot(project, this.workspaceFor(project));
  }

  /* ---------------- cards ---------------- */

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

  /**
   * Creates a card and fixes its working directory on the record: the
   * Project's external Workspace, created on first use.
   */
  async createCard(projectId: ID, input: NewKanbanCardInput): Promise<KanbanCard> {
    const project = this.getProject(projectId);
    const board = this.boardSettings(project);
    const workspace = await this.ensureWorkspace(project);
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new DomainError("kanban-session-not-startable", "A card needs a prompt");
    const agentId = assertAgentKind(input.agentId ?? board.defaultAgentId ?? "claude");
    const executionMode = assertExecutionModeForProject(
      input.executionMode ?? board.defaultExecutionMode ?? "direct",
      board.workspaceType
    );
    const card: KanbanCard = {
      id: newId("kbcard"),
      projectId,
      title:
        (typeof input.title === "string" && input.title.trim()) || deriveKanbanCardTitle(prompt) || prompt.slice(0, 80),
      prompt,
      column: "backlog",
      agentId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.permissionModeId ? { permissionModeId: input.permissionModeId } : {}),
      executionMode,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      workspaceId: workspace.id,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.insert("kanbanCards", card);
  }

  async updateCard(id: ID, patch: KanbanCardPatch): Promise<KanbanCard> {
    const card = this.getCard(id);
    const board = this.boardSettings(this.getProject(card.projectId));
    const next: Partial<KanbanCard> = { updatedAt: now() };
    if (patch.title !== undefined) next.title = String(patch.title);
    if (patch.prompt !== undefined) {
      if (!String(patch.prompt).trim()) throw new DomainError("kanban-session-not-startable", "A card needs a prompt");
      next.prompt = String(patch.prompt);
    }
    if (patch.agentId !== undefined) next.agentId = assertAgentKind(patch.agentId);
    if (patch.model !== undefined) next.model = patch.model || undefined;
    if (patch.reasoningEffort !== undefined) next.reasoningEffort = patch.reasoningEffort || undefined;
    if (patch.permissionModeId !== undefined) next.permissionModeId = patch.permissionModeId || undefined;
    if (patch.executionMode !== undefined) {
      next.executionMode = assertExecutionModeForProject(patch.executionMode, board.workspaceType);
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

  /**
   * Removes a card. Its Task is soft-deleted (recoverable from the trash), never
   * physically deleted; the process handles go with the card.
   */
  async deleteCard(id: ID): Promise<void> {
    const card = this.getCard(id);
    for (const session of this.listSessions(card.id)) {
      await this.store.remove("kanbanSessions", session.id);
    }
    if (card.taskId) await this.deps.tasks?.softDelete(card.taskId);
    await this.store.remove("kanbanCards", id);
  }

  /* ---------------- sessions: process handles + the task projection ---------------- */

  listSessions(cardId?: ID): KanbanSession[] {
    const all = this.store.list<KanbanSession>("kanbanSessions");
    return cardId ? all.filter((s) => s.cardId === cardId) : all;
  }

  getSession(id: ID): KanbanSession {
    const session = this.store.get<KanbanSession>("kanbanSessions", id);
    if (!session) throw new DomainError("kanban-session-not-found", `Kanban session not found: ${id}`);
    return session;
  }

  /**
   * The card's most recent session. `card.runId` is the only pointer: a card
   * with no attempt yet has no session.
   */
  latestSessionForCard(cardId: ID): KanbanSession | undefined {
    const card = this.store.get<KanbanCard>("kanbanCards", cardId);
    if (!card?.runId) return undefined;
    return this.store.get<KanbanSession>("kanbanSessions", card.runId);
  }

  /** The Task a started card produced. */
  getTaskForCard(cardId: ID): Task | undefined {
    const card = this.getCard(cardId);
    return card.taskId ? this.deps.tasks?.get(card.taskId) : undefined;
  }

  /**
   * Starts one attempt of a card — the single place where the board writes a
   * Task:
   *
   * 1. resolve the harness runtime the card's agent runs on (else fail);
   * 2. create the Task on the first start, carrying the card's identity and a
   *    complete `execution` (phase `agent.running`, status `running`);
   * 3. add one Run through `RunService` — on every new start, rerun or not;
   * 4. create the `KanbanSession` handle whose id **is** that Run's id, point
   *    the card at `taskId`/`runId` and move it to `in_progress`.
   *
   * `resume: true` reopens the previous attempt instead: the harness process
   * that continues the conversation belongs to the Run that already exists, so
   * no second Run is recorded for it.
   */
  async startAttempt(cardId: ID, input: KanbanStartInput): Promise<KanbanStartResult> {
    const card = this.getCard(cardId);
    const { tasks, runs } = this.writeServices();
    const project = this.getProject(card.projectId);
    // Fails loudly for a plain (non-board) Project before anything is written.
    this.boardSettings(project);
    const workspace = await this.ensureWorkspace(project);
    const cwd = resolve(input.cwd || boardProjectRoot(project, workspace));

    if (input.resume) {
      const previous = this.latestSessionForCard(card.id);
      if (previous) {
        const resumedRun = runs.get(previous.runId);
        if (!resumedRun) {
          throw new DomainError(
            "task-not-found",
            `Board session ${previous.id} points at a missing run: ${previous.runId}`
          );
        }
        const resumedTask = tasks.get(resumedRun.taskId);
        if (!resumedTask) {
          throw new DomainError("task-not-found", `Run ${resumedRun.id} points at a missing task: ${resumedRun.taskId}`);
        }
        // The process that continues the conversation is the same run: the
        // handle is reopened as it is, so the run's events and the task's
        // history stay one line instead of forking a second attempt.
        const session = await this.updateSession(previous.id, {
          status: "starting",
          cwd,
          endedAt: undefined,
          exitCode: undefined,
          error: undefined,
          lastHookEvent: "resume",
          lastHookAt: now(),
        });
        await this.setColumn(card.id, "in_progress");
        return {
          card: this.getCard(card.id),
          task: resumedTask,
          run: resumedRun,
          session,
          taskCreated: false,
          resumed: true,
        };
      }
    }

    const runtime = this.runtimeForAgent(card.agentId);
    const at = now();
    let task: Task;
    const taskCreated = card.taskId === undefined;
    if (card.taskId) {
      const existing = tasks.get(card.taskId);
      if (!existing) {
        throw new DomainError("task-not-found", `Kanban card ${card.id} points at a missing task: ${card.taskId}`);
      }
      task = existing;
    } else {
      task = await tasks.create({
        title: card.title,
        prompt: card.prompt,
        projectId: card.projectId,
        workspaceId: workspace.id,
        runtimeId: runtime.id,
        metadata: { board: { cardId: card.id }, lastActivityAt: at },
        execution: projectExecution({ outcome: sessionOutcome("starting", at), runId: "", at }),
      });
    }

    const run = await runs.recordRunForTask(task, {
      runtimeId: task.runtimeId ?? runtime.id,
      workspaceId: task.workspaceId ?? workspace.id,
      projectId: card.projectId,
      phase: "agent.running",
      status: "running",
      purpose: "development",
      runtimeName: card.agentId,
      inputInstruction: card.prompt,
      userPrompt: card.prompt,
      continuity: taskCreated ? "new" : "resume",
    });
    await runs.recordRunEvent(run.id, "run.started", {
      taskId: task.id,
      cardId: card.id,
      sessionId: run.id,
      agentId: card.agentId,
      executionMode: card.executionMode,
    });

    const session: KanbanSession = {
      id: run.id,
      cardId: card.id,
      runId: run.id,
      agentId: card.agentId,
      cwd,
      executionMode: card.executionMode,
      status: "starting",
      interactiveTui: input.interactiveTui,
      transport: input.transport,
      startedAt: at,
    };
    await this.store.insert("kanbanSessions", session);

    const updatedCard = (await this.store.update<KanbanCard>("kanbanCards", card.id, {
      column: "in_progress",
      taskId: task.id,
      runId: run.id,
      workspaceId: workspace.id,
      updatedAt: at,
    }))!;
    // The task's execution names its latest run, so it is written after the run
    // exists — still one projection, computed here and stored.
    const updatedTask = await this.writeTaskExecution(task, {
      outcome: sessionOutcome("starting", at),
      runId: run.id,
      at,
    });
    return {
      card: updatedCard,
      task: updatedTask ?? task,
      run,
      session,
      taskCreated,
      resumed: false,
    };
  }

  /**
   * Writes a session record and applies its consequence to the Run and the
   * card's Task in the same step. Callers mutate facts (status, native session
   * id, cwd, …) and the projection follows; no reader ever re-derives it.
   */
  async updateSession(id: ID, patch: KanbanSessionPatch): Promise<KanbanSession> {
    assertSessionPatch(patch);
    const before = this.getSession(id);
    const next = (await this.store.update<KanbanSession>("kanbanSessions", id, patch))!;
    // The harness's own session id is the only thing that makes a board
    // conversation resumable, so it is recorded on the Run the moment it is
    // known — when the ACP handshake completes and when a hook reports it. A
    // Run without it is one nobody can continue (no `previousHandoff`, no
    // "resume this run" offer), and that must not happen just because the
    // record was settled before the id arrived.
    if (patch.nativeSessionId !== undefined && patch.nativeSessionId !== before.nativeSessionId) {
      await this.recordNativeSession(next);
    }
    if (patch.status !== undefined) {
      await this.syncSession(next, patch.status, next.error);
    }
    return next;
  }

  /**
   * Points the session's Run at its harness session (`runtimeSessionRefId`).
   *
   * One ref per Run: a resume that produces a new harness session updates the
   * same ref instead of piling up records that all claim to be the Run's
   * session.
   */
  private async recordNativeSession(session: KanbanSession): Promise<void> {
    const { runs, runtimeSessions } = this.deps;
    if (!runs || !runtimeSessions || !session.nativeSessionId) return;
    const run = this.store.get<Run>("runs", session.runId);
    if (!run) return;
    const existing = run.runtimeSessionRefId
      ? this.store.get<RuntimeSessionRef>("runtimeSessions", run.runtimeSessionRefId)
      : undefined;
    const input = {
      runtimeKind: (run.runtimeName ?? session.agentId) as RuntimeSessionRef["runtimeKind"],
      nativeSessionRef: session.nativeSessionId,
      // ACP drives `session/resume`; a PTY harness resumes via its own
      // `--resume` flag. Both are advertised by the catalog, so a board Run is
      // resumable whenever the harness gave us an id at all.
      resumeSupported: true,
      taskId: run.taskId,
      runId: run.id,
      workspaceId: run.workspaceId,
      executionBackend: "local" as const,
      metadata: { board: true, sessionId: session.id, agentId: session.agentId },
    };
    if (existing) {
      await this.store.update<RuntimeSessionRef>("runtimeSessions", existing.id, {
        ...input,
        status: "active",
        updatedAt: now(),
      });
      return;
    }
    const ref = await runtimeSessions.register(input);
    await this.store.update<Run>("runs", run.id, { runtimeSessionRefId: ref.id, updatedAt: now() });
  }

  /**
   * Settles a session and applies its board consequence in one place: a clean
   * finish moves the card to `review`; anything else leaves it in `in_progress`
   * with the session status carrying the detail. The Run and the task's
   * execution are written here too (see the projection table).
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

  /**
   * Restart recovery: no board process survived, so every session that was
   * still active is settled as interrupted and its Run + Task say so
   * (`kanban-session-interrupted`). Returns the settled session ids.
   */
  async recoverInterrupted(): Promise<ID[]> {
    const interrupted: ID[] = [];
    for (const session of this.listSessions()) {
      if (!KANBAN_ACTIVE_STATUSES.includes(session.status)) continue;
      await this.settleSession(session.id, {
        status: "interrupted",
        error: "AgentFabric restarted while this session was running",
      });
      interrupted.push(session.id);
    }
    return interrupted;
  }

  /* ---------------- internals ---------------- */

  private writeServices(): { tasks: TaskService; runs: RunService; workspaces: WorkspaceService } {
    const { tasks, runs, workspaces } = this.deps;
    if (!tasks || !runs || !workspaces) {
      throw new DomainError(
        "config-invalid",
        "The kanban service was created without its task, run and workspace services — a board card cannot start without them"
      );
    }
    return { tasks, runs, workspaces };
  }

  private boardSettings(project: Project): ProjectBoardSettings {
    if (!project.board) {
      throw new DomainError(
        "kanban-project-path-invalid",
        `Project ${project.id} (${project.name}) is not a board project — it has no board settings`
      );
    }
    return project.board;
  }

  private runtimeForAgent(agentId: KanbanAgentKind): Runtime {
    const kind = RUNTIME_KIND_BY_AGENT[agentId];
    const runtime = this.deps.runtimes.list().find((candidate) => candidate.kind === kind);
    if (!runtime) {
      throw new DomainError(
        "kanban-runtime-missing",
        `No ${kind} runtime is configured — add one before starting a "${agentId}" card`
      );
    }
    return runtime;
  }

  /** The Project's external Workspace (the board folder), if it exists. */
  private workspaceFor(project: Project): Workspace | undefined {
    return this.deps.workspaces
      ?.list()
      .find((candidate) => candidate.projectId === project.id && candidate.ownership === "external");
  }

  /**
   * The Project's external Workspace: the board folder, user-owned.
   *
   * Found by `projectId` among external workspaces, so a `git`-sourced board
   * project — whose folder exists only as a workspace — resolves the same
   * record. Created when missing, refreshed when the Project's directory moved.
   *
   * The path is the folder **itself**, never a managed copy: the board runs a
   * local agent CLI in the directory the user picked, so this Workspace is what
   * makes a card's Task show up under that folder in the workspace tree. A
   * Project that already has a *managed* Workspace (a Project-task copy) is
   * therefore refused instead of being run in place behind the user's back.
   */
  async ensureWorkspace(project: Project): Promise<Workspace> {
    const { workspaces } = this.writeServices();
    const managed = this.deps.workspaces
      ?.list()
      .find((candidate) => candidate.projectId === project.id && candidate.ownership === "managed");
    if (managed) {
      throw new DomainError(
        "kanban-project-path-invalid",
        `Board project ${project.id} already has a managed workspace (${managed.id}) — a board card runs in the project folder itself, not in a per-task copy`
      );
    }
    const existing = this.workspaceFor(project);
    const desiredPath = project.source.type === "directory" ? project.source.path : undefined;
    if (existing) {
      if (desiredPath && existing.path !== resolve(desiredPath)) {
        return (await this.store.update<Workspace>("workspaces", existing.id, { path: resolve(desiredPath) }))!;
      }
      return existing;
    }
    if (!desiredPath) {
      throw new DomainError(
        "kanban-project-path-invalid",
        `Board project ${project.id} works on a git source and has no external workspace yet — its board folder cannot be resolved`
      );
    }
    const workspace = await workspaces.create({ name: project.name, type: "local", path: desiredPath });
    return (await this.store.update<Workspace>("workspaces", workspace.id, { projectId: project.id }))!;
  }

  /**
   * Mirrors one session status onto its Run (and its lifecycle event) — the
   * whole projection table, in one place. The Task is written by the same
   * status change through `writeTaskExecution`.
   */
  private async syncSession(session: KanbanSession, status: KanbanSessionStatus, error?: string): Promise<void> {
    const at = now();
    const outcome = sessionOutcome(status, at);
    const run = this.store.get<Run>("runs", session.runId);
    if (!run) {
      throw new DomainError("task-not-found", `Board session ${session.id} points at a missing run: ${session.runId}`);
    }
    await this.store.update<Run>("runs", run.id, { status: outcome.run, updatedAt: at });
    const eventType =
      outcome.run === "completed"
        ? "run.completed"
        : outcome.run === "failed"
          ? "run.failed"
          : outcome.run === "cancelled"
            ? "run.cancelled"
            : outcome.run === "running" || outcome.run === "starting"
              ? "run.phase"
              : undefined;
    if (eventType && this.deps.runs) {
      await this.deps.runs.recordRunEvent(run.id, eventType, {
        sessionId: session.id,
        cardId: session.cardId,
        sessionStatus: status,
        runStatus: outcome.run,
        ...(error ? { error } : {}),
      });
    }
    const card = this.store.get<KanbanCard>("kanbanCards", session.cardId);
    const task = card?.taskId ? this.deps.tasks?.get(card.taskId) : undefined;
    if (task) {
      await this.writeTaskExecution(task, { outcome, runId: run.id, at, ...(error ? { error } : {}) });
    }
  }

  /** Writes the complete projected `Task.execution` plus `metadata.lastActivityAt`. */
  private async writeTaskExecution(
    task: Task,
    input: { outcome: SessionOutcome; runId: ID; at: string; error?: string }
  ): Promise<Task | undefined> {
    const { tasks } = this.writeServices();
    const execution = projectExecution({
      previous: task.execution,
      outcome: input.outcome,
      runId: input.runId,
      at: input.at,
      ...(input.error ? { error: input.error } : {}),
    });
    return tasks.update(task.id, {
      execution,
      metadata: { ...(task.metadata ?? {}), lastActivityAt: input.at },
    });
  }
}
