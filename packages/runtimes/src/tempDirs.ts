import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Temporary-directory constraint for harness thread discovery (all
 * kinds): sessions recorded under a temp directory — CI steps, ad-hoc
 * probes, throwaway fixtures — are execution noise, not the user's work,
 * so discovery never lists them. One predicate, applied by every local
 * thread source; the session data itself is never touched here.
 *
 * A directory counts as temp when it is, or lives under, /tmp, /var/tmp
 * or the OS temp dir (macOS per-user /var/folders/…/T), matched in both
 * literal and symlink-resolved form (/tmp → /private/tmp on macOS).
 * Paths that cannot be probed keep the literal form only; relative paths
 * are never classified as temp.
 */

let cachedRoots: string[] | undefined;

function tempRoots(): string[] {
  if (!cachedRoots) {
    const roots = new Set<string>(["/tmp", "/var/tmp", resolve(tmpdir())]);
    if (process.env.TMPDIR) roots.add(resolve(process.env.TMPDIR));
    for (const root of [...roots]) {
      try {
        roots.add(realpathSync(root));
      } catch {
        /* a temp root that does not exist keeps its literal form */
      }
    }
    cachedRoots = [...roots];
  }
  return cachedRoots;
}

export function isTempDirPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const candidates = new Set<string>([resolve(path)]);
  try {
    candidates.add(realpathSync(path));
  } catch {
    /* the path may be gone — judge the literal form only */
  }
  return [...candidates].some((candidate) =>
    tempRoots().some((root) => candidate === root || candidate.startsWith(root + "/"))
  );
}
