import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { EventBus } from "./eventbus.js";
import { RuntimeRegistry } from "./runtime.js";
import { KanbanService, boardProjectRoot, detectKanbanWorkspaceType } from "./kanban.js";
import { ProjectService, RuntimeService, TaskService, WorkspaceService } from "./services.js";
import { RunService } from "./orchestrator.js";
import { isDomainError } from "./errors.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "af-kanban-"));
}

interface Harness {
  dir: string;
  service: KanbanService;
  projects: ProjectService;
  runtimes: RuntimeService;
  tasks: TaskService;
  workspaces: WorkspaceService;
  runs: RunService;
  cleanup: () => void;
}

/**
 * The board writes through the real services (no fakes): a card start must
 * produce a real Task and Run, and only a real TaskService/RunService shows
 * whether it did.
 */
async function makeService(): Promise<Harness> {
  const dir = tempDir();
  const store = await Store.open(dir);
  const projects = new ProjectService(store);
  const runtimes = new RuntimeService(store);
  const tasks = new TaskService(store);
  const workspaces = new WorkspaceService(store);
  const runs = new RunService(store, new EventBus(), new RuntimeRegistry());
  const service = new KanbanService(store, { projects, runtimes, tasks, runs, workspaces });
  // Every board agent resolves to its harness by `Runtime.kind`.
  await runtimes.create({ name: "Claude Code", kind: "claude-code" });
  await runtimes.create({ name: "Pi", kind: "pi" });
  await runtimes.create({ name: "OpenCode", kind: "opencode" });
  await runtimes.create({ name: "DSH", kind: "dsh" });
  return {
    dir,
    service,
    projects,
    runtimes,
    tasks,
    workspaces,
    runs,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function boardProject(h: Harness, name = "plain"): Promise<{ projectId: string; projectDir: string }> {
  const projectDir = join(h.dir, name);
  mkdirSync(projectDir, { recursive: true });
  const project = await h.service.addProject({ rootPath: projectDir });
  return { projectId: project.id, projectDir };
}

test("a board project is a Project: directory source plus board settings", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const project = h.service.getProject(projectId);
    assert.equal(project.source.type, "directory");
    assert.equal(project.source.path, projectDir);
    assert.equal(project.board?.workspaceType, "none");
    // It is the same record the Projects API lists — there is no second store.
    assert.deepEqual(
      h.projects.list().map((p) => p.id),
      [projectId]
    );
    assert.equal(boardProjectRoot(project), projectDir);
  } finally {
    h.cleanup();
  }
});

test("workspace discovery distinguishes git, multi-git and google-repo", () => {
  const root = tempDir();
  try {
    const gitDir = join(root, "git");
    mkdirSync(join(gitDir, ".git"), { recursive: true });
    assert.equal(detectKanbanWorkspaceType(gitDir).workspaceType, "git");

    const multi = join(root, "multi");
    mkdirSync(join(multi, "a", ".git"), { recursive: true });
    mkdirSync(join(multi, "b", ".git"), { recursive: true });
    assert.equal(detectKanbanWorkspaceType(multi).workspaceType, "multi-git");

    const repo = join(root, "repo");
    mkdirSync(join(repo, ".repo", "manifests"), { recursive: true });
    writeFileSync(join(repo, ".repo", "manifests", "default.xml"), "<manifest/>");
    assert.equal(detectKanbanWorkspaceType(repo).workspaceType, "google-repo");

    // A directory that does not exist is still a total answer, never a throw.
    assert.equal(detectKanbanWorkspaceType(join(root, "missing")).workspaceType, "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project creation rejects a non-directory, a relative path and a second board over one folder", async () => {
  const h = await makeService();
  const file = join(h.dir, "file.txt");
  writeFileSync(file, "x");
  try {
    await assert.rejects(
      () => h.service.addProject({ rootPath: file }),
      (err) => isDomainError(err) && err.code === "kanban-project-path-invalid"
    );
    await assert.rejects(
      () => h.service.addProject({ rootPath: "relative/dir" }),
      (err) => isDomainError(err) && err.code === "kanban-project-path-invalid"
    );
    const { projectDir } = await boardProject(h, "once");
    await assert.rejects(
      () => h.service.addProject({ rootPath: projectDir }),
      (err) => isDomainError(err) && err.code === "kanban-project-duplicate"
    );
  } finally {
    h.cleanup();
  }
});

test("a card records its workspace; worktree mode needs a Git project root", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "Fix the build", agentId: "claude" });
    assert.equal(card.column, "backlog");
    assert.equal(card.executionMode, "direct");
    assert.equal(card.title, "Fix the build");
    // The card's folder is the Project's external workspace, created on demand.
    const workspace = h.workspaces.get(card.workspaceId!)!;
    assert.equal(workspace.ownership, "external");
    assert.equal(workspace.path, projectDir);
    assert.equal(workspace.projectId, projectId);

    await assert.rejects(
      () => h.service.createCard(projectId, { prompt: "x", agentId: "claude", executionMode: "worktree" }),
      (err) => isDomainError(err) && err.code === "kanban-worktree-unavailable"
    );

    const gitDir = join(h.dir, "git-project");
    mkdirSync(join(gitDir, ".git"), { recursive: true });
    const gitProject = await h.service.addProject({ rootPath: gitDir });
    assert.equal(gitProject.board?.workspaceType, "git");
    const worktreeCard = await h.service.createCard(gitProject.id, {
      prompt: "x",
      agentId: "claude",
      executionMode: "worktree",
    });
    assert.equal(worktreeCard.executionMode, "worktree");

    await assert.rejects(
      () => h.service.createCard(gitProject.id, { prompt: "x", agentId: "nope" as never }),
      (err) => isDomainError(err) && err.code === "kanban-agent-unknown"
    );
  } finally {
    h.cleanup();
  }
});

test("starting a card creates its Task and a Run; the session handle is that Run", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "Fix the build", agentId: "claude" });
    assert.equal(card.taskId, undefined);

    const started = await h.service.startAttempt(card.id, {
      cwd: projectDir,
      interactiveTui: true,
      transport: "pty",
    });
    assert.equal(started.taskCreated, true);
    assert.equal(started.resumed, false);

    const task = started.task;
    assert.equal(task.projectId, projectId);
    assert.equal(task.workspaceId, card.workspaceId);
    assert.equal(task.title, "Fix the build");
    assert.equal(task.prompt, "Fix the build");
    assert.equal(task.runtimeId, h.runtimes.list().find((r) => r.kind === "claude-code")?.id);
    assert.deepEqual((task.metadata as { board: unknown }).board, { cardId: card.id });
    assert.equal(typeof (task.metadata as { lastActivityAt: unknown }).lastActivityAt, "string");

    // The Task is written with a complete execution: running, agent stage.
    assert.equal(task.execution?.phase, "agent.running");
    assert.equal(task.execution?.status, "running");
    assert.equal(task.execution?.agent?.status, "pending");
    assert.deepEqual(task.execution?.validation, { status: "pending", attempts: 0 });
    assert.deepEqual(task.execution?.publish, { status: "pending", attempts: 0 });

    const run = started.run;
    assert.equal(run.taskId, task.id);
    assert.equal(run.taskTitle, task.title);
    assert.equal(run.status, "running");
    assert.equal(run.purpose, "development");
    assert.equal(run.runtimeName, "claude");
    assert.equal(started.session.id, run.id);
    assert.equal(started.session.runId, run.id);

    const pointed = h.service.getCard(card.id);
    assert.equal(pointed.taskId, task.id);
    assert.equal(pointed.runId, run.id);
    assert.equal(pointed.column, "in_progress");
    assert.equal(h.service.latestSessionForCard(card.id)?.id, run.id);

    // It shows up in the ordinary task lists and has its run.
    assert.deepEqual(
      h.tasks.list({ deleted: false }).map((t) => t.id),
      [task.id]
    );
    assert.equal(h.runs.forTask(task.id).length, 1);
    assert.ok((await h.runs.events(run.id)).some((event) => event.type === "run.started"));
  } finally {
    h.cleanup();
  }
});

test("rerunning a card adds a Run, never a second Task", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "rerun me", agentId: "pi" });
    const first = await h.service.startAttempt(card.id, { cwd: projectDir, interactiveTui: true, transport: "pty" });
    await h.service.settleSession(first.session.id, { status: "stopped" });

    const second = await h.service.startAttempt(card.id, { cwd: projectDir, interactiveTui: true, transport: "pty" });
    assert.equal(second.taskCreated, false);
    assert.equal(second.task.id, first.task.id);
    assert.notEqual(second.run.id, first.run.id);
    assert.equal(h.tasks.list().length, 1);
    assert.equal(h.runs.forTask(first.task.id).length, 2);
    assert.equal(h.service.getCard(card.id).runId, second.run.id);
    assert.equal(second.session.id, second.run.id);
  } finally {
    h.cleanup();
  }
});

test("a resumed conversation reopens its attempt instead of recording a new Run", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "resume me", agentId: "dsh" });
    const first = await h.service.startAttempt(card.id, { cwd: projectDir, interactiveTui: false, transport: "acp" });
    await h.service.settleSession(first.session.id, { status: "stopped" });

    const resumed = await h.service.startAttempt(card.id, {
      cwd: projectDir,
      interactiveTui: false,
      transport: "acp",
      resume: true,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.run.id, first.run.id);
    assert.equal(resumed.session.id, first.session.id);
    assert.equal(resumed.session.status, "starting");
    assert.equal(h.runs.forTask(first.task.id).length, 1);
    assert.equal(h.service.getCard(card.id).column, "in_progress");
  } finally {
    h.cleanup();
  }
});

test("session statuses are projected onto the Run and the task's execution at write time", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "project me", agentId: "claude" });
    const started = await h.service.startAttempt(card.id, { cwd: projectDir, interactiveTui: true, transport: "pty" });
    const taskId = started.task.id;

    const running = await h.service.updateSession(started.session.id, { status: "running" });
    assert.equal(h.runs.get(running.runId)?.status, "running");
    assert.equal(h.tasks.get(taskId)?.execution?.agent?.status, "running");
    assert.equal(h.tasks.get(taskId)?.execution?.status, "running");

    // The agent finished its turn: the run is over, the task waits for the user.
    const settled = await h.service.settleSession(started.session.id, { status: "awaiting_review", exitCode: 0 });
    assert.equal(h.runs.get(settled.runId)?.status, "completed");
    assert.equal(h.tasks.get(taskId)?.execution?.phase, "agent.running");
    assert.equal(h.tasks.get(taskId)?.execution?.status, "running");
    assert.equal(h.tasks.get(taskId)?.execution?.agent?.status, "completed");
    assert.equal(h.tasks.get(taskId)?.execution?.stages?.agent?.status, "completed");
    assert.equal(h.service.getCard(card.id).column, "review");
    // lastActivityAt is refreshed by every write.
    const afterReview = (h.tasks.get(taskId)?.metadata as { lastActivityAt: string }).lastActivityAt;

    const fatalSession = await h.service.startAttempt(card.id, {
      cwd: projectDir,
      interactiveTui: true,
      transport: "pty",
    });
    const failed = await h.service.settleSession(fatalSession.session.id, { status: "failed", error: "agent exploded" });
    assert.equal(h.runs.get(failed.runId)?.status, "failed");
    const execution = h.tasks.get(taskId)?.execution;
    assert.equal(execution?.phase, "failed");
    assert.equal(execution?.status, "failed");
    assert.equal(execution?.failure?.stage, "agent");
    assert.equal(execution?.failure?.code, "kanban-agent-failed");
    assert.equal(execution?.failure?.message, "agent exploded");
    assert.equal(execution?.agent?.status, "failed");
    assert.equal(execution?.stages?.agent?.status, "failed");
    // The untouched parts keep their shape: the board never fakes a pass.
    assert.deepEqual(execution?.validation, { status: "pending", attempts: 0 });
    assert.deepEqual(execution?.publish, { status: "pending", attempts: 0 });
    assert.ok((h.tasks.get(taskId)?.metadata as { lastActivityAt: string }).lastActivityAt >= afterReview);

    const stoppedSession = await h.service.startAttempt(card.id, {
      cwd: projectDir,
      interactiveTui: true,
      transport: "pty",
    });
    const stopped = await h.service.settleSession(stoppedSession.session.id, { status: "stopped" });
    assert.equal(h.runs.get(stopped.runId)?.status, "cancelled");
  } finally {
    h.cleanup();
  }
});

test("restart recovery fails the task with kanban-session-interrupted instead of pretending it runs", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "interrupt me", agentId: "claude" });
    const started = await h.service.startAttempt(card.id, { cwd: projectDir, interactiveTui: true, transport: "pty" });
    await h.service.updateSession(started.session.id, { status: "running" });

    assert.deepEqual(await h.service.recoverInterrupted(), [started.session.id]);
    assert.equal(h.service.getSession(started.session.id).status, "interrupted");
    assert.equal(h.runs.get(started.run.id)?.status, "cancelled");
    const execution = h.tasks.get(started.task.id)?.execution;
    assert.equal(execution?.phase, "failed");
    assert.equal(execution?.status, "failed");
    assert.equal(execution?.failure?.code, "kanban-session-interrupted");
    assert.equal(h.service.getCard(card.id).column, "in_progress");
  } finally {
    h.cleanup();
  }
});

test("deleting a card soft-deletes its task and drops its sessions; the task stays recoverable", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "delete me", agentId: "claude" });
    const started = await h.service.startAttempt(card.id, { cwd: projectDir, interactiveTui: true, transport: "pty" });

    await h.service.deleteCard(card.id);
    assert.equal(h.service.listSessions(card.id).length, 0);
    assert.throws(
      () => h.service.getCard(card.id),
      (err) => isDomainError(err) && err.code === "kanban-card-not-found"
    );
    // Soft, not physical: it is in the trash, not gone.
    assert.ok(h.tasks.get(started.task.id)?.deletedAt);
    assert.equal(h.tasks.list({ deleted: false }).length, 0);
    assert.equal(h.tasks.list({ deleted: true }).length, 1);
  } finally {
    h.cleanup();
  }
});

test("a start fails loudly for a plain Project, an unresolved folder, a missing runtime and missing deps", async () => {
  const h = await makeService();
  try {
    // A Project without board settings is not a board project.
    const plainDir = join(h.dir, "plain-project");
    mkdirSync(plainDir);
    const otherDir = join(h.dir, "other-store");
    const store = await Store.open(otherDir);
    const projects = new ProjectService(store);
    const kanban = new KanbanService(store, {
      projects,
      runtimes: h.runtimes,
      tasks: new TaskService(store),
      runs: new RunService(store, new EventBus(), new RuntimeRegistry()),
      workspaces: new WorkspaceService(store),
    });
    const imported = await projects.create({ name: "Imported", source: { type: "directory", path: plainDir } });
    const importedCard = await store.insert("kanbanCards", {
      id: "kbcard_imported",
      projectId: imported.id,
      title: "t",
      prompt: "p",
      column: "backlog" as const,
      agentId: "claude" as const,
      executionMode: "direct" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(
      () => kanban.startAttempt(importedCard.id, { cwd: plainDir, interactiveTui: true, transport: "pty" }),
      (err) => isDomainError(err) && err.code === "kanban-project-path-invalid"
    );

    // A git-sourced board folder exists only as an external workspace.
    const gitProject = await projects.create({
      name: "Git",
      source: { type: "git", remoteUrl: "https://github.com/acme/demo.git" },
      board: { workspaceType: "git" },
    });
    assert.throws(
      () => boardProjectRoot(gitProject),
      (err) => isDomainError(err) && err.code === "kanban-project-path-invalid"
    );

    // No runtime for the card's agent: refuse, do not pick another harness.
    const emptyDir = join(h.dir, "empty-store");
    const emptyStore = await Store.open(emptyDir);
    const emptyRuntimes = new RuntimeService(emptyStore);
    const emptyProjects = new ProjectService(emptyStore);
    const noRuntime = new KanbanService(emptyStore, {
      projects: emptyProjects,
      runtimes: emptyRuntimes,
      tasks: new TaskService(emptyStore),
      runs: new RunService(emptyStore, new EventBus(), new RuntimeRegistry()),
      workspaces: new WorkspaceService(emptyStore),
    });
    const noRuntimeDir = join(h.dir, "no-runtime");
    mkdirSync(noRuntimeDir);
    const noRuntimeProject = await noRuntime.addProject({ rootPath: noRuntimeDir });
    const noRuntimeCard = await noRuntime.createCard(noRuntimeProject.id, { prompt: "x", agentId: "opencode" });
    await assert.rejects(
      () => noRuntime.startAttempt(noRuntimeCard.id, { cwd: noRuntimeDir, interactiveTui: true, transport: "pty" }),
      (err) => isDomainError(err) && err.code === "kanban-runtime-missing"
    );

    // A board service built without the task services cannot start anything.
    const bare = new KanbanService(emptyStore, { projects: emptyProjects, runtimes: emptyRuntimes });
    await assert.rejects(
      () => bare.startAttempt(noRuntimeCard.id, { cwd: noRuntimeDir, interactiveTui: true, transport: "pty" }),
      (err) => isDomainError(err) && err.code === "config-invalid"
    );
  } finally {
    h.cleanup();
  }
});

test("user moves follow the v13 whitelist; session-driven columns are not user-movable", async () => {
  const h = await makeService();
  try {
    const { projectId } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "p", agentId: "pi" });

    await assert.rejects(
      () => h.service.moveCard(card.id, "in_progress"),
      (err) => isDomainError(err) && err.code === "kanban-session-not-startable",
      "starting is an operation, not a move"
    );
    assert.equal((await h.service.moveCard(card.id, "trash")).column, "trash");
    assert.equal((await h.service.moveCard(card.id, "review")).column, "review");
    await assert.rejects(
      () => h.service.moveCard(card.id, "in_progress"),
      (err) => isDomainError(err) && err.code === "kanban-session-not-startable"
    );
  } finally {
    h.cleanup();
  }
});

test("without hooks, an explicit in_progress → review move is the manual way to review", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const card = await h.service.createCard(projectId, { prompt: "p", agentId: "claude" });
    await h.service.startAttempt(card.id, { cwd: projectDir, interactiveTui: true, transport: "pty" });
    assert.equal(h.service.getCard(card.id).column, "in_progress");

    // Mark for review (v13 §六): allowed as an explicit action before hooks land.
    assert.equal((await h.service.moveCard(card.id, "review")).column, "review");
    // The reverse direction is still session-driven, not a user move.
    await assert.rejects(
      () => h.service.moveCard(card.id, "in_progress"),
      (err) => isDomainError(err) && err.code === "kanban-session-not-startable"
    );
  } finally {
    h.cleanup();
  }
});

test("multiple direct cards can run in one project (no platform-wide writer lock)", async () => {
  const h = await makeService();
  try {
    const { projectId, projectDir } = await boardProject(h);
    const a = await h.service.createCard(projectId, { prompt: "a", agentId: "claude" });
    const b = await h.service.createCard(projectId, { prompt: "b", agentId: "claude" });
    const startedA = await h.service.startAttempt(a.id, { cwd: projectDir, interactiveTui: true, transport: "pty" });
    const startedB = await h.service.startAttempt(b.id, { cwd: projectDir, interactiveTui: true, transport: "pty" });
    assert.equal(h.service.getCard(a.id).column, "in_progress");
    assert.equal(h.service.getCard(b.id).column, "in_progress");
    assert.notEqual(startedA.session.id, startedB.session.id);
    // Each card owns its own Task in the same Project.
    assert.notEqual(startedA.task.id, startedB.task.id);
    assert.equal(startedA.task.projectId, startedB.task.projectId);
  } finally {
    h.cleanup();
  }
});

test("card titles are derived from the prompt like the fork's task titles", async () => {
  const h = await makeService();
  try {
    const { projectId } = await boardProject(h, "titles");
    const derived = await h.service.createCard(projectId, {
      prompt: "\n\n  Fix the flaky login test. Then run the suite.  \nmore detail",
      agentId: "claude",
    });
    assert.equal(derived.title, "Fix the flaky login test.");
    // An explicit title always wins, and a long prompt still gets a title.
    const explicit = await h.service.createCard(projectId, {
      title: "Hand written",
      prompt: "whatever",
      agentId: "claude",
    });
    assert.equal(explicit.title, "Hand written");
    const long = await h.service.createCard(projectId, { prompt: "x".repeat(200), agentId: "claude" });
    assert.equal(long.title.length, 81); // 80 chars + the ellipsis
    assert.ok(long.title.endsWith("…"));
    // An empty prompt has no title to derive; creation is still refused.
    await assert.rejects(
      () => h.service.createCard(projectId, { prompt: "   ", agentId: "claude" }),
      (err) => isDomainError(err)
    );
  } finally {
    h.cleanup();
  }
});

test("a worktree card stores its base ref and keeps it across updates", async () => {
  const h = await makeService();
  try {
    const projectDir = join(h.dir, "base-ref");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    const project = await h.service.addProject({ rootPath: projectDir });
    const card = await h.service.createCard(project.id, {
      prompt: "branch off",
      agentId: "claude",
      executionMode: "worktree",
      baseRef: "feature/login",
    });
    assert.equal(card.baseRef, "feature/login");
    assert.equal(card.executionMode, "worktree");
    const updated = await h.service.updateCard(card.id, { baseRef: "main" });
    assert.equal(updated.baseRef, "main");
    const cleared = await h.service.updateCard(card.id, { baseRef: "" });
    assert.equal(cleared.baseRef, undefined);
  } finally {
    h.cleanup();
  }
});

test("board settings merge partially on Project update and refuse a first partial write", async () => {
  const h = await makeService();
  try {
    const { projectId } = await boardProject(h);
    const merged = await h.projects.update(projectId, { board: { defaultAgentId: "dsh" } });
    assert.equal(merged?.board?.workspaceType, "none");
    assert.equal(merged?.board?.defaultAgentId, "dsh");
    const alsoMode = await h.projects.update(projectId, {
      board: { defaultExecutionMode: "direct", defaultAgentId: "pi" },
    });
    assert.equal(alsoMode?.board?.defaultAgentId, "pi");
    assert.equal(alsoMode?.board?.defaultExecutionMode, "direct");

    const plainDir = join(h.dir, "not-a-board");
    mkdirSync(plainDir);
    const plain = await h.projects.create({ name: "Plain", source: { type: "directory", path: plainDir } });
    await assert.rejects(
      () => h.projects.update(plain.id, { board: { defaultAgentId: "pi" } }),
      (err) => isDomainError(err) && err.code === "project-invalid"
    );
  } finally {
    h.cleanup();
  }
});
