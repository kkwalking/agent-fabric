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
  /** `pty` = raw terminal (Claude/Pi/OpenCode); `acp` = structured chat (DSH). */
  transport: "pty" | "acp";
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
