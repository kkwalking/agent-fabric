/**
 * Local API authentication (auth.ts + the app wiring).
 *
 * These run the real Express app on a random loopback port and speak to it
 * over `node:http`/`fetch` — no supertest, no new dependency. Every server
 * owns a temporary data directory; `~/.fabric` is never touched.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { loadOrCreateToken, tokenPath } from "./auth.js";

/** The fake docker binary: a path that cannot exist, so no probe hangs. */
const NO_DOCKER = join(tmpdir(), "af-test-no-such-docker-binary");

interface Running {
  base: string;
  token: string;
  dataDir: string;
  close(): Promise<void>;
}

async function startApp(): Promise<Running> {
  const dataDir = mkdtempSync(join(tmpdir(), "af-auth-"));
  const app = await createApp({ dataDir });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const token = readFileSync(tokenPath(dataDir), "utf8").trim();
  return {
    base: `http://127.0.0.1:${port}`,
    token,
    dataDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("API authentication", () => {
  let running: Running;
  let savedDockerBin: string | undefined;

  before(async () => {
    savedDockerBin = process.env.AGENTFABRIC_DOCKER_BIN;
    process.env.AGENTFABRIC_DOCKER_BIN = NO_DOCKER;
    running = await startApp();
  });
  after(async () => {
    await running.close();
    if (savedDockerBin === undefined) delete process.env.AGENTFABRIC_DOCKER_BIN;
    else process.env.AGENTFABRIC_DOCKER_BIN = savedDockerBin;
  });

  test("rejects an unauthenticated API request with 401 and code unauthorized", async () => {
    const res = await fetch(`${running.base}/api/tasks`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "unauthorized");
  });

  test("accepts a bearer token", async () => {
    const res = await fetch(`${running.base}/api/tasks`, { headers: bearer(running.token) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test("accepts the af_token cookie", async () => {
    const res = await fetch(`${running.base}/api/tasks`, { headers: { Cookie: `af_token=${running.token}` } });
    assert.equal(res.status, 200);
  });

  test("rejects a wrong token", async () => {
    const res = await fetch(`${running.base}/api/tasks`, { headers: bearer("0".repeat(64)) });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "unauthorized");
  });

  test("never accepts the token from a query string", async () => {
    const res = await fetch(`${running.base}/api/tasks?token=${running.token}`);
    assert.equal(res.status, 401);
  });

  test("exempts GET /api/health from authentication", async () => {
    const res = await fetch(`${running.base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string };
    assert.equal(body.status, "ok");
  });

  test("sets the af_token cookie on a plain page load", async () => {
    const res = await fetch(`${running.base}/`, { redirect: "manual" });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("af_token="));
    assert.ok(cookie, `expected an af_token cookie, got ${JSON.stringify(res.headers.getSetCookie())}`);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });

  test("does not set the cookie on API responses", async () => {
    const res = await fetch(`${running.base}/api/health`);
    assert.deepEqual(res.headers.getSetCookie().filter((c) => c.startsWith("af_token=")), []);
  });

  test("reflects CORS only for loopback origins", async () => {
    const allowed = await fetch(`${running.base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const denied = await fetch(`${running.base}/api/health`, { headers: { Origin: "http://evil.example" } });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  });
});

describe("api-key reveal confirmation", () => {
  let running: Running;
  let savedDockerBin: string | undefined;

  before(async () => {
    savedDockerBin = process.env.AGENTFABRIC_DOCKER_BIN;
    process.env.AGENTFABRIC_DOCKER_BIN = NO_DOCKER;
    running = await startApp();
  });
  after(async () => {
    await running.close();
    if (savedDockerBin === undefined) delete process.env.AGENTFABRIC_DOCKER_BIN;
    else process.env.AGENTFABRIC_DOCKER_BIN = savedDockerBin;
  });

  test("requires the X-AgentFabric-Reveal header even with a valid token", async () => {
    const list = await fetch(`${running.base}/api/providers`, { headers: bearer(running.token) });
    const providers = (await list.json()) as Array<{ id: string }>;
    assert.ok(providers.length > 0, "seedDefaults should have created a provider");
    const id = providers[0].id;

    const refused = await fetch(`${running.base}/api/providers/${id}/api-key`, { headers: bearer(running.token) });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { code?: string }).code, "reveal-not-confirmed");

    const allowed = await fetch(`${running.base}/api/providers/${id}/api-key`, {
      headers: { ...bearer(running.token), "X-AgentFabric-Reveal": "1" },
    });
    assert.equal(allowed.status, 200);
  });
});
describe("token storage", () => {
  test("is generated once, kept at mode 0600 and never written to db.json", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "af-token-"));
    try {
      const first = await loadOrCreateToken(dataDir);
      assert.match(first, /^[0-9a-f]{64}$/);
      assert.equal((statSync(tokenPath(dataDir)).mode & 0o777).toString(8), "600");
      assert.equal(await loadOrCreateToken(dataDir), first, "an existing token is reused, never re-rolled");

      const app = await createApp({ dataDir });
      void app;
      const db = readFileSync(join(dataDir, "db.json"), "utf8");
      assert.equal(db.includes(first), false, "the token must never reach db.json");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
