/**
 * Tests for the v6 spec (v6.md): Codex Local harness + cross-harness
 * handoff continuity.
 *
 * - §1/§2: Codex Local runs on the machine's own `codex` CLI with its
 *   ChatGPT login; auth is *detected* (installed/logged in/usable),
 *   never copied.
 * - §3: harness-native runtimes never bind an AgentFabric Model.
 * - §4/§5: Codex native session = RuntimeSessionRef (runtimeKind codex,
 *   thread id, local backend, resumable); resume via `codex exec resume`.
 * - §6/§7: local thread discovery and read through the app-server.
 * - §8: import/adopt an existing thread → workspace association,
 *   per-turn runs, session ref, handoff toward another harness.
 * - §10: quota exhaustion is classified (`errorKind: "usage-limit"`),
 *   not a plain run failure.
 * - §13: containerized Codex is refused.
 * - §15: acceptance scenarios A (run + native resume) and B (adopt →
 *   handoff → continue on Pi); C is covered by the quota classification
 *   plus the same handoff path.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  freshHarness,
  makeFixtures,
  useBins,
  waitForRun,
  type Fixtures,
  type Harness,
} from "./testkit.js";
import { makeCodexThreadsFixture } from "./fakes.js";
import { codexAuthStatus, detectCodexUsageLimit } from "../../runtimes/src/codex.js";
import type { CompletionFactory } from "./orchestrator.js";

/** Fails summarization instantly so handoffs take the explicitly-degraded digest path. */
const offlineCompletion: CompletionFactory = () =>
  async () => ({ text: "", stopReason: "error" as const, errorMessage: "test: offline" });

function runtimeOf(h: Harness, kind: string) {
  const rt = h.store.list<any>("runtimes").find((r) => r.kind === kind);
  assert.ok(rt, `seeded ${kind} runtime must exist`);
  return rt;
}

/** Fake-codex session store: mark a thread id as resumable. */
function seedCodexSession(fx: Fixtures, threadId: string): void {
  const file = join(fx.dir, "sessions.json");
  const store = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string[]>) : {};
  store[threadId] ??= ["prior context"];
  writeFileSync(file, JSON.stringify(store));
}

function codexInvocations(fx: Fixtures): Array<{ harness: string; argv: string[]; cwd: string }> {
  const dump = join(fx.dir, "codex-dump.jsonl");
  if (!existsSync(dump)) return [];
  return readFileSync(dump, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Cancels any still-executing run before the env fixture is restored. A
 * failed assertion can leave a background run in flight; without this it
 * would respawn the harness *after* AGENTFABRIC_CODEX_BIN was restored —
 * i.e. against the user's real codex login. Never let that escape.
 */
async function quiesce(h: Harness): Promise<void> {
  for (const r of h.runService.list()) {
    if (["pending", "starting", "running"].includes(r.status)) {
      await h.runService.cancel(r.id).catch(() => {});
    }
  }
  await new Promise((r) => setTimeout(r, 200));
}

test("detectCodexUsageLimit matches the canonical CLI quota strings (v6 §10)", () => {
  assert.equal(detectCodexUsageLimit("You've hit your usage limit. Try again in 3 hours 25 minutes."), true);
  assert.equal(detectCodexUsageLimit("usage limit reached"), true);
  assert.equal(detectCodexUsageLimit("You have hit your usage cap"), true);
  assert.equal(detectCodexUsageLimit("HTTP 402: insufficient_quota"), true);
  assert.equal(detectCodexUsageLimit("quota exceeded for this session"), true);
  assert.equal(detectCodexUsageLimit("npm ERR! command failed"), false);
  assert.equal(detectCodexUsageLimit("Reconnecting... 1/5"), false);
  assert.equal(detectCodexUsageLimit(undefined), false);
});

test("harness-native auth is detected through codex's own surfaces (v6 §2)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const ok = await codexAuthStatus(fx.fakeCodex);
    assert.equal(ok.installed, true);
    assert.equal(ok.loggedIn, true);
    assert.equal(ok.ok, true);
    assert.match(ok.detail ?? "", /ChatGPT/);
    assert.match(ok.version ?? "", /codex-cli/);

    process.env.FAKE_CODEX_LOGGED_OUT = "1";
    const out = await codexAuthStatus(fx.fakeCodex);
    assert.equal(out.installed, true);
    assert.equal(out.loggedIn, false);
    assert.equal(out.ok, false);
    assert.match(out.hint ?? "", /codex login/);
  } finally {
    delete process.env.FAKE_CODEX_LOGGED_OUT;
    restore();
  }
});

test("scenario A: codex run needs no provider/model, captures the thread id and native-resumes (v6 §1/§3/§4/§5/§15A)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { FAKE_CODEX_DUMP: join(fx.dir, "codex-dump.jsonl"), FAKE_CODEX_SCENARIO: "tools" });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const codex = runtimeOf(h, "codex");
    assert.equal(codex.credentialSource, "harness-native");

    // §3: even with AgentFabric models configured, the codex run binds none.
    assert.ok(h.store.list("models").length > 0, "seeded models exist");
    const { task, run } = await h.runService.submit({
      prompt: "fix the flaky test",
      runtimeId: codex.id,
      workspaceId: (await h.workspaces.create({ name: "ws-a", type: "local", path: join(fx.dir, "ws-a") })).id,
    });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "completed", finished.error);
    assert.equal(finished.modelId, undefined);
    assert.equal(finished.providerId, undefined);
    assert.equal(finished.errorKind, undefined);

    // §5: the codex thread id became the native session reference.
    const refs = h.runtimeSessions.list({ taskId: task.id });
    assert.equal(refs.length, 1);
    const ref = refs[0];
    assert.equal(ref.runtimeKind, "codex");
    assert.match(ref.nativeSessionRef, /^fake-thread-/);
    assert.equal(ref.resumeSupported, true);
    assert.equal(ref.executionBackend, "local");

    // §5: events were parsed from the exec JSONL protocol.
    const events = await h.runService.events(run.id);
    assert.ok(events.some((e) => e.type === "agent.message" && String(e.data.content).includes("tests pass")));
    assert.ok(events.some((e) => e.type === "file.created" && e.data.path === "src/a.ts"));
    assert.ok(events.some((e) => e.type === "file.modified" && e.data.path === "src/b.ts"));
    assert.ok(events.some((e) => e.type === "shell.command" && e.data.command === "npm test"));
    assert.ok(events.some((e) => e.type === "tool.completed" && e.data.tool === "github/create_issue"));
    assert.ok(events.some((e) => e.type === "agent.thinking"));
    // §5: harness-reported usage reached the run record.
    assert.equal(finished.usage?.inputTokens, 1200);
    assert.equal(finished.usage?.outputTokens, 45);
    assert.equal(finished.usage?.modelRequests, 1);

    // §4/§15A: Codex → Codex continues by native resume with the thread id.
    const cont = await h.runService.continueTask(task.id, { prompt: "re-run the suite" });
    assert.equal(cont.continuity, "resume");
    assert.equal(cont.runtimeSessionRef?.nativeSessionRef, ref.nativeSessionRef);
    const resumed = await waitForRun(h.runService, cont.run.id);
    assert.equal(resumed.status, "completed", resumed.error);

    const resumeInvocations = codexInvocations(fx).filter((c) => c.argv.includes("resume"));
    assert.equal(resumeInvocations.length, 1);
    assert.ok(resumeInvocations[0].argv.includes(ref.nativeSessionRef), "resume passes the thread id");
    assert.ok(resumeInvocations[0].argv.includes("--json"));
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("quota exhaustion is classified as usage-limit, then hands off to Pi (v6 §10/§15C)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { FAKE_CODEX_DUMP: join(fx.dir, "codex-dump.jsonl"), FAKE_CODEX_SCENARIO: "usage-limit" });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const codex = runtimeOf(h, "codex");
    const ws = await h.workspaces.create({ name: "ws-c", type: "local", path: join(fx.dir, "ws-c") });
    const { task, run } = await h.runService.submit({ prompt: "keep working", runtimeId: codex.id, workspaceId: ws.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorKind, "usage-limit", `error was: ${finished.error}`);
    assert.match(finished.error ?? "", /usage limit/i);
    // The failure event carries the classification for the Task page.
    const failed = (await h.runService.events(run.id)).find((e) => e.type === "run.failed");
    assert.equal(failed?.data?.errorKind, "usage-limit");

    // The workspace stays and the thread is readable — switch to Pi.
    const pi = runtimeOf(h, "pi");
    const cont = await h.runService.continueTask(task.id, { prompt: "continue on pi" , runtimeId: pi.id, mode: "handoff", allowDegradedHandoff: true });
    assert.equal(cont.continuity, "handoff");
    assert.ok(cont.handoff);
    assert.equal(cont.handoff?.fromRuntimeKind, "codex");
    assert.equal(cont.handoff?.toRuntimeKind, "pi");
    assert.match(cont.run.inputInstruction ?? "", /Handoff from/);
    const done = await waitForRun(h.runService, cont.run.id);
    assert.equal(done.status, "completed", done.error);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("missing codex login fails fast with the fix, not a harness error (v6 §2)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { FAKE_CODEX_LOGGED_OUT: "1" });
  let h: Harness | undefined;
  try {
    h = await freshHarness();
    const codex = runtimeOf(h, "codex");
    const { run } = await h.runService.submit({ prompt: "do something", runtimeId: codex.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.error ?? "", /codex login/);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("containerized codex is refused — local execution only (v6 §13)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  let h: Harness | undefined;
  try {
    h = await freshHarness();
    const codex = runtimeOf(h, "codex");
    await h.runtimes.update(codex.id, { containerized: true });
    const { run } = await h.runService.submit({ prompt: "try docker", runtimeId: codex.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.error ?? "", /Containerized Codex refused/i);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

// Discovery filters sessions recorded under temp directories, so the
// fixture workspaces must live outside the system's temp dirs.
const wsRoot = mkdtempSync(join(homedir(), ".af-v6-ws-root-"));
after(() => rmSync(wsRoot, { recursive: true, force: true }));

test("local codex threads are discovered by cwd and recency (v6 §6/§11)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(wsRoot, "af-codex-ws-"));
  const fixture = makeCodexThreadsFixture(wsDir);
  const threadsFile = join(fx.dir, "codex-threads.json");
  writeFileSync(threadsFile, fixture.file);
  const restore = useBins(fx, { FAKE_CODEX_THREADS_FILE: threadsFile });
  let h: Harness | undefined;
  try {
    h = await freshHarness();

    const all = await h.runService.listHarnessThreads("codex");
    assert.equal(all.length, 2);
    assert.equal(all[0].id, fixture.inWorkspaceThreadId, "newest first");
    assert.equal(all[0].title, "Fix the login bug");
    assert.equal(all[0].cwd, wsDir);

    const scoped = await h.runService.listHarnessThreads("codex", { cwd: wsDir });
    assert.deepEqual(scoped.map((t) => t.id), [fixture.inWorkspaceThreadId]);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("existing codex threads are read through the harness interface (v6 §7)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(wsRoot, "af-codex-ws-"));
  const fixture = makeCodexThreadsFixture(wsDir);
  const threadsFile = join(fx.dir, "codex-threads.json");
  writeFileSync(threadsFile, fixture.file);
  const restore = useBins(fx, { FAKE_CODEX_THREADS_FILE: threadsFile });
  let h: Harness | undefined;
  try {
    h = await freshHarness();
    const detail = await h.runService.readHarnessThread("codex", fixture.inWorkspaceThreadId);
    assert.equal(detail.title, "Fix the login bug");
    assert.equal(detail.cwd, wsDir);
    assert.equal(detail.turnCount, 2);
    // Pagination (2 turns per page in the fake) still yields the full,
    // chronological history.
    assert.deepEqual(
      detail.items.map((i) => i.kind),
      [
        "user-message",
        "reasoning",
        "command",
        "agent-message",
        "file-change",
        "agent-message",
      ]
    );
    const command = detail.items.find((i) => i.kind === "command");
    assert.equal(command && command.kind === "command" ? command.exitCode : undefined, 1);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("scenario B: adopt an existing codex thread, then continue on Pi via handoff (v6 §8/§9/§15B)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(wsRoot, "af-codex-ws-"));
  const fixture = makeCodexThreadsFixture(wsDir);
  const threadsFile = join(fx.dir, "codex-threads.json");
  writeFileSync(threadsFile, fixture.file);
  const restore = useBins(fx, { FAKE_CODEX_THREADS_FILE: threadsFile, FAKE_CODEX_DUMP: join(fx.dir, "codex-dump.jsonl") });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const pi = runtimeOf(h, "pi");
    // The thread's cwd already has an AgentFabric workspace. Adoption does
    // not guess that: the caller resolves it and passes the id — which is
    // what the adoption form does — so no second record appears.
    const ws = await h.workspaces.create({ name: "login-bug", type: "local", path: wsDir });
    // Make the adopted thread resumable by the fake codex CLI.
    seedCodexSession(fx, fixture.inWorkspaceThreadId);

    const result = await h.runService.importHarnessThread({
      runtimeKind: "codex",
      threadId: fixture.inWorkspaceThreadId,
      workspaceId: ws.id,
      targetRuntimeId: pi.id,
      userNotes: "watch the auth tests",
    });

    assert.equal(result.workspaceId, ws.id, "the workspace the caller chose is associated");
    assert.equal(h.workspaces.list().length, 1, "no second workspace for the same directory");
    assert.ok(result.handoffId, "handoff generated toward Pi during adoption");
    assert.ok(result.runtimeSessionRefId, "thread registered as native session");

    // The task carries the adoption markers used by discovery (v6 §11).
    const task = h.store.get<any>("tasks", result.taskId);
    assert.equal(task.metadata.imported, true);
    assert.equal(task.metadata.importedThreadId, fixture.inWorkspaceThreadId);
    assert.equal(task.title, "Fix the login bug");

    // One completed run per codex turn, in order, with the user's input
    // recorded as the bare prompt (v5 §5 rules apply to adopted work too).
    const runs = h.runService.forTask(result.taskId);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.status === "completed"));
    assert.ok(
      runs.every((r) => r.runtimeSessionRefId === result.runtimeSessionRefId),
      "every imported run carries the adopted thread's native session reference"
    );
    assert.equal(runs[0].userPrompt, "Please fix the login bug in auth.ts");
    const events = await h.runService.events(runs[0].id);
    assert.ok(events.some((e) => e.type === "shell.command" && e.data.command === "npm test"));
    assert.ok(events.some((e) => e.type === "agent.message"));
    const turn2 = await h.runService.events(runs[1].id);
    assert.ok(turn2.some((e) => e.type === "file.modified" && e.data.path === "src/auth.ts"));

    // Discovery now marks the thread as already adopted (v6 §11).
    const listed = await h.runService.listHarnessThreads("codex", { cwd: wsDir });
    assert.equal(listed[0].adopted, true);
    assert.equal(listed[0].adoptedTaskId, result.taskId);

    // The adoption handoff exists up front with the user's notes folded in.
    const adoptionHandoff = h.store.get<any>("handoffs", result.handoffId!);
    assert.equal(adoptionHandoff.fromRuntimeKind, "codex");
    assert.equal(adoptionHandoff.toRuntimeKind, "pi");
    assert.match(adoptionHandoff.userNotes ?? "", /auth tests/);

    // Same harness → native resume of the adopted thread (v6 §4).
    const codex = runtimeOf(h, "codex");
    const resume = await h.runService.continueTask(result.taskId, { prompt: "add a regression test", runtimeId: codex.id });
    assert.equal(resume.continuity, "resume");
    const resumedRun = await waitForRun(h.runService, resume.run.id);
    assert.equal(resumedRun.status, "completed", resumedRun.error);
    assert.ok(
      codexInvocations(fx).some((c) => c.argv.includes("resume") && c.argv.includes(fixture.inWorkspaceThreadId)),
      "codex resume used the adopted thread id"
    );

    // Different harness → handoff: the imported work crosses to Pi as a
    // semantic summary; Pi creates its own new native session.
    const cont = await h.runService.continueTask(result.taskId, { prompt: "continue on pi", runtimeId: pi.id, mode: "handoff", allowDegradedHandoff: true });
    assert.equal(cont.continuity, "handoff");
    assert.equal(cont.handoff?.fromRuntimeKind, "codex");
    assert.equal(cont.handoff?.toRuntimeKind, "pi");
    assert.match(cont.run.inputInstruction ?? "", /Handoff from/);
    const done = await waitForRun(h.runService, cont.run.id);
    assert.equal(done.status, "completed", done.error);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

/** Appends native turns to the fake codex threads file — the user kept
    talking in the harness after adoption (or after an AgentFabric resume). */
function growCodexThread(threadsFile: string, threadId: string, turns: Array<Record<string, unknown>>): void {
  const db = JSON.parse(readFileSync(threadsFile, "utf8")) as { threads: Array<{ id: string; updatedAt?: number }> };
  const thread = db.threads.find((t) => t.id === threadId);
  assert.ok(thread, "fixture thread must exist");
  (thread as { turns?: unknown[] }).turns ??= [];
  (thread as { turns: unknown[] }).turns.push(...turns);
  thread.updatedAt = (thread.updatedAt ?? 0) + 100;
  writeFileSync(threadsFile, JSON.stringify(db));
}

test("syncing an adopted thread appends turns that happened in codex after adoption (v6 §8)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(wsRoot, "af-codex-ws-"));
  const fixture = makeCodexThreadsFixture(wsDir);
  const threadsFile = join(fx.dir, "codex-threads.json");
  writeFileSync(threadsFile, fixture.file);
  const restore = useBins(fx, { FAKE_CODEX_THREADS_FILE: threadsFile });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const result = await h.runService.importHarnessThread({
      runtimeKind: "codex",
      threadId: fixture.inWorkspaceThreadId,
    });
    assert.equal(h.runService.forTask(result.taskId).length, 2, "both fixture turns imported");

    // The user keeps working in codex: the native thread grows a turn.
    growCodexThread(threadsFile, fixture.inWorkspaceThreadId, [
      {
        id: "turn-3",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "one more thing" }] },
          { type: "agentMessage", text: "Done with the extra thing." },
        ],
      },
    ]);

    const sync = await h.runService.syncImportedThread(result.taskId);
    assert.equal(sync.appendedTurns, 1);
    assert.deepEqual(sync.disarmedHandoffIds, []);

    // Appended as one completed run carrying the native turn's user input,
    // sorted after the runs imported earlier.
    const runs = h.runService.forTask(result.taskId);
    assert.equal(runs.length, 3);
    assert.equal(runs[2].status, "completed");
    assert.equal(runs[2].userPrompt, "one more thing");
    assert.equal(runs[2].runtimeSessionRefId, result.runtimeSessionRefId, "synced turns belong to the same native session");
    assert.ok(runs[2].createdAt >= runs[1].createdAt);
    assert.ok(
      (await h.runService.events(runs[2].id)).some((e) => e.type === "agent.message" && /extra thing/.test(String(e.data.content)))
    );
    // The adoption marker moved to the thread's new last-update time.
    const task = h.store.get<any>("tasks", result.taskId);
    assert.equal(task.metadata.threadUpdatedAt, new Date((1780002000 + 100) * 1000).toISOString());

    // Sync is idempotent: nothing new in the harness → nothing appended.
    const again = await h.runService.syncImportedThread(result.taskId);
    assert.equal(again.appendedTurns, 0);
    assert.equal(h.runService.forTask(result.taskId).length, 3);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("sync counts resumed turns as already present and disarms a stale armed handoff (v6 §8)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(wsRoot, "af-codex-ws-"));
  const fixture = makeCodexThreadsFixture(wsDir);
  const threadsFile = join(fx.dir, "codex-threads.json");
  writeFileSync(threadsFile, fixture.file);
  const restore = useBins(fx, {
    FAKE_CODEX_THREADS_FILE: threadsFile,
    FAKE_CODEX_DUMP: join(fx.dir, "codex-dump.jsonl"),
  });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const ws = await h.workspaces.create({ name: "login-bug", type: "local", path: wsDir });
    seedCodexSession(fx, fixture.inWorkspaceThreadId);
    const result = await h.runService.importHarnessThread({
      runtimeKind: "codex",
      threadId: fixture.inWorkspaceThreadId,
      workspaceId: ws.id,
    });

    // An AgentFabric resume appends its own turn to the native thread.
    const codex = runtimeOf(h, "codex");
    const resume = await h.runService.continueTask(result.taskId, { prompt: "add a regression test", runtimeId: codex.id });
    assert.equal(resume.continuity, "resume");
    const resumedRun = await waitForRun(h.runService, resume.run.id);
    assert.equal(resumedRun.status, "completed", resumedRun.error);

    // The native thread now holds the resume's turn plus one newer turn the
    // user added directly in codex. Only the newer one is new to the task.
    growCodexThread(threadsFile, fixture.inWorkspaceThreadId, [
      {
        id: "turn-resume",
        items: [{ type: "userMessage", content: [{ type: "text", text: "add a regression test" }] }],
      },
      {
        id: "turn-new",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "renamed the script" }] },
          { type: "agentMessage", text: "Renamed it." },
        ],
      },
    ]);

    // A handoff armed before the sync was generated from the stale
    // snapshot — the sync must disarm it instead of letting the next turn
    // consume outdated context.
    const armed = await h.runService.generateHandoff(result.taskId, undefined, { allowDegraded: true });
    assert.equal(armed.awaitingNextTurn, true);

    const sync = await h.runService.syncImportedThread(result.taskId);
    assert.equal(sync.appendedTurns, 1, "the resume's turn is accounted, only the newer turn is appended");
    assert.deepEqual(sync.disarmedHandoffIds, [armed.id]);
    assert.equal(h.store.get<any>("handoffs", armed.id).awaitingNextTurn, false);

    // 2 imported + 1 resume + 1 synced, in order.
    const runs = h.runService.forTask(result.taskId);
    assert.equal(runs.length, 4);
    assert.equal(runs[3].userPrompt, "renamed the script");
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("sync refuses tasks that never adopted a native session", async () => {
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const plain = await h.store.insert<any>("tasks", {
      id: "task_plain",
      title: "plain",
      prompt: "p",
      createdAt: new Date().toISOString(),
    });
    await assert.rejects(h.runService.syncImportedThread(plain.id), /did not adopt a native session/);
    await assert.rejects(h.runService.syncImportedThread("task_missing"), /Task not found/);
  } finally {
    if (h) await quiesce(h);
  }
});

test("adoption imports the thread's cwd as a workspace when the caller names one (v6 §8)", async () => {
  const fx = makeFixtures();
  const wsDir = join(mkdtempSync(join(wsRoot, "af-codex-ws-")), "codex-work");
  mkdirSync(wsDir, { recursive: true });
  const fixture = makeCodexThreadsFixture(wsDir);
  const threadsFile = join(fx.dir, "codex-threads.json");
  writeFileSync(threadsFile, fixture.file);
  const restore = useBins(fx, { FAKE_CODEX_THREADS_FILE: threadsFile });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const result = await h.runService.importHarnessThread({
      runtimeKind: "codex",
      threadId: fixture.inWorkspaceThreadId,
      // The adoption form's "New workspace" path: the name is the caller's,
      // never the thread title (which is the work, not the directory).
      createWorkspaceName: "codex-work",
    });
    assert.ok(result.workspaceId);
    const ws = h.workspaces.get(result.workspaceId!);
    assert.equal(ws?.path, wsDir);
    assert.equal(ws?.source, "import");
    assert.equal(ws?.name, "codex-work");
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("adoption without a workspace choice associates nothing (v6 §8)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(wsRoot, "af-codex-ws-"));
  const fixture = makeCodexThreadsFixture(wsDir);
  const threadsFile = join(fx.dir, "codex-threads.json");
  writeFileSync(threadsFile, fixture.file);
  const restore = useBins(fx, { FAKE_CODEX_THREADS_FILE: threadsFile });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const result = await h.runService.importHarnessThread({
      runtimeKind: "codex",
      threadId: fixture.inWorkspaceThreadId,
    });
    assert.equal(result.workspaceId, undefined);
    assert.equal(h.workspaces.list().length, 0, "a session's cwd is not turned into a record on its own");
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});
