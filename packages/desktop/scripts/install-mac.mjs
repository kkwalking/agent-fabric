/**
 * Installs the packaged app into /Applications: `npm run desktop:install`.
 *
 * This is the step after `dist:mac` that a person would otherwise do by hand in
 * Finder, and doing it by hand is where the two avoidable failures live:
 *
 * 1. Replacing a *running* app leaves the old process serving the old code and
 *    the new bundle half-referenced. So the running copy is quit first, and the
 *    quit is the graceful one: the app's `before-quit` shuts its server down.
 * 2. An `identity: null` build (see electron-builder.yml.js) carries Electron's
 *    own ad-hoc signature on the binary but no `Contents/_CodeSignature`, which
 *    does not verify and can make the app refuse to start. Re-signing ad-hoc
 *    after the copy fixes it, and this script always does that rather than
 *    leaving it as a "known limitation" someone has to remember.
 *
 * Steps: quit → copy the .app from the (verified) build output → ad-hoc re-sign
 * → clear quarantine → prove the installed bundle serves its API → drive the
 * installed window end to end (`verify-ui.mjs`).
 *
 * Options:
 *   --dmg         install from the built dmg instead of release/mac-<arch>/.app
 *   --no-launch   copy and verify without starting the app afterwards
 *   --no-ui       skip the window-level check (smoke launch only)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const target = "/Applications/AgentFabric.app";
const args = process.argv.slice(2);
const fromDmg = args.includes("--dmg");
const launch = !args.includes("--no-launch");
const uiCheck = !args.includes("--no-ui");
const arch = process.arch === "arm64" ? "arm64" : "x64";

if (process.platform !== "darwin") {
  console.error("[install] the macOS app can only be installed on macOS");
  process.exit(1);
}

/** Runs a command and returns its stdout; a non-zero status throws. */
function run(command, argv, opts = {}) {
  return execFileSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** Runs a command, ignoring failure — used for steps that are advisory. */
function tryRun(command, argv) {
  try {
    return run(command, argv);
  } catch {
    return "";
  }
}

/** Waits until `predicate` is true, polling; returns false on timeout. */
async function waitFor(predicate, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((done) => setTimeout(done, stepMs));
  }
  return false;
}

// 1. Quit the running copy. `osascript` asks the app itself to quit, which runs
//    its `before-quit` handler (server shutdown, window state saved); killing the
//    process would skip that and leave the server socket held for a moment.
if (existsSync(target)) {
  if (tryRun("pgrep", ["-f", `${target}/Contents/MacOS/AgentFabric`]).trim()) {
    console.log("[install] quitting the running app");
    tryRun("osascript", ["-e", 'tell application id "com.agentfabric.desktop" to quit']);
    const gone = await waitFor(() => !tryRun("pgrep", ["-f", `${target}/Contents/MacOS/AgentFabric`]).trim(), 15_000);
    if (!gone) {
      // A wedged instance still holds the bundle: stop it, since the copy below
      // would otherwise produce an app that cannot start (single-instance lock).
      console.log("[install] it did not quit in 15s — terminating it");
      tryRun("pkill", ["-f", `${target}/Contents/MacOS/AgentFabric`]);
      await waitFor(() => !tryRun("pgrep", ["-f", `${target}/Contents/MacOS/AgentFabric`]).trim(), 5000);
    }
  }
}

// 2. Copy the bundle to /Applications.
let sourceApp;
let mountPoint;
if (fromDmg) {
  const dmg = join(desktopRoot, "release", `AgentFabric-${arch}.dmg`);
  if (!existsSync(dmg)) {
    console.error(`[install] no dmg at ${dmg} — run \`npm run desktop:dmg\` first`);
    process.exit(1);
  }
  mountPoint = join(tryRun("mktemp", ["-d"]).trim(), "mnt");
  run("mkdir", ["-p", mountPoint]);
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmg]);
  sourceApp = join(mountPoint, "AgentFabric.app");
} else {
  sourceApp = join(desktopRoot, "release", `mac-${arch}`, "AgentFabric.app");
}
if (!existsSync(sourceApp)) {
  console.error(`[install] no app bundle at ${sourceApp} — run \`npm run desktop:dmg\` first`);
  process.exit(1);
}

console.log(`[install] copying ${sourceApp} → ${target}`);
rmSync(target, { recursive: true, force: true });
// `ditto` keeps the bundle layout and extended attributes intact; `cp -R` has
// historically dropped things inside .app trees.
run("ditto", [sourceApp, target]);
if (mountPoint) {
  tryRun("diskutil", ["eject", mountPoint]);
  rmSync(dirname(mountPoint), { recursive: true, force: true });
}

// 3. Ad-hoc re-sign. Without this the copy carries a signature that does not
//    verify (see the file header), and macOS may refuse to start it.
console.log("[install] signing ad-hoc");
run("codesign", ["--force", "--deep", "--sign", "-", target]);
tryRun("codesign", ["--verify", "--deep", "--strict", target]);

// 4. Quarantine: the bundle was built locally, but a dmg path can still carry it.
tryRun("xattr", ["-dr", "com.apple.quarantine", target]);

// 5. Prove the installed bundle actually serves its API. The app picks a free
//    port, so the port is read from its own log line rather than guessed.
if (launch) {
  const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version;
  const binary = join(target, "Contents/MacOS/AgentFabric");
  console.log(`[install] smoke-launching ${target} (v${version})`);
  // No ELECTRON_RUN_AS_NODE: an inherited one turns the app into a plain Node
  // process with no window (see src/main.js).
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = (await import("node:child_process")).spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => (log += String(chunk)));
  child.stderr.on("data", (chunk) => (log += String(chunk)));
  const portOf = () => /listening on 127\.0\.0\.1:(\d+)/.exec(log)?.[1];
  try {
    // Every wait has a duration, and every request a deadline: a wedged app (or
    // a port that accepts the connection but never answers) must fail the
    // install instead of hanging it — this script already hung once that way.
    const listening = await waitFor(() => portOf() !== undefined, 30_000);
    if (!listening) throw new Error(`the app never reported a listening port. Output:\n${log || "(none)"}`);
    const port = portOf();
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) });
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!page.ok) throw new Error(`the app did not serve its UI (status ${page.status})`);
    if (!health.ok) throw new Error(`/api/health answered ${health.status}`);
    console.log(`[install] ok — UI ${page.status}, /api/health ${health.status} on 127.0.0.1:${port}`);
  } finally {
    // Escalate: a SIGTERM-only kill leaves an app that ignores it running, and
    // the next step (and the next install) would meet a live single-instance
    // lock.
    child.kill("SIGTERM");
    const exited = await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000);
    if (!exited) child.kill("SIGKILL");
  }
}

// 6. Drive the installed window: the smoke launch proves the server answers, but
//    not that the pages the user opens actually work. `verify-ui.mjs` clicks
//    through the shipped UI against a scratch data directory.
if (uiCheck) {
  console.log("[install] checking the installed UI end to end");
  // Asynchronous on purpose: the check launches its own copy of the app and has
  // to wait for it, which a synchronous child-process call cannot do.
  const { spawn } = await import("node:child_process");
  await new Promise((ok, fail) => {
    const checker = spawn(process.execPath, [join(here, "verify-ui.mjs"), target], { stdio: "inherit" });
    checker.once("error", fail);
    checker.once("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`verify-ui exited with code ${code} — the installed UI has a problem`))
    );
  });
  console.log("[install] UI check passed");
}

console.log(`[install] done: ${target}`);
console.log("[install] open it from Finder or the Dock (a launch through LaunchServices from a non-GUI shell is not reliable).");
