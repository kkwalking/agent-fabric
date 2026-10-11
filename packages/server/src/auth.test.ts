/**
 * Local API authentication (auth.ts + the app wiring).
 *
 * These run the real Express app on a random loopback port and speak to it
 * over `node:http`/`fetch` — no supertest, no new dependency. Every server
 * owns a temporary data directory; `~/.fabric` is never touched.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, createServer } from "./app.js";
import { loadOrCreateToken, tokenPath } from "./auth.js";
import { descendantPids, killDescendants } from "./shutdown.js";

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

  test("case variants of an API path are still authenticated", async () => {
    // Express's router matches routes case-insensitively, so `/API/tasks`
    // runs the same handler as `/api/tasks` — the auth gate must not be
    // the one place that treats them as different paths.
    for (const path of ["/API/tasks", "/Api/tasks"]) {
      const res = await fetch(`${running.base}${path}`);
      assert.equal(res.status, 401, `${path} must not bypass auth`);
    }
    // The health exemption applies to the same path in any case, too.
    const health = await fetch(`${running.base}/API/health`);
    assert.equal(health.status, 200);
  });

  test("a malformed JSON body answers 400, not 500", async () => {
    const res = await fetch(`${running.base}/api/tasks`, {
      method: "POST",
      headers: { ...bearer(running.token), "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "invalid-request");
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

describe("config round-trip", () => {
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

  const WEBHOOK = "https://webhook.invalid/hooks/team-channel/supersecret";
  const put = (body: unknown) =>
    fetch(`${running.base}/api/config`, {
      method: "PUT",
      headers: { ...bearer(running.token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = async () => (await (await fetch(`${running.base}/api/config`, { headers: bearer(running.token) })).json()) as Record<string, any>;

  test("the read redacts the webhook URL but says whether one is set", async () => {
    await put({ notifications: { enabled: true, url: WEBHOOK } });
    const body = await get();
    assert.equal(body.notifications.url, "https://webhook.invalid/***");
    assert.equal(body.notifications.urlSet, true);
  });

  test("editing another field by round-trip does not clobber the stored URL", async () => {
    // `af config <key> <value>` and the Settings page both GET the document,
    // change one field and PUT the whole thing back. The redacted URL comes
    // back with it, and the placeholder is a syntactically valid URL — so
    // storing it verbatim would silently replace the real webhook.
    await put({ notifications: { enabled: true, url: WEBHOOK } });
    const fetched = await get();
    fetched.notifications.timeoutMs = 4321;
    const res = await put(fetched);
    assert.equal(res.status, 200);

    const after = await get();
    assert.equal(after.notifications.urlSet, true, "the webhook is still configured");
    assert.equal(after.notifications.timeoutMs, 4321, "the edit landed");

    // The real value survives: a delivery attempt still targets it.
    const db = readFileSync(join(running.dataDir, "db.json"), "utf8");
    assert.match(db, /supersecret/, "the stored URL is untouched by the round-trip");
    assert.equal(db.includes("webhook.invalid/***"), false, "the redacted placeholder was never persisted");
  });

  test("a genuinely new URL is stored as sent", async () => {
    await put({ notifications: { enabled: true, url: WEBHOOK } });
    await put({ notifications: { enabled: true, url: "https://example.test/other-hook" } });
    const db = readFileSync(join(running.dataDir, "db.json"), "utf8");
    assert.match(db, /other-hook/);
    assert.equal(db.includes("supersecret"), false, "the old URL was replaced, not kept alongside");
  });

  test("header values are redacted on read and restored on round-trip", async () => {
    // A webhook commonly authenticates with `Authorization: Bearer …` — a
    // header value is credential material, so the read must not echo it.
    await put({
      notifications: { enabled: true, url: WEBHOOK, headers: { Authorization: "Bearer hdr-secret-token", "X-Route": "team-a" } },
    });
    const fetched = await get();
    assert.equal(fetched.notifications.headers.Authorization, "***");
    assert.equal(fetched.notifications.headers["X-Route"], "***");

    // The settings round-trip sends the masks back; the stored values must
    // survive, matched by header name.
    fetched.notifications.timeoutMs = 999;
    const res = await put(fetched);
    assert.equal(res.status, 200);
    const db = readFileSync(join(running.dataDir, "db.json"), "utf8");
    assert.match(db, /hdr-secret-token/, "the real header value survived the round-trip");
    assert.match(db, /team-a/);
    assert.equal(db.includes('"Authorization":"***"'), false, "the mask was never persisted");

    // A genuinely new header value replaces the stored one.
    await put({ notifications: { enabled: true, url: WEBHOOK, headers: { Authorization: "Bearer new-token" } } });
    const db2 = readFileSync(join(running.dataDir, "db.json"), "utf8");
    assert.match(db2, /new-token/);
    assert.equal(db2.includes("hdr-secret-token"), false);
  });

  test("a masked header with no stored value is refused, not stored as the mask", async () => {
    const res = await put({ notifications: { enabled: true, url: WEBHOOK, headers: { "X-New": "***" } } });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "config-invalid");
  });

  test("a non-string URL or malformed notifications shape is refused", async () => {
    for (const body of [
      { notifications: { enabled: true, url: 12345 } },
      { notifications: "enabled" },
      { notifications: { enabled: true, headers: "nope" } },
    ]) {
      const res = await put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(((await res.json()) as { code?: string }).code, "config-invalid");
    }
    // The refused writes must not have poisoned the stored config: the
    // read still answers with the previous, valid document.
    const after = await get();
    assert.equal(after.notifications.urlSet, true);
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

describe("async handler failures", () => {
  test("answer 500 instead of leaving the request hanging", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "af-fail-"));
    let restore = false;
    try {
      const app = await createApp({ dataDir });
      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const token = readFileSync(tokenPath(dataDir), "utf8").trim();

      // Make the store's atomic write fail: no temp file can be created in a
      // read-only data directory. This is the exact failure the error
      // middleware exists for — an `await` inside a handler rejecting.
      chmodSync(dataDir, 0o500);
      restore = true;
      let writable = false;
      try {
        writeFileSync(join(dataDir, "probe"), "x");
        writable = true;
      } catch {
        writable = false;
      }
      if (writable) return; // running as root: the directory stays writable, nothing to assert

      const providers = (await (
        await fetch(`${base}/api/providers`, { headers: bearer(token) })
      ).json()) as Array<{ id: string }>;
      const id = providers[0].id;

      // `POST /api/providers/:id/enable` writes to the store through an `ah`
      // wrapper. Without the wrapper and the error middleware this request
      // would hang forever.
      const res = await withTimeout(
        fetch(`${base}/api/providers/${id}/enable`, { method: "POST", headers: bearer(token) }),
        5_000
      );
      assert.equal(res.status, 500);
      assert.equal(((await res.json()) as { code?: string }).code, "internal-error");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      if (restore) chmodSync(dataDir, 0o700);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("shutdown teardown", () => {
  test("stops the process tree a run started", async () => {
    // A stand-in for a harness CLI: the shell spawns a grandchild, exactly
    // like a harness spawning its own helpers.
    const child = spawn("sh", ["-c", "sleep 60"], { stdio: "ignore" });
    try {
      await once(child, "spawn");
      const pids = descendantPids(process.pid);
      assert.ok(pids.includes(child.pid!), `expected ${child.pid} among ${pids.join(",")}`);
      const killed = killDescendants(process.pid);
      assert.ok(killed.includes(child.pid!));
      await once(child, "exit");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("is a no-op when nothing is running, and idempotent", async () => {
    const savedDockerBin = process.env.AGENTFABRIC_DOCKER_BIN;
    process.env.AGENTFABRIC_DOCKER_BIN = NO_DOCKER;
    const dataDir = mkdtempSync(join(tmpdir(), "af-shutdown-"));
    try {
      const { shutdown } = await createServer({ dataDir });
      // Nothing is running: the teardown must not throw, and must not probe
      // docker for containers it has no reason to touch.
      shutdown();
      shutdown();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      if (savedDockerBin === undefined) delete process.env.AGENTFABRIC_DOCKER_BIN;
      else process.env.AGENTFABRIC_DOCKER_BIN = savedDockerBin;
    }
  });

  test("stops an in-flight run without recording it as a user cancellation", async () => {
    const savedDockerBin = process.env.AGENTFABRIC_DOCKER_BIN;
    process.env.AGENTFABRIC_DOCKER_BIN = NO_DOCKER;
    const dataDir = mkdtempSync(join(tmpdir(), "af-shutdown-run-"));
    let server: Server | undefined;
    try {
      const handle = await createServer({ dataDir });
      server = await new Promise<Server>((resolve) => {
        const s = handle.app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const token = readFileSync(tokenPath(dataDir), "utf8").trim();
      const headers = { ...bearer(token), "Content-Type": "application/json" };

      // A mock runtime that runs long enough to still be executing.
      const created = await fetch(`${base}/api/runtimes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Slow Mock", kind: "mock", enabled: true, usableInTask: true, config: { modelCalls: 60, delayMs: 700 } }),
      });
      const runtime = (await created.json()) as { id: string };
      const submitted = (await (
        await fetch(`${base}/api/runs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ runtimeId: runtime.id, prompt: "long running work" }),
        })
      ).json()) as { run: { id: string } };
      const runId = submitted.run.id;

      // Wait until the run is genuinely executing.
      const deadline = Date.now() + 10_000;
      let status = "pending";
      while (status !== "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        status = ((await (await fetch(`${base}/api/runs/${runId}`, { headers: bearer(token) })).json()) as { status: string }).status;
      }
      assert.equal(status, "running", "the run never started executing");

      handle.shutdown();

      const after = (await (await fetch(`${base}/api/runs/${runId}`, { headers: bearer(token) })).json()) as { status: string; error?: string };
      // The whole point: a shutdown is not a user action (v11 §32). The run
      // keeps its non-terminal state so the next start's
      // `recoverInterrupted()` can read the task's phase and name the honest
      // next step.
      assert.notEqual(after.status, "cancelled", "a shutdown must never be recorded as a user cancellation");
      assert.equal(after.status, "running");
      assert.equal(after.error, undefined);
    } finally {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      rmSync(dataDir, { recursive: true, force: true });
      if (savedDockerBin === undefined) delete process.env.AGENTFABRIC_DOCKER_BIN;
      else process.env.AGENTFABRIC_DOCKER_BIN = savedDockerBin;
    }
  });
});

/** A promise that rejects if `work` does not settle in time (no hanging test). */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`request did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits for one named event (avoids importing node:events for two uses). */
function once(emitter: { once(event: string, listener: (...args: never[]) => void): unknown }, event: string): Promise<unknown> {
  return new Promise((resolve) => emitter.once(event, resolve));
}
