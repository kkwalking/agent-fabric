import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { KanbanService, detectKanbanWorkspaceType } from "./kanban.js";
import { isDomainError } from "./errors.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "af-kanban-"));
}

async function makeService(): Promise<{ dir: string; service: KanbanService; cleanup: () => void }> {
  const dir = tempDir();
  const store = await Store.open(dir);
  return { dir, service: new KanbanService(store), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("folder-first projects accept non-Git directories and classify them", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "plain");
  mkdirSync(projectDir);
  try {
    const project = await service.createProject({ name: "Plain", rootPath: projectDir });
    assert.equal(project.workspaceType, "none");
    assert.equal(project.rootPath, projectDir);
    assert.equal(service.getProject(project.id).name, "Plain");
  } finally {
    cleanup();
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

test("project creation rejects a non-directory and a relative path", async () => {
  const { dir, service, cleanup } = await makeService();
  const file = join(dir, "file.txt");
  writeFileSync(file, "x");
  try {
    await assert.rejects(() => service.createProject({ rootPath: file }), (err) => isDomainError(err) && err.code === "kanban-project-path-invalid");
    await assert.rejects(() => service.createProject({ rootPath: "relative/dir" }), (err) => isDomainError(err) && err.code === "kanban-project-path-invalid");
  } finally {
    cleanup();
  }
});

test("cards start in backlog; worktree mode is available only for a Git project root", async () => {
  const { dir, service, cleanup } = await makeService();
  const plainDir = join(dir, "plain");
  const gitDir = join(dir, "git-project");
  mkdirSync(plainDir);
  mkdirSync(join(gitDir, ".git"), { recursive: true });
  try {
    const plain = await service.createProject({ rootPath: plainDir });
    const card = await service.createCard(plain.id, { prompt: "Fix the build", agentId: "claude" });
    assert.equal(card.column, "backlog");
    assert.equal(card.executionMode, "direct");
    assert.equal(card.title, "Fix the build");

    await assert.rejects(
      () => service.createCard(plain.id, { prompt: "x", agentId: "claude", executionMode: "worktree" }),
      (err) => isDomainError(err) && err.code === "kanban-worktree-unavailable"
    );

    const gitProject = await service.createProject({ rootPath: gitDir });
    assert.equal(gitProject.workspaceType, "git");
    const worktreeCard = await service.createCard(gitProject.id, {
      prompt: "x",
      agentId: "claude",
      executionMode: "worktree",
    });
    assert.equal(worktreeCard.executionMode, "worktree");

    await assert.rejects(
      () => service.createCard(gitProject.id, { prompt: "x", agentId: "nope" as never }),
      (err) => isDomainError(err) && err.code === "kanban-agent-unknown"
    );
  } finally {
    cleanup();
  }
});

test("user moves follow the v13 whitelist; session-driven columns are not user-movable", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "plain");
  mkdirSync(projectDir);
  try {
    const project = await service.createProject({ rootPath: projectDir });
    const card = await service.createCard(project.id, { prompt: "p", agentId: "pi" });

    await assert.rejects(
      () => service.moveCard(card.id, "in_progress"),
      (err) => isDomainError(err) && err.code === "kanban-session-not-startable",
      "starting is an operation, not a move"
    );
    assert.equal((await service.moveCard(card.id, "trash")).column, "trash");
    assert.equal((await service.moveCard(card.id, "review")).column, "review");
    await assert.rejects(
      () => service.moveCard(card.id, "in_progress"),
      (err) => isDomainError(err) && err.code === "kanban-session-not-startable"
    );
  } finally {
    cleanup();
  }
});

test("a session moves its card to in_progress; a clean finish moves it to review", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "plain");
  mkdirSync(projectDir);
  try {
    const project = await service.createProject({ rootPath: projectDir });
    const card = await service.createCard(project.id, { prompt: "p", agentId: "claude" });
    const session = await service.createSession(card, { cwd: projectDir, interactiveTui: true });
    assert.equal(service.getCard(card.id).column, "in_progress");
    assert.equal(service.getCard(card.id).sessionId, session.id);

    const settled = await service.settleSession(session.id, { status: "awaiting_review", exitCode: 0 });
    assert.equal(settled.status, "awaiting_review");
    assert.equal(service.getCard(card.id).column, "review");
  } finally {
    cleanup();
  }
});

test("restart recovery marks live sessions interrupted instead of pretending they run", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "plain");
  mkdirSync(projectDir);
  try {
    const project = await service.createProject({ rootPath: projectDir });
    const card = await service.createCard(project.id, { prompt: "p", agentId: "claude" });
    const session = await service.createSession(card, { cwd: projectDir, interactiveTui: true });

    const interrupted = await service.recoverInterrupted();
    assert.deepEqual(interrupted, [session.id]);
    assert.equal(service.getSession(session.id).status, "interrupted");
    assert.equal(service.getCard(card.id).column, "in_progress");
  } finally {
    cleanup();
  }
});

test("deleting a project removes its cards and sessions", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "plain");
  mkdirSync(projectDir);
  try {
    const project = await service.createProject({ rootPath: projectDir });
    const card = await service.createCard(project.id, { prompt: "p", agentId: "claude" });
    const session = await service.createSession(card, { cwd: projectDir, interactiveTui: true });
    await service.deleteProject(project.id);
    assert.equal(service.listProjects().length, 0);
    assert.equal(service.listCards(project.id).length, 0);
    assert.equal(service.listSessions(card.id).length, 0);
    assert.throws(() => service.getSession(session.id));
  } finally {
    cleanup();
  }
});

test("without hooks, an explicit in_progress → review move is the manual way to review", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "plain");
  mkdirSync(projectDir);
  try {
    const project = await service.createProject({ rootPath: projectDir });
    const card = await service.createCard(project.id, { prompt: "p", agentId: "claude" });
    await service.createSession(card, { cwd: projectDir, interactiveTui: true });
    assert.equal(service.getCard(card.id).column, "in_progress");

    // Mark for review (v13 §六): allowed as an explicit action before hooks land.
    assert.equal((await service.moveCard(card.id, "review")).column, "review");
    // The reverse direction is still session-driven, not a user move.
    await assert.rejects(
      () => service.moveCard(card.id, "in_progress"),
      (err) => isDomainError(err) && err.code === "kanban-session-not-startable"
    );
  } finally {
    cleanup();
  }
});

test("multiple direct sessions can run in one project (no platform-wide writer lock)", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "plain");
  mkdirSync(projectDir);
  try {
    const project = await service.createProject({ rootPath: projectDir });
    const a = await service.createCard(project.id, { prompt: "a", agentId: "claude" });
    const b = await service.createCard(project.id, { prompt: "b", agentId: "claude" });
    const sessionA = await service.createSession(a, { cwd: projectDir, interactiveTui: true });
    const sessionB = await service.createSession(b, { cwd: projectDir, interactiveTui: true });
    assert.equal(service.getCard(a.id).column, "in_progress");
    assert.equal(service.getCard(b.id).column, "in_progress");
    assert.notEqual(sessionA.id, sessionB.id);
  } finally {
    cleanup();
  }
});

test("card titles are derived from the prompt like the fork's task titles", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "titles");
  mkdirSync(projectDir);
  try {
    const project = await service.createProject({ rootPath: projectDir });
    const derived = await service.createCard(project.id, {
      prompt: "\n\n  Fix the flaky login test. Then run the suite.  \nmore detail",
      agentId: "claude",
    });
    assert.equal(derived.title, "Fix the flaky login test.");
    // An explicit title always wins, and a long prompt still gets a title.
    const explicit = await service.createCard(project.id, {
      title: "Hand written",
      prompt: "whatever",
      agentId: "claude",
    });
    assert.equal(explicit.title, "Hand written");
    const long = await service.createCard(project.id, {
      prompt: "x".repeat(200),
      agentId: "claude",
    });
    assert.equal(long.title.length, 81); // 80 chars + the ellipsis
    assert.ok(long.title.endsWith("…"));
    // An empty prompt has no title to derive; creation is still refused.
    await assert.rejects(
      () => service.createCard(project.id, { prompt: "   ", agentId: "claude" }),
      (err) => isDomainError(err)
    );
  } finally {
    cleanup();
  }
});

test("the same folder cannot be added twice as a board project", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "once");
  mkdirSync(projectDir);
  try {
    await service.createProject({ rootPath: projectDir });
    await assert.rejects(
      () => service.createProject({ rootPath: projectDir }),
      (err) => isDomainError(err) && err.code === "kanban-project-duplicate"
    );
  } finally {
    cleanup();
  }
});

test("a worktree card stores its base ref and keeps it across updates", async () => {
  const { dir, service, cleanup } = await makeService();
  const projectDir = join(dir, "base-ref");
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  try {
    const project = await service.createProject({ rootPath: projectDir });
    const card = await service.createCard(project.id, {
      prompt: "branch off",
      agentId: "claude",
      executionMode: "worktree",
      baseRef: "feature/login",
    });
    assert.equal(card.baseRef, "feature/login");
    assert.equal(card.executionMode, "worktree");
    const updated = await service.updateCard(card.id, { baseRef: "main" });
    assert.equal(updated.baseRef, "main");
    const cleared = await service.updateCard(card.id, { baseRef: "" });
    assert.equal(cleared.baseRef, undefined);
  } finally {
    cleanup();
  }
});
