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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const appPath = resolve(args.find((a) => !a.startsWith("--")) ?? "/Applications/AgentFabric.app");
const keepOpen = args.includes("--keep-open");

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
  // A board project plus two cards: one in Done (its panel offers the two-step
  // delete) and one in Review (opened after abandoning an armed delete).
  const kanbanProject = (id, name, rootPath) => ({
    id, name, rootPath, workspaceType: "git",
    createdAt: now, updatedAt: now,
  });
  const kanbanCard = (id, title, column) => ({
    id, projectId: "kproj_verify", title, prompt: title, column,
    agentId: "dsh", executionMode: "direct", createdAt: now, updatedAt: now,
  });
  const db = {
    providers: [], models: [], runtimes: [], secrets: [], profiles: [],
    sources: [], sourceCredentials: [], projects: [], workspaceLocks: [],
    runs: [], eventShards: [], artifacts: [], handoffs: [],
    runtimeSessions: [], nativeStates: [], kanbanSessions: [],
    config: {},
    kanbanProjects: [kanbanProject("kproj_verify", "verify-board", "/tmp/af-verify-board")],
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
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "db.json"), JSON.stringify(db, null, 2));
}
writeFixture(dataDir);
const profileDir = mkdtempSync(join(tmpdir(), "af-verify-profile-"));
const port = await freePort();
const env = { ...process.env, AGENTFABRIC_DATA_DIR: dataDir };
// The app is an Electron binary: an inherited ELECTRON_RUN_AS_NODE turns it
// into a plain Node process with no window to inspect.
delete env.ELECTRON_RUN_AS_NODE;
// A separate profile keeps the check away from the user's own Electron state.
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
  // 4. The rail groups those tasks by workspace.
  await waitFor(cdp, `document.querySelectorAll(".ws-group").length > 0`, 20_000, "the workspace tree to load");
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

  // 8. Language switch: the shell and the rail both follow it.
  const language = await evaluate(
    cdp,
    `(async () => {
       const before = { lang: document.documentElement.lang, heading: document.querySelector(".settings-nav-title")?.textContent?.trim() };
       const toggle = [...document.querySelectorAll("button")].find((b) => /Switch to|切换到/.test(b.getAttribute("title") ?? ""));
       toggle?.click();
       await new Promise((r) => setTimeout(r, 700));
       return {
         before,
         after: {
           lang: document.documentElement.lang,
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
           errorText: document.querySelector(".error-box, [role='alert']")?.textContent?.slice(0, 80) ?? null,
         };
       })()`
    );
    check(
      verdict.heading !== null && verdict.textLen > 40 && !verdict.errorText,
      `${label} renders (${verdict.heading ?? "no heading"}, ${verdict.textLen} chars${verdict.errorText ? `, error: ${verdict.errorText}` : ""})`
    );
  }

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

  // 10. A terminal session actually spawns a PTY process inside the bundle.
  //     (The UI half: the board's session list must reach the API.)
  const board = await evaluate(
    cdp,
    `(async () => {
       const res = await fetch("/api/kanban/projects");
       const body = await res.json();
       return { ok: res.ok, count: Array.isArray(body) ? body.length : (body.projects?.length ?? 0) };
     })()`
  );
  check(board.ok, `the board API answers from the bundle (${board.count} project(s))`);

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
