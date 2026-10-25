/**
 * Bundles the API server (`createServer` from `@agentfabric/server`) into one
 * file the desktop app
 * can launch: `resources/app/backend/server.cjs`.
 *
 * Why a bundle instead of running `dist/`:
 *
 * - The workspace packages are ESM TypeScript with relative `.js` import
 *   specifiers that only resolve under `tsx`. A bundle makes the server a
 *   single self-contained CommonJS file with every first-party and npm module
 *   inlined, so the app does not need a `node_modules` tree, `tsx`, or a
 *   matching directory layout next to the binary.
 * - Native modules cannot be inlined: `node-pty` is a compiled `.node` addon.
 *   It stays external, and the desktop entry launches the server with the
 *   Electron binary in Node mode so the addon loads against Electron's ABI.
 *
 * Run from the repository root: `node packages/desktop/scripts/build-backend.mjs`.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const outFile = join(desktopRoot, "backend", "server.cjs");

/**
 * Packages that must be resolved at runtime, not inlined:
 *
 * - `node-pty` — native addon (`.node` binary), ABI-bound.
 * - `electron` — provided by the Electron runtime, never bundled.
 *
 * Everything else (express, ws, cors, fzstd, and the ESM workspace packages)
 * is inlined: they are pure JavaScript.
 */
const external = ["node-pty", "electron"];

// Wipe the previous bundle so a failed build cannot leave a stale server that
// the app would happily launch.
rmSync(join(desktopRoot, "backend"), { recursive: true, force: true });
mkdirSync(join(desktopRoot, "backend"), { recursive: true });

await build({
  // `createServer` is what the app needs; the CLI entry point (`index.ts`) only
  // wires up an HTTP listener and exports nothing.
  entryPoints: [join(repoRoot, "packages/server/src/app.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external,
  // No source map in the shipped bundle: nothing in the server reads one
  // (`source-map-support` is not a dependency), and it was half the bundle's
  // size on disk. Debugging a packaged app can rebuild with it if needed.
  sourcemap: process.env.AF_BACKEND_SOURCEMAP === "1",
  // Nothing in the server reads `import.meta`: it takes its directories from
  // `createServer`'s options, and the CLI entry point (which does read it) is
  // not bundled here.
  logLevel: "info",
});

if (!existsSync(outFile)) {
  console.error(`[desktop] expected bundle at ${outFile}`);
  process.exit(1);
}

console.log(`[desktop] backend bundle written to ${outFile}`);

/**
 * The native PTY addon is not in the bundle. It is built for Node's ABI by
 * `build-native.mjs` into `packages/desktop/native/node-pty`, and staged next
 * to the server bundle (`backend/node_modules/node-pty`): that is the path the
 * in-process server resolves at runtime, both in `npm run desktop` and inside
 * the packaged app (electron-builder copies the same directory in).
 */
const nativeSource = join(desktopRoot, "native", "node-pty", "build", "Release", "pty.node");
if (!existsSync(nativeSource)) {
  console.error(
    `[desktop] node-pty is not built for Node (${nativeSource} is missing) — run \`npm run build:native -w @agentfabric/desktop\``
  );
  process.exit(1);
}
cpSync(join(desktopRoot, "native", "node-pty"), join(desktopRoot, "backend", "node_modules", "node-pty"), {
  recursive: true,
});
console.log(`[desktop] node-pty staged from ${nativeSource}`);
