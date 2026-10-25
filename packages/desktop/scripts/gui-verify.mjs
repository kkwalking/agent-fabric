/**
 * Launches the packaged app in a logged-in GUI session and records what it
 * prints.
 *
 * Capturing an Electron app's startup log has no reliable path without a
 * terminal: a `.app` launched from `Contents/MacOS/AgentFabric` by a
 * headless/automated shell exits during the window-server setup (logged only to
 * the unified log), so the app's own `console.log` never appears. In a
 * GUI-attached session the same binary runs normally.
 *
 * This helper is the *window* half of the packaged-app check: it launches the
 * app like the Dock does, waits until the server it spawns serves the UI and
 * the API, then stops it — writing everything the app prints to a log file and
 * a final verdict line the caller can read:
 *
 *   node packages/desktop/scripts/gui-verify.mjs <appPath> <logFile>
 *
 * Invoked by `build-mac.mjs --gui-check`, which is only meaningful from a
 * logged-in GUI session **whose environment does not set
 * `ELECTRON_RUN_AS_NODE`** (that variable turns Electron into plain Node; the
 * check scrubs it so it tests the app, not the shell). The check is complete when the log ends with
 * `AF_GUI_VERIFY_OK` (or `AF_GUI_VERIFY_FAIL` plus the reason).
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [, , appPathArg, logFileArg] = process.argv;
if (!appPathArg || !logFileArg) {
  console.error("usage: node gui-verify.mjs <appPath> <logFile>");
  process.exit(2);
}

const appPath = resolve(appPathArg);
const logFile = resolve(logFileArg);

// The log is appended, never truncated: the caller may read it while this runs.
function log(line) {
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
}

log(`gui-verify: starting for ${appPath}`);
try {
  log(`AF_GUI_VERIFY_OK ${await launchAndProbe(appPath)}`);
} catch (err) {
  log(`AF_GUI_VERIFY_FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

/** Launches the app like the Dock does and waits until it serves its UI. */
async function launchAndProbe(appPath) {
  const dataDir = mkdtempSync(join(tmpdir(), "af-gui-verify-"));
  // Scrubbed, not just overridden: with `ELECTRON_RUN_AS_NODE` set, Electron
  // runs the main script on plain Node and exits before it logs anything —
  // the check would then measure the environment instead of the app.
  const env = { ...process.env, AGENTFABRIC_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(join(appPath, "Contents", "MacOS", "AgentFabric"), [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
    log(`[app] ${String(chunk).trimEnd()}`);
  };
  app.stdout.on("data", collect);
  app.stderr.on("data", collect);
  try {
    const url = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`no server within 60s. App output:\n${output}`)), 60_000);
      const poll = setInterval(() => {
        const match = /listening on (http:\/\/\S+)/.exec(output);
        const tokenFile = join(dataDir, "token");
        if (match && existsSync(tokenFile)) {
          clearInterval(poll);
          clearTimeout(timer);
          res(match[1].replace(/\/$/, ""));
        }
      }, 250);
      app.once("exit", (code) => {
        clearInterval(poll);
        clearTimeout(timer);
        rej(new Error(`the app exited during startup (code ${code}). App output:\n${output}`));
      });
    });
    const token = readFileSync(join(dataDir, "token"), "utf8").trim();
    const page = await fetch(url);
    const html = await page.text();
    if (!page.ok || !html.includes('<div id="root"')) throw new Error(`the app did not serve the UI (status ${page.status})`);
    const health = await fetch(`${url}/api/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (!health.ok) throw new Error(`/api/health answered ${health.status}`);
    return `the app launched in a GUI session and serves the UI + API at ${url}`;
  } finally {
    app.kill("SIGTERM");
    await new Promise((res) => {
      const timer = setTimeout(() => {
        app.kill("SIGKILL");
        res();
      }, 15_000);
      app.once("exit", () => {
        clearTimeout(timer);
        res();
      });
    });
    rmSync(dataDir, { recursive: true, force: true });
  }
}
