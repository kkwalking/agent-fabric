import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createServer } from "./app.js";

interface Harness {
  dir: string;
  baseUrl: string;
  token: string;
  server: Server;
  shutdown: () => void;
  cleanup: () => Promise<void>;
}

/**
 * A fake Claude CLI: prints a marker, then stays alive like an interactive
 * TUI. The board only needs the PTY contract, not the real agent.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function makeHarness(
  claudeScript = "#!/bin/sh\nprintf 'FAKE_CLAUDE_TUI\\n'\nsleep 30\n"
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "af-kanban-http-"));
  const bin = join(dir, "bin");
  const project = join(dir, "project");
  mkdirSync(bin);
  mkdirSync(project);
  const fakeClaude = join(bin, "claude");
  writeFileSync(fakeClaude, claudeScript);
  chmodSync(fakeClaude, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const port = await getFreePort();
    const { app, shutdown, upgrade } = await createServer({
      dataDir: dir,
      hookBaseUrl: `http://127.0.0.1:${port}/kanban-hooks/ingest`,
    });
    const server = createHttpServer(app);
    server.on("upgrade", upgrade);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const token = readFileSync(join(dir, "token"), "utf8").trim();
    return {
      dir,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token,
      server,
      shutdown,
      cleanup: async () => {
        shutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        process.env.PATH = previousPath;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    process.env.PATH = previousPath;
    throw err;
  }
}

async function api<T>(h: Harness, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${h.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${res.status} ${data?.code ?? ""} ${data?.error ?? text}`);
  return data as T;
}

test("board HTTP + terminal websocket end to end with a fake CLI", async () => {
  const h = await makeHarness();
  try {
    const { project } = await api<{ project: { id: string; workspaceType: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    assert.equal(project.workspaceType, "none");

    const { card } = await api<{ card: { id: string; column: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "do the thing",
      agentId: "claude",
    });
    assert.equal(card.column, "backlog");

    // Starting is an operation, not a column move.
    await assert.rejects(() => api(h, "POST", `/api/kanban/cards/${card.id}/move`, { column: "in_progress" }), /409/);

    const { session } = await api<{ session: { id: string; status: string; interactiveTui: boolean } }>(
      h,
      "POST",
      `/api/kanban/cards/${card.id}/start`,
      {}
    );
    assert.equal(session.status, "running");
    assert.equal(session.interactiveTui, true);

    // Unauthenticated websocket upgrades are refused.
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/${session.id}/terminal`);
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        resolve();
      });
      ws.on("error", () => resolve());
      ws.on("open", () => {
        ws.close();
        assert.fail("unauthenticated websocket must not open");
      });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/${session.id}/terminal`, {
      headers: { Cookie: `af_token=${h.token}` },
    });
    const frames: Array<{ kind: "text" | "binary"; value: string }> = [];
    const restore = await new Promise<{ type: string; data: string; cols: number; rows: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no restore frame; got ${JSON.stringify(frames)}`)), 5_000);
      ws.on("message", (data, isBinary) => {
        const text = Buffer.from(data as Buffer).toString(isBinary ? "utf8" : "utf8");
        frames.push({ kind: isBinary ? "binary" : "text", value: text });
        if (!isBinary) {
          const parsed = JSON.parse(text) as { type?: string };
          if (parsed.type === "restore") {
            clearTimeout(timer);
            resolve(parsed as never);
          }
        }
      });
      ws.on("error", reject);
    });
    assert.ok(restore.cols > 0);
    assert.ok(restore.rows > 0);

    // Replay or a live chunk must carry the fake agent's marker.
    const restoredText =
      Buffer.from(restore.data, "base64").toString("utf8") +
      frames.filter((frame) => frame.kind === "binary").map((frame) => frame.value).join("");
    if (!restoredText.includes("FAKE_CLAUDE_TUI")) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`did not see FAKE_CLAUDE_TUI: ${JSON.stringify(frames)}`)), 5_000);
        ws.on("message", (data, isBinary) => {
          if (isBinary && Buffer.from(data as Buffer).toString("utf8").includes("FAKE_CLAUDE_TUI")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }

    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    const { session: stopped } = await api<{ session: { status: string } }>(h, "POST", `/api/kanban/cards/${card.id}/stop`, {});
    assert.equal(stopped.status, "stopped");
    const latest = await api<{ session: { status: string } }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
    assert.equal(latest.session.status, "stopped");
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("a signalled agent exit is a failure, not a clean Review", async () => {
  // The agent kills itself with SIGTERM. node-pty reports this as
  // exitCode 0 + signal 15 on Unix; treating it as a clean finish would move
  // the card to Review and lie about why the agent stopped.
  const h = await makeHarness("#!/bin/sh\nprintf 'SIGNAL_AGENT\\n'\nkill -TERM $$\n");
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string; column: string } }>(
      h,
      "POST",
      `/api/kanban/projects/${project.id}/cards`,
      { prompt: "kill yourself", agentId: "claude" }
    );
    await api(h, "POST", `/api/kanban/cards/${card.id}/start`, {});

    let status = "running";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { session } = await api<{ session: { status: string } }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
      status = session.status;
      if (["failed", "awaiting_review", "stopped", "interrupted"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status, "failed");

    const { cards } = await api<{ cards: Array<{ id: string; column: string }> }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/cards`
    );
    assert.equal(cards.find((c) => c.id === card.id)?.column, "in_progress");
  } finally {
    await h.cleanup();
  }
});

function initGitRepo(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "e2e@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "E2E"]);
  writeFileSync(join(dir, "README.md"), "worktree fixture\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
}

async function pollSession(
  h: Harness,
  cardId: string,
  predicate: (session: { status: string }) => boolean,
  timeoutMs = 5_000
): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string } = { status: "unknown" };
  while (Date.now() < deadline) {
    const result = await api<{ session: { status: string } }>(h, "GET", `/api/kanban/cards/${cardId}/session`);
    last = result.session;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`session did not reach the expected state; last=${JSON.stringify(last)}`);
}

test("worktree mode runs in a git worktree and leaves the project tree untouched", async () => {
  const h = await makeHarness();
  try {
    const projectDir = join(h.dir, "project");
    initGitRepo(projectDir);
    const { project } = await api<{ project: { id: string; workspaceType: string } }>(h, "POST", "/api/kanban/projects", {
      path: projectDir,
    });
    assert.equal(project.workspaceType, "git");

    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "work in a worktree",
      agentId: "claude",
      executionMode: "worktree",
    });
    const { session } = await api<{ session: { id: string; cwd: string; status: string } }>(
      h,
      "POST",
      `/api/kanban/cards/${card.id}/start`,
      {}
    );
    assert.equal(session.status, "running");
    assert.ok(
      session.cwd.startsWith(join(h.dir, "kanban", "worktrees")),
      `session cwd should be a worktree path, got ${session.cwd}`
    );
    const inside = execFileSync("git", ["-C", session.cwd, "rev-parse", "--is-inside-work-tree"]).toString().trim();
    assert.equal(inside, "true");
    const sourceStatus = execFileSync("git", ["-C", projectDir, "status", "--porcelain"]).toString().trim();
    assert.equal(sourceStatus, "", "the source working tree must not be touched by the worktree task");

    await api(h, "POST", `/api/kanban/cards/${card.id}/stop`, {});
  } finally {
    await h.cleanup();
  }
});

test("Claude Stop hook moves the card to Review; typing moves it back to In Progress", async () => {
  const hookScript = [
    "#!/bin/sh",
    "printf 'HOOK_AGENT\\n'",
    'curl -sS -m 3 -X POST "$AGENTFABRIC_KANBAN_HOOK_URL" -H \'content-type: application/json\' -H "x-kanban-hook-token: $AGENTFABRIC_KANBAN_HOOK_TOKEN" -d "{\\"sessionId\\":\\"$AGENTFABRIC_KANBAN_SESSION_ID\\",\\"event\\":\\"to_review\\"}" >/dev/null 2>&1',
    "sleep 30",
    "",
  ].join("\n");
  const h = await makeHarness(hookScript);
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string; column: string } }>(
      h,
      "POST",
      `/api/kanban/projects/${project.id}/cards`,
      { prompt: "finish a turn", agentId: "claude" }
    );
    const { session } = await api<{ session: { id: string } }>(h, "POST", `/api/kanban/cards/${card.id}/start`, {});

    // The generated Claude settings actually carry the Stop hook.
    const settings = readFileSync(
      join(h.dir, "kanban", "provisioning", session.id, "claude-settings.json"),
      "utf8"
    );
    assert.match(settings, /"Stop"/);
    assert.match(settings, /to_review/);

    const awaiting = await pollSession(h, card.id, (s) => s.status === "awaiting_review");
    assert.equal(awaiting.status, "awaiting_review");
    const cards = await api<{ cards: Array<{ id: string; column: string }> }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/cards`
    );
    assert.equal(cards.cards.find((c) => c.id === card.id)?.column, "review");

    // The hook endpoint refuses a wrong/absent session token.
    const unauthorized = await fetch(`${h.baseUrl}/kanban-hooks/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, event: "to_review" }),
    });
    assert.equal(unauthorized.status, 403);

    // Typing into the still-live TUI is a new turn → back to In Progress.
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/${session.id}/terminal`, {
      headers: { Cookie: `af_token=${h.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.send(Buffer.from("x", "utf8"));
    const running = await pollSession(h, card.id, (s) => s.status === "running");
    assert.equal(running.status, "running");
    const moved = await api<{ cards: Array<{ id: string; column: string }> }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/cards`
    );
    assert.equal(moved.cards.find((c) => c.id === card.id)?.column, "in_progress");
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("a Claude permission/AskUserQuestion dialog parks the card in Review", async () => {
  // Verified against Claude Code 2.1.302: a pending dialog emits
  // PreToolUse → PermissionRequest → (human answers) → PostToolUse → Stop.
  // Stop does not fire while the dialog waits, and AskUserQuestion sends no
  // Notification at all — PermissionRequest is the only hook that sees it.
  const hookScript = [
    "#!/bin/sh",
    "printf 'HOOK_AGENT\\n'",
    'curl -sS -m 3 -X POST "$AGENTFABRIC_KANBAN_HOOK_URL" -H \'content-type: application/json\' -H "x-kanban-hook-token: $AGENTFABRIC_KANBAN_HOOK_TOKEN" -d "{\\"sessionId\\":\\"$AGENTFABRIC_KANBAN_SESSION_ID\\",\\"event\\":\\"needs_attention\\"}" >/dev/null 2>&1',
    "sleep 30",
    "",
  ].join("\n");
  const h = await makeHarness(hookScript);
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string; column: string } }>(
      h,
      "POST",
      `/api/kanban/projects/${project.id}/cards`,
      { prompt: "ask me a question", agentId: "claude" }
    );
    const { session } = await api<{ session: { id: string } }>(h, "POST", `/api/kanban/cards/${card.id}/start`, {});

    // The generated settings watch the dialog hook itself, not just the
    // permission_prompt notification.
    const settings = JSON.parse(
      readFileSync(join(h.dir, "kanban", "provisioning", session.id, "claude-settings.json"), "utf8")
    ) as { hooks: Record<string, unknown> };
    assert.ok(settings.hooks.PermissionRequest, "AskUserQuestion is only visible through PermissionRequest");
    assert.match(JSON.stringify(settings.hooks.PermissionRequest), /needs_attention/);
    assert.match(JSON.stringify(settings.hooks.Notification), /permission_prompt/);

    const waiting = await pollSession(h, card.id, (s) => s.status === "needs_attention");
    assert.equal(waiting.status, "needs_attention");
    const cards = await api<{ cards: Array<{ id: string; column: string }> }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/cards`
    );
    assert.equal(
      cards.cards.find((c) => c.id === card.id)?.column,
      "review",
      "a pending question parks the card in Review: the next move is the user's"
    );
  } finally {
    await h.cleanup();
  }
});

test("two Direct cards can run in one project at the same time", async () => {
  const h = await makeHarness();
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const cards = [];
    for (const prompt of ["first", "second"]) {
      const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
        prompt,
        agentId: "claude",
      });
      cards.push(card);
    }
    const sessions = [];
    for (const card of cards) {
      const { session } = await api<{ session: { id: string; status: string } }>(
        h,
        "POST",
        `/api/kanban/cards/${card.id}/start`,
        {}
      );
      assert.equal(session.status, "running");
      sessions.push(session);
    }
    const { cards: boardCards } = await api<{ cards: Array<{ id: string; column: string }> }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/cards`
    );
    for (const card of cards) {
      assert.equal(boardCards.find((entry) => entry.id === card.id)?.column, "in_progress");
    }
    for (const card of cards) await api(h, "POST", `/api/kanban/cards/${card.id}/stop`, {});
  } finally {
    await h.cleanup();
  }
});

test("a clean exit (node-pty signal 0) moves the card to Review", async () => {
  const h = await makeHarness("#!/bin/sh\nprintf 'CLEAN_EXIT_AGENT\\n'\nexit 0\n");
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "finish cleanly",
      agentId: "claude",
    });
    await api(h, "POST", `/api/kanban/cards/${card.id}/start`, {});
    const settled = await pollSession(h, card.id, (s) => s.status === "awaiting_review");
    assert.equal(settled.status, "awaiting_review");
    const { cards } = await api<{ cards: Array<{ id: string; column: string }> }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/cards`
    );
    assert.equal(cards.find((c) => c.id === card.id)?.column, "review");
  } finally {
    await h.cleanup();
  }
});

/** Raw request helper: these tests assert on error statuses, so no throwing. */
async function rawApi(
  h: Harness,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${h.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test("the project picker lists folders and flags Git repositories", async () => {
  const h = await makeHarness();
  try {
    const scanRoot = join(h.dir, "scan");
    mkdirSync(join(scanRoot, "plain"), { recursive: true });
    mkdirSync(join(scanRoot, "repo", ".git"), { recursive: true });
    mkdirSync(join(scanRoot, ".hidden"), { recursive: true });
    writeFileSync(join(scanRoot, "file.txt"), "not a folder");

    const { listing } = await api<{
      listing: {
        currentPath: string;
        parentPath: string | null;
        entries: Array<{ name: string; path: string; isGitRepository: boolean }>;
      };
    }>(h, "GET", `/api/kanban/fs?path=${encodeURIComponent(scanRoot)}`);

    assert.equal(listing.currentPath, scanRoot);
    assert.equal(listing.parentPath, h.dir);
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ["plain", "repo"]
    );
    assert.equal(listing.entries[0]?.isGitRepository, false);
    assert.equal(listing.entries[1]?.isGitRepository, true);
    assert.equal(listing.entries[1]?.path, join(scanRoot, "repo"));

    const missing = await rawApi(h, "GET", `/api/kanban/fs?path=${encodeURIComponent(join(scanRoot, "nope"))}`);
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, "kanban-path-invalid");
  } finally {
    await h.cleanup();
  }
});

test("adding a non-Git folder asks for an explicit choice, then honours it", async () => {
  const h = await makeHarness();
  try {
    const plainDir = join(h.dir, "plain-folder");
    mkdirSync(plainDir);

    // No choice yet: nothing is created, and the answer says why.
    const asked = await rawApi(h, "POST", "/api/kanban/projects", { path: plainDir });
    assert.equal(asked.status, 409);
    assert.equal(asked.data.code, "kanban-project-not-git");
    assert.equal(asked.data.requiresGitInitialization, true);
    assert.equal(asked.data.path, plainDir);
    const before = await api<{ projects: unknown[] }>(h, "GET", "/api/kanban/projects");
    assert.equal(before.projects.length, 0);

    // "Add without Git" is a real board project.
    const skipped = await api<{ project: { id: string; workspaceType: string; name: string } }>(
      h,
      "POST",
      "/api/kanban/projects",
      { path: plainDir, gitInit: "skip" }
    );
    assert.equal(skipped.project.workspaceType, "none");
    assert.equal(skipped.project.name, "plain-folder");

    // The same folder cannot be a second board.
    const duplicate = await rawApi(h, "POST", "/api/kanban/projects", { path: plainDir, gitInit: "skip" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, "kanban-project-duplicate");
  } finally {
    await h.cleanup();
  }
});

test("initializing Git on an existing folder creates a worktree-ready repository", async () => {
  const h = await makeHarness();
  try {
    const folder = join(h.dir, "to-init");
    mkdirSync(folder);
    writeFileSync(join(folder, "hello.txt"), "hello\n");

    const { project } = await api<{ project: { id: string; workspaceType: string } }>(
      h,
      "POST",
      "/api/kanban/projects",
      { path: folder, gitInit: "init" }
    );
    assert.equal(project.workspaceType, "git");
    // The initial commit is what makes a detached worktree possible.
    const head = execFileSync("git", ["-C", folder, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim();
    assert.match(head, /^[0-9a-f]{40}$/);

    const { git } = await api<{ git: { currentBranch: string | null; branches: string[] } | null }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/git`
    );
    assert.ok(git);
    assert.equal(git.branches.length, 1);
    assert.equal(git.currentBranch, git.branches[0]);
  } finally {
    await h.cleanup();
  }
});

test("cloning a Git URL adds the clone as a board project", async () => {
  const h = await makeHarness();
  try {
    const seed = join(h.dir, "seed");
    mkdirSync(seed);
    initGitRepo(seed);
    const target = join(h.dir, "cloned");

    const { project } = await api<{ project: { id: string; workspaceType: string; rootPath: string } }>(
      h,
      "POST",
      "/api/kanban/projects",
      { gitUrl: seed, path: target }
    );
    assert.equal(project.workspaceType, "git");
    assert.equal(project.rootPath, target);
    assert.ok(existsSync(join(target, ".git")));
    assert.ok(existsSync(join(target, "README.md")));

    // Cloning the same folder again is a duplicate board, not a second copy.
    const duplicate = await rawApi(h, "POST", "/api/kanban/projects", { gitUrl: seed, path: target });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, "kanban-project-duplicate");

    // A different, non-empty destination is refused instead of being merged into.
    const occupied = join(h.dir, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "keep me\n");
    const blocked = await rawApi(h, "POST", "/api/kanban/projects", { gitUrl: seed, path: occupied });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.data.code, "kanban-path-invalid");
  } finally {
    await h.cleanup();
  }
});

test("a worktree card checks out its base ref, and an unknown ref fails loudly", async () => {
  const h = await makeHarness();
  try {
    const repo = join(h.dir, "base-ref-repo");
    mkdirSync(repo);
    initGitRepo(repo);
    const mainBranch = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/base"]);
    writeFileSync(join(repo, "feature.txt"), "from the base ref\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "feature"]);
    execFileSync("git", ["-C", repo, "checkout", "-q", mainBranch]);

    const { project } = await api<{ project: { id: string; workspaceType: string } }>(
      h,
      "POST",
      "/api/kanban/projects",
      { path: repo }
    );
    assert.equal(project.workspaceType, "git");

    const { git } = await api<{ git: { currentBranch: string | null; branches: string[]; defaultBranch: string | null } }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/git`
    );
    assert.deepEqual([...git.branches].sort(), ["feature/base", mainBranch].sort());
    assert.equal(git.currentBranch, mainBranch);

    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "start from the feature branch",
      agentId: "claude",
      executionMode: "worktree",
      baseRef: "feature/base",
    });
    const { session } = await api<{ session: { id: string; status: string; cwd: string } }>(
      h,
      "POST",
      `/api/kanban/cards/${card.id}/start`,
      {}
    );
    // The checkout is the base ref's tree, not the project HEAD.
    assert.ok(session.cwd.includes(join("kanban", "worktrees")));
    assert.ok(existsSync(join(session.cwd, "feature.txt")));
    await api(h, "POST", `/api/kanban/cards/${card.id}/stop`, {});

    const { card: badCard } = await api<{ card: { id: string } }>(
      h,
      "POST",
      `/api/kanban/projects/${project.id}/cards`,
      { prompt: "bad ref", agentId: "claude", executionMode: "worktree", baseRef: "does-not-exist" }
    );
    const failed = await rawApi(h, "POST", `/api/kanban/cards/${badCard.id}/start`, {});
    assert.equal(failed.status, 404);
    assert.equal(failed.data.code, "base-ref-not-found");
    const latest = await api<{ session: { status: string; error: string } }>(
      h,
      "GET",
      `/api/kanban/cards/${badCard.id}/session`
    );
    assert.equal(latest.session.status, "failed");
    assert.match(latest.session.error, /does-not-exist/);
  } finally {
    await h.cleanup();
  }
});

test("moving a card to Done keeps the process when there is nothing to resume from", async () => {
  // Releasing is only safe when the conversation can be resumed. An agent that
  // never reported a harness session id (no hooks, e.g. Pi) would lose its only
  // copy of the conversation, so its process stays.
  const h = await makeHarness("#!/bin/sh\nprintf AGENT_UP\nsleep 60\n");
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "archive me",
      agentId: "claude",
    });
    await api(h, "POST", `/api/kanban/cards/${card.id}/start`, {});
    await api(h, "POST", `/api/kanban/cards/${card.id}/move`, { column: "trash" });
    const parked = await api<{ session: { status: string; nativeSessionId?: string } }>(
      h,
      "GET",
      `/api/kanban/cards/${card.id}/session`
    );
    assert.equal(parked.session.status, "running", "no resume id → keep the process rather than lose the conversation");
    assert.equal(parked.session.nativeSessionId, undefined);

    // Restoring the card still works, and the session is still the same one.
    await api(h, "POST", `/api/kanban/cards/${card.id}/move`, { column: "review" });
    const { session } = await api<{ session: { status: string } }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
    assert.equal(session.status, "running");
    await api(h, "POST", `/api/kanban/cards/${card.id}/stop`, {});
  } finally {
    await h.cleanup();
  }
});

test("Done releases the process and restoring relaunches with --resume", async () => {
  // The whole point of recording the harness session id: archive the card, give
  // the process back, and bring the conversation back on restore.
  const h = await makeHarness("#!/bin/sh\nprintf AGENT_UP\nsleep 60\n");
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "archive me",
      agentId: "claude",
    });
    const { session } = await api<{ session: { id: string } }>(h, "POST", `/api/kanban/cards/${card.id}/start`, {});

    // A Claude hook records the harness session id.
    const settings = readFileSync(join(h.dir, "kanban", "provisioning", session.id, "claude-settings.json"), "utf8");
    const hookToken = (settings.match(/x-kanban-hook-token: ([a-f0-9]+)/) ?? [])[1];
    await fetch(`${h.baseUrl}/kanban-hooks/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kanban-hook-token": hookToken! },
      body: JSON.stringify({ sessionId: session.id, event: "to_review", nativeSessionId: "claude-session-abc" }),
    });

    // Archiving releases the process: nothing left running, id retained.
    await api(h, "POST", `/api/kanban/cards/${card.id}/move`, { column: "trash" });
    const parked = await api<{ session: { status: string; nativeSessionId?: string } }>(
      h,
      "GET",
      `/api/kanban/cards/${card.id}/session`
    );
    assert.equal(parked.session.status, "stopped");
    assert.equal(parked.session.nativeSessionId, "claude-session-abc");

    // Restoring and starting relaunches Claude with `--resume <id>`, and the
    // fake CLI records the argv it was given.
    await api(h, "POST", `/api/kanban/cards/${card.id}/move`, { column: "review" });
    const argvFile = join(h.dir, "argv.txt");
    writeFileSync(
      join(h.dir, "bin", "claude"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\nprintf RESUMED\\n\nsleep 60\n`
    );
    chmodSync(join(h.dir, "bin", "claude"), 0o755);
    await api(h, "POST", `/api/kanban/cards/${card.id}/start`, {});
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(argvFile)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const argv = readFileSync(argvFile, "utf8");
    assert.match(argv, /--resume/);
    assert.match(argv, /claude-session-abc/);
    await api(h, "POST", `/api/kanban/cards/${card.id}/stop`, {});
  } finally {
    await h.cleanup();
  }
});

test("a hook-reported harness session id is recorded on the session", async () => {
  const h = await makeHarness();
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "record my id",
      agentId: "claude",
    });
    const { session } = await api<{ session: { id: string } }>(h, "POST", `/api/kanban/cards/${card.id}/start`, {});

    // The generated Claude hook reads the harness payload off stdin; assert the
    // command carries the plumbing that forwards its session id.
    const settings = readFileSync(join(h.dir, "kanban", "provisioning", session.id, "claude-settings.json"), "utf8");
    assert.match(settings, /nativeSessionId/, "the hook must forward the harness session id");

    // The endpoint stores it when a hook supplies one.
    const token = readFileSync(join(h.dir, "token"), "utf8").trim();
    void token;
    const hookToken = (settings.match(/x-kanban-hook-token: ([a-f0-9]+)/) ?? [])[1];
    assert.ok(hookToken, "hook token must be embedded in the settings");
    const res = await fetch(`${h.baseUrl}/kanban-hooks/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kanban-hook-token": hookToken },
      body: JSON.stringify({ sessionId: session.id, event: "to_review", nativeSessionId: "claude-session-123" }),
    });
    assert.equal(res.status, 200);
    const stored = await api<{ session: { nativeSessionId?: string } }>(h, "GET", `/api/kanban/cards/${card.id}/session`);
    assert.equal(stored.session.nativeSessionId, "claude-session-123");
    await api(h, "POST", `/api/kanban/cards/${card.id}/stop`, {});
  } finally {
    await h.cleanup();
  }
});

test("clearing Done deletes only trashed card records", async () => {
  const h = await makeHarness();
  try {
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card: kept } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "keep me",
      agentId: "claude",
    });
    const { card: trashed } = await api<{ card: { id: string } }>(
      h,
      "POST",
      `/api/kanban/projects/${project.id}/cards`,
      { prompt: "clear me", agentId: "claude" }
    );
    await api(h, "POST", `/api/kanban/cards/${trashed.id}/move`, { column: "trash" });

    const cleared = await api<{ deleted: number }>(h, "POST", `/api/kanban/projects/${project.id}/trash/clear`, {});
    assert.equal(cleared.deleted, 1);

    const { cards } = await api<{ cards: Array<{ id: string; column: string }> }>(
      h,
      "GET",
      `/api/kanban/projects/${project.id}/cards`
    );
    assert.deepEqual(cards.map((card) => card.id), [kept.id]);
    // The folder itself is untouched: clearing Done is a record operation.
    assert.ok(existsSync(join(h.dir, "project")));

    const again = await api<{ deleted: number }>(h, "POST", `/api/kanban/projects/${project.id}/trash/clear`, {});
    assert.equal(again.deleted, 0);
  } finally {
    await h.cleanup();
  }
});

test("the agent chat socket shares the terminal socket's auth and transport guards", async () => {
  const h = await makeHarness();
  try {
    // No token: the upgrade is rejected before any session logic runs.
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/nope/agent`);
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        assert.equal(res.statusCode, 401);
        resolve();
      });
      ws.on("error", () => resolve());
      ws.on("open", () => {
        ws.close();
        assert.fail("unauthenticated agent socket opened");
      });
    });

    // A valid token still cannot open a chat on a session that does not exist.
    const unknown = await new Promise<string[]>((resolve) => {
      const seen: string[] = [];
      const ws = new WebSocket(
        `ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/does-not-exist/agent`,
        { headers: { authorization: `Bearer ${h.token}` } }
      );
      ws.on("message", (raw) => seen.push(raw.toString()));
      ws.on("close", () => resolve(seen));
      ws.on("error", () => resolve(seen));
    });
    const notFound = unknown.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "agent_error");
    assert.equal(notFound?.code, "kanban-session-not-found");

    // A PTY session is a terminal, not a chat: the agent socket says so
    // instead of silently streaming nothing.
    const { project } = await api<{ project: { id: string } }>(h, "POST", "/api/kanban/projects", {
      path: join(h.dir, "project"),
      gitInit: "skip",
    });
    const { card } = await api<{ card: { id: string } }>(h, "POST", `/api/kanban/projects/${project.id}/cards`, {
      prompt: "stay alive",
      agentId: "claude",
    });
    const { session } = await api<{ session: { id: string } }>(h, "POST", `/api/kanban/cards/${card.id}/start`, {});
    const frames = await new Promise<string[]>((resolve) => {
      const seen: string[] = [];
      const ws = new WebSocket(
        `ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/${session.id}/agent`,
        { headers: { authorization: `Bearer ${h.token}` } }
      );
      ws.on("message", (raw) => seen.push(raw.toString()));
      ws.on("close", () => resolve(seen));
      ws.on("error", () => resolve(seen));
    });
    const wrongTransport = frames.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "agent_error");
    assert.equal(wrongTransport?.code, "kanban-session-not-agent");
  } finally {
    await h.cleanup();
  }
});

test("a malformed session id in a socket upgrade is rejected without taking the server down", async () => {
  const h = await makeHarness();
  try {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${new URL(h.baseUrl).port}/api/kanban/sessions/%E0%A4%A/agent`,
        { headers: { authorization: `Bearer ${h.token}` } }
      );
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        assert.equal(res.statusCode, 400);
        resolve();
      });
      ws.on("error", () => resolve());
      ws.on("open", () => {
        ws.close();
        assert.fail("malformed session id opened a socket");
      });
    });
    // The upgrade listener ran inside the HTTP server; an exception there would
    // have exited the process, so a healthy answer proves it was contained.
    const health = await fetch(`${h.baseUrl}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await h.cleanup();
  }
});
