/**
 * Shared harness for the v12 suites (validation, pin/replay, recovery).
 *
 * The judge is a normal Run through the same registry (v12 §4.1): the
 * scripted adapter dispatches on the run's purpose, and the "judge" writes
 * the real `verdict.json` the supervisor reads — so every assertion runs
 * against the production read path, never a re-implementation of it.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventBus } from "./eventbus.js";
import { Store } from "./store.js";
import { RuntimeRegistry, type AgentRuntimeAdapter, type RuntimeContext, type RuntimeResult } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import { ExecutionSupervisor } from "./supervisor.js";
import { ProjectService, RuntimeService, TaskService, WorkspaceService } from "./services.js";
import { validationJudgePaths } from "./provisioning.js";
import type { GitOps } from "./git.js";
import type { VerdictPayload } from "./validation.js";
import type { Project, Run, Task } from "./types.js";

const execFileAsync = promisify(execFile);

/** The git identity every suite's `before()` installs. */
export function setGitIdentity(): void {
  process.env.GIT_AUTHOR_NAME = "AgentFabric Test";
  process.env.GIT_AUTHOR_EMAIL = "af@example.test";
  process.env.GIT_COMMITTER_NAME = "AgentFabric Test";
  process.env.GIT_COMMITTER_EMAIL = "af@example.test";
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return String(stdout);
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function makeRemote(): Promise<{ remote: string; seed: string; baseSha: string }> {
  const root = tempDir("af-v12-remote-");
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await git(seed, ["init", "--quiet"]);
  await git(seed, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--quiet", "-m", "initial commit"]);
  const baseSha = (await git(seed, ["rev-parse", "HEAD"])).trim();
  const remote = join(root, "remote.git");
  await git(root, ["clone", "--quiet", "--bare", seed, remote]);
  return { remote, seed, baseSha };
}

export interface Harness {
  store: Store;
  bus: EventBus;
  runService: RunService;
  supervisor: ExecutionSupervisor;
  projects: ProjectService;
  tasks: TaskService;
  workspaces: WorkspaceService;
  dataDir: string;
  runtimeId: string;
  /** Development runs (initial + rework) the harness executed. */
  runs: number;
  /** Judge runs the harness executed. */
  judgeRuns: number;
  setAgent: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
  setJudge: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
  /** Runtime contexts of the judge runs, for isolation assertions. */
  judgeContexts: RuntimeContext[];
  agentContexts: RuntimeContext[];
}

export async function makeHarness(options: { git?: GitOps } = {}): Promise<Harness> {
  const dataDir = tempDir("af-v12-data-");
  const store = await Store.open(dataDir);
  const bus = new EventBus();
  const state: {
    runs: number;
    judgeRuns: number;
    handler: (ctx: RuntimeContext) => Promise<RuntimeResult>;
    judge: (ctx: RuntimeContext) => Promise<RuntimeResult>;
  } = {
    runs: 0,
    judgeRuns: 0,
    handler: async () => ({ exitCode: 0 }),
    judge: async () => ({ exitCode: 0 }),
  };
  const judgeContexts: RuntimeContext[] = [];
  const agentContexts: RuntimeContext[] = [];
  const adapter: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Scripted harness",
    capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
    async run(ctx) {
      if (ctx.run.purpose === "validation") {
        state.judgeRuns += 1;
        judgeContexts.push(ctx);
        return state.judge(ctx);
      }
      state.runs += 1;
      agentContexts.push(ctx);
      return state.handler(ctx);
    },
  };
  const registry = new RuntimeRegistry();
  registry.register(adapter);
  const runService = new RunService(store, bus, registry, { destroy: async () => {} }, undefined, {});
  // Automatic retry is off: it is a real behavior with a real backoff
  // (v11.retry.test.ts covers it end to end) and would re-run the cycle
  // behind the terminal assertions these suites make.
  await store.updateConfig({ autoRetry: { enabled: false } });
  const supervisor = new ExecutionSupervisor(store, bus, runService, { ...(options.git ? { git: options.git } : {}) });
  const runtimes = new RuntimeService(store);
  const runtime = await runtimes.create({
    name: "Scripted runtime",
    kind: "custom",
    usableInTask: true,
    enabled: true,
    containerized: true,
    executionBackend: "isolated",
    image: "af-test-isolated:latest",
  });
  return {
    store,
    bus,
    runService,
    supervisor,
    projects: new ProjectService(store),
    tasks: new TaskService(store),
    workspaces: new WorkspaceService(store),
    dataDir,
    runtimeId: runtime.id,
    get runs() {
      return state.runs;
    },
    get judgeRuns() {
      return state.judgeRuns;
    },
    setAgent: (handler) => {
      state.handler = handler;
    },
    setJudge: (handler) => {
      state.judge = handler;
    },
    judgeContexts,
    agentContexts,
  };
}

export function verdict(overrides: Partial<VerdictPayload> = {}): VerdictPayload {
  return {
    passed: true,
    summary: "The acceptance standard is met.",
    unmet: [],
    evidence: ["`ls` → the expected files are present"],
    ...overrides,
  };
}

export function failedVerdict(summary: string, unmet: string[]): VerdictPayload {
  return { passed: false, summary, unmet, evidence: ["`npm test` → failing tests"] };
}

/** Where one judge run's verdict is read from (v12 §5.1) — one derivation. */
export function judgeVerdictPath(dataDir: string, judgeRunId: string): string {
  return join(validationJudgePaths(dataDir, judgeRunId, true).outputHostDir, "verdict.json");
}

/**
 * A scripted Validation Agent (v12 §5.2): submits real verdicts by writing
 * the same `verdict.json` the supervisor reads. Verdicts are consumed in
 * order; the last one repeats. `onJudge` observes each judge context.
 */
export function judgeScript(h: { dataDir: string }, verdicts: VerdictPayload[], onJudge?: (ctx: RuntimeContext) => Promise<void> | void) {
  let index = 0;
  return async (ctx: RuntimeContext): Promise<RuntimeResult> => {
    const payload = verdicts[Math.min(index, verdicts.length - 1)];
    index += 1;
    if (onJudge) await onJudge(ctx);
    const file = judgeVerdictPath(h.dataDir, ctx.run.id);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    await ctx.emit("log", { line: `verdict submitted: ${payload.passed ? "passed" : "failed"}` });
    return { exitCode: 0 };
  };
}

/** Writes `files` into the workspace — the agent "doing the work". */
export function writeFiles(files: Record<string, string>) {
  return async (ctx: RuntimeContext): Promise<RuntimeResult> => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(ctx.workspacePath!, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return { exitCode: 0 };
  };
}

export async function startTask(h: Harness, project: Project, input: Record<string, unknown> = {}): Promise<{ task: Task; run: Run }> {
  const result = await h.supervisor.startTask({
    projectId: project.id,
    instruction: "Add a feature",
    runtimeId: h.runtimeId,
    ...input,
  } as Parameters<ExecutionSupervisor["startTask"]>[0]);
  await h.supervisor.whenSettled(result.task.id);
  return { task: h.tasks.get(result.task.id)!, run: h.runService.get(result.run.id)! };
}
