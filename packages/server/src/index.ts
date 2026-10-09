import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

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

  const app = await createApp({ dataDir, staticDir });
  app.listen(port, host, () => {
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
}

main().catch((err) => {
  console.error("[agent-fabric] failed to start:", err);
  process.exit(1);
});
