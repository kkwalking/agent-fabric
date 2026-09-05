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
import { RunService } from "./orchestrator.js";
import {
  NativeStateService,
  RuntimeService,
  RuntimeSessionService,
  WorkspaceService,
  seedDefaults,
} from "./services.js";
import { opencodeAdapter } from "../../runtimes/src/opencode.js";
import { piAdapter } from "../../runtimes/src/pi.js";
import { mockAdapter } from "../../runtimes/src/mock.js";
import { FAKE_DOCKER_SCRIPT, FAKE_OPENCODE_SCRIPT, FAKE_PI_SCRIPT } from "./fakes.js";
import type { Run } from "./types.js";

export interface Fixtures {
  dir: string;
  fakeOpenCode: string;
  fakePi: string;
  fakeDocker: string;
  dockerLog: string;
}

function writeExecutable(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  chmodSync(p, 0o755);
  return p;
}

export function makeFixtures(): Fixtures {
  const dir = mkdtempSync(join(tmpdir(), "af-fixtures-"));
  return {
    dir,
    fakeOpenCode: writeExecutable(dir, "fake-opencode.mjs", FAKE_OPENCODE_SCRIPT),
    fakePi: writeExecutable(dir, "fake-pi.mjs", FAKE_PI_SCRIPT),
    fakeDocker: writeExecutable(dir, "fake-docker.mjs", FAKE_DOCKER_SCRIPT),
    dockerLog: join(dir, "docker-calls.log"),
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
    AGENTFABRIC_DOCKER_BIN: process.env.AGENTFABRIC_DOCKER_BIN,
    AGENTFABRIC_PI_IMAGE: process.env.AGENTFABRIC_PI_IMAGE,
    AGENTFABRIC_OPENCODE_IMAGE: process.env.AGENTFABRIC_OPENCODE_IMAGE,
    FAKE_DOCKER_LOG: process.env.FAKE_DOCKER_LOG,
    ...Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]])),
  };
  process.env.AGENTFABRIC_OPENCODE_BIN = fx.fakeOpenCode;
  process.env.AGENTFABRIC_PI_BIN = fx.fakePi;
  process.env.AGENTFABRIC_DOCKER_BIN = fx.fakeDocker;
  process.env.FAKE_DOCKER_LOG = fx.dockerLog;
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

export async function freshHarness(): Promise<Harness> {
  const store = await Store.open(mkdtempSync(join(tmpdir(), "af-test-")));
  const bus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  registry.register(opencodeAdapter);
  registry.register(piAdapter);
  await seedDefaults(store);
  const runService = new RunService(store, bus, registry);
  return {
    store,
    runService,
    runtimes: new RuntimeService(store),
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
