/**
 * Runs the desktop app from a sources checkout: `npm run desktop`.
 *
 * The dev loop runs exactly the packaged arrangement — server bundle in
 * `backend/`, web UI in `packages/web/dist`, server in-process — except that
 * the native addon lives where electron-builder will copy it from
 * (`native/node-pty`), which requires `build-native` to have run.
 *
 * This is the fast loop for the window itself (window chrome, links, quit
 * behaviour). For anything that depends on the packaging — the Node runtime
 * link, node-pty resolution from `Resources/`, signing, the dmg — build the
 * real app with `npm run desktop:app`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");

for (const required of [
  [join(desktopRoot, "backend", "server.cjs"), "npm run build:backend -w @agentfabric/desktop"],
  [join(desktopRoot, "backend", "node_modules", "node-pty", "build", "Release", "pty.node"), "npm run build:native -w @agentfabric/desktop"],
  [join(repoRoot, "packages/web/dist/index.html"), "npm run build:web"],
]) {
  if (!existsSync(required[0])) {
    console.error(`[desktop] missing ${required[0]} — run: ${required[1]}`);
    process.exit(1);
  }
}

// Electron's own launcher resolves the platform binary; the app package's
// `main` (src/main.mjs) is what gets loaded as the main process.
const electron = join(repoRoot, "node_modules", "electron", "cli.js");
if (!existsSync(electron)) {
  console.error("[desktop] electron is not installed — run `npm install` (see README for the ELECTRON_MIRROR note)");
  process.exit(1);
}

const child = spawn(process.execPath, [electron, desktopRoot], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});
child.on("exit", (code) => process.exit(code ?? 0));
