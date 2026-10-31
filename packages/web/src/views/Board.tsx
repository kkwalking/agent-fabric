import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ApiError, del, fmtTime, get, patch, post, put, shortId } from "../api";
import { notifyTasksChanged } from "../appEvents";
import { ErrorBox, Icon, Modal, AppLink } from "../components";
import { useT } from "../i18n-react";
import type { MessageKey } from "../i18n";
import { navigate } from "../router";
import { AcpChat } from "../components/AcpChat";
import { BoardTerminal } from "../components/BoardTerminal";
import { AddWorkspaceDialog } from "../components/board/AddWorkspaceDialog";
import { TaskCreateDialog, TaskEditDialog } from "../components/board/TaskCreateDialog";
import { initialFromDefaults, type TaskCreateSubmissionOptions } from "../components/board/TaskCreateForm";
import type {
  BoardColumnId,
  BoardWorkspace,
  ExecutionMode,
  KanbanAgent,
  KanbanCard,
  KanbanGitInfo,
  KanbanSession,
  ProjectBoardSettings,
  SessionStatus,
  TaskDraft,
  TaskFormDefaults,
  WorkspaceType,
} from "../components/board/types";

/**
 * Board (v13 §七): four fixed columns over one workspace's directory, with local
 * agent sessions and their live PTY terminals.
 *
 * A board workspace *is* a workspace: the board reads `/api/kanban/workspaces`
 * and each row is one directory on this machine plus the board-only settings
 * (folder shape, default agent and execution mode) in `workspace.board`. There
 * is no Project above it — the directory is the entity, so the same row is the
 * workspace the sidebar lists.
 *
 * Every started card produces a real Task (one Task per card, one Run per
 * start): the card detail has an "Open task" entry into the ordinary task
 * thread, and the Task lands under that workspace in the sidebar tree.
 *
 * Adding a workspace and creating tasks follow the Cline Kanban fork's flow:
 * - add a workspace by picking an absolute directory path (Git is optional —
 *   a plain folder boards exactly the same way);
 * - create a card from the Backlog column or the "New task" dialog, choosing
 *   agent, model, permission mode, workspace mode and worktree base ref.
 *
 * The server owns column transitions (§六); this view renders state and
 * performs the whitelisted user moves. Direct↔Review transitions are
 * programmatic only, so user drags there are refused here as well as server
 * side.
 */

/** Column ids are the server's values; only the labels are translated. */
const COLUMNS: { id: BoardColumnId; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { id: "backlog", labelKey: "board.column.backlog", hintKey: "board.column.backlog.hint" },
  {
    id: "in_progress",
    labelKey: "board.column.in_progress",
    hintKey: "board.column.in_progress.hint",
  },
  { id: "review", labelKey: "board.column.review", hintKey: "board.column.review.hint" },
  { id: "trash", labelKey: "board.column.trash", hintKey: "board.column.trash.hint" },
];

const COLUMN_LABEL_KEY: Record<BoardColumnId, MessageKey> = {
  backlog: "board.column.backlog",
  in_progress: "board.column.in_progress",
  review: "board.column.review",
  trash: "board.column.trash",
};

/** Session statuses as the badge shows them; the stored values are unchanged. */
const STATUS_LABEL_KEY: Record<string, MessageKey> = {
  starting: "board.status.starting",
  running: "board.status.running",
  awaiting_review: "board.status.awaiting_review",
  needs_attention: "board.status.needs_attention",
  failed: "board.status.failed",
  interrupted: "board.status.interrupted",
  stopped: "board.status.stopped",
  pending: "board.status.pending",
  completed: "board.status.completed",
  timeout: "board.status.timeout",
  cancelled: "board.status.cancelled",
};

/** The badge keeps the raw status as its class and only translates the text. */
function SessionStatusBadge({ status }: { status: string }) {
  const t = useT();
  const key = STATUS_LABEL_KEY[status];
  return <span className={`badge ${status}`}>{key ? t(key) : status}</span>;
}

/** Letters used by the workspace-list count badges (fork uses B / IP / R / D). */
const COUNT_KEY: Record<BoardColumnId, string> = {
  backlog: "B",
  in_progress: "IP",
  review: "R",
  trash: "D",
};

const WORKSPACE_LABEL_KEY: Record<WorkspaceType, MessageKey> = {
  none: "board.workspace.none",
  git: "board.workspace.git",
  "multi-git": "board.workspace.multiGit",
  "google-repo": "board.workspace.googleRepo",
};

/** What `<select>` offers for a workspace's board settings. */
const BOARD_WORKSPACE_TYPES: WorkspaceType[] = ["none", "git", "multi-git", "google-repo"];

/** Session statuses that still own a running PTY (stop/restart are meaningful). */
const LIVE_SESSION_STATUSES = new Set<SessionStatus>([
  "starting",
  "running",
  "awaiting_review",
  "needs_attention",
]);

const WORKSPACE_STORAGE_KEY = "agentfabric.boardWorkspaceId";
const TASK_DEFAULTS_PREFIX = "agentfabric.boardTaskDefaults.";
const DETAIL_SIDE_WIDTH_KEY = "agentfabric.boardDetailSideWidth";

function errText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The board settings of a workspace. A workspace that was not added from the
 * board has none (any directory is a valid board), so it boards as a plain
 * folder with no defaults — that default is computed here, never stored back.
 */
function boardSettingsOf(workspace: BoardWorkspace): ProjectBoardSettings {
  return workspace.board ?? { workspaceType: "none" };
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

function readTaskDefaults(workspace: BoardWorkspace | null): TaskFormDefaults {
  if (!workspace) return {};
  const board = boardSettingsOf(workspace);
  const stored = readStoredJson<TaskFormDefaults>(`${TASK_DEFAULTS_PREFIX}${workspace.id}`) ?? {};
  return {
    ...(stored.agentId ?? board.defaultAgentId
      ? { agentId: stored.agentId ?? board.defaultAgentId }
      : {}),
    ...(stored.model ? { model: stored.model } : {}),
    ...(stored.permissionModeId ? { permissionModeId: stored.permissionModeId } : {}),
    executionMode: stored.executionMode ?? board.defaultExecutionMode ?? "direct",
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

function writeTaskDefaults(workspaceId: string, draft: TaskDraft): void {
  try {
    window.localStorage.setItem(
      `${TASK_DEFAULTS_PREFIX}${workspaceId}`,
      JSON.stringify({
        agentId: draft.agentId,
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
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
  const t = useT();
  const [workspaces, setWorkspaces] = useState<BoardWorkspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(() =>
    window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
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

  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [deletingWorkspace, setDeletingWorkspace] = useState<BoardWorkspace | null>(null);
  const [deletingWorkspaceBusy, setDeletingWorkspaceBusy] = useState(false);
  /** The workspace whose board settings are being edited (agent/execution mode). */
  const [settingsWorkspace, setSettingsWorkspace] = useState<BoardWorkspace | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [clearTrashOpen, setClearTrashOpen] = useState(false);
  const [clearTrashBusy, setClearTrashBusy] = useState(false);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskFormKey, setTaskFormKey] = useState(0);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [createMore, setCreateMore] = useState(false);

  // Clicking a Backlog card opens it as a form (the fork's behaviour); every
  // other card opens its detail view. `editingCardId` is the card being edited.
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [detailSession, setDetailSession] = useState<KanbanSession | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [drag, setDrag] = useState<{ cardId: string; from: BoardColumnId } | null>(null);
  const [dropTarget, setDropTarget] = useState<BoardColumnId | null>(null);
  const dragRef = useRef<{ cardId: string; from: BoardColumnId } | null>(null);
  dragRef.current = drag;

  const selectedWorkspace = workspaces?.find((workspace) => workspace.id === workspaceId) ?? null;
  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? null;
  const editingCard = cards.find((card) => card.id === editingCardId) ?? null;
  const taskDefaults = readTaskDefaults(selectedWorkspace);

  // ---------- loading ----------

  /**
   * Loads the board's workspace list. A board workspace is an ordinary
   * workspace, so this is the board's only collection: the sidebar row, the
   * selected board and the directory in the header all come from here.
   */
  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await get<{ workspaces: BoardWorkspace[] }>("/api/kanban/workspaces");
      setWorkspaces(result.workspaces);
      setBoardError(null);
      setWorkspaceId((current) => {
        const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
        const pick =
          result.workspaces.find((workspace) => workspace.id === current) ??
          result.workspaces.find((workspace) => workspace.id === stored) ??
          result.workspaces[0];
        return pick?.id ?? null;
      });
    } catch (error) {
      setBoardError(errText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (workspaceId) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
    else window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }, [workspaceId]);

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
        if (alive) setAgentsError(t("board.agentCatalogUnavailable", { error: errText(error) }));
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Branch options for worktree cards; `null` for a non-repository folder. */
  const loadGit = useCallback(async (workspace: string) => {
    try {
      const result = await get<{ git: KanbanGitInfo | null }>(
        `/api/kanban/workspaces/${encodeURIComponent(workspace)}/git`
      );
      setGit(result.git);
    } catch {
      // Worktree options are optional; Direct mode still works without this.
      setGit(null);
    }
  }, []);

  useEffect(() => {
    setGit(null);
    if (!workspaceId) return;
    void loadGit(workspaceId);
  }, [workspaceId, loadGit]);

  /** Cards + per-card session status. The board API returns cards only, so
   *  session state is read one card at a time for cards that have been started
   *  (`taskId`; a Backlog card that never ran has none). */
  const refreshCards = useCallback(async (workspace: string) => {
    const result = await get<{ cards: KanbanCard[] }>(
      `/api/kanban/workspaces/${encodeURIComponent(workspace)}/cards`
    );
    setCards(result.cards);
    const pending = result.cards.filter((card) => card.taskId);
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
      failures.length > 0 ? t("board.sessionStatusUnavailable", { error: failures[0]! }) : null
    );
  }, [t]);

  const refreshNow = useCallback(async () => {
    if (!workspaceId) return;
    try {
      await refreshCards(workspaceId);
      // The row carries the server's card totals, so a refresh that may have
      // changed cards reloads the workspace list as well.
      await loadWorkspaces();
      setBoardError(null);
    } catch (error) {
      setBoardError(errText(error));
    }
  }, [workspaceId, refreshCards, loadWorkspaces]);

  // Board poll: every 2s (§七). Cards are the expensive part; workspace
  // metadata is refreshed on explicit actions and initial load.
  const workspacesLoaded = workspaces !== null;
  useEffect(() => {
    if (!workspaceId || !workspacesLoaded) {
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
        await refreshCards(workspaceId);
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
  }, [workspaceId, workspacesLoaded, refreshCards]);

  // Workspace list poll (workspaces added or removed elsewhere). Slower than
  // the card poll because it changes far less often, but the sidebar never
  // waits for a manual refresh.
  useEffect(() => {
    if (!workspaceId) return;
    const timer = window.setInterval(() => {
      void loadWorkspaces();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [workspaceId, loadWorkspaces]);

  // Returning to the tab refreshes immediately: a background tab throttles
  // timers, so the first paint after focus must not show stale sessions.
  useEffect(() => {
    if (!workspaceId) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshNow();
      void loadGit(workspaceId);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [workspaceId, refreshNow, loadGit]);

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

  const selectWorkspace = (id: string) => {
    if (id === workspaceId) return;
    setWorkspaceId(id);
    setCards([]);
    setSessions({});
    setSelectedCardId(null);
    setEditingCardId(null);
    setActionError(null);
    setBoardError(null);
    setTaskDialogOpen(false);
  };

  const startCard = async (
    card: KanbanCard,
    restart = false,
    options: { idleOk?: boolean } = {}
  ): Promise<boolean> => {
    setActionError(null);
    try {
      const response = await post<{ session: KanbanSession }>(
        `/api/kanban/cards/${encodeURIComponent(card.id)}/start`,
        restart ? { restart: true } : {}
      );
      if (selectedCardId === card.id) setDetailSession(response.session);
      await refreshNow();
      // Starting a card for the first time creates its Task; the rail must show
      // it now, not on the next navigation.
      notifyTasksChanged();
      return true;
    } catch (error) {
      // A restore that finds the session already live is a success, not a
      // failure: the card ended up where the user wanted it.
      if (options.idleOk && errText(error).includes("already has a running session")) {
        await refreshNow();
        notifyTasksChanged();
        return true;
      }
      setActionError(
        t(restart ? "board.action.restartFailed" : "board.action.startFailed", {
          error: errText(error),
        })
      );
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
      setActionError(
        t("board.action.moveFailed", { column: t(COLUMN_LABEL_KEY[column]), error: errText(error) })
      );
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
    const needsStop = Boolean(card.taskId) && (known ? LIVE_SESSION_STATUSES.has(known.status) : true);
    if (needsStop) {
      try {
        await post(`/api/kanban/cards/${encodeURIComponent(card.id)}/stop`, {});
      } catch (error) {
        setActionError(t("board.action.stopBeforeDone", { error: errText(error) }));
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
      // Deleting the card soft-deletes its Task; the rail must drop the row.
      notifyTasksChanged();
      return true;
    } catch (error) {
      setActionError(t("board.action.deleteCardFailed", { error: errText(error) }));
      return false;
    }
  };

  /**
   * Deletes the workspace itself (`DELETE /api/workspaces/:id`), not a
   * board-only copy: there is only one workspace record, so the sidebar loses
   * it too. The directory on disk, the worktrees and the Tasks that already ran
   * are kept.
   */
  const deleteWorkspace = async () => {
    if (!deletingWorkspace) return;
    setDeletingWorkspaceBusy(true);
    setActionError(null);
    try {
      await del(`/api/workspaces/${encodeURIComponent(deletingWorkspace.id)}`);
      setDeletingWorkspace(null);
      if (deletingWorkspace.id === workspaceId) {
        setWorkspaceId(null);
        setSelectedCardId(null);
      }
      await loadWorkspaces();
    } catch (error) {
      setActionError(t("board.action.deleteWorkspaceFailed", { error: errText(error) }));
      setDeletingWorkspace(null);
    } finally {
      setDeletingWorkspaceBusy(false);
    }
  };

  /**
   * Saves the board settings of a workspace (`PUT /api/workspaces/:id` with a
   * partial `board`). The workspace update merges the patch, so the fields this
   * dialog does not show are left as they are.
   */
  const saveBoardSettings = async (workspace: BoardWorkspace, next: ProjectBoardSettings) => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      await put<BoardWorkspace>(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
        board: next,
      });
      setSettingsWorkspace(null);
      await loadWorkspaces();
    } catch (error) {
      setSettingsError(t("board.action.saveFailed", { error: errText(error) }));
    } finally {
      setSettingsBusy(false);
    }
  };

  /** Empties Done. Records only — the workspace directory and worktrees are kept. */
  const clearTrash = async () => {
    if (!workspaceId) return;
    setClearTrashBusy(true);
    setActionError(null);
    try {
      await post(`/api/kanban/workspaces/${encodeURIComponent(workspaceId)}/trash/clear`);
      setClearTrashOpen(false);
      await refreshNow();
      notifyTasksChanged();
    } catch (error) {
      setActionError(t("board.action.clearDoneFailed", { error: errText(error) }));
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
    if (!workspaceId) return;
    setTaskBusy(true);
    setTaskError(null);
    const created: KanbanCard[] = [];
    try {
      for (const prompt of draft.prompts) {
        const response = await post<{ card: KanbanCard }>(
          `/api/kanban/workspaces/${encodeURIComponent(workspaceId)}/cards`,
          {
            prompt,
            ...(draft.prompts.length === 1 && draft.title ? { title: draft.title } : {}),
            agentId: draft.agentId,
            ...(draft.model ? { model: draft.model } : {}),
            ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
            ...(draft.permissionModeId ? { permissionModeId: draft.permissionModeId } : {}),
            executionMode: draft.executionMode,
            ...(draft.baseRef ? { baseRef: draft.baseRef } : {}),
          }
        );
        created.push(response.card);
      }
      writeTaskDefaults(workspaceId, draft);

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
      // Each card this form just started created its Task; the rail reads them
      // from `/api/tasks`, which no navigation has refreshed yet.
      if (options.start) notifyTasksChanged();
      if (startFailures.length > 0) {
        setActionError(t("board.action.startCardFailed", { error: startFailures[0]! }));
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

  /**
   * Saves the edit form back onto its Backlog card.
   *
   * The PATCH body is sent in full, including empty strings, so that clearing a
   * field in the form really clears it on the card (an absent key means "leave
   * alone", an empty one means "no longer set").
   */
  const saveCardEdit = async (card: KanbanCard, draft: TaskDraft) => {
    const prompt = draft.prompts[0]?.trim();
    if (!prompt) {
      setEditError(t("board.cardNeedsPrompt"));
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      await patch<{ card: KanbanCard }>(`/api/kanban/cards/${encodeURIComponent(card.id)}`, {
        prompt,
        title: draft.title?.trim() ?? "",
        agentId: draft.agentId,
        model: draft.model ?? "",
        reasoningEffort: draft.reasoningEffort ?? "",
        permissionModeId: draft.permissionModeId ?? "",
        executionMode: draft.executionMode,
        baseRef: draft.executionMode === "worktree" ? (draft.baseRef ?? "") : "",
      });
      setEditingCardId(null);
      await refreshNow();
    } catch (error) {
      setEditError(t("board.action.saveFailed", { error: errText(error) }));
    } finally {
      setEditBusy(false);
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
      if (taskDialogOpen || addWorkspaceOpen || deletingWorkspace || selectedCardId || editingCardId) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (!workspaceId) return;
      event.preventDefault();
      openTaskDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    addWorkspaceOpen,
    deletingWorkspace,
    editingCardId,
    openTaskDialog,
    selectedCardId,
    taskDialogOpen,
    workspaceId,
  ]);

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

  /**
   * A Backlog card is still being described, so clicking it edits it — the
   * form it was created with, seeded from the card. Every other column opens
   * the detail view (session, terminal/chat, metadata): once a session has
   * been started the prompt is what the agent ran on, and the board does not
   * rewrite that history.
   */
  const openCard = (card: KanbanCard) => {
    setActionError(null);
    if (card.column === "backlog") {
      setEditingCardId(card.id);
      setEditError(null);
      return;
    }
    setSelectedCardId(card.id);
    setDetailSession(card.taskId ? (sessions[card.id] ?? null) : null);
    setDetailError(null);
  };

  // A deleted card must not leave a dead overlay behind.
  useEffect(() => {
    if (selectedCardId && !selectedCard && cards.length > 0) setSelectedCardId(null);
  }, [cards, selectedCardId, selectedCard]);

  // Same for the editor: a card that left Backlog (started or dragged away) or
  // was deleted must close its form instead of writing to a stale record.
  useEffect(() => {
    if (editingCardId && cards.length > 0 && (!editingCard || editingCard.column !== "backlog")) {
      setEditingCardId(null);
    }
  }, [cards, editingCard, editingCardId]);

  if (loading) {
    return (
      <div className="board">
        <div className="board-loading muted">{t("board.loading")}</div>
      </div>
    );
  }

  const detailSessionLive = detailSession ? LIVE_SESSION_STATUSES.has(detailSession.status) : false;
  /**
   * Card totals per column. The selected workspace's totals are counted from
   * the cards on screen (they are already loaded and are what the columns
   * show); every other row uses the totals the server computes for the list.
   */
  const countsFor = (workspace: BoardWorkspace): Record<BoardColumnId, number> | null => {
    if (workspace.id !== workspaceId) return workspace.cardCounts ?? null;
    const counts: Record<BoardColumnId, number> = { backlog: 0, in_progress: 0, review: 0, trash: 0 };
    for (const card of cards) counts[card.column] += 1;
    return counts;
  };
  const selectedRoot = selectedWorkspace?.path ?? null;
  const selectedBoard: ProjectBoardSettings | null = selectedWorkspace
    ? boardSettingsOf(selectedWorkspace)
    : null;

  return (
    <div className="board">
      <aside className="board-projects">
        <div className="board-projects-head">
          <span className="board-projects-title">{t("board.workspaces")}</span>
          <button
            className="icon-btn"
            title={t("board.addWorkspace")}
            onClick={() => setAddWorkspaceOpen(true)}
          >
            <Icon name="plus" />
          </button>
        </div>
        <div className="board-projects-list">
          {workspaces === null && (
            <div className="muted board-projects-empty">{t("board.loadingShort")}</div>
          )}
          {workspaces?.length === 0 && (
            <div className="muted board-projects-empty">{t("board.noWorkspaces")}</div>
          )}
          {(workspaces ?? []).map((workspace) => {
            const counts = countsFor(workspace);
            const total = counts
              ? counts.backlog + counts.in_progress + counts.review + counts.trash
              : 0;
            const board = boardSettingsOf(workspace);
            return (
              <div
                key={workspace.id}
                className={`board-project ${workspace.id === workspaceId ? "active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => selectWorkspace(workspace.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectWorkspace(workspace.id);
                  }
                }}
              >
                <span className="board-project-top">
                  {board.workspaceType === "git" && (
                    <span className="board-project-git" title={t("board.gitRepoTitle")}>
                      git
                    </span>
                  )}
                  <span className="board-project-name">{workspace.name}</span>
                </span>
                <span className="board-project-path mono" title={workspace.path}>
                  {workspace.path}
                </span>
                {total > 0 && counts && (
                  <span className="board-project-counts">
                    {COLUMNS.filter((column) => counts[column.id] > 0).map((column) => (
                      <span
                        key={column.id}
                        className={`board-count ${column.id}`}
                        title={t("board.columnCount", {
                          column: t(column.labelKey),
                          n: counts[column.id]!,
                        })}
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
                  title={t("board.deleteWorkspaceTooltip")}
                  aria-label={t("board.deleteWorkspaceAria", { name: workspace.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeletingWorkspace(workspace);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button className="board-add-project" onClick={() => setAddWorkspaceOpen(true)}>
          <Icon name="plus" size={12} /> {t("board.addWorkspace")}
        </button>
      </aside>

      <section className="board-main">
        <header className="board-head">
          <div className="board-head-main">
            <div className="board-head-title">
              <h1>{selectedWorkspace?.name ?? t("board.title")}</h1>
              {selectedBoard && (
                <span className="board-workspace-chip">
                  {t(WORKSPACE_LABEL_KEY[selectedBoard.workspaceType])}
                </span>
              )}
            </div>
            <div className="board-head-path mono">
              {selectedRoot ?? t("board.selectWorkspaceHint")}
            </div>
            {selectedBoard?.discoveryWarning && (
              <div className="board-hint warn">{selectedBoard.discoveryWarning}</div>
            )}
          </div>
          <div className="board-head-actions">
            {agentsError && <span className="board-hint warn">{agentsError}</span>}
            <button
              className="small"
              disabled={!selectedWorkspace}
              title={t("board.boardSettingsTooltip")}
              onClick={() => {
                setSettingsError(null);
                setSettingsWorkspace(selectedWorkspace);
              }}
            >
              {t("board.boardSettings")}
            </button>
            <button className="small primary" disabled={!selectedWorkspace} onClick={openTaskDialog}>
              <Icon name="plus" size={12} /> {t("board.newTask")}
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

        {!selectedWorkspace ? (
          <div className="board-empty muted">
            <p>{t("board.noWorkspaceSelected")}</p>
            <button className="small primary" onClick={() => setAddWorkspaceOpen(true)}>
              <Icon name="plus" size={12} /> {t("board.addWorkspace")}
            </button>
          </div>
        ) : (
          <div className="board-columns">
            {COLUMNS.map((column) => {
              const columnCards = cards.filter((card) => card.column === column.id);
              const canCreateTask = column.id === "backlog" && workspaceId !== null;
              return (
                <div className="board-column" key={column.id}>
                  <div className="board-column-head">
                    <ColumnIndicator columnId={column.id} />
                    <span className="board-column-label">{t(column.labelKey)}</span>
                    <span className="board-column-count">{columnCards.length}</span>
                    {column.id === "trash" && (
                      <button
                        className="board-column-clear"
                        title={t(columnCards.length > 0 ? "board.done.clearTooltip" : "board.done.empty")}
                        aria-label={t("board.done.clearAria")}
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
                        title={t("board.createTaskTooltip")}
                      >
                        <Icon name="plus" size={13} /> {t("board.createTask")}
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
                      <div className="board-column-empty muted">{t(column.hintKey)}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {addWorkspaceOpen && (
        <AddWorkspaceDialog
          onClose={() => setAddWorkspaceOpen(false)}
          onAdded={(workspace) => {
            // The dialog returns the workspace the server created; the list is
            // re-read so the row is exactly what `/api/kanban/workspaces` reports.
            setAddWorkspaceOpen(false);
            selectWorkspace(workspace.id);
            void loadWorkspaces();
          }}
        />
      )}

      {taskDialogOpen && selectedWorkspace && selectedBoard && (
        <TaskCreateDialog
          key={`dialog-${taskFormKey}`}
          workspaceType={selectedBoard.workspaceType}
          agents={agents ?? []}
          git={git}
          initial={initialFromDefaults(taskDefaults, selectedBoard.defaultExecutionMode ?? "direct")}
          busy={taskBusy}
          error={taskError}
          createMore={createMore}
          onCreateMoreChange={setCreateMore}
          onSubmit={(draft, options) => void createTasks(draft, options)}
          onClose={cancelTaskForm}
        />
      )}

      {editingCard && selectedWorkspace && selectedBoard && (
        <TaskEditDialog
          key={editingCard.id}
          card={editingCard}
          workspaceType={selectedBoard.workspaceType}
          agents={agents ?? []}
          git={git}
          busy={editBusy}
          error={editError}
          onSubmit={(draft) => void saveCardEdit(editingCard, draft)}
          onClose={() => {
            setEditingCardId(null);
            setEditError(null);
          }}
        />
      )}

      {settingsWorkspace && (
        <BoardSettingsDialog
          workspace={settingsWorkspace}
          root={settingsWorkspace.path}
          agents={agents ?? []}
          busy={settingsBusy}
          error={settingsError}
          onSubmit={(next) => void saveBoardSettings(settingsWorkspace, next)}
          onClose={() => setSettingsWorkspace(null)}
        />
      )}

      {deletingWorkspace && (
        <Modal title={t("board.deleteWorkspaceTitle")} onClose={() => setDeletingWorkspace(null)}>
          <p>
            {t("board.deleteWorkspaceBody1")} <strong>{deletingWorkspace.name}</strong>
            {t("board.deleteWorkspaceBody2")}
          </p>
          <p className="muted">
            {t("board.deleteWorkspaceNote")}{" "}
            <span className="mono">{deletingWorkspace.path}</span>{" "}
            {t("board.deleteWorkspaceNote2")}
          </p>
          <div className="modal-actions">
            <button onClick={() => setDeletingWorkspace(null)}>{t("board.form.cancel")}</button>
            <button
              className="danger"
              disabled={deletingWorkspaceBusy}
              onClick={() => void deleteWorkspace()}
            >
              {t("board.deleteWorkspace")}
            </button>
          </div>
        </Modal>
      )}

      {clearTrashOpen && (
        <Modal title={t("board.done.clearTitle")} onClose={() => setClearTrashOpen(false)}>
          <p>
            {t("board.done.clearConfirm", {
              n: cards.filter((card) => card.column === "trash").length,
            })}
          </p>
          <p className="muted">{t("board.done.clearNote")}</p>
          <div className="modal-actions">
            <button onClick={() => setClearTrashOpen(false)}>{t("board.form.cancel")}</button>
            <button className="danger" disabled={clearTrashBusy} onClick={() => void clearTrash()}>
              {clearTrashBusy ? t("board.done.clearing") : t("board.done.clear")}
            </button>
          </div>
        </Modal>
      )}

      {selectedCard && (
        <CardDetail
          card={selectedCard}
          workspaceRootPath={selectedRoot}
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
            // Restoring a Done card brings its session back with it: it was
            // released when archived (Done frees the process), so leaving the
            // user to press Start afterwards would be a second, redundant step.
            // A session that is somehow still live makes the start a no-op
            // rather than an error — the card is already in the state the user
            // asked for.
            setDetailBusy(true);
            void moveCard(selectedCard, "review")
              .then((ok) => (ok ? startCard(selectedCard, false, { idleOk: true }) : false))
              .finally(() => setDetailBusy(false));
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
      ? "var(--ink-dim)"
      : columnId === "in_progress"
        ? "var(--signal-blue)"
        : columnId === "review"
          ? "var(--signal-purple)"
          : "var(--signal-red)";
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
  const t = useT();
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
          title={t("board.card.restore")}
          aria-label={t("board.card.restoreAria")}
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
          {t(card.executionMode === "direct" ? "board.execution.direct" : "board.execution.worktree")}
        </span>
        {card.executionMode === "worktree" && card.baseRef && (
          <span className="board-chip mono" title={t("board.card.baseRef", { ref: card.baseRef })}>
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
      {!isTrash && card.taskId && (
        <div className="board-card-foot">
          {session ? (
            <SessionStatusBadge status={session.status} />
          ) : (
            <span className="board-chip">{t("board.card.task", { id: shortId(card.taskId) })}</span>
          )}
        </div>
      )}
    </div>
  );
}

function CardDetail({
  card,
  workspaceRootPath,
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
  /** The workspace directory on disk; the card's session runs inside it. */
  workspaceRootPath: string | null;
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
  const t = useT();
  // A recorded harness session id means "start" continues that conversation
  // instead of opening a blank one; the button says so.
  const canResume = Boolean(session?.nativeSessionId) && !sessionLive;
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The panel is reused when the user switches cards, and "arm the delete" must
  // not survive that switch: otherwise a card opened later shows "Confirm
  // delete" already armed, and one click destroys it.
  useEffect(() => {
    setConfirmDelete(false);
  }, [card.id]);
  // Task details start collapsed: the terminal is the reason to open a card, and
  // the prompt/metadata are contextual. The rail is the affordance to expand.
  const [sideOpen, setSideOpen] = useState(false);
  const [sideWidth, setSideWidth] = useState(() => readStoredSideWidth());
  const bodyRef = useRef<HTMLDivElement>(null);
  const agentLabel = agents.find((agent) => agent.id === card.agentId)?.label ?? card.agentId;
  // DSH sessions speak the structured ACP chat; every other agent keeps xterm.
  const acpSession = session?.transport === "acp";
  // What the session is actually running on, mirrored from ACP's model option.
  const sessionModelLabel = session?.modelRoute?.label ?? session?.modelRoute?.model;
  /** The Task this card drives; absent until the card has been started once. */
  const taskId = card.taskId;

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
  // A card that names no mode runs the agent's default: `"default"` is the
  // no-op choice the "agent default" label already means, any other id is a
  // real catalog row (DSH pins one of its sandbox presets).
  const cardAgent = agents.find((agent) => agent.id === card.agentId);
  const cardPermissionId =
    card.permissionModeId ??
    (cardAgent?.defaultPermissionModeId && cardAgent.defaultPermissionModeId !== "default"
      ? cardAgent.defaultPermissionModeId
      : "");
  const permissionLabel =
    cardAgent?.permissionModes.find((mode) => mode.id === cardPermissionId)?.label ??
    card.permissionModeId ??
    t("board.detail.agentDefault");

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
            title={t("board.detail.back")}
            aria-label={t("board.detail.back")}
            onClick={onClose}
          >
            <Icon name="arrowLeft" size={16} />
          </button>
          <div className="board-detail-head-main">
            <div className="board-detail-title">{cardTitle(card)}</div>
          </div>
          <div className="board-detail-actions">
            {/* The started card *is* a Task. Once it has one, the ordinary task
                thread (Runs, lifecycle, handoff) is the fuller view of the same
                work, so it is one click away; a card that never ran has no
                taskId and therefore no entry. */}
            {taskId && (
              <button
                className="small"
                disabled={busy}
                title={t("board.detail.openTaskTitle", { id: taskId })}
                onClick={() => navigate(`/tasks/${encodeURIComponent(taskId)}`)}
              >
                <Icon name="compose" size={12} /> {t("board.detail.openTask")}
              </button>
            )}
            {card.column === "backlog" && (
              <button className="primary" disabled={busy} onClick={onStart}>
                {t("board.detail.start")}
              </button>
            )}
            {(card.column === "review" || card.column === "in_progress") && !sessionLive && (
              <button className="primary" disabled={busy} onClick={onRestart}>
                {t(canResume ? "board.detail.resumeSession" : "board.detail.startNew")}
              </button>
            )}
            {card.column === "in_progress" && (
              <button
                disabled={busy}
                onClick={onMarkReview}
                title={t("board.detail.markReviewHint")}
              >
                {t("board.detail.markReview")}
              </button>
            )}
            {card.column === "trash" ? (
              <>
                <button className="primary" disabled={busy} onClick={onRestore}>
                  {t("board.detail.restoreToReview")}
                </button>
                {confirmDelete ? (
                  <button className="danger-prominent" disabled={busy} onClick={onDelete}>
                    {t("board.detail.confirmDelete")}
                  </button>
                ) : (
                  <button className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                    {t("board.detail.deletePermanently")}
                  </button>
                )}
              </>
            ) : (
              <button className="danger" disabled={busy} onClick={onTrash}>
                {t("board.detail.moveToDone")}
              </button>
            )}
            <button className="board-close" title={t("board.detail.close")} onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        {(actionError || sessionError) && (
          <div className="board-banners">
            <ErrorBox message={actionError} />
            {sessionError && (
              <div className="board-hint warn">
                {t("board.sessionStatusUnavailable", { error: sessionError })}
              </div>
            )}
          </div>
        )}

        <div className="board-detail-body" ref={bodyRef}>
          {sideOpen ? (
            <>
              <aside className="board-detail-side" style={{ width: sideWidth }}>
                <div className="board-detail-side-head">
                  <span className="board-detail-side-title">{t("board.detail.taskDetails")}</span>
                  <button
                    className="board-detail-side-collapse"
                    title={t("board.detail.collapse")}
                    aria-label={t("board.detail.collapse")}
                    onClick={() => setSideOpen(false)}
                  >
                    <Icon name="chevron" size={14} />
                  </button>
                </div>
                <div className="board-field-label">{t("board.detail.field.prompt")}</div>
              <pre className="board-prompt">{card.prompt}</pre>

              <dl className="board-meta">
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.column")}</dt>
                  <dd>{t(COLUMN_LABEL_KEY[card.column])}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.agent")}</dt>
                  <dd>{agentLabel}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.model")}</dt>
                  <dd className="mono">{sessionModelLabel ?? card.model ?? t("board.detail.agentDefault")}</dd>
                </div>
                {session?.reasoningEffort && (
                  <div className="board-meta-row">
                    <dt>{t("board.detail.field.reasoning")}</dt>
                    <dd className="mono">{session.reasoningEffort}</dd>
                  </div>
                )}
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.permission")}</dt>
                  <dd>{permissionLabel}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.execution")}</dt>
                  <dd>
                    {t(
                      card.executionMode === "direct"
                        ? "board.execution.direct"
                        : "board.execution.worktree"
                    )}
                  </dd>
                </div>
                {card.executionMode === "worktree" && (
                  <div className="board-meta-row">
                    <dt>{t("board.detail.field.baseRef")}</dt>
                    <dd className="mono">{card.baseRef ?? "HEAD"}</dd>
                  </div>
                )}
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.workspace")}</dt>
                  <dd className="mono" title={workspaceRootPath ?? undefined}>
                    {workspaceRootPath ?? "—"}
                  </dd>
                </div>
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.card")}</dt>
                  <dd className="mono">{card.id}</dd>
                </div>
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.task")}</dt>
                  <dd className="mono">
                    {taskId ? (
                      <AppLink href={`/tasks/${encodeURIComponent(taskId)}`}>
                        {taskId}
                      </AppLink>
                    ) : (
                      t("board.detail.notStarted")
                    )}
                  </dd>
                </div>
                <div className="board-meta-row">
                  <dt>{t("board.detail.field.run")}</dt>
                  <dd className="mono">{session?.runId ?? card.runId ?? "—"}</dd>
                </div>
                {session && (
                  <>
                    <div className="board-meta-row">
                      <dt>{t("board.detail.field.status")}</dt>
                      <dd>
                        <SessionStatusBadge status={session.status} />
                      </dd>
                    </div>
                    <div className="board-meta-row">
                      <dt>{t("board.detail.field.cwd")}</dt>
                      <dd className="mono">{session.cwd}</dd>
                    </div>
                    <div className="board-meta-row">
                      <dt>{t("board.detail.field.started")}</dt>
                      <dd>{fmtTime(session.startedAt)}</dd>
                    </div>
                    {session.endedAt && (
                      <div className="board-meta-row">
                        <dt>{t("board.detail.field.ended")}</dt>
                        <dd>{fmtTime(session.endedAt)}</dd>
                      </div>
                    )}
                    {session.exitCode != null && (
                      <div className="board-meta-row">
                        <dt>{t("board.detail.field.exitCode")}</dt>
                        <dd className="mono">{session.exitCode}</dd>
                      </div>
                    )}
                    {session.nativeSessionId && (
                      <div className="board-meta-row">
                        <dt>{t("board.detail.field.nativeSession")}</dt>
                        <dd className="mono">{session.nativeSessionId}</dd>
                      </div>
                    )}
                  </>
                )}
              </dl>

              {session?.error && (
                <div className="board-session-error">
                  {t("board.detail.sessionError", { error: session.error })}
                </div>
              )}

              {card.column === "review" && (
                <div className="board-hint">
                  {sessionLive
                    ? t(acpSession ? "board.review.liveChat" : "board.review.liveTerm")
                    : t(acpSession ? "board.review.chat" : "board.review.term")}
                </div>
              )}
              </aside>
              <div
                className="board-detail-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("board.detail.resize")}
                onPointerDown={beginResize}
              />
            </>
          ) : (
            <aside className="board-detail-rail">
              <button
                className="board-detail-rail-btn"
                title={t("board.detail.show")}
                aria-label={t("board.detail.show")}
                onClick={() => setSideOpen(true)}
              >
                <Icon name="chevron" size={14} />
              </button>
              <span className="board-detail-rail-label">{t("board.detail.details")}</span>
            </aside>
          )}

          <section className="board-detail-term">
            {card.column === "trash" && (
              // Done frees the process. Say what happened and what Restore does,
              // so a stopped terminal does not read as "this card is broken".
              <div className="board-detail-notice">
                {t("board.detail.doneNotice")}{" "}
                {t(canResume ? "board.detail.doneResumable" : "board.detail.doneFresh")}
              </div>
            )}
            {session ? (
              acpSession ? (
                <AcpChat key={session.id} sessionId={session.id} />
              ) : (
                <BoardTerminal
                  key={session.id}
                  sessionId={session.id}
                  interactive={session.interactiveTui}
                />
              )
            ) : (
              <div className="board-term-empty">
                <div className="board-term-empty-title">{t("board.detail.noSession")}</div>
                {card.column === "backlog" ? (
                  <>
                    <p className="muted">
                      {card.executionMode === "direct"
                        ? t("board.detail.startDirect", { agent: agentLabel })
                        : t("board.detail.startWorktree", {
                            ref: card.baseRef ?? "HEAD",
                            agent: agentLabel,
                          })}
                    </p>
                    <button className="primary" disabled={busy} onClick={onStart}>
                      {t("board.detail.startSession")}
                    </button>
                  </>
                ) : (
                  <p className="muted">
                    {card.column === "trash"
                      ? t("board.detail.trashNeedsRestore")
                      : t("board.detail.noTerminal")}
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

/**
 * Board settings of a workspace (`workspace.board`).
 *
 * These are the only board-specific fields left on a workspace: the folder
 * shape discovery reported, the agent and execution mode a new card starts
 * with, and a discovery warning when that probe failed. The directory itself is
 * not here — it is the workspace's own `path`, which is why it is shown
 * read-only.
 *
 * Saving sends a partial `board`; the workspace update merges it, so a field
 * this dialog does not show keeps its stored value.
 */
function BoardSettingsDialog({
  workspace,
  root,
  agents,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  workspace: BoardWorkspace;
  root: string | null;
  agents: KanbanAgent[];
  busy: boolean;
  error: string | null;
  onSubmit: (next: ProjectBoardSettings) => void;
  onClose: () => void;
}) {
  const t = useT();
  const current = boardSettingsOf(workspace);
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>(current.workspaceType);
  const [agentId, setAgentId] = useState(current.defaultAgentId ?? "");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(
    current.defaultExecutionMode ?? "direct"
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const available = agents.filter((agent) => agent.available);

  return (
    <Modal title={t("board.settings.title")} onClose={onClose}>
      <p className="muted">
        <strong>{workspace.name}</strong> · <span className="mono">{root ?? "—"}</span>
      </p>
      <div className="form-grid-2">
        <label className="board-dialog-field">
          <span className="board-dialog-label">{t("board.settings.folderShape")}</span>
          <select
            value={workspaceType}
            disabled={busy}
            onChange={(event) => setWorkspaceType(event.target.value as WorkspaceType)}
          >
            {BOARD_WORKSPACE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(WORKSPACE_LABEL_KEY[type])}
              </option>
            ))}
          </select>
        </label>
        <label className="board-dialog-field">
          <span className="board-dialog-label">{t("board.settings.defaultAgent")}</span>
          <select
            value={agentId}
            disabled={busy}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">{t("board.settings.firstAvailable")}</option>
            {available.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        <label className="board-dialog-field">
          <span className="board-dialog-label">{t("board.settings.defaultExecution")}</span>
          <select
            value={executionMode}
            disabled={busy}
            onChange={(event) => setExecutionMode(event.target.value as ExecutionMode)}
          >
            <option value="direct">{t("board.execution.directOption")}</option>
            <option value="worktree">{t("board.execution.worktreeOption")}</option>
          </select>
        </label>
      </div>
      <p className="board-hint">{t("board.settings.hint")}</p>
      {error && <div className="board-hint warn board-dialog-error">{error}</div>}
      <div className="modal-actions">
        <button onClick={onClose} disabled={busy}>
          {t("board.form.cancel")}
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            onSubmit({
              workspaceType,
              ...(agentId ? { defaultAgentId: agentId } : {}),
              defaultExecutionMode: executionMode,
              // The warning describes the folder as it was probed; nothing here
              // re-probes it, so it is carried over as recorded.
              ...(current.discoveryWarning ? { discoveryWarning: current.discoveryWarning } : {}),
            })
          }
        >
          {busy ? t("board.settings.saving") : t("board.settings.save")}
        </button>
      </div>
    </Modal>
  );
}
