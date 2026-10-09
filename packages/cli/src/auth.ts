/**
 * Bearer-token resolution for the AgentFabric API.
 *
 * The server writes a 32-byte hex token to `$AGENTFABRIC_DATA_DIR/token`
 * (default `~/.fabric/token`, mode 0600) the first time it starts, and every
 * `/api/*` request except `/api/health` has to present it. Resolution order:
 *
 *   1. an explicit `--token <t>`
 *   2. `$AGENTFABRIC_TOKEN`
 *   3. the token file above
 *
 * A missing token is an error, never a silent unauthenticated request. The
 * token value itself must never be printed anywhere — only its path.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `<dataDir>/token`, where dataDir is `$AGENTFABRIC_DATA_DIR` or `~/.fabric`. */
export function tokenFilePath(): string {
  const dataDir = process.env.AGENTFABRIC_DATA_DIR ?? join(homedir(), ".fabric");
  return join(dataDir, "token");
}

/**
 * Resolve the API token, or throw an actionable error that explains how to
 * obtain one. The thrown message never contains the token (or the value of
 * `AGENTFABRIC_TOKEN`).
 */
export function resolveToken(explicit?: string): string {
  const fromFlag = explicit?.trim();
  if (fromFlag) return fromFlag;

  const fromEnv = process.env.AGENTFABRIC_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const path = tokenFilePath();
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "does not exist" : `could not be read (${code ?? (error as Error).message})`;
    throw new Error(
      `no API token: ${path} ${reason}.\n` +
        `Start the server once (\`npm run dev:server\`) to generate it, or pass --token <t> / set AGENTFABRIC_TOKEN.`
    );
  }
  if (!token) {
    throw new Error(
      `no API token: ${path} is empty.\n` +
        `Start the server once (\`npm run dev:server\`) to generate it, or pass --token <t> / set AGENTFABRIC_TOKEN.`
    );
  }
  return token;
}
