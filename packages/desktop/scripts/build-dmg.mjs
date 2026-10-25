/**
 * Builds the `.dmg` with macOS's own `hdiutil`.
 *
 * electron-builder's dmg target downloads a `dmgbuild` bundle from GitHub on
 * first use. That download is unavailable on networks where GitHub release
 * assets are blocked or extremely slow — and it is the *layout tooling*, not a
 * correctness dependency: a dmg is a volume containing the `.app` and an
 * `/Applications` symlink. This script builds exactly that with `hdiutil`, which
 * ships with macOS, and fails loudly if the result does not mount with both.
 *
 * The electron-builder configuration keeps the dmg/zip targets for networks
 * where the download works; `build-mac.mjs` falls back to this script when the
 * dmg target fails.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

/**
 * @param {{ appPath: string, outFile: string, volumeName: string }} options
 */
export function buildDmg({ appPath, outFile, volumeName }) {
  if (!existsSync(appPath)) throw new Error(`buildDmg: app bundle not found at ${appPath}`);

  // A staging directory *outside* the bundle: staging inside it would make the
  // image contain a copy of itself.
  const staging = mkdtempSync(join(tmpdir(), "af-dmg-stage-"));
  try {
    const stagedApp = join(staging, "AgentFabric.app");
    // `cp -c` clones files on APFS (fast, no data copies) and preserves
    // permissions and symlinks exactly as the .app has them.
    execFileSync("cp", ["-Rc", appPath, stagedApp], { stdio: ["ignore", "pipe", "inherit"] });
    symlinkSync("/Applications", join(staging, "Applications"));

    rmSync(outFile, { force: true });
    // hdiutil writes deprecation notices for `create`/`attach` on newer macOS;
    // they are noise, not a problem — the image is verified by mounting it.
    execFileSync(
      "hdiutil",
      ["create", "-volname", volumeName, "-srcfolder", staging, "-ov", "-format", "UDZO", outFile],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    if (!existsSync(outFile)) throw new Error(`buildDmg: hdiutil reported success but ${outFile} does not exist`);
    verifyDmg(outFile);
    return outFile;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Mounts the image read-only and checks what a user will see: the app and the
 * `/Applications` shortcut, and the server/UI/native addon inside the app.
 */
function verifyDmg(outFile) {
  // `hdiutil` occasionally wedges on this machine (it has hung both attach and
  // detach); without a timeout the whole build then waits forever after the
  // image is already written. Failing with a clear reason is recoverable — the
  // dmg and .app are complete by then — a silent hang is not.
  const plist = execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-plist", outFile], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const mountPoint = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!mountPoint) throw new Error("buildDmg: the image mounted without a mount point");
  try {
    const app = join(mountPoint, "AgentFabric.app");
    for (const required of [
      app,
      join(mountPoint, "Applications"),
      join(app, "Contents", "Resources", "backend", "server.cjs"),
      join(app, "Contents", "Resources", "web", "index.html"),
      join(app, "Contents", "Resources", "backend", "node_modules", "node-pty", "build", "Release", "pty.node"),
    ]) {
      if (!existsSync(required)) {
        throw new Error(`buildDmg: the image is missing ${relative(mountPoint, required)} (hdiutil said it succeeded)`);
      }
    }

  } finally {
    try {
      execFileSync("hdiutil", ["detach", mountPoint, "-quiet", "-force"], { stdio: "ignore", timeout: 120_000 });
    } catch {
      // A mount left behind is noise the next build clears; it must not turn a
      // verified image into a failed build.
    }
  }
}

// CLI form, used by `build-mac.mjs` as the fallback and directly for debugging:
//   node scripts/build-dmg.mjs <appPath> <outFile> <volumeName>
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [, , appPath, outFile, volumeName] = process.argv;
  if (!appPath || !outFile || !volumeName) {
    console.error("usage: node scripts/build-dmg.mjs <appPath> <outFile> <volumeName>");
    process.exit(1);
  }
  buildDmg({ appPath, outFile, volumeName });
  console.log(`[desktop] dmg written to ${outFile}`);
}

export { desktopRoot };
