/**
 * node-pty ships `spawn-helper` inside its prebuilt directories, but npm can
 * extract it without the executable bit (notably under install-script gating).
 * Without +x, every `pty.spawn()` fails with `posix_spawnp failed` while
 * `require("node-pty")` still succeeds — a confusing failure. Fix the bit
 * after install instead of asking every contributor to discover it.
 *
 * No-op on Windows (ConPTY has no helper binary) and when node-pty is absent.
 */
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    join(root, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(root, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
  ];
  for (const helper of candidates) {
    if (!existsSync(helper)) continue;
    try {
      chmodSync(helper, 0o755);
    } catch {
      // Best-effort: a read-only node_modules should fail loudly at spawn time,
      // not break the install for every other package.
    }
  }
}
