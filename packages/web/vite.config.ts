import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev-mode auth. The API server authenticates every `/api/*` request except
 * `/api/health` (cookie `af_token`, or `Authorization: Bearer <token>`) and
 * writes the bearer token to `$AGENTFABRIC_DATA_DIR/token` (default
 * `~/.fabric/token`) on first start. In dev the page is served by vite, so
 * the cookie is never set for that origin — attach the bearer token to every
 * proxied request instead. A missing token file must not crash vite: warn
 * loudly and let the API answer 401 until the server has run once.
 */
const tokenFile = join(process.env.AGENTFABRIC_DATA_DIR ?? join(homedir(), ".fabric"), "token");

function readToken(): string | undefined {
  try {
    const token = readFileSync(tokenFile, "utf8").trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

let warnedMissingToken = false;

/**
 * Re-read on every request so that starting the server *after* vite needs no
 * restart; the value is only ever put on a request header, never logged.
 */
function authToken(): string | undefined {
  const token = readToken();
  if (token) {
    warnedMissingToken = false;
    return token;
  }
  if (!warnedMissingToken) {
    warnedMissingToken = true;
    console.warn(
      `[af] dev proxy: no API token at ${tokenFile} — start the server once ` +
        `(\`npm run dev:server\`) to generate it; until then every /api request will get 401.`
    );
  }
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // One entry for the whole `/api` prefix, so SSE endpoints
      // (`/api/events/stream`, `/api/runs/:id/events/stream`) are proxied —
      // and authenticated — exactly like the JSON calls: EventSource issues
      // ordinary GETs, they just arrive on `proxyReq` the same way.
      "/api": {
        target: "http://localhost:7377",
        changeOrigin: true,
        configure(proxy) {
          authToken(); // surface the missing-token warning at startup, not only on the first request
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.headers.authorization) return; // the caller authenticated explicitly
            const token = authToken();
            if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
