/**
 * v11 inheritance — the three Project → Task execution defaults the README
 * claims but the supervisor did not actually read:
 *
 *   1. `project.execution.profileId` — the Project's agent profile preset
 *      (runtime / model / policy / env / tools / systemInstructions);
 *   2. `project.execution.networkPolicy` — the Project's default egress policy;
 *   3. `Task.skills` / `Task.mcpServers` — Task-level provisioning overrides
 *      of the Project's lists.
 *
 * Precedence under test is the documented one, in both directions:
 *
 *   Task 显式 > Project > Profile        (runtime / model / policy / presets)
 *   Task 显式 > Project                  (skills / mcpServers / networkPolicy)
 *
 * Two carriers prove the wiring end to end:
 *
 * - a **scripted harness** (the v11 suite's adapter) for everything the
 *   runtime context exposes — resolved policy, provisioning env/mounts,
 *   resolved runtime and model;
 * - the **real docker adapter + the fake docker CLI** for the claim that the
 *   Project's network policy actually reaches the container argv
 *   (`--network none`), not merely the resolved policy object.
 *
 * Git is the real `git` CLI against local bare repositories, exactly as in
 * the other v11 suites. Nothing here touches the network or a Docker daemon.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventBus } from "./eventbus.js";
import { Store } from "./store.js";
import { RuntimeRegistry, type AgentRuntimeAdapter, type RuntimeContext, type RuntimeResult } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import { ExecutionSupervisor } from "./supervisor.js";
import { ProjectService, ProfileService, RuntimeService, TaskService, WorkspaceService } from "./services.js";
import { DomainError } from "./errors.js";
import { MCP_CONFIG_ENV_VAR, SKILLS_ENV_VAR } from "./provisioning.js";
import { dockerCalls, makeFixtures, useBins } from "./testkit.js";
import { dockerAdapter } from "../../runtimes/src/docker.js";
import type { Project, Run, Task } from "./types.js";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Git fixtures: a local bare repository is a real remote.             */
/* ------------------------------------------------------------------ */

const savedEnv: Record<string, string | undefined> = {};
before(() => {
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.GIT_AUTHOR_NAME = "AgentFabric Test";
  process.env.GIT_AUTHOR_EMAIL = "af@example.test";
  process.env.GIT_COMMITTER_NAME = "AgentFabric Test";
  process.env.GIT_COMMITTER_EMAIL = "af@example.test";
});
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return String(stdout);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A local bare repository with one commit on `main` — a valid git remote. */
async function makeRemote(): Promise<{ remote: string }> {
  const root = tempDir("af-v11i-remote-");
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await git(seed, ["init", "--quiet"]);
  await git(seed, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--quiet", "-m", "initial commit"]);
  const remote = join(root, "remote.git");
  await git(root, ["clone", "--quiet", "--bare", seed, remote]);
  return { remote };
}

/* ------------------------------------------------------------------ */
/* Harness                                                              */
/* ------------------------------------------------------------------ */

interface ScriptedHarness {
  adapter: AgentRuntimeAdapter;
  runs: () => number;
  contexts: RuntimeContext[];
  setHandler: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
}

/** A scripted agent harness: the test decides what the "agent" does. */
function scriptedHarness(): ScriptedHarness {
  let runs = 0;
  const contexts: RuntimeContext[] = [];
  // Provisioning is removed at cleanup, so anything a test needs to inspect
  // about it has to be read *while the run is live* — that is what the
  // handler seam is for.
  let handler: (ctx: RuntimeContext) => Promise<RuntimeResult> = async (ctx) => {
    writeFileSync(join(ctx.workspacePath!, `${ctx.run.id}.txt`), "work\n");
    return { exitCode: 0 };
  };
  const adapter: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Scripted harness",
    capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
    async run(ctx): Promise<RuntimeResult> {
      runs += 1;
      contexts.push(ctx);
      return handler(ctx);
    },
  };
  return { adapter, runs: () => runs, contexts, setHandler: (next) => { handler = next; } };
}

interface Harness {
  store: Store;
  bus: EventBus;
  registry: RuntimeRegistry;
  runService: RunService;
  supervisor: ExecutionSupervisor;
  scripted: ScriptedHarness;
  projects: ProjectService;
  profiles: ProfileService;
  tasks: TaskService;
  runtimes: RuntimeService;
  /** The isolated scripted runtime every task defaults to. */
  runtimeId: string;
}

async function makeHarness(): Promise<Harness> {
  const store = await Store.open(tempDir("af-v11i-data-"));
  const bus = new EventBus();
  const scripted = scriptedHarness();
  const registry = new RuntimeRegistry();
  registry.register(scripted.adapter);
  registry.register(dockerAdapter);
  const runService = new RunService(store, bus, registry, { destroy: async () => {} }, undefined, {});
  const supervisor = new ExecutionSupervisor(store, bus, runService, {
    // Validation is exercised by its own suites; these tests configure no
    // validation steps, so this executor is never reached.
    validationExecutor: () => async () => ({ exitCode: 0, timedOut: false, output: "" }),
  });
  const runtimes = new RuntimeService(store);
  // The isolation gate (v11 hardening §4) reads capability metadata, not the
  // kind: the scripted adapter is wired to a container-backed declaration.
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
    registry,
    runService,
    supervisor,
    scripted,
    projects: new ProjectService(store),
    profiles: new ProfileService(store),
    tasks: new TaskService(store),
    runtimes,
    runtimeId: runtime.id,
  };
}

/** Starts a Task and waits for its lifecycle to settle. */
async function startTask(
  h: Harness,
  project: Project,
  input: Partial<Parameters<ExecutionSupervisor["startTask"]>[0]> = {}
): Promise<{ task: Task; run: Run }> {
  const result = await h.supervisor.startTask({
    projectId: project.id,
    instruction: "Add a feature",
    runtimeId: h.runtimeId,
    ...input,
  });
  await h.supervisor.whenSettled(result.task.id);
  return { task: h.tasks.get(result.task.id)!, run: h.runService.get(result.run.id)! };
}

/* ================================================================== */
/* 1. project.execution.profileId                                      */
/* ================================================================== */

describe("v11 inheritance: project.execution.profileId", () => {
  test("a Project's profile preset applies to its Tasks (runtime / model / policy / instructions)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const other = await h.runtimes.create({
      name: "Profile runtime",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test-profile:latest",
    });
    const profile = await h.profiles.create({
      name: "Careful reviewer",
      runtimeId: other.id,
      systemInstructions: "You are a careful reviewer.",
      tools: ["read"],
      env: { PROFILE_ENV: "from-profile" },
      policy: { maxTokens: 4242, shell: "deny" },
    });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { profileId: profile.id },
    });

    // No task-level runtimeId: the profile's preset is the configured source.
    const result = await h.supervisor.startTask({ projectId: project.id, instruction: "work" });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    const run = h.runService.get(result.run.id)!;

    assert.equal(task.profileId, profile.id, "the Project's profile is materialized onto the Task");
    assert.equal(task.runtimeId, other.id, "the profile's runtime preset is used when nothing overrides it");
    assert.equal(run.profileId, profile.id);
    // The profile's system instructions are snapshotted onto the Run (v4 §10).
    assert.equal(run.systemInstructions, "You are a careful reviewer.");

    const ctx = h.scripted.contexts.at(-1)!;
    // The profile's policy is the lowest configured layer — present here
    // because nothing else configured shell / maxTokens.
    assert.equal(ctx.policy?.shell, "deny");
    assert.equal(ctx.policy?.maxTokens, 4242);
    // Profile tools join the effective allowlist (v4 §11)…
    assert.deepEqual(ctx.policy?.toolPermissions, ["read"]);
    // …and the profile's env reaches the runtime environment.
    assert.equal(ctx.env.PROFILE_ENV, "from-profile");
    assert.equal(task.execution!.status, "completed");
  });

  test("an explicit Task profile wins over the Project's", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const projectProfile = await h.profiles.create({ name: "Project default", systemInstructions: "PROJECT-PROFILE" });
    const taskProfile = await h.profiles.create({ name: "Task choice", systemInstructions: "TASK-PROFILE" });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { profileId: projectProfile.id },
    });

    const { task, run } = await startTask(h, project, { profileId: taskProfile.id });
    assert.equal(task.profileId, taskProfile.id);
    assert.equal(run.systemInstructions, "TASK-PROFILE");
  });

  test("Task > Project > Profile: neither an explicit runtime nor an explicit model is overridden by the profile", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    // A real, resolvable stack for the profile's presets — a dangling preset
    // is a loud failure, so the presets must exist to be *loseable*.
    const presetRuntime = await h.runtimes.create({
      name: "Preset runtime",
      kind: "custom",
      usableInTask: true,
      enabled: true,
      containerized: true,
      executionBackend: "isolated",
      image: "af-test-preset:latest",
    });
    const { ModelService, ProviderService } = await import("./services.js");
    const provider = await new ProviderService(h.store).create({ name: "Preset provider", type: "openai-completions" });
    const presetModel = await new ModelService(h.store).create({ providerId: provider.id, name: "preset-model" });
    const projectModel = await new ModelService(h.store).create({ providerId: provider.id, name: "project-model" });
    const profile = await h.profiles.create({
      name: "Preset profile",
      runtimeId: presetRuntime.id,
      modelId: presetModel.id,
      systemInstructions: "PROFILE",
    });

    // The Project names its own runtime and model; the profile's presets must
    // lose to them (Task > Project > Profile), while still contributing
    // everything the higher layers did not set.
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { profileId: profile.id, runtimeId: h.runtimeId, modelId: projectModel.id },
    });

    const { task, run } = await startTask(h, project);
    assert.equal(task.runtimeId, h.runtimeId, "the Project's runtime wins over the profile's preset");
    assert.equal(task.modelId, projectModel.id, "the Project's model wins over the profile's preset");
    assert.equal(run.modelId, projectModel.id);
    assert.equal(run.systemInstructions, "PROFILE");
  });

  test("a profile reference that no longer resolves fails loudly, before any task exists", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { profileId: "prof_deleted" },
    });

    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "x", runtimeId: h.runtimeId }),
      (err: unknown) => (err as DomainError).code === "profile-not-found"
    );
    // A task-level reference to a missing profile is the same loud failure.
    await assert.rejects(
      () =>
        h.supervisor.startTask({
          projectId: project.id,
          instruction: "x",
          runtimeId: h.runtimeId,
          profileId: "prof_also_missing",
        }),
      (err: unknown) => (err as DomainError).code === "profile-not-found"
    );
    assert.equal(h.scripted.runs(), 0);
  });

  test("a profile whose runtime or model preset was deleted is refused, not silently dropped", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();

    const danglingModel = await h.profiles.create({ name: "Dangling model", modelId: "mod_deleted" });
    const modelProject = await h.projects.create({
      name: "Dangling model project",
      source: { remoteUrl: remote },
      execution: { profileId: danglingModel.id },
    });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: modelProject.id, instruction: "x", runtimeId: h.runtimeId }),
      (err: unknown) => (err as DomainError).code === "model-not-found"
    );

    const danglingRuntime = await h.profiles.create({ name: "Dangling runtime", runtimeId: "rt_deleted" });
    const runtimeProject = await h.projects.create({
      name: "Dangling runtime project",
      source: { remoteUrl: remote },
      execution: { profileId: danglingRuntime.id },
    });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: runtimeProject.id, instruction: "x", runtimeId: h.runtimeId }),
      (err: unknown) => (err as DomainError).code === "runtime-create-failed"
    );
    assert.equal(h.scripted.runs(), 0);
  });

  test("a profile preset that wins but points at a disabled runtime or model is refused", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const { ModelService, ProviderService } = await import("./services.js");
    const provider = await new ProviderService(h.store).create({ name: "Disabled provider", type: "openai-completions" });

    // Disabled runtime preset — no explicit task/project runtime, so the
    // preset is the reason this runtime was picked.
    const disabledRuntime = await h.runtimes.create({
      name: "Turned off",
      kind: "custom",
      usableInTask: false,
      enabled: false,
    });
    const runtimeProfile = await h.profiles.create({ name: "Off runtime", runtimeId: disabledRuntime.id });
    const runtimeProject = await h.projects.create({
      name: "Off runtime project",
      source: { remoteUrl: remote },
      execution: { profileId: runtimeProfile.id },
    });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: runtimeProject.id, instruction: "x" }),
      (err: unknown) => (err as DomainError).code === "runtime-create-failed"
    );

    // Disabled model preset, same shape.
    const disabledModel = await new ModelService(h.store).create({
      providerId: provider.id,
      name: "off-model",
      enabled: false,
    });
    const modelProfile = await h.profiles.create({ name: "Off model", modelId: disabledModel.id });
    const modelProject = await h.projects.create({
      name: "Off model project",
      source: { remoteUrl: remote },
      execution: { profileId: modelProfile.id },
    });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: modelProject.id, instruction: "x", runtimeId: h.runtimeId }),
      (err: unknown) => (err as DomainError).code === "model-not-found"
    );
    assert.equal(h.scripted.runs(), 0);
  });

  test("a disabled preset that does NOT win is not a failure: an explicit runtime and model override it", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const { ModelService, ProviderService } = await import("./services.js");
    const provider = await new ProviderService(h.store).create({ name: "Mixed provider", type: "openai-completions" });
    const explicitModel = await new ModelService(h.store).create({ providerId: provider.id, name: "explicit-model" });
    const disabledRuntime = await h.runtimes.create({ name: "Off", kind: "custom", enabled: false, usableInTask: false });
    const disabledModel = await new ModelService(h.store).create({ providerId: provider.id, name: "off", enabled: false });
    const profile = await h.profiles.create({
      name: "Losing presets",
      runtimeId: disabledRuntime.id,
      modelId: disabledModel.id,
      systemInstructions: "LOSING-PRESETS",
    });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { profileId: profile.id },
    });

    // Explicit runtime + explicit model: the disabled presets never decide
    // anything, so the task runs — and still carries the profile.
    const { task, run } = await startTask(h, project, { runtimeId: h.runtimeId, modelId: explicitModel.id });
    assert.equal(task.runtimeId, h.runtimeId);
    assert.equal(task.modelId, explicitModel.id);
    assert.equal(run.modelId, explicitModel.id);
    assert.equal(task.execution!.status, "completed", task.execution!.failure?.message);
    assert.equal(run.systemInstructions, "LOSING-PRESETS");
  });

  test("a retry keeps running under the Task's profile", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const profile = await h.profiles.create({ name: "Retry profile", systemInstructions: "STILL-PROFILE" });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { profileId: profile.id },
    });

    const { task } = await startTask(h, project);
    const { run } = await h.supervisor.retryRun(task.id);
    assert.equal(run.profileId, profile.id);
    assert.equal(run.systemInstructions, "STILL-PROFILE");
  });
});

/* ================================================================== */
/* 2. project.execution.networkPolicy                                  */
/* ================================================================== */

describe("v11 inheritance: project.execution.networkPolicy", () => {
  test("the Project's network policy reaches the runtime context and the container argv", async () => {
    const fx = makeFixtures();
    const restore = useBins(fx);
    try {
      const h = await makeHarness();
      const { remote } = await makeRemote();
      const containerized = await h.runtimes.create({
        name: "Containerized",
        kind: "docker",
        usableInTask: true,
        enabled: true,
        containerized: true,
        executionBackend: "isolated",
        image: "af-test-network:1",
      });
      const project = await h.projects.create({
        name: "Demo",
        source: { remoteUrl: remote },
        execution: { networkPolicy: { enabled: false } },
      });

      const { task } = await startTask(h, project, { runtimeId: containerized.id });
      assert.equal(task.execution!.status, "completed", task.execution!.failure?.message);

      // The container the harness actually ran in got `--network none`.
      const runArgs = dockerCalls(fx).find((c) => c[0] === "run" && c.includes("af-test-network:1"))!;
      assert.ok(runArgs, "the containerized runtime started a container");
      assert.equal(runArgs[runArgs.indexOf("--network") + 1], "none");
    } finally {
      restore();
    }
  });

  test("a Task-level network policy wins over the Project default", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { networkPolicy: { enabled: false } },
    });

    const { task } = await startTask(h, project, { policy: { network: { enabled: true } } });
    assert.equal(task.execution!.status, "completed");
    // The resolved policy — the single object every executor reads — carries
    // the Task's choice, not the Project's default.
    assert.equal(h.scripted.contexts.at(-1)!.policy?.network?.enabled, true);
  });

  test("a Project-level default is inherited when the Task declares no policy", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      execution: { networkPolicy: { enabled: false } },
    });

    const { task } = await startTask(h, project);
    assert.equal(h.scripted.contexts.at(-1)!.policy?.network?.enabled, false);
    // Frozen onto the Task record at creation, like every other Project
    // execution default (env / tools / resourceLimits / timeoutMs).
    assert.equal(h.tasks.get(task.id)!.policy?.network?.enabled, false);
  });

  test("no network policy anywhere leaves the runtime's own default in place", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await startTask(h, project);
    assert.equal(h.scripted.contexts.at(-1)!.policy?.network, undefined);
  });
});

/* ================================================================== */
/* 3. Task-level skills / MCP servers                                  */
/* ================================================================== */

describe("v11 inheritance: Task skills / mcpServers", () => {
  function makeSkill(name: string): string {
    const dir = tempDir(`af-v11i-skill-${name}-`);
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
    return dir;
  }

  /** What one run provisioned, captured while the run was live. */
  interface Provisioned {
    skills: string[];
    mcpServers: string[];
    skillContents: string[];
    document: { mcpServers?: Record<string, unknown> };
    skillsMountPath?: string;
    mcpConfigMountPath?: string;
    skillsMountContainerPaths: string[];
  }

  /** Captures provisioning from the live runtime context of the next run. */
  function captureProvisioning(h: Harness): { seen: Provisioned } {
    const seen: Provisioned = {
      skills: [],
      mcpServers: [],
      skillContents: [],
      document: {},
      skillsMountContainerPaths: [],
    };
    h.scripted.setHandler(async (ctx) => {
      const dir = ctx.provisioning?.skillsHostDir;
      // The provisioning directory is removed at cleanup, so read the
      // generated artifacts now — this is the moment they exist.
      seen.skills = dir ? readdirSync(dir) : [];
      seen.skillContents = dir
        ? seen.skills.map((name) => String(readFileSync(join(dir, name, "SKILL.md"), "utf8")))
        : [];
      seen.document = ctx.provisioning?.mcpConfigHostPath
        ? (JSON.parse(readFileSync(ctx.provisioning.mcpConfigHostPath, "utf8")) as Provisioned["document"])
        : {};
      seen.mcpServers = Object.keys(seen.document.mcpServers ?? {});
      seen.skillsMountPath = ctx.provisioning?.skillsMountPath;
      seen.mcpConfigMountPath = ctx.provisioning?.mcpConfigMountPath;
      seen.skillsMountContainerPaths = (ctx.extraMounts ?? []).map((m) => m.containerPath);
      writeFileSync(join(ctx.workspacePath!, `${ctx.run.id}.txt`), "work\n");
      return { exitCode: 0 };
    });
    return { seen };
  }

  test("a Task inherits the Project's skills and MCP servers when it declares none", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      skills: [{ name: "project-skill", path: makeSkill("project-skill") }],
      mcpServers: [{ name: "project-server", command: "npx", args: ["-y", "server"] }],
    });
    const { seen } = captureProvisioning(h);

    const { task } = await startTask(h, project);
    assert.equal(task.execution!.status, "completed", task.execution!.failure?.message);
    // The Task record stays as declared (nothing here): inheritance is
    // resolved where the environment is built, not back-written onto the Task.
    assert.equal(task.skills, undefined);
    assert.equal(task.mcpServers, undefined);

    assert.deepEqual(seen.skills, ["project-skill"]);
    assert.deepEqual(seen.mcpServers, ["project-server"]);
    assert.equal(seen.skillsMountPath, "/root/.agentfabric/skills");
    assert.equal(seen.mcpConfigMountPath, "/root/.agentfabric/mcp.json");
    assert.deepEqual(seen.skillsMountContainerPaths, ["/root/.agentfabric/skills", "/root/.agentfabric/mcp.json"]);
  });

  test("a Task's own skills and MCP servers replace the Project's list", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      skills: [{ name: "project-skill", path: makeSkill("project-skill") }],
      mcpServers: [{ name: "project-server", command: "npx", args: ["-y", "server"] }],
    });
    const { seen } = captureProvisioning(h);

    const { task } = await startTask(h, project, {
      skills: [{ name: "task-skill", path: makeSkill("task-skill") }],
      mcpServers: [{ name: "task-server", command: "npx", args: ["-y", "task-server"] }],
    });
    assert.equal(task.execution!.status, "completed", task.execution!.failure?.message);

    // The Task's list is a replacement, not a union: the Project's skill is
    // not provisioned, and its MCP server is not in the generated document.
    assert.deepEqual(seen.skills, ["task-skill"]);
    assert.match(seen.skillContents[0], /# task-skill/);
    assert.deepEqual(seen.mcpServers, ["task-server"]);

    // The Task record keeps what it was given, verbatim.
    assert.deepEqual(task.skills?.map((s) => s.name), ["task-skill"]);
    assert.deepEqual(task.mcpServers?.map((s) => s.name), ["task-server"]);
  });

  test("a Task that declares an empty list provisions no skills (an explicit override, not inheritance)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      skills: [{ name: "project-skill", path: makeSkill("project-skill") }],
      mcpServers: [{ name: "project-server", command: "npx" }],
    });

    const { task } = await startTask(h, project, { skills: [], mcpServers: [] });
    const ctx = h.scripted.contexts.at(-1)!;
    assert.equal(task.execution!.status, "completed", task.execution!.failure?.message);
    assert.equal(ctx.provisioning!.skillsHostDir, undefined);
    assert.equal(ctx.provisioning!.mcpConfigHostPath, undefined);
    assert.deepEqual(ctx.extraMounts, []);
    // Nothing was mounted, so no env var points at a directory that is absent.
    assert.equal(ctx.env[SKILLS_ENV_VAR], undefined);
    assert.equal(ctx.env[MCP_CONFIG_ENV_VAR], undefined);
  });

  test("a Task-declared skill directory that does not exist fails loudly", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });

    const { task } = await startTask(h, project, {
      skills: [{ name: "gone", path: "/nonexistent/task-skill/path" }],
    });
    assert.equal(task.execution!.status, "failed");
    assert.equal(h.scripted.runs(), 0, "the agent never starts without the configured skill");
    const message = `${task.execution!.failure!.message} ${task.execution!.failure!.code}`;
    assert.match(message, /nonexistent|ENOENT/i, `the failure names the missing skill directory: ${message}`);
  });
});
