import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

async function main(): Promise<void> {
  const dataDir = process.env.AGENTFABRIC_DATA_DIR ?? resolve(process.cwd(), "data");
  const host = process.env.AGENTFABRIC_HOST ?? "0.0.0.0";
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
  });
}

main().catch((err) => {
  console.error("[agent-fabric] failed to start:", err);
  process.exit(1);
});
