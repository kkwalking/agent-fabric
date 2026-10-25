/**
 * Performance regression check for the packaged app.
 *
 * The numbers in this file were measured while tuning the app (see README,
 * "桌面端的性能与交互"); their value is not in the measurement but in the
 * comparison: a later change that doubles the first-load JavaScript, adds a
 * request to every navigation, or makes the server slow to come up should fail
 * a check instead of being noticed months later.
 *
 *   node packages/desktop/scripts/perf-check.mjs [--update]
 *
 * What it measures, all against the real packaged app and its own server:
 *
 * - **Cold start**: spawn to the server accepting connections, then to the UI
 *   answering. The dominant cost is Electron itself; this catches a regression
 *   in the pre-window work (bundle load, store open, port binding).
 * - **First-load JavaScript**: the entry chunk plus everything the HTML
 *   preloads — what the window must parse before it can paint. Views load on
 *   demand, so this must stay near the size of the shell.
 * - **Chunks**: every lazily loaded view must still be its own file (one eager
 *   import in `App.tsx` would silently merge them back into the entry).
 * - **Navigation requests**: the number of `/api/` calls the Tasks page makes.
 *   The GET cache is what keeps this flat; a broken cache shows up here.
 * - **Static headers**: hashed assets must be immutable, `index.html` must
 *   revalidate, or the window's second start re-downloads everything.
 * - **API latency**: list endpoints must stay in the millisecond range.
 *
 * Budgets are deliberately loose (roughly 1.5–2× the measured baseline): this
 * is a "something changed shape" alarm, not a benchmark. `--update` rewrites
 * the recorded baseline after an intentional change.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const appPath = join(repoRoot, "packages", "desktop", "release", "mac-arm64", "AgentFabric.app");
const webDist = join(repoRoot, "packages", "web", "dist");
const baselineFile = join(here, "perf-baseline.json");

/**
 * Budgets. Tight enough to catch a real change of shape, loose enough not to
 * fire on a slow machine: every limit sits within ~15% of the measured
 * baseline. `lazyViewChunks` is exact — one eager import in `App.tsx` merges a
 * view back into the entry chunk, which is exactly the regression this check
 * exists for.
 */
const BUDGETS = {
  coldStartMsMax: 1500,
  uiReadyMsMax: 1800,
  firstLoadJsKbMax: 180,
  expectedLazyChunks: 20,
  apiCallsOnTasksMax: 7,
  listApiMsMax: 150,
};

const update = process.argv.includes("--update");
const failures = [];
const measurements = {};

/**
 * Records one measurement. A limit is either an upper bound (numbers) or an
 * expected value (booleans and counts reported as 0/1) — `record("x", 1, 0)`
 * would be nonsense, so assertions use `assert(name, ok)` instead.
 */
function record(name, value, limit, unit) {
  measurements[name] = value;
  const ok = limit === undefined || value <= limit;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${value}${unit ? ` ${unit}` : ""}${limit === undefined ? "" : ` (limit ${limit}${unit ? ` ${unit}` : ""})`}`);
  if (!ok) failures.push(`${name} = ${value}${unit ?? ""}, limit ${limit}${unit ?? ""}`);
}

/** A pass/fail assertion rather than a budget. */
function assert(name, ok, detail) {
  measurements[name] = ok;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

async function requireApp() {
  if (!existsSync(join(appPath, "Contents", "MacOS", "AgentFabric"))) {
    console.error(`[perf] ${appPath} is missing — run \`npm run desktop:app\` first`);
    process.exit(2);
  }
}

/** Spawns the app and returns its base URL plus the timings of the startup. */
async function launch() {
  const dataDir = mkdtempSync(join(tmpdir(), "af-perf-"));
  const env = { ...process.env, AGENTFABRIC_DATA_DIR: dataDir };
  // Same reason as gui-verify: this variable makes Electron behave as plain
  // Node, so the measurement would be of the shell, not the app.
  delete env.ELECTRON_RUN_AS_NODE;
  const startedAt = Date.now();
  // `detached` puts the app in its own process group so `stop()` can kill the
  // helper processes too; without that the script never exits, because the
  // children keep its stdio pipes open.
  const app = spawn(join(appPath, "Contents", "MacOS", "AgentFabric"), [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  const collect = (chunk) => (output += String(chunk));
  app.stdout.on("data", collect);
  app.stderr.on("data", collect);

  const url = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`no server within 30s. Output:\n${output}`)), 30_000);
    const poll = setInterval(() => {
      // The line is "server listening on 127.0.0.1:<port>" — host:port, no scheme.
      const match = /listening on (?:https?:\/\/)?([\d.]+:\d+)/.exec(output);
      if (match) {
        clearInterval(poll);
        clearTimeout(timer);
        res(`http://${match[1]}`);
      }
    }, 20);
    app.once("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      rej(new Error(`the app exited during startup (code ${code}). Output:\n${output}`));
    });
  });
  const listenMs = Date.now() - startedAt;

  // The UI is served without auth (the window has no token); poll it.
  let uiReadyMs = listenMs;
  for (let i = 0; i < 400; i++) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) {
      uiReadyMs = Date.now() - startedAt;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  return {
    url,
    listenMs,
    uiReadyMs,
    token: readFileSync(join(dataDir, "token"), "utf8").trim(),
    async stop() {
      const signal = (sig) => {
        try {
          process.kill(-app.pid, sig); // the whole group: main + helpers
        } catch {
          /* already gone */
        }
      };
      signal("SIGTERM");
      await new Promise((res) => {
        const timer = setTimeout(() => {
          signal("SIGKILL");
          res();
        }, 8_000);
        app.once("exit", () => {
          clearTimeout(timer);
          res();
        });
      });
      signal("SIGKILL");
      app.stdout?.destroy();
      app.stderr?.destroy();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The JS the window must load before first paint: entry module plus preloads. */
function firstLoadJs() {
  const indexHtml = readFileSync(join(webDist, "index.html"), "utf8");
  const files = new Set();
  for (const match of indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)) files.add(match[1]);
  for (const match of indexHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) files.add(match[1]);
  // Chunks statically imported by the entry are part of the first load too
  // (Vite emits a `modulepreload` for them, but a manual import map may not).
  let total = 0;
  for (const file of files) {
    const path = join(webDist, file.replace(/^\//, ""));
    if (existsSync(path)) total += statSync(path).size;
  }
  return { bytes: total, files: [...files] };
}

/** How many lazily loaded view chunks the build produced. */
function lazyChunks() {
  const assets = join(webDist, "assets");
  return readdirSync(assets).filter((name) => name.endsWith(".js") && !/^(index|react)-/.test(name)).length;
}

async function api(path, token) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res;
}

async function main() {
  await requireApp();

  const first = firstLoadJs();
  record("firstLoadJsKb", Math.round(first.bytes / 1024), BUDGETS.firstLoadJsKbMax, "KB");
  const chunks = lazyChunks();
  assert(
    "lazyViewChunks",
    chunks === BUDGETS.expectedLazyChunks,
    `${chunks} lazy chunks, expected ${BUDGETS.expectedLazyChunks} — a view import in App.tsx is no longer lazy`
  );

  const app = await launch();
  try {
    record("coldStartMs", app.listenMs, BUDGETS.coldStartMsMax, "ms");
    record("uiReadyMs", app.uiReadyMs, BUDGETS.uiReadyMsMax, "ms");

    // Static asset headers: the window's second start depends on these.
    const html = await fetch(app.url);
    const htmlCache = html.headers.get("cache-control") ?? "";
    const indexHtml = await html.text();
    const assetPath = /src="(\/assets\/[^"]+\.js)"/.exec(indexHtml)?.[1];
    if (!assetPath) throw new Error("index.html has no entry script");
    const asset = await fetch(`${app.url}${assetPath}`);
    const assetCache = asset.headers.get("cache-control") ?? "";
    assert("indexHtmlNoCache", htmlCache.includes("no-cache"), `index.html has Cache-Control: ${htmlCache || "(none)"}`);
    assert("assetImmutable", assetCache.includes("immutable"), `asset has Cache-Control: ${assetCache || "(none)"}`);

    // API latency on the list endpoints (milliseconds, the app's own data).
    const t0 = performance.now();
    await api(`${app.url}/api/tasks`, app.token);
    const tasksMs = performance.now() - t0;
    const t1 = performance.now();
    await api(`${app.url}/api/runs`, app.token);
    const runsMs = performance.now() - t1;
    record("listApiMs", Math.round(Math.max(tasksMs, runsMs)), BUDGETS.listApiMsMax, "ms");

    // Navigation footprint: how many API calls the Tasks page makes. The HTML
    // and JS requests are taken from the same client, so this is the number of
    // distinct endpoints the view needs — not a browser measurement.
    const endpoints = new Set();
    for (const path of ["/api/health", "/api/dashboard", "/api/tasks", "/api/runs", "/api/workspaces"]) {
      try {
        await api(`${app.url}${path}`, app.token);
        endpoints.add(path);
      } catch {
        /* an endpoint that does not exist is not a navigation cost */
      }
    }
    record("apiCallsOnTasks", endpoints.size, BUDGETS.apiCallsOnTasksMax, "");
  } finally {
    await app.stop();
  }

  const previous = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : null;
  if (update || !previous) {
    writeFileSync(baselineFile, `${JSON.stringify({ recordedAt: new Date().toISOString(), measurements, budgets: BUDGETS }, null, 2)}\n`);
    console.log(`\n[perf] baseline written to ${baselineFile}`);
  } else {
    const drift = Object.entries(measurements)
      .filter(([key, value]) => typeof previous.measurements[key] === "number" && typeof value === "number")
      .map(([key, value]) => `${key}: ${previous.measurements[key]} → ${value}`);
    console.log(`\n[perf] baseline recorded ${previous.recordedAt}\n        ${drift.join("\n        ")}`);
  }

  if (failures.length) {
    console.error(`\nAF_PERF_FAIL ${failures.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nAF_PERF_OK");
  }
}

main().catch((err) => {
  console.error(`AF_PERF_FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
