/**
 * Builds the macOS app and disk image: `npm run dist:mac`.
 *
 * Steps, in order, each of which stops the build on failure:
 *
 * 1. Check the host (macOS) and the tools the packaging needs.
 * 2. Build the web UI, the single-file server bundle and the native addon
 *    (`node-pty` for Node's ABI — the server runs in the app's own process).
 * 3. Run the PTY smoke test: start the *bundled* server with the staged addon,
 *    open a board session and confirm a real process spawns and streams bytes
 *    back.
 * 4. Let electron-builder package `AgentFabric.app` (with `afterPack` copying
 *    the Node runtime and re-checking the addon) and the `.dmg`.
 *
 * Options:
 *   --dir          only produce the .app (no dmg)
 *   --arch=<a>     arm64 | x64 (default: this machine's architecture)
 *   --gui-check    also launch the packaged app from this (GUI) session and
 *                  wait until it serves its UI — see scripts/gui-verify.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDmg } from "./build-dmg.mjs";
import { verifyApp } from "./verify-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
// The app version is the desktop package's own version (what electron-builder
// stamps into the bundle and names the artifacts after).
const { version } = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));

const args = process.argv.slice(2);
const dirOnly = args.includes("--dir");
const guiCheck = args.includes("--gui-check");
const archArg = args.find((arg) => arg.startsWith("--arch="))?.slice("--arch=".length);
const arch = archArg ?? (process.arch === "arm64" ? "arm64" : "x64");

if (process.platform !== "darwin") {
  console.error("[desktop] the macOS app can only be built on macOS");
  process.exit(1);
}
if (arch !== "arm64" && arch !== "x64") {
  console.error(`[desktop] unknown arch "${arch}" (expected arm64 or x64)`);
  process.exit(1);
}

/** Runs a command from the repository root, inheriting stdio. */
function run(command, argv, extraEnv = {}) {
  console.log(`\n[desktop] $ ${[command, ...argv].join(" ")}`);
  const result = spawnSync(command, argv, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`[desktop] failed: ${command} ${argv.join(" ")} (exit ${result.status ?? result.signal})`);
    process.exit(result.status ?? 1);
  }
}

// 1. Tools.
const electronBinary = join(repoRoot, "node_modules/electron/cli.js");
if (!existsSync(electronBinary)) {
  console.error("[desktop] electron is not installed — run `npm install` (see README for the ELECTRON_MIRROR note)");
  process.exit(1);
}
if (!existsSync(join(repoRoot, "node_modules/electron-builder/out/cli/cli.js"))) {
  console.error("[desktop] electron-builder is not installed — run `npm install`");
  process.exit(1);
}

// 2. Artifacts the app ships: the web UI, the native addon, then the bundle
//    (which stages the addon next to itself).
run("npm", ["run", "build", "-w", "@agentfabric/web"]);
run("node", [join(desktopRoot, "scripts/build-native.mjs")]);
run("node", [join(desktopRoot, "scripts/build-backend.mjs")]);

// 3. Prove the packaged server can run a PTY before paying for packaging.
run("node", [join(desktopRoot, "scripts/smoke-pty.mjs")]);

// 4. Package. electron-builder lays out the Electron runtime, helper apps and
//    app.asar (the .app); the dmg is `hdiutil` (see scripts/build-dmg.mjs).
const builderCli = join(repoRoot, "node_modules/electron-builder/out/cli/cli.js");
const builderArgs = (extra) => [
  builderCli,
  "--mac",
  `--${arch}`,
  "--config",
  join(desktopRoot, "electron-builder.yml.js"),
  // electron-builder otherwise derives the output directory from the package
  // it was invoked from; pin it to the desktop package so `release/` is one
  // predictable place regardless of where the command ran.
  "--projectDir",
  desktopRoot,
  ...extra,
];
const builderEnv = {
  // The first download of the Electron distribution needs a reachable mirror
  // in networks where GitHub is blocked; npm config already points at
  // npmmirror, and Electron honours the same override for its own downloads.
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://registry.npmmirror.com/-/binary/electron/",
};

const appDir = join(desktopRoot, "release", `mac-${arch}`);
const appPath = join(appDir, "AgentFabric.app");
if (dirOnly) {
  run(process.execPath, builderArgs(["--dir"]), builderEnv);
} else {
  // Keep a copy of the app before the dmg target runs: a dmg tooling failure
  // must not cost the .app that was already built successfully.
  run(process.execPath, builderArgs(["--dir"]), builderEnv);
  const dmgPath = join(desktopRoot, "release", `AgentFabric-${arch}.dmg`);

  // 5. Verify the packaged bundle: layout, runtime link, and a bundled server
  //    started on that runtime (UI + API + a real PTY round-trip).
  console.log(`\n[desktop] verifying ${appPath}`);
  const verdict = await verifyApp(appPath);
  console.log(`[desktop] OK  ${verdict}`);

  if (guiCheck) {
    // Opt-in: only meaningful from a logged-in GUI session. This is the one
    // check that exercises the window process itself.
    const logFile = join(tmpdir(), `af-desktop-gui-${Date.now()}.log`);
    console.log(`[desktop] GUI check: launching the app (log: ${logFile})`);
    const gui = spawnSync(process.execPath, [join(desktopRoot, "scripts/gui-verify.mjs"), appPath, logFile], {
      stdio: "inherit",
      env: process.env,
    });
    const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : [];
    const verdictLine = lines.find((line) => line.includes("AF_GUI_VERIFY_OK") || line.includes("AF_GUI_VERIFY_FAIL"));
    if (gui.status !== 0 || !verdictLine?.includes("AF_GUI_VERIFY_OK")) {
      console.error(`[desktop] GUI check failed:\n${lines.join("\n") || "(no log)"}`);
      process.exit(1);
    }
    console.log(`[desktop] OK  ${verdictLine.replace(/^\S+ /, "")}`);
  }

  // 6. The install image.
  buildDmg({ appPath, outFile: dmgPath, volumeName: `AgentFabric ${version}` });
  console.log(`[desktop] OK  dmg at ${dmgPath}`);
}

console.log(`\n[desktop] done. Artifacts in ${join(desktopRoot, "release")}`);
console.log(`[desktop]   app: ${appPath}`);

// Exit deliberately now that the work is finished and printed.
//
// `verifyApp` runs in this process and its PTY round trip leaves a
// `/dev/ptmx` handle open even after the server's shutdown kills the child
// (node-pty on macOS does not close the parent side). That keeps the event
// loop alive, so the build printed "done", wrote a good dmg — and then never
// exited, which looks exactly like hdiutil hanging. Nothing below this point
// needs an orderly teardown, and every failure path above already exits
// loudly, so a plain exit is the right end here.
process.exit(0);
