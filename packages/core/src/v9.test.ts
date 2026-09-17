/**
 * v9 — Handoff hardening.
 *
 * These tests cover the v9 acceptance checklist T1–T20 plus the one-shot
 * semantic fixture and the healthy-small-task regression example. They are
 * deterministic and offline: selection never calls a model, and the checkpoint
 * call is a fake completion.
 *
 * The hardening itself is about correctness, not architecture:
 *
 * - no-ID tool call/result pairing stays deterministic (never name-only);
 * - a PARTIALLY retained item is not treated as fully covered;
 * - the target harness's real context window can drive the handoff budget;
 * - every rendered section (including user notes) is inside the budget;
 * - the estimator is conservative for CJK;
 * - historical user instructions carry chronological supersession semantics;
 * - an oversized historical turn keeps its tail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TARGET_CONTEXT_WINDOW,
  collectHandoffContext,
  estimateTextTokens,
  estimateTokens,
  groupHandoffContextUnits,
  handoffTextCost,
  resolveHandoffBudget,
  selectHandoffContext,
  truncateForHandoffRetention,
  unretainedTurns,
  type HandoffContextSourceTurn,
} from "./handoffContext.js";
import {
  HandoffBudgetExceededError,
  generateHandoffSummary,
  serializeRunConversation,
  type CompletionFn,
  type CompletionRequest,
} from "./handoffSummary.js";
import { declaredRuntimeContextWindow } from "./orchestrator.js";
import { renderHandoffBody, renderHandoffPrompt } from "./handoff.js";
import type { Handoff, HandoffContent, Run, RunEvent, Runtime, Task, Workspace } from "./types.js";
import { freshHarness, makeFixtures, testCompletionFactory, useBins, waitForRun } from "./testkit.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

let seq = 0;
function ev(type: RunEvent["type"], data: Record<string, unknown> = {}, runId = "run_1"): RunEvent {
  return { id: `evt_${++seq}`, runId, seq, type, timestamp: new Date().toISOString(), data };
}

const task = {
  id: "task_1",
  title: "Improve the handoff implementation",
  prompt: "Improve the handoff implementation.",
} as Task;

const run = {
  id: "run_1",
  status: "completed",
  runtimeName: "OpenCode",
  usage: { modelRequests: 2, inputTokens: 100, outputTokens: 200 },
  cost: 0.01,
} as unknown as Run;

const workspace = {
  id: "ws_1",
  name: "agent-fabric",
  type: "local",
  path: "/Users/dev/agent-fabric",
  persistent: true,
} as Workspace;

const CHECKPOINT = `## Goal
Improve the AgentFabric handoff implementation.

## Next Steps
1. Continue the hardening work.`;

function fakeCompletion(text: string, log?: CompletionRequest[]): CompletionFn {
  return async (req) => {
    log?.push(req);
    return { text, stopReason: "stop", usage: { inputTokens: 10, outputTokens: 20 } };
  };
}

function handoffOf(content: HandoffContent, userNotes?: string): Handoff {
  return {
    id: "hoff_1",
    taskId: "task_1",
    fromRunId: "run_1",
    fromRuntimeName: "OpenCode",
    toRuntimeName: "Codex (ChatGPT)",
    source: "agentfabric",
    sources: ["agentfabric"],
    artifactIds: [],
    createdAt: new Date().toISOString(),
    content,
    ...(userNotes ? { userNotes } : {}),
  } as unknown as Handoff;
}

function selectFrom(
  turns: HandoffContextSourceTurn[],
  opts: {
    taskPrompt?: string;
    sharedWorkspace?: boolean;
    settings?: Parameters<typeof resolveHandoffBudget>[0];
    reservedChars?: number;
  } = {}
) {
  const budget = resolveHandoffBudget(opts.settings ?? {});
  const collected = collectHandoffContext(turns, {
    taskPrompt: opts.taskPrompt,
    sharedWorkspace: opts.sharedWorkspace ?? true,
  });
  const selection = selectHandoffContext({
    items: collected.items,
    budget,
    reservedChars: opts.reservedChars ?? 0,
  });
  return { budget, collected, selection };
}

const TEXT_OF = (slices: { text: string }[]) => slices.map((s) => s.text).join("\n");

/* ------------------------------------------------------------------ */
/* T1/T2/T3 — tool call / result pairing                               */
/* ------------------------------------------------------------------ */

test("T1 — a native call id pairs a call with its result", () => {
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      events: [
        ev("tool.started", { tool: "edit", toolCallId: "A", args: { path: "a.ts" } }),
        ev("tool.completed", { tool: "edit", toolCallId: "A", output: "ok a" }),
      ],
    },
  ];
  const { collected } = selectFrom(turns);
  const units = groupHandoffContextUnits(collected.items).filter((u) => u.kind === "tool");
  assert.equal(units.length, 1, "native id pairs into ONE logical interaction");
  assert.deepEqual(
    units[0].items.map((i) => i.kind),
    ["tool-call", "tool-result"]
  );
  assert.equal(units[0].items[1].text, "ok a");
});

test("T2 — no native IDs: call A ↔ result A and call B ↔ result B, never crossed", () => {
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      userPrompt: "read both files",
      events: [
        ev("tool.started", { tool: "read", args: { path: "a.ts" } }),
        ev("tool.started", { tool: "read", args: { path: "b.ts" } }),
        ev("tool.completed", { tool: "read", args: { path: "a.ts" }, output: "BODY A" }),
        ev("tool.completed", { tool: "read", args: { path: "b.ts" }, output: "BODY B" }),
      ],
    },
  ];
  const { collected, selection } = selectFrom(turns, { sharedWorkspace: false });
  const units = groupHandoffContextUnits(collected.items).filter((u) => u.kind === "tool");
  assert.equal(units.length, 2, "two calls, two units — no synthetic duplicate call");
  assert.deepEqual(
    units.map((u) => u.items.map((i) => i.text)),
    [
      ['read(path="a.ts")', "BODY A"],
      ['read(path="b.ts")', "BODY B"],
    ]
  );
  assert.deepEqual(
    selection.retained.filter((s) => s.kind === "tool-call").map((s) => s.text),
    ['read(path="a.ts")', 'read(path="b.ts")'],
    "the calls stay distinct"
  );
});

test("T2b — no native IDs and out-of-order results still pair by target", () => {
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      events: [
        ev("tool.started", { tool: "read", args: { path: "a.ts" } }),
        ev("tool.started", { tool: "read", args: { path: "b.ts" } }),
        ev("tool.completed", { tool: "read", args: { path: "b.ts" }, output: "BODY B" }),
        ev("tool.completed", { tool: "read", args: { path: "a.ts" }, output: "BODY A" }),
      ],
    },
  ];
  const { collected } = selectFrom(turns, { sharedWorkspace: false });
  const units = groupHandoffContextUnits(collected.items).filter((u) => u.kind === "tool");
  assert.deepEqual(
    units.map((u) => u.items.map((i) => i.text)),
    [
      ['read(path="a.ts")', "BODY A"],
      ['read(path="b.ts")', "BODY B"],
    ]
  );
});

test("T3 — repeated same-name tools without IDs never collide", () => {
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      events: [
        ev("tool.started", { tool: "read", args: { path: "foo" } }),
        ev("tool.started", { tool: "read", args: { path: "bar" } }),
        ev("tool.started", { tool: "read", args: { path: "baz" } }),
        ev("tool.completed", { tool: "read", args: { path: "foo" }, output: "R foo" }),
        ev("tool.completed", { tool: "read", args: { path: "bar" }, output: "R bar" }),
        ev("tool.completed", { tool: "read", args: { path: "baz" }, output: "R baz" }),
      ],
    },
  ];
  const { collected } = selectFrom(turns, { sharedWorkspace: false });
  const units = groupHandoffContextUnits(collected.items).filter((u) => u.kind === "tool");
  assert.equal(units.length, 3);
  assert.deepEqual(
    units.map((u) => u.items.map((i) => i.text)),
    [
      ['read(path="foo")', "R foo"],
      ['read(path="bar")', "R bar"],
      ['read(path="baz")', "R baz"],
    ]
  );
});

test("T3b — the summary serializer invents no duplicate call for no-ID repeats", () => {
  const text = serializeRunConversation([
    ev("tool.started", { tool: "read", args: { path: "a.ts" } }),
    ev("tool.started", { tool: "read", args: { path: "b.ts" } }),
    ev("tool.completed", { tool: "read", args: { path: "a.ts" }, output: "A" }),
    ev("tool.completed", { tool: "read", args: { path: "b.ts" }, output: "B" }),
  ]);
  // Both starts coalesce into ONE toolCalls part, and neither completion
  // re-renders a synthetic call.
  assert.equal(text.split("[Assistant tool calls]:").length - 1, 1);
  assert.match(text, /read\(path="a\.ts"\); read\(path="b\.ts"\)/);
  assert.equal(text.split("[Tool result]:").length - 1, 2);
});

test("a shell command and its output stay one logical interaction", () => {
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      events: [
        ev("shell.command", { command: "npm test" }),
        ev("shell.output", { line: "FAIL a.test.ts" }),
        ev("shell.output", { line: "1 failing" }),
      ],
    },
  ];
  const { collected, selection } = selectFrom(turns);
  const units = groupHandoffContextUnits(collected.items);
  assert.equal(units.length, 1);
  assert.equal(units[0].items.length, 2);
  assert.match(selection.retained[1].text, /FAIL a\.test\.ts/);
});

/* ------------------------------------------------------------------ */
/* T4–T6 — retention coverage semantics                                */
/* ------------------------------------------------------------------ */

function hugeToolTurn(tag: string): HandoffContextSourceTurn {
  const middle = `${tag} MIDDLE-${tag} ${"detail ".repeat(4_000)}`;
  const output = `${tag} HEAD\n${middle}\n${tag} TAIL-CRITICAL-DECISION: ${tag}`;
  return {
    runId: `run_${tag}`,
    events: [
      ev("tool.started", { tool: "bash", args: { command: `npm test -- ${tag}` } }, `run_${tag}`),
      ev("tool.completed", { tool: "bash", args: { command: `npm test -- ${tag}` }, output }, `run_${tag}`),
    ],
  };
}

test("T4 — a partially retained item still reaches the checkpoint source", async () => {
  const turns = [hugeToolTurn("PARTIAL")];
  const fixture = await runFixture(turns, {
    settings: { contextWindow: 1_000_000, maxHandoffTokens: 5_000, checkpointMaxTokens: 400 },
  });

  const partialId = [...fixture.result.selection.retentionByItemId.entries()].find(
    ([, cls]) => cls === "partial"
  )?.[0];
  assert.ok(partialId, "the oversized result was shortened (partial), not claimed as complete");
  const partialItem = fixture.collected.items.find((i) => i.id === partialId)!;
  for (const id of partialItem.eventIds) {
    assert.ok(
      !fixture.result.selection.excludedFromSummaryEventIds.has(id),
      "a partially retained event must stay in the checkpoint's input (v9 §4)"
    );
  }
  // The summarizer really saw the omitted middle.
  assert.ok(fixture.requests.length > 0);
  assert.ok(
    fixture.requests.some((r) => r.prompt.includes("MIDDLE-PARTIAL")),
    "the omitted middle must be eligible for checkpoint representation"
  );
});

test("T5 — a fully retained item is not redundantly summarized", async () => {
  const turns: HandoffContextSourceTurn[] = [
    // An older prefix that has to be summarized, so a call happens at all.
    ...Array.from({ length: 6 }, (_, i) => ({
      runId: `old_${i}`,
      userPrompt: `old ${i}`,
      events: [ev("agent.message", { role: "assistant" as const, content: `old work ${i}\n${"noise\n".repeat(400)}` }, `old_${i}`)],
    })),
    // The recent, fully retained frontier.
    {
      runId: "run_new",
      userPrompt: "keep this verbatim",
      events: [ev("agent.message", { role: "assistant", content: "FULLY-RETAINED-TEXT" }, "run_new")],
    },
  ];
  const fixture = await runFixture(turns, {
    // A small but realistic budget: the v10 render scaffolding (~2.2K tokens
    // of fixed trust/temporal prose) is part of the body, so the trajectory
    // needs room beyond it for anything to be retained at all — but the old
    // prefix must still NOT fit, or nothing gets summarized.
    settings: { contextWindow: 1_000_000, maxHandoffTokens: 6_000, checkpointMaxTokens: 400 },
  });
  assert.ok(fixture.requests.length > 0, "the old prefix was summarized");
  assert.ok(
    fixture.requests.every((r) => !r.prompt.includes("FULLY-RETAINED-TEXT")),
    "a fully retained item is excluded from the summarizer input"
  );
  assert.ok(TEXT_OF(fixture.result.selection.retained).includes("FULLY-RETAINED-TEXT"));
});

test("T6 — a reconstructable body may be fully excluded from the checkpoint", () => {
  const body = `import type { HandoffContent } from "./types.js";\n${"// implementation line\n".repeat(6_000)}`;
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      events: [
        ev("tool.started", { tool: "read", args: { path: "packages/core/src/foo.ts" } }),
        ev("tool.completed", { tool: "read", args: { path: "packages/core/src/foo.ts" }, output: body }),
      ],
    },
  ];
  const { collected, selection } = selectFrom(turns, { sharedWorkspace: true });
  const resultItem = collected.items.find((i) => i.kind === "tool-result")!;
  assert.equal(selection.retentionByItemId.get(resultItem.id), "reconstructable-omitted");
  for (const id of resultItem.eventIds) {
    assert.ok(selection.excludedFromSummaryEventIds.has(id), "reconstructable content needs no summary");
  }
  assert.match(TEXT_OF(selection.retained), /Re-read packages\/core\/src\/foo\.ts/);
  assert.ok(!TEXT_OF(selection.retained).includes("// implementation line"), "the body does not ship");
});

/* ------------------------------------------------------------------ */
/* T7–T9 — target harness capability                                   */
/* ------------------------------------------------------------------ */

/** Run generateHandoffSummary over a single-turn fixture, capturing requests. */
async function runFixture(
  turns: HandoffContextSourceTurn[],
  opts: {
    settings?: Parameters<typeof resolveHandoffBudget>[0];
    targetContextWindow?: number;
    modelContextWindow?: number;
    userNotes?: string;
    sharedWorkspace?: boolean;
    complete?: CompletionFn;
  } = {}
) {
  const requests: CompletionRequest[] = [];
  const events = turns.flatMap((t) => t.events);
  const inner = opts.complete ?? fakeCompletion(CHECKPOINT);
  const complete: CompletionFn = async (req) => {
    requests.push(req);
    return inner(req);
  };
  const result = await generateHandoffSummary({
    task,
    run,
    events,
    turns,
    artifacts: [],
    workspace: opts.sharedWorkspace === false ? undefined : workspace,
    targetContextWindow: opts.targetContextWindow,
    modelContextWindow: opts.modelContextWindow,
    ...(opts.userNotes ? { userNotes: opts.userNotes } : {}),
    complete,
    settings: opts.settings,
  });
  const collected = collectHandoffContext(turns, {
    taskPrompt: task.prompt,
    sharedWorkspace: opts.sharedWorkspace !== false,
  });
  return { result, requests, collected };
}

test("T7 — a declared 1M native harness target receives the 150K budget", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const h = await freshHarness({ completionFactory: () => testCompletionFactory() });
  try {
    const oc = h.store.list<Runtime>("runtimes").find((r) => r.kind === "opencode")!;
    const codex = h.store.list<Runtime>("runtimes").find((r) => r.kind === "codex")!;
    assert.equal(codex.credentialSource, "harness-native");
    // The operator declares the harness's real window (capability metadata).
    await h.runtimes.update(codex.id, { contextWindow: 1_000_000 });

    const first = await h.runService.submit({ prompt: "step one", runtimeId: oc.id });
    await waitForRun(h.runService, first.run.id);
    const handoff = await h.runService.generateHandoff(first.task.id, codex.id);
    const bundle = handoff.content.contextBundle!;
    assert.equal(bundle.budget.contextWindow, 1_000_000);
    assert.equal(bundle.budget.maxTokens, 150_000, "not the 19.2K fallback");
  } finally {
    restore();
  }
});

test("T8 — an unknown target still uses the deterministic safe default", () => {
  // No runtime capability, no configured model window: the documented default.
  assert.equal(declaredRuntimeContextWindow(undefined), undefined);
  assert.equal(declaredRuntimeContextWindow({ kind: "codex" } as Runtime), undefined);
  assert.equal(resolveHandoffBudget({}).contextWindow, DEFAULT_TARGET_CONTEXT_WINDOW);
  assert.equal(resolveHandoffBudget({}).maxTokens, 19_200);
  // Nothing here consults a model name or the network — it is a pure function.
  const budget = resolveHandoffBudget({ contextWindow: DEFAULT_TARGET_CONTEXT_WINDOW });
  assert.equal(budget.maxTokens, 19_200);
});

test("T9 — explicit capability overrides the configured fallback", () => {
  const runtime = {
    kind: "codex",
    capabilities: { contextWindow: 512_000 },
    config: { contextWindow: 256_000 },
  } as unknown as Runtime;
  assert.equal(declaredRuntimeContextWindow(runtime), 512_000);
  const budget = resolveHandoffBudget({ contextWindow: declaredRuntimeContextWindow(runtime) });
  assert.equal(budget.maxTokens, 76_800);

  // config.contextWindow is the same explicit channel when capabilities is absent.
  const configOnly = { kind: "codex", config: { contextWindow: 512_000 } } as unknown as Runtime;
  assert.equal(declaredRuntimeContextWindow(configOnly), 512_000);
});

/* ------------------------------------------------------------------ */
/* T10/T11 — user notes are part of the budget                         */
/* ------------------------------------------------------------------ */

test("T10 — user notes make the selector leave room", async () => {
  const turns: HandoffContextSourceTurn[] = [
    { runId: "run_1", userPrompt: "the brief", events: [ev("agent.message", { role: "assistant", content: "start" })] },
    ...Array.from({ length: 20 }, (_, i) => ({
      runId: `run_${i + 2}`,
      userPrompt: `instruction ${i}`,
      events: [ev("agent.message", { role: "assistant" as const, content: `${"x".repeat(20_000)}` }, `run_${i + 2}`)],
    })),
  ];
  const notes = "用户备注：".repeat(4_000); // ~40K chars of CJK notes
  const withNotes = await runFixture(turns, {
    settings: { contextWindow: 1_000_000, maxHandoffTokens: 150_000 },
    userNotes: notes,
  });
  const bundle = withNotes.result.contextBundle;
  assert.ok((bundle.budget.userNotesTokens ?? 0) > 0, "notes are accounted for");
  assert.ok(
    bundle.budget.estimatedTokens <= bundle.budget.maxTokens,
    `estimated ${bundle.budget.estimatedTokens} > ${bundle.budget.maxTokens}`
  );
  const body = renderHandoffBody(handoffOf({ contextBundle: bundle }, notes));
  assert.ok(
    estimateTextTokens(body, bundle.budget.charsPerToken) <= bundle.budget.maxTokens,
    "the rendered body (notes included) respects the budget"
  );

  // Without the notes the same fixture retains strictly more context.
  const withoutNotes = await runFixture(turns, {
    settings: { contextWindow: 1_000_000, maxHandoffTokens: 150_000 },
  });
  assert.ok(
    withoutNotes.result.contextBundle.budget.retainedTokens > bundle.budget.retainedTokens,
    "notes consume room the trajectory would otherwise use"
  );
});

test("T11 — notes larger than the whole budget fail loudly, never silently", async () => {
  const notes = "n".repeat(400_000); // > 150K tokens at 2 chars/token
  await assert.rejects(
    () =>
      runFixture([{ runId: "run_1", events: [ev("agent.message", { role: "assistant", content: "hi" })] }], {
        settings: { contextWindow: 1_000_000, maxHandoffTokens: 150_000 },
        userNotes: notes,
      }),
    (err: unknown) =>
      err instanceof HandoffBudgetExceededError && (err as { code: string }).code === "handoff-budget-exceeded"
  );
});

/* ------------------------------------------------------------------ */
/* T12–T14 — multilingual estimation                                   */
/* ------------------------------------------------------------------ */

test("T12 — English/code estimation stays reasonable and deterministic", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(2_000), 1_000);
  assert.equal(estimateTextTokens("abcd"), 2);
  const code = "export function x(): void {\n  return;\n}\n";
  assert.equal(estimateTextTokens(code), estimateTokens(code.length));
  assert.equal(estimateTextTokens(code), estimateTextTokens(code), "deterministic");
});

test("T13 — Chinese-heavy text is not estimated at the Latin ratio", () => {
  const chinese = "这是一个大量中文上下文。".repeat(1_000); // 12K chars
  const tokens = estimateTextTokens(chinese);
  assert.ok(tokens >= chinese.length, `CJK must cost at least one token per character, got ${tokens}`);
  assert.ok(tokens > estimateTokens(chinese.length, 2) * 1.5, "never the Latin chars/token ratio");
  assert.equal(handoffTextCost(chinese), tokens * 2, "cost and tokens use the same rule");
});

test("T14 — mixed CJK + code + JSON + shell stays conservative", () => {
  const mixed = [
    "以下是实现说明：handoff 选择器必须保守估算 token。",
    "```ts\nexport const x = 1;\n```",
    '{"name":"agent-fabric","count":42}',
    "$ npm test\nPASS a.test.ts\n1 passing",
    "决定：保留 Context Bundle 架构不变。",
  ].join("\n");
  const tokens = estimateTextTokens(mixed);
  assert.ok(tokens >= estimateTokens(mixed.length, 2), "CJK weight only ever increases the estimate");
  assert.ok(tokens <= mixed.length, "the estimate stays within the conservative 1-token-per-char bound");
  assert.equal(tokens, estimateTextTokens(mixed), "deterministic");
});

test("a CJK-heavy handoff still respects its reported budget", async () => {
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      userPrompt: "这是一个中文任务，需要保留上下文。",
      events: [
        ev("agent.message", { role: "assistant", content: "中文说明。".repeat(8_000) }),
        ev("agent.message", { role: "assistant", content: "最终结论：不要丢失尾部关键信息。" }),
      ],
    },
  ];
  const { result } = await runFixture(turns, {
    settings: { contextWindow: 1_000_000, maxHandoffTokens: 5_000, checkpointMaxTokens: 500 },
  });
  const bundle = result.contextBundle;
  assert.ok(bundle.budget.estimatedTokens <= bundle.budget.maxTokens);
  const body = renderHandoffBody(handoffOf({ contextBundle: bundle }));
  assert.ok(
    estimateTextTokens(body, bundle.budget.charsPerToken) <= bundle.budget.maxTokens,
    `rendered ${estimateTextTokens(body, bundle.budget.charsPerToken)} tokens > ${bundle.budget.maxTokens}`
  );
});

/* ------------------------------------------------------------------ */
/* T15–T17 — historical user instruction supersession                  */
/* ------------------------------------------------------------------ */

const SUPERSEDE_BODY = renderHandoffBody(
  handoffOf({
    workspaceStatus: "Workspace \"agent-fabric\" (local) at /Users/dev/agent-fabric.",
    contextBundle: {
      version: 2,
      pinnedContext: [
        { kind: "user", text: "Do not change the public API.", retention: "pinned" },
        { kind: "user", text: "You may change the public API if necessary.", retention: "pinned" },
      ],
      retainedContext: [{ kind: "assistant", text: "continuing", retention: "recent" }],
      budget: {
        contextWindow: 1_000_000,
        maxTokens: 150_000,
        estimatedTokens: 100,
        checkpointTokens: 0,
        pinnedTokens: 20,
        retainedTokens: 4,
        charsPerToken: 2,
      },
    },
  })
);

test("T15 — later user instructions explicitly supersede conflicting earlier ones", () => {
  assert.match(SUPERSEDE_BODY, /chronological order/i);
  assert.match(SUPERSEDE_BODY, /supersede/i);
  assert.match(SUPERSEDE_BODY, /LATER instruction is the user's current wish/i);
});

test("T16 — a non-conflicting earlier constraint still applies", () => {
  assert.match(SUPERSEDE_BODY, /earlier constraint that no later instruction contradicts still applies/i);
  // Both instructions are preserved verbatim, so the receiving harness can judge
  // the conflict itself.
  assert.ok(SUPERSEDE_BODY.includes("Do not change the public API."));
  assert.ok(SUPERSEDE_BODY.includes("You may change the public API if necessary."));
});

test("T17 — the current instruction has the highest recency", () => {
  const prompt = renderHandoffPrompt(
    handoffOf({ contextBundle: { version: 2, pinnedContext: [], retainedContext: [], budget: { contextWindow: 1_000, maxTokens: 100, estimatedTokens: 1, checkpointTokens: 0, pinnedTokens: 0, retainedTokens: 0, charsPerToken: 2 } } }),
    "Please update the tests as part of this task."
  );
  assert.match(prompt, /# Your instruction\nPlease update the tests as part of this task\./);
  assert.match(SUPERSEDE_BODY, /"# Your instruction".*the NEWEST user instruction/);
  assert.match(SUPERSEDE_BODY, /outranks every preserved historical user message/i);
});

/* ------------------------------------------------------------------ */
/* T18/T19 — oversized historical input and recent failures            */
/* ------------------------------------------------------------------ */

test("T18 — a huge historical turn keeps its tail in the checkpoint source", async () => {
  const huge = `HEAD_MARKER\n${"investigation log line\n".repeat(8_000)}\nTAIL_CRITICAL_DECISION: native harness targets fall back to 128K.`;
  const turns: HandoffContextSourceTurn[] = [
    { runId: "run_old", userPrompt: "old turn", events: [ev("agent.message", { role: "assistant", content: huge }, "run_old")] },
    { runId: "run_new", userPrompt: "continue", events: [ev("agent.message", { role: "assistant", content: "frontier" }, "run_new")] },
  ];
  const { requests } = await runFixture(turns, {
    // Tiny handoff budget + tiny summarizer window force the old turn into the
    // summarizer AND force its transcript to be reduced.
    settings: { contextWindow: 1_000_000, maxHandoffTokens: 300, checkpointMaxTokens: 300 },
    modelContextWindow: 5_000,
  });
  const prompt = requests[0]?.prompt ?? "";
  assert.ok(prompt.includes("HEAD_MARKER"), "the beginning is still there");
  assert.ok(
    prompt.includes("TAIL_CRITICAL_DECISION"),
    "the tail must not disappear because of a head-only cut (v9 §9)"
  );
  assert.ok(!prompt.includes("investigation log line\n".repeat(8_000)), "the middle was reduced");
});

test("T19 — a recent failure keeps its high-fidelity tail", async () => {
  const output = `${"log line\n".repeat(6_000)}FAIL foo.test.ts\nExpected A\nReceived B\nexit code 1`;
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      events: [
        ev("tool.started", { tool: "bash", args: { command: "npm test" } }),
        ev("tool.completed", { tool: "bash", args: { command: "npm test" }, output }),
      ],
    },
  ];
  const { result } = await runFixture(turns, {
    settings: { contextWindow: 1_000_000, maxHandoffTokens: 5_000, checkpointMaxTokens: 300 },
  });
  const body = renderHandoffBody(handoffOf({ contextBundle: result.contextBundle }));
  assert.match(body, /FAIL foo\.test\.ts/);
  assert.match(body, /Expected A/);
  assert.match(body, /Received B/);
  assert.match(body, /characters omitted from the middle during handoff retention/);
});

test("truncateForHandoffRetention is tail-biased and cost-bounded for CJK", () => {
  const latin = `${"H".repeat(10_000)}${"T".repeat(10_000)}`;
  const out = truncateForHandoffRetention(latin, 1_000);
  assert.ok(out.length <= 1_000);
  assert.ok(out.startsWith("H") && out.endsWith("T"));
  assert.ok(out.indexOf("T") > out.indexOf("H"), "the tail gets the larger share");

  const cjk = "中".repeat(10_000);
  const cjkOut = truncateForHandoffRetention(cjk, 1_000);
  assert.ok(handoffTextCost(cjkOut) <= 1_000, "a CJK cut obeys the cost budget, not the char budget");
  assert.ok(cjkOut.length < cjk.length);
});

/* ------------------------------------------------------------------ */
/* T20 — total rendered size                                           */
/* ------------------------------------------------------------------ */

test("T20 — every rendered section, notes included, respects the budget", async () => {
  const turns: HandoffContextSourceTurn[] = [
    { runId: "run_1", userPrompt: "the original brief", events: [ev("agent.message", { role: "assistant", content: `start\n${"x".repeat(20_000)}` })] },
    ...Array.from({ length: 10 }, (_, i) => ({
      runId: `run_${i + 2}`,
      userPrompt: `instruction ${i}`,
      events: [ev("agent.message", { role: "assistant" as const, content: `step ${i}\n${"y".repeat(30_000)}` }, `run_${i + 2}`)],
    })),
  ];
  const notes = "Please preserve the existing Context Bundle architecture. Focus only on correctness and budget hardening.";
  const { result } = await runFixture(turns, {
    settings: { contextWindow: 1_000_000, maxHandoffTokens: 150_000, checkpointMaxTokens: 12_000 },
    userNotes: notes,
    complete: fakeCompletion(`${CHECKPOINT}\n${"## Critical Context\n- detail line\n".repeat(600)}`),
  });
  const bundle = result.contextBundle;
  assert.equal(bundle.budget.maxTokens, 150_000);
  assert.ok(bundle.budget.metadataTokens! > 0, "scaffolding + metadata are accounted");
  assert.ok(bundle.budget.userNotesTokens! > 0, "user notes are accounted");
  assert.ok(bundle.budget.checkpointTokens > 0);
  assert.ok(bundle.budget.pinnedTokens > 0);
  assert.ok(bundle.budget.retainedTokens > 0);
  assert.ok(bundle.budget.estimatedTokens <= bundle.budget.maxTokens);

  const body = renderHandoffBody(handoffOf({ workspaceStatus: `Workspace "agent-fabric" (local) at ${workspace.path}.`, previousRunResult: `Run ${run.id} finished with status "completed".`, contextBundle: bundle }, notes));
  assert.ok(
    estimateTextTokens(body, bundle.budget.charsPerToken) <= bundle.budget.maxTokens,
    `rendered ${estimateTextTokens(body, bundle.budget.charsPerToken)} > ${bundle.budget.maxTokens}`
  );
  assert.ok(body.includes("# Notes from the user"), "notes are rendered inside the body they are budgeted for");
});

/* ------------------------------------------------------------------ */
/* One-shot semantic acceptance fixture (v9 §12/§13)                   */
/* ------------------------------------------------------------------ */

const EARLY_BRIEF = `Improve the handoff implementation.

Constraints:
1. Do not add new dependencies.
2. Keep Node 20 compatibility.
3. Do not change the public server API.
4. Handoff and compaction must remain separate concepts.`;

const LATER_INSTRUCTION = `You may change the public server API if it is necessary to expose target harness context capability.
Do not add dependencies.`;

const HISTORICAL_ENDING =
  "The actual issue is that native harness targets do not expose their configured context window, so they fall back to the 128K default and only receive a ~19.2K handoff budget.";

const RECENT_FAILURE = `FAIL no-id tool pairing
Expected:
  read("packages/core/src/handoff.ts")
  to pair with result A

Received:
  synthetic read call

FAIL partial retention coverage
Expected omitted middle to be available to checkpoint generation
Received:
  event marked fully covered

41 passing
2 failing`;

const DIAGNOSIS = `Two issues remain: no-ID tool calls are not paired deterministically; oversized partially retained context is incorrectly treated as fully covered.`;

const ONE_SHOT_CHECKPOINT = `## Goal
Harden the existing AgentFabric Handoff implementation without redesigning the Context Bundle architecture.

## Constraints & Preferences
- Do not add new dependencies.
- Keep Node 20 compatibility.
- Handoff and compaction must remain separate concepts.
- The public server API may change if necessary to expose target harness context capability (supersedes the earlier "do not change the public server API").

## Progress
### Blocked
- No-ID tool calls are not paired deterministically.
- Oversized partially retained context is incorrectly treated as fully covered.

## Key Decisions
- **Keep the Context Bundle architecture**: retain what fits, summarize what does not.

## Next Steps
1. Fix no-ID tool call/result pairing.
2. Treat a partially retained item as partial, not fully covered.
3. Run the core tests, typecheck and build.

## Critical Context
- Native harness targets currently fall back to ${DEFAULT_TARGET_CONTEXT_WINDOW / 1_000}K when their real context capability is unavailable.
- Failing tests: "FAIL no-id tool pairing" and "FAIL partial retention coverage".`;

function oneShotTurns(): HandoffContextSourceTurn[] {
  const fileBody = `import type { HandoffContent } from "./types.js";\n${"// implementation line\n".repeat(6_000)}`;
  const hugeHistorical = `BEGINNING: I am investigating context capability resolution.\n${"investigation detail\n".repeat(8_000)}\nENDING: ${HISTORICAL_ENDING}`;
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      userPrompt: EARLY_BRIEF,
      events: [
        ev("agent.message", { role: "assistant", content: "I will read the current implementation first." }, "run_1"),
        // Historical tool calls WITHOUT native ids.
        ev("tool.started", { tool: "read", args: { path: "packages/core/src/handoff.ts" } }, "run_1"),
        ev("tool.started", { tool: "read", args: { path: "packages/core/src/handoffContext.ts" } }, "run_1"),
        ev("tool.completed", { tool: "read", args: { path: "packages/core/src/handoff.ts" }, output: fileBody }, "run_1"),
        ev("tool.completed", { tool: "read", args: { path: "packages/core/src/handoffContext.ts" }, output: fileBody }, "run_1"),
        // The oversized historical turn, outside the recent retained window.
        ev("agent.message", { role: "assistant", content: hugeHistorical }, "run_1"),
      ],
    },
    {
      runId: "run_2",
      userPrompt: LATER_INSTRUCTION,
      events: [ev("agent.message", { role: "assistant", content: "Understood — the API constraint is updated." }, "run_2")],
    },
  ];
  // Ordinary work in between, so the early turns fall outside the retained tail.
  for (let i = 3; i <= 14; i++) {
    turns.push({
      runId: `run_${i}`,
      userPrompt: `continue with step ${i}`,
      events: [ev("agent.message", { role: "assistant", content: `step ${i}\n${"progress detail line\n".repeat(900)}` }, `run_${i}`)],
    });
  }
  // The execution frontier: the failing tests, the reasons and the conclusion.
  turns.push({
    runId: "run_15",
    userPrompt: "continue",
    events: [
      ev("agent.message", { role: "assistant", content: "I will run the Handoff tests now." }, "run_15"),
      ev("shell.command", { command: "npm run test -w @agentfabric/core" }, "run_15"),
      ...RECENT_FAILURE.split("\n").map((line) => ev("shell.output", { line }, "run_15")),
      ev("agent.message", { role: "assistant", content: DIAGNOSIS }, "run_15"),
    ],
  });
  return turns;
}

test("one-shot: a 1M native target gets a 150K hardened bundle whose frontier is intact", async () => {
  const turns = oneShotTurns();
  const notes = "Please preserve the existing Context Bundle architecture.\nFocus only on correctness and budget hardening.";
  const { result, requests, collected } = await runFixture(turns, {
    settings: { contextWindow: 1_000_000, handoffContextRatio: 0.15, maxHandoffTokens: 150_000, checkpointMaxTokens: 12_000 },
    modelContextWindow: 1_000_000,
    userNotes: notes,
    complete: fakeCompletion(ONE_SHOT_CHECKPOINT),
  });
  const bundle = result.contextBundle;
  const body = renderHandoffPrompt(
    handoffOf(
      {
        workspaceStatus: `Workspace "${workspace.name}" (local) at ${workspace.path}.`,
        previousRunResult: 'Run run_15 finished with status "completed".',
        contextBundle: bundle,
      },
      notes
    ),
    "continue from where the previous agent stopped"
  );

  /* A. Target budget */
  assert.equal(bundle.budget.contextWindow, 1_000_000);
  assert.equal(bundle.budget.maxTokens, 150_000);
  assert.notEqual(bundle.budget.maxTokens, 19_200);

  /* B. Checkpoint budget stays independent of the handoff budget */
  assert.ok(requests.length > 0);
  for (const req of requests) assert.equal(req.maxTokens, 12_000);

  /* C. User constraint supersession is explicit */
  assert.match(body, /chronological order/i);
  assert.match(body, /supersede/i);
  assert.ok(body.includes("You may change the public server API if it is necessary"));
  assert.ok(body.includes("Do not add new dependencies."));

  /* D. No-ID tool calls stay distinguishable and deterministically paired */
  const readCalls = collected.items.filter((i) => i.kind === "tool-call" && i.text.includes("read("));
  assert.equal(readCalls.length, 2, "two historical reads stay two calls — no synthetic duplicate");
  assert.notEqual(readCalls[0].id, readCalls[1].id);
  const readUnits = groupHandoffContextUnits(collected.items).filter(
    (u) => u.items.some((i) => i.kind === "tool-call" && i.text.includes("read("))
  );
  assert.equal(readUnits.length, 2, "each read is its own logical interaction");
  for (const unit of readUnits) {
    assert.equal(unit.items.filter((i) => i.kind === "tool-result").length, 1, "exactly one result per call");
  }
  assert.ok(!body.includes("evt_"), "no synthetic duplicate call leaked into the body");

  /* E. Reconstructable file bodies do not ship, but they are named */
  assert.ok(!body.includes("// implementation line"), "local file bodies are reconstructable");
  for (const path of ["packages/core/src/handoff.ts", "packages/core/src/handoffContext.ts"]) {
    assert.ok(body.includes(path), `the handoff still names the inspected file: ${path}`);
  }

  /* F. The historical tail reached the checkpoint source */
  assert.ok(
    requests.some((r) => r.prompt.includes("native harness targets do not expose their configured context window")),
    "the checkpoint input carries the old turn's conclusion"
  );
  assert.ok(
    requests.some((r) => r.prompt.includes("~19.2K handoff budget")),
    "the key figure from the historical tail survives"
  );

  /* G. Recent failures are preserved raw, with reasons */
  assert.ok(body.includes("FAIL no-id tool pairing"));
  assert.ok(body.includes("FAIL partial retention coverage"));
  assert.ok(body.includes("synthetic read call"));
  assert.ok(body.includes(DIAGNOSIS));

  /* H. Partial retention is never silently treated as full coverage */
  for (const item of collected.items) {
    if (result.selection.retentionByItemId.get(item.id) === "partial") {
      for (const id of item.eventIds) {
        assert.ok(
          !result.selection.excludedFromSummaryEventIds.has(id),
          `partially retained item ${item.id} must stay eligible for the checkpoint`
        );
      }
    }
  }

  /* I. User notes count toward the budget */
  assert.ok((bundle.budget.userNotesTokens ?? 0) > 0);
  assert.ok(bundle.budget.estimatedTokens <= 150_000);
  assert.ok(
    estimateTextTokens(renderHandoffBody(handoffOf({ contextBundle: bundle }, notes)), 2) <= 150_000
  );

  /* J. A reviewer can answer the continuation questions from the body alone */
  const answers: Array<[string, RegExp]> = [
    ["architecture that must stay", /Context Bundle architecture/],
    ["superseded constraint", /supersedes the earlier/],
    ["why a 1M target got too small a handoff", /fall back to 128K/],
    ["the two failing tests", /FAIL no-id tool pairing[\s\S]*FAIL partial retention coverage/],
    ["why no-ID pairing fails", /not paired deterministically/],
    ["why partial-retention coverage is wrong", /incorrectly treated as fully covered/],
    ["what to fix next", /## Next Steps[\s\S]*no-ID tool call\/result pairing/],
  ];
  for (const [question, pattern] of answers) {
    assert.match(body, pattern, `the handoff must answer: ${question}`);
  }
});

/* ------------------------------------------------------------------ */
/* Regression: a healthy small task stays simple                       */
/* ------------------------------------------------------------------ */

test("regression — a small context that fits is retained whole, with no forced summary", async () => {
  const turns: HandoffContextSourceTurn[] = [
    {
      runId: "run_1",
      userPrompt: "what does this repo do?",
      events: [ev("agent.message", { role: "assistant", content: "It orchestrates agent harnesses across sessions." })],
    },
  ];
  const { result, requests } = await runFixture(turns, {
    settings: { contextWindow: 1_000_000 },
    targetContextWindow: 1_000_000,
  });
  assert.equal(requests.length, 0, "nothing needed summarizing, so nothing was summarized");
  assert.equal(result.checkpoint, undefined, "no checkpoint merely because a handoff exists");
  assert.equal(result.chunks, 0);
  assert.ok(result.contextBundle.retainedContext.length >= 2, "the whole useful context is retained raw");
  assert.ok(!result.contextBundle.pinnedContext.length);
  // A small context against a large budget: the only fixed cost is the render
  // scaffolding + metadata, and everything useful is retained.
  assert.ok(result.contextBundle.budget.estimatedTokens <= result.contextBundle.budget.maxTokens);
  assert.ok(
    result.contextBundle.budget.retainedTokens > result.contextBundle.budget.checkpointTokens,
    "the trajectory, not a checkpoint, carries the context"
  );
});