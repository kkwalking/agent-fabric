/**
 * Desktop shell for AgentFabric — the macOS `.app` entry point.
 *
 * **CommonJS, and it must stay that way.** Electron loads a packaged app's main
 * script through its CommonJS loader; an ESM entry (`"type": "module"` or a
 * `.mjs` main) is silently never executed in a dock-launched app — the process
 * starts, no window appears, and nothing is logged, because no line of the
 * script ran. Plain CommonJS is the one form that runs both unpackaged
 * (`npm run desktop`) and inside the packaged app.
 *
 * The server is started **in this process**:
 *
 * - Its store needs `node:sqlite`, which Electron's main process has.
 * - The window talks to a real HTTP server on loopback, so `/api` REST, SSE and
 *   terminal websockets behave exactly as in a browser; the renderer is a plain
 *   page load, not a shim.
 * - The one native module, `node-pty`, is built for Node's ABI
 *   (`scripts/build-native.mjs`) — Electron's main process runs on that ABI —
 *   and `afterPack` checks it against the package before shipping.
 *
 * Lifecycle: the server runs in this process, so quitting (Cmd+Q, dock, window
 * close) calls its bounded `shutdown()` before the app exits.
 */
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { app, BrowserWindow, dialog, Menu, screen, shell } = require("electron");

// Chromium switches tuned for a long-lived local app rather than a browser
// tab: never go dormant on the renderer (the window must stay interactive even
// while the machine is idle), but keep its caches bounded so a long session
// does not grow without limit.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disk-cache-size", String(128 * 1024 * 1024));

// A GUI process must not inherit "run me as plain Node": with
// `ELECTRON_RUN_AS_NODE` set, Electron runs the main script on Node — no window
// system, no Electron API. Clearing it here is always correct: nothing in this
// design starts a Node child process.
delete process.env.ELECTRON_RUN_AS_NODE;

/** Loopback host. The bundled server is never exposed beyond the machine. */
const HOST = "127.0.0.1";

/**
 * Where the app's runtime files are.
 *
 * Packaged: they are `extraResources` in `Contents/Resources` (`backend/`,
 * `web/`), not inside `app.asar` — a native module cannot be required from an
 * asar and the server bundle resolves `node-pty` next to itself. Unpackaged
 * (`npm run desktop`): the same files sit in the package directory.
 */
const bundled = app.isPackaged ? process.resourcesPath : join(__dirname, "..");
const backendEntry = join(bundled, "backend", "server.cjs");
const webDir = join(bundled, "web");

/** `~/.fabric` by default: the same directory the CLI and `npm run dev` use. */
const dataDir = process.env.AGENTFABRIC_DATA_DIR ?? join(app.getPath("home"), ".fabric");

/** One window at a time: a second launch focuses the running one. */
let mainWindow = null;

/** The running in-process server, so a configuration restart can replace it. */
let backend = null;

/**
 * Window geometry is remembered between launches: a desktop app that forgets
 * where the user put it (and how big) is the first thing people complain about.
 */
const windowStateFile = () => join(app.getPath("userData"), "window-state.json");

/** The remembered size and position, validated against the current screens. */
function lastBounds() {
  try {
    const saved = JSON.parse(require("node:fs").readFileSync(windowStateFile(), "utf8"));
    const { width, height, x, y } = saved;
    if (![width, height].every((n) => Number.isFinite(n) && n >= 960)) return { width: 1440, height: 900 };
    // A window restored onto a monitor that is no longer attached would be
    // invisible; only keep the position if a screen still covers it.
    const onScreen = screen.getAllDisplays().some(({ workArea }) =>
      Number.isFinite(x) && Number.isFinite(y) && x >= workArea.x && y >= workArea.y &&
      x < workArea.x + workArea.width && y < workArea.y + workArea.height
    );
    return onScreen ? { width, height, x, y } : { width, height };
  } catch {
    return { width: 1440, height: 900 };
  }
}

function rememberBounds(win) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    const { width, height, x, y } = win.getNormalBounds();
    writeFileSync(windowStateFile(), JSON.stringify({ width, height, x, y }));
  } catch {
    /* geometry is a convenience; failing to store it must not block quitting */
  }
}

/**
 * The application menu.
 *
 * `before-input-event` alone is not enough: the standard Edit items are what
 * make macOS show the shortcuts and route them through the focused element
 * (including the terminal's hidden textarea), and without an app menu there is
 * no way to reach the developer tools or to Quit from the menu bar at all.
 */
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Cmd+<key> → the webContents command that performs it. */
const EDIT_SHORTCUTS = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
  y: "redo",
};
/** Set while quitting so the window's `close` handler stops asking. */
let quitting = false;

/**
 * A port nothing is listening on, so a stale dev server on the default port
 * cannot make the app fail to start. Released before the server binds it; the
 * window that follows makes a race practically impossible, and a bind failure
 * surfaces in the error dialog instead of a blank window.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = require("node:net").createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the bundled server in this process; resolves once it listens.
 *
 * `settings.server` in `<dataDir>/config.json` is a fallback for the address
 * only: the app always asks for a free port so a stale development server can
 * never make the window fail to open, and it writes the port it actually bound
 * back into that file.
 */
async function startBackend() {
  mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  // Loaded only now: the bundle is large, and a failure here should reach the
  // error dialog below instead of killing the process before there is one.
  const { createServer } = require(backendEntry);
  const server = await createServer({
    dataDir,
    staticDir: webDir,
    hookBaseUrl: `http://${HOST}:${port}/kanban-hooks/ingest`,
    // `port` makes the server bind and resolve only once it accepts
    // connections; without it the handle has no HTTP server at all.
    port,
    // Applying an edited configuration file means a restart: the listen address
    // and every value read once at boot come from the fresh server. The old one
    // is torn down first (its `shutdown` kills the work it started). Scheduled
    // off the request rather than run inside it, so the apply response is sent
    // before the server handling it goes away.
    restart: () => setTimeout(() => void restartBackend(), 0),
    // Straight to stderr: `console.log` is exactly what the server wraps to
    // hand us this line, so calling it back would recurse.
    onLog: (line) => process.stderr.write(`[server] ${line}\n`),
  });
  return { server, port };
}

/**
 * Restarts only the in-process server, not the window.
 *
 * The window keeps its identity (position, devtools) and is pointed at the new
 * port. The old handle's `shutdown()` is synchronous and kills the work that
 * process started, so nothing is left behind on the previous port.
 */
async function restartBackend() {
  const previous = backend;
  backend = null;
  try {
    previous?.server.shutdown();
    previous?.server.server?.close();
  } catch (err) {
    console.error("[desktop] stopping the previous server failed:", err);
  }
  const next = await startBackend();
  backend = next;
  console.log(`[desktop] server restarted on ${HOST}:${next.port}`);
  const win = mainWindow;
  if (win && !win.isDestroyed()) await win.loadURL(`http://${HOST}:${next.port}`);
}

async function createWindow(url) {
  const win = new BrowserWindow({
    // The app reopens at the size it was last used; first run uses these.
    ...lastBounds(),
    minWidth: 960,
    minHeight: 600,
    title: "AgentFabric",
    // The web UI is light; painting the window in its background colour means
    // the first frame is the app's own surface, not a black flash.
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mainWindow = win;

  // Show only once the first frame is ready, so the window never appears as an
  // empty white box while the UI chunk is still loading.
  win.once("ready-to-show", () => win.show());

  // Standard macOS editing shortcuts. The window has no menu bar entries for
  // them (there is no application menu with Edit roles yet), so without this
  // Cmd+C / Cmd+V / Cmd+A do nothing inside inputs — the most common thing a
  // user tries in a terminal or a task composer.
  win.webContents.on("before-input-event", (event, input) => {
    // Shift variants belong to the page (e.g. Cmd+Shift+V is "paste and match
    // style" in some apps; here they should not be hijacked).
    if (input.type !== "keyDown" || !input.meta || input.shift) return;
    const command = EDIT_SHORTCUTS[input.key.toLowerCase()];
    if (!command) return;
    event.preventDefault();
    win.webContents[command]();
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  win.on("close", (event) => {
    if (!quitting) rememberBounds(win);
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    app.quit();
  });
  await win.loadURL(url);
  return win;
}

async function boot() {
  try {
    backend = await startBackend();
    const { port } = backend;
    console.log(`[desktop] server listening on ${HOST}:${port}`);
    await createWindow(`http://${HOST}:${port}`);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // A Dock launch has no terminal: without this file the failure only exists
    // in a dialog there is no way to copy text out of.
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "desktop-startup.log"), `${new Date().toISOString()}\n${message}\n`);
    } catch {
      /* the dialog still reports it */
    }
    dialog.showErrorBox("AgentFabric 启动失败", `${message}\n\n数据目录：${dataDir}`);
    app.exit(1);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    buildMenu();
    return boot();
  });
  // Quitting must go through the server's own teardown (kill harness/git/docker
  // clients, remove their containers). Electron would otherwise exit on the
  // spot, leaving that work orphaned — which is exactly what `shutdown()` exists
  // to prevent. Synchronous on purpose: it has to finish before the process ends.
  app.on("before-quit", () => {
    quitting = true;
    try {
      backend?.server.shutdown();
    } catch (err) {
      console.error("[desktop] server shutdown failed:", err);
    }
    backend = null;
  });
  app.on("window-all-closed", () => app.quit());
}
