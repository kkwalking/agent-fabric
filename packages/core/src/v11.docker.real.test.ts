/**
 * REAL Docker runtime Coding Task E2E (v11 hardening §21–§24/§40, AC-30–AC-35).
 *
 * This suite runs the **whole** Project lifecycle against a real Docker
 * daemon and a real git remote:
 *
 *   Create Git Credential → Create Project → Create Task
 *   → Create Managed Workspace → Clone Repository → Resolve Base Commit
 *   → Create Working Branch → Start Real Docker Runtime → Mount Workspace
 *   → Run Fake Agent INSIDE Docker → Modify Workspace
 *   → Verify the Agent Cannot Read the Git Credential
 *   → Run Validation INSIDE a Disposable Sandbox
 *   → Finalize Git → Freeze the Final Commit SHA → Push the Exact Commit
 *   → Destroy the Runtime → Verify the Workspace Still Exists
 *   → Verify the Remote Branch → Verify the Secret Never Leaked
 *
 * No LLM is called: the "agent" is a deterministic shell script that runs
 * inside the container, writes into the mounted workspace and prints what it
 * sees. The point is the **runtime isolation contract**, not model ability.
 *
 * Gating: the suite runs whenever a Docker daemon is reachable; it skips (with
 * a reason) when there is none. It needs no API key and no network beyond the
 * images already present locally.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry } from "./runtime.js";
import { RunService } from "./orchestrator.js";
import { ExecutionSupervisor } from "./supervisor.js";
import {
  ProjectService,
  RuntimeService,
  SourceCredentialService,
  TaskService,
  WorkspaceService,
} from "./services.js";
import { createDockerContainerOps } from "../../runtimes/src/docker.js";
import { dockerAdapter } from "../../runtimes/src/docker.js";
import type { Run, Task } from "./types.js";

const exec = promisify(execFile);

/** The unmistakable fake secret every leakage assertion searches for. */
const LEAK_CANARY = "AGENTFABRIC_TEST_SECRET_DO_NOT_LEAK";
/** A host-only secret that must never be visible inside any container. */
const HOST_ONLY_CANARY = "AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK";

/** Image every container in this suite runs (already used by the seeds). */
const IMAGE = process.env.AGENTFABRIC_DOCKER_E2E_IMAGE ?? "node:22-alpine";

async function dockerReady(): Promise<boolean> {
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function imageReady(image: string): Promise<boolean> {
  try {
    const { stdout } = await exec("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { timeout: 30_000 });
    return String(stdout)
      .split("\n")
      .map((l) => l.trim())
      .includes(image);
  } catch {
    return false;
  }
}

const dockerOk = await dockerReady();
const imageOk = dockerOk && (await imageReady(IMAGE));
const SKIP: string | false = !dockerOk
  ? "no reachable Docker daemon (start Docker/OrbStack to run the real-runtime E2E)"
  : !imageOk
    ? `Docker image ${IMAGE} is not present locally`
    : false;

before(() => {
  process.env.GIT_AUTHOR_NAME = "AgentFabric E2E";
  process.env.GIT_AUTHOR_EMAIL = "e2e@example.test";
  process.env.GIT_COMMITTER_NAME = "AgentFabric E2E";
  process.env.GIT_COMMITTER_EMAIL = "e2e@example.test";
  process.env.AGENTFABRIC_HOST_ONLY_SECRET = HOST_ONLY_CANARY;
});
after(() => {
  delete process.env.AGENTFABRIC_HOST_ONLY_SECRET;
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return String(stdout);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A local bare repository used as the remote (no network, no auth server). */
async function makeRemote(): Promise<{ root: string; remote: string; seed: string; baseSha: string }> {
  const root = tempDir("af-docker-remote-");
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
  return { root, remote, seed, baseSha };
}

/**
 * The deterministic "agent" that runs **inside** the container. It proves
 * where it ran, writes into the mounted workspace, and dumps everything it
 * can see — the raw material for the isolation assertions.
 */
const FAKE_AGENT_SCRIPT = `#!/bin/sh
set -eu
echo "AF_AGENT_START"
if [ -f /.dockerenv ]; then echo "AF_IN_CONTAINER=yes"; else echo "AF_IN_CONTAINER=no"; fi
echo "AF_CONTAINER_HOSTNAME=$(hostname)"
echo "AF_CWD=$(pwd)"
echo "AF_WORKSPACE_LISTING_START"
ls -A /workspace
echo "AF_WORKSPACE_LISTING_END"
echo "AF_ENV_START"
env | sort
echo "AF_ENV_END"
printf 'produced by the agent inside the container\\n' > /workspace/agent-output.txt
mkdir -p /workspace/src
printf 'export const feature = 1;\\n' > /workspace/src/feature.ts
echo "AF_AGENT_END"
exit 0
`;

/**
 * The skill directory itself (it contains `run.sh`). Provisioning copies it to
 * `<skillsMount>/<skill.name>`, so the container command below finds the agent
 * at `/root/.agentfabric/skills/fake-agent/run.sh`.
 */
function skillDir(): string {
  const dir = tempDir("af-docker-skill-");
  const script = join(dir, "run.sh");
  writeFileSync(script, FAKE_AGENT_SCRIPT);
  chmodSync(script, 0o755);
  return dir;
}

function eventLines(events: Array<{ type: string; data: Record<string, unknown> }>): string {
  return events
    .filter((e) => e.type === "shell.output" || e.type === "log")
    .map((e) => String(e.data?.line ?? ""))
    .join("\n");
}

describe("v11 hardening: REAL Docker runtime Coding Task E2E", { skip: SKIP }, () => {
  test("the full isolated lifecycle: agent in Docker, validation in a sandbox, exact commit pushed", async () => {
    /* ---------- 0. Environment ---------- */
    const { remote, baseSha } = await makeRemote();
    const dataDir = tempDir("af-docker-data-");
    const store = await Store.open(dataDir);
    const bus = new EventBus();
    const registry = new RuntimeRegistry();
    registry.register(dockerAdapter);
    const runService = new RunService(store, bus, registry, createDockerContainerOps());
    // The production supervisor: the default validation executor is the real
    // disposable Docker one, so validation genuinely runs in a container.
    const supervisor = new ExecutionSupervisor(store, bus, runService);
    const projects = new ProjectService(store);
    const credentials = new SourceCredentialService(store);
    const runtimes = new RuntimeService(store);
    const tasks = new TaskService(store);
    const workspaces = new WorkspaceService(store);

    /* ---------- 1. Create the Git credential ---------- */
    const credential = await credentials.create({
      name: "E2E source credential",
      type: "https-token",
      username: "e2e",
      // A local-path remote has no host to bind to; the credential is still
      // materialized and redacted, which is what the leakage checks read.
      value: LEAK_CANARY,
    });
    assert.equal(JSON.stringify(credentials.list()).includes(LEAK_CANARY), false, "the credential value is never served");

    /* ---------- 2. Create the Project ---------- */
    const project = await projects.create({
      name: "E2E Docker project",
      source: { remoteUrl: remote, credentialId: credential.id },
      skills: [{ name: "fake-agent", path: skillDir() }],
      validation: {
        steps: [
          // Case A: the command reads the workspace the agent wrote into.
          { name: "workspace-visible", command: "test -f /workspace/agent-output.txt" },
          { name: "agent-work-visible", command: "grep -q 'export const feature' /workspace/src/feature.ts" },
          // AC-33: validation itself runs inside a container.
          { name: "in-container", command: "test -f /.dockerenv" },
          // AC-8/§26 Case D + AC-7/§26 Case C: the sandbox's whole
          // environment is dumped and scanned below for both canaries. The
          // commands deliberately do not spell either value, so a match could
          // only come from the environment itself.
          { name: "environment-dump", command: "printenv | sort" },
          // §6.1: no Docker socket, no host filesystem beyond the workspace.
          { name: "no-docker-socket", command: "test ! -e /var/run/docker.sock" },
          { name: "no-host-home", command: "test ! -e /Users" },
          { name: "validation-marker", command: "test \"$AGENTFABRIC_VALIDATION\" = 1" },
        ],
      },
      git: { autoCommit: true, push: true },
    });

    /* ---------- 3. Create the isolated Docker runtime ---------- */
    const runtime = await runtimes.create({
      name: "E2E Docker runtime",
      kind: "docker",
      containerized: true,
      executionBackend: "isolated",
      image: IMAGE,
      // The container command runs the provisioned fake agent. The skill is
      // mounted read-only by the platform's own provisioning path.
      command: ["sh", "/root/.agentfabric/skills/fake-agent/run.sh"],
      usableInTask: true,
      enabled: true,
      ephemeral: true,
      config: { mountPath: "/workspace" },
    });

    /* ---------- 4. Create the Task (managed workspace + branch + runtime) ---------- */
    const started = await supervisor.startTask({
      projectId: project.id,
      instruction: "Produce the feature module",
      title: "Docker E2E",
      runtimeId: runtime.id,
    });
    const runId = started.run.id;
    const containerName = `af-${runId}`;

    // The runtime really starts inside Docker: before settling there is (or
    // was) a container carrying this run's name.
    await supervisor.whenSettled(started.task.id);
    const task = tasks.get(started.task.id)!;
    const run = runService.get(runId)!;

    /* ---------- 5. Lifecycle completed end to end ---------- */
    assert.equal(task.execution!.status, "completed", JSON.stringify(task.execution!.failure ?? {}));
    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.validation!.status, "passed", JSON.stringify(task.execution!.validation));
    assert.equal(task.execution!.publish!.status, "pushed");
    assert.equal(task.baseCommitSha, baseSha, "the base revision was resolved from the real clone");

    const events = await store.readEvents(runId);
    const output = eventLines(events);

    /* ---------- 6. Runtime Isolation (AC-30/AC-3) ---------- */
    assert.match(output, /AF_IN_CONTAINER=yes/, "the agent process ran inside a container");
    const containerHostname = /AF_CONTAINER_HOSTNAME=(.+)/.exec(output)?.[1]?.trim();
    assert.ok(containerHostname, "the agent reported its container hostname");
    assert.notEqual(containerHostname, hostname(), "the agent did not run on the AgentFabric host");
    assert.match(output, /AF_CWD=\/workspace/, "the agent's working directory is the mounted workspace");

    /* ---------- 7. Workspace Mount (AC-31) ---------- */
    const workspace = workspaces.get(task.workspaceId!)!;
    const workspacePath = workspace.path!;
    assert.equal(existsSync(join(workspacePath, "agent-output.txt")), true, "the container's write landed on the host workspace");
    assert.match(readFileSync(join(workspacePath, "agent-output.txt"), "utf8"), /produced by the agent inside the container/);
    assert.equal(existsSync(join(workspacePath, "src", "feature.ts")), true);

    /* ---------- 8. Runtime Destruction (AC-4/AC-32) ---------- */
    const { stdout: surviving } = await exec(
      "docker",
      ["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{.ID}}"],
      { timeout: 30_000 }
    );
    assert.equal(surviving.trim(), "", `the container ${containerName} was destroyed after the run`);
    assert.ok(events.some((e) => e.type === "container.destroyed" || e.type === "runtime.destroyed"), "destruction was announced");

    /* ---------- 9. Workspace Persistence (AC-32) ---------- */
    assert.equal(existsSync(workspacePath), true, "the workspace survives the container");
    assert.equal(existsSync(join(workspacePath, ".git")), true, "the workspace is still a real repository");

    /* ---------- 10. Validation Isolation (AC-33/AC-5/AC-6/AC-7/AC-8) ---------- */
    const validation = task.execution!.validation!;
    assert.equal(validation.execution!.backend, "isolated");
    assert.equal(validation.execution!.containerized, true);
    assert.equal(validation.execution!.image, IMAGE);
    assert.equal(validation.execution!.disposable, true);
    assert.deepEqual(
      validation.steps!.map((s) => [s.name, s.status]),
      [
        ["workspace-visible", "passed"],
        ["agent-work-visible", "passed"],
        ["in-container", "passed"],
        ["environment-dump", "passed"],
        ["no-docker-socket", "passed"],
        ["no-host-home", "passed"],
        ["validation-marker", "passed"],
      ],
      JSON.stringify(validation.steps)
    );
    // The sandbox's environment carries neither the Git credential nor any
    // host-only secret (the dump is the raw evidence).
    const validationEnv = validation.steps!.find((s) => s.name === "environment-dump")!.output!;
    assert.ok(validationEnv.length > 0, "the sandbox environment was captured");
    assert.equal(validationEnv.includes(LEAK_CANARY), false, "the source credential never entered the validation sandbox");
    assert.equal(validationEnv.includes(HOST_ONLY_CANARY), false, "no host-only secret entered the validation sandbox");
    assert.match(validationEnv, /^AGENTFABRIC_VALIDATION=1$/m, "the allowlisted marker is present");

    // The validation container is gone too (--rm + explicit cleanup).
    const { stdout: validationContainers } = await exec(
      "docker",
      ["ps", "-a", "--filter", "label=agentfabric.validation=true", "--format", "{{.ID}}"],
      { timeout: 30_000 }
    );
    assert.equal(validationContainers.trim(), "", "no disposable validation container was left behind");

    /* ---------- 11. Git Credential Isolation (AC-34) ---------- */
    // The agent dumped its whole environment inside the container.
    const agentEnv = /AF_ENV_START\n([\s\S]*?)\nAF_ENV_END/.exec(output)?.[1] ?? "";
    assert.ok(agentEnv.length > 0, "the agent's environment was captured");
    assert.equal(agentEnv.includes(LEAK_CANARY), false, "the source credential never entered the agent container");
    assert.equal(agentEnv.includes(HOST_ONLY_CANARY), false, "no host-only secret entered the agent container");
    assert.equal(/^AGENTFABRIC_GIT_PASSWORD=/m.test(agentEnv), false, "no git credential helper env");
    assert.equal(/^GIT_ASKPASS=/m.test(agentEnv), false, "no askpass helper env");
    assert.equal(/^SSH_ASKPASS=/m.test(agentEnv), false, "no ssh askpass env");
    // …and the credential is not in the container's view of the workspace.
    assert.match(output, /AF_WORKSPACE_LISTING_START/, "the agent listed the workspace");

    /* ---------- 12. Frozen revision + exact push (AC-17/AC-18/AC-35) ---------- */
    const frozen = task.execution!.frozenRevision!;
    assert.ok(frozen, "the final revision was frozen");
    assert.equal(frozen.finalCommitSha, task.execution!.publish!.finalCommitSha);
    const remoteSha = (await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim();
    assert.equal(remoteSha, frozen.finalCommitSha, "the remote branch is exactly the frozen commit");
    // The published tree really carries the container's work.
    const tree = await git(remote, ["ls-tree", "-r", "--name-only", task.workingBranch!]);
    assert.match(tree, /agent-output\.txt/);
    assert.match(tree, /src\/feature\.ts/);
    // And the frozen fingerprint matches the working tree that produced it.
    const statusNow = (await git(workspacePath, ["status", "--porcelain"])).trim();
    assert.equal(statusNow, "", "finalization left a clean working tree");

    /* ---------- 13. Credential Leakage Prevention (AC-15/AC-16/§29) ---------- */
    const eventText = JSON.stringify(events);
    assert.equal(eventText.includes(LEAK_CANARY), false, "the credential is not in the event log");
    assert.equal(output.includes(LEAK_CANARY), false, "the credential is not in the runtime stdout/stderr");
    const dbText = readFileSync(join(dataDir, "db.json"), "utf8");
    const db = JSON.parse(dbText) as { secrets?: { value?: string }[] };
    // The Secret store holds the value — encrypted, so even db.json itself no
    // longer carries the plaintext anywhere, the secret rows included.
    assert.equal(
      (db.secrets ?? []).some((s) => s.value?.startsWith("enc:v1:")),
      true,
      "the credential's Secret is stored encrypted"
    );
    assert.equal(dbText.includes(LEAK_CANARY), false, "the credential is nowhere in db.json, not even in the secret store");
    // Not in .git/config — the remote URL stays credential-free.
    const gitConfig = readFileSync(join(workspacePath, ".git", "config"), "utf8");
    assert.equal(gitConfig.includes(LEAK_CANARY), false, ".git/config never carries the credential");
    assert.match(gitConfig, new RegExp(`url = ${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    // Not in the workspace or in the temporary credential area.
    const walk = (dir: string, depth = 0): string[] => {
      if (depth > 3) return [];
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === ".git") return [];
        const abs = join(dir, entry.name);
        return entry.isDirectory() ? walk(abs, depth + 1) : [abs];
      });
    };
    for (const file of walk(workspacePath)) {
      const content = readFileSync(file, "utf8");
      assert.equal(content.includes(LEAK_CANARY), false, `credential leaked into ${file}`);
    }
    assert.deepEqual(
      existsSync(join(dataDir, "git-credentials")) ? readdirSync(join(dataDir, "git-credentials")) : [],
      [],
      "temporary credential material was removed"
    );

    /* ---------- 14. Observability (§35): every stage is distinguishable ---------- */
    const types = events.map((e) => e.type);
    for (const expected of [
      "workspace.prepared",
      "source.prepared",
      "credential.resolved",
      "credential.released",
      "runtime.prepared",
      "validation.runtime.prepared",
      "validation.started",
      "validation.passed",
      "git.finalized",
      "git.revision.frozen",
      "git.pushed",
      "run.phase",
    ]) {
      assert.ok(types.includes(expected), `missing event ${expected} (got ${[...new Set(types)].join(",")})`);
    }
    const detail = supervisor.taskDetail(task.id);
    assert.equal(detail.isolation!.sandboxed, true, "the task detail reports an isolated runtime");
    assert.equal(detail.stages!.agent!.status, "completed");
    assert.equal(detail.stages!.validation!.status, "completed");
    assert.equal(detail.stages!.finalization!.status, "completed");
    assert.equal(detail.stages!.publish!.status, "completed");
    assert.equal(detail.frozenRevision!.finalCommitSha, frozen.finalCommitSha);
    assert.equal(detail.validation.execution!.containerized, true);
  });

  test("a validation failure inside the sandbox keeps agent.status completed (AC-27/§26 Case E)", async () => {
    const { remote } = await makeRemote();
    const dataDir = tempDir("af-docker-fail-data-");
    const store = await Store.open(dataDir);
    const bus = new EventBus();
    const registry = new RuntimeRegistry();
    registry.register(dockerAdapter);
    const runService = new RunService(store, bus, registry, createDockerContainerOps());
    const supervisor = new ExecutionSupervisor(store, bus, runService);
    const projects = new ProjectService(store);
    const runtimes = new RuntimeService(store);
    const tasks = new TaskService(store);

    const project = await projects.create({
      name: "E2E failing validation",
      source: { remoteUrl: remote },
      skills: [{ name: "fake-agent", path: skillDir() }],
      validation: {
        steps: [
          { name: "workspace-visible", command: "test -f /workspace/agent-output.txt" },
          { name: "in-container", command: "test -f /.dockerenv" },
          { name: "always-fails", command: "echo 'type error' >&2; exit 2" },
        ],
      },
    });
    const runtime = await runtimes.create({
      name: "E2E Docker runtime",
      kind: "docker",
      containerized: true,
      executionBackend: "isolated",
      image: IMAGE,
      command: ["sh", "/root/.agentfabric/skills/fake-agent/run.sh"],
      usableInTask: true,
      enabled: true,
      ephemeral: true,
      config: { mountPath: "/workspace" },
    });

    const started = await supervisor.startTask({
      projectId: project.id,
      instruction: "Produce the feature module",
      runtimeId: runtime.id,
    });
    await supervisor.whenSettled(started.task.id);
    const task = tasks.get(started.task.id)!;

    // The agent completed; validation is its own, isolated failure.
    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.validation!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "validation");
    assert.equal(task.execution!.failure!.code, "validation-failed");
    assert.equal(task.execution!.stages!.agent!.status, "completed");
    assert.equal(task.execution!.stages!.validation!.status, "failed");
    assert.equal(task.execution!.publish!.status, "pending", "nothing is published after a failed validation");
    // The steps that ran before the failure really ran in a container.
    assert.deepEqual(
      task.execution!.validation!.steps!.map((s) => [s.name, s.status]),
      [
        ["workspace-visible", "passed"],
        ["in-container", "passed"],
        ["always-fails", "failed"],
      ]
    );
    assert.match(task.execution!.validation!.steps![2].output!, /type error/);
    // The task offers "retry validation", not a generic retry.
    const detail = supervisor.taskDetail(task.id);
    assert.equal(detail.retry.kind, "validation");
    assert.equal(detail.retry.validation, true);
  });

  test("a Project task on a host runtime is refused before any container is created (AC-1/AC-2)", async () => {
    const { remote } = await makeRemote();
    const store = await Store.open(tempDir("af-docker-refuse-data-"));
    const bus = new EventBus();
    const registry = new RuntimeRegistry();
    registry.register(dockerAdapter);
    const runService = new RunService(store, bus, registry, createDockerContainerOps());
    const supervisor = new ExecutionSupervisor(store, bus, runService);
    const projects = new ProjectService(store);
    const runtimes = new RuntimeService(store);

    const project = await projects.create({ name: "E2E refusal", source: { remoteUrl: remote } });
    const local = await runtimes.create({
      name: "Local (host) runtime",
      kind: "docker",
      containerized: false,
      executionBackend: "host",
      usableInTask: true,
      enabled: true,
    });

    await assert.rejects(
      () => supervisor.startTask({ projectId: project.id, instruction: "x", runtimeId: local.id }),
      (err: unknown) => (err as { code?: string }).code === "runtime-not-isolated"
    );
    assert.equal(new TaskService(store).list().length, 0, "no task was created");
    const { stdout } = await exec("docker", ["ps", "-a", "--filter", "name=af-", "--format", "{{.ID}}"], { timeout: 30_000 });
    assert.equal(stdout.trim(), "", "no container was created for a refused task");
  });
});
