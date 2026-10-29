/**
 * Browser-local signals for data shared between views.
 *
 * The GET cache in `api.ts` is invalidated by a write, but that only makes the
 * *next* read fresh — it cannot tell a view that is already on screen to read
 * again. Views that show Tasks therefore reload when another view says Tasks
 * changed. These events never leave this window; a second window still picks
 * up changes on its own navigation (or its next write).
 */

export const TASKS_CHANGED_EVENT = "agentfabric:tasks-changed";

/** Call after any write that creates, renames or (soft) deletes a Task. */
export function notifyTasksChanged(): void {
  window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
}
