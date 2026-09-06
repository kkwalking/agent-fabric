/**
 * Tests for the pi-aligned compaction handoff generation
 * (core/compaction.ts): AgentFabric's assisted handoff content is
 * produced by the pi coding agent's context-compaction pipeline —
 * pi-style conversation serialization, verbatim pi prompts (initial +
 * iterative update), pi's token budget and failure checks, tracked file
 * operations appended as XML tags (accumulated across iterative
 * updates), pi's transient-error retry policy, and a
 * verbatim-checkpoint render.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMPACTION_SETTINGS,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  buildSummarizationPrompt,
  computeFileLists,
  createFileOps,
  extractFileOperations,
  formatFileOperations,
  generateCompactionHandoff,
  getSummarizationFailure,
  serializeRunConversation,
  type CompletionFn,
  type CompletionRequest,
} from "./compaction.js";
import { renderHandoffPrompt } from "./handoff.js";
import type { Handoff, Run, RunEvent, Task, Workspace } from "./types.js";
import { freshHarness, makeFixtures, useBins, waitForRun } from "./testkit.js";

let seq = 0;
function ev(type: RunEvent["type"], data: Record<string, unknown>): RunEvent {
  return {
    id: `evt_${++seq}`,
    runId: "run_test",
    seq,
    type,
    timestamp: new Date().toISOString(),
    data,
  };
}

const task = { id: "task_1", title: "Fix flaky login tests", prompt: "fix the three flaky tests in login.test.ts" } as Task;
const run = { id: "run_1", status: "completed", runtimeName: "opencode", usage: { modelRequests: 2 } } as unknown as Run;
const workspace = {
  id: "ws_1",
  name: "bruce-go",
  type: "local",
  path: "/Users/zhouzekun/code/bruce-go",
  persistent: true,
} as Workspace;

const CHECKPOINT = `## Goal
Fix the three flaky tests in packages/auth/tests/login.test.ts

## Constraints & Preferences
- Do not modify the existing API

## Progress
### Done
- [x] Added a retry wrapper around the OAuth mock

### In Progress
- [ ] Isolate the shared session store

### Blocked
- CI runner keeps timing out

## Key Decisions
- **Retry wrapper over bigger timeouts**: flakiness came from cold-start latency

## Next Steps
1. Finish the session store isolation
2. Re-run the suite

## Critical Context
- Failing test: "login › handles concurrent refresh"`;

function fakeCompletion(
  text: string,
  log?: CompletionRequest[],
  stopReason: "stop" | "length" = "stop"
): CompletionFn {
  return async (req) => {
    log?.push(req);
    return { text, stopReason, usage: { inputTokens: 10, outputTokens: 20 } };
  };
}

/* ------------------------------------------------------------------ */
/* serializeRunConversation (pi: serializeConversation)                */
/* ------------------------------------------------------------------ */

test("serializeRunConversation emits pi transcript labels", () => {
  const text = serializeRunConversation([
    ev("agent.message", { role: "user", content: "please fix the tests" }),
    ev("agent.thinking", { content: "listing files first" }),
    ev("agent.message", { role: "assistant", content: "I will start by reading the test file." }),
    ev("tool.started", { tool: "read_file", input: { path: "login.test.ts" } }),
    ev("tool.completed", { tool: "read_file", path: "login.test.ts", output: "test 1\nok" }),
  ]);
  assert.match(text, /\[User\]: please fix the tests/);
  assert.match(text, /\[Assistant thinking\]: listing files first/);
  assert.match(text, /\[Assistant\]: I will start by reading the test file\./);
  assert.match(text, /\[Assistant tool calls\]: read_file\(path="login\.test\.ts"\)/);
  assert.match(text, /\[Tool result\]: test 1\nok/);
  // One tool call serializes once: the completion closes the started
  // call instead of re-rendering it (pi renders one toolCall block).
  assert.equal(text.split("[Assistant tool calls]:").length - 1, 1);
  // pi separates parts with a blank line, never reorders them.
  const userIdx = text.indexOf("[User]:");
  const thinkIdx = text.indexOf("[Assistant thinking]:");
  const asstIdx = text.indexOf("[Assistant]:");
  const callIdx = text.indexOf("[Assistant tool calls]:");
  const resIdx = text.indexOf("[Tool result]:");
  assert.ok(userIdx < thinkIdx && thinkIdx < asstIdx && asstIdx < callIdx && callIdx < resIdx);
});

test("serializeRunConversation pairs started/completed calls by toolCallId (pi runtime shape)", () => {
  const text = serializeRunConversation([
    ev("tool.started", { tool: "edit", toolCallId: "c1", args: { path: "a.ts", old: "x", new: "y" } }),
    ev("tool.started", { tool: "edit", toolCallId: "c2", args: { path: "b.ts", old: "x", new: "y" } }),
    ev("tool.completed", { tool: "edit", toolCallId: "c1", result: "ok" }),
    ev("tool.completed", { tool: "edit", toolCallId: "c2", result: "ok" }),
  ]);
  assert.equal(text.split("[Assistant tool calls]:").length - 1, 1);
  assert.match(text, /\[Assistant tool calls\]: edit\(path="a\.ts", old="x", new="y"\); edit\(path="b\.ts", old="x", new="y"\)/);
  assert.match(text, /\[Tool result\]: ok\n\n\[Tool result\]: ok/);
});

test("serializeRunConversation joins consecutive thinking parts with newlines (pi)", () => {
  const text = serializeRunConversation([
    ev("agent.thinking", { content: "first" }),
    ev("agent.thinking", { content: "second" }),
    ev("agent.message", { role: "assistant", content: "done" }),
  ]);
  assert.match(text, /\[Assistant thinking\]: first\nsecond/);
  assert.equal(text.split("[Assistant thinking]:").length - 1, 1);
});

test("serializeRunConversation prepends the task prompt when no user message was echoed", () => {
  const text = serializeRunConversation(
    [ev("agent.message", { role: "assistant", content: "done" })],
    task
  );
  assert.match(text, new RegExp(`\\[User\\]: #${task.title}: ${task.prompt}`));
});

test("serializeRunConversation accumulates shell output and truncates tool results at 2000 chars (pi)", () => {
  const long = "x".repeat(3000);
  const text = serializeRunConversation([
    ev("shell.command", { command: "ls -la" }),
    ev("shell.output", { line: "README.md" }),
    ev("shell.output", { line: "src" }),
    ev("tool.completed", { tool: "bash", input: { command: "cat big.txt" }, output: long }),
  ]);
  assert.match(text, /\[Assistant tool calls\]: bash\(command="ls -la"\)/);
  assert.match(text, /\[Tool result\]: README\.md\nsrc/);
  const resultMatch = text.match(/\[Tool result\]: (x+)\n\n\[\.\.\. (\d+) more characters truncated\]/);
  assert.ok(resultMatch, "long tool result must carry pi's truncation marker");
  assert.equal(resultMatch[1].length, 2000);
  assert.equal(Number(resultMatch[2]), 1000);
});

test("serializeRunConversation excludes orchestrator log events (server-side noise)", () => {
  const text = serializeRunConversation([
    ev("agent.message", { role: "user", content: "fix the tests" }),
    ev("log", {
      line: "pi provider config injected: deepseek (models.json in /Users/zhouzekun/code/agent-fabric/packages/server/data/harness-state/rt_1)",
      kind: "config-injected",
    }),
    ev("log", { line: "opencode ignores unsupported model parameters: temperature", kind: "config-warning" }),
    ev("agent.message", { role: "assistant", content: "done" }),
  ]);
  // The transcript must not leak AgentFabric's own paths or config lines —
  // the summarizer mistook them for the project identity.
  assert.ok(!text.includes("agent-fabric"), "server-side paths must not reach the summary input");
  assert.ok(!text.includes("config injected"), "orchestrator bookkeeping is not conversation");
  assert.match(text, /\[User\]: fix the tests/);
  assert.match(text, /\[Assistant\]: done/);
});

/* ------------------------------------------------------------------ */
/* File operations (pi: compaction/utils.ts)                           */
/* ------------------------------------------------------------------ */

test("extractFileOperations + computeFileLists mirror pi read/modified semantics", () => {
  const ops = extractFileOperations([
    ev("tool.completed", { tool: "read", path: "a.ts" }),
    ev("tool.completed", { tool: "edit", path: "b.ts" }),
    ev("file.created", { path: "c.md" }),
    ev("file.modified", { path: "b.ts" }),
    ev("tool.completed", { tool: "write", path: "d.ts" }),
    ev("tool.completed", { tool: "read", path: "d.ts" }),
  ]);
  assert.deepEqual(computeFileLists(ops), {
    readFiles: ["a.ts"], // read-only: d.ts was also written, so not read-only
    modifiedFiles: ["b.ts", "c.md", "d.ts"], // edited ∪ written, sorted
  });
});

test("extractFileOperations seeds file lists from the previous checkpoint (pi prev-details merge)", () => {
  const previousSummary =
    "## Goal\nx\n\n<read-files>\nold.ts\n</read-files>\n\n<modified-files>\nmut.ts\n</modified-files>";
  const ops = extractFileOperations(
    [ev("tool.completed", { tool: "read", path: "new.ts" })],
    previousSummary
  );
  // read-files → read, modified-files → edited (pi: compaction.ts extractFileOperations)
  assert.deepEqual(computeFileLists(ops), {
    readFiles: ["new.ts", "old.ts"],
    modifiedFiles: ["mut.ts"],
  });
});

test("formatFileOperations renders pi XML tags", () => {
  const ops = createFileOps();
  ops.read.add("a.ts");
  ops.edited.add("b.ts");
  const { readFiles, modifiedFiles } = computeFileLists(ops);
  assert.equal(
    formatFileOperations(readFiles, modifiedFiles),
    "\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>"
  );
  assert.equal(formatFileOperations([], []), "");
});

/* ------------------------------------------------------------------ */
/* Prompt construction + failure checks (pi: verbatim)                 */
/* ------------------------------------------------------------------ */

test("buildSummarizationPrompt wraps conversation, previous summary and pi prompts", () => {
  const initial = buildSummarizationPrompt("CONV");
  assert.ok(initial.startsWith("<conversation>\nCONV\n</conversation>\n\n"));
  assert.ok(initial.endsWith(SUMMARIZATION_PROMPT));
  assert.ok(!initial.includes("<previous-summary>"));

  const update = buildSummarizationPrompt("CONV2", "PREV");
  assert.ok(update.includes("<conversation>\nCONV2\n</conversation>"));
  assert.ok(update.includes("<previous-summary>\nPREV\n</previous-summary>"));
  assert.ok(update.endsWith(UPDATE_SUMMARIZATION_PROMPT));

  const focused = buildSummarizationPrompt("CONV", undefined, "focus on the auth work");
  assert.ok(focused.endsWith("Additional focus: focus on the auth work"));
});

test("buildSummarizationPrompt states the workspace authoritatively (AgentFabric addition)", () => {
  const withWs = buildSummarizationPrompt("CONV", "PREV", undefined, workspace);
  const wsStart = withWs.indexOf("<workspace>");
  const convEnd = withWs.indexOf("</conversation>");
  const prevStart = withWs.indexOf("<previous-summary>");
  // Order: conversation → workspace → previous summary → pi prompt.
  assert.ok(wsStart > convEnd && wsStart < prevStart);
  assert.match(withWs, /<workspace>\nWorkspace "bruce-go" \(local\) at \/Users\/zhouzekun\/code\/bruce-go\./);
  assert.match(withWs, /it is the "current project" the user refers to\./);
  // No workspace attached → no block, prompts stay pi-verbatim.
  const withoutWs = buildSummarizationPrompt("CONV");
  assert.ok(!withoutWs.includes("<workspace>"));
});

test("getSummarizationFailure reproduces pi's error/length guards", () => {
  assert.equal(
    getSummarizationFailure({ text: "x", stopReason: "error", errorMessage: "boom" }, "Summarization"),
    "Summarization failed: boom"
  );
  assert.equal(
    getSummarizationFailure({ text: "x", stopReason: "length" }, "Summarization"),
    "Summarization failed: generation hit the token cap and the summary is incomplete"
  );
  assert.equal(getSummarizationFailure({ text: "x", stopReason: "stop" }, "Summarization"), undefined);
});

/* ------------------------------------------------------------------ */
/* generateCompactionHandoff                                           */
/* ------------------------------------------------------------------ */

test("generateCompactionHandoff produces a pi checkpoint mapped onto HandoffContent", async () => {
  const requests: CompletionRequest[] = [];
  const result = await generateCompactionHandoff({
    task,
    run,
    events: [
      ev("agent.message", { role: "user", content: "fix the tests" }),
      ev("agent.message", { role: "assistant", content: "starting" }),
      ev("file.modified", { path: "b.ts" }),
      ev("tool.completed", { tool: "read", path: "a.ts" }),
    ],
    artifacts: [],
    workspace,
    complete: fakeCompletion(CHECKPOINT, requests),
  });

  // The LLM call used pi's system prompt and budget: floor(0.8 × 16384).
  assert.equal(requests.length, 1);
  assert.equal(requests[0].systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
  assert.ok(requests[0].prompt.startsWith("<conversation>\n[User]: fix the tests"));
  assert.ok(requests[0].prompt.includes('<workspace>\nWorkspace "bruce-go" (local) at /Users/zhouzekun/code/bruce-go.'));
  assert.equal(requests[0].maxTokens, Math.floor(0.8 * DEFAULT_COMPACTION_SETTINGS.reserveTokens));

  // Summary = checkpoint + pi's file XML tags from tracked operations.
  assert.ok(result.summary.startsWith(CHECKPOINT));
  assert.ok(result.summary.includes("<read-files>\na.ts\n</read-files>"));
  assert.ok(result.summary.includes("<modified-files>\nb.ts\n</modified-files>"));

  const c = result.content;
  assert.equal(c.compactionSummary, result.summary);
  assert.ok(c.originalTask!.includes("Fix flaky login tests"));
  assert.deepEqual(c.completedWork, ["Added a retry wrapper around the OAuth mock"]);
  assert.deepEqual(c.userConstraints, ["Do not modify the existing API"]);
  assert.deepEqual(c.importantDecisions, ["**Retry wrapper over bigger timeouts**: flakiness came from cold-start latency"]);
  assert.deepEqual(c.relevantFiles, ["a.ts", "b.ts"]);
  assert.ok(c.remainingWork!.includes("[in progress] Isolate the shared session store"));
  assert.ok(c.remainingWork!.includes("[blocked] CI runner keeps timing out"));
  assert.ok(c.remainingWork!.includes("Finish the session store isolation"));
  assert.ok(c.notesForNextAgent!.includes("handles concurrent refresh"));
});

test("generateCompactionHandoff passes previousSummary through the pi update flow", async () => {
  const requests: CompletionRequest[] = [];
  await generateCompactionHandoff({
    task,
    run,
    events: [],
    artifacts: [],
    previousSummary: "PREV SUMMARY",
    complete: fakeCompletion(CHECKPOINT, requests),
  });
  assert.ok(requests[0].prompt.includes("<previous-summary>\nPREV SUMMARY\n</previous-summary>"));
  assert.ok(requests[0].prompt.endsWith(UPDATE_SUMMARIZATION_PROMPT));
});

test("generateCompactionHandoff accumulates file lists across iterative updates (pi)", async () => {
  const previousSummary =
    CHECKPOINT + "\n\n<read-files>\nold.ts\n</read-files>\n\n<modified-files>\nmut.ts\n</modified-files>";
  const result = await generateCompactionHandoff({
    task,
    run,
    events: [ev("file.modified", { path: "b.ts" })],
    artifacts: [],
    previousSummary,
    complete: fakeCompletion(CHECKPOINT),
  });
  // The new checkpoint's tags carry the previous run's files forward.
  assert.ok(result.summary.includes("<read-files>\nold.ts\n</read-files>"));
  assert.ok(result.summary.includes("<modified-files>\nb.ts\nmut.ts\n</modified-files>"));
  assert.deepEqual(result.content.relevantFiles, ["old.ts", "b.ts", "mut.ts"]);
});

test("generateCompactionHandoff retries transient summary errors with backoff (pi retryAssistantCall)", async () => {
  let calls = 0;
  const complete: CompletionFn = async () => {
    calls++;
    if (calls < 3) return { text: "", stopReason: "error", errorMessage: "HTTP 503: overloaded" };
    return { text: CHECKPOINT, stopReason: "stop" };
  };
  const result = await generateCompactionHandoff({
    task,
    run,
    events: [],
    artifacts: [],
    complete,
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
  });
  assert.equal(calls, 3);
  assert.ok(result.summary.startsWith("## Goal"));
});

test("generateCompactionHandoff fails fast on non-retryable errors (quota/billing)", async () => {
  let calls = 0;
  const complete: CompletionFn = async () => {
    calls++;
    return { text: "", stopReason: "error", errorMessage: "HTTP 402: insufficient_quota" };
  };
  await assert.rejects(
    generateCompactionHandoff({
      task,
      run,
      events: [],
      artifacts: [],
      complete,
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
    }),
    /insufficient_quota/
  );
  assert.equal(calls, 1, "deterministic quota errors must not be retried");
});

test("generateCompactionHandoff rejects incomplete summaries (pi failure checks)", async () => {
  await assert.rejects(
    generateCompactionHandoff({
      task,
      run,
      events: [],
      artifacts: [],
      complete: fakeCompletion("partial…", undefined, "length"),
    }),
    /token cap/
  );
  await assert.rejects(
    generateCompactionHandoff({
      task,
      run,
      events: [],
      artifacts: [],
      complete: async () => ({ text: "", stopReason: "stop" }),
    }),
    /empty summary/
  );
});

test("renderHandoffPrompt embeds the compaction checkpoint verbatim", () => {
  const handoff = {
    id: "hoff_1",
    taskId: "task_1",
    fromRunId: "run_1",
    fromRuntimeName: "OpenCode",
    toRuntimeName: "Pi Agent",
    source: "agentfabric",
    sources: ["agentfabric"],
    artifactIds: [],
    createdAt: new Date().toISOString(),
    content: {
      compactionSummary: CHECKPOINT + "\n\n<modified-files>\nb.ts\n</modified-files>",
      originalTask: "#mapped (not rendered when a checkpoint exists)",
      workspaceStatus: 'Workspace "bruce-go" (local) at /Users/zhouzekun/code/bruce-go.',
    },
  } as unknown as Handoff;
  const rendered = renderHandoffPrompt(handoff, "continue");
  assert.match(rendered, /## Context checkpoint\n/);
  assert.ok(rendered.includes(CHECKPOINT));
  assert.ok(rendered.includes("<modified-files>"));
  assert.ok(!rendered.includes("#mapped"), "mapped fields must not duplicate the checkpoint");
  assert.match(rendered, /# Your instruction\ncontinue/);
});

test("renderHandoffPrompt always states the workspace, even for checkpoints", () => {
  const base = {
    id: "hoff_1",
    taskId: "task_1",
    fromRunId: "run_1",
    source: "agentfabric",
    sources: ["agentfabric"],
    artifactIds: [],
    createdAt: new Date().toISOString(),
  };
  const checkpoint = renderHandoffPrompt(
    {
      ...base,
      content: {
        compactionSummary: CHECKPOINT,
        workspaceStatus: 'Workspace "bruce-go" (local) at /Users/zhouzekun/code/bruce-go.',
      },
    } as unknown as Handoff,
    "continue"
  );
  // The workspace section precedes the checkpoint and anchors every
  // relative path in it — the summarizer's own project naming is not
  // authoritative.
  assert.match(checkpoint, /# Workspace\nWorkspace "bruce-go" \(local\) at \/Users\/zhouzekun\/code\/bruce-go\./);
  assert.match(checkpoint, /current working directory/);
  assert.ok(checkpoint.indexOf("# Workspace") < checkpoint.indexOf("## Context checkpoint"));

  const heuristic = renderHandoffPrompt(
    { ...base, content: { originalTask: "task" } } as unknown as Handoff,
    "continue"
  );
  assert.match(heuristic, /# Workspace\nNo workspace was attached to the previous run\./);
});

/* ------------------------------------------------------------------ */
/* End-to-end through RunService (fake opencode harness)               */
/* ------------------------------------------------------------------ */

function opencodeRuntimeOf(h: Awaited<ReturnType<typeof freshHarness>>) {
  const rt = h.store.list("runtimes").find((r: any) => r.kind === "opencode");
  assert.ok(rt, "seeded opencode runtime must exist");
  return rt as { id: string; kind: string };
}

test("assisted handoff is generated by the compaction pipeline end-to-end", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const requests: CompletionRequest[] = [];
  const h = await freshHarness({
    completionFactory: () => fakeCompletion(CHECKPOINT, requests),
  });
  try {
    const oc = opencodeRuntimeOf(h);
    const first = await h.runService.submit({ prompt: "fix the flaky tests", runtimeId: oc.id });
    const finished = await waitForRun(h.runService, first.run.id);
    assert.equal(finished.status, "completed");
    // OpenCode declares no handoff generation → no harness handoff attached.
    assert.equal(finished.generatedHandoffId, undefined);

    // Force a handoff continuation (same harness, session exists).
    const cont = await h.runService.continueTask(first.task.id, {
      prompt: "继续修剩下的",
      runtimeId: oc.id,
      mode: "handoff",
    });
    assert.equal(cont.continuity, "handoff");
    assert.ok(cont.handoff);
    assert.ok(cont.handoff!.content.compactionSummary!.startsWith("## Goal"));
    assert.equal(cont.handoff!.source, "agentfabric");
    // The initial pi prompt was used (no previous summary for run #1).
    assert.ok(requests[requests.length - 1].prompt.endsWith(SUMMARIZATION_PROMPT));
    // The generation is observable on the summarized run's event log.
    const genEvt = h.runService
      .events(first.run.id)
      .find((e) => e.type === "handoff.generated");
    assert.equal(genEvt?.data?.method, "compaction");
    // The next harness receives the checkpoint verbatim in its instruction.
    assert.match(cont.run.inputInstruction!, /## Context checkpoint\n/);
    assert.ok(cont.run.inputInstruction!.includes(CHECKPOINT));
    assert.match(cont.run.inputInstruction!, /# Your instruction\n继续修剩下的/);
    await waitForRun(h.runService, cont.run.id);

    // Second forced hop: the new run consumed the first checkpoint, so
    // pi's iterative update flow kicks in (<previous-summary> + UPDATE).
    const cont2 = await h.runService.continueTask(first.task.id, {
      prompt: "收尾",
      runtimeId: oc.id,
      mode: "handoff",
    });
    assert.equal(cont2.continuity, "handoff");
    const lastReq = requests[requests.length - 1];
    assert.ok(lastReq.prompt.includes("<previous-summary>"));
    assert.ok(lastReq.prompt.includes("## Goal"));
    assert.ok(lastReq.prompt.endsWith(UPDATE_SUMMARIZATION_PROMPT));
    await waitForRun(h.runService, cont2.run.id);
  } finally {
    restore();
  }
});

test("compaction failure falls back to the heuristic generator, handoff still exists", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const h = await freshHarness({
    completionFactory: () => async () => ({
      text: "",
      stopReason: "error",
      // Non-retryable auth failure — retries (pi settings.retry) must not kick in.
      errorMessage: "HTTP 401: invalid api key",
    }),
  });
  try {
    const oc = opencodeRuntimeOf(h);
    const first = await h.runService.submit({ prompt: "fix the flaky tests", runtimeId: oc.id });
    await waitForRun(h.runService, first.run.id);

    const cont = await h.runService.continueTask(first.task.id, {
      prompt: "继续",
      runtimeId: oc.id,
      mode: "handoff",
    });
    assert.equal(cont.continuity, "handoff");
    assert.ok(cont.handoff);
    assert.equal(cont.handoff!.content.compactionSummary, undefined);
    assert.match(cont.handoff!.content.notesForNextAgent!, /assembled by AgentFabric/);
    const genEvt = h.runService
      .events(first.run.id)
      .find((e) => e.type === "handoff.generated");
    assert.equal(genEvt?.data?.method, "heuristic");
    assert.match(String(genEvt?.data?.detail ?? ""), /invalid api key/);
    // Structured (non-checkpoint) handoffs still render section-by-section.
    assert.match(cont.run.inputInstruction!, /## Original task/);
    await waitForRun(h.runService, cont.run.id);
  } finally {
    restore();
  }
});
