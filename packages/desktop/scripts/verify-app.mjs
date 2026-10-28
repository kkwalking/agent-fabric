/**
 * Checks the packaged bundle *by contents*, from any session.
 *
 * Launching an Electron app from an automated, non-GUI shell is not reliable
 * (it exits during window-server setup) and a spawned helper inside an `.app`
 * does not behave as a Node runtime, so "start the app and watch it" cannot be
 * the default check. What *can* be checked everywhere is the contract the app
 * relies on at runtime — and every step of it is verified here:
 *
 * 1. The bundle carries the server, the web UI, the asar entry and the native
 *    PTY addon (built for Node's ABI, `build/Release/pty.node`).
 * 2. A server started from the bundle's own layout — plain Node, cwd and
 *    environment as the app sets them — serves the UI and API on loopback.
 *    The app's own entry point is CommonJS (an ESM entry is silently never run
 *    in a packaged Electron app).
 * 3. Its PTY path works: a Kanban terminal session spawns a real process and
 *    streams bytes back over the websocket.
 *
 * What this cannot check is the window itself: Electron needs a GUI session
 * for that. `scripts/gui-verify.mjs` is the opt-in check for it
 * (`build-mac.mjs --gui-check`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

/**
 * @param {string} appPath path to `AgentFabric.app`
 * @returns {Promise<string>} a one-line verdict
 */
export async function verifyApp(appPath) {
  const contents = join(appPath, "Contents");
  const resources = join(contents, "Resources");
  const failures = [];
  const check = (ok, message) => {
    if (!ok) failures.push(message);
  };

  // 1. The bundle contents.
  const serverEntry = join(resources, "backend", "server.cjs");
  const webIndex = join(resources, "web", "index.html");
  const ptyDir = join(resources, "backend", "node_modules", "node-pty");
  check(existsSync(serverEntry), `Resources/backend/server.cjs is missing`);
  check(existsSync(webIndex), `Resources/web/index.html is missing`);
  check(existsSync(ptyDir), `Resources/backend/node_modules/node-pty is missing`);
  check(existsSync(join(ptyDir, "build", "Release", "pty.node")), `the PTY addon was not built (no build/Release/pty.node)`);
  check(existsSync(join(resources, "app.asar")), `Resources/app.asar is missing`);
  if (existsSync(join(resources, "app.asar"))) {
    const { listPackage, extractFile } = await import("@electron/asar");
    const asar = join(resources, "app.asar");
    const entries = listPackage(asar);
    check(!entries.some((entry) => entry.endsWith(".mjs")), `app.asar contains an ESM entry (must be CommonJS)`);
    const manifest = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
    check(manifest.type !== "module", `app.asar package.json is "type": "module" (packaged main must be CommonJS)`);
  }
  if (failures.length > 0) throw new Error(`verify: the bundle is incomplete —\n  - ${failures.join("\n  - ")}`);

  // 2./3. Run the bundle's own server from the bundle's layout.
  const scratch = mkdtempSync(join(tmpdir(), "af-app-verify-"));
  const served = await startBundledServer({ resources, serverEntry, webIndex });
  try {
    const page = await fetch(served.url);
    const html = await page.text();
    check(page.ok && html.includes('<div id="root"'), `the server did not serve the web UI (status ${page.status})`);
    const health = await fetch(`${served.url}/api/health`, { headers: { Authorization: `Bearer ${served.token}` } });
    check(health.ok, `/api/health answered ${health.status}`);
    // Workspaces are the only first-class entity now: the board, the task
    // composer and the sidebar all read this one collection.
    const workspaces = await fetch(`${served.url}/api/workspaces`, {
      headers: { Authorization: `Bearer ${served.token}` },
    });
    check(workspaces.ok, `/api/workspaces answered ${workspaces.status}`);
    const ptyVerdict = await ptyRoundTrip(served.url, served.token, scratch);
    if (failures.length > 0) throw new Error(`verify: the packaged bundle misbehaves —\n  - ${failures.join("\n  - ")}`);
    return `bundle ok: the packaged server runs from the bundle (UI, API, ${ptyVerdict})`;
  } finally {
    served.server.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Starts the packaged server the way the app does: load the bundle and call
 * `createServer` with the bundle's own directories. The bundle exports the
 * server (it is not a CLI), so it is required here rather than spawned.
 */
async function startBundledServer({ resources, serverEntry, webIndex }) {
  const { createRequire } = await import("node:module");
  const { createServer } = createRequire(serverEntry)(serverEntry);
  const port = await freePort();
  // A scratch data directory next to the check's own temp dir: the packaged
  // app's data directory is the user's, and a check must not touch it.
  const dataDir = mkdtempSync(join(tmpdir(), "af-verify-data-"));
  const server = await createServer({
    dataDir,
    staticDir: dirname(webIndex),
    hookBaseUrl: `http://127.0.0.1:${port}/kanban-hooks/ingest`,
    port,
    onLog: (line) => process.stderr.write(`[server] ${line}\n`),
  });
  const token = readFileSync(join(dataDir, "token"), "utf8").trim();
  return { server, token, url: `http://127.0.0.1:${port}` };
}

/** Creates a project + card, starts a terminal session and waits for PTY bytes. */
async function ptyRoundTrip(url, token, scratch) {
  const api = async (path, init = {}) => {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${body}`);
    return body === "" ? undefined : JSON.parse(body);
  };

  const workspaceDir = join(scratch, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "README.md"), "verify\n");
  const created = await api("/api/kanban/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "verify", rootPath: workspaceDir }),
  });
  const card = await api(`/api/kanban/workspaces/${created.workspace.id}/cards`, {
    method: "POST",
    body: JSON.stringify({ title: "pty verify", prompt: "Reply with the single word ok.", agentId: "opencode" }),
  });
  const started = await api(`/api/kanban/cards/${card.card.id}/start`, { method: "POST", body: "{}" });

  const ws = new WebSocket(`${url.replace("http:", "ws:")}/api/kanban/sessions/${started.session.id}/terminal`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  try {
    const bytes = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("no PTY output over the websocket within 20s")), 20_000);
      let total = 0;
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return; // the replay snapshot is JSON; process output is binary
        total += data.length;
        if (total > 0) {
          clearTimeout(timer);
          res(total);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        rej(err);
      });
    });
    return `PTY spawn (${bytes} bytes back)`;
  } finally {
    ws.close();
  }
}

async function freePort() {
  const { createServer } = await import("node:http");
  return await new Promise((res, rej) => {
    const probe = createServer();
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => res(port));
    });
  });
}

export { desktopRoot };
