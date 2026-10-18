import { useEffect } from "react";
import { Icon } from "../../components";
import {
  TaskCreateForm,
  initialFromCard,
  type TaskCreateSubmissionOptions,
  type TaskFormInitial,
} from "./TaskCreateForm";
import type {
  KanbanAgent,
  KanbanCard,
  KanbanGitInfo,
  TaskDraft,
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
  initial,
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
  initial: TaskFormInitial;
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
            initial={initial}
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

/**
 * "Edit task" dialog (v13 §七).
 *
 * Clicking a Backlog card opens this: the same form the card was created with,
 * seeded from the card, with one action — save. It exists only while the card is
 * still in Backlog; once a session has started, the card's prompt and agent are
 * history the board must not rewrite, so the card opens its detail view instead.
 */
export function TaskEditDialog({
  card,
  workspaceType,
  agents,
  git,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  card: KanbanCard;
  workspaceType: WorkspaceType;
  agents: KanbanAgent[];
  git: KanbanGitInfo | null;
  busy: boolean;
  error: string | null;
  /** A card is one task: the draft carries exactly one prompt. */
  onSubmit: (draft: TaskDraft) => void;
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
      <div className="modal board-dialog task-create-dialog" role="dialog" aria-modal="true" aria-label="Edit task">
        <header className="board-dialog-head">
          <span className="board-dialog-title">
            <Icon name="compose" size={15} />
            Edit task
          </span>
          <button className="board-dialog-close" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="board-dialog-body">
          <TaskCreateForm
            key={card.id}
            workspaceType={workspaceType}
            agents={agents}
            git={git}
            initial={initialFromCard(card)}
            editing
            busy={busy}
            error={error}
            onSubmit={(draft) => onSubmit(draft)}
            onCancel={onClose}
          />
        </div>
      </div>
    </div>
  );
}
