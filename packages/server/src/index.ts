import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "@agentfabric/core";
import { createServer } from "./app.js";
import { SCHEMA_REF, configFilePath, readConfigFile, writeConfigFile } from "./settings.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

/**
 * Set right before a restart that applies the config file; names the keys whose
 * values changed so the Settings page can still list the change afterwards.
 */
const APPLIED_FLAG_FILE = "settings-applied.json";

/** Bound for the whole shutdown; the process exits even if a step hangs. */
const SHUTDOWN_TIMEOUT_MS = 10_000;


/** Loopback hosts. Anything else is reachable from the network. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Runs the server until it is stopped, restarting it in place once when the
 * configuration file has been applied.
 *
 * An in-place restart is the portable form: exiting with a code and trusting a
 * supervisor to start the process again works for `tsx watch` and the desktop
 * app, but a plain `npm start` (or `node dist/index.js`) would simply stop —
 * the page says "restarting…" and nothing comes back. Deferring the server's
 * setup by one turn of the event loop is what makes the teardown in `stop()`
 * safe to call from a request handler, and what lets a restart reuse this
 * function's own teardown.
 */
async function main(): Promise<{ restart: () => void }> {
  // Data lives in a stable per-user directory so the store does not move
  // with whatever cwd the server happened to be started from.
  const dataDir = process.env.AGENTFABRIC_DATA_DIR ?? join(homedir(), ".fabric");

  // Serve the built web UI (packages/web/dist). The directory is re-checked
  // per request, so `npm run dev` may build the UI after the server started.
  const distCandidates = [
    process.env.AGENTFABRIC_WEB_DIR,
    resolve(__dirname, "../../web/dist"),
    resolve(process.cwd(), "web/dist"),
    resolve(process.cwd(), "dist/web"),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
  const staticDir = distCandidates.find((d) => existsSync(resolve(d, "index.html"))) ?? distCandidates[0];

  // The configuration file (`<dataDir>/config.json`) is the single place
  // settings live and what the Settings page edits. Its `server` block is only a
  // *fallback* for the listen address: an env override wins for this launch and
  // the winner is written back, so the file and the environment never disagree
  // about what actually runs.
  const configPath = configFilePath(dataDir);
  const stored = await readConfigFile(configPath);
  if (stored.error !== undefined) {
    // A file that is there but does not parse is the user's edit in progress:
    // refuse to start rather than run on settings the file does not say.
    throw new Error(`The configuration file ${configPath} could not be read (${stored.error}). Fix it and start again.`);
  }
  const fileServer = stored.parsed?.server ?? {};
  const config: AppConfig = {
    ...(stored.parsed ?? {}),
    server: {
      host: process.env.AGENTFABRIC_HOST ?? fileServer.host ?? "127.0.0.1",
      port: Number(process.env.AGENTFABRIC_PORT ?? fileServer.port ?? 7377),
    },
  };

  // Loopback by default (the values above): this server holds every configured
  // credential and can start processes, so it must not be reachable from the
  // network unless the operator says so explicitly.
  const host = config.server!.host!;
  const port = config.server!.port!;

  // Harness hooks call back over loopback; a wildcard bind still reaches
  // 127.0.0.1, and an explicit IPv6 host needs brackets in a URL.
  const hookHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const hookAuthority = hookHost.includes(":") ? `[${hookHost}]` : hookHost;

  // The history is in memory, so an apply that restarts the server would lose
  // its own record. The flag file survives the restart and names the keys that
  // changed; the next boot consumes it (and deletes it either way, so a flag
  // that cannot be deleted does not accumulate).
  const appliedFlagPath = join(dataDir, APPLIED_FLAG_FILE);
  let appliedKeys: string[] | undefined;
  if (existsSync(appliedFlagPath)) {
    try {
      appliedKeys = JSON.parse(await readFile(appliedFlagPath, "utf8")).keys;
    } catch {
      appliedKeys = undefined;
    }
    await rm(appliedFlagPath, { force: true });
  }

  const { app, shutdown, upgrade } = await createServer({
    dataDir,
    appliedFromRestart: appliedKeys,
    staticDir,
    hookBaseUrl: `http://${hookAuthority}:${port}/kanban-hooks/ingest`,
    // Applying an edited file means restarting: the listen address may have
    // changed, and the config is read once at boot. A fresh process is the only
    // way to honour that without every consumer re-reading the store.
    // The restart is deferred off the request so the client gets its answer
    // before this server's socket goes away; the flag file carries the change
    // into the fresh process, whose in-memory history starts empty.
    restart: (changed: string[]) => {
      void writeFile(join(dataDir, APPLIED_FLAG_FILE), JSON.stringify({ keys: changed, at: new Date().toISOString() }))
        .catch(() => {})
        .finally(() => setImmediate(requestRestart));
    },
  });
  // The file is created on first boot only, from the effective config:
  // `$schema` for editors and the address this process bound. A file that is
  // already there is left byte-for-byte alone — it is the record of the
  // configuration, possibly mid-edit in an editor, and a boot that rewrote it
  // would both discard unsaved changes and change the revision every reader
  // compares against (every `GET /api/settings/file` then reports an
  // unapplied edit that nobody made).
  if (!existsSync(configPath)) await writeConfigFile(configPath, config, SCHEMA_REF);
  // An explicit HTTP server (rather than `app.listen`) is what lets the
  // kanban terminal websocket share the same port and auth token (v13 §5.1).
  const server = createHttpServer(app);
  server.on("upgrade", upgrade);
  server.listen(port, host, () => {
    console.log(`[agent-fabric] API server listening on http://${host}:${port}`);
    console.log(`[agent-fabric] Data directory: ${dataDir}`);
    // The UI is served on demand; say whether it resolves right now, since a
    // build may still be running (npm run dev builds it alongside).
    const webReady = distCandidates.some((d) => existsSync(resolve(d, "index.html")));
    console.log(
      `[agent-fabric] Web UI: ${webReady ? `http://localhost:${port}` : "build not found yet — `npm run build:web` (or keep `npm run dev` running to build it)"}`
    );
    if (!LOOPBACK_HOSTS.has(host)) {
      console.warn(
        `[agent-fabric] WARNING: bound to ${host}, not loopback — this server is reachable from the network, ` +
          `and the API token is the only thing protecting every configured credential, workspace and process. ` +
          `Unset AGENTFABRIC_HOST to listen on 127.0.0.1 only.`
      );
    }
  });

  let stopping = false;
  /** Set by the `restart` hook above; `stop()` does the teardown for both. */
  let restarting = false;
  /** Set while a restart is being applied; resolved once the old server stopped. */
  let resolveRestart: (() => void) | undefined;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[agent-fabric] ${signal} received — shutting down`);

    // A watchdog, not the normal path: if any teardown step wedges, the
    // process still exits instead of hanging around half-stopped.
    const watchdog = setTimeout(() => {
      console.error(`[agent-fabric] shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS}ms — exiting`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      // Stop the work first (harness processes, git/docker clients,
      // containers — all synchronous), then stop accepting requests. The
      // Run records stay non-terminal on purpose: the next start's
      // `recoverInterrupted()` reads their phase and reports the exact
      // next step, which a "cancelled" write would destroy.
      shutdown();
      server.close(() => {
        clearTimeout(watchdog);
        if (restarting) resolveRestart?.();
        else process.exit(0);
      });
      // Drop whatever is still open — including SSE streams, which `close()`
      // alone would wait on — so the process exits promptly. Nothing is
      // being produced any more; there is nothing to drain.
      server.closeAllConnections();
    } catch (err) {
      console.error("[agent-fabric] error during shutdown:", err);
      clearTimeout(watchdog);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  /**
   * Applying the file: the current server is torn down exactly like a signal
   * stop, and `main` is then entered again — which re-reads `config.json`, so
   * a changed listen address or any other boot-time value takes effect.
   */
  function requestRestart(): void {
    if (stopping) return;
    console.log("[agent-fabric] configuration applied — restarting");
    restarting = true;
    stop("restart");
  }

  return {
    restart: () =>
      new Promise<void>((resolve) => {
        resolveRestart = resolve;
      }),
  };
}

async function run(): Promise<void> {
  for (;;) {
    const handle = await main();
    await handle.restart();
  }
}

run().catch((err) => {
  console.error("[agent-fabric] failed to start:", err);
  process.exit(1);
});
