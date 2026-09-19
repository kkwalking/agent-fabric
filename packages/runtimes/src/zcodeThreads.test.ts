/**
 * Unit tests for ZCode local session discovery — the store shapes
 * verified against the live ~/.zcode/cli/db/db.sqlite (schema with
 * per-store sequence columns, assistant modelId, tool part state).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listZcodeSessions, readZcodeSession } from "./zcodeThreads.js";

function makeStore(dir: string): void {
  const db = new DatabaseSync(join(dir, "db.sqlite"));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER,
      time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER,
      time_created INTEGER, data TEXT);
  `);
  const session = (
    id: string,
    title: string | null,
    directory: string | null,
    parent: string | null = null,
    updated = 1000
  ): void => {
    db.prepare("INSERT INTO session (id, parent_id, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, parent, title, directory, updated - 5000, updated
    );
  };
  const message = (id: string, sessionId: string, sequence: number, data: unknown, time: number): void => {
    db.prepare("INSERT INTO message (id, session_id, sequence, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      id, sessionId, sequence, time, JSON.stringify(data)
    );
  };
  const part = (id: string, messageId: string, sequence: number, data: unknown): void => {
    db.prepare("INSERT INTO part (id, message_id, sequence, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      id, messageId, sequence, 0, JSON.stringify(data)
    );
  };

  // A full conversation: user → assistant (thinking + bash + edit + mcp)
  // → user → assistant (text).
  session("sess_a", "Fix the flaky test", "/tmp/proj-a");
  message("m1", "sess_a", 0, { role: "user" }, 1001);
  part("m1p1", "m1", 0, { type: "text", text: "The test fails on CI" });
  message("m2", "sess_a", 1, { role: "assistant", modelId: "glm-4.7" }, 1002);
  part("m2p1", "m2", 0, { type: "reasoning", text: "look at the retry logic" });
  part("m2p2", "m2", 1, { type: "text", text: "Checking the test now." });
  part("m2p3", "m2", 2, {
    type: "tool", tool: "Bash", callID: "c1",
    state: { status: "completed", input: { command: "npm test" }, output: "3 passing" },
  });
  part("m2p4", "m2", 3, {
    type: "tool", tool: "Edit", callID: "c2",
    state: { status: "completed", input: { file_path: "/tmp/proj-a/t.ts" } },
  });
  part("m2p5", "m2", 4, {
    type: "tool", tool: "mcp__x__lookup", callID: "c3",
    state: { status: "error", input: { q: "flaky" }, output: { err: "boom" } },
  });
  part("m2p6", "m2", 5, { type: "compaction", summary: { body: "earlier context summary" } });
  part("m2p7", "m2", 6, { type: "step-finish", tokens: { total: 10 } });
  message("m3", "sess_a", 2, { role: "user" }, 1003);
  part("m3p1", "m3", 0, { type: "text", text: "and the config?" });
  message("m4", "sess_a", 3, { role: "assistant", modelId: "glm-4.7" }, 1004);
  part("m4p1", "m4", 0, { type: "text", text: "Config was fine." });

  // A branched child session — internal bookkeeping, never listed.
  session("sess_child", "child", "/tmp/proj-a", "sess_a", 2000);

  // A session with no readable conversation (user message without text).
  session("sess_empty", null, "/tmp/proj-b", null, 3000);
  message("e1", "sess_empty", 0, { role: "user" }, 3001);

  db.close();
}

test("lists main sessions newest first, skipping child and empty sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-zcode-"));
  makeStore(dir);
  try {
    const saved = process.env.AGENTFABRIC_ZCODE_DB_DIR;
    process.env.AGENTFABRIC_ZCODE_DB_DIR = dir;
    try {
      const sessions = await listZcodeSessions();
      assert.deepEqual(sessions.map((s) => s.id), ["sess_a"]);
      const a = sessions[0];
      assert.equal(a.title, "Fix the flaky test");
      assert.equal(a.cwd, "/tmp/proj-a");
      assert.equal(a.model, "glm-4.7");
      assert.equal(a.turnCount, 2);
      assert.ok((a.preview ?? "").includes("The test fails on CI"));
      const narrowed = await listZcodeSessions({ cwd: "/tmp/nowhere" });
      assert.deepEqual(narrowed, []);
      const limited = await listZcodeSessions({ limit: 0 });
      assert.equal(limited.length, 1);
    } finally {
      if (saved === undefined) delete process.env.AGENTFABRIC_ZCODE_DB_DIR;
      else process.env.AGENTFABRIC_ZCODE_DB_DIR = saved;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads a session into turns and unified items", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-zcode-"));
  makeStore(dir);
  try {
    const saved = process.env.AGENTFABRIC_ZCODE_DB_DIR;
    process.env.AGENTFABRIC_ZCODE_DB_DIR = dir;
    try {
      const detail = await readZcodeSession("sess_a");
      assert.equal(detail.turns?.length, 2);
      assert.equal(detail.turns?.[0].userText, "The test fails on CI");
      assert.deepEqual(
        (detail.turns?.[0].items ?? []).map((i) => i.kind),
        // step-finish is structural and drops out; compaction stays as a
        // reasoning item at its place in the record.
        ["user-message", "reasoning", "agent-message", "command", "file-change", "tool-call", "reasoning"]
      );
      const command = detail.items.find((i) => i.kind === "command");
      assert.equal(command && command.kind === "command" ? command.command : undefined, "npm test");
      assert.equal(command && command.kind === "command" ? command.output : undefined, "3 passing");
      const edit = detail.items.find((i) => i.kind === "file-change");
      assert.equal(edit && edit.kind === "file-change" ? edit.path : undefined, "/tmp/proj-a/t.ts");
      const call = detail.items.find((i) => i.kind === "tool-call");
      assert.equal(call && call.kind === "tool-call" ? call.tool : undefined, "mcp__x__lookup");
      assert.equal(call && call.kind === "tool-call" ? call.isError : undefined, true);
      assert.ok((call && call.kind === "tool-call" ? String(call.result) : "").includes("boom"));
      const summaries = detail.items.filter((i) => i.kind === "reasoning");
      const summary = summaries[summaries.length - 1];
      assert.equal(summary && summary.kind === "reasoning" ? summary.text : undefined, "earlier context summary");

      await assert.rejects(() => readZcodeSession("sess_child"));
      await assert.rejects(() => readZcodeSession("sess_missing"));
    } finally {
      if (saved === undefined) delete process.env.AGENTFABRIC_ZCODE_DB_DIR;
      else process.env.AGENTFABRIC_ZCODE_DB_DIR = saved;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns no sessions when the store directory does not exist", async () => {
  const saved = process.env.AGENTFABRIC_ZCODE_DB_DIR;
  process.env.AGENTFABRIC_ZCODE_DB_DIR = join(tmpdir(), "af-zcode-missing-" + Date.now());
  try {
    assert.deepEqual(await listZcodeSessions(), []);
  } finally {
    if (saved === undefined) delete process.env.AGENTFABRIC_ZCODE_DB_DIR;
    else process.env.AGENTFABRIC_ZCODE_DB_DIR = saved;
  }
});
