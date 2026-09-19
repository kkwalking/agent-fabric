/**
 * Tests for the checkpoint half of a handoff: the pi-aligned summarization
 * that covers the history a context bundle could NOT carry verbatim.
 *
 * Covered here: pi-style conversation serialization, verbatim pi prompts
 * (initial + iterative update), pi's failure checks, tracked file operations
 * appended as XML tags (accumulated across iterative updates), pi's
 * transient-error retry policy, and the checkpoint → HandoffContent
 * projection.
 *
 * The bundle itself — selection, pins, retained context, budget accounting and
 * rendering — is covered by `v8.test.ts`. Most tests here force a tiny handoff
 * budget (`FORCE_SUMMARY`) so the checkpoint path actually runs: with the real
 * 150K budget these small fixtures are carried verbatim and the model is never
 * called, which is the whole point of a context bundle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  buildSummarizationPrompt,
  checkpointOutputTokenCap,
  computeFileLists,
  createFileOps,
  createHttpCompletionFn,
  extractFileOperations,
  formatFileOperations,
  generateHandoffSummary,
  getSummarizationFailure,
  serializeRunChain,
  serializeRunConversation,
  extractCheckpoint,
  type CompletionFn,
  type CompletionRequest,
} from "./handoffSummary.js";
import { renderHandoffPrompt } from "./handoff.js";
import type { Handoff, Model, Provider, Run, RunEvent, Task, Workspace } from "./types.js";
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

/**
 * A handoff budget far smaller than any covered history in this file, so
 * selection leaves the whole history to the checkpoint. The metadata and
 * render scaffolding reserve alone exceeds it, which means nothing is retained
 * — exactly the summary-only situation these tests are about.
 */
const FORCE_SUMMARY = { contextWindow: 1_000_000, maxHandoffTokens: 600 };

/** Shrink the seeded model's window so a handoff cannot retain its history. */
async function forceSummarization(h: Awaited<ReturnType<typeof freshHarness>>): Promise<void> {
  const model = h.store.list<{ id: string; parameters?: Record<string, unknown> }>("models")[0];
  await h.store.update("models", model.id, {
    parameters: { ...(model.parameters ?? {}), contextWindow: 2_000 },
  });
}

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

test("serializeRunConversation accumulates shell output and truncates tool results at 2000 chars (summary input only)", () => {
  const long = "x".repeat(3000);
  const text = serializeRunConversation([
    ev("shell.command", { command: "ls -la" }),
    ev("shell.output", { line: "README.md" }),
    ev("shell.output", { line: "src" }),
    ev("tool.completed", { tool: "bash", input: { command: "cat big.txt" }, output: long }),
  ]);
  assert.match(text, /\[Assistant tool calls\]: bash\(command="ls -la"\)/);
  assert.match(text, /\[Tool result\]: README\.md\nsrc/);
  // The cap is bounded and marked; it keeps a head AND the tail (v9 §9), so it
  // is no longer a plain prefix.
  const resultMatch = text.match(
    /\[Tool result\]: (x+)\n\n\[\.\.\. (\d+) more characters truncated\]\n\n(x+)/
  );
  assert.ok(resultMatch, "long tool result must carry a middle truncation marker");
  const head = resultMatch[1].length;
  const tail = resultMatch[3].length;
  assert.ok(head > 0 && tail > 0, "both ends survive");
  assert.ok(tail > head, "the tail gets the larger share");
  assert.ok(head + tail < 3000, "the result is still reduced");
  assert.equal(Number(resultMatch[2]), 3000 - head - tail);
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
/* serializeRunChain (multi-run handoff coverage)                      */
/* ------------------------------------------------------------------ */

test("serializeRunChain renders every run's user prompt as one transcript", () => {
  const text = serializeRunChain(
    [
      { events: [ev("agent.message", { role: "assistant", content: "answer one" })], userPrompt: "question one" },
      { events: [ev("agent.message", { role: "assistant", content: "answer two" })], userPrompt: "question two" },
      { events: [ev("agent.message", { role: "assistant", content: "answer three" })], userPrompt: "question three" },
    ],
    task
  );
  const order = [
    "[User]: question one",
    "[Assistant]: answer one",
    "[User]: question two",
    "[Assistant]: answer two",
    "[User]: question three",
    "[Assistant]: answer three",
  ].map((needle) => text.indexOf(needle));
  assert.ok(order.every((i) => i >= 0), `all turns must be present:\n${text}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "turns must stay in run order");
});

test("serializeRunChain never doubles a user turn the run already echoed", () => {
  const text = serializeRunChain(
    [
      {
        events: [
          ev("agent.message", { role: "user", content: "only once" }),
          ev("agent.message", { role: "assistant", content: "ok" }),
        ],
        userPrompt: "only once",
      },
    ],
    task
  );
  assert.equal(text.split("[User]: only once").length - 1, 1);
});

test("serializeRunChain falls back to the task label for a first turn with no userPrompt", () => {
  const text = serializeRunChain(
    [{ events: [ev("agent.message", { role: "assistant", content: "done" })] }],
    task
  );
  assert.match(text, new RegExp(`\\[User\\]: #${task.title}: ${task.prompt}`));
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
/* generateHandoffSummary                                           */
/* ------------------------------------------------------------------ */

test("generateHandoffSummary produces a pi checkpoint mapped onto HandoffContent", async () => {
  const requests: CompletionRequest[] = [];
  const result = await generateHandoffSummary({
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
    settings: FORCE_SUMMARY,
  });

  // The LLM call used pi's system prompt and the CHECKPOINT output budget —
  // never the handoff budget (150K is not a summary output size).
  assert.equal(requests.length, 1);
  assert.equal(requests[0].systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
  assert.ok(requests[0].prompt.startsWith("<conversation>\n[User]: fix the tests"));
  assert.ok(requests[0].prompt.includes('<workspace>\nWorkspace "bruce-go" (local) at /Users/zhouzekun/code/bruce-go.'));
  assert.equal(requests[0].maxTokens, checkpointOutputTokenCap({ checkpointMaxTokens: 12_000 }));

  // Checkpoint = model answer + pi's file XML tags from tracked operations.
  assert.ok(result.checkpoint!.startsWith(CHECKPOINT));
  assert.ok(result.checkpoint!.includes("<read-files>\na.ts\n</read-files>"));
  assert.ok(result.checkpoint!.includes("<modified-files>\nb.ts\n</modified-files>"));
  assert.equal(result.contextBundle.checkpoint, result.checkpoint);

  const c = result.content;
  assert.equal(c.contextBundle!.checkpoint, result.checkpoint);
  assert.equal(c.contextBundle!.budget.maxTokens, 600);
  // The estimate counts every section of the body, so it is honest even when a
  // deliberately tiny budget cannot cover the render scaffolding itself.
  assert.ok(c.contextBundle!.budget.estimatedTokens > c.contextBundle!.budget.retainedTokens);
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

test("generateHandoffSummary passes previousSummary through the pi update flow", async () => {
  const requests: CompletionRequest[] = [];
  await generateHandoffSummary({
    task,
    run,
    events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
    artifacts: [],
    previousSummary: "PREV SUMMARY",
    complete: fakeCompletion(CHECKPOINT, requests),
    settings: FORCE_SUMMARY,
  });
  assert.ok(requests[0].prompt.includes("<previous-summary>\nPREV SUMMARY\n</previous-summary>"));
  assert.ok(requests[0].prompt.endsWith(UPDATE_SUMMARIZATION_PROMPT));
});

test("generateHandoffSummary accumulates file lists across iterative updates (pi)", async () => {
  const previousSummary =
    CHECKPOINT + "\n\n<read-files>\nold.ts\n</read-files>\n\n<modified-files>\nmut.ts\n</modified-files>";
  const result = await generateHandoffSummary({
    task,
    run,
    events: [ev("file.modified", { path: "b.ts" })],
    artifacts: [],
    previousSummary,
    complete: fakeCompletion(CHECKPOINT),
    settings: FORCE_SUMMARY,
  });
  // The new checkpoint's tags carry the previous run's files forward.
  assert.ok(result.checkpoint!.includes("<read-files>\nold.ts\n</read-files>"));
  assert.ok(result.checkpoint!.includes("<modified-files>\nb.ts\nmut.ts\n</modified-files>"));
  assert.deepEqual(result.content.relevantFiles, ["old.ts", "b.ts", "mut.ts"]);
});

test("extractCheckpoint drops the summarizer's chain-of-thought preamble", () => {
  const dirty = `Let me analyze this conversation carefully.\n\nThe conversation is very short.\n\nLet me write the structured summary.\n${CHECKPOINT}`;
  assert.ok(extractCheckpoint(dirty).startsWith("## Goal"));
  assert.ok(!extractCheckpoint(dirty).includes("Let me analyze"));
  // No `## ` section at all → nothing distinguishes reasoning from a
  // malformed summary, so it is kept unchanged.
  assert.equal(extractCheckpoint("just thinking out loud"), "just thinking out loud");
});

test("generateHandoffSummary refuses an answer that is not a checkpoint", async () => {
  // The model answered the transcript instead of summarizing it: prose that
  // would otherwise be stored as a "checkpoint" and handed to the next agent.
  await assert.rejects(
    () =>
      generateHandoffSummary({
        task,
        run,
        events: [ev("agent.message", { role: "assistant", content: "the old implementation summarizes everything" })],
        artifacts: [],
        complete: fakeCompletion("Sure — the project is a Go service with six HTTP endpoints."),
        settings: FORCE_SUMMARY,
      }),
    /did not return a checkpoint/
  );
});

test("extractCheckpoint keeps only the last of several drafts in one answer", () => {
  // The reported shape: a leaked reasoning draft, the model's commentary
  // on it, then the checkpoint it actually meant to produce.
  const final = CHECKPOINT.replace("Fix the three flaky tests", "Fix the two flaky tests");
  const dirty = [
    "Let me analyze this conversation.",
    CHECKPOINT,
    "I should keep it concise but preserve exact paths.",
    "Let me draft:",
    "## Goal",
    "草稿",
    "## Critical Context",
    "- 草稿",
    "That's comprehensive. Let me finalize.",
    final,
  ].join("\n");
  const clean = extractCheckpoint(dirty);
  assert.ok(clean.startsWith("## Goal"));
  assert.ok(clean.includes("Fix the two flaky tests"));
  for (const leak of ["Let me analyze", "I should keep it concise", "Let me draft", "草稿", "Let me finalize"]) {
    assert.ok(!clean.includes(leak), `leaked: ${leak}`);
  }
});

test("generateHandoffSummary stores and renders a preamble-free checkpoint", async () => {
  const dirty = `Let me analyze this conversation carefully.\n\nLet me write the structured summary.\n${CHECKPOINT}`;
  const result = await generateHandoffSummary({
    task,
    run,
    events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
    artifacts: [],
    complete: fakeCompletion(dirty),
    settings: FORCE_SUMMARY,
  });
  assert.ok(result.checkpoint!.startsWith("## Goal"));
  assert.ok(!result.checkpoint!.includes("Let me analyze"));
  assert.equal(result.content.contextBundle!.checkpoint, result.checkpoint);
});

test("parsed fields drop elaborated \"(none …)\" placeholder lines", async () => {
  const checkpoint = [
    "## Goal", "Answer the user's question.", "",
    "## Constraints & Preferences", "- (none explicitly stated by the user)", "",
    "## Progress", "### Done", "- [x] Answered.", "",
    "### In Progress", "- (none — this was a single informational Q&A)", "",
    "### Blocked", "- (none)", "",
    "## Key Decisions", "- (none)", "",
    "## Next Steps", "1. Await the user's next instruction.", "",
    "## Critical Context", "- (none)",
  ].join("\n");
  const result = await generateHandoffSummary({
    task,
    run,
    events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
    artifacts: [],
    complete: fakeCompletion(checkpoint),
    settings: FORCE_SUMMARY,
  });
  assert.equal(result.content.userConstraints, undefined);
  assert.equal(result.content.importantDecisions, undefined);
  assert.equal(result.content.notesForNextAgent, undefined);
  assert.deepEqual(result.content.remainingWork, ["Await the user's next instruction."]);
});

test("taskLabel does not repeat the prompt when the title defaults to it", async () => {
  const sameTask = { id: "task_1", title: "当前项目是什么语言写的", prompt: "当前项目是什么语言写的" } as Task;
  const result = await generateHandoffSummary({
    task: sameTask,
    run,
    events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
    artifacts: [],
    complete: fakeCompletion(CHECKPOINT),
    settings: FORCE_SUMMARY,
  });
  assert.equal(result.content.originalTask, "#当前项目是什么语言写的");
});

test("generateHandoffSummary retries transient summary errors with backoff (pi retryAssistantCall)", async () => {
  let calls = 0;
  const complete: CompletionFn = async () => {
    calls++;
    if (calls < 3) return { text: "", stopReason: "error", errorMessage: "HTTP 503: overloaded" };
    return { text: CHECKPOINT, stopReason: "stop" };
  };
  const result = await generateHandoffSummary({
    task,
    run,
    events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
    artifacts: [],
    complete,
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
    settings: FORCE_SUMMARY,
  });
  assert.equal(calls, 3);
  assert.ok(result.checkpoint!.startsWith("## Goal"));
});

test("generateHandoffSummary fails fast on non-retryable errors (quota/billing)", async () => {
  let calls = 0;
  const complete: CompletionFn = async () => {
    calls++;
    return { text: "", stopReason: "error", errorMessage: "HTTP 402: insufficient_quota" };
  };
  await assert.rejects(
    generateHandoffSummary({
      task,
      run,
      events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
      artifacts: [],
      complete,
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
      settings: FORCE_SUMMARY,
    }),
    /insufficient_quota/
  );
  assert.equal(calls, 1, "deterministic quota errors must not be retried");
});

test("generateHandoffSummary rejects incomplete summaries (pi failure checks)", async () => {
  await assert.rejects(
    generateHandoffSummary({
      task,
      run,
      events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
      artifacts: [],
      complete: fakeCompletion("partial…", undefined, "length"),
      settings: FORCE_SUMMARY,
    }),
    /token cap/
  );
  await assert.rejects(
    generateHandoffSummary({
      task,
      run,
      events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
      artifacts: [],
      complete: async () => ({ text: "", stopReason: "stop" }),
      settings: FORCE_SUMMARY,
    }),
    /empty summary/
  );
});

test("renderHandoffPrompt embeds the bundle's checkpoint verbatim", () => {
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
      contextBundle: {
        version: 2,
        checkpoint: CHECKPOINT + "\n\n<modified-files>\nb.ts\n</modified-files>",
        pinnedContext: [],
        retainedContext: [],
        budget: {
          contextWindow: 128_000,
          maxTokens: 19_200,
          estimatedTokens: 200,
          checkpointTokens: 200,
          pinnedTokens: 0,
          retainedTokens: 0,
          charsPerToken: 2,
        },
      },
      originalTask: "#mapped (not rendered when a checkpoint exists)",
      workspaceStatus: 'Workspace "bruce-go" (local) at /Users/zhouzekun/code/bruce-go.',
    },
  } as unknown as Handoff;
  const rendered = renderHandoffPrompt(handoff, "continue");
  // The checkpoint is a document of its own under its own section: its
  // `## Goal` … `## Critical Context` headings nest inside that section.
  assert.match(rendered, /# Historical checkpoint\n/);
  assert.ok(rendered.includes(CHECKPOINT));
  assert.ok(rendered.includes("<modified-files>"));
  assert.ok(!rendered.includes("#mapped"), "mapped fields must not duplicate the checkpoint");
  assert.match(rendered, /# Your instruction\ncontinue/);
});

test("renderHandoffPrompt embeds a stored checkpoint verbatim, without repairing it", () => {
  // Reads and renders are pure: the checkpoint is reduced to the model's
  // answer when the handoff is generated, and a stored record is never
  // re-parsed to compensate for an older generation (AGENTS.md: "No
  // compatibility logic for old data"). A wrong record is discarded and
  // regenerated instead.
  const stored = `Let me analyze this conversation carefully.\n${CHECKPOINT}`;
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
      contextBundle: {
        version: 2,
        checkpoint: stored,
        pinnedContext: [],
        retainedContext: [],
        budget: {
          contextWindow: 128_000,
          maxTokens: 19_200,
          estimatedTokens: 200,
          checkpointTokens: 200,
          pinnedTokens: 0,
          retainedTokens: 0,
          charsPerToken: 2,
        },
      },
      workspaceStatus: 'Workspace "bruce-go" (local) at /Users/zhouzekun/code/bruce-go.',
    },
  } as unknown as Handoff;
  const rendered = renderHandoffPrompt(handoff, "continue");
  assert.ok(rendered.includes(stored), "the stored checkpoint is the source of truth");
  assert.ok(rendered.includes(CHECKPOINT));
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
        contextBundle: {
          version: 2,
          checkpoint: CHECKPOINT,
          pinnedContext: [],
          retainedContext: [],
          budget: {
            contextWindow: 128_000,
            maxTokens: 19_200,
            estimatedTokens: 200,
            checkpointTokens: 200,
            pinnedTokens: 0,
            retainedTokens: 0,
            charsPerToken: 2,
          },
        },
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
  assert.ok(checkpoint.indexOf("# Workspace") < checkpoint.indexOf("## Goal"));

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

test("assisted handoff is generated by the context-bundle pipeline end-to-end", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const requests: CompletionRequest[] = [];
  const h = await freshHarness({
    completionFactory: () => fakeCompletion(CHECKPOINT, requests),
  });
  try {
    const oc = opencodeRuntimeOf(h);
    // Force the checkpoint path: this short history would otherwise be carried
    // verbatim (which is the point of the bundle — see v8.test.ts).
    await forceSummarization(h);
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
    assert.ok(cont.handoff!.content.contextBundle!.checkpoint!.startsWith("## Goal"));
    assert.equal(cont.handoff!.source, "agentfabric");
    // A model-written checkpoint, and the record says so (nothing to warn about).
    assert.equal(cont.handoff!.generation?.method, "context-bundle");
    assert.equal(cont.handoff!.generation?.chunks, 1);
    // The initial pi prompt was used (no previous summary for run #1).
    assert.ok(requests[requests.length - 1].prompt.endsWith(SUMMARIZATION_PROMPT));
    // The generation is observable on the summarized run's event log.
    const genEvt = (await h.runService.events(first.run.id))
      .find((e) => e.type === "handoff.generated");
    assert.equal(genEvt?.data?.method, "context-bundle");
    // The next harness receives the checkpoint verbatim in its instruction.
    assert.match(cont.run.inputInstruction!, /# Historical checkpoint\n/);
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

test("a failed summarization errors instead of silently degrading", async () => {
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
    await forceSummarization(h);
    const first = await h.runService.submit({ prompt: "fix the flaky tests", runtimeId: oc.id });
    await waitForRun(h.runService, first.run.id);

    await assert.rejects(
      () =>
        h.runService.continueTask(first.task.id, { prompt: "继续", runtimeId: oc.id, mode: "handoff" }),
      (err: any) => {
        assert.equal(err?.code, "handoff-unavailable");
        assert.match(String(err?.message ?? ""), /invalid api key/);
        return true;
      }
    );
    // Nothing was stored and no run was started — the caller decides.
    assert.equal(h.runService.forTask(first.task.id).length, 1);
    assert.equal(h.store.list("handoffs").length, 0);
  } finally {
    restore();
  }
});

test("an explicitly accepted degraded handoff is recorded as heuristic", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const h = await freshHarness({
    completionFactory: () => async () => ({
      text: "",
      stopReason: "error",
      errorMessage: "HTTP 401: invalid api key",
    }),
  });
  try {
    const oc = opencodeRuntimeOf(h);
    await forceSummarization(h);
    const first = await h.runService.submit({ prompt: "fix the flaky tests", runtimeId: oc.id });
    await waitForRun(h.runService, first.run.id);

    const cont = await h.runService.continueTask(first.task.id, {
      prompt: "继续",
      runtimeId: oc.id,
      mode: "handoff",
      allowDegradedHandoff: true,
    });
    assert.equal(cont.continuity, "handoff");
    assert.ok(cont.handoff);
    // The degraded state rides on the record, not just the event log.
    assert.equal(cont.handoff!.generation?.method, "heuristic");
    assert.match(cont.handoff!.generation?.detail ?? "", /invalid api key/);
    assert.equal(cont.handoff!.content.contextBundle, undefined);
    assert.match(cont.handoff!.content.notesForNextAgent!, /assembled by AgentFabric/);
    const genEvt = (await h.runService.events(first.run.id))
      .find((e) => e.type === "handoff.generated");
    assert.equal(genEvt?.data?.method, "heuristic");
    // Structured (non-checkpoint) handoffs still render section-by-section.
    assert.match(cont.run.inputInstruction!, /## Original task/);
    await waitForRun(h.runService, cont.run.id);
  } finally {
    restore();
  }
});

test("a long transcript is summarized in chunks, each updating the previous checkpoint", async () => {
  const requests: CompletionRequest[] = [];
  // Six turns, each far larger than the tiny budget below.
  const turns = Array.from({ length: 6 }, (_, i) => ({
    events: [
      ev("agent.message", { role: "assistant", content: `answer ${i} `.repeat(200) }),
      ...(i === 0 ? [ev("file.created", { path: "chunked.ts" })] : []),
    ],
    userPrompt: `question ${i}`,
  }));
  const result = await generateHandoffSummary({
    task,
    run,
    events: turns.flatMap((t) => t.events),
    turns,
    artifacts: [],
    complete: fakeCompletion(CHECKPOINT, requests),
    // (window − output − overhead, floored at 1000) × 1 char/token = 1000
    // characters per checkpoint call, and a handoff budget that retains
    // nothing: every turn is chunked on its own.
    settings: { maxHandoffTokens: 600, checkpointMaxTokens: 200, contextWindow: 1_000, charsPerToken: 1 },
  });

  assert.equal(result.chunks, 6, "one call per oversized turn");
  assert.equal(requests.length, 6);
  assert.ok(!requests[0].prompt.includes("<previous-summary>"), "the first chunk starts fresh");
  assert.ok(requests[1].prompt.includes("<previous-summary>"), "later chunks iterate");
  assert.ok(requests[5].prompt.endsWith(UPDATE_SUMMARIZATION_PROMPT));
  // File operations accumulate across the whole covered range.
  assert.match(result.checkpoint!, /<modified-files>\nchunked\.ts\n<\/modified-files>/);
  // The mapping still points at the final checkpoint.
  assert.equal(result.content.contextBundle!.checkpoint, result.checkpoint);
});

test("a small transcript stays a single summarization call", async () => {
  const requests: CompletionRequest[] = [];
  const result = await generateHandoffSummary({
    task,
    run,
    events: [ev("agent.message", { role: "assistant", content: "short" })],
    artifacts: [],
    complete: fakeCompletion(CHECKPOINT, requests),
    settings: FORCE_SUMMARY,
  });
  assert.equal(result.chunks, 1);
  assert.equal(requests.length, 1);
  assert.ok(!requests[0].prompt.includes("<previous-summary>"));
});

/* ------------------------------------------------------------------ */
/* Cancellation and the total generation budget                        */
/* ------------------------------------------------------------------ */

/** A completion that never resolves on its own — only when aborted. */
function hangingCompletion(onAbort: () => void): CompletionFn {
  return (req) =>
    new Promise((resolve) => {
      req.signal?.addEventListener("abort", () => {
        onAbort();
        resolve({ text: "", stopReason: "error" as const, errorMessage: "aborted" });
      });
    });
}

test("the total budget aborts a long generation instead of hanging", async () => {
  let aborted = false;
  await assert.rejects(
    () =>
      generateHandoffSummary({
        task,
        run,
        events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
        artifacts: [],
        complete: hangingCompletion(() => { aborted = true; }),
        settings: FORCE_SUMMARY,
        timeoutMs: 40,
      }),
    /budget/
  );
  assert.equal(aborted, true, "the in-flight summary call must receive the abort");
});

test("a caller abort cancels the generation and reports cancellation", async () => {
  const controller = new AbortController();
  let aborted = false;
  const pending = generateHandoffSummary({
    task,
    run,
    events: [ev("agent.message", { role: "assistant", content: "some work happened" })],
    artifacts: [],
    complete: hangingCompletion(() => { aborted = true; }),
    settings: FORCE_SUMMARY,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending, /cancelled/);
  assert.equal(aborted, true);
});

test("a cancelled continue never stores a degraded handoff", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  // Hangs until aborted, so the caller's signal is the only way out.
  const h = await freshHarness({
    completionFactory: () => hangingCompletion(() => {}),
  });
  try {
    const oc = opencodeRuntimeOf(h);
    await forceSummarization(h);
    const first = await h.runService.submit({ prompt: "fix the flaky tests", runtimeId: oc.id });
    await waitForRun(h.runService, first.run.id);

    const controller = new AbortController();
    const pending = h.runService.continueTask(
      first.task.id,
      { prompt: "继续", runtimeId: oc.id, mode: "handoff", allowDegradedHandoff: true },
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => pending,
      (err: any) => err?.code === "handoff-unavailable" && /cancelled/i.test(err.message)
    );
    // Even with degradation allowed, a gone caller gets no stored context.
    assert.equal(h.store.list("handoffs").length, 0);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* Handoff is explicit — never a side effect of sending a message      */
/* ------------------------------------------------------------------ */

test("sending a message never generates a handoff implicitly", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const requests: CompletionRequest[] = [];
  const h = await freshHarness({ completionFactory: () => fakeCompletion(CHECKPOINT, requests) });
  try {
    const oc = opencodeRuntimeOf(h);
    const pi = piRuntimeOf(h);
    const first = await h.runService.submit({ prompt: "fix the flaky tests", runtimeId: oc.id });
    await waitForRun(h.runService, first.run.id);

    const options = h.runService.continueOptions(first.task.id, pi.id);
    assert.equal(options.suggestedContinuity, "handoff");
    assert.equal(options.handoffAvailable, false, "nothing to consume yet");

    await assert.rejects(
      () => h.runService.continueTask(first.task.id, { prompt: "继续", runtimeId: pi.id }),
      (err: any) => err?.code === "handoff-required"
    );
    // The refusal happens before any model call or stored record.
    assert.equal(requests.length, 0, "no summarization may happen implicitly");
    assert.equal(h.store.list("handoffs").length, 0);
    assert.equal(h.runService.forTask(first.task.id).length, 1, "no run was created");
  } finally {
    restore();
  }
});

test("an explicit handoff is consumed by the continuation instead of regenerated", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const requests: CompletionRequest[] = [];
  const h = await freshHarness({ completionFactory: () => fakeCompletion(CHECKPOINT, requests) });
  try {
    const oc = opencodeRuntimeOf(h);
    const pi = piRuntimeOf(h);
    await forceSummarization(h);
    const first = await h.runService.submit({ prompt: "fix the flaky tests", runtimeId: oc.id });
    await waitForRun(h.runService, first.run.id);

    // The explicit action (the UI's confirmed handoff) generates it…
    const handoff = await h.runService.generateHandoff(first.task.id, pi.id);
    assert.equal(requests.length, 1);
    assert.equal(h.runService.continueOptions(first.task.id, pi.id).handoffAvailable, true);

    // …and the continuation only consumes it.
    const cont = await h.runService.continueTask(first.task.id, { prompt: "继续", runtimeId: pi.id });
    assert.equal(cont.continuity, "handoff");
    assert.equal(cont.handoff!.id, handoff.id, "reused, not regenerated");
    assert.equal(requests.length, 1, "no second summarization call");
    await waitForRun(h.runService, cont.run.id);
  } finally {
    restore();
  }
});



/* ------------------------------------------------------------------ */
/* Coverage across native-resume turns (the resume-chain fix)          */
/* ------------------------------------------------------------------ */

const secondRunId = (h: Awaited<ReturnType<typeof freshHarness>>, taskId: string) =>
  h.runService.forTask(taskId)[1].id;
const thirdRunId = (h: Awaited<ReturnType<typeof freshHarness>>, taskId: string) =>
  h.runService.forTask(taskId)[2].id;

function piRuntimeOf(h: Awaited<ReturnType<typeof freshHarness>>) {
  const rt = h.store.list("runtimes").find((r: any) => r.kind === "pi");
  assert.ok(rt, "seeded pi runtime must exist");
  return rt as { id: string };
}

test("a handoff records how it was produced and which runs it covers", async () => {
  // The audit trail. The same facts ride the record and the
  // `handoff.generated` event, so the handoff page and the task timeline
  // cannot describe one generation differently — and the event outlives the
  // record after a Discard.
  const fx = makeFixtures();
  const restore = useBins(fx);
  const requests: CompletionRequest[] = [];
  const h = await freshHarness({ completionFactory: () => fakeCompletion(CHECKPOINT, requests) });
  try {
    const oc = opencodeRuntimeOf(h);
    const pi = piRuntimeOf(h);
    await forceSummarization(h);
    const first = await h.runService.submit({ prompt: "MARKER_Q1", runtimeId: oc.id });
    await waitForRun(h.runService, first.run.id);
    // A native-resume turn in between: coverage must include it, even though
    // no handoff was involved in that turn.
    const second = await h.runService.continueTask(first.task.id, { prompt: "MARKER_Q2", runtimeId: oc.id });
    assert.equal(second.continuity, "resume");
    await waitForRun(h.runService, second.run.id);

    // Generating a handoff is explicit, so the continue asks for one rather
    // than expecting it to happen on its own (HandoffRequiredError otherwise).
    const cont = await h.runService.continueTask(first.task.id, {
      prompt: "继续",
      runtimeId: pi.id,
      mode: "handoff",
    });
    const g = cont.handoff!.generation!;
    assert.equal(g.method, "context-bundle");
    assert.equal(g.trigger, "continuation", "a handoff produced by a continue says so");
    assert.equal(g.chunks, 1);
    assert.deepEqual(g.coveredRunIds, [first.run.id, second.run.id], "coverage is recorded, oldest first");
    assert.ok(g.modelName, "the model that wrote the checkpoint is recorded");
    assert.ok(g.providerName);
    assert.equal(typeof g.durationMs, "number");
    assert.deepEqual(g.usage, { inputTokens: 10, outputTokens: 20 });

    // The timeline reads the event, which must carry the same facts.
    const evt = (await h.runService.events(second.run.id)).find((e) => e.type === "handoff.generated")!;
    assert.equal(evt.data.handoffId, cont.handoff!.id);
    assert.equal(evt.data.trigger, "continuation");
    assert.equal(evt.data.method, "context-bundle");
    assert.deepEqual(evt.data.coveredRunIds, [first.run.id, second.run.id]);
    assert.equal(evt.data.modelName, g.modelName);
    assert.equal(evt.data.providerName, g.providerName);
    assert.deepEqual(evt.data.usage, { inputTokens: 10, outputTokens: 20 });
    await waitForRun(h.runService, cont.run.id);
  } finally {
    restore();
  }
});

test("the standalone Handoff action records itself as the explicit trigger", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const requests: CompletionRequest[] = [];
  const h = await freshHarness({ completionFactory: () => fakeCompletion(CHECKPOINT, requests) });
  try {
    const pi = piRuntimeOf(h);
    await forceSummarization(h);
    const first = await h.runService.submit({ prompt: "fix the flaky tests", runtimeId: pi.id });
    await waitForRun(h.runService, first.run.id);

    // A pre-generation toward a harness is cached for it, not armed.
    const targeted = await h.runService.generateHandoff(first.task.id, pi.id);
    assert.equal(targeted.generation?.trigger, "targeted");
    assert.equal(targeted.awaitingNextTurn, undefined);
    assert.deepEqual(targeted.generation?.coveredRunIds, [first.run.id]);

    // The standalone action reuses that same summary (same runs, no second
    // model call) and arms it; the record still says why it *exists*.
    const explicit = await h.runService.generateHandoff(first.task.id);
    assert.equal(explicit.id, targeted.id, "no second summarization for the same runs");
    assert.equal(requests.length, 1);
    assert.equal(explicit.generation?.trigger, "targeted");
    assert.equal(explicit.awaitingNextTurn, true, "the standalone action arms it");
  } finally {
    restore();
  }
});

test("the continuation preview is stale until the previous run finished", async () => {
  // Documents why the *client* must never refuse to send based on its own
  // resume/handoff preview: taken while the run is still starting, the
  // preview has no native session ref to resume and reports "handoff",
  // while the very same continuation resumes once the run completes.
  const fx = makeFixtures();
  const restore = useBins(fx);
  const h = await freshHarness();
  try {
    const pi = piRuntimeOf(h);
    const first = await h.runService.submit({ prompt: "first turn", runtimeId: pi.id });
    const early = h.runService.continueOptions(first.task.id);
    if (h.runtimeSessions.list({ taskId: first.task.id }).length === 0) {
      assert.equal(
        early.suggestedContinuity,
        "handoff",
        "with no session ref yet the preview cannot see the resume"
      );
    }

    await waitForRun(h.runService, first.run.id);
    const late = h.runService.continueOptions(first.task.id);
    assert.equal(late.suggestedContinuity, "resume", "the finished run resumes natively");

    // The server, which sees the current state, resumes — no handoff is
    // needed, and none may be generated implicitly.
    const cont = await h.runService.continueTask(first.task.id, { prompt: "second turn", runtimeId: pi.id });
    assert.equal(cont.continuity, "resume");
    await waitForRun(h.runService, cont.run.id);
  } finally {
    restore();
  }
});

test("a handoff after native-resume turns covers every run, user prompts included", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const requests: CompletionRequest[] = [];
  const h = await freshHarness({ completionFactory: () => fakeCompletion(CHECKPOINT, requests) });
  try {
    const pi = piRuntimeOf(h);
    await forceSummarization(h);
    const first = await h.runService.submit({ prompt: "MARKER_Q1", runtimeId: pi.id });
    const run1 = await waitForRun(h.runService, first.run.id);
    const run1Text = (await h.runService.events(run1.id))
      .filter((e) => e.type === "agent.message")
      .map((e) => String(e.data?.content ?? ""))
      .join("\n");
    assert.ok(run1Text, "run 1 must have produced agent text");

    // Same harness → native resume; no handoff is created anywhere.
    const r2 = await h.runService.continueTask(first.task.id, { prompt: "MARKER_Q2", runtimeId: pi.id });
    assert.equal(r2.continuity, "resume");
    await waitForRun(h.runService, r2.run.id);

    // Switching away summarizes runs 1..2 — not just the latest run.
    const r3 = await h.runService.continueTask(first.task.id, {
      prompt: "MARKER_Q3",
      runtimeId: pi.id,
      mode: "handoff",
    });
    await waitForRun(h.runService, r3.run.id);

    const last = requests[requests.length - 1].prompt;
    assert.ok(last.includes("[User]: MARKER_Q1"), "run 1's request must be covered");
    assert.ok(last.includes("[User]: MARKER_Q2"), "run 2's request must be covered");
    assert.ok(last.includes(run1Text), "run 1's work must be covered");
    // No checkpoint existed before this summary, so nothing to iterate on.
    assert.ok(!last.includes("<previous-summary>"));
    // ...and the consuming harness receives the full checkpoint.
    assert.match(r3.run.inputInstruction!, /# Historical checkpoint\n/);
  } finally {
    restore();
  }
});

test("the iterative update resumes from the newest checkpoint even across resume turns", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const requests: CompletionRequest[] = [];
  const h = await freshHarness({ completionFactory: () => fakeCompletion(CHECKPOINT, requests) });
  try {
    const pi = piRuntimeOf(h);
    await forceSummarization(h);
    const first = await h.runService.submit({ prompt: "MARKER_Q1", runtimeId: pi.id });
    await waitForRun(h.runService, first.run.id);

    // run 2: forced handoff → checkpoint h1 covers run 1; run 2 consumes it.
    const r2 = await h.runService.continueTask(first.task.id, {
      prompt: "MARKER_Q2",
      runtimeId: pi.id,
      mode: "handoff",
    });
    assert.ok(r2.handoff!.content.contextBundle!.checkpoint);
    await waitForRun(h.runService, r2.run.id);

    // run 3: plain resume of run 2's native session (never touches a handoff).
    const r3 = await h.runService.continueTask(first.task.id, { prompt: "MARKER_Q3", runtimeId: pi.id });
    assert.equal(r3.continuity, "resume");
    await waitForRun(h.runService, r3.run.id);

    // run 4: handoff again → iterate from h1 and cover runs 2..3.
    const before = requests.length;
    const r4 = await h.runService.continueTask(first.task.id, {
      prompt: "MARKER_Q4",
      runtimeId: pi.id,
      mode: "handoff",
    });
    await waitForRun(h.runService, r4.run.id);

    // This generation's checkpoint calls (one per chunk of unretained history).
    const generation = requests.slice(before).map((r) => r.prompt);
    assert.deepEqual(
      r4.handoff!.generation!.coveredRunIds,
      [secondRunId(h, first.task.id), thirdRunId(h, first.task.id)],
      "coverage starts after the newest checkpoint"
    );
    const last = generation[generation.length - 1];
    assert.ok(last.includes("<previous-summary>"), "resume turns must not drop the checkpoint");
    assert.ok(
      last.includes("Added a retry wrapper around the OAuth mock"),
      "the previous checkpoint content is carried verbatim"
    );
    const covered = generation.join("\n");
    assert.ok(covered.includes("[User]: MARKER_Q2"), "the checkpoint's consuming run is re-covered");
    assert.ok(covered.includes("[User]: MARKER_Q3"), "the resume run is covered");
    // run 1 already lives inside the checkpoint — re-serializing it doubles it.
    assert.ok(!covered.includes("[User]: MARKER_Q1"), "already-checkpointed runs must not repeat");
    assert.ok(last.endsWith(UPDATE_SUMMARIZATION_PROMPT));
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* Wire formats: the answer, never the model's deliberation            */
/* ------------------------------------------------------------------ */

/** Serve one canned JSON body to the next `fetch` the client makes. */
async function withStubbedFetch<T>(body: unknown, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const responsesProvider = { id: "prov_1", name: "moark", type: "openai-responses", baseUrl: "https://api.example.com/v1", headers: {} } as Provider;
const responsesModel = { id: "mod_1", providerId: "prov_1", name: "deepseek-v4-flash-0731" } as Model;

test("openai-responses keeps the reasoning item out of the answer", async () => {
  // The shape that leaked: an interleaved `reasoning` item whose
  // `summary_text`/`reasoning_text` blocks hold the model's draft and its
  // "let me …" commentary, with the real checkpoint in a `message` item.
  const body = {
    status: "completed",
    output: [
      {
        type: "reasoning",
        status: "completed",
        content: [{ type: "summary_text", text: "Let me analyze this conversation.\n## Goal\nDRAFT GOAL\n## Critical Context\n- DRAFT" }],
      },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "## Goal\n" },
          { type: "output_text", text: "Fix the flaky tests" },
        ],
      },
      { type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: "I should keep it concise. Let me finalize." }] },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  const complete = createHttpCompletionFn(responsesProvider, responsesModel, "sk-test");
  const text = await withStubbedFetch(body, () => complete({ systemPrompt: "s", prompt: "p", maxTokens: 100 }));
  assert.equal(text.text, "## Goal\nFix the flaky tests");
  for (const leak of ["Let me analyze", "DRAFT", "I should keep it concise"]) {
    assert.ok(!text.text.includes(leak), `leaked: ${leak}`);
  }
  assert.equal(text.stopReason, "stop");
  assert.deepEqual(text.usage, { inputTokens: 10, outputTokens: 20 });
});

test("openai-completions ignores reasoning_content and reasoning content blocks", async () => {
  const provider = { id: "prov_2", name: "deepseek", type: "openai-completions", baseUrl: "https://api.example.com/v1", headers: {} } as Provider;
  const model = { id: "mod_2", providerId: "prov_2", name: "deepseek-reasoner" } as Model;
  const complete = createHttpCompletionFn(provider, model, "sk-test");

  const reasoningField = await withStubbedFetch(
    { choices: [{ message: { role: "assistant", reasoning_content: "SECRET THOUGHTS", content: "## Goal\nGood" }, finish_reason: "stop" }] },
    () => complete({ systemPrompt: "s", prompt: "p", maxTokens: 100 })
  );
  assert.equal(reasoningField.text, "## Goal\nGood");

  const blockForm = await withStubbedFetch(
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "SECRET THOUGHTS" },
              { type: "text", text: "## Goal\n" },
              { type: "text", text: "Good" },
            ],
          },
          finish_reason: "stop",
        },
      ],
    },
    () => complete({ systemPrompt: "s", prompt: "p", maxTokens: 100 })
  );
  assert.equal(blockForm.text, "## Goal\nGood");
});
