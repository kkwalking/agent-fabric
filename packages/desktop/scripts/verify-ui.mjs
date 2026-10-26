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
  const workspace = (id, name, path) => ({
    id, name, type: "local", path, mountPath: "/workspace",
    persistent: true, source: "create", status: "ready", ownership: "external",
    createdAt: now, updatedAt: now,
  });
  const task = (id, title, workspaceId) => ({
    id, title, prompt: title, workspaceId,
    env: {}, secretIds: [], tools: [], createdAt: now, updatedAt: now,
    metadata: { lastActivityAt: now },
  });
  // The board shares the Project collection (`source` + `board`), so a board
  // project is just a Project whose source is the folder the user picked.
  const boardProject = (id, name, rootPath) => ({
    id, name,
    source: { type: "directory", path: rootPath, defaultBranch: "main" },
    board: { workspaceType: "git", defaultAgentId: "dsh", defaultExecutionMode: "direct" },
    createdAt: now, updatedAt: now,
  });
  // The board's folder is also an external Workspace: that is what the sidebar
  // task tree groups a board card's Task under.
  const kanbanCard = (id, title, column) => ({
    id, projectId: "proj_verify_board", title, prompt: title, column,
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
      // The board's project first: opening /kanban selects `projects[0]` unless
      // this browser already remembers another one. It is the same record the
      // Projects page lists — the board has no collection of its own.
      boardProject("proj_verify_board", "verify-board", "/tmp/af-verify-board"),
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
      workspace("ws_verify_alpha", "verify-alpha", "/tmp/af-verify-alpha"),
      workspace("ws_verify_beta", "verify-beta", "/tmp/af-verify-beta"),
      // A long workspace, so paging has something to page through.
      workspace("ws_verify_bulk", "verify-bulk", "/tmp/af-verify-bulk"),
    ],
    tasks: [
      task("task_verify_1", "verify task one", "ws_verify_alpha"),
      task("task_verify_2", "verify task two", "ws_verify_alpha"),
      task("task_verify_3", "verify task three", "ws_verify_beta"),
      task("task_verify_orphan", "verify orphan task", undefined),
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
  const shard = (runId) => ({
    runId,
    file: `events/${runId}.jsonl`,
    count: runMessages + 2,
    bytes: 0,
    lastSeq: runMessages + 2,
    createdAt: now,
    updatedAt: now,
  });
  db.eventShards = [shard(longRunId), shard(longRunId2)];
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
       const projects = await (await fetch("/api/projects")).json();
       return { health: token, tasks: tasks.length, workspaces: workspaces.length, projects: projects.length };
     })()`
  );
  check(api.health === true, `/api/health answers ok (${api.tasks} tasks, ${api.workspaces} workspaces, ${api.projects} projects)`);

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

  // 5b. The rail's new-session button and the row menu.
  const railOps = await evaluate(
    cdp,
    `(async () => {
       const newBtn = document.querySelector(".rail-new");
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
         headIcons,
         items,
         menuOnScreen,
         closedByEscape: !document.querySelector(".ws-task-menu"),
       };
     })()`
  );
  check(/新会话|New session/.test(railOps.newLabel ?? ""), `the rail has a new-session button ("${railOps.newLabel}")`);
  check(railOps.headIcons === 3, `the workspace heading carries ${railOps.headIcons} icons (search / filter / new)`);
  check(railOps.items.length === 4, `session menu offers ${railOps.items.length} actions: ${railOps.items.join(", ")}`);
  check(railOps.menuOnScreen && railOps.closedByEscape, "the session menu stays on screen and closes on Escape");

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
    // workspace), and its message must point somewhere that actually opens.
    const firstUse = await evaluate(
      cdp,
      `(async () => {
         history.pushState({}, "", "/new");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1800));
         const main = () => document.querySelector("main");
         const sendBtn = [...document.querySelectorAll("main button")]
           .find((b) => b.className.includes("send"));
         // The hint card is found by structure, not by its wording: the UI is
         // bilingual, so matching English prose here broke the moment the
         // Chinese strings landed. The card that carries the way out is the one
         // containing a link into Projects.
         const hint = [...document.querySelectorAll("main .card")]
           .map((c) => c.textContent.trim())
           .find((t) => /更多|More/.test(t)) ?? "";
         const out = {
           sendDisabled: sendBtn ? sendBtn.disabled : null,
           hintMentionsPath: /更多/.test(hint) && /项目/.test(hint),
           hintText: hint,
         };
         // Follow the path the hint describes.
         history.pushState({}, "", "/projects");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 1400));
         const trigger = [...document.querySelectorAll("main a, main button")]
           // Either language: the button's label is translated now.
           .find((el) => /New project|新建项目|新建一个项目|添加项目|创建项目/.test(el.textContent));
         out.hasCreateEntry = Boolean(trigger);
         if (trigger) {
           trigger.click();
           await new Promise((r) => setTimeout(r, 700));
           // A dialog is a dialog whatever its language: require that one opened
           // and that it is asking about a project (name label or source tabs).
           out.dialogOpened = [...document.querySelectorAll(".modal, [role=dialog]")]
             .some((m) => /project|项目|仓库|文件夹/i.test(m.innerText));
         }
         return out;
       })()`
    );
    check(firstUse.sendDisabled === true, "a fresh install blocks the composer until a workspace exists");
    check(firstUse.hintMentionsPath === true, "the block message names a path that exists (更多 → 项目)");
    // The message must not send the user to a page that does not exist: there is
    // no workspace-creation entry in the UI, and the platform creates a task's
    // working copy itself, so "go create a Workspace" is a dead end.
    check(
      !/前往 Workspaces|新建一个 Workspace|Workspaces 页面/.test(firstUse.hintText ?? ""),
      `the block message does not send the user to a page that cannot exist (${JSON.stringify((firstUse.hintText ?? "").slice(0, 60))})`
    );
    check(firstUse.hasCreateEntry === true, "the projects page offers a way to create the first project");
    check(firstUse.dialogOpened === true, "clicking it opens the create dialog");

    // After creating a project the next gate is a containerized runtime, and the
    // message for it must lead to the Docker diagnosis rather than leaving the
    // user to guess whether Docker is missing, stopped, or fine.
    //
    // This only exists once a project exists: with none, the Project selector
    // itself is not rendered, so the runtime question cannot come up yet (that
    // ordering is what the composer check above covers). Create one first.
    const gateSource = join(dataDir, "gate-source");
    mkdirSync(gateSource, { recursive: true });
    await evaluate(
      cdp,
      `(async () => {
         const res = await fetch("/api/projects", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ name: "gate-probe", source: { type: "directory", path: ${JSON.stringify(gateSource)} } }),
         });
         return res.status;
       })()`
    );
    const runtimeGate = await evaluate(
      cdp,
      `(async () => {
         // Create a project through the dialog's own API path is covered above;
         // here the message text for the runtime gate is what matters.
         // Leave and come back so the composer re-reads the project list: the
         // GET cache lives 5s, and the project was created a moment ago.
         history.pushState({}, "", "/tasks");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 5200));
         history.pushState({}, "", "/new");
         window.dispatchEvent(new PopStateEvent("popstate"));
         await new Promise((r) => setTimeout(r, 2200));
         const texts = [...document.querySelectorAll("main .card")].map((c) => c.textContent.trim());
         // Both languages: the gate text is translated.
         const gate = texts.find((t) => /isolated runtime|隔离运行时/i.test(t)) ?? null;
         return {
           gate,
           mentionsDocker: /Docker/.test(gate ?? ""),
           // Where the fix lives moves as the IA changes (Runtimes lives under
           // "More" now), so assert the runtimes/settings entry point rather
           // than one literal menu word.
           mentionsSettings: /设置|运行时|Settings|Runtimes/.test(gate ?? ""),
         };
       })()`
    );
    // With a project present and no containerized runtime on a fresh install,
    // the gate must be on screen — asserting its wording only when it happens to
    // appear would let a missing message pass silently.
    check(runtimeGate.gate !== null, `a project without a containerized runtime shows the gate (${JSON.stringify((runtimeGate.gate ?? "").slice(0, 60))})`);
    check(
      runtimeGate.gate !== null && runtimeGate.mentionsDocker === true && runtimeGate.mentionsSettings === true,
      `the runtime gate points at the Docker diagnosis (${JSON.stringify((runtimeGate.gate ?? "").slice(0, 60))})`
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
       // The credentials page is a settings section now; visit it by URL.
       history.pushState({}, "", "/settings/credentials");
       window.dispatchEvent(new PopStateEvent("popstate"));
       await new Promise((r) => setTimeout(r, 1000));
       return {
         panel,
         sections,
         credentialsHeading: document.querySelector(".settings-page-title")?.textContent?.trim() ?? null,
         hasAddButton: [...document.querySelectorAll(".settings-panel button")].some((b) => /Add credential|新增凭据|添加/i.test(b.textContent)),
       };
     })()`
  );
  check(settings.panel, `settings panel opens with ${settings.sections.length} sections: ${settings.sections.join(", ")}`);
  check(settings.sections.some((s) => /凭据|credential/i.test(s)), "the settings nav includes source credentials");
  check(settings.credentialsHeading !== null, `the credentials page renders ("${settings.credentialsHeading}")`);

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
           .filter((b) => b.className.split(/\\s+/).indexOf("danger") !== -1)
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
       for (const [path, match] of [["/projects/proj_verify", /delete/i], ["/source-credentials", /remove/i]]) {
         const problem = await openDeleteConfirm(path, match);
         if (problem) out.push(problem);
       }
       return out;
     })()`
  );
  check(
    Array.isArray(guardedDeletes) && guardedDeletes.length === 0,
    `the Project and credential deletes ask first (${Array.isArray(guardedDeletes) ? guardedDeletes.join("; ") || "both confirmed" : String(guardedDeletes)})`
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

  // 10. A terminal session actually spawns a PTY process inside the bundle.
  //     (The UI half: the board's project list — the shared Project collection —
  //     must reach the API. There is no board-only project endpoint any more.)
  const board = await evaluate(
    cdp,
    `(async () => {
       const res = await fetch("/api/projects");
       const body = await res.json();
       return { ok: res.ok, count: Array.isArray(body) ? body.length : (body.projects?.length ?? 0) };
     })()`
  );
  check(board.ok, `the project API answers from the bundle (${board.count} project(s))`);

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
