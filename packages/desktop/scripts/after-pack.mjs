/**
 * electron-builder `afterPack` hook (macOS).
 *
 * The app runs the bundled server **in its own process** (see `src/main.mjs`),
 * so everything here is about making that process honest:
 *
 * 1. **The native PTY addon must be built for Node's ABI.** `node-pty` is
 *    compiled against Node (`scripts/build-native.mjs`); a binary built against
 *    Electron would fail to load in-process. The addon inside the packaged app
 *    is loaded here with the packaging host's Node — same ABI as the server —
 *    and if it cannot spawn a process the build stops. (A prebuilt-for-Electron
 *    addon can load here by accident when Electron's ABI number happens to
 *    match the host Node's; the `--target` used by the build script is what
 *    makes the match intentional.)
 * 2. **`node-pty`'s `spawn-helper` must be executable.** npm strips the bit in
 *    some configurations, and without it every PTY spawn fails with
 *    "posix_spawnp failed" while `require` still succeeds.
 * 3. **The bundle must be complete.** The server, the web UI and the addon are
 *    checked before the app is packaged into the dmg.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    // The desktop target is macOS-only; other platforms have no configured
    // runtime layout yet, and silently packaging an app whose server cannot
    // start would be worse than failing.
    throw new Error(`packages/desktop only supports darwin, got ${context.electronPlatformName}`);
  }

  const appBundle = join(context.appOutDir, "AgentFabric.app");
  const resourcesDir = join(appBundle, "Contents", "Resources");
  const ptyDir = join(resourcesDir, "backend", "node_modules", "node-pty");

  for (const path of [
    join(resourcesDir, "backend", "server.cjs"),
    join(resourcesDir, "web", "index.html"),
    join(ptyDir, "package.json"),
    join(resourcesDir, "app.asar"),
  ]) {
    if (!existsSync(path)) throw new Error(`afterPack: missing packaged resource ${path}`);
  }

  // The entry point must be CommonJS: Electron never executes an ESM main in a
  // packaged app (the process starts, no window appears, nothing is logged).
  const { extractFile, listPackage } = await import("@electron/asar");
  const asar = join(resourcesDir, "app.asar");
  const entries = listPackage(asar);
  if (entries.some((entry) => entry.endsWith(".mjs"))) {
    throw new Error(`afterPack: ${asar} contains an ESM entry — the app's main process must be CommonJS (see src/main.js)`);
  }
  const manifest = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
  if (typeof manifest.main !== "string" || !manifest.main.endsWith(".js")) {
    throw new Error(`afterPack: package.json main is ${JSON.stringify(manifest.main)} — expected a CommonJS .js entry`);
  }
  if (!entries.includes(`/${manifest.main}`)) {
    throw new Error(`afterPack: ${asar} does not contain the main entry ${manifest.main}`);
  }
  if (manifest.type === "module") {
    throw new Error(`afterPack: the app package is "type": "module" — a packaged Electron main must be CommonJS`);
  }

  // 1./2. The addon must load and spawn on this Node — the ABI the server runs on.
  const native = join(ptyDir, "build", "Release", "pty.node");
  if (!existsSync(native)) {
    throw new Error(
      `afterPack: ${native} is missing — the addon must be built for Node's ABI ` +
        `(run \`node packages/desktop/scripts/build-native.mjs\`), not shipped from a prebuild.`
    );
  }
  const helperPath = join(ptyDir, "build", "Release", "spawn-helper");
  if (existsSync(helperPath)) chmodSync(helperPath, 0o755);

  try {
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        `const pty = require(${JSON.stringify(ptyDir)});` +
          `if (!require("node:sqlite").DatabaseSync) throw new Error("node:sqlite is missing");` +
          `const p = pty.spawn("/bin/echo", ["af-pack-ok"], { cols: 80, rows: 24 });` +
          `p.onData((d) => { if (d.includes("af-pack-ok")) { process.stdout.write("ok"); p.kill(); } });` +
          `p.onExit(() => process.exit(0));` +
          `setTimeout(() => process.exit(3), 10000);`,
      ],
      { timeout: 30_000, encoding: "utf8" }
    );
    if (!out.includes("ok")) throw new Error(`PTY probe produced no output: ${JSON.stringify(out)}`);
  } catch (err) {
    throw new Error(
      `afterPack: the packaged node-pty does not work on Node ${process.versions.node} — ` +
        `${err instanceof Error ? err.message : err}`
    );
  }

  console.log(`  • node-pty          node ${process.versions.node} ABI verified (spawn round-trip ok)`);
}
