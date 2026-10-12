/**
 * REAL Docker runtime Coding Task E2E (v11 hardening §21–§24/§40, AC-30–AC-35;
 * v12 §4/§9).
 *
 * This suite runs the **whole** Project lifecycle against a real Docker
 * daemon and a real git remote:
 *
 *   Create Git Credential → Create Project → Create Task
 *   → Create Managed Workspace → Clone Repository → Resolve Base Commit
 *   → Create Working Branch → Start Real Docker Runtime → Mount Workspace
 *   → Run Fake Agent INSIDE Docker → Modify Workspace
 *   → Verify the Agent Cannot Read the Git Credential
 *   → Run the Validation Judge INSIDE its own fresh container
 *     (read-only workspace, no host environment, verdict tool usable)
 *   → Finalize Git → Freeze the Final Commit SHA → Push the Exact Commit
 *   → Destroy the Runtime → Verify the Workspace Still Exists
 *   → Verify the Remote Branch → Verify the Secret Never Leaked
 *
 * No LLM is called: the "agent" and the "judge" are deterministic shell
 * scripts that run inside their containers, print what they see, and — for
 * the judge — submit a real verdict through the provisioned tool. The point
 * is the **runtime isolation contract**, not model ability.
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
  SecretService,
  SourceCredentialService,
  TaskService,
  WorkspaceService,
} from "./services.js";
import { createDockerContainerOps } from "../../runtimes/src/docker.js";
import { dockerAdapter } from "../../runtimes/src/docker.js";
import { VALIDATION_OUTPUT_CONTAINER_PATH, VALIDATION_TOOL_CONTAINER_PATH } from "./validation.js";
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
 * A "development agent" that does NOT satisfy the acceptance standard on its
 * first run: it writes something else entirely, so a real judge checking real
 * evidence reaches a failing verdict. On a rework run (recognizable because
 * its previous partial output is still in the workspace) it completes the
 * work — the deterministic stand-in for "the agent acted on the verdict".
 */
const FAKE_PARTIAL_AGENT_SCRIPT = `#!/bin/sh
set -eu
echo "AF_AGENT_START"
if [ -f /workspace/partial.txt ]; then
  echo "AF_AGENT_MODE=rework"
  printf 'produced by the agent inside the container\\n' > /workspace/agent-output.txt
  mkdir -p /workspace/src
  printf 'export const feature = 1;\\n' > /workspace/src/feature.ts
else
  echo "AF_AGENT_MODE=initial"
  printf 'work in progress\\n' > /workspace/partial.txt
fi
echo "AF_AGENT_END"
exit 0
`;

/**
 * The runtime's container command, shared by both roles. A judge run always
 * carries `AGENTFABRIC_VALIDATION_OUTPUT` (provisioned in v12 §4.1); a
 * development run never does.
 *
 * The judge branch is deliberately self-contained — the judge container gets
 * no skills mount, its only platform tool is the verdict tool — and it
 * derives its verdict from real checks against the read-only workspace,
 * submitting through the provisioned tool exactly like a real judge would.
 */
const RUNTIME_DISPATCH_SCRIPT = `
if [ -n "\${AGENTFABRIC_VALIDATION_OUTPUT:-}" ]; then
  # ---- judge role (v12 §4.1): its own container, read-only workspace ----
  echo "AF_JUDGE_IN_CONTAINER=yes"
  echo "AF_JUDGE_HOSTNAME=$(hostname)"
  if [ -e /Users ]; then echo "AF_JUDGE_NO_HOST_HOME=no"; else echo "AF_JUDGE_NO_HOST_HOME=yes"; fi
  if [ -e /var/run/docker.sock ]; then echo "AF_JUDGE_NO_DOCKER_SOCKET=no"; else echo "AF_JUDGE_NO_DOCKER_SOCKET=yes"; fi
  if (echo nope > /workspace/judge-should-not-write.txt) 2>/dev/null; then echo "AF_JUDGE_WRITE_READONLY=no"; else echo "AF_JUDGE_WRITE_READONLY=yes"; fi
  echo "AF_JUDGE_ENV_START"
  printenv | sort
  echo "AF_JUDGE_ENV_END"
  missing=""
  if [ -f /workspace/agent-output.txt ]; then
    echo "AF_JUDGE_CHECK agent-output.txt present"
  else
    echo "AF_JUDGE_CHECK agent-output.txt missing"
    missing="$missing agent-output.txt"
  fi
  if grep -q "export const feature" /workspace/src/feature.ts 2>/dev/null; then
    echo "AF_JUDGE_CHECK src/feature.ts matches"
  else
    echo "AF_JUDGE_CHECK src/feature.ts missing"
    missing="$missing src/feature.ts"
  fi
  if [ -z "$missing" ]; then
    node ${VALIDATION_TOOL_CONTAINER_PATH} --passed \\
      --summary "The acceptance standard is met: the pinned revision contains agent-output.txt and the feature module." \\
      --evidence "test -f /workspace/agent-output.txt -> present" \\
      --evidence "grep feature /workspace/src/feature.ts -> matched"
  else
    node ${VALIDATION_TOOL_CONTAINER_PATH} --failed \\
      --summary "The acceptance standard is not met: the pinned revision is missing required artifacts." \\
      --unmet "missing:$missing" \\
      --evidence "ls /workspace -> the expected files are absent"
  fi
  echo "AF_JUDGE_TOOL_EXIT=$?"
  exit 0
fi
# ---- development role: run the provisioned skill ----
exec sh /root/.agentfabric/skills/fake-agent/run.sh
`;

/**
 * The skill directory itself (it contains `run.sh`). Provisioning copies it to
 * `<skillsMount>/<skill.name>`, so the container command above finds the agent
 * at `/root/.agentfabric/skills/fake-agent/run.sh`.
 */
function skillDir(script: string = FAKE_AGENT_SCRIPT): string {
  const dir = tempDir("af-docker-skill-");
  const scriptPath = join(dir, "run.sh");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
  return dir;
}

function eventLines(events: Array<{ type: string; data: Record<string, unknown> }>): string {
  return events
    .filter((e) => e.type === "shell.output" || e.type === "log")
    .map((e) => String(e.data?.line ?? ""))
    .join("\n");
}

describe("v11 hardening: REAL Docker runtime Coding Task E2E", { skip: SKIP }, () => {
  test("the full isolated lifecycle: agent in Docker, the judge in its own container, exact commit pushed", async () => {
    /* ---------- 0. Environment ---------- */
    const { remote, baseSha } = await makeRemote();
    const dataDir = tempDir("af-docker-data-");
    const store = await Store.open(dataDir);
    const bus = new EventBus();
    const registry = new RuntimeRegistry();
    registry.register(dockerAdapter);
    const runService = new RunService(store, bus, registry, createDockerContainerOps());
    // The production supervisor, end to end: the judge is a real Run through
    // the same Docker runtime (v12 §4.1), so the read-only mount, the verdict
    // tool and the secret boundaries are the real ones.
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
      validation: { prompt: "the acceptance standard is met, proven by running commands in the container" },
      git: { autoCommit: true, push: true },
    });

    /* ---------- 3. Create the isolated Docker runtime ---------- */
    // One runtime, both roles: the command dispatches on the judge-only env
    // var the platform provisions (v12 §4.1) — the development agent runs the
    // fake agent skill, the judge runs the in-container verification script.
    const runtime = await runtimes.create({
      name: "E2E Docker runtime",
      kind: "docker",
      containerized: true,
      executionBackend: "isolated",
      image: IMAGE,
      // Inline dispatch (the judge container gets no skills mount): the
      // script branches on the judge-only env var the platform provisions.
      command: ["sh", "-c", RUNTIME_DISPATCH_SCRIPT],
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

    /* ---------- 10. The judge ran as its own Run, in its own container (v12 §4/§9) ---------- */
    const validation = task.execution!.validation!;
    assert.equal(validation.attempts, 1);
    assert.equal(validation.rounds!.length, 1);
    const round = validation.rounds![0];
    const judgeRun = runService.get(round.judgeRunId!)!;
    assert.equal(judgeRun.purpose, "validation", "the judge is an ordinary Run with its own purpose");
    assert.equal(judgeRun.lifecycle.mode, "ephemeral", "the judge never reuses the development container");
    assert.equal(judgeRun.status, "completed");
    assert.notEqual(round.judgeRunId, runId, "the judge did not run as the development run");
    // The judge ran in its own container — the fake judge script reports it.
    const judgeOutput = eventLines(await store.readEvents(judgeRun.id));
    assert.match(judgeOutput, /AF_JUDGE_IN_CONTAINER=yes/);
    assert.equal(
      judgeOutput.includes(LEAK_CANARY),
      false,
      "the credential is not in the judge's stdout/stderr"
    );

    /* ---------- 10a. The verdict tool was usable inside the container ---------- */
    // The fake judge invoked the provisioned tool by its container path and
    // the verdict the supervisor froze is the one the tool wrote.
    assert.match(judgeOutput, new RegExp(`AF_JUDGE_TOOL_EXIT=0`));
    assert.equal(round.verdict!.passed, true);
    assert.match(round.verdict!.summary, /acceptance standard is met/);
    assert.ok(round.verdict!.evidence.length > 0, "the frozen verdict carries the tool's own evidence");
    assert.equal(round.verdict!.judgeRunId, judgeRun.id, "the verdict is frozen against its judge run");
    assert.equal(round.verdict!.round, 1);

    /* ---------- 10b. Pin + read-only mount + drift containment ---------- */
    const pinned = round.pinnedRevision!;
    assert.ok(pinned.commitSha, "round 1 judged a pinned commit");
    assert.equal(pinned.round, 1);
    assert.equal(pinned.runId, runId, "round 1's pin came from the development run");
    // The judge saw a read-only workspace (the mount refused its write), ran
    // in a container, and could not see the host or the docker socket.
    assert.match(judgeOutput, /AF_JUDGE_WRITE_READONLY=yes/, "the workspace mount was read-only for the judge");
    assert.match(judgeOutput, /AF_JUDGE_NO_HOST_HOME=yes/);
    assert.match(judgeOutput, /AF_JUDGE_NO_DOCKER_SOCKET=yes/);
    // The judge's environment carries neither canary and no git credential.
    const judgeEnv = /AF_JUDGE_ENV_START\n([\s\S]*?)\nAF_JUDGE_ENV_END/.exec(judgeOutput)?.[1] ?? "";
    assert.ok(judgeEnv.length > 0, "the judge's environment was captured");
    assert.equal(judgeEnv.includes(LEAK_CANARY), false, "the source credential never entered the judge container");
    assert.equal(judgeEnv.includes(HOST_ONLY_CANARY), false, "no host-only secret entered the judge container");
    assert.match(judgeEnv, new RegExp(`^AGENTFABRIC_VALIDATION_OUTPUT=${VALIDATION_OUTPUT_CONTAINER_PATH}$`, "m"));
    // The judge container is gone (ephemeral + explicit cleanup).
    const { stdout: judgeContainers } = await exec(
      "docker",
      ["ps", "-a", "--filter", `name=^/af-${judgeRun.id}$`, "--format", "{{.ID}}"],
      { timeout: 30_000 }
    );
    assert.equal(judgeContainers.trim(), "", "no judge container was left behind");
    // No drift was detected (the read-only mount held), and the workspace is
    // exactly at the pin the judge judged.
    assert.equal(round.drift, undefined);
    assert.equal((await git(workspacePath, ["rev-parse", "HEAD"])).trim(), pinned.commitSha);

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
      "validation.pinned",
      "validation.round.started",
      "validation.verdict",
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
    assert.equal(detail.validation.rounds![0].verdict!.passed, true);
  });

  test("a failing verdict sends the work back: the rework run fixes it and round 2 passes (v12 §4.3/§4.4)", async () => {
    const { remote } = await makeRemote();
    const dataDir = tempDir("af-docker-rework-data-");
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
      name: "E2E rework loop",
      source: { remoteUrl: remote },
      skills: [{ name: "fake-agent", path: skillDir(FAKE_PARTIAL_AGENT_SCRIPT) }],
      // The marker makes "the validation prompt is never injected into the
      // rework instruction" a checkable claim.
      validation: { prompt: "ACCEPTANCE-STANDARD-MARKER: agent-output.txt and src/feature.ts are present" },
    });
    const runtime = await runtimes.create({
      name: "E2E Docker runtime",
      kind: "docker",
      containerized: true,
      executionBackend: "isolated",
      image: IMAGE,
      command: ["sh", "-c", RUNTIME_DISPATCH_SCRIPT],
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

    // The loop ran: round 1 failed, a rework followed, round 2 passed.
    assert.equal(task.execution!.status, "completed", JSON.stringify(task.execution!.failure ?? {}));
    assert.equal(task.execution!.validation!.status, "passed");
    assert.equal(task.execution!.validation!.attempts, 2, "two verdicts were produced");
    const [round1, round2] = task.execution!.validation!.rounds!;
    assert.deepEqual(task.execution!.validation!.rounds!.map((r) => [r.round, r.verdict!.passed]), [
      [1, false],
      [2, true],
    ]);

    // Round 1's verdict is a real failing judgement with the unmet items the
    // judge observed against the pinned revision.
    assert.ok(round1.verdict!.unmet.length > 0);
    assert.match(round1.verdict!.unmet.join(" "), /agent-output\.txt/);
    assert.ok(round1.verdict!.evidence.length > 0, "the failing verdict carries evidence");
    assert.ok(round1.reworkRunId, "the failing verdict triggered a rework run");
    assert.ok(round1.pinnedRevision!.commitSha, "round 1 judged a pin");

    // The rework run is a development run: same workspace, purpose "rework",
    // instructed with the verdict's conclusion — never the validation prompt.
    const reworkRun = runService.get(round1.reworkRunId!)!;
    assert.equal(reworkRun.purpose, "rework");
    assert.equal(reworkRun.workspaceId, task.workspaceId, "the rework continued in the same workspace");
    assert.match(reworkRun.inputInstruction!, /did not pass validation/);
    assert.match(reworkRun.inputInstruction!, /agent-output\.txt/, "the unmet findings were carried");
    assert.equal(
      reworkRun.inputInstruction!.includes("ACCEPTANCE-STANDARD-MARKER"),
      false,
      "the validation prompt itself is never injected into the rework instruction"
    );
    // The judge, by contrast, was given the acceptance standard verbatim.
    const judgeRun = runService.get(round1.judgeRunId!)!;
    assert.match(judgeRun.inputInstruction!, /ACCEPTANCE-STANDARD-MARKER/);

    // Round 2 judged the rework's output: a NEW pin, its own judge run.
    assert.notEqual(round2.pinnedRevision!.commitSha, round1.pinnedRevision!.commitSha);
    assert.equal(round2.pinnedRevision!.runId, reworkRun.id, "round 2's pin came from the rework run");
    assert.notEqual(round2.judgeRunId, round1.judgeRunId);
    // The agent stage reflects the loop honestly and ends completed.
    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.agent!.attempts, 2, "the rework run is an agent attempt");
    assert.equal(task.execution!.stages!.agent!.status, "completed");

    // Publishing happened only after the passing verdict, and the remote has
    // exactly the round-2 pin.
    assert.equal(task.execution!.publish!.status, "pushed");
    assert.equal(task.execution!.frozenRevision!.finalCommitSha, round2.pinnedRevision!.commitSha);
    const remoteSha = (await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim();
    assert.equal(remoteSha, round2.pinnedRevision!.commitSha);
    const workspacePath = new WorkspaceService(store).get(task.workspaceId!)!.path!;
    const log = await git(workspacePath, ["log", "--format=%B"]);
    assert.match(log, /af-pin/, "the completion pins are visible in the commit log");
  });

  test("a last-round failing verdict terminates the task, keeps agent completed, publishes nothing (AC-27/§26 Case E)", async () => {
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
      skills: [{ name: "fake-agent", path: skillDir(FAKE_PARTIAL_AGENT_SCRIPT) }],
      // maxAttempts 1: the first failing verdict exhausts the budget, so the
      // terminal-failure path is what this test exercises.
      validation: { prompt: "agent-output.txt and src/feature.ts are present", maxAttempts: 1 },
    });
    const runtime = await runtimes.create({
      name: "E2E Docker runtime",
      kind: "docker",
      containerized: true,
      executionBackend: "isolated",
      image: IMAGE,
      command: ["sh", "-c", RUNTIME_DISPATCH_SCRIPT],
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
    assert.equal(task.execution!.validation!.attempts, 1);
    assert.equal(task.execution!.failure!.stage, "validation");
    assert.equal(task.execution!.failure!.code, "validation-failed");
    assert.equal(task.execution!.stages!.agent!.status, "completed");
    assert.equal(task.execution!.stages!.validation!.status, "failed");
    assert.equal(task.execution!.publish!.status, "pending", "nothing is published after a failed validation");
    // The failing verdict (a real judgement from inside the judge container)
    // is frozen on the record with its unmet findings.
    const round = task.execution!.validation!.rounds![0];
    assert.equal(round.verdict!.passed, false);
    assert.ok(round.verdict!.unmet.length > 0);
    assert.equal(round.reworkRunId, undefined, "no rework run was started — the budget was exhausted");
    // The task offers "retry validation", not a generic retry.
    const detail = supervisor.taskDetail(task.id);
    assert.equal(detail.retry.kind, "validation");
    assert.equal(detail.retry.validation, true);
    // No branch was published at all.
    const branches = await git(remote, ["branch", "--list", `af/*`]);
    assert.equal(branches.trim(), "", "no branch landed on the remote");
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
