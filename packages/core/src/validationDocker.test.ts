/**
 * Disposable validation runtime — the `docker run` argv it constructs
 * (v11 hardening §6).
 *
 * `validationDocker.ts` is the executor production always uses
 * (`supervisor.ts` defaults to `dockerValidationExecutor`), yet every other
 * suite replaces it through the `validationExecutor` seam and
 * `v11.docker.real.test.ts` skips without a reachable Docker daemon. The one
 * thing that actually decides the container's privileges — the exact argv and
 * environment handed to `docker run` — would otherwise have no automated
 * coverage at all.
 *
 * These tests drive the **real** module with an injected fake `spawn`: every
 * `docker` invocation is captured and asserted, and the step outcomes (exit
 * code, timeout, cancellation) are scripted. No container, no daemon and no
 * Docker installation is required.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventBus } from "./eventbus.js";
import { Store } from "./store.js";
import { RuntimeRegistry, type AgentRuntimeAdapter, type RuntimeContext, type RuntimeResult } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import { ExecutionSupervisor } from "./supervisor.js";
import {
  ProjectService,
  RuntimeService,
  SecretService,
  SourceCredentialService,
  TaskService,
  WorkspaceService,
} from "./services.js";
import { DomainError } from "./errors.js";
import { buildValidationEnvironment, runSandboxedValidation, VALIDATION_BASE_ENV } from "./validation.js";
import {
  DEFAULT_VALIDATION_IMAGE,
  dockerBin,
  dockerValidationExecutor,
  VALIDATION_WORKSPACE_MOUNT,
  validationImage,
  type DockerChildProcess,
  type DockerSpawn,
} from "./validationDocker.js";
import type { Project } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * A host-only secret and a Git credential value: neither may ever appear in
 * a `docker run` argv (v11 hardening §6.1/AC-7, §26 Case C/D).
 */
const HOST_ONLY_CANARY = "AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK";
const LEAK_CANARY = "AGENTFABRIC_TEST_SECRET_DO_NOT_LEAK";

const savedEnv: Record<string, string | undefined> = {};
before(() => {
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    savedEnv[key] = process.env[key];
    process.env[key] = key.includes("AUTHOR") ? "AgentFabric Test" : "af@example.test";
  }
  // Live in *this* process for the whole suite: any test that finds either
  // value in a captured argv is reading host leakage.
  process.env.AGENTFABRIC_HOST_ONLY_SECRET = HOST_ONLY_CANARY;
  process.env.AWS_SECRET_ACCESS_KEY = HOST_ONLY_CANARY;
});
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.AGENTFABRIC_HOST_ONLY_SECRET;
  delete process.env.AWS_SECRET_ACCESS_KEY;
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return String(stdout);
}

/** A local bare repository used as the remote: no network, no auth server. */
async function makeRemote(): Promise<string> {
  const root = tempDir("af-vd-remote-");
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await git(seed, ["init", "--quiet"]);
  await git(seed, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--quiet", "-m", "initial commit"]);
  const remote = join(root, "remote.git");
  await git(root, ["clone", "--quiet", "--bare", seed, remote]);
  return remote;
}

/* ================================================================== */
/* A fake `docker` CLI good enough for the executor contract           */
/* ================================================================== */

interface DockerCall {
  command: string;
  args: string[];
}

/** One scripted `docker` invocation: what it prints and how it exits. */
interface ScriptedCall {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** Emit `error` instead of `close` (the binary could not be launched). */
  spawnError?: string;
  /** Never exit on its own; only a SIGKILL from the executor ends it. */
  hang?: boolean;
}

type FakeChild = EventEmitter & DockerChildProcess & { stdout: EventEmitter; stderr: EventEmitter };

/**
 * An `EventEmitter` shaped like the subset of `ChildProcess` the executor
 * touches. Each call is scripted, and the argv it was spawned with is
 * recorded — that recording is the actual subject of this suite.
 */
class FakeDocker {
  readonly calls: DockerCall[] = [];
  readonly signals: Array<{ index: number; signal: NodeJS.Signals | undefined }> = [];
  private readonly script: ScriptedCall[];

  constructor(script: ScriptedCall[] = []) {
    this.script = script;
  }

  /** Every `docker run` invocation, in order (one per validation step). */
  runCalls(): DockerCall[] {
    return this.calls.filter((c) => c.args[0] === "run");
  }

  /** `docker rm -f` invocations (the cleanup path). */
  cleanupCalls(): DockerCall[] {
    return this.calls.filter((c) => c.args[0] === "rm");
  }

  /** The `-e KEY=VALUE` pairs of one argv, split at the first `=`. */
  static envPairs(args: string[]): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    for (const token of FakeDocker.rawEnvTokens(args)) {
      const eq = token.indexOf("=");
      if (eq === -1) continue;
      pairs.push([token.slice(0, eq), token.slice(eq + 1)]);
    }
    return pairs;
  }

  /** The raw values passed to `-e` (the form docker actually interprets). */
  static rawEnvTokens(args: string[]): string[] {
    const tokens: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "-e" || args[i] === "--env") tokens.push(args[i + 1] ?? "");
    }
    return tokens;
  }

  /** The `-v`/`--volume` mounts of one argv. */
  static mounts(args: string[]): string[] {
    const mounts: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "-v" || args[i] === "--volume") mounts.push(args[i + 1] ?? "");
    }
    return mounts;
  }

  /** The container name of one `docker run` argv. */
  static containerName(args: string[]): string {
    const name = args[args.indexOf("--name") + 1];
    assert.ok(name, "the argv carries a --name");
    return name;
  }

  readonly spawnImpl: DockerSpawn = (command, args, _options) => {
    const index = this.calls.length;
    this.calls.push({ command, args: [...args] });
    const step = this.script[index] ?? { exitCode: 0 };
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal?: NodeJS.Signals): boolean => {
      this.signals.push({ index, signal });
      // A killed client closes with a null code, like the real one.
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    // The pipes are read only after `spawn` returns, so the script is
    // emitted on a microtask.
    queueMicrotask(() => {
      if (step.spawnError !== undefined) {
        child.emit("error", new Error(step.spawnError));
        return;
      }
      if (step.stdout) child.stdout.emit("data", Buffer.from(step.stdout));
      if (step.stderr) child.stderr.emit("data", Buffer.from(step.stderr));
      if (step.hang) return;
      child.emit("close", step.exitCode === undefined ? 0 : step.exitCode);
    });
    return child;
  };
}

/** Builds the executor under test, backed by a scripted fake `docker`. */
function executorFor(fake: FakeDocker, image?: string) {
  return dockerValidationExecutor({ spawnImpl: fake.spawnImpl })(image);
}

/* ================================================================== */
/* 1. argv construction — the security surface                         */
/* ================================================================== */

describe("validationDocker: the docker run argv it constructs", () => {
  test("the environment is the allowlisted set verbatim — the host env never leaks in", async () => {
    const fake = new FakeDocker([{ stdout: "ok\n", exitCode: 0 }]);
    const workspace = tempDir("af-vd-ws-");
    const env = buildValidationEnvironment({ BUILD_TOKEN: "explicit-secret" });

    const outcome = await executorFor(fake)({
      step: { name: "check", command: "npm test" },
      cwd: workspace,
      env,
      timeoutMs: 30_000,
    });

    assert.equal(outcome.exitCode, 0);
    const args = fake.runCalls()[0]!.args;
    const pairs = FakeDocker.envPairs(args);

    // The host carries these; the container must not see them.
    assert.equal(process.env.AGENTFABRIC_HOST_ONLY_SECRET, HOST_ONLY_CANARY, "the canary is live in this process");
    assert.equal(process.env.AWS_SECRET_ACCESS_KEY, HOST_ONLY_CANARY);
    const argvText = JSON.stringify(args);
    assert.equal(argvText.includes(HOST_ONLY_CANARY), false, "no host-only secret may appear anywhere in the argv");
    for (const forbidden of [
      "AGENTFABRIC_HOST_ONLY_SECRET",
      "AWS_SECRET_ACCESS_KEY",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "AGENTFABRIC_GIT_PASSWORD",
    ]) {
      assert.equal(
        pairs.some(([k]) => k === forbidden),
        false,
        `${forbidden} must not be injected`
      );
    }

    // Exactly the environment the caller built: base allowlist + explicit extra.
    assert.deepEqual(Object.fromEntries(pairs), env);
    assert.deepEqual(
      pairs.map(([k]) => k).sort(),
      [...Object.keys(VALIDATION_BASE_ENV), "BUILD_TOKEN"].sort()
    );
  });

  test("every `-e` is a `KEY=VALUE` literal — never the inheritance form", async () => {
    // `docker run -e KEY` (no `=`) copies KEY from the *client's* environment,
    // which would silently reintroduce host inheritance. The executor builds
    // `KEY=VALUE` for every pair; assert the literal form, not just the names.
    const fake = new FakeDocker([{ exitCode: 0 }]);
    await executorFor(fake)({
      step: { name: "check", command: "true" },
      cwd: tempDir("af-vd-ws-"),
      env: buildValidationEnvironment({ EMPTY_VALUE: "", PADDED: "a=b=c" }),
      timeoutMs: 10_000,
    });

    const tokens = FakeDocker.rawEnvTokens(fake.runCalls()[0]!.args);
    assert.equal(tokens.length, Object.keys(VALIDATION_BASE_ENV).length + 2);
    for (const token of tokens) {
      assert.ok(token.includes("="), `"${token}" must be KEY=VALUE so docker cannot inherit it from the host`);
    }
    // Values pass through untouched, including `=` and the empty string.
    const pairs = Object.fromEntries(FakeDocker.envPairs(fake.runCalls()[0]!.args));
    assert.equal(pairs.PADDED, "a=b=c");
    assert.equal(pairs.EMPTY_VALUE, "");
  });

  test("only explicitly resolved build/test secrets are injected — never a git-scoped one", async () => {
    const store = await Store.open(tempDir("af-vd-sec-"));
    const secrets = new SecretService(store);
    const allowed = await secrets.create({ name: "NPM_TOKEN", value: "allowed-value-1234", scope: "validation" });
    const gitScoped = await secrets.create({ name: "GIT_WRITE_TOKEN", value: LEAK_CANARY, scope: "git" });

    const resolved = secrets.resolve([allowed.id], "validation");
    assert.deepEqual(
      resolved.map((s) => [s.name, s.value]),
      [["NPM_TOKEN", "allowed-value-1234"]]
    );
    // Refused at the resolution boundary, so the value never reaches argv.
    assert.throws(
      () => secrets.resolve([gitScoped.id], "validation"),
      (err: unknown) => (err as DomainError).code === "validation-secret-not-allowed"
    );

    const fake = new FakeDocker([{ exitCode: 0 }]);
    const env = buildValidationEnvironment(Object.fromEntries(resolved.map((s) => [s.name, s.value ?? ""])));
    await executorFor(fake)({ step: { name: "t", command: "true" }, cwd: tempDir("af-vd-ws-"), env, timeoutMs: 10_000 });
    const argvText = JSON.stringify(fake.runCalls()[0]!.args);
    assert.match(argvText, /NPM_TOKEN=allowed-value-1234/);
    assert.equal(argvText.includes(LEAK_CANARY), false, "the git credential value never enters the container argv");
  });

  test("the workspace is the only host path mounted — no socket, no home, no data dir", async () => {
    const fake = new FakeDocker([{ exitCode: 0 }]);
    const workspace = tempDir("af-vd-ws-");

    await executorFor(fake)({
      step: { name: "check", command: "npm test" },
      cwd: workspace,
      env: buildValidationEnvironment(),
      timeoutMs: 10_000,
    });

    const args = fake.runCalls()[0]!.args;
    assert.deepEqual(FakeDocker.mounts(args), [`${workspace}:${VALIDATION_WORKSPACE_MOUNT}:rw`], "exactly one mount");
    assert.equal(args[args.indexOf("-w") + 1], VALIDATION_WORKSPACE_MOUNT, "the working directory is the mount point");
    const argvText = JSON.stringify(args);
    for (const forbidden of ["docker.sock", "/var/run", "/Users", "/root/.ssh", "git-credentials"]) {
      assert.equal(argvText.includes(forbidden), false, `the argv must not mount or reference ${forbidden}`);
    }
  });

  test("the container is disposable, named and labelled, and the step runs through `sh -c`", async () => {
    const fake = new FakeDocker([{ exitCode: 0 }]);
    const step = { name: "typecheck", command: "npm run typecheck -- --strict" };

    await executorFor(fake)({
      step,
      cwd: tempDir("af-vd-ws-"),
      env: buildValidationEnvironment(),
      timeoutMs: 10_000,
    });

    const args = fake.runCalls()[0]!.args;
    assert.equal(args[0], "run");
    assert.ok(args.includes("--rm"), "the container is disposable by construction");
    assert.match(FakeDocker.containerName(args), /^af-validate-[a-z0-9]+-[a-z0-9]+$/, "the container is named");
    assert.equal(args[args.indexOf("--label") + 1], "agentfabric.validation=true", "the container is labelled as validation");
    // The command is `sh -c <command>` after the image, so the repository's
    // own shell semantics hold inside the container.
    assert.equal(args.at(-3), "sh");
    assert.equal(args.at(-2), "-c");
    assert.equal(args.at(-1), step.command);
    assert.equal(args[args.indexOf("sh") - 1], DEFAULT_VALIDATION_IMAGE, "the image precedes the command");
  });

  test("the image is the task runtime's, else the configured default", async () => {
    assert.equal(validationImage(), DEFAULT_VALIDATION_IMAGE);
    assert.equal(validationImage("af-toolchain:latest"), "af-toolchain:latest");
    assert.equal(validationImage("   "), DEFAULT_VALIDATION_IMAGE, "blank falls through to the default");

    const fake = new FakeDocker([{ exitCode: 0 }]);
    await executorFor(fake, "af-toolchain:latest")({
      step: { name: "check", command: "true" },
      cwd: tempDir("af-vd-ws-"),
      env: buildValidationEnvironment(),
      timeoutMs: 10_000,
    });
    const call = fake.runCalls()[0]!;
    assert.equal(call.command, dockerBin(), "the docker binary is invoked directly (no shell wrapper)");
    assert.equal(call.args[call.args.indexOf("sh") - 1], "af-toolchain:latest");
  });

  test("`network.enabled = false` yields `--network none` — validation runs under the Task's egress policy", async () => {
    // Validation commands are untrusted repository code, so they must never
    // have more network than the agent container had. The executor used to
    // have no network knob at all: a project that declared
    // `network.enabled = false` got `--network none` on the agent container
    // but full egress for every validation step.
    const fake = new FakeDocker([{ exitCode: 0 }]);
    await executorFor(fake)({
      step: { name: "check", command: "npm test" },
      cwd: tempDir("af-vd-ws-"),
      env: buildValidationEnvironment(),
      network: { enabled: false },
      timeoutMs: 10_000,
    });
    const args = fake.runCalls()[0]!.args;
    assert.equal(args[args.indexOf("--network") + 1], "none");
  });

  test("an enabled (or absent) network policy leaves docker's default networking", async () => {
    // The flip side: `enabled: true` and "nothing configured anywhere" both
    // mean docker's default bridge. `enabled: false` is the only value that
    // restricts, matching runtimes/docker.ts exactly.
    for (const network of [{ enabled: true }, undefined] as const) {
      const fake = new FakeDocker([{ exitCode: 0 }]);
      await executorFor(fake)({
        step: { name: "check", command: "npm test" },
        cwd: tempDir("af-vd-ws-"),
        env: buildValidationEnvironment(),
        network,
        timeoutMs: 10_000,
      });
      const args = fake.runCalls()[0]!.args;
      assert.equal(args.includes("--network"), false, `network=${JSON.stringify(network)} must not restrict`);
      assert.equal(args.includes("--net"), false);
    }
  });
});

/* ================================================================== */
/* 2. Step outcomes through the real runner                            */
/* ================================================================== */

describe("validationDocker: step outcomes recorded by the real runner", () => {
  test("a passing step records status / exitCode / durationMs / output", async () => {
    const fake = new FakeDocker([{ stdout: "all good\n", stderr: "warning\n", exitCode: 0 }]);
    const result = await runSandboxedValidation(
      { cwd: tempDir("af-vd-run-"), steps: [{ name: "unit", command: "npm test" }], env: {} },
      executorFor(fake)
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.steps.map((s) => [s.name, s.status, s.exitCode]), [["unit", "passed", 0]]);
    const step = result.steps[0]!;
    assert.equal(step.command, "npm test");
    assert.equal(step.output, "all good\nwarning\n", "stdout and stderr are both kept");
    assert.equal(typeof step.durationMs, "number");
    assert.ok(step.durationMs! >= 0);
    assert.equal(fake.calls.length, 1, "one container, one step");
  });

  test("a non-zero exit is a failing step with its exit code and output", async () => {
    const fake = new FakeDocker([{ stdout: "ok\n", exitCode: 0 }, { stderr: "type error TS2345\n", exitCode: 2 }, { exitCode: 0 }]);
    const result = await runSandboxedValidation(
      {
        cwd: tempDir("af-vd-run-"),
        steps: [
          { name: "lint", command: "npm run lint" },
          { name: "typecheck", command: "npm run typecheck" },
          { name: "build", command: "npm run build" },
        ],
        env: {},
      },
      executorFor(fake)
    );

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "validation-failed");
    assert.match(result.error!, /typecheck/);
    assert.deepEqual(
      result.steps.map((s) => [s.name, s.status, s.exitCode]),
      [
        ["lint", "passed", 0],
        ["typecheck", "failed", 2],
      ],
      "a required failure stops the remaining steps"
    );
    assert.match(result.steps[1]!.output!, /type error TS2345/);
    assert.equal(fake.runCalls().length, 2, "the third step never started a container");
  });

  test("a step that finishes inside its budget is not misread as a timeout", async () => {
    // Regression: the executor used to compare wall-clock `elapsed` against
    // the budget as a second timeout signal. Date.now() is millisecond-
    // granular, so a step finishing exactly on the boundary was reported as
    // a timeout with `exitCode: null`, throwing away a passing result.
    const fake = new FakeDocker([{ stdout: "ALL TESTS PASSED\n", exitCode: 0 }]);
    const result = await runSandboxedValidation(
      { cwd: tempDir("af-vd-run-"), steps: [{ name: "unit", command: "npm test", timeoutMs: 0 }], env: {} },
      executorFor(fake)
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.steps.map((s) => [s.name, s.status, s.exitCode]), [["unit", "passed", 0]]);
    assert.equal(fake.cleanupCalls().length, 0, "a finished step is not reaped as if it had timed out");
  });

  test("a step that runs out of budget is a timeout — and the container is removed", async () => {
    const fake = new FakeDocker([{ hang: true }, { exitCode: 0 }]);
    const result = await runSandboxedValidation(
      { cwd: tempDir("af-vd-run-"), steps: [{ name: "slow", command: "npm test", timeoutMs: 40 }], env: {} },
      executorFor(fake)
    );

    assert.equal(result.status, "timeout");
    assert.equal(result.errorCode, "validation-timeout");
    assert.match(result.error!, /timed out/);
    assert.deepEqual(result.steps.map((s) => [s.name, s.status, s.exitCode]), [["slow", "timeout", null]]);
    // The killed client may leave the container behind, so the executor removes it.
    const cleanup = fake.cleanupCalls();
    assert.equal(cleanup.length, 1, `exactly one cleanup (calls: ${JSON.stringify(fake.calls)})`);
    assert.deepEqual(cleanup[0]!.args, ["rm", "-f", FakeDocker.containerName(fake.runCalls()[0]!.args)]);
    assert.equal(fake.signals.length > 0, true, "the hung client was killed");
  });

  test("the runner keeps only the output tail", async () => {
    const fake = new FakeDocker([{ stdout: `${"x".repeat(4500)}END`, exitCode: 0 }]);
    const result = await runSandboxedValidation(
      { cwd: tempDir("af-vd-run-"), steps: [{ name: "noisy", command: "npm test" }], env: {} },
      executorFor(fake)
    );
    const output = result.steps[0]!.output!;
    assert.equal(result.status, "passed");
    assert.equal(output.length, 4000, "validation.ts retains the last 4000 chars");
    assert.match(output, /END$/);
  });

  test("cancellation stops the container and is reported as a runtime failure", async () => {
    const fake = new FakeDocker([{ hang: true }, { exitCode: 0 }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const outcome = await executorFor(fake)({
      step: { name: "check", command: "npm test" },
      cwd: tempDir("af-vd-ws-"),
      env: buildValidationEnvironment(),
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.timedOut, false, "an abort is not a timeout");
    assert.equal(outcome.errorCode, "validation-runtime-failed");
    assert.match(outcome.error!, /cancelled/i);
    assert.equal(fake.cleanupCalls().length, 1, "the cancelled container is removed");
    assert.equal(fake.signals.length > 0, true, "the client was signalled");
  });

  test("an unrunnable docker is a runtime failure, not a failing test", async () => {
    const missingBinary = new FakeDocker([{ spawnError: "spawn docker ENOENT" }]);
    const outcome = await executorFor(missingBinary)({
      step: { name: "check", command: "npm test" },
      cwd: tempDir("af-vd-ws-"),
      env: buildValidationEnvironment(),
      timeoutMs: 10_000,
    });
    assert.equal(outcome.exitCode, -1);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.errorCode, "validation-runtime-unavailable");
    assert.match(outcome.error!, /could not start/);

    const noDaemon = new FakeDocker([
      { stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n", exitCode: 125 },
    ]);
    const result = await runSandboxedValidation(
      { cwd: tempDir("af-vd-run-"), steps: [{ name: "check", command: "npm test" }], env: {} },
      executorFor(noDaemon)
    );
    // The sandbox never started, so the code survives the runner intact: the
    // API maps `validation-runtime-unavailable` to 502 (retry the runtime),
    // not to `validation-failed`'s 400 (go fix a test that never ran).
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "validation-runtime-unavailable");
    assert.match(result.error!, /isolated validation runtime could not start/);
    assert.match(result.error!, /Cannot connect to the Docker daemon/);
    assert.deepEqual(result.steps.map((s) => [s.name, s.status, s.exitCode]), [["check", "failed", 125]]);
    assert.equal(noDaemon.runCalls().length, 1);
  });
});

/* ================================================================== */
/* 3. The production wiring: a Project Coding Task's validation        */
/* ================================================================== */

interface Harness {
  store: Store;
  supervisor: ExecutionSupervisor;
  projects: ProjectService;
  runtimes: RuntimeService;
  tasks: TaskService;
  workspaces: WorkspaceService;
  secrets: SecretService;
  credentials: SourceCredentialService;
  setAgent: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
}

/**
 * A supervisor whose validation executor is the **real** disposable-container
 * executor — only its process launcher is faked, and the agent is scripted.
 * Every other suite injects a fake `SandboxedStepExecutor`, which is exactly
 * the gap this file closes.
 */
async function makeHarness(fake: FakeDocker): Promise<Harness> {
  const store = await Store.open(tempDir("af-vd-data-"));
  const bus = new EventBus();
  const state: { handler: (ctx: RuntimeContext) => Promise<RuntimeResult> } = {
    handler: async () => ({ exitCode: 0 }),
  };
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
  const runService = new RunService(store, bus, registry, { destroy: async () => {} });
  const supervisor = new ExecutionSupervisor(store, bus, runService, {
    validationExecutor: (image?: string) => dockerValidationExecutor({ spawnImpl: fake.spawnImpl })(image),
  });
  return {
    store,
    supervisor,
    projects: new ProjectService(store),
    runtimes: new RuntimeService(store),
    tasks: new TaskService(store),
    workspaces: new WorkspaceService(store),
    secrets: new SecretService(store),
    credentials: new SourceCredentialService(store),
    setAgent: (handler) => {
      state.handler = handler;
    },
  };
}

function writeFile(rel: string, content: string) {
  return async (ctx: RuntimeContext): Promise<RuntimeResult> => {
    const abs = join(ctx.workspacePath!, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    return { exitCode: 0 };
  };
}

describe("validationDocker: the production path (supervisor → real executor → argv)", () => {
  test("a Project task's validation container gets the allowlist, the task env and the allowed secret — nothing else", async () => {
    const fake = new FakeDocker([{ stdout: "ok\n", exitCode: 0 }]);
    const h = await makeHarness(fake);
    const credential = await h.credentials.create({ name: "Deploy credential", type: "https-token", value: LEAK_CANARY });
    const buildSecret = await h.secrets.create({ name: "NPM_TOKEN", value: "built-in-secret-9999", scope: "validation" });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: await makeRemote(), credentialId: credential.id },
      validation: { steps: [{ name: "unit", command: "npm test" }] },
      execution: { validationSecretIds: [buildSecret.id] },
    });
    const runtime = await h.runtimes.create({
      name: "Isolated toolchain",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-toolchain:latest",
    });
    h.setAgent(writeFile("feature.txt", "done\n"));

    const started = await h.supervisor.startTask({
      projectId: project.id,
      instruction: "Add a feature",
      runtimeId: runtime.id,
      env: { BUILD_FLAVOR: "ci" },
    });
    await h.supervisor.whenSettled(started.task.id);
    const task = h.tasks.get(started.task.id)!;
    assert.equal(task.execution!.validation!.status, "passed", JSON.stringify(task.execution!.validation));

    const runCalls = fake.runCalls();
    assert.equal(runCalls.length, 1, "one container for the one step");
    const args = runCalls[0]!.args;
    assert.deepEqual(Object.fromEntries(FakeDocker.envPairs(args)), {
      ...VALIDATION_BASE_ENV,
      BUILD_FLAVOR: "ci",
      NPM_TOKEN: "built-in-secret-9999",
    });
    // The runtime's image is the one that ran the validation...
    assert.equal(args[args.indexOf("sh") - 1], "af-toolchain:latest");
    // ...and the workspace really is this task's mounted path.
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    assert.deepEqual(FakeDocker.mounts(args), [`${workspacePath}:${VALIDATION_WORKSPACE_MOUNT}:rw`]);

    const everyArgv = JSON.stringify(fake.calls.map((c) => c.args));
    assert.equal(everyArgv.includes(LEAK_CANARY), false, "the Git credential never reaches the container");
    assert.equal(everyArgv.includes(HOST_ONLY_CANARY), false, "no host-only secret reaches the container");
  });

  test("each step gets its own fresh container", async () => {
    const fake = new FakeDocker([{ exitCode: 0 }, { exitCode: 0 }]);
    const h = await makeHarness(fake);
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: await makeRemote() },
      validation: {
        steps: [
          { name: "lint", command: "npm run lint" },
          { name: "test", command: "npm test" },
        ],
      },
    });
    const runtime = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFile("x.txt", "x\n"));

    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: runtime.id });
    await h.supervisor.whenSettled(started.task.id);
    assert.equal(h.tasks.get(started.task.id)!.execution!.validation!.status, "passed");

    const runs = fake.runCalls();
    assert.equal(runs.length, 2, "one container per step");
    const names = runs.map((c) => FakeDocker.containerName(c.args));
    assert.notEqual(names[0], names[1], "the containers are distinct");
    for (const call of runs) {
      assert.ok(call.args.includes("--rm"), "each container is disposable");
      assert.deepEqual(
        FakeDocker.envPairs(call.args).map(([k]) => k).sort(),
        Object.keys(VALIDATION_BASE_ENV).sort(),
        "no task env configured means exactly the base allowlist"
      );
    }
    assert.equal(runs[0]!.args.at(-1), "npm run lint");
    assert.equal(runs[1]!.args.at(-1), "npm test");
  });

  test("the Project's `network.enabled = false` reaches the validation container as `--network none`", async () => {
    const fake = new FakeDocker([{ stdout: "ok\n", exitCode: 0 }]);
    const h = await makeHarness(fake);
    const project = await h.projects.create({
      name: "Air-gapped",
      source: { remoteUrl: await makeRemote() },
      validation: { steps: [{ name: "unit", command: "npm test" }] },
      execution: { networkPolicy: { enabled: false } },
    });
    const runtime = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFile("x.txt", "x\n"));

    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: runtime.id });
    await h.supervisor.whenSettled(started.task.id);
    assert.equal(h.tasks.get(started.task.id)!.execution!.validation!.status, "passed");

    const runs = fake.runCalls();
    assert.equal(runs.length, 1, "one container for the one step");
    const args = runs[0]!.args;
    assert.equal(args[args.indexOf("--network") + 1], "none", "untrusted validation code gets no egress");
  });

  test("a Task-level network override wins for validation too, exactly as it did for the agent", async () => {
    const fake = new FakeDocker([{ exitCode: 0 }]);
    const h = await makeHarness(fake);
    const project = await h.projects.create({
      name: "Air-gapped",
      source: { remoteUrl: await makeRemote() },
      validation: { steps: [{ name: "unit", command: "npm test" }] },
      execution: { networkPolicy: { enabled: false } },
    });
    const runtime = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFile("x.txt", "x\n"));

    const started = await h.supervisor.startTask({
      projectId: project.id,
      instruction: "work",
      runtimeId: runtime.id,
      // The Task explicitly re-enables egress; validation must follow the
      // same precedence (Task > Project) the agent container followed.
      policy: { network: { enabled: true } },
    });
    await h.supervisor.whenSettled(started.task.id);

    const args = fake.runCalls()[0]!.args;
    assert.equal(args.includes("--network"), false, "the Task's override is honored, not the Project's default");
  });

  test("a git-scoped secret named for validation is refused before any container exists", async () => {
    const fake = new FakeDocker();
    const h = await makeHarness(fake);
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: await makeRemote() },
      validation: { steps: [{ name: "t", command: "true" }] },
    });
    const runtime = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    const gitScoped = await h.secrets.create({ name: "GIT_WRITE", value: LEAK_CANARY, scope: "git" });

    await assert.rejects(
      () =>
        h.supervisor.startTask({
          projectId: project.id,
          instruction: "work",
          runtimeId: runtime.id,
          validationSecretIds: [gitScoped.id],
        }),
      (err: unknown) => (err as DomainError).code === "validation-secret-not-allowed"
    );
    assert.equal(h.tasks.list().length, 0, "the task was never created");
    assert.equal(fake.calls.length, 0, "no container, and no docker call at all, was made");
  });

  test("a failing step reaches the task record with its exit code, output and duration", async () => {
    const fake = new FakeDocker([{ stdout: "1 passing\n", exitCode: 0 }, { stderr: "FAIL src/x.test.ts\n", exitCode: 1 }]);
    const h = await makeHarness(fake);
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: await makeRemote() },
      validation: {
        steps: [
          { name: "lint", command: "npm run lint" },
          { name: "test", command: "npm test" },
        ],
      },
    });
    const runtime = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFile("x.txt", "x\n"));

    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: runtime.id });
    await h.supervisor.whenSettled(started.task.id);
    const task = h.tasks.get(started.task.id)!;
    const validation = task.execution!.validation!;

    assert.equal(validation.status, "failed");
    assert.equal(validation.errorCode, "validation-failed");
    assert.deepEqual(
      validation.steps!.map((s) => [s.name, s.status, s.exitCode]),
      [
        ["lint", "passed", 0],
        ["test", "failed", 1],
      ]
    );
    assert.match(validation.steps![1]!.output!, /FAIL src\/x\.test\.ts/);
    for (const step of validation.steps!) {
      assert.equal(typeof step.durationMs, "number", `${step.name} recorded a duration`);
    }
    // The agent's own work is untouched: a validation failure is its own stage.
    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.stages!.agent!.status, "completed");
    assert.equal(task.execution!.stages!.validation!.status, "failed");
    assert.equal(task.execution!.publish!.status, "pending", "nothing is published after a failed validation");
    assert.equal(fake.runCalls().length, 2, "the failing step's container was the last one started");
  });

  test("a step that hangs past its budget times the task out and reaps the container", async () => {
    const fake = new FakeDocker([{ hang: true }, { exitCode: 0 }]);
    const h = await makeHarness(fake);
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: await makeRemote() },
      validation: { steps: [{ name: "slow", command: "npm test", timeoutMs: 60 }] },
    });
    const runtime = await h.runtimes.create({
      name: "Isolated",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test:latest",
    });
    h.setAgent(writeFile("x.txt", "x\n"));

    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: runtime.id });
    await h.supervisor.whenSettled(started.task.id);
    const task = h.tasks.get(started.task.id)!;
    const validation = task.execution!.validation!;

    assert.equal(validation.status, "timeout");
    assert.equal(validation.errorCode, "validation-timeout");
    assert.deepEqual(validation.steps!.map((s) => [s.name, s.status, s.exitCode]), [["slow", "timeout", null]]);
    assert.equal(
      fake.cleanupCalls().length,
      1,
      `the timed-out container was removed (calls: ${JSON.stringify(fake.calls.map((c) => c.args))})`
    );
    assert.equal(task.execution!.agent!.status, "completed", "the agent still completed");
  });
});
