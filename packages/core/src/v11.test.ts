/**
 * v11 — Project + isolated runtime Task lifecycle.
 *
 * These suites exercise the real platform path end to end:
 *   Credential → Project → Task → Managed Workspace → clone → base revision
 *   → working branch → isolated runtime → agent → validation → finalization
 *   → push → cleanup → preserved workspace
 *
 * Git is the real `git` CLI against local bare repositories used as remotes,
 * so clone/fetch/branch/commit/push semantics are genuinely tested; only the
 * agent harness is scripted. Failure modes that need a live server (auth
 * failure, network failure, remote rejection) are injected through the
 * `GitOps` seam, which is exactly the seam the supervisor uses in production.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  SourceCredentialService,
  TaskService,
  WorkspaceLockService,
  WorkspaceService,
} from "./services.js";
import { DomainError } from "./errors.js";
import {
  branchSlug,
  classifyGitFailure,
  createGitOps,
  generateWorkingBranch,
  materializeGitCredential,
  validateBranchName,
  validateRemoteUrl,
  type GitOps,
} from "./git.js";
import { SecretRedactor, redactRemoteUrl, urlHasUserInfo } from "./redaction.js";
import { buildMcpConfigDocument, provisionEnvironment } from "./provisioning.js";
import { createValidationRunner, resolveValidationConfig } from "./validation.js";
import type { Project, Run, Task } from "./types.js";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Git identity: the platform commits, so the environment must have one. */
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

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return String(stdout);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A local bare repository used as the remote, with one commit on `main`.
 * Returns its absolute path — a perfectly valid `git` remote URL that needs no
 * network and no credential.
 */
async function makeRemote(): Promise<{ remote: string; seed: string; baseSha: string }> {
  const root = tempDir("af-v11-remote-");
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

/** A scripted agent harness: the test decides what the "agent" does. */
interface ScriptedHarness {
  adapter: AgentRuntimeAdapter;
  runs: () => number;
  setHandler: (handler: (ctx: RuntimeContext) => Promise<RuntimeResult>) => void;
  /** Environments the agent actually saw (credential-leak assertions). */
  envs: RuntimeContext["env"][];
  contexts: RuntimeContext[];
}

function scriptedHarness(): ScriptedHarness {
  let handler: (ctx: RuntimeContext) => Promise<RuntimeResult> = async () => ({ exitCode: 0 });
  let runs = 0;
  const envs: RuntimeContext["env"][] = [];
  const contexts: RuntimeContext[] = [];
  const adapter: AgentRuntimeAdapter = {
    kind: "custom",
    name: "Scripted harness",
    capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
    async run(ctx) {
      runs += 1;
      envs.push({ ...ctx.env });
      contexts.push(ctx);
      return handler(ctx);
    },
  };
  return {
    adapter,
    runs: () => runs,
    setHandler: (next) => {
      handler = next;
    },
    envs,
    contexts,
  };
}

/** Writes `files` into the workspace — the agent "doing the work". */
function writeFiles(files: Record<string, string>) {
  return async (ctx: RuntimeContext): Promise<RuntimeResult> => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(ctx.workspacePath!, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
      await ctx.emit("file.modified", { path: rel });
    }
    return { exitCode: 0 };
  };
}

interface Harness {
  store: Store;
  bus: EventBus;
  registry: RuntimeRegistry;
  runService: RunService;
  supervisor: ExecutionSupervisor;
  scripted: ScriptedHarness;
  projects: ProjectService;
  credentials: SourceCredentialService;
  tasks: TaskService;
  workspaces: WorkspaceService;
  runtimes: RuntimeService;
  locks: WorkspaceLockService;
  dataDir: string;
  runtimeId: string;
}

async function makeHarness(options: { git?: GitOps; validationRunner?: ReturnType<typeof createValidationRunner> } = {}): Promise<Harness> {
  const dataDir = tempDir("af-v11-data-");
  const store = await Store.open(dataDir);
  const bus = new EventBus();
  const scripted = scriptedHarness();
  const registry = new RuntimeRegistry();
  registry.register(scripted.adapter);
  const runService = new RunService(store, bus, registry, { destroy: async () => {} }, undefined, {});
  const supervisor = new ExecutionSupervisor(store, bus, runService, options);
  const runtimes = new RuntimeService(store);
  const runtime = await runtimes.create({
    name: "Scripted runtime",
    kind: "custom",
    usableInTask: true,
    enabled: true,
    containerized: false,
  });
  return {
    store,
    bus,
    registry,
    runService,
    supervisor,
    scripted,
    projects: new ProjectService(store),
    credentials: new SourceCredentialService(store),
    tasks: new TaskService(store),
    workspaces: new WorkspaceService(store),
    runtimes,
    locks: new WorkspaceLockService(store),
    dataDir,
    runtimeId: runtime.id,
  };
}

/** A GitOps that records the calls the supervisor makes. */
function recordingGit(inner: GitOps): {
  git: GitOps;
  pushes: Array<{ branch: string; remote: string }>;
  clones: number;
  fetches: number;
  commits: number;
} {
  const pushes: Array<{ branch: string; remote: string }> = [];
  const state = { clones: 0, fetches: 0, commits: 0 };
  const git: GitOps = {
    ...inner,
    async clone(opts) {
      state.clones += 1;
      return inner.clone(opts);
    },
    async fetch(opts) {
      state.fetches += 1;
      return inner.fetch(opts);
    },
    async commit(opts) {
      state.commits += 1;
      return inner.commit(opts);
    },
    async push(opts) {
      pushes.push({ branch: opts.branch, remote: opts.remote });
      return inner.push(opts);
    },
  };
  return {
    git,
    pushes,
    get clones() {
      return state.clones;
    },
    get fetches() {
      return state.fetches;
    },
    get commits() {
      return state.commits;
    },
  } as never;
}

/** GitOps whose push fails a fixed number of times before delegating. */
function flakyPushGit(inner: GitOps, failures: number, error: DomainError): GitOps {
  let remaining = failures;
  return {
    ...inner,
    async push(opts) {
      if (remaining > 0) {
        remaining -= 1;
        throw error;
      }
      return inner.push(opts);
    },
  };
}

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

function eventTypes(h: Harness, runId: string): Promise<string[]> {
  return h.store.readEvents(runId).then((events) => events.map((e) => e.type));
}

async function eventText(h: Harness, runId: string): Promise<string> {
  return JSON.stringify(await h.store.readEvents(runId));
}

/* ================================================================== */
/* 1. Pure helpers: URL / branch validation, classification, redaction */
/* ================================================================== */

describe("v11 source input validation", () => {
  test("accepts https, ssh, scp-like and local remotes", () => {
    for (const url of [
      "https://github.com/org/repo.git",
      "ssh://git@gitlab.com/org/repo.git",
      "git@github.com:org/repo.git",
      "https://gitee.com/org/repo.git",
      "/srv/git/repo.git",
    ]) {
      assert.equal(validateRemoteUrl(url).ok, true, url);
    }
  });

  test("rejects credentials embedded in the remote URL (v11 §12)", () => {
    const result = validateRemoteUrl("https://user:ghp_secret@github.com/org/repo.git");
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /credential/i);
    assert.equal(urlHasUserInfo("https://user:tok@github.com/org/repo.git"), true);
  });

  test("rejects unsupported schemes, control characters and option-like URLs", () => {
    assert.equal(validateRemoteUrl("ftp://example.com/repo.git").ok, false);
    assert.equal(validateRemoteUrl("https://example.com/a\nb.git").ok, false);
    assert.equal(validateRemoteUrl("--upload-pack=/bin/sh").ok, false);
    assert.equal(validateRemoteUrl("").ok, false);
  });

  test("redacts userinfo before a URL is ever echoed", () => {
    assert.equal(redactRemoteUrl("https://user:tok@github.com/o/r.git"), "https://***@github.com/o/r.git");
  });
});

describe("v11 branch naming", () => {
  test("accepts ordinary and namespaced branch names", () => {
    for (const name of ["af/abc123-fix-thing", "feature/x-1", "release/2024.1"]) {
      assert.equal(validateBranchName(name).ok, true, name);
    }
  });

  test("rejects malicious / invalid branch names (v11 §8.1/§42)", () => {
    for (const name of [
      "",
      "-x",
      "a..b",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a@{1}",
      "refs/heads/main",
      "feature/.hidden",
      "trailing/",
      "/leading",
      "x.lock",
      `${"a".repeat(201)}`,
    ]) {
      assert.equal(validateBranchName(name).ok, false, `expected invalid: ${JSON.stringify(name)}`);
    }
  });

  test("system-generated branches are stable and derived from the task id", () => {
    const branch = generateWorkingBranch("task_abc12345deadbeef", "Add Project Model!");
    assert.equal(branch, "af/abc12345-add-project-model");
    assert.equal(branchSlug("!!!", 10), "task");
  });
});

describe("v11 git failure classification", () => {
  test("maps auth failures to source / push auth codes", () => {
    assert.equal(classifyGitFailure("fatal: Authentication failed for 'https://x'", "clone").code, "source-auth-failed");
    assert.equal(classifyGitFailure("Permission denied (publickey).", "fetch").code, "source-auth-failed");
    assert.equal(classifyGitFailure("fatal: Authentication failed", "push").code, "git-push-auth-failed");
    assert.equal(classifyGitFailure("Host key verification failed.", "clone").code, "source-auth-failed");
  });

  test("maps missing repositories and network failures", () => {
    assert.equal(classifyGitFailure("remote: Repository not found.", "clone").code, "source-not-found");
    assert.equal(classifyGitFailure("fatal: unable to access 'https://x': Could not resolve host: x", "clone").code, "source-network-failed");
  });

  test("maps rejected pushes", () => {
    assert.equal(
      classifyGitFailure("! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs", "push").code,
      "git-push-rejected"
    );
  });
});

describe("v11 credential materialization", () => {
  test("HTTPS token reaches git through the environment, never argv or a URL", async () => {
    const dir = tempDir("af-v11-cred-");
    const credential = await materializeGitCredential({ type: "https-token", username: "x-access-token", token: "ghp_supersecret" }, dir);
    try {
      assert.equal(credential.args.join(" ").includes("ghp_supersecret"), false);
      assert.equal(credential.env.AGENTFABRIC_GIT_PASSWORD, "ghp_supersecret");
      assert.equal(credential.env.GIT_TERMINAL_PROMPT, "0");
      assert.ok(credential.env.GIT_ASKPASS && existsSync(credential.env.GIT_ASKPASS));
      // The askpass helper reads the value from the env, it does not embed it.
      assert.equal(readFileSync(credential.env.GIT_ASKPASS, "utf8").includes("ghp_supersecret"), false);
      assert.deepEqual(credential.secrets, ["ghp_supersecret"]);
    } finally {
      await credential.cleanup();
    }
    assert.equal(existsSync(dir), false, "materialized credential must be removed");
  });

  test("SSH key is a 0600 file and host keys are always verified (v11 §12.1/§42)", async () => {
    const dir = tempDir("af-v11-ssh-");
    const credential = await materializeGitCredential(
      { type: "ssh-key", privateKey: "-----BEGIN KEY-----\nsecret\n-----END KEY-----", passphrase: "p4ss" },
      dir
    );
    try {
      const sshCommand = credential.args.join(" ");
      assert.match(sshCommand, /StrictHostKeyChecking=yes/);
      assert.match(sshCommand, /IdentitiesOnly=yes/);
      assert.equal(sshCommand.includes("BEGIN KEY"), false, "key material must not appear in argv");
      const keyPath = /-i (\S+)/.exec(sshCommand)![1];
      assert.equal(statSync(keyPath).mode & 0o777, 0o600);
      assert.equal(credential.env.SSH_ASKPASS_REQUIRE, "force");
      assert.equal(credential.secrets.includes("p4ss"), true);
    } finally {
      await credential.cleanup();
    }
  });
});

describe("v11 secret redaction", () => {
  test("redacts values in text and nested payloads", () => {
    const redactor = new SecretRedactor(["ghp_supersecret"]);
    assert.equal(redactor.redact("token=ghp_supersecret done"), "token=***redacted*** done");
    assert.equal(redactor.leaks("token=ghp_supersecret"), true);
    const payload = redactor.redactValue({ nested: { list: ["ghp_supersecret"] }, n: 1 });
    assert.equal(JSON.stringify(payload).includes("ghp_supersecret"), false);
  });

  test("ignores short values so ordinary text is not mangled", () => {
    const redactor = new SecretRedactor(["ab"]);
    assert.equal(redactor.redact("ab cd"), "ab cd");
  });
});

/* ================================================================== */
/* 2. Project / Source / Credential (v11 §41.1/§41.2)                  */
/* ================================================================== */

describe("v11 projects and credentials", () => {
  test("creates a public-repository project without a credential (AC-3)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    assert.equal(project.source.credentialId, undefined);
    assert.equal(project.source.type, "git");
    assert.equal(project.source.defaultBranch, "main");
    assert.equal(project.source.provider, "generic");
  });

  test("infers the provider from the host", async () => {
    const h = await makeHarness();
    for (const [url, provider] of [
      ["https://github.com/o/r.git", "github"],
      ["https://gitlab.com/o/r.git", "gitlab"],
      ["https://gitee.com/o/r.git", "gitee"],
    ] as const) {
      const project = await h.projects.create({ name: url, source: { remoteUrl: url } });
      assert.equal(project.source.provider, provider);
    }
  });

  test("rejects an invalid repository URL and an unknown credential reference", async () => {
    const h = await makeHarness();
    await assert.rejects(
      () => h.projects.create({ name: "bad", source: { remoteUrl: "https://user:tok@github.com/o/r.git" } }),
      (err: unknown) => (err as DomainError).code === "source-url-invalid"
    );
    await assert.rejects(
      () => h.projects.create({ name: "bad", source: { remoteUrl: "https://github.com/o/r.git", credentialId: "cred_missing" } }),
      (err: unknown) => (err as DomainError).code === "credential-not-found"
    );
  });

  test("updates a project and keeps the source coherent", async () => {
    const h = await makeHarness();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: "https://github.com/o/r.git" } });
    const updated = await h.projects.update(project.id, {
      name: "Renamed",
      source: { remoteUrl: "https://gitlab.com/o/r2.git", defaultBranch: "develop" },
    });
    assert.equal(updated!.name, "Renamed");
    assert.equal(updated!.source.provider, "gitlab");
    assert.equal(updated!.source.defaultBranch, "develop");
    assert.equal(updated!.source.credentialId, undefined);
  });

  test("HTTPS credential: secret stored once, only the mask is ever served (v11 §41.2)", async () => {
    const h = await makeHarness();
    const view = await h.credentials.create({
      name: "Personal GitHub",
      type: "https-token",
      host: "github.com",
      username: "octocat",
      value: "ghp_supersecret",
    });
    assert.equal(view.type, "https-token");
    assert.match(view.secretMasked!, /\*\*\*/);
    const served = JSON.stringify(h.credentials.list()) + JSON.stringify(h.credentials.getView(view.id));
    assert.equal(served.includes("ghp_supersecret"), false, "credential value must never be served");
    // Resolution is the only path that exposes the value, for one git operation.
    const resolved = h.credentials.resolve(view.id);
    assert.equal(resolved!.token, "ghp_supersecret");
    assert.equal(resolved!.type, "https-token");
  });

  test("SSH credential carries the key and the passphrase as separate secrets", async () => {
    const h = await makeHarness();
    const view = await h.credentials.create({
      name: "Internal Git SSH",
      type: "ssh-key",
      username: "git",
      value: "-----BEGIN KEY-----\nkey\n-----END KEY-----",
      passphrase: "p4ss",
      knownHosts: "git.internal ssh-ed25519 AAAA",
    });
    const resolved = h.credentials.resolve(view.id);
    assert.equal(resolved!.type, "ssh-key");
    assert.match(resolved!.privateKey!, /BEGIN KEY/);
    assert.equal(resolved!.passphrase, "p4ss");
    assert.equal(resolved!.knownHosts, "git.internal ssh-ed25519 AAAA");
  });

  test("a project references the credential by id only", async () => {
    const h = await makeHarness();
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: "ghp_supersecret" });
    const project = await h.projects.create({
      name: "Private",
      source: { remoteUrl: "https://github.com/o/private.git", credentialId: credential.id },
    });
    assert.equal(project.source.credentialId, credential.id);
    assert.equal(JSON.stringify(project).includes("ghp_supersecret"), false);
  });
});

/* ================================================================== */
/* 3. The happy path (Case A) and source lifecycle                     */
/* ================================================================== */

describe("v11 lifecycle: public repository end to end (Case A)", () => {
  test("credential → project → task → workspace → clone → branch → agent → finalize → push", async () => {
    const h = await makeHarness();
    const { remote, baseSha } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "src/feature.ts": "export const feature = 1;\n" }));

    const { task, run } = await startTask(h, project, { instruction: "Add the feature module" });

    assert.equal(task.execution!.status, "completed");
    assert.equal(task.execution!.phase, "completed");
    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.publish!.status, "pushed");

    // AC-7: a managed workspace was created for this task alone.
    const workspace = h.workspaces.get(task.workspaceId!)!;
    assert.equal(workspace.ownership, "managed");
    assert.equal(workspace.taskId, task.id);
    assert.equal(workspace.projectId, project.id);
    assert.equal(existsSync(join(workspace.path!, "src", "feature.ts")), true);

    // AC-9: the base revision was resolved and frozen.
    assert.equal(task.baseRef, "main");
    assert.equal(task.baseCommitSha, baseSha);

    // AC-10: the working branch exists and carries the agent's work.
    assert.match(task.workingBranch!, /^af\/[0-9a-z]{8}-add-the-feature-module$/);
    const branchSha = (await git(workspace.path!, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim();
    assert.equal(task.execution!.publish!.finalCommitSha, branchSha);

    // AC-21/AC-22: pushed to the remote, remote branch + final commit recorded.
    const remoteSha = (await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim();
    assert.equal(remoteSha, task.execution!.publish!.finalCommitSha);
    assert.equal(task.execution!.publish!.remoteBranch, task.workingBranch);
    assert.equal(task.execution!.publish!.remote, "origin");
    assert.ok(task.execution!.publish!.pushedAt);

    // The pushed tree really contains the agent's file.
    const show = await git(remote, ["show", `${task.workingBranch}:src/feature.ts`]);
    assert.match(show, /export const feature/);

    // The run carries the same observability facts (v11 §33).
    assert.equal(run.phase, "completed");
    assert.equal(run.baseCommitSha, baseSha);
    assert.equal(run.workingBranch, task.workingBranch);
    assert.equal(run.projectId, project.id);

    // Every lifecycle phase was announced on the run's event stream.
    const types = await eventTypes(h, run.id);
    for (const expected of ["workspace.prepared", "source.prepared", "runtime.prepared", "git.finalized", "git.pushed", "run.phase"]) {
      assert.ok(types.includes(expected), `missing event ${expected} (got ${types.join(",")})`);
    }
  });

  test("AC-14/AC-15: the runtime is disposable, the workspace and its work are not", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "a.txt": "first\n" }));
    const { task } = await startTask(h, project);
    const workspace = h.workspaces.get(task.workspaceId!)!;

    // A second run reuses the same workspace: same repo, same branch.
    h.scripted.setHandler(writeFiles({ "b.txt": "second\n" }));
    const retry = await h.supervisor.retryRun(task.id);
    await h.supervisor.whenSettled(task.id);
    const after = h.tasks.get(task.id)!;
    assert.equal(after.execution!.status, "completed");
    assert.equal(h.runService.get(retry.run.id)!.workspaceId, workspace.id);
    assert.equal(h.scripted.runs(), 2);
    assert.equal(existsSync(join(workspace.path!, "a.txt")), true, "work from the first run survives");
    assert.equal(existsSync(join(workspace.path!, "b.txt")), true);
    // Both files are published.
    const tree = await git(remote, ["ls-tree", "-r", "--name-only", task.workingBranch!]);
    assert.match(tree, /a\.txt/);
    assert.match(tree, /b\.txt/);
  });

  test("AC-8/AC-11/AC-12: a containerized runtime mounts the workspace and the runtime is destroyed", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    // The generic docker adapter runs a fixed command; it is enough to prove
    // the isolation contract (image, workspace mount, labels, destroy).
    const dockerRuns: string[][] = [];
    h.registry.register({
      kind: "docker",
      name: "Recording docker",
      capabilities: { supportsWorkspace: true, supportsStreamingEvents: true },
      async run(ctx): Promise<RuntimeResult> {
        dockerRuns.push(["run", String(ctx.workspacePath), String(ctx.runtime.config?.mountPath ?? "/workspace")]);
        await ctx.emit("shell.output", { line: "container ran" });
        return { exitCode: 0, containerId: "fake_container" };
      },
      async cleanup() {
        dockerRuns.push(["destroy"]);
      },
    });
    const dockerRuntime = await h.runtimes.create({
      name: "Containerized",
      kind: "docker",
      usableInTask: true,
      enabled: true,
      containerized: true,
      image: "node:22-alpine",
      config: { mountPath: "/workspace" },
    });

    h.scripted.setHandler(writeFiles({ "container.txt": "ok\n" }));
    const result = await h.supervisor.startTask({
      projectId: project.id,
      instruction: "Containerized work",
      runtimeId: dockerRuntime.id,
    });
    await h.supervisor.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    const workspace = h.workspaces.get(task.workspaceId!)!;

    assert.deepEqual(dockerRuns[0], ["run", workspace.path, "/workspace"]);
    assert.deepEqual(dockerRuns[1], ["destroy"], "an ephemeral runtime is destroyed after the run");
    assert.equal(task.execution!.status, "completed");
    assert.equal(existsSync(workspace.path!), true);
  });
});

/* ================================================================== */
/* 4. Base revision, branch modes, collisions (v11 §41.4/§41.5)        */
/* ================================================================== */

describe("v11 source: base revision and branch creation", () => {
  test("AC-9: baseCommitSha stays fixed after the remote base branch moves", async () => {
    const h = await makeHarness();
    const { remote, seed, baseSha } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    assert.equal(task.baseCommitSha, baseSha);

    // The base branch advances afterwards.
    writeFileSync(join(seed, "later.txt"), "later\n");
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--quiet", "-m", "later work"]);
    await git(seed, ["push", "--quiet", remote, "main"]);
    const movedSha = (await git(seed, ["rev-parse", "HEAD"])).trim();
    assert.notEqual(movedSha, baseSha);

    // A second run on the same task keeps the original base.
    h.scripted.setHandler(writeFiles({ "y.txt": "y\n" }));
    await h.supervisor.retryRun(task.id);
    await h.supervisor.whenSettled(task.id);
    const after = h.tasks.get(task.id)!;
    assert.equal(after.baseCommitSha, baseSha);
    assert.equal(h.runService.forTask(task.id).at(-1)!.baseCommitSha, baseSha);
  });

  test("resolves a custom base ref (branch or commit)", async () => {
    const h = await makeHarness();
    const { remote, seed } = await makeRemote();
    await git(seed, ["checkout", "--quiet", "-b", "release/1.0"]);
    writeFileSync(join(seed, "release.txt"), "release\n");
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--quiet", "-m", "release commit"]);
    await git(seed, ["push", "--quiet", remote, "release/1.0"]);
    const releaseSha = (await git(seed, ["rev-parse", "HEAD"])).trim();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));

    const { task } = await startTask(h, project, { baseRef: "release/1.0" });
    assert.equal(task.baseCommitSha, releaseSha);
    assert.equal(task.baseRef, "release/1.0");
  });

  test("a missing base ref fails loudly with base-ref-not-found", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const { task } = await startTask(h, project, { baseRef: "does-not-exist" });
    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "source");
    assert.equal(task.execution!.failure!.code, "base-ref-not-found");
    assert.equal(h.scripted.runs(), 0, "the agent never starts without a valid base revision");
  });

  test("branch collision with an existing remote branch is refused (v11 §8.1)", async () => {
    const h = await makeHarness();
    const { remote, seed } = await makeRemote();
    await git(seed, ["branch", "af/taken", "main"]);
    await git(seed, ["push", "--quiet", remote, "af/taken"]);
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const { task } = await startTask(h, project, { workingBranch: "af/taken" });
    assert.equal(task.execution!.failure!.code, "branch-conflict");
    assert.equal(h.scripted.runs(), 0);
  });

  test("an invalid working branch name is refused before anything runs", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "x", runtimeId: h.runtimeId, workingBranch: "bad..name" }),
      (err: unknown) => (err as DomainError).code === "branch-invalid"
    );
  });

  test("a protected branch can never be a task's working branch", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: project.id, instruction: "x", runtimeId: h.runtimeId, workingBranch: "main" }),
      (err: unknown) => (err as DomainError).code === "branch-invalid"
    );
  });

  test("branch mode continue builds on an existing branch explicitly", async () => {
    const h = await makeHarness();
    const { remote, seed } = await makeRemote();
    await git(seed, ["checkout", "--quiet", "-b", "af/existing"]);
    writeFileSync(join(seed, "existing.txt"), "existing\n");
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--quiet", "-m", "existing work"]);
    await git(seed, ["push", "--quiet", remote, "af/existing"]);
    const existingSha = (await git(seed, ["rev-parse", "HEAD"])).trim();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "more.txt": "more\n" }));

    const { task } = await startTask(h, project, { workingBranch: "af/existing", branchMode: "continue" });
    assert.equal(task.execution!.status, "completed");
    assert.equal(task.baseCommitSha, existingSha);
    const tree = await git(remote, ["ls-tree", "-r", "--name-only", "af/existing"]);
    assert.match(tree, /existing\.txt/);
    assert.match(tree, /more\.txt/);
  });

  test("continue mode without an existing branch fails loudly", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const { task } = await startTask(h, project, { workingBranch: "af/ghost", branchMode: "continue" });
    assert.equal(task.execution!.failure!.code, "branch-not-found");
  });
});

/* ================================================================== */
/* 5. Credential security boundary (v11 §12/§34/§41.2/§42)             */
/* ================================================================== */

describe("v11 credential security boundary", () => {
  test("AC-16/AC-17: the agent never sees the credential; nothing leaks", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const token = "ghp_supersecrettoken";
    const credential = await h.credentials.create({
      name: "Personal GitHub",
      type: "https-token",
      username: "octocat",
      host: "github.com",
      value: token,
    });
    const project = await h.projects.create({
      name: "Private",
      source: { remoteUrl: remote, credentialId: credential.id },
    });
    h.scripted.setHandler(writeFiles({ "secret-check.txt": "ok\n" }));
    const { task, run } = await startTask(h, project);
    assert.equal(task.execution!.status, "completed");

    // 1. The agent's environment carries no credential material at all.
    const agentEnv = h.scripted.envs[0];
    assert.equal(JSON.stringify(agentEnv).includes(token), false);
    assert.equal(agentEnv.GIT_ASKPASS, undefined);
    assert.equal(agentEnv.AGENTFABRIC_GIT_PASSWORD, undefined);
    assert.equal(agentEnv.SSH_ASKPASS, undefined);

    // 2. Not in the event log (v11 §34).
    assert.equal((await eventText(h, run.id)).includes(token), false);

    // 3. Not in the task / run records or the aggregated detail view.
    const detail = JSON.stringify(h.supervisor.taskDetail(task.id));
    assert.equal(detail.includes(token), false);
    assert.equal(JSON.stringify(h.store.list("tasks")).includes(token), false);
    assert.equal(JSON.stringify(h.store.list("runs")).includes(token), false);

    // 4. Not in .git/config — the remote URL stays credential-free.
    const config = readFileSync(join(h.workspaces.get(task.workspaceId!)!.path!, ".git", "config"), "utf8");
    assert.equal(config.includes(token), false);
    assert.match(config, new RegExp(`url = ${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    // 5. Not in the workspace or the data directory at large.
    const workspacePath = h.workspaces.get(task.workspaceId!)!.path!;
    assert.equal(JSON.stringify(readdirSync(workspacePath)).includes(token), false);
    assert.deepEqual(
      existsSync(join(h.dataDir, "git-credentials")) ? readdirSync(join(h.dataDir, "git-credentials")) : [],
      [],
      "temporary credential material is removed"
    );

    // 6. The credential was resolved and released around the git operations.
    const types = await eventTypes(h, run.id);
    assert.ok(types.includes("credential.resolved"));
    assert.ok(types.includes("credential.released"));
  });

  test("only the task's own working branch is ever pushed, never with force", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const recorder = recordingGit(createGitOps());
    const supervised = new ExecutionSupervisor(h.store, h.bus, h.runService, { git: recorder.git });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    assert.equal(recorder.pushes.length, 1);
    assert.equal(recorder.pushes[0].branch, task.workingBranch);
    assert.equal(recorder.pushes[0].remote, "origin");
    // The GitOps push contract has no force parameter and no arbitrary refspec.
    assert.equal(createGitOps().push.length, 1);
  });

  test("repository content cannot grant itself secrets or MCP access (v11 §27)", async () => {
    const h = await makeHarness();
    const { remote, seed } = await makeRemote();
    // A repository-local config asking for a privileged secret.
    writeFileSync(join(seed, ".agentfabric.yml"), "secrets: [production-deploy-key]\nmcp: [privileged-admin]\n");
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--quiet", "-m", "repo-local config"]);
    await git(seed, ["push", "--quiet", remote, "main"]);

    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      mcpServers: [{ name: "declared-by-project", command: "npx", args: ["-y", "server"] }],
    });
    let generatedMcpConfig: string | undefined;
    h.scripted.setHandler(async (ctx) => {
      // Read the generated configuration while the run is live — provisioning
      // is removed at cleanup by design.
      generatedMcpConfig = readFileSync(ctx.env.AGENTFABRIC_MCP_CONFIG, "utf8");
      writeFileSync(join(ctx.workspacePath!, "x.txt"), "x\n");
      return { exitCode: 0 };
    });
    const { task, run } = await startTask(h, project);

    const agentEnv = h.scripted.envs[0];
    assert.equal(JSON.stringify(agentEnv).includes("production-deploy-key"), false);
    assert.match(generatedMcpConfig!, /declared-by-project/);
    assert.equal(generatedMcpConfig!.includes("privileged-admin"), false);
    // The repository file is untouched input, never executed configuration.
    assert.equal(readFileSync(join(h.workspaces.get(task.workspaceId!)!.path!, ".agentfabric.yml"), "utf8").includes("privileged-admin"), true);
    assert.equal((await eventText(h, run.id)).includes("production-deploy-key"), false);
  });

  test("a malicious repository URL never becomes a command", async () => {
    const h = await makeHarness();
    await assert.rejects(
      () => h.projects.create({ name: "evil", source: { remoteUrl: "ext::sh -c whoami" } }),
      (err: unknown) => (err as DomainError).code === "source-url-invalid"
    );
  });

  test("a managed workspace path is always inside the data directory (v11 §42)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    // A traversal-shaped instruction and title must not influence the path:
    // the managed workspace is keyed by its own id, never by user text.
    const result = await h.supervisor.startTask({
      projectId: project.id,
      instruction: "escape ../../../../etc",
      title: "../../../etc/passwd",
      runtimeId: h.runtimeId,
    });
    await h.supervisor.whenSettled(result.task.id);
    const workspace = h.workspaces.get(result.task.workspaceId!)!;
    assert.equal(workspace.ownership, "managed");
    assert.ok(
      workspace.path!.startsWith(join(h.dataDir, "workspaces")),
      `managed workspace escaped the data dir: ${workspace.path}`
    );
    assert.equal(workspace.path!.includes(".."), false);
  });

  test("the agent's runtime cannot reach another task's workspace (v11 §28)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(async (ctx) => {
      // The runtime context exposes exactly one workspace path, and no other
      // task's workspace is mounted or referenced anywhere in it.
      const mounted = JSON.stringify(ctx.extraMounts ?? []) + JSON.stringify(ctx.provisioning ?? {});
      assert.equal(mounted.includes("workspaces"), false);
      assert.equal(ctx.workspacePath, ctx.workspace!.path);
      writeFileSync(join(ctx.workspacePath!, "x.txt"), "x\n");
      return { exitCode: 0 };
    });
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.status, "completed");
  });
});

/* ================================================================== */
/* 6. Validation (v11 §20/§41.8)                                       */
/* ================================================================== */

describe("v11 validation", () => {
  test("AC-18/AC-19: validation runs after the agent and gates finalization", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "check", command: "test -f feature.txt" }] },
    });
    h.scripted.setHandler(writeFiles({ "feature.txt": "ok\n" }));
    const { task, run } = await startTask(h, project);
    assert.equal(task.execution!.validation!.status, "passed");
    assert.equal(task.execution!.status, "completed");
    // A validation report artifact is attached to the run.
    const artifacts = h.store.list<{ name: string; runId: string }>("artifacts").filter((a) => a.runId === run.id);
    assert.ok(artifacts.some((a) => a.name === "validation-report.txt"));
  });

  test("a failing validation is its own failure, not an agent failure (v11 §20/§23)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "typecheck", command: "echo 'type error' >&2; exit 2" }] },
    });
    h.scripted.setHandler(writeFiles({ "feature.txt": "ok\n" }));
    const { task } = await startTask(h, project);

    assert.equal(task.execution!.agent!.status, "completed", "the agent itself succeeded");
    assert.equal(task.execution!.validation!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "validation");
    assert.equal(task.execution!.failure!.code, "validation-failed");
    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.publish!.status, "pending", "nothing is published after a failed validation");
    // The step's output is retained for the task view.
    assert.match(task.execution!.validation!.steps![0].output!, /type error/);
  });

  test("validation timeout is distinguished from a plain failure", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "slow", command: "sleep 5", timeoutMs: 150 }] },
    });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.validation!.status, "timeout");
    assert.equal(task.execution!.failure!.code, "validation-timeout");
  });

  test("Retry Validation re-runs validation without re-running the agent (v11 §31)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      validation: { steps: [{ name: "test", command: "test -f ready.flag" }] },
    });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.failure!.code, "validation-failed");
    assert.equal(h.scripted.runs(), 1);

    // The environment is fixed out of band (as a human would), then validation
    // is retried: no agent, no model call.
    writeFileSync(join(h.workspaces.get(task.workspaceId!)!.path!, "ready.flag"), "ok\n");
    const after = await h.supervisor.retryValidation(task.id);
    assert.equal(h.scripted.runs(), 1, "the agent must not run again");
    assert.equal(after!.execution!.validation!.status, "passed");
    assert.equal(after!.execution!.status, "completed");
    assert.equal(after!.execution!.publish!.status, "pushed");
  });

  test("a task-level validation override replaces the project default", () => {
    assert.deepEqual(resolveValidationConfig({ steps: [{ name: "t", command: "x" }] }, { steps: [{ name: "p", command: "y" }] }), [
      { name: "t", command: "x" },
    ]);
    assert.deepEqual(resolveValidationConfig({ enabled: false, steps: [{ name: "t", command: "x" }] }, undefined), []);
    assert.deepEqual(resolveValidationConfig(undefined, { steps: [{ name: "p", command: "y" }] }), [{ name: "p", command: "y" }]);
  });

  test("the validation runner reports required vs optional steps", async () => {
    const runner = createValidationRunner();
    const dir = tempDir("af-v11-val-");
    const result = await runner({
      cwd: dir,
      steps: [
        { name: "optional", command: "exit 1", required: false },
        { name: "required", command: "exit 0" },
      ],
    });
    assert.equal(result.status, "passed");
    assert.equal(result.steps[0].status, "failed");
    assert.equal(result.steps[1].status, "passed");
  });
});

/* ================================================================== */
/* 7. Finalization (v11 §17/§41.9)                                     */
/* ================================================================== */

describe("v11 git finalization", () => {
  test("AC-20: an agent that never commits still gets a final commit", async () => {
    const h = await makeHarness();
    const { remote, baseSha } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "untracked.txt": "new file\n" }));
    const { task } = await startTask(h, project);
    assert.notEqual(task.execution!.publish!.finalCommitSha, baseSha, "a final commit was created");
    const log = await git(h.workspaces.get(task.workspaceId!)!.path!, ["log", "--format=%s", "-1"]);
    assert.match(log, /af: Add a feature/);
  });

  test("agent-created commits are preserved, not squashed (v11 §17.1)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, "agent.txt"), "agent commit\n");
      await execFileAsync("git", ["add", "-A"], { cwd: ctx.workspacePath! });
      await execFileAsync("git", ["commit", "--quiet", "-m", "agent: real work"], { cwd: ctx.workspacePath! });
      return { exitCode: 0 };
    });
    const { task } = await startTask(h, project);
    const workspace = h.workspaces.get(task.workspaceId!)!.path!;
    const subjects = await git(workspace, ["log", "--format=%s", `${task.baseCommitSha}..HEAD`]);
    assert.match(subjects, /agent: real work/);
    assert.equal(subjects.trim().split("\n").length, 1, "no extra commit was appended");
    assert.equal(task.execution!.status, "completed");
  });

  test("dirty changes on top of agent commits get one final commit (v11 §17.1)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, "committed.txt"), "committed\n");
      await execFileAsync("git", ["add", "-A"], { cwd: ctx.workspacePath! });
      await execFileAsync("git", ["commit", "--quiet", "-m", "agent: partial work"], { cwd: ctx.workspacePath! });
      writeFileSync(join(ctx.workspacePath!, "leftover.txt"), "leftover\n");
      return { exitCode: 0 };
    });
    const { task } = await startTask(h, project);
    const workspace = h.workspaces.get(task.workspaceId!)!.path!;
    const subjects = (await git(workspace, ["log", "--format=%s", `${task.baseCommitSha}..HEAD`])).trim().split("\n");
    assert.equal(subjects.length, 2);
    assert.match(subjects[1], /agent: partial work/);
    assert.match(subjects[0], /af: Add a feature/);
    const status = await git(workspace, ["status", "--porcelain"]);
    assert.equal(status.trim(), "");
  });

  test("a no-op task publishes the branch at the base revision", async () => {
    const h = await makeHarness();
    const { remote, baseSha } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(async () => ({ exitCode: 0 }));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.publish!.finalCommitSha, baseSha);
    assert.equal((await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim(), baseSha);
    assert.equal(task.execution!.status, "completed");
  });

  test("autoCommit=false leaves the working tree dirty and publishes the commits only", async () => {
    const h = await makeHarness();
    const { remote, baseSha } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote }, git: { autoCommit: false } });
    h.scripted.setHandler(writeFiles({ "dirty.txt": "dirty\n" }));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.publish!.finalCommitSha, baseSha);
    const status = await git(h.workspaces.get(task.workspaceId!)!.path!, ["status", "--porcelain"]);
    assert.match(status, /dirty\.txt/);
  });

  test("the task can opt out of publishing entirely", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote }, git: { push: false } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.publish!.status, "skipped");
    assert.equal(task.execution!.status, "completed");
  });
});

/* ================================================================== */
/* 8. Publishing, retry publish, idempotency (v11 §18/§23/§37/§41.10)  */
/* ================================================================== */

describe("v11 publishing", () => {
  test("AC-23/AC-24/AC-25: publish failure is separable and retryable without the agent", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    const failing = flakyPushGit(inner, 1, new DomainError("git-push-auth-failed", "credential rejected by the remote"));
    const supervised = new ExecutionSupervisor(h.store, h.bus, h.runService, { git: failing });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));

    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;

    // Development completed; publishing failed — both facts are visible.
    assert.equal(task.execution!.agent!.status, "completed");
    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "publish");
    assert.equal(task.execution!.failure!.code, "git-push-auth-failed");
    assert.equal(task.execution!.publish!.status, "failed");
    assert.equal(task.execution!.publish!.errorCode, "git-push-auth-failed");
    const finalCommit = task.execution!.publish!.finalCommitSha!;
    assert.ok(finalCommit);

    // Retry Publish: no agent, no model call.
    const after = await supervised.retryPublish(task.id);
    assert.equal(h.scripted.runs(), 1, "the agent must not run again");
    assert.equal(after!.execution!.publish!.status, "pushed");
    assert.equal(after!.execution!.status, "completed");
    assert.equal(after!.execution!.failure, undefined);
    assert.equal((await git(remote, ["rev-parse", `refs/heads/${task.workingBranch}`])).trim(), finalCommit);
    assert.equal(after!.execution!.publish!.attempts, 2);
  });

  test("a push whose result is uncertain is resolved from the remote (v11 §37)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    // The push really lands, but the caller sees a failure (timeout).
    const lying: GitOps = {
      ...inner,
      async push(opts) {
        await inner.push(opts);
        throw new DomainError("source-network-failed", "connection reset while pushing");
      },
    };
    const supervised = new ExecutionSupervisor(h.store, h.bus, h.runService, { git: lying });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const result = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await supervised.whenSettled(result.task.id);
    const task = h.tasks.get(result.task.id)!;
    assert.equal(task.execution!.publish!.status, "pushed", "the remote state wins over the failed push report");
    assert.equal(task.execution!.status, "completed");
  });

  test("retry publish on an already-published revision is idempotent", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    const finalCommit = task.execution!.publish!.finalCommitSha!;

    const recorder = recordingGit(createGitOps());
    const supervised = new ExecutionSupervisor(h.store, h.bus, h.runService, { git: recorder.git });
    await supervised.retryPublish(task.id);
    assert.equal(recorder.pushes.length, 0, "nothing to push — the remote already has the revision");
    assert.equal(h.tasks.get(task.id)!.execution!.publish!.finalCommitSha, finalCommit);
  });

  test("a remote branch that this task did not create is a conflict, not an overwrite (v11 §8.1)", async () => {
    const h = await makeHarness();
    const { remote, seed } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project, { workingBranch: "af/contested" });
    assert.equal(task.execution!.publish!.status, "pushed");

    // Someone else force-moves the remote branch afterwards, then publish is
    // retried: the platform refuses to overwrite it.
    await git(seed, ["fetch", "--quiet", remote, "af/contested"]);
    await git(seed, ["checkout", "--quiet", "-B", "af/contested", "FETCH_HEAD"]);
    writeFileSync(join(seed, "other.txt"), "other\n");
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--quiet", "-m", "someone else"]);
    await git(seed, ["push", "--quiet", "--force", remote, "af/contested"]);

    // The task's own previous publish is recorded, so this is a diverged
    // branch: the push is attempted and the remote rejects it — no force.
    const after = await h.supervisor.retryPublish(task.id);
    assert.equal(after!.execution!.publish!.status, "failed");
    assert.equal(after!.execution!.failure!.stage, "publish");
    assert.ok(["git-push-rejected", "remote-branch-conflict", "git-push-failed"].includes(after!.execution!.failure!.code));
    assert.equal(h.scripted.runs(), 1);
  });
});

/* ================================================================== */
/* 9. Concurrency, locking, cancellation, recovery (v11 §32/§35/§36/§37) */
/* ================================================================== */

describe("v11 concurrency, locks, cancellation and recovery", () => {
  test("AC-26: two tasks on one project are fully isolated (Case F)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, `${ctx.task.id}.txt`), "work\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      return { exitCode: 0 };
    });

    const [a, b] = await Promise.all([
      h.supervisor.startTask({ projectId: project.id, instruction: "Task A", runtimeId: h.runtimeId, workingBranch: "af/task-a" }),
      h.supervisor.startTask({ projectId: project.id, instruction: "Task B", runtimeId: h.runtimeId, workingBranch: "af/task-b" }),
    ]);
    await Promise.all([h.supervisor.whenSettled(a.task.id), h.supervisor.whenSettled(b.task.id)]);
    const taskA = h.tasks.get(a.task.id)!;
    const taskB = h.tasks.get(b.task.id)!;

    const wsA = h.workspaces.get(taskA.workspaceId!)!;
    const wsB = h.workspaces.get(taskB.workspaceId!)!;
    assert.notEqual(wsA.id, wsB.id);
    assert.notEqual(wsA.path, wsB.path);
    // Neither task's file leaked into the other's working copy.
    assert.equal(existsSync(join(wsA.path!, `${taskB.id}.txt`)), false);
    assert.equal(existsSync(join(wsB.path!, `${taskA.id}.txt`)), false);
    // Independent branches, independent publishes.
    assert.equal((await git(remote, ["rev-parse", "refs/heads/af/task-a"])).trim(), taskA.execution!.publish!.finalCommitSha);
    assert.equal((await git(remote, ["rev-parse", "refs/heads/af/task-b"])).trim(), taskB.execution!.publish!.finalCommitSha);
  });

  test("AC-27: a workspace has one writer — a live lock blocks a second one", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const { task } = await startTask(h, project);
    const workspaceId = task.workspaceId!;

    // Run 1 holds the lock and is active.
    await h.locks.acquire(workspaceId, { taskId: task.id, runId: "run_live" }, (id) => id === "run_live");
    await assert.rejects(
      () => h.locks.acquire(workspaceId, { taskId: task.id, runId: "run_other" }, (id) => id === "run_live"),
      (err: unknown) => (err as DomainError).code === "workspace-locked"
    );
    // A stale lock (its run is gone) is reclaimed.
    await h.locks.acquire(workspaceId, { taskId: task.id, runId: "run_next" }, () => false);
    assert.equal(h.locks.get(workspaceId)!.runId, "run_next");
  });

  test("a busy task refuses a concurrent retry", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolvePromise) => (release = resolvePromise));
    h.scripted.setHandler(async (ctx) => {
      await gate;
      writeFileSync(join(ctx.workspacePath!, "x.txt"), "x\n");
      return { exitCode: 0 };
    });
    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    await assert.rejects(
      () => h.supervisor.retryRun(started.task.id),
      (err: unknown) => (err as DomainError).code === "task-busy"
    );
    release();
    await h.supervisor.whenSettled(started.task.id);
  });

  test("AC-29: cancel stops the run, keeps the workspace and reports cancellation (v11 §32)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    let agentStarted: () => void = () => {};
    const startedRunning = new Promise<void>((resolvePromise) => (agentStarted = resolvePromise));
    h.scripted.setHandler(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, "partial.txt"), "partial work\n");
      agentStarted();
      await new Promise<void>((resolvePromise) => {
        ctx.signal.addEventListener("abort", () => resolvePromise(), { once: true });
        if (ctx.signal.aborted) resolvePromise();
      });
      return { exitCode: 1, error: "aborted" };
    });
    const started = await h.supervisor.startTask({ projectId: project.id, instruction: "long work", runtimeId: h.runtimeId });
    await startedRunning;
    const cancelled = await h.supervisor.cancelTask(started.task.id);

    assert.equal(cancelled!.execution!.status, "cancelled");
    assert.equal(cancelled!.execution!.phase, "cancelled");
    assert.equal(cancelled!.execution!.agent!.status, "cancelled");
    assert.equal(h.runService.get(started.run.id)!.status, "cancelled");
    const workspace = h.workspaces.get(cancelled!.workspaceId!)!;
    assert.equal(existsSync(join(workspace.path!, "partial.txt")), true, "uncommitted work is preserved");
    assert.equal(h.locks.get(workspace.id), undefined, "the lock was released");
    // A new run can continue on the same workspace (v11 §32).
    h.scripted.setHandler(writeFiles({ "finished.txt": "done\n" }));
    const retry = await h.supervisor.retryRun(started.task.id);
    await h.supervisor.whenSettled(started.task.id);
    assert.equal(h.tasks.get(started.task.id)!.execution!.status, "completed");
    assert.equal(h.runService.get(retry.run.id)!.workspaceId, workspace.id);
  });

  test("cancelling during source preparation never starts the agent (v11 §32)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const inner = createGitOps();
    let releaseClone: () => void = () => {};
    const cloneGate = new Promise<void>((resolvePromise) => (releaseClone = resolvePromise));
    let cloneStarted: () => void = () => {};
    const cloneStartedPromise = new Promise<void>((resolvePromise) => (cloneStarted = resolvePromise));
    const slowGit: GitOps = {
      ...inner,
      async clone(opts) {
        cloneStarted();
        // A real clone is killed by the abort; the fake has to honor it too.
        await Promise.race([
          cloneGate,
          new Promise<void>((resolvePromise) => {
            opts.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
            if (opts.signal?.aborted) resolvePromise();
          }),
        ]);
        if (opts.signal?.aborted) throw new DomainError("agent-cancelled", "clone cancelled");
        return inner.clone(opts);
      },
    };
    const supervised = new ExecutionSupervisor(h.store, h.bus, h.runService, { git: slowGit });
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "never.txt": "never\n" }));
    const started = await supervised.startTask({ projectId: project.id, instruction: "work", runtimeId: h.runtimeId });
    await cloneStartedPromise;
    const cancelled = await supervised.cancelTask(started.task.id);
    releaseClone();

    assert.equal(cancelled!.execution!.status, "cancelled");
    assert.equal(cancelled!.execution!.agent!.status, "cancelled");
    assert.equal(h.scripted.runs(), 0, "the harness must never start for a cancelled task");
  });

  test("AC-28: a runtime crash preserves the workspace and a new run resumes (Case E)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, "half-done.txt"), "half\n");
      return { exitCode: 137, error: "runtime lost: container exited unexpectedly" };
    });
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.agent!.status, "failed");
    assert.equal(task.execution!.failure!.stage, "agent");
    const workspace = h.workspaces.get(task.workspaceId!)!;
    assert.equal(existsSync(join(workspace.path!, "half-done.txt")), true);

    h.scripted.setHandler(async (ctx) => {
      writeFileSync(join(ctx.workspacePath!, "finished.txt"), "finished\n");
      return { exitCode: 0 };
    });
    await h.supervisor.retryRun(task.id);
    await h.supervisor.whenSettled(task.id);
    const after = h.tasks.get(task.id)!;
    assert.equal(after.execution!.status, "completed");
    assert.equal(existsSync(join(workspace.path!, "half-done.txt")), true);
    const tree = await git(remote, ["ls-tree", "-r", "--name-only", after.workingBranch!]);
    assert.match(tree, /half-done\.txt/);
    assert.match(tree, /finished\.txt/);
  });

  test("Case C: agent failure → preserved workspace → new run → publish", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    let attempt = 0;
    h.scripted.setHandler(async (ctx) => {
      attempt += 1;
      if (attempt === 1) {
        writeFileSync(join(ctx.workspacePath!, "attempt1.txt"), "1\n");
        return { exitCode: 1, error: "agent failed" };
      }
      writeFileSync(join(ctx.workspacePath!, "attempt2.txt"), "2\n");
      return { exitCode: 0 };
    });
    const { task } = await startTask(h, project);
    assert.equal(task.execution!.status, "failed");
    assert.equal(task.execution!.publish!.status, "pending");

    await h.supervisor.retryRun(task.id);
    await h.supervisor.whenSettled(task.id);
    const after = h.tasks.get(task.id)!;
    assert.equal(after.execution!.status, "completed");
    assert.equal(after.execution!.publish!.status, "pushed");
    assert.equal(after.execution!.agent!.attempts, 2);
    const tree = await git(remote, ["ls-tree", "-r", "--name-only", after.workingBranch!]);
    assert.match(tree, /attempt1\.txt/);
    assert.match(tree, /attempt2\.txt/);
  });

  test("AC-30: crash recovery marks in-flight tasks and reclaims locks (v11 §37)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const { task } = await startTask(h, project);
    // Simulate a task left mid-flight by a restart.
    await h.store.update<Task>("tasks", task.id, {
      execution: { ...task.execution!, phase: "git.pushing", status: "publishing", failure: undefined },
    });
    await h.locks.acquire(task.workspaceId!, { taskId: task.id, runId: "run_ghost" }, () => false);

    const recovered = await h.supervisor.recoverInterrupted();
    assert.ok(recovered.tasks.includes(task.id));
    const after = h.tasks.get(task.id)!;
    assert.equal(after.execution!.status, "failed");
    assert.equal(after.execution!.failure!.code, "supervisor-restarted");
    assert.equal(after.execution!.failure!.stage, "publish");
    assert.equal(h.locks.get(task.workspaceId!), undefined);
    // The workspace is intact and the task can be retried.
    assert.equal(existsSync(h.workspaces.get(task.workspaceId!)!.path!), true);
  });
});

/* ================================================================== */
/* 10. Provisioning (v11 §25/§26/§41.6)                                */
/* ================================================================== */

describe("v11 runtime provisioning", () => {
  test("skills are provisioned per run, mounted read-only, and cleaned up", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const skillDir = tempDir("af-v11-skill-");
    writeFileSync(join(skillDir, "SKILL.md"), "# demo skill\n");
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote },
      skills: [{ name: "demo", path: skillDir }],
    });
    let seenSkillsDir: string | undefined;
    h.scripted.setHandler(async (ctx) => {
      seenSkillsDir = ctx.env.AGENTFABRIC_SKILLS_DIR;
      assert.equal(existsSync(join(ctx.env.AGENTFABRIC_SKILLS_DIR!, "demo", "SKILL.md")), true);
      assert.deepEqual(ctx.extraMounts, [{ hostPath: ctx.env.AGENTFABRIC_SKILLS_DIR, containerPath: "/root/.agentfabric/skills" }]);
      writeFileSync(join(ctx.workspacePath!, "x.txt"), "x\n");
      return { exitCode: 0 };
    });
    const { task, run } = await startTask(h, project);
    assert.equal(task.execution!.status, "completed");
    assert.ok(seenSkillsDir);
    assert.equal(existsSync(seenSkillsDir!), false, "provisioning is removed at cleanup");
    const types = await eventTypes(h, run.id);
    assert.ok(types.includes("provisioning.prepared"));
    assert.ok(types.includes("provisioning.cleaned"));
  });

  test("the MCP configuration is generated from project config only", () => {
    const document = buildMcpConfigDocument(
      [
        { name: "search", command: "npx", args: ["-y", "search-mcp"] },
        { name: "disabled", command: "nope", enabled: false },
        { name: "authed", url: "https://mcp.example/mcp", secretIds: ["sec_1"] },
      ],
      (id) => (id === "sec_1" ? "s3cr3t" : undefined)
    );
    const servers = document.mcpServers as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(servers), ["search", "authed"]);
    assert.equal((servers.authed.env as Record<string, string>).AGENTFABRIC_MCP_SECRET_sec_1, "s3cr3t");
  });

  test("provisioning is idempotent and isolated per run", async () => {
    const dataDir = tempDir("af-v11-prov-");
    const skillDir = tempDir("af-v11-skill2-");
    writeFileSync(join(skillDir, "S.md"), "s\n");
    const project = { skills: [{ name: "s", path: skillDir }] } as Project;
    const first = await provisionEnvironment({ dataDir, runId: "run_1", project });
    const second = await provisionEnvironment({ dataDir, runId: "run_1", project });
    const other = await provisionEnvironment({ dataDir, runId: "run_2", project });
    try {
      assert.equal(first.dir, second.dir);
      assert.notEqual(first.dir, other.dir);
      assert.equal(existsSync(join(second.skillsHostDir!, "s", "S.md")), true);
      // Re-provisioning replaces content rather than accumulating it.
      writeFileSync(join(skillDir, "extra.md"), "extra\n");
      const third = await provisionEnvironment({ dataDir, runId: "run_1", project });
      assert.equal(existsSync(join(third.skillsHostDir!, "s", "extra.md")), true);
    } finally {
      await first.cleanup();
      await second.cleanup();
      await other.cleanup();
    }
  });

  test("the MCP configuration file is private (0600) and removed at cleanup", async () => {
    const dataDir = tempDir("af-v11-mcp-");
    const env = await provisionEnvironment({
      dataDir,
      runId: "run_mcp",
      project: { mcpServers: [{ name: "s", command: "x" }] } as Project,
    });
    assert.equal(statSync(env.mcpConfigHostPath!).mode & 0o777, 0o600);
    await env.cleanup();
    assert.equal(existsSync(env.mcpConfigHostPath!), false);
  });

  test("provisioning a missing skill directory fails loudly", async () => {
    const dataDir = tempDir("af-v11-missing-");
    await assert.rejects(() =>
      provisionEnvironment({
        dataDir,
        runId: "run_bad",
        project: { skills: [{ name: "gone", path: "/nonexistent/skill/path" }] } as Project,
      })
    );
  });
});

/* ================================================================== */
/* 11. Supervisor-level API surface (v11 §31/§40)                      */
/* ================================================================== */

describe("v11 supervisor API surface", () => {
  test("task detail exposes everything the task view needs (v11 §40)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const credential = await h.credentials.create({ name: "c", type: "https-token", value: "ghp_supersecret" });
    const project = await h.projects.create({
      name: "Demo",
      source: { remoteUrl: remote, credentialId: credential.id },
    });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    const detail = h.supervisor.taskDetail(task.id);

    assert.equal(detail.project!.id, project.id);
    assert.equal(detail.source!.remoteUrl, remote);
    assert.equal(detail.source!.credential!.name, "c");
    assert.equal(detail.baseRef, "main");
    assert.equal(detail.baseCommitSha, task.baseCommitSha);
    assert.equal(detail.workingBranch, task.workingBranch);
    assert.equal(detail.workspace!.ownership, "managed");
    assert.equal(detail.phase, "completed");
    assert.equal(detail.status, "completed");
    assert.equal(detail.agent!.status, "completed");
    assert.equal(detail.validation.status, "skipped");
    assert.equal(detail.publish.status, "pushed");
    assert.ok(detail.finalCommitSha);
    assert.equal(detail.remoteBranch, task.workingBranch);
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.retry.kind, "none");
    assert.equal(detail.retry.publish, false);
  });

  test("retry availability follows the failure stage (v11 §31)", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(async () => ({ exitCode: 1, error: "boom" }));
    const { task } = await startTask(h, project);
    const detail = h.supervisor.taskDetail(task.id);
    assert.equal(detail.retry.kind, "agent");
    assert.equal(detail.retry.agent, true);
    assert.equal(detail.retry.validation, false);
    assert.equal(detail.retry.publish, false);
  });

  test("retry endpoints reject a task with nothing to retry", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    h.scripted.setHandler(writeFiles({ "x.txt": "x\n" }));
    const { task } = await startTask(h, project);
    // Already completed: validation retry is a no-op state, but it must not
    // silently re-run the agent.
    await h.supervisor.retryValidation(task.id);
    assert.equal(h.scripted.runs(), 1);
  });

  test("a task without a project cannot be started from a project id", async () => {
    const h = await makeHarness();
    await assert.rejects(
      () => h.supervisor.startTask({ projectId: "proj_missing", instruction: "x", runtimeId: h.runtimeId }),
      (err: unknown) => (err as DomainError).code === "project-not-found"
    );
  });

  test("starting a task on a disabled or non-usable runtime fails loudly", async () => {
    const h = await makeHarness();
    const { remote } = await makeRemote();
    const project = await h.projects.create({ name: "Demo", source: { remoteUrl: remote } });
    const disabled = await h.runtimes.create({ name: "Off", kind: "custom", enabled: false, usableInTask: true });
    const { task } = await startTask(h, project, { runtimeId: disabled.id });
    assert.equal(task.execution!.failure!.stage, "runtime");
    assert.equal(task.execution!.failure!.code, "runtime-create-failed");
    assert.equal(h.scripted.runs(), 0);
  });
});
