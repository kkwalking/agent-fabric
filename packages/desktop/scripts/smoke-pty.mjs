/**
 * End-to-end check that the bundled server can actually run a PTY.
 *
 * The app runs the bundled server in its own process (Node's ABI), with the
 * `node-pty` build staged at `backend/node_modules/node-pty`. This loads that
 * bundle the same way (Node, that layout), opens a Kanban terminal session and
 * asserts a real process spawns and streams bytes back over the websocket.
 *
 * Usage (after `npm run build:backend`, which stages the addon):
 *   node scripts/smoke-pty.mjs
 *
 * It prints a one-line verdict and exits non-zero on failure, so it can gate a
 * release build. Nothing is written outside a temporary data directory.
 */
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");

async function freePort() {
  return await new Promise((res, rej) => {
    const probe = createServer();
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => res(port));
    });
  });
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "af-desktop-smoke-"));
  const resources = join(scratch, "resources");
  try {
    // The packaged layout: the bundle with the addon tree beside it, and the
    // built web UI where the bundle expects it.
    cpSync(join(desktopRoot, "backend"), join(resources, "app"), { recursive: true });
    cpSync(join(repoRoot, "packages/web/dist"), join(resources, "app", "web"), { recursive: true });

    const port = await freePort();
    const { createServer } = createRequire(join(resources, "app", "server.cjs"))(join(resources, "app", "server.cjs"));
    const server = await createServer({
      dataDir: join(scratch, "data"),
      staticDir: join(resources, "app", "web"),
      hookBaseUrl: `http://127.0.0.1:${port}/kanban-hooks/ingest`,
      port,
    });
    const url = `http://127.0.0.1:${port}`;

    try {
      const token = readFileSync(join(scratch, "data", "token"), "utf8").trim();
      const verdict = await ptyRoundTrip(url, token, scratch);
      console.log(`OK  ${verdict}`);
    } finally {
      server.shutdown();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Starts a project + board session and asserts a real PTY spawns.
 *
 * The session runs whichever agent CLI the card names, and that CLI may itself
 * block (waiting for a model, or for stdin). The assertion is therefore only
 * "the PTY produced bytes and still works", bounded by a deadline; the session
 * and the whole check are torn down afterwards regardless.
 */
async function ptyRoundTrip(url, token, scratch) {
  const api = async (path, init = {}) => {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${body}`);
    return body === "" ? undefined : JSON.parse(body);
  };

  // A plain folder becomes a board workspace: the board runs in place, so
  // nothing is cloned and no repository is initialised.
  const workspaceDir = join(scratch, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "README.md"), "smoke\n");
  const created = await api("/api/kanban/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "smoke", rootPath: workspaceDir }),
  });
  const workspaceId = created.workspace.id;

  const card = await api(`/api/kanban/workspaces/${workspaceId}/cards`, {
    method: "POST",
    body: JSON.stringify({ title: "pty smoke", prompt: "Reply with the single word ok.", agentId: "opencode" }),
  });
  const cardId = card.card?.id ?? card.id;

  // Starting the card spawns the harness/PTY. The session id is what the
  // terminal websocket attaches to.
  const started = await api(`/api/kanban/cards/${cardId}/start`, { method: "POST", body: "{}" });
  const sessionId = started.session?.id ?? started.id;

  const marker = `af-pty-${Date.now()}`;
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/api/kanban/sessions/${sessionId}/terminal`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // Wait for the terminal to emit anything at all. The point of this check is
  // that node-pty spawned a process on this runtime and its bytes made it back
  // over the websocket; which agent the card runs is irrelevant, and asserting
  // on a specific banner would make the check depend on the agent's UI.
  const seen = [];
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("no PTY output within 20s")), 20_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 })));
    ws.on("message", (data, isBinary) => {
      const text = isBinary ? data.toString() : String(data);
      seen.push(text);
      // The first frame is the replay snapshot; real process output is the
      // binary frames that follow it.
      if (isBinary && text.length > 0) {
        clearTimeout(timer);
        res();
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      rej(err);
    });
  });
  const bytes = seen.reduce((sum, chunk) => sum + chunk.length, 0);

  ws.close();
  await api(`/api/kanban/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
  return `node-pty spawned a process and its output reached the websocket (${bytes} bytes over ${seen.length} frames)`;
}

try {
  await main();
} catch (err) {
  console.error(`FAIL  ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
process.exit(0);
