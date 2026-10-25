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
        // Board terminal sessions (v13) are websockets on the same /api
        // prefix; without `ws: true` the dev page cannot open a terminal even
        // though production serves REST, SSE and WS from one port.
        ws: true,
        configure(proxy) {
          authToken(); // surface the missing-token warning at startup, not only on the first request
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.headers.authorization) return; // the caller authenticated explicitly
            const token = authToken();
            if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
          });
          // A browser cannot set headers on a websocket, and the dev origin
          // has no `af_token` cookie for the API server, so the proxy must
          // present the bearer token on the upgrade itself.
          proxy.on("proxyReqWs", (proxyReq) => {
            if (proxyReq.getHeader("authorization")) return;
            const token = authToken();
            if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    // The initial CSS is render-blocking. Splitting it per entry keeps the
    // stylesheet a lazy view needs in that view's own chunk instead of in the
    // file the window must parse before it can paint anything.
    cssCodeSplit: true,
    // Keep a single vendor chunk that changes rarely: the app chunk then
    // re-downloads alone when the UI changes (matters for the dev loop).
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          return undefined;
        },
      },
    },
  },
});
