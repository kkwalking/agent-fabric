import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ApiError, del, fmtTime, get, post, shortId } from "../api";
import { ErrorBox, Icon, Modal, StatusBadge } from "../components";
import { BoardTerminal } from "../components/BoardTerminal";
import { AddProjectDialog } from "../components/board/AddProjectDialog";
import { TaskCreateDialog } from "../components/board/TaskCreateDialog";
import type { TaskCreateSubmissionOptions } from "../components/board/TaskCreateForm";
import type {
  BoardColumnId,
  ExecutionMode,
  KanbanAgent,
  KanbanCard,
  KanbanGitInfo,
  KanbanProject,
  KanbanSession,
  SessionStatus,
  TaskDraft,
  TaskFormDefaults,
  WorkspaceType,
} from "../components/board/types";

/**
 * Board (v13 §七): four fixed columns over one BoardProject directory, with
 * local agent sessions and their live PTY terminals. This is a separate
 * product surface from Tasks/Projects — a board project is any folder, not a
 * Git source, and cards never enter the coding-task lifecycle.
 *
 * Project creation and task creation follow the Cline Kanban fork's flow:
 * - add a project from a server-path picker or a Git clone, with the
 *   "this folder is not Git" decision left to the user;
 * - create a card from the Backlog column or the "New task" dialog, choosing
 *   agent, model, permission mode, workspace mode and worktree base ref.
 *
 * The server owns column transitions (§六); this view renders state and
 * performs the whitelisted user moves. Direct↔Review transitions are
 * programmatic only, so user drags there are refused here as well as server
 * side.
 */

const COLUMNS: { id: BoardColumnId; label: string; hint: string }[] = [
  { id: "backlog", label: "Backlog", hint: "Queued cards" },
  { id: "in_progress", label: "In Progress", hint: "Agent sessions running" },
  { id: "review", label: "Review", hint: "Awaiting your review" },
  { id: "trash", label: "Done", hint: "Stopped and trashed" },
];

const COLUMN_LABEL: Record<BoardColumnId, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  review: "Review",
  trash: "Done",
};

/** Letters used by the project-list count badges (fork uses B / IP / R / D). */
const COUNT_KEY: Record<BoardColumnId, string> = {
  backlog: "B",
  in_progress: "IP",
  review: "R",
  trash: "D",
};

const WORKSPACE_LABEL: Record<WorkspaceType, string> = {
  none: "plain folder",
  git: "git",
  "multi-git": "multi-git",
  "google-repo": "google repo",
};

/** Session statuses that still own a running PTY (stop/restart are meaningful). */
const LIVE_SESSION_STATUSES = new Set<SessionStatus>([
  "starting",
  "running",
  "awaiting_review",
  "needs_attention",
]);

const PROJECT_STORAGE_KEY = "agentfabric.boardProjectId";
const TASK_DEFAULTS_PREFIX = "agentfabric.boardTaskDefaults.";
const DETAIL_SIDE_WIDTH_KEY = "agentfabric.boardDetailSideWidth";

function errText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** `/Users/you/x` → `~/x` for display; the absolute path is the fallback. */
function shortenHomePath(path: string, homePath: string | null): string {
  if (!homePath) return path;
  if (path === homePath) return "~";
  return path.startsWith(`${homePath}/`) ? `~${path.slice(homePath.length)}` : path;
}

function cardTitle(card: KanbanCard): string {
  const title = card.title?.trim();
  if (title) return title;
  // Display-only fallback: a card is always readable even before/without a
  // generated title. The stored record is never rewritten here.
  const line = card.prompt.split("\n").find((part) => part.trim().length > 0) ?? card.prompt;
  return line.length > 110 ? `${line.slice(0, 110)}…` : line;
}

/**
 * User drag whitelist (§六). Everything else is refused: notably
 * In Progress ↔ Review is driven by session state, never by the user.
 */
function allowedDrop(from: BoardColumnId, to: BoardColumnId): boolean {
  if (from === to) return false;
  if (to === "trash") return true;
  if (from === "backlog" && to === "in_progress") return true;
  if (from === "trash" && to === "review") return true;
  return false;
}

/** Null-safe localStorage read: bad JSON is treated as "no stored defaults". */
function readStoredJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function readTaskDefaults(project: KanbanProject | null): TaskFormDefaults {
  if (!project) return {};
  const stored = readStoredJson<TaskFormDefaults>(`${TASK_DEFAULTS_PREFIX}${project.id}`) ?? {};
  return {
    ...(stored.agentId ?? project.defaultAgentId
      ? { agentId: stored.agentId ?? project.defaultAgentId }
      : {}),
    ...(stored.model ? { model: stored.model } : {}),
    ...(stored.permissionModeId ? { permissionModeId: stored.permissionModeId } : {}),
    executionMode: stored.executionMode ?? project.defaultExecutionMode ?? "direct",
    ...(stored.baseRef ? { baseRef: stored.baseRef } : {}),
  };
}

/** Stored width of the task-details panel; clamped to a sane range on read. */
function readStoredSideWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(DETAIL_SIDE_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= 220 && stored <= 620) return stored;
  } catch {
    /* fall through to the default */
  }
  return 330;
}

function writeTaskDefaults(projectId: string, draft: TaskDraft): void {
  try {
    window.localStorage.setItem(
      `${TASK_DEFAULTS_PREFIX}${projectId}`,
      JSON.stringify({
        agentId: draft.agentId,
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.permissionModeId ? { permissionModeId: draft.permissionModeId } : {}),
        executionMode: draft.executionMode,
        ...(draft.baseRef ? { baseRef: draft.baseRef } : {}),
      } satisfies TaskFormDefaults)
    );
  } catch {
    /* Defaults are a convenience; a full quota must not block card creation. */
  }
}

export function BoardView() {
  const [projects, setProjects] = useState<KanbanProject[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(() =>
    window.localStorage.getItem(PROJECT_STORAGE_KEY)
  );
  const [agents, setAgents] = useState<KanbanAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [sessions, setSessions] = useState<Record<string, KanbanSession | null>>({});
  const [git, setGit] = useState<KanbanGitInfo | null>(null);
  const [sessionStatusError, setSessionStatusError] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [deletingProject, setDeletingProject] = useState<KanbanProject | null>(null);
  const [deletingProjectBusy, setDeletingProjectBusy] = useState(false);

  const [clearTrashOpen, setClearTrashOpen] = useState(false);
  const [clearTrashBusy, setClearTrashBusy] = useState(false);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskFormKey, setTaskFormKey] = useState(0);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [createMore, setCreateMore] = useState(false);

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [detailSession, setDetailSession] = useState<KanbanSession | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [drag, setDrag] = useState<{ cardId: string; from: BoardColumnId } | null>(null);
  const [dropTarget, setDropTarget] = useState<BoardColumnId | null>(null);
  const dragRef = useRef<{ cardId: string; from: BoardColumnId } | null>(null);
  dragRef.current = drag;

  const selectedProject = projects?.find((project) => project.id === projectId) ?? null;
  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? null;
  const taskDefaults = readTaskDefaults(selectedProject);

  // ---------- loading ----------

  const loadProjects = useCallback(async () => {
    try {
      const result = await get<{ projects: KanbanProject[] }>("/api/kanban/projects");
      setProjects(result.projects);
      setBoardError(null);
      setProjectId((current) => {
        const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY);
        const pick =
          result.projects.find((project) => project.id === current) ??
          result.projects.find((project) => project.id === stored) ??
          result.projects[0];
        return pick?.id ?? null;
      });
    } catch (error) {
      setBoardError(errText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (projectId) window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
    else window.localStorage.removeItem(PROJECT_STORAGE_KEY);
  }, [projectId]);

  // Home directory, used only to shorten a Done card's working-directory path
  // to `~/…` the way the fork shows it. Best effort: without it the absolute
  // path is shown instead.
  useEffect(() => {
    let alive = true;
    get<{ listing: { currentPath: string } }>("/api/kanban/fs")
      .then((response) => {
        if (alive) setHomePath(response.listing.currentPath);
      })
      .catch(() => {
        /* display-only */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    get<{ agents: KanbanAgent[] }>("/api/kanban/agents")
      .then((result) => {
        if (alive) {
          setAgents(result.agents);
          setAgentsError(null);
        }
      })
      .catch((error) => {
        if (alive) setAgentsError(`agent catalog unavailable: ${errText(error)}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Branch options for worktree cards; `null` for a non-repository folder. */
  const loadGit = useCallback(async (pid: string) => {
    try {
      const result = await get<{ git: KanbanGitInfo | null }>(
        `/api/kanban/projects/${encodeURIComponent(pid)}/git`
      );
      setGit(result.git);
    } catch {
      // Worktree options are optional; Direct mode still works without this.
      setGit(null);
    }
  }, []);

  useEffect(() => {
    setGit(null);
    if (!projectId) return;
    void loadGit(projectId);
  }, [projectId, loadGit]);

  /** Cards + per-card session status. The board API returns cards only, so
   *  session state is read one card at a time for cards that have a session. */
  const refreshCards = useCallback(async (pid: string) => {
    const result = await get<{ cards: KanbanCard[] }>(
      `/api/kanban/projects/${encodeURIComponent(pid)}/cards`
    );
    setCards(result.cards);
    const pending = result.cards.filter((card) => card.sessionId);
    if (pending.length === 0) {
      setSessions({});
      setSessionStatusError(null);
      return;
    }
    const failures: string[] = [];
    const results = await Promise.all(
      pending.map(async (card) => {
        try {
          const response = await get<{ session: KanbanSession | null }>(
            `/api/kanban/cards/${encodeURIComponent(card.id)}/session`
          );
          return [card.id, response.session] as const;
        } catch (error) {
          failures.push(errText(error));
          return null;
        }
      })
    );
    const next: Record<string, KanbanSession | null> = {};
    for (const result of results) if (result) next[result[0]] = result[1];
    setSessions(next);
    setSessionStatusError(
      failures.length > 0 ? `session status unavailable: ${failures[0]}` : null
    );
  }, []);

  const refreshNow = useCallback(async () => {
    if (!projectId) return;
    try {
      await refreshCards(projectId);
      // Card counts live on the project list, so an action that moves or
      // creates cards must refresh it too (the 2s poll only reloads cards).
      await loadProjects();
      setBoardError(null);
    } catch (error) {
      setBoardError(errText(error));
    }
  }, [projectId, refreshCards, loadProjects]);

  // Board poll: every 2s (§七). Cards are the expensive part; project metadata
  // is refreshed on explicit actions and initial load.
  const projectsLoaded = projects !== null;
  useEffect(() => {
    if (!projectId || !projectsLoaded) {
      setCards([]);
      setSessions({});
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refreshCards(projectId);
        if (!cancelled) setBoardError(null);
      } catch (error) {
        if (!cancelled) setBoardError(errText(error));
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, projectsLoaded, refreshCards]);

  // Project list poll (counts, projects added or removed elsewhere). Slower
  // than the card poll because it changes far less often, but it still means
  // the sidebar never waits for a manual refresh.
  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => {
      void loadProjects();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [projectId, loadProjects]);

  // Returning to the tab refreshes immediately: a background tab throttles
  // timers, so the first paint after focus must not show stale sessions.
  useEffect(() => {
    if (!projectId) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshNow();
      void loadGit(projectId);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [projectId, refreshNow, loadGit]);

  // Card detail session poll: every 1.5s while the overlay is open (§七).
  useEffect(() => {
    if (!selectedCardId) return;
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await get<{ session: KanbanSession | null }>(
          `/api/kanban/cards/${encodeURIComponent(selectedCardId)}/session`
        );
        if (!cancelled) {
          setDetailSession(response.session);
          setDetailError(null);
        }
      } catch (error) {
        if (!cancelled) setDetailError(errText(error));
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedCardId]);

  // ---------- actions ----------

  const selectProject = (id: string) => {
    if (id === projectId) return;
    setProjectId(id);
    setCards([]);
    setSessions({});
    setSelectedCardId(null);
    setActionError(null);
    setBoardError(null);
    setTaskDialogOpen(false);
  };

  const startCard = async (card: KanbanCard, restart = false): Promise<boolean> => {
    setActionError(null);
    try {
      const response = await post<{ session: KanbanSession }>(
        `/api/kanban/cards/${encodeURIComponent(card.id)}/start`,
        restart ? { restart: true } : {}
      );
      if (selectedCardId === card.id) setDetailSession(response.session);
      await refreshNow();
      return true;
    } catch (error) {
      setActionError(`${restart ? "Restart" : "Start"} failed: ${errText(error)}`);
      return false;
    }
  };

  const moveCard = async (card: KanbanCard, column: BoardColumnId): Promise<boolean> => {
    // Optimistic move; the server is authoritative and the poll corrects a
    // rejected move (the API error is surfaced below).
    setCards((current) =>
      current.map((entry) => (entry.id === card.id ? { ...entry, column } : entry))
    );
    try {
      await post(`/api/kanban/cards/${encodeURIComponent(card.id)}/move`, { column });
      await refreshNow();
      return true;
    } catch (error) {
      setActionError(`Move to ${COLUMN_LABEL[column]} failed: ${errText(error)}`);
      await refreshNow();
      return false;
    }
  };

  /** Any → Done: stop the session first when it is still live (§六). A stop
   *  failure is surfaced but does not block trashing — the user asked for the
   *  card to leave the board, and leaving it half-moved would be worse. */
  const trashCard = async (card: KanbanCard): Promise<boolean> => {
    setActionError(null);
    const known = sessions[card.id] ?? null;
    const needsStop = Boolean(card.sessionId) && (known ? LIVE_SESSION_STATUSES.has(known.status) : true);
    if (needsStop) {
      try {
        await post(`/api/kanban/cards/${encodeURIComponent(card.id)}/stop`, {});
      } catch (error) {
        setActionError(`Stop failed before moving to Done: ${errText(error)}`);
      }
    }
    return moveCard(card, "trash");
  };

  const deleteCard = async (card: KanbanCard): Promise<boolean> => {
    setActionError(null);
    try {
      await del(`/api/kanban/cards/${encodeURIComponent(card.id)}`);
      setSelectedCardId(null);
      await refreshNow();
      return true;
    } catch (error) {
      setActionError(`Delete failed: ${errText(error)}`);
      return false;
    }
  };

  const deleteProject = async () => {
    if (!deletingProject) return;
    setDeletingProjectBusy(true);
    setActionError(null);
    try {
      await del(`/api/kanban/projects/${encodeURIComponent(deletingProject.id)}`);
      setDeletingProject(null);
      if (deletingProject.id === projectId) {
        setProjectId(null);
        setSelectedCardId(null);
      }
      await loadProjects();
    } catch (error) {
      setActionError(`Delete project failed: ${errText(error)}`);
      setDeletingProject(null);
    } finally {
      setDeletingProjectBusy(false);
    }
  };

  /** Empties Done. Records only — the project folder and worktrees are kept. */
  const clearTrash = async () => {
    if (!projectId) return;
    setClearTrashBusy(true);
    setActionError(null);
    try {
      await post(`/api/kanban/projects/${encodeURIComponent(projectId)}/trash/clear`);
      setClearTrashOpen(false);
      await refreshNow();
    } catch (error) {
      setActionError(`Clear Done failed: ${errText(error)}`);
      setClearTrashOpen(false);
    } finally {
      setClearTrashBusy(false);
    }
  };

  /**
   * Creates the cards the form asked for, then optionally starts them.
   *
   * Multi-task creation is a client-side loop over the same endpoint: the
   * server's card is the unit, and a partial failure must leave the cards that
   * did get created visible rather than silently rolling them back.
   */
  const createTasks = async (draft: TaskDraft, options: TaskCreateSubmissionOptions) => {
    if (!projectId) return;
    setTaskBusy(true);
    setTaskError(null);
    const created: KanbanCard[] = [];
    try {
      for (const prompt of draft.prompts) {
        const response = await post<{ card: KanbanCard }>(
          `/api/kanban/projects/${encodeURIComponent(projectId)}/cards`,
          {
            prompt,
            ...(draft.prompts.length === 1 && draft.title ? { title: draft.title } : {}),
            agentId: draft.agentId,
            ...(draft.model ? { model: draft.model } : {}),
            ...(draft.permissionModeId ? { permissionModeId: draft.permissionModeId } : {}),
            executionMode: draft.executionMode,
            ...(draft.baseRef ? { baseRef: draft.baseRef } : {}),
          }
        );
        created.push(response.card);
      }
      writeTaskDefaults(projectId, draft);

      const startFailures: string[] = [];
      if (options.start) {
        for (const card of created) {
          try {
            await post(`/api/kanban/cards/${encodeURIComponent(card.id)}/start`, {});
          } catch (error) {
            startFailures.push(`${cardTitle(card)}: ${errText(error)}`);
          }
        }
      }
      await refreshNow();
      if (startFailures.length > 0) {
        setActionError(`Card created, but starting failed — ${startFailures[0]}`);
        setTaskDialogOpen(false);
        return;
      }
      if (options.keepOpen) {
        setTaskError(null);
        setTaskFormKey((key) => key + 1);
        return;
      }
      setTaskDialogOpen(false);
    } catch (error) {
      setTaskError(errText(error));
    } finally {
      setTaskBusy(false);
    }
  };

  const openTaskDialog = useCallback(() => {
    setTaskError(null);
    setCreateMore(false);
    setTaskFormKey((key) => key + 1);
    setTaskDialogOpen(true);
  }, []);

  const cancelTaskForm = () => {
    setTaskDialogOpen(false);
    setTaskError(null);
    setCreateMore(false);
  };

  // "c" opens the create-task dialog, the way the fork's board does. Ignored
  // while typing, with a modifier held, or when another surface is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "c" && event.key !== "C") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (taskDialogOpen || addProjectOpen || deletingProject || selectedCardId) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (!projectId) return;
      event.preventDefault();
      openTaskDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addProjectOpen, deletingProject, openTaskDialog, projectId, selectedCardId, taskDialogOpen]);

  // ---------- drag & drop ----------

  const beginDrag = (event: DragEvent<HTMLDivElement>, card: KanbanCard) => {
    event.dataTransfer.setData("text/plain", card.id);
    event.dataTransfer.effectAllowed = "move";
    // Mirror into the ref immediately: dragover/drop can fire before React
    // commits the state update for dragstart.
    dragRef.current = { cardId: card.id, from: card.column };
    setDrag({ cardId: card.id, from: card.column });
  };

  const endDrag = () => {
    dragRef.current = null;
    setDrag(null);
    setDropTarget(null);
  };

  const dropOn = (event: DragEvent<HTMLDivElement>, to: BoardColumnId) => {
    event.preventDefault();
    const dragged = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    setDropTarget(null);
    if (!dragged || !allowedDrop(dragged.from, to)) return;
    const card = cards.find((entry) => entry.id === dragged.cardId);
    if (!card) return;
    setActionError(null);
    void (async () => {
      if (dragged.from === "backlog" && to === "in_progress") {
        await startCard(card);
      } else if (to === "trash") {
        await trashCard(card);
      } else if (dragged.from === "trash" && to === "review") {
        await moveCard(card, "review");
      }
    })();
  };

  // ---------- new card ----------

  const openCard = (card: KanbanCard) => {
    setSelectedCardId(card.id);
    setDetailSession(card.sessionId ? (sessions[card.id] ?? null) : null);
    setDetailError(null);
    setActionError(null);
  };

  // A deleted card must not leave a dead overlay behind.
  useEffect(() => {
    if (selectedCardId && !selectedCard && cards.length > 0) setSelectedCardId(null);
  }, [cards, selectedCardId, selectedCard]);

  if (loading) {
    return (
      <div className="board">
        <div className="board-loading muted">Loading board…</div>
      </div>
    );
  }

  const detailSessionLive = detailSession ? LIVE_SESSION_STATUSES.has(detailSession.status) : false;
  const countsFor = (project: KanbanProject) => {
    if (project.id !== projectId) return project.cardCounts;
    const counts: Record<BoardColumnId, number> = { backlog: 0, in_progress: 0, review: 0, trash: 0 };
    for (const card of cards) counts[card.column] += 1;
    return counts;
  };

  return (
    <div className="board">
      <aside className="board-projects">
        <div className="board-projects-head">
          <span className="board-projects-title">Kanban projects</span>
          <button className="icon-btn" title="Add project" onClick={() => setAddProjectOpen(true)}>
            <Icon name="plus" />
          </button>
        </div>
        <div className="board-projects-list">
          {projects === null && <div className="muted board-projects-empty">Loading…</div>}
          {projects?.length === 0 && (
            <div className="muted board-projects-empty">
              No Kanban projects yet. A Kanban project is any local folder — Git is optional.
            </div>
          )}
          {(projects ?? []).map((project) => {
            const counts = countsFor(project);
            const total = counts
              ? counts.backlog + counts.in_progress + counts.review + counts.trash
              : 0;
            return (
              <div
                key={project.id}
                className={`board-project ${project.id === projectId ? "active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => selectProject(project.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectProject(project.id);
                  }
                }}
              >
                <span className="board-project-top">
                  {project.workspaceType === "git" && (
                    <span className="board-project-git" title="Git repository at the project root">
                      git
                    </span>
                  )}
                  <span className="board-project-name">{project.name}</span>
                </span>
                <span className="board-project-path mono" title={project.rootPath}>
                  {project.rootPath}
                </span>
                {total > 0 && counts && (
                  <span className="board-project-counts">
                    {COLUMNS.filter((column) => counts[column.id] > 0).map((column) => (
                      <span
                        key={column.id}
                        className={`board-count ${column.id}`}
                        title={`${COLUMN_LABEL[column.id]}: ${counts[column.id]}`}
                      >
                        <span className="board-count-key">{COUNT_KEY[column.id]}</span>
                        <span className="board-count-sep">|</span>
                        <span className="board-count-value">{counts[column.id]}</span>
                      </span>
                    ))}
                  </span>
                )}
                <button
                  className="board-project-del"
                  title="Delete Kanban project (the folder itself is not touched)"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeletingProject(project);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button className="board-add-project" onClick={() => setAddProjectOpen(true)}>
          <Icon name="plus" size={12} /> Add project
        </button>
      </aside>

      <section className="board-main">
        <header className="board-head">
          <div className="board-head-main">
            <div className="board-head-title">
              <h1>{selectedProject?.name ?? "Kanban"}</h1>
              {selectedProject && (
                <span className="board-workspace-chip">
                  {WORKSPACE_LABEL[selectedProject.workspaceType]}
                </span>
              )}
            </div>
            <div className="board-head-path mono">
              {selectedProject?.rootPath ?? "Select or create a Kanban project to load the board"}
            </div>
            {selectedProject?.discoveryWarning && (
              <div className="board-hint warn">{selectedProject.discoveryWarning}</div>
            )}
          </div>
          <div className="board-head-actions">
            {agentsError && <span className="board-hint warn">{agentsError}</span>}
            <button className="small primary" disabled={!selectedProject} onClick={openTaskDialog}>
              <Icon name="plus" size={12} /> New task
            </button>
          </div>
        </header>

        {(boardError || actionError || sessionStatusError) && (
          <div className="board-banners">
            <ErrorBox message={boardError} />
            <ErrorBox message={actionError} />
            {sessionStatusError && <div className="board-hint warn">{sessionStatusError}</div>}
          </div>
        )}

        {!selectedProject ? (
          <div className="board-empty muted">
            <p>No Kanban project selected.</p>
            <button className="small primary" onClick={() => setAddProjectOpen(true)}>
              <Icon name="plus" size={12} /> Add project
            </button>
          </div>
        ) : (
          <div className="board-columns">
            {COLUMNS.map((column) => {
              const columnCards = cards.filter((card) => card.column === column.id);
              const canCreateTask = column.id === "backlog" && projectId !== null;
              return (
                <div className="board-column" key={column.id}>
                  <div className="board-column-head">
                    <ColumnIndicator columnId={column.id} />
                    <span className="board-column-label">{column.label}</span>
                    <span className="board-column-count">{columnCards.length}</span>
                    {column.id === "trash" && (
                      <button
                        className="board-column-clear"
                        title={
                          columnCards.length > 0
                            ? "Clear Done permanently (records only)"
                            : "Done is empty"
                        }
                        aria-label="Clear Done"
                        disabled={columnCards.length === 0}
                        onClick={() => setClearTrashOpen(true)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                  <div
                    className={`board-column-body ${dropTarget === column.id ? "drop-ok" : ""} ${
                      drag && allowedDrop(drag.from, column.id) ? "drop-candidate" : ""
                    }`}
                    onDragOver={(event) => {
                      const dragged = dragRef.current;
                      if (!dragged || !allowedDrop(dragged.from, column.id)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      if (dropTarget !== column.id) setDropTarget(column.id);
                    }}
                    onDragLeave={(event) => {
                      if (
                        dropTarget === column.id &&
                        !event.currentTarget.contains(event.relatedTarget as Node | null)
                      ) {
                        setDropTarget(null);
                      }
                    }}
                    onDrop={(event) => dropOn(event, column.id)}
                  >
                    {canCreateTask && (
                      <button
                        className="board-create-task-btn"
                        onClick={openTaskDialog}
                        title="Create a task on this Kanban board"
                      >
                        <Icon name="plus" size={13} /> Create task
                        <span className="board-create-task-key">c</span>
                      </button>
                    )}
                    {columnCards.map((card) => (
                      <CardTile
                        key={card.id}
                        card={card}
                        agentLabel={
                          agents?.find((agent) => agent.id === card.agentId)?.label ?? card.agentId
                        }
                        session={sessions[card.id] ?? null}
                        dragging={drag?.cardId === card.id}
                        onOpen={() => openCard(card)}
                        onRestore={
                          card.column === "trash" ? () => void moveCard(card, "review") : undefined
                        }
                        homePath={homePath}
                        onDragStart={(event) => beginDrag(event, card)}
                        onDragEnd={endDrag}
                      />
                    ))}
                    {columnCards.length === 0 && !canCreateTask && (
                      <div className="board-column-empty muted">{column.hint}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {addProjectOpen && (
        <AddProjectDialog
          onClose={() => setAddProjectOpen(false)}
          onAdded={(project) => {
            setAddProjectOpen(false);
            setProjects((current) => [...(current ?? []), project]);
            selectProject(project.id);
          }}
        />
      )}

      {taskDialogOpen && selectedProject && (
        <TaskCreateDialog
          key={`dialog-${taskFormKey}`}
          workspaceType={selectedProject.workspaceType}
          agents={agents ?? []}
          git={git}
          defaults={taskDefaults}
          busy={taskBusy}
          error={taskError}
          createMore={createMore}
          onCreateMoreChange={setCreateMore}
          onSubmit={(draft, options) => void createTasks(draft, options)}
          onClose={cancelTaskForm}
        />
      )}

      {deletingProject && (
        <Modal title="Delete Kanban project" onClose={() => setDeletingProject(null)}>
          <p>
            Delete Kanban project <strong>{deletingProject.name}</strong>?
          </p>
          <p className="muted">
            Only the AgentFabric record is removed. The folder{" "}
            <span className="mono">{deletingProject.rootPath}</span> and your files stay untouched.
          </p>
          <div className="modal-actions">
            <button onClick={() => setDeletingProject(null)}>Cancel</button>
            <button className="danger" disabled={deletingProjectBusy} onClick={() => void deleteProject()}>
              {deletingProjectBusy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </Modal>
      )}

      {clearTrashOpen && (
        <Modal title="Clear Done" onClose={() => setClearTrashOpen(false)}>
          <p>
            Permanently delete{" "}
            <strong>
              {cards.filter((card) => card.column === "trash").length} Done card
              {cards.filter((card) => card.column === "trash").length === 1 ? "" : "s"}
            </strong>
            ?
          </p>
          <p className="muted">
            Only the AgentFabric records (cards and their sessions) are removed. The project folder,
            worktrees and your files stay untouched.
          </p>
          <div className="modal-actions">
            <button onClick={() => setClearTrashOpen(false)}>Cancel</button>
            <button className="danger" disabled={clearTrashBusy} onClick={() => void clearTrash()}>
              {clearTrashBusy ? "Clearing…" : "Clear Done"}
            </button>
          </div>
        </Modal>
      )}

      {selectedCard && (
        <CardDetail
          card={selectedCard}
          project={selectedProject}
          agents={agents ?? []}
          session={detailSession}
          sessionLive={detailSessionLive}
          sessionError={detailError}
          actionError={actionError}
          busy={detailBusy}
          onClose={() => setSelectedCardId(null)}
          onStart={() => {
            setDetailBusy(true);
            void startCard(selectedCard).finally(() => setDetailBusy(false));
          }}
          onRestart={() => {
            setDetailBusy(true);
            void startCard(selectedCard, true).finally(() => setDetailBusy(false));
          }}
          onMarkReview={() => {
            setDetailBusy(true);
            void moveCard(selectedCard, "review").finally(() => setDetailBusy(false));
          }}
          onTrash={() => {
            setDetailBusy(true);
            void trashCard(selectedCard).then((ok) => {
              setDetailBusy(false);
              if (ok) setSelectedCardId(null);
            });
          }}
          onRestore={() => {
            setDetailBusy(true);
            void moveCard(selectedCard, "review").finally(() => setDetailBusy(false));
          }}
          onDelete={() => {
            setDetailBusy(true);
            void deleteCard(selectedCard).finally(() => setDetailBusy(false));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Column progress glyph, matching the fork: an empty ring for Backlog, a
 * half-filled disc while a session runs, a three-quarter disc for Review, and a
 * solid dot for Done. Shape carries the state; color only reinforces it.
 */
function ColumnIndicator({ columnId, size = 14 }: { columnId: BoardColumnId; size?: number }) {
  const color =
    columnId === "backlog"
      ? "var(--dim)"
      : columnId === "in_progress"
        ? "var(--blue)"
        : columnId === "review"
          ? "var(--purple)"
          : "var(--red)";
  const r = size * 0.4;
  const cx = size / 2;
  const cy = size / 2;
  const strokeWidth = Math.max(1.5, size * 0.15);
  return (
    <svg
      className="board-column-indicator"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
    >
      {columnId === "trash" ? (
        <circle cx={cx} cy={cy} r={r + strokeWidth / 2} fill={color} />
      ) : (
        <>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={strokeWidth} />
          {columnId === "in_progress" && (
            // Left half filled: a session is running.
            <path d={`M${cx} ${cy - r} A${r} ${r} 0 0 0 ${cx} ${cy + r} Z`} fill={color} />
          )}
          {columnId === "review" && (
            // Three quarters filled: the agent finished a round, awaiting review.
            <path
              d={`M${cx} ${cy - r} A${r} ${r} 0 1 0 ${cx + r} ${cy} L${cx} ${cy} Z`}
              fill={color}
            />
          )}
        </>
      )}
    </svg>
  );
}

function CardTile({
  card,
  agentLabel,
  session,
  dragging,
  homePath,
  onOpen,
  onRestore,
  onDragStart,
  onDragEnd,
}: {
  card: KanbanCard;
  agentLabel: string;
  session: KanbanSession | null;
  dragging: boolean;
  homePath: string | null;
  onOpen: () => void;
  onRestore?: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const isTrash = card.column === "trash";
  return (
    <div
      className={`board-card ${dragging ? "dragging" : ""} ${card.column === "trash" ? "trashed" : ""}`}
      role="button"
      tabIndex={0}
      draggable
      title={card.prompt}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {isTrash && onRestore && (
        <button
          className="board-card-restore"
          title="Restore to Review"
          aria-label="Restore card to Review"
          onClick={(event) => {
            event.stopPropagation();
            onRestore();
          }}
        >
          <Icon name="restore" size={13} />
        </button>
      )}
      <div className="board-card-title">{cardTitle(card)}</div>
      <div className="board-card-meta">
        <span className="board-chip">{agentLabel}</span>
        <span className={`board-chip ${card.executionMode}`}>
          {card.executionMode === "direct" ? "Direct" : "Worktree"}
        </span>
        {card.executionMode === "worktree" && card.baseRef && (
          <span className="board-chip mono" title={`Worktree base ref: ${card.baseRef}`}>
            {card.baseRef}
          </span>
        )}
        {card.model && <span className="board-chip mono">{card.model}</span>}
      </div>
      {isTrash && session?.cwd && (
        <div className="board-card-workdir mono" title={session.cwd}>
          {shortenHomePath(session.cwd, homePath)}
        </div>
      )}
      {!isTrash && (session || card.sessionId) && (
        <div className="board-card-foot">
          {session ? (
            <StatusBadge status={session.status} />
          ) : (
            <span className="board-chip">session {card.sessionId ? shortId(card.sessionId) : "—"}</span>
          )}
        </div>
      )}
    </div>
  );
}

function CardDetail({
  card,
  project,
  agents,
  session,
  sessionLive,
  sessionError,
  actionError,
  busy,
  onClose,
  onStart,
  onRestart,
  onMarkReview,
  onTrash,
  onRestore,
  onDelete,
}: {
  card: KanbanCard;
  project: KanbanProject | null;
  agents: KanbanAgent[];
  session: KanbanSession | null;
  sessionLive: boolean;
  sessionError: string | null;
  actionError: string | null;
  busy: boolean;
  onClose: () => void;
  onStart: () => void;
  onRestart: () => void;
  onMarkReview: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Task details start collapsed: the terminal is the reason to open a card, and
  // the prompt/metadata are contextual. The rail is the affordance to expand.
  const [sideOpen, setSideOpen] = useState(false);
  const [sideWidth, setSideWidth] = useState(() => readStoredSideWidth());
  const bodyRef = useRef<HTMLDivElement>(null);
  const agentLabel = agents.find((agent) => agent.id === card.agentId)?.label ?? card.agentId;

  useEffect(() => {
    try {
      window.localStorage.setItem(DETAIL_SIDE_WIDTH_KEY, String(sideWidth));
    } catch {
      /* A width preference that cannot be stored must not break the overlay. */
    }
  }, [sideWidth]);

  /** Drag the divider to trade width between the details panel and the live
   *  terminal. Clamped so neither side can be squeezed out of existence. */
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const bounds = body.getBoundingClientRect();
    const max = Math.max(260, Math.min(620, bounds.width - 360));
    const move = (moveEvent: PointerEvent) => {
      setSideWidth(Math.max(220, Math.min(max, moveEvent.clientX - bounds.left)));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };
  const permissionLabel =
    agents
      .find((agent) => agent.id === card.agentId)
      ?.permissionModes.find((mode) => mode.id === card.permissionModeId)?.label ??
    card.permissionModeId ??
    "agent default";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="board-detail-overlay" role="dialog" aria-modal="true" aria-label={cardTitle(card)}>
      <div className="board-detail">
        <header className="board-detail-head">
          <button
            className="board-detail-back"
            title="Back to board"
            aria-label="Back to board"
            onClick={onClose}
          >
            <Icon name="arrowLeft" size={16} />
          </button>
          <div className="board-detail-head-main">
            <div className="board-detail-title">{cardTitle(card)}</div>
          </div>
          <div className="board-detail-actions">
            {card.column === "backlog" && (
              <button className="primary" disabled={busy} onClick={onStart}>
                Start
              </button>
            )}
            {card.column === "review" && !sessionLive && (
              <button className="primary" disabled={busy} onClick={onRestart}>
                Start new session
              </button>
            )}
            {card.column === "in_progress" && (
              <button disabled={busy} onClick={onMarkReview} title="Has the agent finished this round?">
                Mark for review
              </button>
            )}
            {card.column === "trash" ? (
              <>
                <button className="primary" disabled={busy} onClick={onRestore}>
                  Restore to Review
                </button>
                {confirmDelete ? (
                  <button className="danger-prominent" disabled={busy} onClick={onDelete}>
                    Confirm delete
                  </button>
                ) : (
                  <button className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                    Delete permanently
                  </button>
                )}
              </>
            ) : (
              <button className="danger" disabled={busy} onClick={onTrash}>
                Move to Done
              </button>
            )}
            <button className="board-close" title="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        {(actionError || sessionError) && (
          <div className="board-banners">
            <ErrorBox message={actionError} />
            {sessionError && <div className="board-hint warn">session status unavailable: {sessionError}</div>}
          </div>
        )}

        <div className="board-detail-body" ref={bodyRef}>
          {sideOpen ? (
            <>
              <aside className="board-detail-side" style={{ width: sideWidth }}>
                <div className="board-detail-side-head">
                  <span className="board-detail-side-title">Task details</span>
                  <button
                    className="board-detail-side-collapse"
                    title="Collapse task details"
                    aria-label="Collapse task details"
                    onClick={() => setSideOpen(false)}
                  >
                    <Icon name="chevron" size={14} />
                  </button>
                </div>
                <div className="board-field-label">Prompt</div>
              <pre className="board-prompt">{card.prompt}</pre>

              <dl className="board-meta">
                <div className="board-meta-row">
                  <dt>Column</dt>
                  <dd>{COLUMN_LABEL[card.column]}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>Agent</dt>
                  <dd>{agentLabel}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>Model</dt>
                  <dd className="mono">{card.model ?? "—"}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>Permission</dt>
                  <dd>{permissionLabel}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>Execution</dt>
                  <dd>{card.executionMode === "direct" ? "Direct" : "Worktree"}</dd>
                </div>
                {card.executionMode === "worktree" && (
                  <div className="board-meta-row">
                    <dt>Base ref</dt>
                    <dd className="mono">{card.baseRef ?? "HEAD"}</dd>
                  </div>
                )}
                <div className="board-meta-row">
                  <dt>Project</dt>
                  <dd className="mono" title={project?.rootPath}>
                    {project?.rootPath ?? "—"}
                  </dd>
                </div>
                <div className="board-meta-row">
                  <dt>Card</dt>
                  <dd className="mono">{card.id}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>Session</dt>
                  <dd className="mono">{session?.id ?? card.sessionId ?? "—"}</dd>
                </div>
                {session && (
                  <>
                    <div className="board-meta-row">
                      <dt>Status</dt>
                      <dd>{session.status}</dd>
                    </div>
                    <div className="board-meta-row">
                      <dt>Working dir</dt>
                      <dd className="mono">{session.cwd}</dd>
                    </div>
                    <div className="board-meta-row">
                      <dt>Started</dt>
                      <dd>{fmtTime(session.startedAt)}</dd>
                    </div>
                    {session.endedAt && (
                      <div className="board-meta-row">
                        <dt>Ended</dt>
                        <dd>{fmtTime(session.endedAt)}</dd>
                      </div>
                    )}
                    {session.exitCode != null && (
                      <div className="board-meta-row">
                        <dt>Exit code</dt>
                        <dd className="mono">{session.exitCode}</dd>
                      </div>
                    )}
                    {session.nativeSessionId && (
                      <div className="board-meta-row">
                        <dt>Native session</dt>
                        <dd className="mono">{session.nativeSessionId}</dd>
                      </div>
                    )}
                  </>
                )}
              </dl>

              {session?.error && <div className="board-session-error">Session error: {session.error}</div>}

              {card.column === "review" && (
                <div className="board-hint">
                  {sessionLive
                    ? "This card is in Review. Continue the agent in the terminal — a new turn moves it back to In Progress automatically."
                    : "This card is in Review. Start a new session to keep working on it; the card moves back to In Progress."}
                </div>
              )}
              </aside>
              <div
                className="board-detail-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize task details"
                onPointerDown={beginResize}
              />
            </>
          ) : (
            <aside className="board-detail-rail">
              <button
                className="board-detail-rail-btn"
                title="Show task details"
                aria-label="Show task details"
                onClick={() => setSideOpen(true)}
              >
                <Icon name="chevron" size={14} />
              </button>
              <span className="board-detail-rail-label">Details</span>
            </aside>
          )}

          <section className="board-detail-term">
            {session ? (
              <BoardTerminal
                key={session.id}
                sessionId={session.id}
                interactive={session.interactiveTui}
              />
            ) : (
              <div className="board-term-empty">
                <div className="board-term-empty-title">No session for this card yet.</div>
                {card.column === "backlog" ? (
                  <>
                    <p className="muted">
                      {card.executionMode === "direct"
                        ? `Starting spawns ${agentLabel} directly in the project folder with this prompt.`
                        : `Starting creates a detached git worktree from ${card.baseRef ?? "HEAD"} and spawns ${agentLabel} there.`}
                    </p>
                    <button className="primary" disabled={busy} onClick={onStart}>
                      Start session
                    </button>
                  </>
                ) : (
                  <p className="muted">
                    {card.column === "trash"
                      ? "Restore the card to Review before starting a new session."
                      : "This card has no replayable terminal. Move it to Done and restore it to Review to start a new session."}
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
