import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./app.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

/** Bound for the whole shutdown; the process exits even if a step hangs. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Loopback hosts. Anything else is reachable from the network. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

async function main(): Promise<void> {
  // Data lives in a stable per-user directory so the store does not move
  // with whatever cwd the server happened to be started from.
  const dataDir = process.env.AGENTFABRIC_DATA_DIR ?? join(homedir(), ".fabric");
  // Loopback by default: this server holds every configured credential and
  // can start processes, so it must not be reachable from the network unless
  // the operator says so explicitly.
  const host = process.env.AGENTFABRIC_HOST ?? "127.0.0.1";
  const port = Number(process.env.AGENTFABRIC_PORT ?? 7377);

  // Serve the built web UI if it exists (packages/web/dist).
  const distCandidates = [
    resolve(__dirname, "../../web/dist"),
    resolve(process.cwd(), "web/dist"),
    resolve(process.cwd(), "dist/web"),
  ];
  const staticDir = distCandidates.find((d) => existsSync(resolve(d, "index.html")));

  const { app, shutdown } = await createServer({ dataDir, staticDir });
  const server = app.listen(port, host, () => {
    console.log(`[agent-fabric] API server listening on http://${host}:${port}`);
    console.log(`[agent-fabric] Data directory: ${dataDir}`);
    console.log(`[agent-fabric] Web UI: ${staticDir ? `http://localhost:${port}` : "(not built; run npm run build -w @agentfabric/web)"}`);
    if (!LOOPBACK_HOSTS.has(host)) {
      console.warn(
        `[agent-fabric] WARNING: bound to ${host}, not loopback — this server is reachable from the network, ` +
          `and the API token is the only thing protecting every configured credential, workspace and process. ` +
          `Unset AGENTFABRIC_HOST to listen on 127.0.0.1 only.`
      );
    }
  });

  let stopping = false;
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
        process.exit(0);
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
}

main().catch((err) => {
  console.error("[agent-fabric] failed to start:", err);
  process.exit(1);
});
