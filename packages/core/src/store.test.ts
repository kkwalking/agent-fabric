/**
 * Store durability: two Stores over one directory must not fight over the
 * temp file used by the atomic write.
 *
 * The board made this concrete: a board card's start writes a Task, a Run, a
 * session handle and the card in one step, and the server tests open two
 * Stores on the same directory (a restart overlapping the instance it
 * replaces). A single shared `<db>.tmp` name made those writes rename *the
 * same file*, so one of them failed with ENOENT and the failure surfaced as a
 * failed session.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "./store.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "af-store-"));
}

test("two Stores on one directory flush concurrently without clobbering each other", async () => {
  const dir = tempDir();
  try {
    const first = await Store.open(dir);
    const second = await Store.open(dir);

    // Interleaved writes: each Store persists its own view of the same file.
    await Promise.all([
      first.updateConfig({ allowHostExecution: true }),
      second.updateConfig({ allowHostExecution: false }),
      first.updateConfig({ allowHostExecution: true }),
      second.updateConfig({ allowHostExecution: false }),
    ]);

    // The file is always a complete document — a rename is atomic, so the
    // database on disk parses, and no temp file is left behind.
    const text = readFileSync(join(dir, "db.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(text));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      []
    );

    // Reopening reads the last complete write, whichever Store won.
    const reopened = await Store.open(dir);
    assert.equal(typeof reopened.config().allowHostExecution, "boolean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
