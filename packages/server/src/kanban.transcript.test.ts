/**
 * Saved transcript tests (v13).
 *
 * A transcript is the board's own projection written beside the store, so the
 * contract is small: round-trip the items, treat anything unreadable as
 * absent (no read-time repair), and delete with the session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanTranscriptStore } from "./kanban/transcript.js";
import type { ChatItem } from "./kanban/acpChat.js";

function tempStore(): { store: KanbanTranscriptStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "af-kanban-transcript-"));
  return {
    store: new KanbanTranscriptStore(dir),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const ITEMS: ChatItem[] = [
  { id: "user:1", kind: "user", text: "list the files", at: "2026-01-01T00:00:00.000Z" },
  { id: "msg:m1", kind: "agent", text: "done", at: "2026-01-01T00:00:01.000Z" },
  {
    id: "tool:c1",
    kind: "tool",
    toolCallId: "c1",
    title: "bash",
    status: "done",
    output: "a.txt",
    at: "2026-01-01T00:00:02.000Z",
  },
];

test("a transcript round-trips through the data directory", async () => {
  const { store, cleanup } = tempStore();
  try {
    assert.deepEqual(await store.load("kbsess_a"), { items: [], found: false });
    await store.save("kbsess_a", ITEMS);
    assert.deepEqual(await store.load("kbsess_a"), { items: ITEMS, found: true });

    // The synchronous write (shutdown path) produces the same document.
    store.saveSync("kbsess_b", ITEMS.slice(0, 1));
    assert.deepEqual(await store.load("kbsess_b"), { items: ITEMS.slice(0, 1), found: true });
  } finally {
    cleanup();
  }
});

test("unreadable or stale transcripts read as absent instead of being repaired", async () => {
  const { store, cleanup } = tempStore();
  try {
    const path = store.path("kbsess_c");
    store.saveSync("kbsess_c", ITEMS);
    writeFileSync(path, "{not json", "utf8");
    assert.deepEqual(await store.load("kbsess_c"), { items: [], found: false });

    // An older document version is not migrated on read (AGENTS.md).
    writeFileSync(path, JSON.stringify({ version: 0, sessionId: "kbsess_c", items: ITEMS }), "utf8");
    assert.deepEqual(await store.load("kbsess_c"), { items: [], found: false });

    // A malformed item invalidates the whole transcript.
    writeFileSync(
      path,
      JSON.stringify({ version: 1, sessionId: "kbsess_c", items: [{ id: "user:1", kind: "nope" }] }),
      "utf8"
    );
    assert.deepEqual(await store.load("kbsess_c"), { items: [], found: false });
    // The unreadable file is left in place; the board simply treats it as absent.
    assert.equal(existsSync(path), true);
  } finally {
    cleanup();
  }
});

test("removing a transcript deletes only that session's file", async () => {
  const { store, cleanup } = tempStore();
  try {
    await store.save("kbsess_x", ITEMS);
    await store.save("kbsess_y", ITEMS);
    await store.remove("kbsess_x");
    assert.equal((await store.load("kbsess_x")).found, false);
    assert.equal((await store.load("kbsess_y")).found, true);
  } finally {
    cleanup();
  }
});

test("a session id that could escape the transcript directory is refused", () => {
  const { store, cleanup } = tempStore();
  try {
    assert.throws(() => store.path("../escape"), /Invalid board session id/);
  } finally {
    cleanup();
  }
});
