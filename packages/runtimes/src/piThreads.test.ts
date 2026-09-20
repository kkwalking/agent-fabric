/**
 * Unit tests for Pi Coding Agent local session discovery — transcript
 * shapes verified against real ~/.pi/agent/sessions files (v3 tree with
 * id/parentId, toolResult entries, model_change/session_info/compaction).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPiSessions, readPiSession } from "./piThreads.js";

function transcript(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function makeTree(dir: string): void {
  const subdir = (name: string): string => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  // A v3 tree session: two branches off the root — the abandoned one is
  // not part of the conversation and must not be read.
  const header = { type: "session", version: 3, id: "11111111-1111-1111-1111-111111111111", timestamp: "2026-09-01T10:00:00.000Z", cwd: "/home/work/proj-a" };
  writeFileSync(
    subdir("--tmp-proj-a") + "/2026-09-01T10-00-00-000Z_11111111-1111-1111-1111-111111111111.jsonl",
    transcript([
      header,
      { type: "model_change", id: "e0", parentId: null, timestamp: "2026-09-01T10:00:01.000Z", provider: "zai", modelId: "glm-4.7" },
      { type: "message", id: "e1", parentId: "e0", timestamp: "2026-09-01T10:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "Fix the flaky test" }] } },
      // Abandoned branch: an assistant reply that was discarded.
      { type: "message", id: "e2", parentId: "e1", timestamp: "2026-09-01T10:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned reply" }], model: "glm-4.7" } },
      // Active branch: thinking + bash + write + tool call, then results.
      { type: "message", id: "e3", parentId: "e1", timestamp: "2026-09-01T10:00:04.000Z", message: { role: "assistant", model: "glm-4.7", content: [
        { type: "thinking", thinking: "check the retry logic" },
        { type: "text", text: "Checking now." },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
        { type: "toolCall", id: "c2", name: "write", arguments: { file_path: "/tmp/proj-a/t.ts", content: "x" } },
        { type: "toolCall", id: "c3", name: "webfetch", arguments: { url: "https://x" } },
      ] } },
      { type: "message", id: "e4", parentId: "e3", timestamp: "2026-09-01T10:00:05.000Z", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "3 passing" }] } },
      { type: "message", id: "e5", parentId: "e4", timestamp: "2026-09-01T10:00:06.000Z", message: { role: "toolResult", toolCallId: "c3", content: [{ type: "text", text: "page body" }], isError: true } },
      { type: "message", id: "e6", parentId: "e5", timestamp: "2026-09-01T10:00:07.000Z", message: { role: "user", content: [{ type: "text", text: "and the config?" }] } },
      { type: "message", id: "e7", parentId: "e6", timestamp: "2026-09-01T10:00:08.000Z", message: { role: "assistant", content: [{ type: "text", text: "Config was fine." }] } },
      { type: "session_info", id: "e8", parentId: "e7", timestamp: "2026-09-01T10:00:09.000Z", name: "Flaky test" },
    ])
  );

  // A v1-style linear session: no ids/parentIds, plus a compaction entry.
  writeFileSync(
    subdir("--tmp-proj-b") + "/2026-09-02T10-00-00-000Z_22222222-2222-2222-2222-222222222222.jsonl",
    transcript([
      { type: "session", version: 1, id: "22222222-2222-2222-2222-222222222222", timestamp: "2026-09-02T10:00:00.000Z", cwd: "/home/work/proj-b" },
      { type: "message", timestamp: "2026-09-02T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello there" }] } },
      { type: "compaction", timestamp: "2026-09-02T10:00:02.000Z", summary: "earlier context summary" },
      { type: "message", timestamp: "2026-09-02T10:00:03.000Z", message: { role: "assistant", model: "glm-4.6", content: [{ type: "text", text: "Hi!" }] } },
    ])
  );

  // Header-only session: no conversation, not listed.
  writeFileSync(
    subdir("--tmp-proj-c") + "/2026-09-03T10-00-00-000Z_33333333-3333-3333-3333-333333333333.jsonl",
    transcript([{ type: "session", version: 3, id: "33333333-3333-3333-3333-333333333333", timestamp: "2026-09-03T10:00:00.000Z", cwd: "/home/work/proj-c" }])
  );

  // Foreign .jsonl without a session header (e.g. editor scratch): never
  // read as a pi session.
  writeFileSync(subdir("--tmp-proj-c") + "/scratch.jsonl", transcript([{ id: "x", cwd: "/tmp", entries: ["not pi"] }]));
}

function withSessionsDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.AGENTFABRIC_PI_SESSIONS_DIR;
  process.env.AGENTFABRIC_PI_SESSIONS_DIR = dir;
  return fn().finally(() => {
    if (saved === undefined) delete process.env.AGENTFABRIC_PI_SESSIONS_DIR;
    else process.env.AGENTFABRIC_PI_SESSIONS_DIR = saved;
  });
}

test("lists pi sessions newest first, skipping header-less and empty files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-pi-"));
  makeTree(dir);
  try {
    await withSessionsDir(dir, async () => {
      const sessions = await listPiSessions();
      assert.deepEqual(sessions.map((s) => s.id), [
        "22222222-2222-2222-2222-222222222222",
        "11111111-1111-1111-1111-111111111111",
      ]);
      const a = sessions[1];
      assert.equal(a.title, "Flaky test");
      assert.equal(a.cwd, "/home/work/proj-a");
      assert.equal(a.model, "glm-4.7");
      assert.equal(a.turnCount, 2);
      assert.equal(a.preview, "Fix the flaky test");
      assert.ok((a.updatedAt ?? "").startsWith("2026-09-01"));

      const narrowed = await listPiSessions({ cwd: "/home/work/proj-b" });
      assert.deepEqual(narrowed.map((s) => s.id), ["22222222-2222-2222-2222-222222222222"]);
      assert.deepEqual(await listPiSessions({ cwd: "/tmp/nowhere" }), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads the active branch only, pairing toolResults with their calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-pi-"));
  makeTree(dir);
  try {
    await withSessionsDir(dir, async () => {
      const detail = await readPiSession("11111111-1111-1111-1111-111111111111");
      assert.equal(detail.turns?.length, 2);
      assert.equal(detail.turns?.[0].userText, "Fix the flaky test");
      // The abandoned branch's reply never appears.
      assert.ok(!detail.items.some((i) => i.kind === "agent-message" && i.text === "abandoned reply"));
      assert.deepEqual(
        (detail.turns?.[0].items ?? []).map((i) => i.kind),
        ["user-message", "reasoning", "agent-message", "command", "file-change", "tool-call"]
      );
      const command = detail.items.find((i) => i.kind === "command");
      assert.equal(command && command.kind === "command" ? command.command : undefined, "npm test");
      assert.equal(command && command.kind === "command" ? command.output : undefined, "3 passing");
      const write = detail.items.find((i) => i.kind === "file-change");
      assert.equal(write && write.kind === "file-change" ? write.path : undefined, "/tmp/proj-a/t.ts");
      assert.equal(write && write.kind === "file-change" ? write.action : undefined, "add");
      const call = detail.items.find((i) => i.kind === "tool-call");
      assert.equal(call && call.kind === "tool-call" ? call.tool : undefined, "webfetch");
      assert.equal(call && call.kind === "tool-call" ? call.isError : undefined, true);
      assert.equal(call && call.kind === "tool-call" ? call.result : undefined, "page body");

      // A header-only session reads as an empty history (the file exists),
      // while an unknown id rejects.
      const empty = await readPiSession("33333333-3333-3333-3333-333333333333");
      assert.deepEqual(empty.items, []);
      await assert.rejects(() => readPiSession("no-such-session"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads a v1 linear transcript; compaction summaries surface as reasoning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-pi-"));
  makeTree(dir);
  try {
    await withSessionsDir(dir, async () => {
      const detail = await readPiSession("22222222-2222-2222-2222-222222222222");
      assert.equal(detail.turns?.length, 1);
      const kinds = (detail.items ?? []).map((i) => i.kind);
      assert.deepEqual(kinds, ["user-message", "reasoning", "agent-message"]);
      const summary = detail.items.find((i) => i.kind === "reasoning");
      assert.equal(summary && summary.kind === "reasoning" ? summary.text : undefined, "earlier context summary");
      assert.equal(detail.model, "glm-4.6");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns no sessions when the transcripts root does not exist", async () => {
  const saved = process.env.AGENTFABRIC_PI_SESSIONS_DIR;
  process.env.AGENTFABRIC_PI_SESSIONS_DIR = join(tmpdir(), "af-pi-missing-" + Date.now());
  try {
    assert.deepEqual(await listPiSessions(), []);
  } finally {
    if (saved === undefined) delete process.env.AGENTFABRIC_PI_SESSIONS_DIR;
    else process.env.AGENTFABRIC_PI_SESSIONS_DIR = saved;
  }
});
