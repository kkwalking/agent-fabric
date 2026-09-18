/**
 * The configured handoff model (config `handoff.modelId`, Handoffs page).
 *
 * Selection is an explicit-priority order recorded on the generation: a
 * configured model wins over the covered run's own model; with no
 * configuration the run chain applies (previous run's model, else the first
 * enabled model). A configured model that has become unusable fails loudly —
 * the user explicitly chose it, so generation never silently falls back to
 * another model.
 *
 * Deterministic and offline, on the fake opencode harness (the mock runtime
 * writes its own harness handoff, which would bypass our summarizer). Small
 * model windows force the covered history past the handoff budget so a
 * checkpoint (and therefore a model call) actually happens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { HandoffService } from "./handoff.js";
import { HandoffUnavailableError } from "./orchestrator.js";
import type { Model } from "./types.js";
import { freshHarness, makeFixtures, testCompletionFactory, useBins, waitForRun, type Harness } from "./testkit.js";

interface HandoffHarness extends Harness {
  handoffs: HandoffService;
}

async function freshHandoffHarness(): Promise<HandoffHarness> {
  const h = await freshHarness({ completionFactory: () => testCompletionFactory() });
  return { ...h, handoffs: new HandoffService(h.store) };
}

/** Shrink every seeded model's window so the budget forces a checkpoint. */
async function shrinkModelWindows(h: Harness): Promise<void> {
  for (const m of h.store.list<Model>("models")) {
    await h.store.update("models", m.id, {
      parameters: { ...(m.parameters ?? {}), contextWindow: 2_000 },
    });
  }
}

/** One finished run on the fake opencode harness; returns its task. */
async function runOnce(h: HandoffHarness): Promise<string> {
  const oc = h.store.list<{ id: string; kind: string }>("runtimes").find((r) => r.kind === "opencode")!;
  const { task, run } = await h.runService.submit({
    prompt: "investigate the flaky integration suite and land a fix with a regression test",
    runtimeId: oc.id,
  });
  await waitForRun(h.runService, run.id);
  return task.id;
}

test("a configured handoff model wins over the run chain and is recorded as such", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const h = await freshHandoffHarness();
  try {
    await shrinkModelWindows(h);
    const models = h.store.list<Model>("models");
    const first = models.find((m) => m.name === "gpt-4o")!;
    const second = models.find((m) => m.name === "gpt-4o-mini")!;
    const taskId = await runOnce(h);

    // Without configuration the covered run's own model writes the checkpoint.
    const inherited = await h.runService.generateHandoff(taskId);
    assert.equal(inherited.generation?.method, "context-bundle");
    assert.equal(inherited.generation?.modelSource, "previous-run");
    assert.equal(inherited.generation?.modelId, first.id);
    await h.handoffs.remove(inherited.id);

    // The explicit choice wins even though the run ran on another model.
    await h.store.updateConfig({ handoff: { modelId: second.id } });
    const configured = await h.runService.generateHandoff(taskId);
    assert.equal(configured.generation?.method, "context-bundle");
    assert.equal(configured.generation?.modelSource, "configured");
    assert.equal(configured.generation?.modelId, second.id);
    await h.handoffs.remove(configured.id);

    // Clearing the configuration restores the run chain.
    await h.store.updateConfig({ handoff: {} });
    const cleared = await h.runService.generateHandoff(taskId);
    assert.equal(cleared.generation?.modelSource, "previous-run");
    assert.equal(cleared.generation?.modelId, first.id);
  } finally {
    restore();
  }
});

test("an unusable configured handoff model fails loudly instead of falling back", async () => {
  const fx = makeFixtures();
  const restore = useBins(fx);
  const h = await freshHandoffHarness();
  try {
    await shrinkModelWindows(h);
    const taskId = await runOnce(h);

    // A configured model that does not exist is the user's explicit choice:
    // strict callers get the error, and the reason names the configuration —
    // never a silent switch to the run's own model.
    await h.store.updateConfig({ handoff: { modelId: "mod_missing" } });
    await assert.rejects(
      () => h.runService.generateHandoff(taskId),
      (err: unknown) =>
        err instanceof HandoffUnavailableError && /configured handoff model/.test(err.message)
    );

    // Explicit acceptance still gets a degraded digest, visibly attributed.
    const degraded = await h.runService.generateHandoff(taskId, undefined, { allowDegraded: true });
    assert.equal(degraded.generation?.method, "heuristic");
    assert.match(degraded.generation?.detail ?? "", /configured handoff model/);
    assert.equal(degraded.generation?.modelId, undefined);
    await h.handoffs.remove(degraded.id);

    // A since-disabled configured model is equally unusable — same loud
    // failure instead of falling back to the run's own model.
    const enabled = h.store.list<Model>("models").find((m) => m.enabled)!;
    await h.store.update("models", enabled.id, { enabled: false });
    await h.store.updateConfig({ handoff: { modelId: enabled.id } });
    await assert.rejects(
      () => h.runService.generateHandoff(taskId),
      (err: unknown) =>
        err instanceof HandoffUnavailableError && /configured handoff model/.test(err.message)
    );
  } finally {
    restore();
  }
});
