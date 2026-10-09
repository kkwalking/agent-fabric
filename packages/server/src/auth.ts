/**
 * Local API authentication.
 *
 * The API server holds every credential the user has configured (Provider
 * API keys, Git tokens, secrets) and can start processes. Binding it to
 * loopback is not enough on its own: any web page the user visits could
 * reach `http://127.0.0.1:7377/api/...` from their browser, so every
 * `/api/*` request must present a token that only a local reader of the
 * data directory knows.
 *
 * The token is generated once per data directory and lives in
 * `<dataDir>/token` (mode 0o600). It is **never** logged, never written into
 * `db.json`, never returned by any endpoint, and never accepted from a query
 * string (a URL lands in logs and shell history).
 *
 * Clients present it either as `Authorization: Bearer <token>` (CLI, e2e
 * scripts, the vite dev proxy) or as the `af_token` cookie the server sets
 * on the first page load (browser).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Request, RequestHandler } from "express";

/** Cookie the browser carries after loading the page (set by `app.ts`). */
export const TOKEN_COOKIE = "af_token";

/** File holding the token, inside the data directory. */
export function tokenPath(dataDir: string): string {
  return join(dataDir, "token");
}

/**
 * Reads the API token for `dataDir`, generating and persisting one on first
 * start. The file is created with mode 0o600 — only the user who started the
 * server can read it. An existing file is used verbatim: it is the fact, and
 * nothing rewrites or "repairs" it (AGENTS.md).
 */
export async function loadOrCreateToken(dataDir: string): Promise<string> {
  const file = tokenPath(dataDir);
  let existing: string | undefined;
  try {
    existing = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing !== undefined) {
    const token = existing.trim();
    // An empty token would authenticate nobody and lock the user out of a
    // running server with no way to see why (失败要响): say so instead.
    if (token === "") {
      throw new Error(`The API token file ${file} is empty — delete it so a new token is generated`);
    }
    return token;
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, token, { mode: 0o600 });
  return token;
}

/** The token a request presents, or undefined. Never reads a query string. */
function presentedToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  return cookieValue(req.headers.cookie, TOKEN_COOKIE);
}

/** One cookie out of a raw `Cookie:` header (no cookie-parser dependency). */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Constant-time comparison; a length mismatch answers unequal immediately. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // The token's length is public (64 hex chars), so a fast reject is fine.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Rejects any request that does not carry the token. The response body names
 * the failure (`code: "unauthorized"`) and nothing else — no hint about the
 * expected token.
 */
export function requireToken(token: string): RequestHandler {
  return (req, res, next) => {
    if (!tokenMatches(presentedToken(req), token)) {
      res.status(401).json({ error: "Missing or invalid API token", code: "unauthorized" });
      return;
    }
    next();
  };
}
