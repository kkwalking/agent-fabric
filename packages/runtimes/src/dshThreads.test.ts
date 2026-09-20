/**
 * Unit tests for DSH (DeepSeek Harness) local session discovery — the
 * event-log shapes verified against live ~/.dsh/sessions logs. Fixtures
 * reproduce DSH's frame-per-append storage: one zstd frame per event
 * line (Node's zlib can compress single frames; discovery walks the
 * concatenation with fzstd).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { listDshSessions, readDshSession } from "./dshThreads.js";

const T0 = 1_700_000_000_000;

function ev(seq: number, type: string, data: Record<string, unknown>, time = T0): unknown {
  return { type, seq, time, data };
}

function header(id: string, cwd: string, overrides: Record<string, unknown> = {}): unknown {
  return { type: "session", version: 0, id, createdAt: T0, cwd, delegationDepth: 0, ...overrides };
}

/** A desktop-created session: presets appear in the creation header and
 * can be switched mid-session via agent-preset/selected events. */
const SESSION_PRESET: unknown[] = [
  header("session-preset", "/home/work/proj-p", { agentPreset: "standard" }),
  ev(0, "agent-preset/selected", { agentPreset: "router-standard" }, T0 + 1000),
  ev(1, "turn/start", { turn: 1 }, T0 + 2000),
  ev(2, "user/message", { content: [{ type: "text", text: "preset switch" }] }, T0 + 3000),
  ev(3, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "switched" }] } }, T0 + 4000),
];

/** The full conversation from a real log: title, two turns, tools,
 * compaction summary, streaming noise, an injected extra user message. */
const SESSION_A: unknown[] = [
  header("session-a", "/home/work/proj-a"),
  ev(0, "sandbox/mode", { mode: "workspace-write" }),
  ev(1, "session/title", { title: "Fix the flaky test" }),
  ev(2, "model/selection", { provider: "deepseek", model: "kimi-k3" }),
  ev(3, "turn/start", { turn: 1 }),
  ev(3, "user/message", { content: [{ type: "text", text: "The test fails on CI" }] }),
  ev(4, "assistant/message", {
    turn: 1,
    step: 1,
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "look at the retry logic" },
        { type: "text", text: "Checking the test now." },
        { type: "tool-call", id: "c1", name: "bash", arguments: "{\"command\":\"npm test\"}" },
      ],
      source: { kind: "model", provider: "deepseek", model: "kimi-k3" },
    },
  }),
  ev(5, "tool/call", { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{\"command\":\"npm test\"}" }),
  ev(6, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      source: { kind: "tool", callId: "c1" },
      content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "3 passing" }], isError: false }],
    },
  }),
  ev(7, "tool/call", { turn: 1, step: 1, callId: "c2", name: "edit", arguments: "{\"file_path\":\"/tmp/proj-a/t.ts\"}" }),
  ev(8, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      source: { kind: "tool", callId: "c2" },
      content: [{ type: "tool-result", toolCallId: "c2", content: [{ type: "text", text: "edited" }] }],
    },
  }),
  ev(9, "tool/call", { turn: 1, step: 1, callId: "c3", name: "glob", arguments: "{\"pattern\":\"**/*.ts\"}" }),
  ev(10, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      source: { kind: "tool", callId: "c3" },
      content: [{ type: "tool-result", toolCallId: "c3", content: [{ type: "text", text: "boom" }], isError: true }],
    },
  }),
  ev(11, "compaction/summary", { summary: [{ type: "text", text: "earlier context summary" }] }),
  ev(12, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } }),
  ev(13, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ev(14, "turn/start", { turn: 2 }),
  ev(15, "user/message", { content: [{ type: "text", text: "and the config?" }] }),
  ev(16, "assistant/message", {
    turn: 2,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: "Config was fine." }] },
  }),
  ev(17, "user/message", { content: [{ type: "text", text: "(injected note)" }] }),
  ev(18, "turn/end", { turn: 2, reason: { kind: "completed" } }),
];

const SESSION_B: unknown[] = [
  header("session-b", "/home/work/proj-a", { delegationDepth: 1, parentSession: "session-a" }),
  ev(0, "turn/start", { turn: 1 }),
  ev(1, "user/message", { content: [{ type: "text", text: "subagent ask" }] }),
  ev(2, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "subagent reply" }] } }),
];

const SESSION_EMPTY: unknown[] = [header("session-empty", "/home/work/proj-b")];

const SESSION_D: unknown[] = [
  header("session-d", "/home/work/proj-d", { version: 3 }),
  ev(0, "turn/start", { turn: 1 }),
  ev(1, "user/message", { content: [{ type: "text", text: "plain log" }] }),
  ev(2, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "plain reply" }] } }),
];

// A probe session recorded under a temp directory: real conversation,
// never listed — the temp-directory constraint applies to every source.
const SESSION_TMP: unknown[] = [
  header("session-tmp", "/tmp/probe-ws"),
  ev(0, "turn/start", { turn: 1 }),
  ev(1, "user/message", { content: [{ type: "text", text: "throwaway probe" }] }),
  ev(2, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "probe reply" }] } }),
];

// DSH titles arrive in stages: a placeholder cut from the first prompt
// (source.kind "fallback") lands with the first turn, the generated title
// overwrites it moments later. An empty title event in between clears
// nothing — the last non-empty title wins.
const SESSION_TITLE: unknown[] = [
  header("session-title", "/home/work/title-probe"),
  ev(0, "turn/start", { turn: 1 }, T0),
  ev(1, "user/message", { content: [{ type: "text", text: "当前的本地分析ana_202609160915034失败了" }] }, T0 + 1000),
  ev(2, "session/title", { title: "当前的本地分析ana_202609160915034", source: { kind: "fallback" } }, T0 + 1000),
  ev(3, "session/title", {}, T0 + 1000),
  ev(4, "session/title", { title: "本地分析 vectorize 步骤失败调查", source: { kind: "provider", provider: "session-title-first-prompt-llm" } }, T0 + 2600),
  ev(5, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "looking into it" }] } }, T0 + 3000),
];

function logText(recs: unknown[]): string {
  return recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** DSH flushes one zstd frame per event batch; a fixture frame per line. */
function zstdLog(recs: unknown[]): Buffer {
  const lines = logText(recs).split("\n").filter((l) => l.trim());
  return Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(l + "\n"))));
}

function writeSession(root: string, ws: string, id: string, file: string, recs: unknown[], mtimeMs: number): void {
  const dir = join(root, ws, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), file.endsWith(".zstd") ? zstdLog(recs) : logText(recs));
  utimesSync(join(dir, file), mtimeMs / 1000, mtimeMs / 1000);
}

function makeTree(root: string): void {
  writeSession(root, "--tmp-proj-a--", "session-a", "session.jsonl.zstd", SESSION_A, 1000);
  writeSession(root, "--tmp-proj-a--", "session-b", "session.v3.jsonl.zstd", SESSION_B, 2000);
  writeSession(root, "--tmp-proj-b--", "session-empty", "session.jsonl.zstd", SESSION_EMPTY, 3000);
  writeSession(root, "--tmp-proj-d--", "session-d", "session.jsonl", SESSION_D, 4000);
  writeSession(root, "--tmp-proj-p--", "session-preset", "session.jsonl.zstd", SESSION_PRESET, 4500);
  writeSession(root, "--tmp-probe-ws--", "session-tmp", "session.jsonl.zstd", SESSION_TMP, 4700);
  writeSession(root, "--home-work-title--", "session-title", "session.jsonl.zstd", SESSION_TITLE, 4600);
  // Previously imported external thread — never re-listed.
  writeSession(root, "--tmp-proj-a--", "import-x1", "session.jsonl.zstd", SESSION_A, 5000);
}

function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-dsh-"));
  makeTree(root);
  const saved = process.env.AGENTFABRIC_DSH_SESSIONS_DIR;
  process.env.AGENTFABRIC_DSH_SESSIONS_DIR = root;
  return fn(root).finally(() => {
    if (saved === undefined) delete process.env.AGENTFABRIC_DSH_SESSIONS_DIR;
    else process.env.AGENTFABRIC_DSH_SESSIONS_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  });
}

test("lists sessions newest first, skipping delegated, empty and imported sessions", async () => {
  await withRoot(async () => {
    const sessions = await listDshSessions();
    // session-tmp carries a real conversation but a temp cwd — the
    // temp-directory constraint keeps it out of every listing.
    assert.deepEqual(sessions.map((s) => s.id), [
      "session-title",
      "session-preset",
      "session-d",
      "session-a",
    ]);
    const a = sessions[3];
    assert.equal(a.title, "Fix the flaky test");
    assert.equal(a.cwd, "/home/work/proj-a");
    assert.equal(a.model, "kimi-k3");
    assert.equal(a.createdAt, new Date(T0).toISOString());
    assert.ok((a.preview ?? "").includes("The test fails on CI"));
    // The preset names the surface a session came from: header-created
    // sessions carry theirs; headless-created ones (session-d) have none.
    assert.equal(a.source, undefined);
    assert.equal(sessions[0].source, undefined);
    assert.equal(sessions[1].source, "router-standard");
    assert.equal(sessions[2].source, undefined);
    // Listing decompresses only the log prefix (header/title/first turn),
    // so it carries no turn count — the full read reports it.
    assert.equal(a.turnCount, undefined);
    assert.equal(a.createdAt, new Date(T0).toISOString());
    assert.ok((a.preview ?? "").includes("The test fails on CI"));
    const narrowed = await listDshSessions({ cwd: "/home/work/proj-d" });
    assert.deepEqual(narrowed.map((s) => s.id), ["session-d"]);
    const limited = await listDshSessions({ limit: 1 });
    assert.deepEqual(limited.map((s) => s.id), ["session-title"]);
  });
});

test("read advances the agent preset through agent-preset/selected events", async () => {
  await withRoot(async () => {
    const detail = await readDshSession("session-preset");
    // Creation header said "standard"; the selected event moved the
    // session to "router-standard" — the value DSH's own adoptability
    // check compares against.
    assert.equal(detail.source, "router-standard");
    assert.equal(detail.model, undefined);
  });
});

test("listing waits past the placeholder title for the generated one", async () => {
  await withRoot(async () => {
    const sessions = await listDshSessions();
    const title = sessions.find((s) => s.id === "session-title");
    // Not the fallback (truncated first prompt) — the generated title
    // that DSH writes moments later wins, matching its own UI.
    assert.equal(title?.title, "本地分析 vectorize 步骤失败调查");
  });
});

test("reads a session into turns and unified items", async () => {
  await withRoot(async () => {
    const detail = await readDshSession("session-a");
    assert.equal(detail.title, "Fix the flaky test");
    assert.equal(detail.turnCount, 2);
    assert.equal(detail.turns?.length, 2);
    assert.equal(detail.turns?.[0].userText, "The test fails on CI");
    assert.deepEqual(
      (detail.turns?.[0].items ?? []).map((i) => i.kind),
      // assistant/tool-call blocks are the announcement; the tool/call
      // event is projected. Streaming chunks and step bookkeeping drop out;
      // the compaction summary stays as a reasoning item.
      ["user-message", "reasoning", "agent-message", "command", "file-change", "tool-call", "reasoning"]
    );
    const command = detail.items.find((i) => i.kind === "command");
    assert.equal(command && command.kind === "command" ? command.command : undefined, "npm test");
    assert.equal(command && command.kind === "command" ? command.output : undefined, "3 passing");
    const edit = detail.items.find((i) => i.kind === "file-change");
    assert.equal(edit && edit.kind === "file-change" ? edit.path : undefined, "/tmp/proj-a/t.ts");
    assert.equal(edit && edit.kind === "file-change" ? edit.action : undefined, "update");
    const call = detail.items.find((i) => i.kind === "tool-call");
    assert.equal(call && call.kind === "tool-call" ? call.tool : undefined, "glob");
    assert.equal(call && call.kind === "tool-call" ? call.isError : undefined, true);
    assert.ok((call && call.kind === "tool-call" ? String(call.result) : "").includes("boom"));
    const second = detail.turns?.[1];
    assert.equal(second?.userText, "and the config?");
    // The injected extra user message stays in its own turn as an item.
    assert.deepEqual((second?.items ?? []).map((i) => i.kind), ["user-message", "agent-message", "user-message"]);

    // Delegated and empty sessions are not listed but stay readable.
    const delegated = await readDshSession("session-b");
    assert.equal(delegated.turns?.length, 1);
    const empty = await readDshSession("session-empty");
    assert.deepEqual(empty.items, []);
    await assert.rejects(() => readDshSession("session-missing"));
  });
});

test("skips a log with a corrupt frame in listing but fails loudly on read", async () => {
  await withRoot(async (root) => {
    const dir = join(root, "--tmp-proj-c--", "session-c");
    mkdirSync(dir, { recursive: true });
    const corrupt = Buffer.concat([zstdLog(SESSION_A), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])]);
    writeFileSync(join(dir, "session.jsonl.zstd"), corrupt);
    utimesSync(join(dir, "session.jsonl.zstd"), 10, 10);
    const sessions = await listDshSessions();
    assert.ok(!sessions.some((s) => s.id === "session-c"));
    // A corrupted log is still a DSH session log for the other kinds; the
    // same tree now hides session-a behind an unreadable sibling only.
    assert.ok(sessions.some((s) => s.id === "session-a"));
    await assert.rejects(() => readDshSession("session-c"), /zstd/);
  });
});

test("returns no sessions when the sessions root does not exist", async () => {
  const saved = process.env.AGENTFABRIC_DSH_SESSIONS_DIR;
  process.env.AGENTFABRIC_DSH_SESSIONS_DIR = join(tmpdir(), "af-dsh-missing-" + Date.now());
  try {
    assert.deepEqual(await listDshSessions(), []);
  } finally {
    if (saved === undefined) delete process.env.AGENTFABRIC_DSH_SESSIONS_DIR;
    else process.env.AGENTFABRIC_DSH_SESSIONS_DIR = saved;
  }
});
