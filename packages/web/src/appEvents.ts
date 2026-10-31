/**
 * Browser-local signals for data shared between views.
 *
 * The GET cache in `api.ts` is invalidated by a write, but that only makes the
 * *next* read fresh — it cannot tell a view that is already on screen to read
 * again. Views that show Tasks therefore reload when another view says Tasks
 * changed. These events never leave this window; a second window still picks
 * up changes on its own navigation (or its next write).
 *
 * Every writer announces what it wrote. Before this, only the board did: a
 * delete from the task list left the rail stale, a restore from Trash left both
 * stale, and they waited on the 5s GET cache to expire.
 *
 * ## Announcing precisely
 *
 * A task event carries the id it is about. `TaskThread`, `TaskLifecycle` and
 * the run inspector are about **one** task; when the rail deletes a different
 * task they reloaded anyway — a whole detail page, for nothing. Writers pass
 * what they touched and readers filter. `undefined` id means "something moved,
 * I don't know what" (the board drops a whole column, a bulk action): every
 * reader reloads, which is the old behaviour and the honest one.
 */

export const TASKS_CHANGED_EVENT = "agentfabric:tasks-changed";
export const RUNS_CHANGED_EVENT = "agentfabric:runs-changed";

/** Detail kept on the event: which record changed, when the writer knows. */
export interface FetchedChange {
  /** The task this is about; omitted when the writer cannot name one. */
  taskId?: string;
  /** The run this is about, for run events. */
  runId?: string;
}

function announce(event: string, detail: FetchedChange): void {
  // Never silence handler exceptions: a view that fails to reload must not take
  // the writer down with it, but the failure has to be visible.
  try {
    window.dispatchEvent(new CustomEvent(event, { detail }));
  } catch (e) {
    console.error(`[agentfabric] reload handler for ${event} failed`, e);
  }
}

/** Call after any write that creates, renames, (soft) deletes or restores a Task. */
export function notifyTasksChanged(changed: FetchedChange = {}): void {
  announce(TASKS_CHANGED_EVENT, changed);
}

/**
 * Call after any write that starts, cancels or otherwise moves a Run.
 *
 * A Run change usually implies a Task change (a new execution, a cancel), so
 * this also announces the task: announcing both is cheaper than reasoning about
 * which callers need which, and a redundant reload is a cache hit.
 */
export function notifyRunsChanged(changed: FetchedChange = {}): void {
  announce(RUNS_CHANGED_EVENT, changed);
  notifyTasksChanged(changed);
}

/**
 * Subscribes to one of the events above; returns the unsubscribe function.
 *
 * `accepts` lets a page about a single record ignore changes to other records.
 * Omitting it means "reload on anything", which is right for a list.
 */
export function onAppEvent(
  event: string,
  handler: (change: FetchedChange) => void,
  accepts?: (change: FetchedChange) => boolean
): () => void {
  const listener = (e: Event) => {
    const change = (e as CustomEvent<FetchedChange>).detail ?? {};
    if (accepts && !accepts(change)) return;
    handler(change);
  };
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}
