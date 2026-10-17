/**
 * Board view model (v13 §七), shared by the board view and its dialogs.
 *
 * These mirror the server's JSON exactly; the web package does not import core
 * types so the browser bundle stays free of Node code.
 */

export type BoardColumnId = "backlog" | "in_progress" | "review" | "trash";
export type ExecutionMode = "direct" | "worktree";
export type WorkspaceType = "none" | "git" | "multi-git" | "google-repo";
export type SessionStatus =
  | "starting"
  | "running"
  | "awaiting_review"
  | "needs_attention"
  | "failed"
  | "interrupted"
  | "stopped";

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
  permissionModes: KanbanAgentPermissionMode[];
  modelFlag: string | null;
}

export type ColumnCounts = Record<BoardColumnId, number>;

export interface KanbanProject {
  id: string;
  name: string;
  rootPath: string;
  workspaceType: WorkspaceType;
  discoveryWarning?: string;
  defaultAgentId?: string;
  defaultExecutionMode?: ExecutionMode;
  cardCounts?: ColumnCounts;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanCard {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  column: BoardColumnId;
  agentId: string;
  model?: string;
  permissionModeId?: string;
  executionMode: ExecutionMode;
  /** Git ref a worktree checkout starts from; absent = project HEAD. */
  baseRef?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanSession {
  id: string;
  cardId: string;
  agentId: string;
  cwd: string;
  executionMode: ExecutionMode;
  status: SessionStatus;
  nativeSessionId?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
  interactiveTui: boolean;
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
  permissionModeId?: string;
  executionMode: ExecutionMode;
  baseRef?: string;
}

/** The last choices a user made in a project, used to seed the next task. */
export interface TaskFormDefaults {
  agentId?: string;
  model?: string;
  permissionModeId?: string;
  executionMode?: ExecutionMode;
  baseRef?: string;
}
