import { useEffect } from "react";
import { Icon } from "../../components";
import { TaskCreateForm, type TaskCreateSubmissionOptions } from "./TaskCreateForm";
import type {
  KanbanAgent,
  KanbanGitInfo,
  TaskDraft,
  TaskFormDefaults,
  WorkspaceType,
} from "./types";

/**
 * "New task" dialog (v13 §七).
 *
 * The same form as the inline Backlog card, plus the two things only the dialog
 * has room for: "Create more" (keep authoring after a create) and splitting one
 * numbered prompt into several cards.
 */
export function TaskCreateDialog({
  workspaceType,
  agents,
  git,
  defaults,
  createMore,
  onCreateMoreChange,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  workspaceType: WorkspaceType;
  agents: KanbanAgent[];
  git: KanbanGitInfo | null;
  defaults: TaskFormDefaults;
  busy: boolean;
  error: string | null;
  /** Persisted by the board so a "Create more" create keeps the dialog open. */
  createMore: boolean;
  onCreateMoreChange: (value: boolean) => void;
  onSubmit: (draft: TaskDraft, options: TaskCreateSubmissionOptions) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal board-dialog task-create-dialog" role="dialog" aria-modal="true" aria-label="New task">
        <header className="board-dialog-head">
          <span className="board-dialog-title">
            <Icon name="compose" size={15} />
            New task
          </span>
          <button className="board-dialog-close" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="board-dialog-body">
          <TaskCreateForm
            workspaceType={workspaceType}
            agents={agents}
            git={git}
            defaults={defaults}
            allowSplit
            allowCreateMore
            createMore={createMore}
            onCreateMoreChange={onCreateMoreChange}
            busy={busy}
            error={error}
            onSubmit={onSubmit}
            onCancel={onClose}
          />
        </div>
      </div>
    </div>
  );
}
