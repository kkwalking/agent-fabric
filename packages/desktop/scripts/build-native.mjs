/**
 * Builds the native module the desktop app ships: `node-pty` compiled for the
 * **Node** ABI.
 *
 * The in-process server (see `src/main.mjs`) runs on Node's ABI — each Electron
 * release has its own NODE_MODULE_VERSION, and Electron's own ABI changes with
 * every major version, so a prebuilt-for-Electron binary cannot be assumed. The
 * build hosts that have a matching Electron happen to work today by luck; this
 * step is what makes it true.
 *
 * Output goes to `packages/desktop/native/node-pty`, not into the repository's
 * `node_modules`: the checkout keeps its own prebuilt addon for the CLI, and a
 * package build must not rewrite the developer's dependencies.
 *
 * Run: `node packages/desktop/scripts/build-native.mjs [--target=<electron-version>]`
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");

const targetArg = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
const nodeTarget = targetArg ?? process.versions.node;

const sourceDir = join(repoRoot, "node_modules", "node-pty");
const outputDir = join(desktopRoot, "native", "node-pty");
if (!existsSync(join(sourceDir, "binding.gyp"))) {
  console.error(`[desktop] node-pty sources not found at ${sourceDir} — run \`npm install\` first`);
  process.exit(1);
}

// Work on a copy: `node-gyp` writes `build/` and `config.gypi` next to the
// sources, and the checkout's own copy must stay untouched.
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(join(outputDir, ".."), { recursive: true });
cpSync(sourceDir, outputDir, {
  recursive: true,
  filter: (file) => !file.includes(`${sourceDir}/build`) && !file.includes(`${sourceDir}/prebuilds`),
});

const nodeGyp = join(repoRoot, "node_modules", ".bin", "node-gyp");
const args = [
  nodeGyp,
  "rebuild",
  "--runtime=node",
  `--target=${nodeTarget}`,
  `--arch=${process.arch}`,
  // `--nodedir` points at the running Node so node-gyp never has to download
  // headers (it uses `<nodedir>/include/node` and the resolved library).
  `--nodedir=${dirname(dirname(process.execPath))}`,
  "--release",
];
console.log(`[desktop] building node-pty for node ${nodeTarget} (${process.arch})`);

try {
  execFileSync(process.execPath, args, { cwd: outputDir, stdio: ["ignore", "pipe", "inherit"] });
} catch (err) {
  console.error(
    `[desktop] node-pty build failed (${err instanceof Error ? err.message : err}).\n` +
      `[desktop] this step needs a C++ toolchain (Xcode Command Line Tools) and python3 — ` +
      `install them with \`xcode-select --install\` if they are missing.`
  );
  process.exit(1);
}

const built = join(outputDir, "build", "Release", "pty.node");
if (!existsSync(built)) {
  console.error(`[desktop] node-gyp reported success but ${built} does not exist`);
  process.exit(1);
}

// Prove it before packaging: load the module in this Node and spawn a process
// through it. A binary built for the wrong ABI fails to load here, which is the
// failure this script exists to prevent.
const probe = execFileSync(
  process.execPath,
  [
    "-e",
    `const pty = require(${JSON.stringify(outputDir)});` +
      `const p = pty.spawn("/bin/echo", ["native-ok"], { cols: 80, rows: 24 });` +
      `p.onData((d) => { if (d.includes("native-ok")) { process.stdout.write("ok"); p.kill(); } });` +
      `p.onExit(() => process.exit(0));` +
      `setTimeout(() => process.exit(3), 10000);`,
  ],
  { encoding: "utf8", timeout: 60_000 }
);
if (!probe.includes("ok")) {
  console.error(`[desktop] the freshly built node-pty did not spawn a process (output: ${JSON.stringify(probe)})`);
  process.exit(1);
}

console.log(`[desktop] node-pty rebuilt for node ${nodeTarget}: ${built}`);
