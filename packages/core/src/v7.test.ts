/**
 * Tests for the v7 spec (v7.md): Claude Code Local harness + cross-harness
 * continuity through Claude Code.
 *
 * - §1/§2: Claude Code Local runs on the machine's own `claude` CLI with
 *   its Claude.ai login; auth is *detected* (installed/logged in/usable),
 *   never copied or converted into a Provider.
 * - §3: harness-native runtimes never bind an AgentFabric Model.
 * - §4/§5: non-interactive execution through stream-json; the native
 *   session (RuntimeSessionRef, runtimeKind claude-code, local backend,
 *   resumable) is captured from the protocol.
 * - §6: Claude Code → Claude Code continues by native resume
 *   (`--resume <session-id>`).
 * - §7/§8: protocol events map onto the standard event set; harness-
 *   reported usage lands on the Run (harness-reported cost only — never
 *   an Anthropic-pricing estimate of a subscription run).
 * - §9/§10: local session discovery + read through the transcript store,
 *   confined to the adapter layer.
 * - §11: import/adopt an existing session → workspace association,
 *   per-turn runs, session ref, handoff toward another harness.
 * - §13/§14: quota exhaustion is classified (`errorKind: "usage-limit"`)
 *   as a switch-harness scenario; other harnesses → Claude Code handoff.
 * - §18: containerized Claude Code is refused.
 * - §20: acceptance scenarios A–D.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshHarness,
  makeClaudeSessionsFixture,
  makeFixtures,
  useBins,
  waitForRun,
  type Fixtures,
  type Harness,
} from "./testkit.js";
import { claudeCodeAuthStatus, detectClaudeUsageLimit } from "../../runtimes/src/claudecode.js";
import { encodeClaudeProjectDir } from "../../runtimes/src/claudeCodeThreads.js";
import type { CompletionFactory } from "./orchestrator.js";

/** Fails summarization instantly so handoffs take the explicitly-degraded digest path. */
const offlineCompletion: CompletionFactory = () =>
  async () => ({ text: "", stopReason: "error" as const, errorMessage: "test: offline" });

function runtimeOf(h: Harness, kind: string) {
  const rt = h.store.list<any>("runtimes").find((r) => r.kind === kind);
  assert.ok(rt, `seeded ${kind} runtime must exist`);
  return rt;
}

function claudeInvocations(fx: Fixtures): Array<{ harness: string; argv: string[]; cwd: string }> {
  const dump = join(fx.dir, "claude-dump.jsonl");
  if (!existsSync(dump)) return [];
  return readFileSync(dump, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Cancels any still-executing run before the env fixture is restored. A
 * failed assertion can leave a background run in flight; without this it
 * would respawn the harness *after* AGENTFABRIC_CLAUDE_BIN was restored —
 * i.e. against the user's real Claude Code login. Never let that escape.
 */
async function quiesce(h: Harness): Promise<void> {
  for (const r of h.runService.list()) {
    if (["pending", "starting", "running"].includes(r.status)) {
      await h.runService.cancel(r.id).catch(() => {});
    }
  }
  await new Promise((r) => setTimeout(r, 200));
}

/* ------------------------------------------------------------------ */
/* §2 / §14 units                                                      */
/* ------------------------------------------------------------------ */

test("detectClaudeUsageLimit matches the canonical CLI quota strings (v7 §14)", () => {
  assert.equal(detectClaudeUsageLimit("Claude usage limit reached"), true);
  assert.equal(detectClaudeUsageLimit("You've hit your usage limit and it resets at 5pm"), true);
  assert.equal(detectClaudeUsageLimit("usage limit reached · Resets 11pm"), true);
  assert.equal(detectClaudeUsageLimit("API Error: usage_limit_reached"), true);
  assert.equal(detectClaudeUsageLimit("You've reached your weekly limit"), true);
  assert.equal(detectClaudeUsageLimit("npm ERR! command failed"), false);
  assert.equal(detectClaudeUsageLimit("ENOENT: no such file"), false);
  assert.equal(detectClaudeUsageLimit(undefined), false);
});

test("harness-native auth is detected through claude's own surfaces (v7 §2)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  try {
    const ok = await claudeCodeAuthStatus(fx.fakeClaude);
    assert.equal(ok.installed, true);
    assert.equal(ok.loggedIn, true);
    assert.equal(ok.ok, true);
    assert.match(ok.detail ?? "", /Claude\.ai/);
    assert.match(ok.version ?? "", /Claude Code/);

    process.env.FAKE_CLAUDE_LOGGED_OUT = "1";
    const out = await claudeCodeAuthStatus(fx.fakeClaude);
    assert.equal(out.installed, true);
    assert.equal(out.loggedIn, false);
    assert.equal(out.ok, false);
    assert.match(out.hint ?? "", /claude login/);
  } finally {
    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
    restore();
  }
});

test("project dirs are encoded the way Claude Code names them (v7 §9)", () => {
  assert.equal(encodeClaudeProjectDir("/Users/foo/bar.baz"), "-Users-foo-bar-baz");
  assert.equal(encodeClaudeProjectDir("/private/tmp/af-claude-probe"), "-private-tmp-af-claude-probe");
});

/* ------------------------------------------------------------------ */
/* §20 Scenario A: AgentFabric starts Claude Code                      */
/* ------------------------------------------------------------------ */

test("scenario A: claude-code run needs no provider/model, captures the session id and native-resumes (v7 §1/§3/§4/§5/§6/§8/§20A)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { FAKE_CLAUDE_DUMP: join(fx.dir, "claude-dump.jsonl"), FAKE_CLAUDE_SCENARIO: "tools" });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const claude = runtimeOf(h, "claude-code");
    assert.equal(claude.credentialSource, "harness-native");

    // §3: even with AgentFabric models configured, the run binds none.
    assert.ok(h.store.list("models").length > 0, "seeded models exist");
    const { task, run } = await h.runService.submit({
      prompt: "fix the flaky test",
      runtimeId: claude.id,
      workspaceId: (await h.workspaces.create({ name: "ws-a", type: "local", path: join(fx.dir, "ws-a") })).id,
    });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "completed", finished.error);
    assert.equal(finished.modelId, undefined);
    assert.equal(finished.providerId, undefined);
    assert.equal(finished.errorKind, undefined);

    // §5: the Claude session id became the native session reference.
    const refs = h.runtimeSessions.list({ taskId: task.id });
    assert.equal(refs.length, 1);
    const ref = refs[0];
    assert.equal(ref.runtimeKind, "claude-code");
    assert.match(ref.nativeSessionRef, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(ref.resumeSupported, true);
    assert.equal(ref.executionBackend, "local");

    // §7: events were parsed from the stream-json protocol.
    const events = await h.runService.events(run.id);
    assert.ok(events.some((e) => e.type === "agent.message" && String(e.data.content).includes("tests pass")));
    assert.ok(events.some((e) => e.type === "agent.thinking"));
    assert.ok(events.some((e) => e.type === "shell.command" && e.data.command === "npm test"));
    assert.ok(events.some((e) => e.type === "shell.output" && String(e.data.output).includes("3 passing")));
    assert.ok(events.some((e) => e.type === "file.modified" && e.data.path === "src/a.ts"));
    assert.ok(events.some((e) => e.type === "tool.started" && e.data.tool === "Read"));
    assert.ok(events.some((e) => e.type === "tool.completed" && e.data.tool === "Read"));

    // §8: harness-reported usage reached the run record — cost is the
    // harness's own number, never an AgentFabric estimate (no
    // Anthropic-pricing guess for a subscription run).
    assert.equal(finished.usage?.inputTokens, 900);
    assert.equal(finished.usage?.outputTokens, 60);
    assert.equal(finished.usage?.cachedTokens, 160);
    assert.equal(finished.usage?.modelRequests, 1);
    assert.equal(finished.cost, 0.12);

    // §4: the invocation was non-interactive stream-json (the dump also
    // contains the --version / auth-status probes).
    const runInvocations = claudeInvocations(fx).filter((c) => c.argv.includes("-p"));
    const first = runInvocations[0];
    assert.ok(first, "run invocation recorded");
    assert.ok(first.argv.includes("--output-format"));
    assert.ok(first.argv.includes("stream-json"));

    // §6/§20A: Claude Code → Claude Code continues by native resume with
    // the session id.
    const cont = await h.runService.continueTask(task.id, { prompt: "re-run the suite" });
    assert.equal(cont.continuity, "resume");
    assert.equal(cont.runtimeSessionRef?.nativeSessionRef, ref.nativeSessionRef);
    const resumed = await waitForRun(h.runService, cont.run.id);
    assert.equal(resumed.status, "completed", resumed.error);

    const resumeInvocations = claudeInvocations(fx).filter((c) => c.argv.includes("--resume"));
    assert.equal(resumeInvocations.length, 1);
    assert.equal(resumeInvocations[0].argv[resumeInvocations[0].argv.indexOf("--resume") + 1], ref.nativeSessionRef);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §14 / §20 Scenario C: quota exhaustion → switch harness             */
/* ------------------------------------------------------------------ */

test("scenario C: claude quota exhaustion is usage-limit, then hands off to Pi (v7 §14/§20C)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { FAKE_CLAUDE_DUMP: join(fx.dir, "claude-dump.jsonl"), FAKE_CLAUDE_SCENARIO: "usage-limit" });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const claude = runtimeOf(h, "claude-code");
    const ws = await h.workspaces.create({ name: "ws-c", type: "local", path: join(fx.dir, "ws-c") });
    const { task, run } = await h.runService.submit({ prompt: "keep working", runtimeId: claude.id, workspaceId: ws.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorKind, "usage-limit", `error was: ${finished.error}`);
    assert.match(finished.error ?? "", /usage limit/i);
    // The failure event carries the classification for the Task page.
    const failed = (await h.runService.events(run.id)).find((e) => e.type === "run.failed");
    assert.equal(failed?.data?.errorKind, "usage-limit");

    // The workspace stays and the session context is readable — switch to Pi.
    const pi = runtimeOf(h, "pi");
    const cont = await h.runService.continueTask(task.id, { prompt: "continue on pi", runtimeId: pi.id, mode: "handoff", allowDegradedHandoff: true });
    assert.equal(cont.continuity, "handoff");
    assert.ok(cont.handoff);
    assert.equal(cont.handoff?.fromRuntimeKind, "claude-code");
    assert.equal(cont.handoff?.toRuntimeKind, "pi");
    assert.match(cont.run.inputInstruction ?? "", /Handoff from/);
    const done = await waitForRun(h.runService, cont.run.id);
    assert.equal(done.status, "completed", done.error);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §2 / §18 guards                                                     */
/* ------------------------------------------------------------------ */

test("missing claude login fails fast with the fix, not a harness error (v7 §2)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { FAKE_CLAUDE_LOGGED_OUT: "1" });
  let h: Harness | undefined;
  try {
    h = await freshHarness();
    const claude = runtimeOf(h, "claude-code");
    const { run } = await h.runService.submit({ prompt: "do something", runtimeId: claude.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.error ?? "", /claude login/);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("containerized claude code is refused — local execution only (v7 §18)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  let h: Harness | undefined;
  try {
    h = await freshHarness();
    const claude = runtimeOf(h, "claude-code");
    await h.runtimes.update(claude.id, { containerized: true });
    const { run } = await h.runService.submit({ prompt: "try docker", runtimeId: claude.id });
    const finished = await waitForRun(h.runService, run.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.error ?? "", /Containerized Claude Code refused/i);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §9/§10: discovery + read                                            */
/* ------------------------------------------------------------------ */

test("local claude sessions are discovered by cwd and recency (v7 §9)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(tmpdir(), "af-claude-ws-"));
  makeClaudeSessionsFixture(wsDir, fx.claudeProjects);
  const restore = useBins(fx);
  let h: Harness | undefined;
  try {
    h = await freshHarness();

    const all = await h.runService.listHarnessThreads("claude-code");
    assert.equal(all.length, 3);
    assert.equal(all[0].id.includes("11111111"), true, "newest first");
    assert.equal(all[0].title, "Fix the login bug");
    assert.equal(all[0].cwd, wsDir);
    assert.equal(all[0].model, "claude-sonnet-5");

    const scoped = await h.runService.listHarnessThreads("claude-code", { cwd: wsDir });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].id.includes("11111111"), true);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("a transcript without a cwd never gets a guessed path (v7 §9/§10)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(tmpdir(), "af-claude-ws-"));
  const fixture = makeClaudeSessionsFixture(wsDir, fx.claudeProjects);
  const restore = useBins(fx);
  let h: Harness | undefined;
  try {
    h = await freshHarness();

    // Read path: no cwd line means no cwd — in particular not the decoded
    // project directory ("/Users/me/code/bruce/go"), which does not exist
    // and would land the adopted task on a silently unassociated workspace.
    const detail = await h.runService.readHarnessThread("claude-code", fixture.noCwdSessionId);
    assert.equal(detail.cwd, undefined);
    assert.ok(detail.items.some((i) => i.kind === "user-message"), "the conversation itself still reads");

    // Discovery reports the same absenteeism, so the list and adoption agree.
    const listed = (await h.runService.listHarnessThreads("claude-code")).find((t) => t.id === fixture.noCwdSessionId);
    assert.ok(listed, "a session without a cwd is still discoverable");
    assert.equal(listed.cwd, undefined);

    // Adoption: without a cwd there is nothing to associate — the task is
    // created, and no workspace record is invented for a guessed directory.
    const before = h.workspaces.list().length;
    const adopted = await h.runService.importHarnessThread({ runtimeKind: "claude-code", threadId: fixture.noCwdSessionId });
    assert.equal(adopted.workspaceId, undefined);
    assert.equal(h.workspaces.list().length, before);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("existing claude sessions are read without executing the model (v7 §10)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(tmpdir(), "af-claude-ws-"));
  const fixture = makeClaudeSessionsFixture(wsDir, fx.claudeProjects);
  const restore = useBins(fx);
  let h: Harness | undefined;
  try {
    h = await freshHarness();
    const detail = await h.runService.readHarnessThread("claude-code", fixture.inWorkspaceSessionId);
    assert.equal(detail.title, "Fix the login bug");
    assert.equal(detail.cwd, wsDir);
    // Synthetic plumbing (slash commands, attachments) never surfaces.
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
    assert.equal(command && command.kind === "command" ? command.command : undefined, "npm test");
    assert.equal(command && command.kind === "command" ? command.output : undefined, "1 failing");
    const fileChange = detail.items.find((i) => i.kind === "file-change");
    assert.equal(fileChange?.kind === "file-change" ? fileChange.path : undefined, "src/auth.ts");
    assert.equal(detail.turns?.length, 1);
    assert.equal(detail.turns?.[0].userText, "Please fix the login bug in auth.ts");
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §11 / §20 Scenario B: adopt existing Claude Code work               */
/* ------------------------------------------------------------------ */

test("scenario B: adopt an existing claude session, resume same-harness, then hand off to Pi (v7 §11/§20B)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(tmpdir(), "af-claude-ws-"));
  const fixture = makeClaudeSessionsFixture(wsDir, fx.claudeProjects);
  const restore = useBins(fx, { FAKE_CLAUDE_DUMP: join(fx.dir, "claude-dump.jsonl") });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const pi = runtimeOf(h, "pi");
    // The session's cwd already has an AgentFabric workspace. Adoption does
    // not guess that: the caller (the adoption form) resolves it and passes
    // the id, which is exactly what this models.
    const ws = await h.workspaces.create({ name: "login-bug", type: "local", path: wsDir });

    const result = await h.runService.importHarnessThread({
      runtimeKind: "claude-code",
      threadId: fixture.inWorkspaceSessionId,
      workspaceId: ws.id,
      targetRuntimeId: pi.id,
      userNotes: "watch the auth tests",
    });

    assert.equal(result.workspaceId, ws.id, "the workspace the caller chose is associated");
    assert.equal(h.workspaces.list().length, 1, "adoption did not create a second workspace for the same directory");
    assert.ok(result.handoffId, "handoff generated toward Pi during adoption");
    assert.ok(result.runtimeSessionRefId, "session registered as native session");

    // The task carries the adoption markers used by discovery (v7 §9).
    const task = h.store.get<any>("tasks", result.taskId);
    assert.equal(task.metadata.imported, true);
    assert.equal(task.metadata.importedThreadId, fixture.inWorkspaceSessionId);
    assert.equal(task.title, "Fix the login bug");

    // One completed run per session turn with the user's input recorded
    // as the bare prompt (v5 §5 rules apply to adopted work too).
    const runs = h.runService.forTask(result.taskId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].userPrompt, "Please fix the login bug in auth.ts");
    const events = await h.runService.events(runs[0].id);
    assert.ok(events.some((e) => e.type === "shell.command" && e.data.command === "npm test"));
    assert.ok(events.some((e) => e.type === "agent.message"));
    assert.ok(events.some((e) => e.type === "file.modified" && e.data.path === "src/auth.ts"));

    // Discovery now marks the session as already adopted (v7 §9).
    const listed = await h.runService.listHarnessThreads("claude-code", { cwd: wsDir });
    assert.equal(listed[0].adopted, true);
    assert.equal(listed[0].adoptedTaskId, result.taskId);

    // The adoption handoff exists up front with the user's notes folded in.
    const adoptionHandoff = h.store.get<any>("handoffs", result.handoffId!);
    assert.equal(adoptionHandoff.fromRuntimeKind, "claude-code");
    assert.equal(adoptionHandoff.toRuntimeKind, "pi");
    assert.match(adoptionHandoff.userNotes ?? "", /auth tests/);

    // Same harness → native resume of the adopted session (v7 §6): the
    // fake CLI finds the fixture transcript and continues it.
    const claude = runtimeOf(h, "claude-code");
    const resume = await h.runService.continueTask(result.taskId, { prompt: "add a regression test", runtimeId: claude.id });
    assert.equal(resume.continuity, "resume");
    assert.equal(resume.runtimeSessionRef?.nativeSessionRef, fixture.inWorkspaceSessionId);
    const resumedRun = await waitForRun(h.runService, resume.run.id);
    assert.equal(resumedRun.status, "completed", resumedRun.error);
    assert.ok(
      claudeInvocations(fx).some(
        (c) => c.argv.includes("--resume") && c.argv.includes(fixture.inWorkspaceSessionId)
      ),
      "claude --resume used the adopted session id"
    );

    // Different harness → handoff: the imported work crosses to Pi as a
    // semantic summary; Pi creates its own new native session.
    const cont = await h.runService.continueTask(result.taskId, { prompt: "continue on pi", runtimeId: pi.id, mode: "handoff", allowDegradedHandoff: true });
    assert.equal(cont.continuity, "handoff");
    assert.equal(cont.handoff?.fromRuntimeKind, "claude-code");
    assert.equal(cont.handoff?.toRuntimeKind, "pi");
    assert.equal(cont.run.workspaceId, ws.id, "workspace preserved across the handoff");
    assert.match(cont.run.inputInstruction ?? "", /Handoff from/);
    const done = await waitForRun(h.runService, cont.run.id);
    assert.equal(done.status, "completed", done.error);
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

test("adoption creates a workspace record only when the caller asks for one (v7 §11)", async () => {
  const fx = makeFixtures();
  const wsDir = mkdtempSync(join(tmpdir(), "af-claude-ws-"));
  const fixture = makeClaudeSessionsFixture(wsDir, fx.claudeProjects);
  const restore = useBins(fx);
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });

    // No workspace named → the history is adopted, nothing is imported.
    const bare = await h.runService.importHarnessThread({
      runtimeKind: "claude-code",
      threadId: fixture.inWorkspaceSessionId,
    });
    assert.equal(bare.workspaceId, undefined);
    assert.equal(h.workspaces.list().length, 0, "adoption never invents a workspace record");

    // Named → the directory is imported in place under that name.
    const named = await h.runService.importHarnessThread({
      runtimeKind: "claude-code",
      threadId: fixture.inWorkspaceSessionId,
      createWorkspaceName: "scratch-probe",
    });
    const ws = h.workspaces.get(named.workspaceId!);
    assert.equal(ws?.path, wsDir);
    assert.equal(ws?.name, "scratch-probe");
    assert.equal(ws?.source, "import");

    // A directory that no longer exists fails loudly — the caller asked for
    // this record by name, so silence would be a lie. (The fixture's
    // "elsewhere" session points at a path that is never created.)
    await assert.rejects(
      () =>
        h!.runService.importHarnessThread({
          runtimeKind: "claude-code",
          threadId: fixture.otherSessionId,
          createWorkspaceName: "gone",
        }),
      /Cannot import workspace/
    );
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* §13 / §20 Scenario D: other harness → Claude Code                   */
/* ------------------------------------------------------------------ */

test("scenario D: Pi hands off into a fresh Claude Code native session on the same workspace (v7 §13/§20D)", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx, { FAKE_CLAUDE_DUMP: join(fx.dir, "claude-dump.jsonl") });
  let h: Harness | undefined;
  try {
    h = await freshHarness({ completionFactory: offlineCompletion });
    const pi = runtimeOf(h, "pi");
    const claude = runtimeOf(h, "claude-code");
    const ws = await h.workspaces.create({ name: "ws-d", type: "local", path: join(fx.dir, "ws-d") });

    // Previous harness does some work first.
    const first = await h.runService.submit({ prompt: "start the refactor", runtimeId: pi.id, workspaceId: ws.id });
    const firstRun = await waitForRun(h.runService, first.run.id);
    assert.equal(firstRun.status, "completed", firstRun.error);

    // Switch to Claude Code: handoff, new native session, same workspace.
    const cont = await h.runService.continueTask(first.task.id, { prompt: "continue with claude", runtimeId: claude.id, mode: "handoff", allowDegradedHandoff: true });
    assert.equal(cont.continuity, "handoff");
    assert.ok(cont.handoff);
    assert.equal(cont.handoff?.fromRuntimeKind, "pi");
    assert.equal(cont.handoff?.toRuntimeKind, "claude-code");
    assert.equal(cont.run.workspaceId, ws.id, "workspace preserved");
    assert.match(cont.run.inputInstruction ?? "", /Handoff from/);
    const done = await waitForRun(h.runService, cont.run.id);
    assert.equal(done.status, "completed", done.error);

    // The target harness created its own new native session — no session
    // migration (v7 §13).
    const claudeRefs = h.runtimeSessions.list({ taskId: first.task.id, runtimeKind: "claude-code" });
    assert.equal(claudeRefs.length, 1);
    assert.equal(claudeRefs[0].executionBackend, "local");
    const invocation = claudeInvocations(fx)[0];
    assert.ok(!invocation.argv.includes("--resume"), "handoff starts a new session, never resumes Pi's");
  } finally {
    if (h) await quiesce(h);
    restore();
  }
});
