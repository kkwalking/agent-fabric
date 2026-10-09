/**
 * The outbound webhook, wired to a real Task lifecycle.
 *
 * `notifications.test.ts` covers the module in isolation (payload, retry,
 * redaction). This suite covers the *wiring*: that a terminal Task actually
 * fires one, that a broken webhook is recorded rather than swallowed, and —
 * the hard constraint — that a notification can never change a Task's
 * recorded outcome.
 *
 * The transport is stubbed at `globalThis.fetch`, which is the seam the
 * delivery loop defaults to; nothing here touches the network.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Store } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry, type AgentRuntimeAdapter, type RuntimeContext, type RuntimeResult } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import { ExecutionSupervisor } from "./supervisor.js";
import { ProjectService, RuntimeService, TaskService } from "./services.js";
import type { Project, Run, Task } from "./types.js";

const execFileAsync = promisify(execFile);

const WEBHOOK_URL = "https://hooks.example.com/services/T000/B000/supersecret";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout;
}

async function makeRemote(): Promise<{ remote: string }> {
  const root = tempDir("af-notify-remote-");
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await git(seed, ["init", "--quiet"]);
  await git(seed, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "initial"]);
  const remote = join(root, "remote.git");
  await git(root, ["clone", "--quiet", "--bare", seed, remote]);
  return { remote };
}

interface Harness {
  store: Store;
  supervisor: ExecutionSupervisor;
  runService: RunService;
  projects: ProjectService;
  tasks: TaskService;
  runtimeId: string;
  setAgent: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
}

async function makeHarness(): Promise<Harness> {
  const store = await Store.open(tempDir("af-notify-data-"));
  const bus = new EventBus();
  const state = { handler: async () => ({ exitCode: 0 }) as RuntimeResult };
  const adapter: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Scripted harness",
    capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
    async run(ctx) {
      return state.handler(ctx);
    },
  };
  const registry = new RuntimeRegistry();
  registry.register(adapter);
  const runService = new RunService(store, bus, registry, { destroy: async () => {} }, undefined, {});
  const supervisor = new ExecutionSupervisor(store, bus, runService, {
    validationExecutor: () => async () => ({ exitCode: 0, timedOut: false, output: "" }),
  });
  const runtimes = new RuntimeService(store);
  const runtime = await runtimes.create({
    name: "Isolated",
    kind: "custom",
    usableInTask: true,
    enabled: true,
    containerized: true,
    executionBackend: "isolated",
    image: "af-test:latest",
  });
  return {
    store,
    supervisor,
    runService,
    projects: new ProjectService(store),
    tasks: new TaskService(store),
    runtimeId: runtime.id,
    setAgent: (handler) => {
      state.handler = handler;
    },
  };
}

async function startTask(h: Harness, project: Project): Promise<{ task: Task; run: Run }> {
  const result = await h.supervisor.startTask({
    projectId: project.id,
    instruction: "Add a feature",
    runtimeId: h.runtimeId,
  });
  await h.supervisor.whenSettled(result.task.id);
  return { task: h.tasks.get(result.task.id)!, run: h.runService.get(result.run.id)! };
}

/** Captures every fetch the delivery loop makes. */
function stubFetch(respond: () => { status: number; body?: string }): {
  calls: Array<{ url: string; body: unknown; headers: Record<string, string> }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const { status, body } = respond();
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body ?? "",
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const writeFile = (rel: string, content: string) => async (ctx: RuntimeContext): Promise<RuntimeResult> => {
  const abs = join(ctx.workspacePath!, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return { exitCode: 0 };
};

/* ================================================================== */

describe("v11 notifications: the webhook fires on a terminal Task", () => {
  test("a completed Task posts one notification carrying the frozen revision", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await h.store.updateConfig({ notifications: { enabled: true, url: WEBHOOK_URL } });
    h.setAgent(writeFile("src/a.ts", "export const a = 1;\n"));

    const { calls, restore } = stubFetch(() => ({ status: 200 }));
    try {
      const { task } = await startTask(h, project);

      assert.equal(calls.length, 1, "exactly one POST");
      assert.equal(calls[0].url, WEBHOOK_URL);
      const payload = calls[0].body as Record<string, unknown>;
      assert.equal(payload.event, "task.completed");
      assert.equal(payload.taskId, task.id);
      assert.equal(payload.status, "completed");
      assert.equal(payload.finalCommitSha, task.execution!.frozenRevision!.finalCommitSha);
      assert.equal(payload.workingBranch, task.workingBranch);
      assert.equal(payload.link, `/tasks/${task.id}`);
      assert.equal(payload.instruction, "Add a feature");
      assert.equal(payload.failure, undefined, "a completed task carries no failure");
      // The stages block lets the receiver distinguish "agent succeeded,
      // publish failed" from a bare "it broke". It is copied from the
      // record verbatim (status + timestamp), never recomputed here.
      const stages = payload.stages as Record<string, { status: string }>;
      assert.deepEqual(
        Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v.status])),
        { agent: "completed", validation: "skipped", finalization: "completed", publish: "completed" },
        "this harness configures no validation steps, so that stage is skipped, not completed"
      );
    } finally {
      restore();
    }
  });

  test("notifications off means no request at all", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.setAgent(writeFile("x.txt", "x\n"));

    const { calls, restore } = stubFetch(() => ({ status: 200 }));
    try {
      await startTask(h, project);
      assert.equal(calls.length, 0);
    } finally {
      restore();
    }
  });

  test("a failed Task reports the failure stage and code", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await h.store.updateConfig({ notifications: { enabled: true, url: WEBHOOK_URL } });
    // The agent fails: the Task is terminal, but publish never ran. The run's
    // status is driven by `error`, not `exitCode` (orchestrator §…), so a
    // non-zero code alone would still be a "completed" run.
    h.setAgent(async () => ({ exitCode: 1, error: "the agent gave up" }));

    const { calls, restore } = stubFetch(() => ({ status: 200 }));
    try {
      const { task } = await startTask(h, project);
      assert.equal(task.execution!.status, "failed");

      assert.equal(calls.length, 1);
      const payload = calls[0].body as Record<string, unknown>;
      assert.equal(payload.event, "task.failed");
      assert.equal(payload.status, "failed");
      const failure = payload.failure as Record<string, unknown>;
      assert.equal(failure.stage, "agent");
      assert.ok(failure.code, "the machine-readable code is carried through");
    } finally {
      restore();
    }
  });

  test("a broken webhook is recorded on the run and never fails the Task", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    // `enabled` with no URL is the misconfiguration the module refuses to
    // swallow — and the case most likely to reach the terminal write.
    await h.store.updateConfig({ notifications: { enabled: true } });
    h.setAgent(writeFile("x.txt", "x\n"));

    const { calls, restore } = stubFetch(() => ({ status: 200 }));
    try {
      const { task, run } = await startTask(h, project);

      // The Task succeeded on its own merits — the webhook had no vote.
      assert.equal(task.execution!.status, "completed");
      assert.equal(calls.length, 0, "nothing was sent");

      const events = await h.store.readEvents(run.id);
      const log = events.find((e) => (e.data as { kind?: string }).kind === "notification-failed");
      assert.ok(log, "the drop is visible as an event, not silent");
      assert.match(String((log.data as { line: string }).line), /notification failed/);
    } finally {
      restore();
    }
  });

  test("a webhook URL that embeds a token never reaches the run's events", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await h.store.updateConfig({ notifications: { enabled: true, url: WEBHOOK_URL } });
    h.setAgent(writeFile("x.txt", "x\n"));

    // A 403 whose body echoes the URL, the way a real endpoint might.
    const { restore } = stubFetch(() => ({ status: 403, body: `forbidden: ${WEBHOOK_URL}` }));
    try {
      const { run } = await startTask(h, project);
      const serialized = JSON.stringify(await h.store.readEvents(run.id));
      assert.doesNotMatch(serialized, /supersecret/, "the path token is a credential");
      assert.match(serialized, /notification failed/, "…but the failure itself is still recorded");
    } finally {
      restore();
    }
  });
});
