/**
 * Restart recovery, and the one rule it must never break: a finished turn is a
 * fact, and a boot path may not rewrite it.
 *
 * Only the board storage is needed to build these records, so this constructs the
 * bare minimum `KanbanService` (no tasks/runs services) — the recovery path reads
 * and settles sessions, and `sessionOutcome` is what it consults.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KanbanService } from "./kanban.js";
import { Store } from "./store.js";
import type { KanbanCard, KanbanSession, Run, Task, Workspace } from "./types.js";

function fixture(dir: string) {
  const store = new Store(dir);
  const kanban = new KanbanService(store, {
    workspaces: { get: () => undefined, list: () => [] } as never,
    runtimes: { list: () => [] } as never,
  });
  const workspace: Workspace = {
    id: "ws_board",
    name: "board",
    type: "local",
    path: dir,
    mountPath: "/workspace",
    persistent: true,
    source: "import",
    status: "ready",
    ownership: "external",
    createdAt: "2026-01-01T00:00:00.000Z",
    board: { workspaceType: "plain" },
  } as Workspace;
  (store as unknown as { db: { workspaces: Workspace[] } }).db.workspaces.push(workspace);
  return { store, kanban };
}

/** A card, its Task and a Run in the given state, as a start would have made them. */
function seed(store: Store, opts: { sessionStatus: KanbanSession["status"]; runStatus: Run["status"] }) {
  const card: KanbanCard = {
    id: "kbcard_1",
    workspaceId: "ws_board",
    title: "a card",
    prompt: "do the thing",
    column: "in_progress",
    agentId: "claude",
    executionMode: "direct",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    taskId: "task_1",
  } as KanbanCard;
  const task: Task = {
    id: "task_1",
    title: "a card",
    prompt: "do the thing",
    workspaceId: "ws_board",
    createdAt: "2026-01-01T00:00:00.000Z",
    lifecycle: { mode: "ephemeral" },
    execution: { phase: "agent.running", status: "running" },
  } as Task;
  const run: Run = {
    id: "run_1",
    taskId: "task_1",
    workspaceId: "ws_board",
    status: opts.runStatus,
    phase: opts.runStatus === "completed" ? "completed" : "agent.running",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Run;
  const session: KanbanSession = {
    id: "run_1",
    runId: "run_1",
    cardId: "kbcard_1",
    workspaceId: "ws_board",
    agentId: "claude",
    status: opts.sessionStatus,
    transport: "pty",
    cwd: "/tmp/x",
    interactiveTui: false,
    executionMode: "direct",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as KanbanSession;
  const db = store as unknown as { db: Record<string, unknown[]> };
  db.db.kanbanCards.push(card);
  db.db.tasks.push(task);
  db.db.runs.push(run);
  db.db.kanbanSessions.push(session);
  return { card, task, run, session };
}

test("restart settles a session that was mid-turn as interrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-recovery-"));
  try {
    const { store, kanban } = fixture(dir);
    seed(store, { sessionStatus: "running", runStatus: "running" });
    const settled = await kanban.recoverInterrupted();
    assert.deepEqual(settled, ["run_1"]);
    assert.equal(store.get<KanbanSession>("kanbanSessions", "run_1")?.status, "interrupted");
    assert.equal(store.get<Run>("runs", "run_1")?.status, "cancelled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart interrupts a finished-but-unreviewed session without rewriting its outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-recovery-"));
  try {
    const { store, kanban } = fixture(dir);
    // The agent's turn ended (Run completed) and the card waits for review. The
    // session's process did not survive the restart, so the session record has to
    // say `interrupted` — a record claiming it is still live would be wrong. What
    // must survive is the *outcome*: writing `cancelled` over `completed` would
    // erase the only record that the turn actually succeeded.
    seed(store, { sessionStatus: "awaiting_review", runStatus: "completed" });
    const settled = await kanban.recoverInterrupted();
    assert.deepEqual(settled, ["run_1"], "the dead session is reported as interrupted");
    assert.equal(store.get<KanbanSession>("kanbanSessions", "run_1")?.status, "interrupted");
    assert.equal(store.get<Run>("runs", "run_1")?.status, "completed", "the completed Run survives the restart");
    assert.equal(store.get<Run>("runs", "run_1")?.phase, "completed", "and so does its phase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
