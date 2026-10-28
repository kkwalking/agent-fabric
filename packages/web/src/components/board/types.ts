/**
 * Board view model (v13 §七), shared by the board view and its dialogs.
 *
 * These mirror the server's JSON exactly; the web package does not import core
 * types so the browser bundle stays free of Node code.
 */

export type BoardColumnId = "backlog" | "in_progress" | "review" | "trash";
export type ExecutionMode = "direct" | "worktree";
/** Repository shape discovered for a board workspace. Discovery never blocks. */
export type WorkspaceType = "none" | "git" | "multi-git" | "google-repo";
export type SessionStatus =
  | "starting"
  | "running"
  | "awaiting_review"
  | "needs_attention"
  | "failed"
  | "interrupted"
  | "stopped";

/**
 * One ACP configuration option as the agent advertises it (model, reasoning
 * effort, …). `value` is opaque — it goes back verbatim in `set_config`.
 */
export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOptionGroup {
  group: string;
  name?: string;
  options: AcpConfigOptionValue[];
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options?: Array<AcpConfigOptionValue | AcpConfigOptionGroup>;
}

/** The model route a session is on, as the server mirrors it from ACP. */
export interface KanbanSessionModelRoute {
  value: string;
  provider?: string;
  model?: string;
  label?: string;
}

export interface KanbanAgentPermissionMode {
  id: string;
  label: string;
  risky?: boolean;
}

export interface KanbanAgent {
  id: string;
  label: string;
  available: boolean;
  installHint: string;
  interactiveTui: boolean;
  /** `pty` = raw terminal (Claude/Pi/OpenCode); `acp` = structured chat (DSH). */
  transport: "pty" | "acp";
  permissionModes: KanbanAgentPermissionMode[];
  modelFlag: string | null;
  /** Absolute path detection found the CLI at; absent when it is not installed. */
  cliPath?: string;
  /** Installed in a folder the terminal's PATH lacks — a terminal's `which` misses it. */
  cliOffPath?: boolean;
}

export type ColumnCounts = Record<BoardColumnId, number>;

/**
 * Board settings of a workspace — only a workspace added from the board has
 * them. The board root is never stored here: it is the workspace's own `path`,
 * because a second copy of a path always drifts from the first.
 */
export interface ProjectBoardSettings {
  workspaceType: WorkspaceType;
  /** Present when discovery failed; discovery is advisory and never blocks. */
  discoveryWarning?: string;
  defaultAgentId?: string;
  defaultExecutionMode?: ExecutionMode;
}

/**
 * One row of `/api/kanban/workspaces`: a workspace directory plus the board's
 * view of it.
 *
 * A board workspace *is* a workspace — there is no Project above it — so the
 * row is the directory itself: `path` is where the cards run and where the
 * sidebar's tasks land. `board` is present only on a workspace that was added
 * from the board; `cardCounts` is the server's per-column total for the row.
 */
export interface BoardWorkspace {
  id: string;
  name: string;
  /** Absolute directory the board works in; the only copy of that path. */
  path: string;
  board?: ProjectBoardSettings;
  cardCounts?: ColumnCounts;
}

export interface KanbanCard {
  id: string;
  /** The workspace this card belongs to (a board works in one directory). */
  workspaceId: string;
  title: string;
  prompt: string;
  column: BoardColumnId;
  agentId: string;
  model?: string;
  /** ACP only: preferred `reasoning_effort` value. */
  reasoningEffort?: string;
  permissionModeId?: string;
  executionMode: ExecutionMode;
  /** Git ref a worktree checkout starts from; absent = workspace HEAD. */
  baseRef?: string;
  /** The Task this card drives: created on the first start, never replaced. */
  taskId?: string;
  /** The Task's most recent Run (= the current `KanbanSession.id`). */
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Runtime handle for the process behind one Run (not a task record). */
export interface KanbanSession {
  /** = the id of the Run it drives (1:1). */
  id: string;
  cardId: string;
  runId: string;
  agentId: string;
  cwd: string;
  executionMode: ExecutionMode;
  status: SessionStatus;
  nativeSessionId?: string;
  /** ACP only: the model route the session currently runs on. */
  modelRoute?: KanbanSessionModelRoute;
  /** ACP only: the current `reasoning_effort` value. */
  reasoningEffort?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
  interactiveTui: boolean;
  /** Drives which detail panel the card gets: xterm for `pty`, AcpChat for `acp`. */
  transport: "pty" | "acp";
}

/* ---------- DSH chat (protocol: /api/kanban/sessions/:id/agent WS) ---------- */

/** One entry of the replayed/streamed conversation; server upserts by `id`. */
export type ChatItem =
  | { id: string; kind: "user"; text: string; at: string }
  | { id: string; kind: "agent"; text: string; at: string }
  | { id: string; kind: "reasoning"; text: string; at: string }
  | {
      id: string;
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: "running" | "done" | "error";
      input?: unknown;
      output?: string;
      error?: string;
      at: string;
    }
  | { id: string; kind: "error"; message: string; at: string };

/** A tool call the agent wants the user to approve over the ACP socket. */
export interface PermissionRequest {
  requestId: string;
  title: string;
  toolCallId?: string;
  /** `kind` ≈ allow_once / allow_always / reject_once / reject_always. */
  options: Array<{ optionId: string; name: string; kind: string }>;
  at: string;
}

export interface KanbanDirectoryEntry {
  name: string;
  path: string;
  isGitRepository: boolean;
}

export interface KanbanDirectoryListing {
  rootPath: string;
  currentPath: string;
  parentPath: string | null;
  entries: KanbanDirectoryEntry[];
}

export interface KanbanGitInfo {
  currentBranch: string | null;
  branches: string[];
  defaultBranch: string | null;
}

/** One card to create from the task form. Multi-task creation makes several. */
export interface TaskDraft {
  prompts: string[];
  /** Only meaningful for a single prompt; absent = derived from the prompt. */
  title?: string;
  agentId: string;
  model?: string;
  /** ACP only: preferred `reasoning_effort` value. */
  reasoningEffort?: string;
  permissionModeId?: string;
  executionMode: ExecutionMode;
  baseRef?: string;
}

/** The last choices a user made in a workspace, used to seed the next task. */
export interface TaskFormDefaults {
  agentId?: string;
  model?: string;
  permissionModeId?: string;
  executionMode?: ExecutionMode;
  baseRef?: string;
}
