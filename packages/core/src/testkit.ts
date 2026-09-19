/**
 * Shared test kit for the v2/v3 suites: realistic fake harness binaries
 * (fakes.ts), a fake `docker` CLI, and an in-memory harness wiring the
 * orchestrator to the real runtime adapters.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry } from "./runtime.js";
import { RunService, type CompletionFactory } from "./orchestrator.js";
import {
  NativeStateService,
  RuntimeService,
  RuntimeSessionService,
  WorkspaceService,
  seedDefaults,
  type NewRuntimeInput,
} from "./services.js";
import type { Runtime } from "./types.js";
import { opencodeAdapter } from "../../runtimes/src/opencode.js";
import { piAdapter } from "../../runtimes/src/pi.js";
import { codexAdapter } from "../../runtimes/src/codex.js";
import { codexThreadSource } from "../../runtimes/src/codexAppServer.js";
import { claudeCodeAdapter } from "../../runtimes/src/claudecode.js";
import { claudeCodeThreadSource } from "../../runtimes/src/claudeCodeThreads.js";
import { mockAdapter } from "../../runtimes/src/mock.js";
import { createDockerContainerOps } from "../../runtimes/src/docker.js";
import {
  FAKE_CLAUDE_SCRIPT,
  FAKE_CODEX_SCRIPT,
  FAKE_DOCKER_SCRIPT,
  FAKE_OPENCODE_SCRIPT,
  FAKE_PI_SCRIPT,
} from "./fakes.js";
import type { Run } from "./types.js";

export interface Fixtures {
  dir: string;
  fakeOpenCode: string;
  fakePi: string;
  fakeDocker: string;
  fakeCodex: string;
  fakeClaude: string;
  dockerLog: string;
  /** Claude Code home shared by the fake CLI and the thread source. */
  claudeHome: string;
  /** Transcript root: $claudeHome/projects (real ~/.claude/projects layout). */
  claudeProjects: string;
}

function writeExecutable(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  chmodSync(p, 0o755);
  return p;
}

export function makeFixtures(): Fixtures {
  const dir = mkdtempSync(join(tmpdir(), "af-fixtures-"));
  const claudeHome = join(dir, "claude-home");
  return {
    dir,
    fakeOpenCode: writeExecutable(dir, "fake-opencode.mjs", FAKE_OPENCODE_SCRIPT),
    fakePi: writeExecutable(dir, "fake-pi.mjs", FAKE_PI_SCRIPT),
    fakeDocker: writeExecutable(dir, "fake-docker.mjs", FAKE_DOCKER_SCRIPT),
    fakeCodex: writeExecutable(dir, "fake-codex.mjs", FAKE_CODEX_SCRIPT),
    fakeClaude: writeExecutable(dir, "fake-claude.mjs", FAKE_CLAUDE_SCRIPT),
    dockerLog: join(dir, "docker-calls.log"),
    claudeHome,
    claudeProjects: join(claudeHome, "projects"),
  };
}

/**
 * Point the adapters at the fakes and reset the docker call log.
 * `unset` removes env vars for the duration (e.g. AGENTFABRIC_PI_IMAGE
 * when a test asserts the no-image policy while the outer shell has one
 * configured).
 */
export function useBins(fx: Fixtures, extra: Record<string, string> = {}, unset: string[] = []): () => void {
  const saved: Record<string, string | undefined> = {
    AGENTFABRIC_OPENCODE_BIN: process.env.AGENTFABRIC_OPENCODE_BIN,
    AGENTFABRIC_PI_BIN: process.env.AGENTFABRIC_PI_BIN,
    AGENTFABRIC_CODEX_BIN: process.env.AGENTFABRIC_CODEX_BIN,
    AGENTFABRIC_CLAUDE_BIN: process.env.AGENTFABRIC_CLAUDE_BIN,
    AGENTFABRIC_CLAUDE_PROJECTS_DIR: process.env.AGENTFABRIC_CLAUDE_PROJECTS_DIR,
    AGENTFABRIC_DOCKER_BIN: process.env.AGENTFABRIC_DOCKER_BIN,
    AGENTFABRIC_PI_IMAGE: process.env.AGENTFABRIC_PI_IMAGE,
    AGENTFABRIC_OPENCODE_IMAGE: process.env.AGENTFABRIC_OPENCODE_IMAGE,
    FAKE_DOCKER_LOG: process.env.FAKE_DOCKER_LOG,
    FAKE_CODEX_HOME: process.env.FAKE_CODEX_HOME,
    FAKE_CODEX_THREADS_FILE: process.env.FAKE_CODEX_THREADS_FILE,
    FAKE_CODEX_DUMP: process.env.FAKE_CODEX_DUMP,
    FAKE_CODEX_SCENARIO: process.env.FAKE_CODEX_SCENARIO,
    FAKE_CODEX_LOGGED_OUT: process.env.FAKE_CODEX_LOGGED_OUT,
    FAKE_CLAUDE_HOME: process.env.FAKE_CLAUDE_HOME,
    FAKE_CLAUDE_DUMP: process.env.FAKE_CLAUDE_DUMP,
    FAKE_CLAUDE_SCENARIO: process.env.FAKE_CLAUDE_SCENARIO,
    FAKE_CLAUDE_LOGGED_OUT: process.env.FAKE_CLAUDE_LOGGED_OUT,
    ...Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]])),
  };
  process.env.AGENTFABRIC_OPENCODE_BIN = fx.fakeOpenCode;
  process.env.AGENTFABRIC_PI_BIN = fx.fakePi;
  process.env.AGENTFABRIC_CODEX_BIN = fx.fakeCodex;
  process.env.AGENTFABRIC_DOCKER_BIN = fx.fakeDocker;
  process.env.FAKE_DOCKER_LOG = fx.dockerLog;
  // Isolated per-test codex state: session store + threads fixture live in
  // the fixtures dir unless a test overrides them.
  process.env.FAKE_CODEX_HOME ??= fx.dir;
  // Claude Code: the fake CLI and the discovery thread source share one
  // fake ~/.claude tree so sessions created by runs are discoverable and
  // fixture sessions are resumable (v7 §9/§10).
  process.env.AGENTFABRIC_CLAUDE_BIN = fx.fakeClaude;
  process.env.AGENTFABRIC_CLAUDE_PROJECTS_DIR = fx.claudeProjects;
  process.env.FAKE_CLAUDE_HOME = fx.claudeHome;
  if (!process.env.FAKE_CODEX_THREADS_FILE) delete process.env.FAKE_CODEX_THREADS_FILE;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  for (const k of unset) delete process.env[k];
  writeFileSync(fx.dockerLog, "");
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export function dockerCalls(fx: Fixtures): string[][] {
  return readFileSync(fx.dockerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

export interface Harness {
  store: Store;
  runService: RunService;
  runtimes: RuntimeService;
  workspaces: WorkspaceService;
  runtimeSessions: RuntimeSessionService;
  nativeStates: NativeStateService;
}

/**
 * Deterministic offline summarization for suites that do not inject their
 * own `completionFactory`. Without it the default HTTP client would call
 * the seeded (keyless) OpenAI provider — slow, network-dependent, and now
 * a hard error instead of a silent fallback. Tests that exercise a failing
 * or degraded summary pass their own factory.
 */
const TEST_CHECKPOINT = `## Goal
Continue the task described by the covered runs.

## Progress
### Done
- [x] Work recorded in the covered runs

### In Progress
- [ ] Finish the remaining work

## Next Steps
1. Continue the work and verify the result`;

export const testCompletionFactory: CompletionFactory = () => async () => ({
  text: TEST_CHECKPOINT,
  stopReason: "stop" as const,
  usage: { inputTokens: 10, outputTokens: 20 },
});

/**
 * Runtimes created through the harness default to usable in tasks: these
 * suites exercise run semantics, and product-level usability defaults are
 * covered by their own tests. An explicit `usableInTask` in the input
 * still wins.
 */
class HarnessRuntimes extends RuntimeService {
  override async create(input: NewRuntimeInput): Promise<Runtime> {
    return super.create({ usableInTask: true, ...input });
  }
}

export async function freshHarness(opts?: { completionFactory?: CompletionFactory }): Promise<Harness> {
  const store = await Store.open(mkdtempSync(join(tmpdir(), "af-test-")));
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  registry.register(opencodeAdapter);
  registry.register(piAdapter);
  registry.register(codexAdapter);
  registry.register(claudeCodeAdapter);
  await seedDefaults(store);
  // Suites exercise run semantics: mark the seeded runtimes usable for
  // tasks so tests target run behavior, not the product's usability
  // defaults (those are covered by their own tests). Runtimes created
  // through the harness default to usable via HarnessRuntimes below.
  const runtimes = new HarnessRuntimes(store);
  for (const r of runtimes.list()) {
    if (!r.usableInTask) await runtimes.update(r.id, { usableInTask: true });
  }
  // Real docker ops (routed at the fake docker binary by useBins) so
  // keep-alive abort destroys are observable in the docker call log.
  // The codex/claude-code thread sources are the real clients pointed at
  // the fake CLIs / fake ~/.claude tree via env (v6 §6–§8, v7 §9–§10).
  const runService = new RunService(
    store,
    bus,
    registry,
    createDockerContainerOps(),
    opts?.completionFactory ?? testCompletionFactory,
    { codex: codexThreadSource, "claude-code": claudeCodeThreadSource }
  );
  return {
    store,
    runService,
    runtimes,
    workspaces: new WorkspaceService(store),
    runtimeSessions: new RuntimeSessionService(store),
    nativeStates: new NativeStateService(store),
  };
}

export async function waitForRun(runService: RunService, runId: string): Promise<Run> {
  const deadline = Date.now() + 10000;
  let current = runService.get(runId)!;
  while (["pending", "starting", "running"].includes(current.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
    current = runService.get(runId)!;
  }
  return current;
}

export { existsSync, mkdtempSync, join, tmpdir };
export { makeClaudeSessionsFixture, makeCodexThreadsFixture } from "./fakes.js";
