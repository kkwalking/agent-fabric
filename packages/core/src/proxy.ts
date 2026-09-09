import type { ProxyConfig } from "./types.js";

/* ------------------------------------------------------------------ */
/* Global harness proxy (Proxy page)                                   */
/* ------------------------------------------------------------------ */

/**
 * Builds the proxy environment layer injected into newly spawned harness
 * processes when the Proxy page toggle is on.
 *
 * - Standard variable set: HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (upper
 *   and lowercase) — the only channel every harness honors uniformly
 *   (Codex's WebSocket transport in particular ignores the macOS system
 *   proxy but reads these).
 * - NO_PROXY always safeguards loopback destinations so local MCP
 *   servers and hooks are never pushed through the proxy.
 * - `containerized` rewrites a loopback proxy host to
 *   host.docker.internal: 127.0.0.1 inside a container is the container
 *   itself, not the host machine running the proxy.
 *
 * The result merges as the *lowest* layer of the run env (explicit
 * task/run env wins) and is resolved at spawn time, so toggling the
 * proxy affects subsequent runs only.
 */

const PROXY_URL_VARS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

const NO_PROXY_VALUE = "localhost,127.0.0.1,::1";

export function buildProxyEnv(proxy: ProxyConfig | undefined, containerized = false): Record<string, string> {
  if (!proxy?.enabled) return {};
  const host = proxy.host?.trim();
  const port = proxy.port;
  if (!host || !port || port < 1 || port > 65535) return {};
  const resolvedHost =
    containerized && (host === "127.0.0.1" || host === "localhost" || host === "::1")
      ? "host.docker.internal"
      : host;
  const url = `${proxy.scheme === "socks5" ? "socks5" : "http"}://${resolvedHost}:${port}`;
  const env: Record<string, string> = {};
  for (const name of PROXY_URL_VARS) env[name] = url;
  env.NO_PROXY = NO_PROXY_VALUE;
  env.no_proxy = NO_PROXY_VALUE;
  return env;
}
