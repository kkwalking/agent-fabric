/**
 * End-to-end check of the **installed/packaged** app: `npm run desktop:verify`.
 *
 * `verify-app.mjs` proves the bundle's server runs; `gui-verify.mjs` proves a
 * window opens and serves the UI. Neither looks at what the user actually sees
 * after a change, so a UI regression can ship in a bundle that "starts fine".
 * This script drives the real app window over the Chrome DevTools Protocol and
 * asserts the behaviour of the features this repository has been changing:
 *
 *   - the rail lists every task under the workspace it belongs to;
 *   - clicking a session opens that task in the main area;
 *   - the rail's "More" panel reaches the pages that no longer have a nav row;
 *   - Settings opens, lists its sections, and has the credentials section
 *     (moved out of the top-level nav);
 *   - the interface switches between Chinese and English;
 *   - no dashboard chunk is shipped, and `/` lands on the task list.
 *
 * It launches the app with `--remote-debugging-port` and a scratch data
 * directory, so it never touches the user's `~/.fabric`. Chromium refuses a
 * non-default data directory for the *profile* unless told otherwise, so the
 * app is given `--user-data-dir` too; both flags are Chromium's own, not app
 * options.
 *
 * Usage:
 *   node packages/desktop/scripts/verify-ui.mjs [appPath] [--keep-open]
 *
 * The app defaults to /Applications/AgentFabric.app.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const appPath = resolve(args.find((a) => !a.startsWith("--")) ?? "/Applications/AgentFabric.app");
const keepOpen = args.includes("--keep-open");
/**
 * Run against an *empty* data directory instead of the fixture.
 *
 * Every other check runs with data, so the empty path (a fresh install: no
 * tasks, no projects, nothing) was never exercised by anything automated — and
 * it is the very first screen a new user sees.
 */
const emptyMode = args.includes("--empty");

if (!existsSync(join(appPath, "Contents", "MacOS", "AgentFabric"))) {
  console.error(`[verify-ui] no app bundle at ${appPath}`);
  process.exit(2);
}

const DEBUG_PORT = 9333;
const failures = [];
const notes = [];
const check = (ok, message) => {
  if (ok) notes.push(`  ok   ${message}`);
  else failures.push(message);
};

/** Minimal CDP client: one websocket, request ids, event-free. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error("could not open the DevTools websocket")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

/** Evaluates an expression in the page and returns its JSON value. */
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
}

/** Waits until `expression` is truthy in the page. */
async function waitFor(cdp, expression, timeoutMs = 20_000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Finding a free TCP port, so two runs never collide. */
async function freePort() {
  const { createServer } = await import("node:http");
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const dataDir = mkdtempSync(join(tmpdir(), "af-verify-ui-"));
/** Two workspaces, three tasks, one task with no workspace (the catch-all). */
function writeFixture(dir) {
  const now = new Date().toISOString();
  const workspace = (id, name, path, extra = {}) => ({
    id, name, type: "local", path, mountPath: "/workspace",
    persistent: true, source: "create", status: "ready", ownership: "external",
    createdAt: now, updatedAt: now, ...extra,
  });
  const task = (id, title, workspaceId) => ({
    id, title, prompt: title, workspaceId,
    env: {}, secretIds: [], tools: [], createdAt: now, updatedAt: now,
    metadata: { lastActivityAt: now },
  });
  // A board workspace is a Workspace carrying `board` settings — the board has
  // no collection of its own.
  const kanbanCard = (id, title, column) => ({
    id, workspaceId: "ws_verify_board", title, prompt: title, column,
    agentId: "dsh", executionMode: "direct", createdAt: now, updatedAt: now,
  });
  const db = {
    providers: [], models: [], runtimes: [], secrets: [], profiles: [],
    sources: [],
    // One credential and one project, so the two deletes that ask for
    // confirmation have a row to act on. Without them the check below finds no
    // button and can only report that it checked nothing.
    sourceCredentials: [
      {
        id: "cred_verify",
        name: "verify-credential",
        type: "https-token",
        host: "example.invalid",
        username: "verify",
        createdAt: now,
        updatedAt: now,
      },
    ],
    projects: [
      {
        id: "proj_verify",
        name: "verify-project",
        source: { type: "directory", path: "/tmp/af-verify-project", defaultBranch: "main" },
        createdAt: now,
        updatedAt: now,
      },
    ],
    workspaceLocks: [],
    runs: [], eventShards: [], artifacts: [], handoffs: [],
    runtimeSessions: [], nativeStates: [], kanbanSessions: [],
    config: {},
    kanbanCards: [
      kanbanCard("card_verify_done", "verify done card", "trash"),
      kanbanCard("card_verify_open", "verify open card", "review"),
    ],
    workspaces: [
      // The board's workspace first: opening /kanban selects the first one
      // unless this browser already remembers another.
      workspace("ws_verify_board", "af-board", "/tmp/af-verify-board", {
        board: { workspaceType: "git", defaultAgentId: "dsh", defaultExecutionMode: "direct" },
      }),
      workspace("ws_verify_alpha", "verify-alpha", "/tmp/af-verify-alpha"),
      workspace("ws_verify_beta", "verify-beta", "/tmp/af-verify-beta"),
      // A long workspace, so paging has something to page through.
      workspace("ws_verify_bulk", "verify-bulk", "/tmp/af-verify-bulk"),
      // A live turn whose shell tool already finished (see the run below).
      workspace("ws_verify_live", "verify-live", "/tmp/af-verify-live"),
    ],
    tasks: [
      task("task_verify_1", "verify task one", "ws_verify_alpha"),
      task("task_verify_2", "verify task two", "ws_verify_alpha"),
      task("task_verify_3", "verify task three", "ws_verify_beta"),
      task("task_verify_orphan", "verify orphan task", undefined),
      task("task_verify_live", "verify live task", "ws_verify_live"),
      ...Array.from({ length: 25 }, (_, i) => task(`task_bulk_${i}`, `bulk session ${i}`, "ws_verify_bulk")),
    ],
  };
  // A thread long enough to scroll, so the "keep the newest message in view"
  // behaviour can be checked in the packaged app. Events live in their own
  // JSONL file per run, which is the same shape the server reads back.
  const longRunId = "run_verify_long";
  const longRunId2 = "run_verify_long_b";
  const runMessages = 60;
  db.runs = [
    {
      id: longRunId,
      taskId: "task_verify_1",
      taskTitle: "verify task one",
      status: "completed",
      runtimeId: "rt_verify",
      runtimeName: "verify",
      modelId: "model_verify",
      modelName: "verify",
      providerId: "prov_verify",
      workspaceId: "ws_verify_alpha",
      inputInstruction: "verify task one",
      continuity: "fresh",
      lifecycle: "ephemeral",
      artifactIds: [],
      eventCount: runMessages + 2,
      createdAt: now,
      updatedAt: now,
      startTime: now,
      endTime: now,
    },
  ];
  db.runs.push({
    ...db.runs[0],
    id: longRunId2,
    taskId: "task_verify_2",
    taskTitle: "verify task two",
    inputInstruction: "verify task two",
  });
  // A failed execution, with the record an inspector shows: the harness error,
  // one inline artifact (previewable) and one on-disk artifact (a path), and a
  // consumed handoff whose content has a summary plus checkpoint sections.
  // Costs of different magnitudes, so the money format is observable: a
  // fraction of a cent, a few cents, more than a dollar.
  db.runs[0] = { ...db.runs[0], cost: 0.000012 };
  db.runs[1] = { ...db.runs[1], cost: 1.2345 };
  db.runs.push({
    ...db.runs[0],
    id: "run_verify_failed",
    taskId: "task_verify_1",
    taskTitle: "verify task one",
    status: "failed",
    phase: "failed",
    error: "harness exited with code 2\n  stderr: spawn verify-harness ENOENT",
    artifactIds: ["art_verify_inline", "art_verify_disk"],
    previousHandoffId: "hof_verify",
  });
  db.artifacts = [
    {
      id: "art_verify_inline",
      runId: "run_verify_failed",
      name: "build.log",
      kind: "log",
      mime: "text/plain",
      size: 64,
      content: "line one of the build log\nline two of the build log",
      createdAt: now,
    },
    {
      id: "art_verify_disk",
      runId: "run_verify_failed",
      name: "report.html",
      kind: "report",
      path: "/workspace/report.html",
      size: 4096,
      createdAt: now,
    },
  ];
  db.handoffs = [
    {
      id: "hof_verify",
      taskId: "task_verify_1",
      fromRunId: longRunId,
      source: "agentfabric",
      artifactIds: [],
      createdAt: now,
      workspaceId: "ws_verify_alpha",
      content: {
        summary: "The parser was rewritten to stream.",
        contextBundle: {
          checkpoint: "## Goal\nMake the parser streaming.\n\n## Decisions\nDropped the buffered reader.",
          pinnedContext: [],
          retainedContext: [],
        },
      },
    },
  ];
  /**
   * A turn that is still running: one shell tool already finished, one still
   * streaming. The finished command's row must stop spinning while the turn
   * goes on, and the streaming one must keep its spinner — both used to spin
   * until the whole run ended.
   */
  const liveRunId = "run_verify_live";
  const liveEvents = [
    { type: "run.started", data: {} },
    // The harness launch line is never an activity row.
    { type: "shell.command", data: { command: "dsh --profile headless …", harnessInvocation: true } },
    { type: "shell.command", data: { command: "verify-finished-cmd", toolCallId: "call_done" } },
    { type: "shell.output", data: { output: "3 passing", status: "completed", toolCallId: "call_done" } },
    { type: "shell.command", data: { command: "verify-open-cmd", toolCallId: "call_open" } },
    { type: "shell.output", data: { line: "still running", stream: "stdout", toolCallId: "call_open" } },
    { type: "tool.started", data: { tool: "read", toolCallId: "call_read", args: { file_path: "README.md" } } },
    { type: "tool.completed", data: { tool: "read", toolCallId: "call_read", result: "ok" } },
  ].map((e, i) => JSON.stringify({ id: `${liveRunId}-${i}`, runId: liveRunId, seq: i, timestamp: now, source: "runtime", ...e }));
  db.runs.push({
    ...db.runs[0],
    id: liveRunId,
    taskId: "task_verify_live",
    taskTitle: "verify live task",
    status: "running",
    inputInstruction: "verify live task",
    endTime: undefined,
    eventCount: liveEvents.length,
  });
  const shard = (runId) => ({
    runId,
    file: `events/${runId}.jsonl`,
    count: runMessages + 2,
    bytes: 0,
    lastSeq: runMessages + 2,
    createdAt: now,
    updatedAt: now,
  });
  db.eventShards = [
    shard(longRunId),
    shard(longRunId2),
    { runId: liveRunId, file: `events/${liveRunId}.jsonl`, count: liveEvents.length, bytes: 0, lastSeq: liveEvents.length - 1, createdAt: now, updatedAt: now },
  ];
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  const buildLines = (runId) => {
  const lines = [{ id: `${runId}-0`, runId, seq: 0, type: "run.started", timestamp: now, data: {}, source: "server" }];
  for (let i = 1; i <= runMessages; i++) {
    lines.push({
      id: `${runId}-${i}`,
      runId,
      seq: i,
      // `agent.message` is what the timeline projects into a visible row;
      // role must not be user/system or it is treated as a harness echo.
      type: "agent.message",
      timestamp: now,
      // Long enough per message that the thread overflows the viewport.
      data: { role: "assistant", content: `verify line ${i}: ${"x".repeat(90)}` },
      source: "runtime",
    });
  }
  lines.push({ id: `${runId}-end`, runId, seq: runMessages + 1, type: "run.completed", timestamp: now, data: {}, source: "server" });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  };
  for (const runId of [longRunId, longRunId2]) {
    writeFileSync(join(dir, "events", `${runId}.jsonl`), buildLines(runId));
  }
  writeFileSync(join(dir, "events", `${liveRunId}.jsonl`), liveEvents.join("\n") + "\n");
  writeFileSync(join(dir, "db.json"), JSON.stringify(db, null, 2));
}
if (!emptyMode) writeFixture(dataDir);
const profileDir = mkdtempSync(join(tmpdir(), "af-verify-profile-"));
const port = await freePort();
const env = { ...process.env, AGENTFABRIC_DATA_DIR: dataDir };
// The app is an Electron binary: an inherited ELECTRON_RUN_AS_NODE turns it
// into a plain Node process with no window to inspect.
delete env.ELECTRON_RUN_AS_NODE;
// A separate profile keeps the check away from the user's own Electron state.
/**
 * Warn when the app being checked is not the one the current sources produce.
 *
 * This has cost a full round three times: the checks fail, the code looks
 * broken, and the real cause is that /Applications still holds the previous
 * build. A stale build cannot be caught by any assertion inside the app.
 *
 * The signal is the web bundle's mtime: `build-mac` rebuilds it while packing
 * and `ditto` preserves it on install, so a current install matches dist within
 * a second. It is a warning rather than an error because a legitimate workflow
 * can rebuild dist afterwards without wanting to reinstall (e.g. iterating on
 * the UI against the dev server) — but the checks should never be read as
 * "this source tree is broken" without that caveat on screen.
 */
function checkBuildIsCurrent(target) {
  const installed = join(target, "Contents", "Resources", "web", "assets");
  const local = resolve(new URL("../../web/dist/assets", import.meta.url).pathname);
  if (!existsSync(installed) || !existsSync(local)) return null;
  const newest = (dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => statSync(join(dir, f)).mtimeMs)
      .reduce((a, b) => Math.max(a, b), 0);
  const installedAt = newest(installed);
  const localAt = newest(local);
  if (!installedAt || !localAt || localAt <= installedAt + 1000) return null;
  const behind = Math.round((localAt - installedAt) / 1000);
  return `WARNING: ${target} predates packages/web/dist by ${behind}s — these checks did NOT exercise your latest sources. Rebuild and reinstall: npm run desktop:dmg && npm run desktop:install`;
}
/**
 * Detect the build being broken by two watchers writing the same dist.
 *
 * `vite build --watch` does not clean its output directory. Two of them running
 * (an old `npm run dev` left over from a previous session plus a new one) leave
 * *two* chunks per view, and index.html ends up pointing at one of them while
 * the other lingers. The visible symptom is a page that renders nothing at all,
 * which reads like a component bug and is not one. This happened once and cost
 * a full round of diagnosis, so it is checked before anything is launched.
 */
function checkDistIsConsistent() {
  const outDir = resolve(new URL("../../web/dist/assets", import.meta.url).pathname);
  if (!existsSync(outDir)) return null;
  // Count per base name *and extension*: a view legitimately emits both a .js and
  // a .css under the same base, so only a repeated .js (or repeated .css) means
  // two builds are on disk.
  const seen = new Map();
  for (const file of readdirSync(outDir)) {
    const m = file.match(/^(.+)-[A-Za-z0-9_-]{8}\.(js|css)$/);
    if (!m) continue;
    const key = `${m[1]}.${m[2]}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicated = [...seen].filter(([key, count]) => count > 1 && !key.startsWith("index."));
  if (duplicated.length === 0) return null;
  return `WARNING: packages/web/dist holds more than one build (duplicated chunks: ${duplicated
    .map(([b, n]) => `${b}×${n}`)
    .join(", ")}). A page may render blank. Fix: kill every extra \`vite build --watch\`, then rm -rf packages/web/dist && npm run build -w @agentfabric/web`;
}

const staleBuildWarning = checkBuildIsCurrent(appPath);
if (staleBuildWarning) console.warn(`\n[verify-ui] ${staleBuildWarning}\n`);
const distWarning = checkDistIsConsistent();
if (distWarning) console.warn(`\n[verify-ui] ${distWarning}\n`);

const app = spawn(
  join(appPath, "Contents", "MacOS", "AgentFabric"),
  [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] }
);
let appOutput = "";
const collect = (chunk) => (appOutput += String(chunk));
app.stdout.on("data", collect);
app.stderr.on("data", collect);

let cdp;
let exitCode = 0;

/**
 * Creates one throwaway task through the API, so a check that deletes a row does
 * not consume the records later checks read. The run itself fails harmlessly
 * (a missing harness binary); the task record is all a list needs.
 */
const createThrowawayTask = async (cdp, title) =>
  evaluate(
    cdp,
    `(async () => {
       const runtimes = await (await fetch("/api/runtimes")).json();
       const runtime = runtimes.find((r) => r.usableInTask);
       if (!runtime) return null;
       const created = await (await fetch("/api/runs", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ prompt: ${JSON.stringify(title)}, title: ${JSON.stringify(title)}, workspaceId: "ws_verify_alpha", runtimeId: runtime.id }),
       })).json();
       return created?.task?.id ?? null;
     })()`
  );

try {
  // 1. Wait for the DevTools endpoint, then attach to the window's page.
  const target = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page;
      } catch {
        /* the port is not open yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`the app never exposed a DevTools page on port ${DEBUG_PORT}. Output:\n${appOutput}`);
  })();
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // 2. The window loaded the app's own UI.
  await waitFor(cdp, `Boolean(document.querySelector(".sidebar"))`, 30_000, "the app shell to render");
  const title = await evaluate(cdp, `document.title`);
  check(title === "AgentFabric", `window title is "${title}"`);

  // 3. The app under test must not depend on the user's own data: a fresh data
  //    directory has no tasks, and the rail's grouping only exists once there
  //    are some. So the scratch directory starts with a small, known fixture
  //    written straight into `db.json` (the store's own format) *before* the
  //    app is launched — creating tasks through the API would start real agent
  //    runs, which is not what this check is about.
  // FIXTURE-DATA ONLY (4-rail-groups)
  if (!emptyMode) {
  // 4. The rail groups those tasks by workspace.
  // In empty mode there are no groups to appear: the rail having rendered *its
  // own* empty message is what "loaded" means there.
  await waitFor(
    cdp,
    emptyMode
      ? `Boolean(document.querySelector(".ws-tree-empty"))`
      : `document.querySelectorAll(".ws-group").length > 0`,
    20_000,
    emptyMode ? "the empty rail message" : "the workspace tree to load"
  );
  const rail = await evaluate(
    cdp,
    `(() => {
       const groups = [...document.querySelectorAll(".ws-group")].map((g) => ({
         label: g.querySelector(".ws-group-name")?.textContent?.trim(),
         tasks: g.querySelectorAll(".ws-task").length,
       }));
       return {
         groups,
         hasDash: Boolean(document.querySelector(".ws-group-name")?.textContent?.match(/dashboard|概览/i)) === false,
         railTitle: document.querySelector(".rail-head-title")?.textContent?.trim(),
       };
     })()`
  );
  const byLabel = new Map(rail.groups.map((g) => [g.label, g.tasks]));
  check(
    byLabel.get("verify-alpha") === 2 && byLabel.get("verify-beta") === 1,
    `rail groups the fixture by workspace: ${rail.groups.map((g) => `${g.label}(${g.tasks})`).join(", ")}`
  );
  check(
    byLabel.has("未归类（没有工作区）") || rail.groups.some((g) => /未归类|Unfiled/.test(g.label)),
    `the workspace-less task gets its own catch-all group (${rail.groups.length} groups)`
  );
  const titled = await evaluate(cdp, `document.querySelector(".rail-head-title")?.textContent?.trim()`);
  check(/工作区|Workspaces/.test(titled ?? ""), `rail heading is "${titled}"`);

  // 4b. The Tasks header is a title only: trash, refresh and new-task moved
  //     out of it (Trash now lives in Settings).
  const tasksHeader = await evaluate(
    cdp,
    `(() => {
       const row = document.querySelector("main h1")?.closest(".row");
       return {
         buttons: [...(row?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()),
         subtitle: document.querySelector("main .row + .sub")?.textContent?.trim() ?? null,
       };
     })()`
  );
  check(
    tasksHeader.buttons.length === 0 && tasksHeader.subtitle === null,
    `the Tasks header is a title only — no buttons (${tasksHeader.buttons.join(", ") || "none"}), no subtitle`
  );

  // FIXTURE-DATA ONLY (4-dist)
  if (!emptyMode) {
  }

  // 4. Distribution endpoints the rail depends on answer from the bundle.
  const api = await evaluate(
    cdp,
    `(async () => {
       const token = await (await fetch("/api/health")).ok;
       const tasks = await (await fetch("/api/tasks")).json();
       const workspaces = await (await fetch("/api/workspaces")).json();
       return { health: token, tasks: tasks.length, workspaces: workspaces.length };
     })()`
  );
  check(api.health === true, `/api/health answers ok (${api.tasks} tasks, ${api.workspaces} workspaces)`);

  // FIXTURE-DATA ONLY (5-open)
  if (!emptyMode) {
  }

  // 5. Clicking a session opens that task.
  const opened = await evaluate(
    cdp,
    `(async () => {
       const row = document.querySelector(".ws-task");
       const label = row?.getAttribute("title") ?? null;
       row?.click();
       await new Promise((r) => setTimeout(r, 1200));
       const activeRow = document.querySelector(".ws-task-row.active");
       return {
         label,
         path: location.pathname,
         active: activeRow?.querySelector(".ws-task")?.getAttribute("title") ?? null,
         // Reported separately so a broken highlight is not confused with a
         // selector that simply moved (the class lives on the row, not the button).
         activeRows: document.querySelectorAll(".ws-task-row.active").length,
       };
     })()`
  );
  check(/^\/tasks\/.+/.test(opened.path), `clicking a session navigates (${opened.path})`);
  check(
    opened.active !== null && opened.active === opened.label && opened.activeRows === 1,
    `the opened session is the only highlighted row (${opened.activeRows} highlighted, "${opened.active}")`
  );

  // FIXTURE-DATA ONLY (5b)
  if (!emptyMode) {
  }

  // 5b. The rail's new-session button, the Kanban row, and the row menu.
  const railOps = await evaluate(
    cdp,
    `(async () => {
       const newBtn = document.querySelector(".rail-new");
       const kanbanBtn = document.querySelector(".rail-kanban");
       const railHead = document.querySelector(".rail-head");
       const newRect = newBtn?.getBoundingClientRect();
       const kanbanRect = kanbanBtn?.getBoundingClientRect();
       const headRect = railHead?.getBoundingClientRect();
       const headIcons = document.querySelectorAll(".rail-head-actions .icon-btn").length;
       document.querySelector(".ws-task-row .ws-task-more")?.click();
       await new Promise((r) => setTimeout(r, 300));
       const menu = document.querySelector(".ws-task-menu");
       const items = menu ? [...menu.querySelectorAll("button")].map((b) => b.textContent.trim()) : [];
       const rect = menu?.getBoundingClientRect();
       const menuOnScreen = rect ? rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1 : false;
       document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
       window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
       await new Promise((r) => setTimeout(r, 200));
       return {
         newLabel: newBtn?.textContent?.trim() ?? null,
         kanbanLabel: kanbanBtn?.textContent?.trim() ?? null,
         kanbanBetween: Boolean(newRect && kanbanRect && headRect && newRect.bottom <= kanbanRect.top && kanbanRect.bottom <= headRect.top),
         headIcons,
         items,
         menuOnScreen,
         closedByEscape: !document.querySelector(".ws-task-menu"),
       };
     })()`
  );
  check(/新会话|New session/.test(railOps.newLabel ?? ""), `the rail has a new-session button ("${railOps.newLabel}")`);
  check(/看板|Kanban/.test(railOps.kanbanLabel ?? ""), `the rail has a Kanban entry ("${railOps.kanbanLabel}")`);
  check(railOps.kanbanBetween, "the Kanban entry sits between New session and the Workspaces heading");
  // Two, not three: a "search" button that only navigated to the task list is
  // gone (the brand button already goes there).
  check(railOps.headIcons === 2, `the workspace heading carries ${railOps.headIcons} icons (filter / new)`);
  check(railOps.items.length === 4, `session menu offers ${railOps.items.length} actions: ${railOps.items.join(", ")}`);
  check(railOps.menuOnScreen && railOps.closedByEscape, "the session menu stays on screen and closes on Escape");

  // FIXTURE-DATA ONLY (5b-1 - needs sessions to delete)
  if (!emptyMode) {
    // 5b-1. Deleting a session from the rail asks first, like every other
    //       destructive action: it used to delete on the menu click and could
    //       leave the open /tasks/<id> page pointing at a record that no longer
    //       exists. Cancelling must change nothing; confirming removes exactly
    //       the one row.
    //
    //       The row deleted is a disposable one created here, not a seeded
    //       session: later checks read the fixture's own tasks.
    const railDelete = await evaluate(
      cdp,
      `(async () => {
         // A runtime the API accepts for a task: the mock agent is not usable in
         // tasks, so the run is created on whichever host harness is available.
         // The run itself fails harmlessly (spawn ENOENT and friends); its task
         // record is all this check needs.
         const runtimes = await (await fetch("/api/runtimes")).json();
         const runtime = runtimes.find((r) => r.usableInTask);
         if (!runtime) return { error: "no task-usable runtime" };
         const created = await (await fetch("/api/runs", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({
             prompt: "rail delete probe",
             title: "rail delete probe",
             workspaceId: "ws_verify_alpha",
             runtimeId: runtime.id,
           }),
         })).json();
         const taskId = created?.task?.id ?? null;
         if (!taskId) return { error: "the probe run was not created" };
         // Another view's write is not visible to the mounted rail until its own
         // five-second GET cache ages out or a write on this page invalidates it;
         // the same event a real creation fires is what makes the row appear.
         window.dispatchEvent(new Event("agentfabric:tasks-changed"));
         const rowTitle = (r) => r.querySelector(".ws-task")?.getAttribute("title");
         const deadline = Date.now() + 12000;
         let row = null;
         while (Date.now() < deadline && !row) {
           row = [...document.querySelectorAll(".ws-task-row")]
             .find((r) => rowTitle(r) === "rail delete probe") ?? null;
           if (!row) await new Promise((r) => setTimeout(r, 250));
         }
         if (!row) return { error: "the probe session never appeared in the rail", taskId };
         const rowCount = () => document.querySelectorAll(".ws-task-row").length;
         const before = rowCount();
         const openDanger = async () => {
           row.querySelector(".ws-task-more")?.click();
           await new Promise((r) => setTimeout(r, 350));
           [...document.querySelectorAll(".ws-task-menu button")]
             .find((b) => b.classList.contains("danger"))
             ?.click();
           await new Promise((r) => setTimeout(r, 600));
           return [...document.querySelectorAll(".ws-rename[role=dialog]")]
             .find((d) => /回收站|Trash/.test(d.textContent ?? "")) ?? null;
         };
         const dialog = await openDanger();
         const text = dialog?.innerText ?? "";
         [...(dialog?.querySelectorAll("button") ?? [])][0]?.click();
         await new Promise((r) => setTimeout(r, 500));
         const afterCancel = rowCount();
         const cancelClosed = !document.querySelector(".ws-rename[role=dialog]");
         const confirmed = await openDanger();
         [...(confirmed?.querySelectorAll("button") ?? [])]
           .find((b) => b.classList.contains("danger"))
           ?.click();
         await new Promise((r) => setTimeout(r, 1200));
         return {
           asked: Boolean(dialog),
           saysRecoverable: /回收站|Trash/.test(text),
           afterCancel,
           before,
           cancelClosed,
           afterConfirm: rowCount(),
         };
       })()`
    );
    if (railDelete.error) failures.push(`rail session delete: ${railDelete.error}`);
    check(railDelete.asked, "deleting a session from the rail asks first");
    check(
      railDelete.saysRecoverable,
      "the session delete explains that it goes to Trash and can be restored"
    );
    check(
      railDelete.cancelClosed && railDelete.afterCancel === railDelete.before,
      `cancelling the session delete removes nothing (${railDelete.before} → ${railDelete.afterCancel})`
    );
    check(
      railDelete.afterConfirm === railDelete.before - 1,
      `confirming the session delete removes exactly one row (${railDelete.before} → ${railDelete.afterConfirm})`
    );
  }

  // 5b-2. The rail's collapse control belongs to the brand row, at its right
  //       edge, not to the Workspaces heading. The collapsed rail keeps a way
  //       to expand it again.
  const collapseOps = await evaluate(
    cdp,
    `(async () => {
       const brandToggle = document.querySelector(".brand .sidebar-toggle");
       const headToggle = document.querySelector(".rail-head .sidebar-toggle");
       const brandRect = document.querySelector(".brand")?.getBoundingClientRect();
       const toggleRect = brandToggle?.getBoundingClientRect();
       const atRightEdge = Boolean(brandRect && toggleRect && brandRect.right - toggleRect.right < 12);
       brandToggle?.click();
       await new Promise((r) => setTimeout(r, 350));
       const collapsed = document.querySelector(".sidebar")?.classList.contains("collapsed") ?? false;
       const railWidth = document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
       const expandToggle = document.querySelector(".rail-head-collapsed .sidebar-toggle");
       expandToggle?.click();
       await new Promise((r) => setTimeout(r, 350));
       const expanded = !(document.querySelector(".sidebar")?.classList.contains("collapsed") ?? true);
       return {
         hasBrandToggle: Boolean(brandToggle),
         hasHeadToggle: Boolean(headToggle),
         atRightEdge,
         collapsed,
         railWidth,
         expanded,
       };
     })()`
  );
  check(
    collapseOps.hasBrandToggle && !collapseOps.hasHeadToggle && collapseOps.atRightEdge,
    "the collapse control sits at the brand row's right edge (not in the Workspaces heading)"
  );
  check(
    collapseOps.collapsed && collapseOps.railWidth <= 61 && collapseOps.expanded,
    `the rail collapses to icons (${Math.round(collapseOps.railWidth)}px) and expands back`
  );

  // FIXTURE-DATA ONLY (5c)
  if (!emptyMode) {
  }

  // 5c. Workspaces collapse, and each workspace has its own ··· menu.
  const groupOps = await evaluate(
    cdp,
    `(async () => {
       const find = () => [...document.querySelectorAll(".ws-group")]
         .find((g) => g.querySelector(".ws-group-name")?.textContent === "verify-alpha");
       if (!find()) return { error: "workspace 'verify-alpha' not in the rail" };
       const before = find().querySelectorAll(".ws-task-row").length;
       const toggle = find().querySelector(".ws-group-toggle");
       if (!toggle) return { error: "the workspace heading has no collapse toggle" };
       toggle.click();
       await new Promise((r) => setTimeout(r, 350));
       const collapsed = find().querySelectorAll(".ws-task-row").length;
       find().querySelector(".ws-group-toggle").click();
       await new Promise((r) => setTimeout(r, 350));
       const reopened = find().querySelectorAll(".ws-task-row").length;
       const groupMore = find().querySelector(".ws-group-more");
       if (!groupMore) return { error: "the workspace heading has no ··· button", before, collapsed, reopened };
       groupMore.click();
       await new Promise((r) => setTimeout(r, 300));
       const items = [...document.querySelectorAll(".ws-group-menu button")].map((b) => b.textContent.trim());
       window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
       await new Promise((r) => setTimeout(r, 200));
       return { before, collapsed, reopened, items, closed: !document.querySelector(".ws-group-menu") };
     })()`
  );
  if (groupOps.error) failures.push(`workspace collapse/menu: ${groupOps.error}`);
  check(groupOps.before > 0 && groupOps.collapsed === 0, `a workspace collapses (${groupOps.before} rows → ${groupOps.collapsed})`);
  check(groupOps.reopened === groupOps.before, `and expands back to ${groupOps.reopened} rows`);
  check(
    groupOps.items.length === 3 && groupOps.closed,
    `a workspace ··· menu offers ${groupOps.items.join(" / ")} and closes on Escape`
  );

  // FIXTURE-DATA ONLY (5d)
  if (!emptyMode) {
  }

  // 5d. A long workspace pages by ten per click.
  const paging = await evaluate(
    cdp,
    `(async () => {
       // "verify-bulk" holds 25 sessions: the only workspace where paging applies.
       const find = () => [...document.querySelectorAll(".ws-group")]
         .find((g) => g.querySelector(".ws-group-name")?.textContent === "verify-bulk");
       if (!find()) return [{ rows: -1, button: null }, { rows: -1 }, { rows: -1 }, { rows: -1 }];
       const snap = () => ({
         rows: find().querySelectorAll(".ws-task-row").length,
         button: find().querySelector(".ws-more")?.textContent?.trim() ?? null,
       });
       const steps = [snap()];
       for (let i = 0; i < 3; i += 1) {
         find().querySelector(".ws-more")?.click();
         await new Promise((r) => setTimeout(r, 300));
         steps.push(snap());
       }
       return steps;
     })()`
  );
  check(paging[0].rows === 6, `a long workspace opens with ${paging[0].rows} sessions`);
  check(paging[1].rows === 16, `the first "show more" adds ten (${paging[0].rows} → ${paging[1].rows})`);
  check(paging[2].rows === 25 && /收起/.test(paging[2].button ?? ""), `the second shows the remaining ${paging[2].rows}`);
  check(paging[3].rows === 6, `"collapse" returns to the first page (${paging[3].rows})`);

  }

  // 9g. The page check above must be able to see an error at all.
  //     It matches ErrorBox by its text, so prove that match works by planting
  //     one: an assertion that cannot fail is worse than no assertion.
  const errorProbe = await evaluate(
    cdp,
    `(async () => {
       const main = document.querySelector("main");
       if (!main) return { error: "no main element" };
       const probe = document.createElement("div");
       probe.className = "card";
       probe.textContent = "Error: planted probe";
       main.appendChild(probe);
       const seen = [...main.querySelectorAll(".card")]
         .map((c) => c.textContent.trim())
         .some((t) => t.startsWith("Error:"));
       probe.remove();
       const goneAfterRemoval = ![...main.querySelectorAll(".card")]
         .some((c) => c.textContent.includes("planted probe"));
       return { seen, goneAfterRemoval };
     })()`
  );
  if (errorProbe.error) failures.push(`error detection probe: ${errorProbe.error}`);
  check(errorProbe.seen === true, "the per-page error check can actually see an ErrorBox");
  check(errorProbe.goneAfterRemoval === true, "the planted probe was removed again");

  // FIXTURE-DATA ONLY (5f - needs two fixture tasks)
  if (!emptyMode) {
  // 5f. Switching tasks must not carry the previous task's state over.
  //     The id-scoped views are keyed on the id, so a switch remounts them; the
  //     observable effect is that a draft typed for one task does not appear in
  //     another (and comes back on its own when you return).
  const taskSwitch = await evaluate(
    cdp,
    `(async () => {
       const tasks = await (await fetch("/api/tasks")).json();
       const idA = "task_verify_1";
       const idB = "task_verify_2";
       if (!Array.isArray(tasks) || !tasks.some((t) => t.id === idA) || !tasks.some((t) => t.id === idB)) {
         return { error: "fixture tasks missing" };
       }
       const out = {};
       const goto = async (id) => {
         history.pushState({}, "", "/tasks/" + id);
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1800));
       };
       const composer = () => document.querySelector("main textarea");
       await goto(idA);
       const a = composer();
       if (!a) return { error: "no composer on the task page" };
       Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
         .set.call(a, "draft-on-A");
       a.dispatchEvent(new Event("input", { bubbles: true }));
       await new Promise((r) => setTimeout(r, 400));
       await goto(idB);
       const onB = composer()?.value ?? null;
       out.onB = onB;
       await goto(idA);
       const backOnA = composer()?.value ?? null;
       out.backOnA = backOnA;
       // Scroll behaviour, on the same switch: scroll the seeded long thread up,
       // leave, come back and switch away — the next task must open at its
       // newest message, not wherever the previous thread was left.
       const scroller = () => [...document.querySelectorAll("main *")]
         .find((el) => el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 120);
       const el = scroller();
       const scroll = { hasScroller: Boolean(el) };
       if (el) {
         el.scrollTop = 0;
         el.dispatchEvent(new Event("scroll", { bubbles: true }));
         await new Promise((r) => setTimeout(r, 400));
         scroll.parkedAtTop = Math.round(el.scrollTop) === 0;
         await goto(idB);
         const onB2 = scroller();
         scroll.bAtBottom = onB2 ? onB2.scrollHeight - onB2.scrollTop - onB2.clientHeight < 60 : null;
       }
       Object.assign(out, scroll);
       // Leave the fixture's storage clean for any later check.
       const last = composer();
       if (last) {
         Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(last, "");
         last.dispatchEvent(new Event("input", { bubbles: true }));
       }
       return out;
     })()`
  );
  if (taskSwitch.error) failures.push(`task switch isolation: ${taskSwitch.error}`);
  check(taskSwitch.onB === "", `a draft typed for one task does not appear in another (${JSON.stringify(taskSwitch.onB)})`);
  check(taskSwitch.backOnA === "draft-on-A", `and the original task still has its own draft (${JSON.stringify(taskSwitch.backOnA)})`);
  check(taskSwitch.hasScroller === true, "the seeded thread is long enough to scroll");
  check(
    taskSwitch.bAtBottom === true,
    `a thread scrolled up does not leave the next task parked at the top (${JSON.stringify(taskSwitch.bAtBottom)})`
  );

  // 5f2. A shell tool's row closes when that tool finished, not when the whole
  //      turn ends. The fixture's live run has one command that already
  //      reported `status: completed` and one that is still streaming: the
  //      first must be closed (no spinner, its result shown), the second must
  //      still spin. Before the fix both spun until the run ended.
  const commandRows = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/tasks/task_verify_live");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 2200));
       const row = (needle) => [...document.querySelectorAll(".activity.command")]
         .find((el) => (el.textContent ?? "").includes(needle));
       const finished = row("verify-finished-cmd");
       const open = row("verify-open-cmd");
       return {
         commands: document.querySelectorAll(".activity.command").length,
         finishedFound: Boolean(finished),
         finishedSpinning: finished ? Boolean(finished.querySelector(".spinner")) : null,
         finishedSummary: finished?.querySelector(".cmd-summary")?.textContent ?? null,
         openFound: Boolean(open),
         openSpinning: open ? Boolean(open.querySelector(".spinner")) : null,
         // The run is live, so the turn itself must still show it is working.
         turnWorking: Boolean(document.querySelector(".live-row .spinner")),
       };
     })()`
  );
  if (!commandRows.finishedFound || !commandRows.openFound) {
    failures.push(`command rows: ${JSON.stringify(commandRows)}`);
  }
  check(
    commandRows.finishedSpinning === false,
    `a finished command stops spinning while the turn is still live (${JSON.stringify(commandRows.finishedSpinning)})`
  );
  check(
    /3 passing/.test(commandRows.finishedSummary ?? ""),
    `the finished command shows its own result (${JSON.stringify(commandRows.finishedSummary)})`
  );
  check(
    commandRows.openSpinning === true,
    `a command that is still streaming keeps its spinner (${JSON.stringify(commandRows.openSpinning)})`
  );
  check(commandRows.turnWorking === true, "the live turn still reports that it is working");

  }

  // 5g. The Docker section says whether a containerized runtime can run at all.
  //     Without this a Project task just refuses, with no way to tell a missing
  //     Docker from a stopped one.
  const dockerUi = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/settings/docker");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 2200));
       const probe = await (await fetch("/api/settings/file")).status;
       const status = document.querySelector('[role=status]');
       const text = status?.innerText ?? "";
       const out = {
         panel: Boolean(document.querySelector(".settings-overlay")),
         text: text.slice(0, 160),
         // One of the four states must be named; a blank or generic line would
         // leave the user where they started.
         namesState: /Docker 可用|未安装 Docker|守护进程没有运行|无法确认 Docker|Docker is available|not installed|daemon is not running|could not be determined/.test(text),
         hasRecheck: [...(status?.querySelectorAll("button") ?? [])].some((b) => /重新检测|Re-check/.test(b.textContent)),
       };
       // The button must actually re-probe.
       const realFetch = window.fetch;
       let probed = 0;
       window.fetch = async (input, init) => {
         const url = typeof input === "string" ? input : input.url;
         if (url.includes("/api/docker/status")) probed += 1;
         return realFetch(input, init);
       };
       [...(status?.querySelectorAll("button") ?? [])][0]?.click();
       await new Promise((r) => setTimeout(r, 2500));
       window.fetch = realFetch;
       out.reprobed = probed >= 1;
       return out;
     })()`
  );
  check(dockerUi.panel === true && dockerUi.namesState === true, `the Docker section reports a real state (${JSON.stringify(dockerUi.text.slice(0, 80))})`);
  check(dockerUi.hasRecheck === true && dockerUi.reprobed === true, "Re-check actually probes the daemon again");

  // 5h. Empty data: the very first screen of a fresh install.
  //     Skipped in fixture mode, where the data exists by construction.
  if (emptyMode) {
    const empty = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/tasks");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1600));
         const main = () => document.querySelector("main");
         const text = () => main()?.innerText ?? "";
         const out = {
           tasksText: text().slice(0, 300),
           railText: document.querySelector(".rail-scroll")?.innerText ?? "",
           railGroups: document.querySelectorAll(".ws-group").length,
           taskRows: document.querySelectorAll(".ws-task-row").length,
           errors: [...document.querySelectorAll("main .card")]
             .map((c) => c.textContent.trim())
             .filter((t) => t.startsWith("Error:")),
         };
         // Every other page must also open clean on an empty install.
         const pages = ["/runs", "/projects", "/runtimes", "/sessions", "/handoffs", "/usage", "/kanban", "/trash"];
         out.pageErrors = [];
         for (const p of pages) {
           history.pushState({}, "", p);
           window.dispatchEvent(new PopStateEvent("popstate"));
           await new Promise((r) => setTimeout(r, 900));
           const errs = [...document.querySelectorAll("main .card")]
             .map((c) => c.textContent.trim())
             .filter((t) => t.startsWith("Error:"));
           if (errs.length) out.pageErrors.push(p + ": " + errs[0].slice(0, 60));
           if (!document.querySelector("main h1")) out.pageErrors.push(p + ": no heading");
         }
         return out;
       })()`
    );
    check(empty.taskRows === 0, `an empty install has no session rows (${empty.taskRows})`);
    check(
      /没有|no |No |尚未|还没有/i.test(empty.railText) || empty.railGroups === 0,
      `the empty rail explains itself instead of showing a blank list (${JSON.stringify(empty.railText.slice(0, 60))})`
    );
    check(empty.errors.length === 0, `the empty task list shows no error (${empty.errors[0] ?? "none"})`);
    check(
      empty.pageErrors.length === 0,
      `every page opens clean on an empty install (${empty.pageErrors.join("; ") || "none"})`
    );

    // The first-use path has to be walkable: the composer is blocked (no
    // workspace) and the way out is the rail's Workspaces + button — workspace
    // creation does not live inside the task composer any more.
    const firstUse = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/new");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1800));
         const sendBtn = [...document.querySelectorAll("main button")]
           .find((b) => b.className.includes("send"));
         // Found by structure, not wording: the UI is bilingual.
         const hint = [...document.querySelectorAll("main .card")]
           .map((c) => c.textContent.trim())
           .find((t) => /工作区|workspace/i.test(t)) ?? "";
         const inlineAdd = [...document.querySelectorAll("main button")]
           .some((b) => /新建工作区|New workspace/.test(b.textContent));
         const headIcons = [...document.querySelectorAll(".rail-head-actions .icon-btn")];
         const railAdd = headIcons[headIcons.length - 1];
         const out = {
           sendDisabled: sendBtn ? sendBtn.disabled : null,
           hintText: hint,
           hintMentionsWorkspace: /工作区|workspace/i.test(hint),
           hasInlineAdd: inlineAdd,
           hasRailAdd: Boolean(railAdd),
           dialogOpen: false,
           nativeBridge: typeof window.agentfabric?.pickDirectory === "function",
           nativeBrowse: false,
         };
         if (railAdd) {
           railAdd.click();
           await new Promise((r) => setTimeout(r, 500));
           out.dialogOpen = Boolean(document.querySelector(".add-workspace-dialog"));
           out.nativeBrowse = Boolean(document.querySelector(".add-workspace-dialog .dir-input-browse"));
           document.querySelector(".add-workspace-dialog .board-dialog-close")?.click();
           await new Promise((r) => setTimeout(r, 300));
         }
         return out;
       })()`
    );
    check(firstUse.sendDisabled === true, "a fresh install blocks the composer until a workspace exists");
    check(
      firstUse.hintMentionsWorkspace === true,
      `the block message names the missing thing (${JSON.stringify((firstUse.hintText ?? "").slice(0, 60))})`
    );
    check(firstUse.hasInlineAdd === false, "the New Task composer has no inline workspace creation");
    check(firstUse.hasRailAdd === true, "the Workspaces header carries the new-workspace entry point");
    check(firstUse.dialogOpen === true, "clicking it opens the workspace form");
    check(firstUse.nativeBridge === true, "the packaged window exposes the native directory bridge");
    check(firstUse.nativeBrowse === false, "the workspace form has no separate browse button");

    // Adding the workspace must clear the gate, and the runtime pill must offer
    // the host harnesses: the isolation gate that used to hide them is gone —
    // a workspace is a directory, and any runtime may work on it.
    const firstWorkspace = join(dataDir, "first-workspace");
    mkdirSync(firstWorkspace, { recursive: true });
    const createdViaRail = await evaluate(
      cdp,
      `(async () => {
         const headIcons = [...document.querySelectorAll(".rail-head-actions .icon-btn")];
         headIcons[headIcons.length - 1]?.click();
         await new Promise((r) => setTimeout(r, 500));
         const dialog = document.querySelector(".add-workspace-dialog");
         if (!dialog) return { error: "the rail did not open the workspace dialog" };
         const input = dialog.querySelector(".dir-input-text");
         if (!input) return { error: "the dialog has no directory field" };
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
         setter.call(input, ${JSON.stringify(firstWorkspace)});
         input.dispatchEvent(new Event("input", { bubbles: true }));
         await new Promise((r) => setTimeout(r, 400));
         [...dialog.querySelectorAll("footer button")]
           .find((b) => b.classList.contains("primary"))
           ?.click();
         await new Promise((r) => setTimeout(r, 1800));
         return {
           dialogClosed: !document.querySelector(".add-workspace-dialog"),
           groups: [...document.querySelectorAll(".ws-group-name")].map((n) => n.textContent.trim()),
         };
       })()`
    );
    check(createdViaRail.dialogClosed === true, "the rail dialog adds the workspace and closes");
    check(
      (createdViaRail.groups ?? []).includes("first-workspace"),
      `the new empty workspace appears in the rail (${(createdViaRail.groups ?? []).join(", ") || "none"})`
    );
    const afterWorkspace = await evaluate(
      cdp,
      `(async () => {
         // Leave and come back so the composer re-reads the workspace list: the
         // GET cache lives 5s, and the workspace was created a moment ago.
         history.pushState({}, "", "/tasks");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 5200));
         history.pushState({}, "", "/new");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 2200));
         const gate = [...document.querySelectorAll("main .card")]
           .map((c) => c.textContent.trim())
           .find((t) => /工作区|workspace/i.test(t)) ?? "";
         const pills = [...document.querySelectorAll("main select.pill")]
           .map((s) => [...s.options].map((o) => o.textContent).join(" | "));
         return { gate, pills: pills.join(" ‖ ") };
       })()`
    );
    check(afterWorkspace.gate === "", `the workspace gate disappears once one exists (${JSON.stringify((afterWorkspace.gate ?? "").slice(0, 60))})`);
    check(
      /运行时|Runtime/.test(afterWorkspace.pills ?? ""),
      `the runtime pill is on screen (${JSON.stringify((afterWorkspace.pills ?? "").slice(0, 80))})`
    );
    check(
      /Codex|Claude|DSH|Pi|OpenCode/i.test(afterWorkspace.pills ?? ""),
      `host harnesses are selectable as runtimes — no isolation gate (${JSON.stringify((afterWorkspace.pills ?? "").slice(0, 80))})`
    );
  }

  // 6. The "More" panel reaches the pages that have no nav row.
  const more = await evaluate(
    cdp,
    `(async () => {
       const trigger = document.querySelector(".rail-menu-trigger");
       trigger?.click();
       await new Promise((r) => setTimeout(r, 400));
       const menu = document.querySelector(".rail-menu");
       const items = menu ? [...menu.querySelectorAll(".rail-menu-item")].map((b) => b.textContent.trim()) : [];
       const rect = menu?.getBoundingClientRect();
       const onScreen = rect ? rect.width > 120 && rect.right <= window.innerWidth + 1 && rect.left >= -1 : false;
       return { items, onScreen };
     })()`
  );
  check(more.items.length >= 6, `rail menu lists ${more.items.length} entries: ${more.items.join(", ")}`);
  check(more.onScreen, "the rail menu is fully on screen");

  // 7. Settings opens with its sections, and credentials live there.
  const settings = await evaluate(
    cdp,
    `(async () => {
       const item = [...document.querySelectorAll(".rail-menu-item")].find((b) => /设置|Settings/i.test(b.textContent));
       item?.click();
       await new Promise((r) => setTimeout(r, 1200));
       const sections = [...document.querySelectorAll(".settings-nav-cell")].map((b) => b.textContent.trim());
       const panel = Boolean(document.querySelector(".settings-panel"));
       const trashNav = [...document.querySelectorAll(".settings-nav-cell")]
         .find((b) => /回收站|Trash/i.test(b.textContent));
       if (trashNav) {
         trashNav.click();
         await new Promise((r) => setTimeout(r, 800));
       }
       const trashTitle = document.querySelector(".settings-page-title")?.textContent?.trim() ?? null;
       const trashRows = document.querySelectorAll(".settings-body .task-item").length;
       // The credentials page is a settings section now; visit it by URL.
       history.pushState({}, "", "/settings/credentials");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1000));
       return {
         panel,
         sections,
         trashNav: Boolean(trashNav),
         trashTitle,
         trashRows,
         credentialsHeading: document.querySelector(".settings-page-title")?.textContent?.trim() ?? null,
         hasAddButton: [...document.querySelectorAll(".settings-panel button")].some((b) => /Add credential|新增凭据|添加/i.test(b.textContent)),
       };
     })()`
  );
  check(settings.panel, `settings panel opens with ${settings.sections.length} sections: ${settings.sections.join(", ")}`);
  check(!settings.sections.some((s) => /凭据|credential/i.test(s)), `source credentials are gone from settings (${settings.sections.join(", ")})`);
  check(
    settings.trashNav && /回收站|Trash/i.test(settings.trashTitle ?? ""),
    `Trash opens inside Settings (${JSON.stringify(settings.trashTitle)})`
  );

  // 7b. The Harness CLI page shows what detection found on this machine — the
  //     whole point of the page: the app's PATH is launchd's, so a CLI installed
  //     by npm/bun/nvm/Homebrew is invisible to `which` and the board used to
  //     report "no agent CLI installed" on a machine full of them.
  const harnessPage = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/settings/harness");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 2500));
       return {
         // One line under each CLI field: its resolved path + version, or "not found".
         states: [...document.querySelectorAll(".settings-page .settings-field-hint")]
           .map((el) => (el.textContent ?? "").trim())
           .filter(Boolean),
         recheck: [...document.querySelectorAll(".settings-body button")]
           .some((b) => /重新检测|Detect again/.test(b.textContent)),
       };
     })()`
  );
  check(
    harnessPage.states.length >= 3,
    `the Harness CLI page reports detection for ${harnessPage.states.length} CLI(s): ${harnessPage.states.slice(0, 3).join(" | ")}`
  );
  check(harnessPage.recheck, "the Harness CLI page can detect again");

  // 8. Language switch: the shell and the rail both follow it.
  //    The switch lives in Settings → General (a segmented control), not in the
  //    brand row — the toolbar keeps only the controls for the rail itself.
  const language = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/settings/general");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 800));
       const before = { lang: document.documentElement.lang, heading: document.querySelector(".settings-nav-title")?.textContent?.trim() };
       const group = document.querySelector(".settings-segmented");
       const options = group ? [...group.querySelectorAll("button")] : [];
       const other = options.find((b) => b.getAttribute("aria-pressed") !== "true");
       other?.click();
       await new Promise((r) => setTimeout(r, 900));
       const switched = { lang: document.documentElement.lang };
       // Back to the task list: the rail's own labels must follow too.
       history.pushState({}, "", "/tasks");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 800));
       return {
         before,
         after: {
           lang: switched.lang,
           heading: document.querySelector(".settings-nav-title")?.textContent?.trim(),
           rail: document.querySelector(".rail-head-title")?.textContent?.trim(),
         },
       };
     })()`
  );
  check(language.after.lang !== language.before.lang, `language switches: ${language.before.lang} → ${language.after.lang}`);
  check(
    language.after.heading !== language.before.heading && /Workspaces|工作区/.test(language.after.rail ?? ""),
    `dictionary follows the switch ("${language.before.heading}" → "${language.after.heading}", rail "${language.after.rail}")`
  );

  // 9. Removed things stay removed, and the home URL still works.
  const home = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1000));
       const chunks = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /assets\\/.*\\.js/.test(n));
       return {
         path: location.pathname,
         heading: document.querySelector("h1")?.textContent?.trim(),
         dashboardChunkLoaded: chunks.some((n) => /Dashboard/i.test(n)),
         settingsClosed: !document.querySelector(".settings-panel"),
       };
     })()`
  );
  check(home.path === "/", `"/" is still a valid URL (landed on "${home.heading}")`);
  check(!home.dashboardChunkLoaded, "no Dashboard chunk is loaded");
  check(home.settingsClosed, "navigating away closes the settings panel");

  // 9b. Every page renders inside the packaged app. A page that throws or
  //     never paints is invisible to a check that only visits the rail, and it
  //     is the most common way a build ships a broken screen.
  const pages = [
    ["/tasks", "Tasks"],
    ["/runs", "Runs"],
    ["/usage", "Usage"],
    ["/handoffs", "Handoffs"],
    ["/projects", "Projects"],
    ["/runtimes", "Runtimes"],
    ["/sessions", "Native sessions"],
    ["/trash", "Deleted tasks"],
    ["/kanban", "Board"],
  ];
  for (const [path, label] of pages) {
    const verdict = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", ${JSON.stringify(path)});
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1200));
         const main = document.querySelector("main");
         return {
           heading: main?.querySelector("h1")?.textContent?.trim() ?? null,
           textLen: (main?.innerText ?? "").length,
           // ErrorBox renders a red-bordered .card, not an .error-box, and has no
           // ARIA role: match its text so this check cannot pass vacuously.
           errorText: [...document.querySelectorAll("main .card")]
             .map((c) => c.textContent.trim())
             .find((t) => t.startsWith("Error:"))?.slice(0, 80) ?? null,
         };
       })()`
    );
    check(
      verdict.heading !== null && verdict.textLen > 40 && !verdict.errorText,
      `${label} renders (${verdict.heading ?? "no heading"}, ${verdict.textLen} chars${verdict.errorText ? `, error: ${verdict.errorText}` : ""})`
    );
  }

  // FIXTURE-DATA ONLY (9b-1 - needs the seeded runs)
  if (!emptyMode) {
    // 9b-1. Run phases are shown as words, not as their stored identifiers.
    //       `agent.running` / `workspace.preparing` are record values; printing
    //       one verbatim put the only untranslated, dotted label in the app.
    const phaseLabels = await evaluate(
      cdp,
      `(async () => {
         const phaseColumnIndex = (root) => {
           const header = [...root.querySelectorAll("thead th")].map((th) => th.textContent.trim());
           const zh = header.indexOf("阶段");
           return zh >= 0 ? zh : header.indexOf("Phase");
         };
         history.pushState({}, "", "/runs");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1200));
         const column = phaseColumnIndex(document.querySelector("main"));
         const cells = [...document.querySelectorAll("main tbody tr")].map((tr) =>
           (tr.children[column]?.textContent ?? "").trim()
         );
         // A stored phase printed verbatim is the failure this check exists for:
         // a dotted, lowercase identifier in a cell of its own.
         const raw = [...document.querySelectorAll("main tbody td")].map((td) => td.textContent.trim())
           .filter((text) => /^[a-z]+\\.[a-z]+$/.test(text));
         // The inspector renders the same value as a stat of its own.
         history.pushState({}, "", "/runs/run_verify_live");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1200));
         const stats = [...document.querySelectorAll("main .stat")].map((s) => ({
           label: s.querySelector(".lbl")?.textContent?.trim(),
           value: s.querySelector(".num")?.textContent?.trim(),
         }));
         const phaseStat = stats.find((s) => s.label === "当前阶段" || s.label === "current phase");
         return {
           hasPhaseColumn: column >= 0,
           cells,
           rawIdentifiers: raw,
           phaseStat: phaseStat?.value ?? null,
         };
       })()`
    );
    check(
      phaseLabels.hasPhaseColumn && phaseLabels.cells.length > 0,
      `the runs table has a phase column (${phaseLabels.cells.slice(0, 3).join(" | ")})`
    );
    check(
      phaseLabels.rawIdentifiers.length === 0,
      `no run phase is printed as a raw identifier (${phaseLabels.rawIdentifiers.join(", ") || "none"})`
    );
    check(
      Boolean(phaseLabels.phaseStat) &&
        phaseLabels.phaseStat !== "agent.running" &&
        phaseLabels.phaseStat !== "undefined",
      `the run inspector labels the current phase ("${phaseLabels.phaseStat}")`
    );

    // 9b-1b. The runs list can be narrowed by status, and it keeps refreshing
    //        while anything is still executing. Executions accumulate for the
    //        life of the install, so "the run I just started" and "what failed"
    //        used to mean scrolling the whole history.
    const runsFilters = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/runs");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1600));
         const chips = () => [...document.querySelectorAll(".runs-filter")];
         const rows = () => document.querySelectorAll("main tbody tr").length;
         const before = rows();
         const labels = chips().map((b) => b.textContent.trim());
         const counts = chips().map((b) => Number(b.querySelector(".runs-filter-count")?.textContent ?? NaN));
         const go = async (nth) => {
           chips()[nth]?.click();
           await new Promise((r) => setTimeout(r, 400));
           return rows();
         };
         const completed = await go(3);
         const failed = await go(2);
         const all = await go(0);
         return {
           chipCount: chips().length,
           labels,
           counts,
           firstPressed: chips()[0]?.getAttribute("aria-pressed") ?? null,
           live: document.querySelector(".runs-live")?.textContent?.trim() ?? null,
           before,
           completed,
           failed,
           all,
         };
       })()`
    );
    check(
      runsFilters.chipCount === 4 && runsFilters.firstPressed === "true",
      `the runs list offers status filters (${runsFilters.labels.join(" | ")})`
    );
    check(
      runsFilters.counts.every((n) => Number.isFinite(n)) &&
        runsFilters.counts[0] === runsFilters.before,
      `each filter carries its row count (${runsFilters.counts.join(" / ")})`
    );
    check(
      runsFilters.completed <= runsFilters.before &&
        runsFilters.failed <= runsFilters.before &&
        runsFilters.all === runsFilters.before,
      `filtering narrows the table and "all" restores it (all ${runsFilters.before} → completed ${runsFilters.completed} → failed ${runsFilters.failed} → all ${runsFilters.all})`
    );
    check(
      /条正在执行|running/.test(runsFilters.live ?? ""),
      `the runs list says it is live while something runs (${JSON.stringify(runsFilters.live)})`
    );
  }

  // FIXTURE-DATA ONLY (9b-1c - needs a failed run and an artifact)
  if (!emptyMode) {
    // 9b-1c. The inspector answers the question it is opened for. A failed run's
    //        reason used to be a bare string in the same red box as every load
    //        error; an artifact row printed four cells and did nothing; a handoff
    //        dumped the stored JSON. All three now lead somewhere.
    const inspector = await evaluate(
      cdp,
      `(async () => {
         const run = (await (await fetch("/api/runs")).json())
           .find((r) => r.id === "run_verify_failed" && r.error);
         if (!run) return { error: "no failed run in the fixture" };
         history.pushState({}, "", "/runs/" + run.id);
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1800));
         const card = document.querySelector(".run-error");
         const out = {
           errorTitle: card?.querySelector(".run-error-title")?.textContent?.trim() ?? null,
           errorActions: [...(card?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()),
         };
         const tab = (label) =>
           [...document.querySelectorAll("main button")]
             .find((b) => new RegExp(label, "i").test(b.textContent ?? ""));
         tab("产物|artifacts")?.click();
         await new Promise((r) => setTimeout(r, 700));
         const rows = [...document.querySelectorAll("main tbody tr")];
         out.artifactRows = rows.length;
         const openBtn = rows.flatMap((tr) => [...tr.querySelectorAll("button")])
           .find((b) => /打开|Open/.test(b?.textContent ?? ""));
         const downloadLink = rows
           .flatMap((tr) => [...tr.querySelectorAll("a")])
           .find((a) => /下载|Download/.test(a.textContent ?? ""));
         out.hasDownloadHref = Boolean(downloadLink?.getAttribute("href"));
         openBtn?.click();
         await new Promise((r) => setTimeout(r, 600));
         const modal = document.querySelector(".modal");
         out.previewOpen = Boolean(modal);
         out.previewText = (modal?.innerText ?? "").slice(0, 60);
         modal?.querySelector("button")?.click();
         await new Promise((r) => setTimeout(r, 400));
         tab("连续|continuity")?.click();
         await new Promise((r) => setTimeout(r, 600));
         out.handoffSections = [...document.querySelectorAll(".handoff-body h3")].map((h) =>
           h.textContent.trim()
         );
         return out;
       })()`
    );
    if (inspector.error) failures.push(`run inspector: ${inspector.error}`);
    check(
      /为什么失败|Why this run failed/.test(inspector.errorTitle ?? "") &&
        (inspector.errorActions ?? []).length === 2,
      `a failed run names its reason and offers its log and events (${inspector.errorTitle} / ${(inspector.errorActions ?? []).join(", ")})`
    );
    check(
      inspector.artifactRows > 0 &&
        inspector.hasDownloadHref &&
        inspector.previewOpen &&
        /产物内容|Artifact content/.test(inspector.previewText ?? ""),
      `an artifact opens a preview and offers a download (${inspector.artifactRows} row(s), "${inspector.previewText}")`
    );
    check(
      (inspector.handoffSections ?? []).length > 0 &&
        !(inspector.handoffSections ?? []).some((s) => s.includes("{")),
      `a handoff shows its sections instead of raw JSON (${(inspector.handoffSections ?? []).join(" | ")})`
    );
  }

  // 9b-1d. Usage: money reads as money, and the heatmap's window is a choice
  //        rather than a hard-coded 26 weeks.
  const usage = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/usage");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1600));
       const ranges = [...document.querySelectorAll(".heat-range button")];
       const out = {
         costTiles: [...document.querySelectorAll(".stat")]
           .filter((s) => /预估费用|estimated/i.test(s.innerText))
           .map((s) => s.querySelector(".num")?.textContent?.trim()),
         ranges: ranges.map((b) => b.textContent.trim()),
         pressedIndex: ranges.findIndex((b) => b.getAttribute("aria-pressed") === "true"),
       };
       const cols = () => {
         const style = document.querySelector(".heat-grid")?.style.gridTemplateColumns ?? "";
         const n = Number(/repeat\\((\\d+)\\b/.exec(style)?.[1] ?? 0);
         return n;
       };
       out.colsBefore = cols();
       ranges[0]?.click();
       await new Promise((r) => setTimeout(r, 400));
       out.colsAfter = cols();
       ranges[ranges.length - 1]?.click();
       await new Promise((r) => setTimeout(r, 400));
       out.colsWidest = cols();
       return out;
     })()`
  );
  check(
    (usage.costTiles ?? []).length > 0 && (usage.costTiles ?? []).every((c) => !/0{6}/.test(c ?? "")),
    `usage prints money without six zeroes (${(usage.costTiles ?? []).join(", ")})`
  );
  check(
    (usage.ranges ?? []).length === 4 && usage.pressedIndex === 2,
    `the heatmap offers a time window and defaults to 26 weeks (${(usage.ranges ?? []).join(" / ")})`
  );
  check(
    usage.colsAfter === 4 && usage.colsWidest === 52 && usage.colsBefore === 26,
    `choosing a window resizes the heatmap (${usage.colsAfter} / ${usage.colsBefore} / ${usage.colsWidest} columns)`
  );

  // FIXTURE-DATA ONLY (9b-1e - needs a runtime row to delete)
  if (!emptyMode) {
    // 9b-1e. Deleting a row on a resource page names the row and reports a
    //        failure. The question used to read "Delete rt_mvven…?" (the id),
    //        and a rejected DELETE was an unhandled rejection: the row stayed
    //        put with nothing said.
    const resourceDelete = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/runtimes");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1600));
         const row = document.querySelector("main tbody tr");
         const name = row?.querySelector("td")?.getAttribute("title") ?? row?.querySelector("td")?.textContent ?? "";
         const del = [...(row?.querySelectorAll("button") ?? [])].find((b) => b.classList.contains("danger"));
         del?.click();
         await new Promise((r) => setTimeout(r, 600));
         const modal = document.querySelector(".modal");
         const question = modal?.querySelector("p")?.textContent?.trim() ?? "";
         const out = { question, hasRawId: /rt_[a-z0-9]{12,}/.test(question) };
         modal?.querySelector("button")?.click();
         await new Promise((r) => setTimeout(r, 400));
         const originalFetch = window.fetch;
         window.fetch = (input, init) => {
           const url = typeof input === "string" ? input : input?.url ?? "";
           if (url.includes("/api/runtimes/") && (init?.method ?? "GET").toUpperCase() === "DELETE") {
             return Promise.reject(new Error("verify: simulated failure"));
           }
           return originalFetch(input, init);
         };
         try {
           del?.click();
           await new Promise((r) => setTimeout(r, 600));
           const again = document.querySelector(".modal");
           [...(again?.querySelectorAll("button") ?? [])]
             .find((b) => /删除|Delete/.test(b.textContent ?? "") && b.classList.contains("danger"))
             ?.click();
           await new Promise((r) => setTimeout(r, 1000));
           const banner = document.querySelector(".action-error");
           out.banner = banner?.getAttribute("role") === "alert" ? (banner.textContent ?? "").trim() : null;
         } finally {
           window.fetch = originalFetch;
           document.querySelector(".action-error button")?.click();
         }
         return out;
       })()`
    );
    check(
      /删除|Delete/.test(resourceDelete.question ?? "") && resourceDelete.hasRawId === false,
      `deleting a resource names the row, not its id (${JSON.stringify(resourceDelete.question)})`
    );
    check(
      /没有成功|did not go through/.test(resourceDelete.banner ?? ""),
      `a failed resource delete is reported (${JSON.stringify(resourceDelete.banner)})`
    );
  }

  // 9b-1f. A list never claims to be empty while it is still loading. The first
  //        render of every list is empty, so the empty-state text was shown
  //        during the fetch — briefly on a fast response, and indefinitely on a
  //        slow one.
  const loadingState = await evaluate(
    cdp,
    `(async () => {
       const originalFetch = window.fetch;
       const release = [];
       window.fetch = (input, init) => {
         const url = typeof input === "string" ? input : input?.url ?? "";
         if (url.includes("/api/handoffs") && !url.includes("/api/handoffs/model")) {
           return new Promise((resolve) => release.push(() => resolve(originalFetch(input, init))));
         }
         return originalFetch(input, init);
       };
       const out = {};
       try {
         // Leave first: remounting a view it is already on can be served from
         // the GET cache without a request, and then nothing is pending at all.
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1200));
         history.pushState({}, "", "/handoffs");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1200));
         const text = document.querySelector("main")?.innerText ?? "";
         out.loadingText = text.includes("加载中") || text.includes("Loading");
         out.claimsEmpty = /还没有|No handoffs/.test(text);
       } finally {
         window.fetch = originalFetch;
         release.forEach((fn) => fn());
       }
       return out;
     })()`
  );
  check(
    loadingState.loadingText === true && loadingState.claimsEmpty === false,
    `a list says it is loading instead of claiming to be empty (loading: ${loadingState.loadingText}, claims empty: ${loadingState.claimsEmpty})`
  );

  // FIXTURE-DATA ONLY (9b-1g - deletes rows it creates itself)
  if (!emptyMode) {
    await createThrowawayTask(cdp, "verify skip-confirm A");
    await createThrowawayTask(cdp, "verify skip-confirm B");
    // The list is open on whichever page the previous check left; reload it so
    // the new rows are on page 1.
    await evaluate(cdp, `(async () => {
      window.dispatchEvent(new Event("agentfabric:tasks-changed"));
      await new Promise((r) => setTimeout(r, 600));
      return true;
    })()`);
    // 9b-1g. "Don't ask again" is a preference, not a one-way door: the list
    //        shows it, says when a delete went through unchecked, and offers
    //        to turn the asking back on.
    const skipConfirm = await evaluate(
      cdp,
      `(async () => {
         const KEY = "agentfabric.deleteTaskConfirmSuppressed";
         localStorage.removeItem(KEY);
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 900));
         history.pushState({}, "", "/tasks");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1600));
         const pref = () => document.querySelector(".tasks-pref input");
         const out = { prefShown: Boolean(pref()), prefOffAtStart: pref()?.checked === false };
         pref()?.click();
         await new Promise((r) => setTimeout(r, 400));
         out.prefOn = pref()?.checked === true && localStorage.getItem(KEY) === "1";
         // The rows deleted here are created for this check: later checks read
         // the fixture's own tasks.
         const byTitle = (t) => [...document.querySelectorAll(".task-item")]
           .find((r) => (r.querySelector(".task-item-title")?.textContent ?? "").trim() === t);
         const target = byTitle("verify skip-confirm A");
         out.found = Boolean(target);
         const title = (target?.querySelector(".task-item-title")?.textContent ?? "").trim();
         [...(target?.querySelectorAll("button") ?? [])].pop()?.click();
         await new Promise((r) => setTimeout(r, 500));
         const items = [...document.querySelectorAll("button")]
           .filter((b) => /删除|Delete/.test(b.textContent ?? ""));
         items[items.length - 1]?.click();
         await new Promise((r) => setTimeout(r, 1200));
         const notice = document.querySelector(".action-error");
         out.notice = notice?.innerText ?? null;
         out.saidDeleted = Boolean(title) && (notice?.innerText ?? "").includes(title);
         const undo = [...(notice?.querySelectorAll("button") ?? [])]
           .find((b) => /以后都询问|Ask me again/.test(b.textContent ?? ""));
         undo?.click();
         await new Promise((r) => setTimeout(r, 500));
         out.undone = pref()?.checked === false && localStorage.getItem(KEY) === null;
         // Turned back on: the next delete asks again.
         const next = byTitle("verify skip-confirm B");
         [...(next?.querySelectorAll("button") ?? [])].pop()?.click();
         await new Promise((r) => setTimeout(r, 500));
         const again = [...document.querySelectorAll("button")]
           .filter((b) => /删除|Delete/.test(b.textContent ?? ""));
         again[again.length - 1]?.click();
         await new Promise((r) => setTimeout(r, 700));
         out.asksAgain = Boolean(document.querySelector(".delete-confirm"));
         document.querySelector(".delete-confirm")?.parentElement?.querySelector("button")?.click();
         await new Promise((r) => setTimeout(r, 300));
         localStorage.removeItem(KEY);
         return out;
       })()`
    );
    check(
      skipConfirm.prefShown === true && skipConfirm.prefOffAtStart === true && skipConfirm.prefOn === true,
      `the task list exposes the skip-confirmation preference and remembers it (shown: ${skipConfirm.prefShown}, off at start: ${skipConfirm.prefOffAtStart}, on: ${skipConfirm.prefOn})`
    );
    check(
      skipConfirm.saidDeleted === true && /没有|without/i.test(skipConfirm.notice ?? ""),
      `a delete that skipped the dialog says so (${JSON.stringify((skipConfirm.notice ?? "").slice(0, 40))})`
    );
    check(
      skipConfirm.undone === true && skipConfirm.asksAgain === true,
      `turning the preference back off restores the confirmation (cleared: ${skipConfirm.undone}, asks again: ${skipConfirm.asksAgain})`
    );
  }

  // 9b-1h. In-app links are links: focusable by keyboard, with a real href, and
  //        a modified click left to the browser (open in new tab still works).
  const links = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/kanban");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 900));
       history.pushState({}, "", "/runs");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1600));
       const anchors = [...document.querySelectorAll("main a")];
       const hrefs = anchors.map((a) => a.getAttribute("href"));
       const out = {
         total: anchors.length,
         withHref: hrefs.filter((h) => h && h.startsWith("/")).length,
         noHref: hrefs.filter((h) => !h).length,
         // A link with no href is skipped by the tab order; one with an href is not.
         focusable: anchors.filter((a) => a.hasAttribute("href") && a.tabIndex >= 0).length,
       };
       // Enter on a focused in-app link navigates through the router.
       const first = anchors.find((a) => a.getAttribute("href")?.startsWith("/runs/"));
       const before = location.pathname;
       first?.focus();
       if (first) {
         first.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
         await new Promise((r) => setTimeout(r, 800));
       }
       out.navigated = Boolean(first) && location.pathname !== before;
       // A Cmd-click must reach the browser (new tab), not the router.
       history.pushState({}, "", "/runs");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1200));
       const link = [...document.querySelectorAll("main a")].find((a) => a.getAttribute("href")?.startsWith("/runs/"));
       let defaultPrevented = null;
       if (link) {
         const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
         link.dispatchEvent(ev);
         defaultPrevented = ev.defaultPrevented;
       }
       out.metaClickFree = defaultPrevented === false;
       return out;
     })()`
  );
  // An empty list that names a next step links to it. Only an install with no
  // runs renders that state, so this runs in empty mode.
  if (emptyMode) {
    const emptyHint = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 900));
         history.pushState({}, "", "/runs");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1600));
         const main = document.querySelector("main");
         const link = [...(main?.querySelectorAll("a[href]") ?? [])]
           .find((a) => a.getAttribute("href") === "/tasks");
         return {
           hint: (main?.innerText ?? "").slice(0, 200),
           hasTasksLink: Boolean(link),
         };
       })()`
    );
    check(
      emptyHint.hasTasksLink === true,
      `an empty run list links to where runs are created (${emptyHint.hasTasksLink})`
    );
  }

  // 9b-1o. Every data table can scroll instead of overflowing its card when the
  //        window is narrow. Only one table used to sit in a `.table-wrap`; the
  //        rest pushed the card wider than the page.
  const tableWraps = await evaluate(
    cdp,
    `(async () => {
       const unwrapped = [];
       const count = (path) => {
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         return new Promise((r) => setTimeout(r, 900))
           .then(() => {
             history.pushState({}, "", path);
             window.dispatchEvent(new PopStateEvent("popstate"));
             return new Promise((r) => setTimeout(r, 1500));
           })
           .then(() => {
             for (const table of document.querySelectorAll("main table")) {
               if (!table.closest(".table-wrap")) unwrapped.push(path + ": " + (table.textContent ?? "").trim().slice(0, 30));
             }
             return document.querySelectorAll("main table").length;
           });
       };
       const counts = {
         runs: await count("/runs"),
         handoffs: await count("/handoffs"),
         usage: await count("/usage"),
         runtimes: await count("/runtimes"),
       };
       return { unwrapped, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
     })()`
  );
  // 9b-1s. Adding a runtime is a dialog with two choices, and the table has no
  //        per-record "usable in tasks" switch: a task is the unit of work and
  //        a runtime is how it runs, so that question is not the user's.
  const runtimeDialog = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/runtimes");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1600));
       const headers = [...document.querySelectorAll("main thead th")]
         .map((h) => (h.textContent ?? "").trim())
         .filter(Boolean);
       const addBtn = [...document.querySelectorAll("main button")]
         .find((b) => /新增|add/i.test(b.textContent ?? "") && !b.closest(".board-dialog"));
       addBtn?.click();
       await new Promise((r) => setTimeout(r, 800));
       const dialog = document.querySelector(".add-runtime-dialog");
       const labels = [...(dialog?.querySelectorAll(".board-dialog-label") ?? [])]
         .map((l) => (l.textContent ?? "").trim());
       const modes = [...(dialog?.querySelectorAll(".runtime-mode-card") ?? [])]
         .map((c) => (c.textContent ?? "").trim());
       const out = {
         opened: Boolean(dialog),
         inlineCard: [...document.querySelectorAll("main .card h2")]
           .some((h) => /新增.*运行时|Add runtime/.test(h.textContent ?? "")),
         labels,
         modes: modes.length,
         hasCommandField: [...(dialog?.querySelectorAll(".board-dialog-label") ?? [])]
           .some((l) => /命令|command/i.test(l.textContent ?? "")),
         hasUsableField: [...(dialog?.querySelectorAll(".board-dialog-label") ?? [])]
           .some((l) => /可用于任务|usable/i.test(l.textContent ?? "")),
         headers,
       };
       document.querySelector(".add-runtime-dialog .board-dialog-close")?.click();
       return out;
     })()`
  );
  check(
    runtimeDialog.opened === true && runtimeDialog.inlineCard === false,
    `adding a runtime opens a dialog, not a page (open: ${runtimeDialog.opened}, inline card: ${runtimeDialog.inlineCard})`
  );
  check(
    runtimeDialog.hasCommandField === false && runtimeDialog.hasUsableField === false && runtimeDialog.modes === 2,
    `the runtime dialog asks only how it runs (modes: ${runtimeDialog.modes}, command field: ${runtimeDialog.hasCommandField}, usable field: ${runtimeDialog.hasUsableField}, fields: ${JSON.stringify(runtimeDialog.labels)})`
  );
  check(
    runtimeDialog.headers.some((h) => /可用于任务|usable in tasks/i.test(h)) === false,
    `the runtime table has no per-record "usable in tasks" column (${JSON.stringify(runtimeDialog.headers)})`
  );

  // 9b-1r. The rail's header offers exactly the actions it can perform, and the
  //        filter toggle says which panel it opens. A "search" button used to
  //        sit here that only navigated to the task list, and the filter toggle
  //        wore the same grid glyph as the Kanban button right above it.
  const railActions = await evaluate(
    cdp,
    `(async () => {
       const buttons = [...document.querySelectorAll(".rail-head-actions button")];
       const filter = buttons.find((b) => b.getAttribute("aria-controls") === "rail-filters");
       const out = {
         count: buttons.length,
         labels: buttons.map((b) => b.getAttribute("aria-label")),
         hasSearch: buttons.some((b) => /搜索|Search/i.test(b.getAttribute("aria-label") ?? "")),
         expandedBefore: filter?.getAttribute("aria-expanded"),
       };
       filter?.click();
       await new Promise((r) => setTimeout(r, 500));
       out.panel = Boolean(document.getElementById("rail-filters"));
       out.expandedAfter = filter?.getAttribute("aria-expanded");
       return out;
     })()`
  );
  check(
    railActions.hasSearch === false && railActions.panel === true,
    `the rail header only offers actions it can perform (${JSON.stringify(railActions.labels)}, panel: ${railActions.panel})`
  );
  check(
    railActions.expandedBefore === "false" && railActions.expandedAfter === "true",
    `the filter toggle announces the panel it controls (${railActions.expandedBefore} → ${railActions.expandedAfter})`
  );

  // 9b-1q. A dialog is announced as one: role, modal, and a name taken from the
  //        text a sighted user can see. The name used to be a copy passed in as
  //        `aria-label`, so the two could disagree; it now points at the title.
  const dialogNames = await evaluate(
    cdp,
    `(async () => {
       const out = { checked: [], problems: [] };
       const inspect = (el, where) => {
         const label = el.getAttribute("aria-label");
         const byId = el.getAttribute("aria-labelledby");
         const labelled = byId ? document.getElementById(byId) : null;
         const name = (label ?? labelled?.textContent ?? "").trim();
         out.checked.push(where);
         if (el.getAttribute("aria-modal") !== "true") out.problems.push(where + ": not modal");
         if (!name) out.problems.push(where + ": no accessible name");
         if (byId && !labelled) out.problems.push(where + ": aria-labelledby points at nothing");
       };
       history.pushState({}, "", "/kanban");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 900));
       history.pushState({}, "", "/tasks");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1600));
       // The task delete confirmation, opened through the row menu.
       const row = document.querySelector(".task-item");
       [...(row?.querySelectorAll("button") ?? [])].pop()?.click();
       await new Promise((r) => setTimeout(r, 400));
       [...document.querySelectorAll("button")]
         .filter((b) => /删除|Delete/.test(b.textContent ?? ""))
         .pop()?.click();
       await new Promise((r) => setTimeout(r, 700));
       // No copy to delete on a fresh install: fall back to the settings dialog,
       // which every install has.
       if (document.querySelectorAll('[role="dialog"]').length === 0) {
         document.querySelector('.sidebar [title], .sidebar button')?.click();
         history.pushState({}, "", "/settings");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1200));
       }
       for (const dialog of document.querySelectorAll('[role="dialog"]')) inspect(dialog, "delete or settings");
       const box = document.querySelector(".modal[aria-labelledby]");
       const titleEl = box ? document.getElementById(box.getAttribute("aria-labelledby")) : null;
       out.titleLinked = Boolean(titleEl && titleEl.classList.contains("modal-title"));
       document.querySelector(".modal-overlay")?.click();
       await new Promise((r) => setTimeout(r, 400));
       return out;
     })()`
  );
  check(
    dialogNames.checked.length > 0 && dialogNames.problems.length === 0,
    `dialogs carry role, aria-modal and a visible name (${dialogNames.checked.length} checked: ${dialogNames.problems.join("; ")})`
  );
  // `Modal` only mounts for a record action; a fresh install has none, and the
  // role/modal/name assertions above still ran on whatever dialog it does have.
  if (!emptyMode) {
    check(
      dialogNames.titleLinked === true,
      `a dialog's accessible name comes from its title element (${dialogNames.titleLinked === true})`
    );
  }

  // 9b-1p. Table headers say what they are the header *of*. Without `scope`, a
  //        screen reader reaches a cell and cannot say which column it is in.
  const headerScopes = await evaluate(
    cdp,
    `(async () => {
       const missing = [];
       const count = (path) => {
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         return new Promise((r) => setTimeout(r, 900))
           .then(() => {
             history.pushState({}, "", path);
             window.dispatchEvent(new PopStateEvent("popstate"));
             return new Promise((r) => setTimeout(r, 1500));
           })
           .then(() => {
             for (const th of document.querySelectorAll("main th")) {
               if (th.getAttribute("scope") !== "col") missing.push(path + ": " + (th.textContent ?? "").trim());
             }
             return document.querySelectorAll("main th").length;
           });
       };
       const totals = {
         runs: await count("/runs"),
         handoffs: await count("/handoffs"),
         usage: await count("/usage"),
         runtimes: await count("/runtimes"),
       };
       return { missing, total: Object.values(totals).reduce((a, b) => a + b, 0) };
     })()`
  );
  check(
    headerScopes.total > 0 && headerScopes.missing.length === 0,
    `every column header declares its scope (${headerScopes.total} headers, ${headerScopes.missing.length} unmarked: ${headerScopes.missing.join("; ")})`
  );

  check(
    tableWraps.total > 0 && tableWraps.unwrapped.length === 0,
    `every table scrolls inside its card (${tableWraps.total} tables, ${tableWraps.unwrapped.length} unwrapped: ${tableWraps.unwrapped.join("; ")})`
  );

  check(
    links.total > 0 && links.noHref === 0 && links.withHref === links.total,
    `every in-app link carries an href (${links.withHref}/${links.total}, ${links.noHref} without)`
  );
  check(links.focusable === links.total, `in-app links are in the tab order (${links.focusable}/${links.total})`);
  // An install with no runs has no /runs/:id link to click; the href checks
  // above still apply, so only these two are skipped.
  if (!emptyMode) {
    check(links.navigated === true, "clicking an in-app link navigates");
    check(links.metaClickFree === true, "a Cmd-click on an in-app link is left to the browser");
  }

  // FIXTURE-DATA ONLY (9b-1i - opens the delete dialog from a seeded task)
  if (!emptyMode) {
    // 9b-1i. A dialog keeps the keyboard. `aria-modal` alone does not: without a
    //        trap, Tab walks out into the page behind the overlay.
    const dialogFocus = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/tasks");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1600));
         const row = document.querySelector(".task-item");
         const opener = row?.querySelector("button");
         opener?.focus();
         [...(row?.querySelectorAll("button") ?? [])].pop()?.click();
         await new Promise((r) => setTimeout(r, 500));
         [...document.querySelectorAll("button")]
           .filter((b) => /删除|Delete/.test(b.textContent ?? ""))
           .pop()?.click();
         await new Promise((r) => setTimeout(r, 700));
         const modal = document.querySelector(".modal");
         const out = {
           opened: Boolean(modal),
           focusInsideOnOpen: modal?.contains(document.activeElement) ?? false,
         };
         const stays = [];
         for (let i = 0; i < 6; i++) {
           window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
           await new Promise((r) => setTimeout(r, 40));
           stays.push(modal?.contains(document.activeElement) ?? false);
         }
         out.trapped = stays.every(Boolean);
         window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
         await new Promise((r) => setTimeout(r, 500));
         out.closed = !document.querySelector(".modal");
         out.restored = document.activeElement === opener;
         return out;
       })()`
    );
    check(
      dialogFocus.opened === true && dialogFocus.focusInsideOnOpen === true && dialogFocus.trapped === true,
      `a dialog keeps the keyboard inside it (opened: ${dialogFocus.opened}, focus inside: ${dialogFocus.focusInsideOnOpen}, trapped: ${dialogFocus.trapped})`
    );
    check(
      dialogFocus.closed === true && dialogFocus.restored === true,
      `closing a dialog returns focus to what opened it (closed: ${dialogFocus.closed}, restored: ${dialogFocus.restored})`
    );
  }

  // FIXTURE-DATA ONLY (9b-1j - deletes a row it creates and expects both lists to agree)
  if (!emptyMode) {
    await createThrowawayTask(cdp, "verify cross-view delete");
    await evaluate(cdp, `(async () => {
      window.dispatchEvent(new Event("agentfabric:tasks-changed"));
      await new Promise((r) => setTimeout(r, 600));
      return true;
    })()`);
    // 9b-1j. A change written in one view reaches the others immediately. Before
    //        the shared event, only the board announced task changes: a delete
    //        in the task list left the rail showing the deleted row until the 5s
    //        GET cache expired.
    const crossView = await evaluate(
      cdp,
      `(async () => {
         const railNames = () => [...document.querySelectorAll(".ws-task-row")]
           .map((r) => (r.textContent ?? "").trim());
         const TITLE = "verify cross-view delete";
         const target = () => [...document.querySelectorAll(".task-item")]
           .find((r) => (r.querySelector(".task-item-title")?.textContent ?? "").trim() === TITLE);
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1000));
         history.pushState({}, "", "/tasks");
         window.dispatchEvent(new PopStateEvent("popstate"));
         // Wait for the row itself: the list is fetched after the route lands.
         const deadline = Date.now() + 10000;
         while (Date.now() < deadline && !target()) {
           await new Promise((r) => setTimeout(r, 250));
         }
         const row = target();
         const title = (row?.querySelector(".task-item-title")?.textContent ?? "").trim();
         const out = { title, railHadItBefore: railNames().some((n) => n.includes(title)) };
         [...(row?.querySelectorAll("button") ?? [])].pop()?.click();
         await new Promise((r) => setTimeout(r, 400));
         [...document.querySelectorAll("button")]
           .filter((b) => /删除|Delete/.test(b.textContent ?? ""))
           .pop()?.click();
         await new Promise((r) => setTimeout(r, 600));
         const modal = document.querySelector(".modal, [role=dialog]");
         [...(modal?.querySelectorAll("button") ?? [])]
           .find((b) => b.classList.contains("danger"))
           ?.click();
         // Well inside the 5s cache window: this can only pass if the rail was
         // told, not if it waited for the cache to expire.
         await new Promise((r) => setTimeout(r, 900));
         out.railStillShowsIt = railNames().some((n) => n.includes(title));
         // The board is the third place the same tasks appear.
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1200));
         out.boardShowsIt = (document.querySelector("main")?.innerText ?? "").includes(title);
         return out;
       })()`
    );
    check(
      Boolean(crossView.title) && crossView.railHadItBefore === true,
      `the rail and the task list show the same tasks (${JSON.stringify(crossView.title)})`
    );
    check(
      crossView.railStillShowsIt === false && crossView.boardShowsIt === false,
      `a delete in the task list reaches the rail and the board at once (rail: ${crossView.railStillShowsIt}, board: ${crossView.boardShowsIt})`
    );
  }

  // FIXTURE-DATA ONLY (9b-1k - needs two seeded tasks to tell "other" from "this one")
  if (!emptyMode) {
    // 9b-1k. A page about one task ignores changes to the others. It used to
    //        reload whenever anything announced a task change, so deleting an
    //        unrelated task from the rail re-read the whole detail page.
    const scopedReload = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 900));
         history.pushState({}, "", "/tasks/task_verify_1/lifecycle");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 2000));
         // Watch the event as the page sees it: a listener registered here runs
         // alongside the page's own, so the count says whether the page's
         // filter let this change through. Network reads are the wrong probe —
         // a reload inside the 5s GET cache never leaves the renderer.
         const seen = [];
         const spy = (e) => seen.push(e.detail?.taskId);
         window.addEventListener("agentfabric:tasks-changed", spy);
         const out = {};
         try {
           window.dispatchEvent(
             new CustomEvent("agentfabric:tasks-changed", { detail: { taskId: "task_verify_2" } })
           );
           window.dispatchEvent(
             new CustomEvent("agentfabric:tasks-changed", { detail: { taskId: "task_verify_1" } })
           );
           await new Promise((r) => setTimeout(r, 1200));
           out.dispatchCount = seen.length;
           // The page must still be the same task: an unrelated event must not
           // have moved it (the rail navigations above are the only moves).
           out.title = document.querySelector("main h1")?.textContent ?? "";
         } finally {
           window.removeEventListener("agentfabric:tasks-changed", spy);
         }
         return out;
       })()`
    );
    check(
      scopedReload.dispatchCount === 2,
      `both task-change events reach the page (${scopedReload.dispatchCount} seen)`
    );
    check(
      /verify task one/.test(scopedReload.title ?? ""),
      `a task page stays on its own task when others change (${JSON.stringify(scopedReload.title)})`
    );
  }

  // FIXTURE-DATA ONLY (9b-1m - needs run rows carrying costs of known size)
  if (!emptyMode) {
    // 9b-1m. One money format. The run list and the inspector printed
    //        `toFixed(6)` (`$0.000012`, `$1.234500`) while Usage had already
    //        learned to drop the noise; both now share `fmtCost`.
    const money = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/runs");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1800));
         const cells = [...document.querySelectorAll("main tbody tr")]
           .map((r) => (r.children[7]?.textContent ?? "").trim())
           .filter((c) => c.startsWith("$"));
         return {
           cells,
           anySixZeroes: cells.some((c) => /0{6}/.test(c)),
           // More than a dollar keeps two decimals, so it cannot be 1.234500-formatted.
           dollarOk: cells.some((c) => c === "$1.23"),
         };
       })()`
    );
    check(
      money.cells.length > 0 && money.anySixZeroes === false,
      `costs are printed without padding zeroes (${JSON.stringify(money.cells)})`
    );
    check(
      money.dollarOk === true,
      `a cost above one dollar keeps two decimals (${JSON.stringify(money.cells)})`
    );
  }

  // FIXTURE-DATA ONLY (9b-1l - needs a run row to read a timestamp from)
  if (!emptyMode) {
    // 9b-1l. One timestamp format. The rows used to render through bare
    //        `toLocaleString()`, i.e. whatever the OS produced — seconds and
    //        all — while the relative labels came from a shared helper. Task
    //        and Trash had two private copies of that helper as well; those are
    //        gone, so the same instant cannot read two ways on one screen.
    const stamps = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1000));
         history.pushState({}, "", "/runs");
         window.dispatchEvent(new PopStateEvent("popstate"));
         // Wait for a row that actually renders a full date — the point of the
         // check — rather than for any row to exist.
         // No backslash escapes here: inside a template literal a backslash before
         // a letter is swallowed, so a shorthand class arrives as a bare letter
         // and silently stops matching. [0-9] and [ ] say the same thing without
         // needing one.
         const STAMP = /([0-9]{4})[年/. -]([0-9]{1,2})[月/. -]([0-9]{1,2})日?[ ]+[0-9]{1,2}:[0-9]{2}(?![0-9])/;
         const deadline = Date.now() + 20000;
         let rowText = "";
         while (Date.now() < deadline) {
           // Route first, then read: a stale page from the previous check still
           // has a <main>, so check which view is up before trusting its rows.
           if (location.pathname !== "/runs") {
             history.pushState({}, "", "/runs");
             window.dispatchEvent(new PopStateEvent("popstate"));
             await new Promise((r) => setTimeout(r, 400));
             continue;
           }
           rowText = document.querySelector("main tbody tr")?.innerText ?? "";
           if (STAMP.test(rowText)) break;
           await new Promise((r) => setTimeout(r, 250));
         }
         const text = rowText;
         const diag = { path: location.pathname, sample: rowText.slice(-60) };
         // A full date: year, month, day, hour:minute. No seconds, no
         // locale-specific noise.
         const stamp = STAMP.exec(text);
         const out = {
           found: Boolean(stamp),
           sample: stamp ? stamp[0] : null,
           hasSeconds: /[0-9]{1,2}:[0-9]{2}:[0-9]{2}/.test(text),
           path: diag.path,
           tail: diag.sample,
         };
         history.pushState({}, "", "/tasks");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1200));
         // The rail's labels and the list's labels come from one helper, so a
         // freshly written record reads the same "just now" in both.
         out.railRelative = document.querySelector(".ws-task-time")?.textContent?.trim() ?? null;
         out.listRelative = document.querySelector(".task-item-time")?.textContent?.trim() ?? null;
         return out;
       })()`
    );
    check(
      stamps.found === true && stamps.hasSeconds === false,
      `timestamps use one explicit format (${JSON.stringify(stamps.sample)}, seconds: ${stamps.hasSeconds}, at ${stamps.path}: ${JSON.stringify(stamps.tail)})`
    );
    check(
      Boolean(stamps.railRelative) && stamps.railRelative === stamps.listRelative,
      `the rail and the task list label the same instant the same way (${JSON.stringify(stamps.railRelative)} / ${JSON.stringify(stamps.listRelative)})`
    );
  }

  // 9b-2. The board's Add workspace dialog can adopt an existing workspace and
  //       exposes the same native folder bridge as the rail's dialog.
  const boardDialog = await evaluate(
    cdp,
    `(async () => {
       // The button only exists on the board: the checks above may have left the
       // window on any route, so navigate first instead of clicking nothing.
       history.pushState({}, "", "/kanban");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1600));
       document.querySelector(".board-add-project")?.click();
       await new Promise((r) => setTimeout(r, 700));
       const dialog = document.querySelector(".add-workspace-dialog");
       const select = dialog?.querySelector("select");
       const options = [...(select?.querySelectorAll("option") ?? [])].map((o) => o.textContent.trim());
       const result = {
         open: Boolean(dialog),
         options,
         nativeBridge: typeof window.agentfabric?.pickDirectory === "function",
         browseButton: Boolean(dialog?.querySelector(".dir-input-browse")),
       };
       dialog?.querySelector(".board-dialog-close")?.click();
       return result;
     })()`
  );
  check(boardDialog.open, `the board's Add workspace dialog opens (${boardDialog.options.length} options)`);
  check(
    boardDialog.options.length > 1,
    `the board dialog lists existing workspaces to adopt (${boardDialog.options.slice(0, 4).join(" | ")})`
  );
  check(
    boardDialog.nativeBridge && !boardDialog.browseButton,
    "the board dialog exposes the native folder bridge and has no browse button"
  );

  // 9b-3. The task dialog's permission select is the agent's real choice set:
  //       DSH exposes its three sandbox presets and preselects workspace write.
  //       There is no "auto" row — approving is granting a sandbox escalation.
  //       Its model field is a picker over the live acp catalog, not free text.
  if (!emptyMode) {
    const taskPermission = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/kanban");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1400));
         const opener = [...document.querySelectorAll("button")]
           .find((b) => /新建任务|New task/.test(b.textContent ?? ""));
         opener?.click();
         await new Promise((r) => setTimeout(r, 2600));
         const dialog = document.querySelector(".task-create-dialog");
         const select = dialog?.querySelector("#task-create-permission");
         const model = dialog?.querySelector("#task-create-model");
         const result = {
           open: Boolean(dialog),
           value: select?.value ?? null,
           options: [...(select?.querySelectorAll("option") ?? [])].map((o) => ({
             value: o.value,
             text: o.textContent.trim(),
           })),
           modelTag: model?.tagName ?? null,
           modelDisabled: model?.disabled ?? null,
           modelOptions: [...(model?.querySelectorAll("option") ?? [])].map((o) => o.textContent.trim()),
         };
         return result;
       })()`
    );
    check(taskPermission.open, "the board's new-task dialog opens");
    check(
      taskPermission.options.map((option) => option.value).join(",") === "read-only,workspace-write,danger-full-access",
      `DSH offers its three sandbox presets (${taskPermission.options.map((option) => option.text).join(" | ")})`
    );
    check(taskPermission.value === "workspace-write", `DSH preselects workspace write (${taskPermission.value})`);
    check(
      taskPermission.modelTag === "SELECT" && taskPermission.modelDisabled === false,
      `DSH's model field is a live catalog picker (${taskPermission.modelTag}, disabled: ${taskPermission.modelDisabled})`
    );
    check(
      taskPermission.modelOptions.length > 5,
      `the model picker lists the acp catalog (${taskPermission.modelOptions.length} rows, first: ${taskPermission.modelOptions.slice(1, 3).join(" | ")})`
    );

    // Every harness exposes a model picker: Claude's settings picker, Pi's
    // `--list-models` and `opencode models`; none is free text any more.
    const agentPickers = await evaluate(
      cdp,
      `(async () => {
         const dialog = document.querySelector(".task-create-dialog");
         const pickers = {};
         for (const label of ["Claude Code", "Pi", "OpenCode"]) {
           const chip = [...(dialog?.querySelectorAll(".task-agent-chip") ?? [])]
             .find((b) => b.textContent.trim() === label);
           chip?.click();
           // opencode models may start its background service on the first
           // call; the picker needs a little longer than the other CLIs.
           await new Promise((r) => setTimeout(r, 2600));
           const select = dialog?.querySelector("#task-create-model");
           const permission = dialog?.querySelector("#task-create-permission");
           pickers[label] = {
             tag: select?.tagName ?? null,
             disabled: select?.disabled ?? null,
             count: select?.querySelectorAll("option").length ?? 0,
             permission: [...(permission?.querySelectorAll("option") ?? [])].map((o) => o.textContent.trim()),
           };
         }
         dialog?.querySelector(".board-dialog-close")?.click();
         return pickers;
       })()`
    );
    for (const [label, picker] of Object.entries(agentPickers)) {
      check(
        picker.tag === "SELECT" && picker.disabled === false && picker.count > 5,
        `${label}'s model field is a live catalog picker (${picker.tag}, ${picker.count} rows)`
      );
    }
    for (const label of ["Pi", "OpenCode"]) {
      const permission = agentPickers[label].permission;
      check(
        permission.length === 3 &&
          permission[0].startsWith("Read only") &&
          permission[1].startsWith("Workspace write") &&
          permission[2].startsWith("Full access"),
        `${label} offers three permission presets (${permission.join(" | ")})`
      );
    }
  }

  // FIXTURE-DATA ONLY (9c - needs a board card)
  if (!emptyMode) {
  // 9c. A card never opens with its delete already armed.
  const boardOps = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/kanban");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1600));
       const cards = () => [...document.querySelectorAll(".board-card")];
       const actions = () => [...document.querySelectorAll(".board-detail-actions button")]
         .map((b) => b.textContent.trim());
       const done = cards().find((c) => c.className.includes("trashed"));
       if (!done) return { error: "no Done card on the board", cards: cards().length };
       done.click();
       await new Promise((r) => setTimeout(r, 900));
       const arm = [...document.querySelectorAll(".board-detail-actions button")]
         .find((b) => /Delete permanently/.test(b.textContent));
       if (!arm) return { error: "Done card has no 'Delete permanently'", actions: actions() };
       arm.click();
       await new Promise((r) => setTimeout(r, 350));
       const armed = actions().includes("Confirm delete");
       document.querySelector(".board-close")?.click();
       await new Promise((r) => setTimeout(r, 500));
       const other = cards().find((c) => !c.className.includes("trashed"));
       if (!other) return { error: "no second card to switch to", armed };
       other.click();
       await new Promise((r) => setTimeout(r, 900));
       return { armed, switched: actions() };
     })()`
  );
  if (boardOps.error) failures.push(`board delete arming: ${boardOps.error}`);
  check(boardOps.armed === true, "a Done card's delete needs the second click (Confirm delete)");
  check(
    boardOps.switched && !boardOps.switched.includes("Confirm delete"),
    `switching cards does not carry the armed delete over (${(boardOps.switched ?? []).join(" / ")})`
  );

  // 9c2. A card with no session explains itself instead of showing an empty box.
  //      The xterm layer below this is covered by verify-app (a real PTY round
  //      trip); what is checkable here without launching an agent is the state a
  //      user actually lands on first.
  const termEmpty = await evaluate(
    cdp,
    `(async () => {
       const card = [...document.querySelectorAll(".board-card")]
         .find((c) => !c.className.includes("trashed"));
       if (!card) return { error: "no card on the board" };
       card.click();
       await new Promise((r) => setTimeout(r, 1400));
       const empty = document.querySelector(".board-term-empty");
       return {
         hasEmpty: Boolean(empty),
         text: empty?.innerText?.split(String.fromCharCode(10)).join(" | ").slice(0, 120) ?? null,
         // Only a Backlog card offers Start; every other column must instead say
         // how to get back to a startable state. Either way the box is never a
         // dead end with no instruction.
         offersStart: empty ? /Start session/.test(empty.innerText) : false,
         explainsRecovery: empty ? /Restore the card|Move it to Done/.test(empty.innerText) : false,
         column: document.querySelector(".board-detail")?.getAttribute("data-column") ?? null,
         strayTerminal: Boolean(document.querySelector(".xterm")) && !document.querySelector(".board-detail"),
       };
     })()`
  );
  if (termEmpty.error) failures.push(`terminal empty state: ${termEmpty.error}`);
  check(
    termEmpty.hasEmpty === true && /No session/.test(termEmpty.text ?? ""),
    `a card without a session says so instead of showing an empty box (${JSON.stringify((termEmpty.text ?? "").slice(0, 60))})`
  );
  check(
    termEmpty.offersStart === true || termEmpty.explainsRecovery === true,
    `and says how to get to a session (Backlog offers Start; others explain the way back)`
  );

  }

  // 9d. Deletes confirm through the app's Modal, never window.confirm.
  //     A native dialog blocks the page, so this both checks consistency and
  //     keeps every delete flow reachable from an automated check.
  const confirmOps = await evaluate(
    cdp,
    `(async () => {
       const real = window.confirm;
       let native = 0;
       window.confirm = () => { native += 1; return false; };
       history.pushState({}, "", "/runtimes");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1600));
       const del = [...document.querySelectorAll("main button")]
         .find((b) => b.textContent.trim() === "delete");
       if (!del) { window.confirm = real; return { error: "no delete button on /runtimes" }; }
       del.click();
       await new Promise((r) => setTimeout(r, 600));
       const modal = [...document.querySelectorAll(".modal, [role=dialog]")]
         .find((m) => /Delete/.test(m.innerText));
       const opened = Boolean(modal);
       let cleared = true;
       if (modal) {
         [...modal.querySelectorAll("button")]
           .find((b) => /Cancel/.test(b.textContent))?.click();
         await new Promise((r) => setTimeout(r, 400));
         cleared = ![...document.querySelectorAll(".modal, [role=dialog]")]
           .some((m) => /Delete/.test(m.innerText));
       }
       window.confirm = real;
       return { opened, cleared, native };
     })()`
  );
  if (confirmOps.error) failures.push(`delete confirmation: ${confirmOps.error}`);
  check(confirmOps.opened === true, "a resource delete opens the in-app confirmation Modal");
  check(confirmOps.native === 0, `no native window.confirm is used (${confirmOps.native} call(s))`);
  check(confirmOps.cleared === true, "cancelling the confirmation closes it and deletes nothing");

  // FIXTURE-DATA ONLY (9d2 - needs the seeded project and credential)
  if (!emptyMode) {
  // 9d2. The two deletes that were missed by hand. Both destroy something that
  //      cannot be reconstructed — the Project is the only description of where
  //      the code comes from, and a credential's secret is never returned by the
  //      API again — so both must open the in-app confirmation before deleting.
  //
  //      Each is checked where it actually lives: the Projects list row, and the
  //      credential table inside the settings panel.
  const guardedDeletes = await evaluate(
    cdp,
    `(async () => {
       const process__DEBUG__ = false;
       const openDeleteConfirm = async (path, match) => {
         history.pushState({}, "", path);
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1800));
         const btn = [...document.querySelectorAll("main button, .settings-body button")]
           .filter((b) => b.className.split(/\s+/).indexOf("danger") !== -1)
           .find((b) => match.test(b.textContent));
         if (!btn) return "no delete button on " + path;
         const before = document.querySelectorAll(".modal, [role=dialog]").length;
         if (process__DEBUG__) console.log("clicking", btn.textContent.trim(), "cls=" + btn.className, "modals-before=" + before);
         btn.click();
         await new Promise((r) => setTimeout(r, 700));
         const opened = document.querySelectorAll(".modal, [role=dialog]").length > before;
         for (const m of document.querySelectorAll(".modal, [role=dialog]")) {
           const cancel = [...m.querySelectorAll("button")].find((b) => /cancel/i.test(b.textContent));
           if (cancel) cancel.click();
         }
         await new Promise((r) => setTimeout(r, 300));
         return opened ? null : "no confirmation for " + btn.textContent.trim() + " on " + path;
       };
       const out = [];
       // A Project's delete lives on its detail page (the list row navigates
       // there); the credential table is a settings section, which renders
       // inside the panel rather than in <main>.
       for (const [path, match] of []) { // Project and source-credential deletes were removed with the Project entity
      void path; void match;
         const problem = await openDeleteConfirm(path, match);
         if (problem) out.push(problem);
       }
       return out;
     })()`
  );
  check(
    Array.isArray(guardedDeletes) && guardedDeletes.length === 0,
    `no Project or credential delete is left to confirm (${Array.isArray(guardedDeletes) ? guardedDeletes.join("; ") || "none" : String(guardedDeletes)})`
  );

  }

  // 9e. Guidance must point at places that exist. The rail dropped the
  //     Workspaces and LLM pages, so a hint that still says "go to the
  //     Workspaces page" sends the user nowhere.
  const guidance = await evaluate(
    cdp,
    `(async () => {
       const stale = ["Workspaces 页面", "Runtimes 页面", "LLM 页面", "Proxy 页面", "Dashboard"];
       // Every reachable page, plus the task composer, is rendered text.
       const pages = ["/tasks", "/new", "/projects", "/runtimes", "/sessions", "/handoffs", "/runs", "/usage", "/kanban"];
       const found = [];
       for (const p of pages) {
         history.pushState({}, "", p);
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 700));
         const text = document.querySelector("main")?.innerText ?? "";
         for (const phrase of stale) {
           if (text.includes(phrase)) found.push(p + " → " + phrase);
         }
       }
       return { found };
     })()`
  );
  check(
    guidance.found.length === 0,
    `no page points at a page that no longer exists (${guidance.found.join(", ") || "none"})`
  );

  // 9f. Closing Settings with unsaved edits asks first. Escape and the mask are
  //     both easy to hit by accident and used to throw the edit away silently.
  const unsaved = await evaluate(
    cdp,
    `(async () => {
       history.pushState({}, "", "/settings/proxy");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1800));
       const overlay = () => document.querySelector(".settings-overlay");
       if (!overlay()) return { error: "settings panel did not open" };
       const input = document.querySelector(".settings-body input[type=text], .settings-body input:not([type])");
       if (!input) return { error: "no text field on the proxy page" };
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
       setter.call(input, "verify-dirty-host");
       input.dispatchEvent(new Event("input", { bubbles: true }));
       await new Promise((r) => setTimeout(r, 400));

       const asking = () => [...document.querySelectorAll(".modal")]
         .some((m) => /未保存|Unsaved/.test(m.innerText));

       window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
       await new Promise((r) => setTimeout(r, 500));
       const keptOpen = Boolean(overlay());
       const asked = asking();

       // Keep editing, then discard and close.
       [...document.querySelectorAll(".modal button")]
         .find((b) => /继续编辑|Keep editing/.test(b.textContent))?.click();
       await new Promise((r) => setTimeout(r, 400));
       const stillEditing = Boolean(overlay());
       window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
       await new Promise((r) => setTimeout(r, 400));
       [...document.querySelectorAll(".modal button")]
         .find((b) => /丢弃并关闭|Discard and close/.test(b.textContent))?.click();
       await new Promise((r) => setTimeout(r, 600));
       const closed = !overlay();
       return { asked, keptOpen, stillEditing, closed };
     })()`
  );
  if (unsaved.error) failures.push(`unsaved-changes guard: ${unsaved.error}`);
  check(
    unsaved.asked === true && unsaved.keptOpen === true,
    `closing Settings with edits asks instead of discarding (${unsaved.asked}, kept open: ${unsaved.keptOpen})`
  );
  check(unsaved.stillEditing === true, "\"Keep editing\" leaves the panel open");
  check(unsaved.closed === true, "\"Discard and close\" closes the panel");

  // 9e. A failed settings save says so where the click happened. Each editable
  //     page's save used to end in `try/finally` with no `catch`: the request
  //     failed, the panel's banner was hidden behind the section, and Save
  //     looked like it had worked while the file was never written. The PUT is
  //     failed here by rejecting it in the page, which is the only way to reach
  //     this path without corrupting a real config.
  const saveFailure = await evaluate(
    cdp,
    `(async () => {
       const originalFetch = window.fetch;
       window.fetch = (input, init) => {
         const url = typeof input === "string" ? input : input?.url ?? "";
         const method = (init?.method ?? "GET").toUpperCase();
         if (url.endsWith("/api/config") && method !== "GET") {
           return Promise.reject(new Error("verify: simulated network failure"));
         }
         return originalFetch(input, init);
       };
       try {
         history.pushState({}, "", "/settings/retry");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1400));
         const toggle = document.querySelector(".settings-page .settings-switch input");
         // Make the page dirty: the save button only exists to save a change.
         toggle?.click();
         await new Promise((r) => setTimeout(r, 500));
         const saveBtn = [...document.querySelectorAll(".settings-page .settings-save-row button")]
           .find((b) => b.classList.contains("btn-primary"));
         const enabled = saveBtn ? !saveBtn.disabled : false;
         saveBtn?.click();
         await new Promise((r) => setTimeout(r, 1200));
         const banner = document.querySelector(".settings-save-row .settings-error-line");
         const out = {
           saveEnabled: enabled,
           bannerText: (banner?.textContent ?? "").trim(),
           role: banner?.getAttribute("role") ?? null,
         };
         // Put the toggle back so the run leaves no dirty state behind.
         toggle?.click();
         return out;
       } finally {
         window.fetch = originalFetch;
       }
     })()`
  );
  check(saveFailure.saveEnabled, "a settings page can be saved once a field changes");
  check(
    saveFailure.role === "alert" && /没有保存成功|Not saved/.test(saveFailure.bannerText ?? ""),
    `a failed settings save reports itself next to the Save button (${JSON.stringify(saveFailure.bannerText?.slice(0, 80))})`
  );

  // 10. A terminal session actually spawns a PTY process inside the bundle.
  //     (The UI half: the board's project list — the shared Project collection —
  //     must reach the API. There is no board-only project endpoint any more.)
  const board = await evaluate(
    cdp,
    `(async () => {
       const res = await fetch("/api/workspaces");
       const body = await res.json();
       return { ok: res.ok, count: Array.isArray(body) ? body.length : 0 };
     })()`
  );
  check(board.ok, `the workspace API answers from the bundle (${board.count} workspace(s))`);

  const heading = await evaluate(cdp, `document.querySelector("h1")?.textContent?.trim()`);
  notes.push(`  info landed on "${heading}" (${home.path})`);
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  cdp?.close();
  if (!keepOpen) {
    app.kill("SIGTERM");
    await new Promise((done) => {
      const timer = setTimeout(() => {
        app.kill("SIGKILL");
        done();
      }, 10_000);
      app.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
}

console.log(`\n[verify-ui] ${appPath}`);
if (staleBuildWarning) console.log(`  !!  ${staleBuildWarning}`);
if (distWarning) console.log(`  !!  ${distWarning}`);
for (const line of notes) console.log(line);
if (failures.length > 0) {
  console.error(`\n[verify-ui] FAIL — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  if (appOutput.trim()) console.error(`\nApp output:\n${appOutput}`);
  exitCode = 1;
} else {
  console.log(`\n[verify-ui] OK — ${notes.filter((n) => n.startsWith("  ok")).length} checks passed`);
}
if (keepOpen) console.log(`[verify-ui] app left running (pid ${app.pid}); data dir ${dataDir}`);
process.exit(exitCode);
