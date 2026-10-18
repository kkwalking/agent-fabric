/**
 * Claude Code workspace trust for board cards (v13).
 *
 * Claude refuses to work in a folder it has not been told to trust: on first
 * launch in an unknown directory it draws a "Do you trust the files in this
 * folder?" dialog and waits. Through a PTY that dialog consumes the prompt the
 * board passed on argv and nothing happens — no turn, no hooks, and a card that
 * looks dead. That is why a card's session never reported its harness id.
 *
 * The board only records trust for directories it created itself (the worktree
 * checkout under `dataDir`). A project directory is the user's own: opening it
 * here must not silently broaden Claude's trust, so those keep the interactive
 * dialog and the user decides.
 *
 * Best effort by design: if the config cannot be read or written the card still
 * launches. Trusting a folder must never be the reason a card fails to start.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface ClaudeUserConfig {
  projects?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Claude's user-level config; `CLAUDE_CONFIG_DIR` moves it (their convention). */
function claudeUserConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir && dir.length > 0 ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

/**
 * True only for directories the board created and owns. Everything else is the
 * user's own tree and is left alone.
 */
export function isBoardManagedWorkspace(cwd: string, dataDir: string): boolean {
  const worktreesRoot = join(dataDir, "kanban", "worktrees") + "/";
  const normalized = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return normalized.startsWith(worktreesRoot) && normalized.length > worktreesRoot.length;
}

/**
 * Records Claude's trust decision for a board-managed workspace. Returns true
 * only when the folder is known to be trusted afterwards; any failure is
 * reported as "not trusted" and the card falls back to the dialog.
 */
export async function preTrustClaudeWorkspace(options: {
  cwd: string;
  dataDir: string;
}): Promise<boolean> {
  if (!isBoardManagedWorkspace(options.cwd, options.dataDir)) return false;

  const configPath = claudeUserConfigPath();
  try {
    // Claude keys its config by the canonical path: on macOS the same folder is
    // reachable as both /var/... and /private/var/..., and storing the wrong
    // spelling leaves the dialog in place.
    const key = await realpath(options.cwd);
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as ClaudeUserConfig;
    const projects = parsed.projects ?? {};
    const existing = projects[key] ?? {};
    if (existing.hasTrustDialogAccepted === true) return true;
    projects[key] = { ...existing, hasTrustDialogAccepted: true };
    await writeFile(configPath, `${JSON.stringify({ ...parsed, projects }, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    // Unreadable/absent config: the card launches and shows Claude's dialog.
    return false;
  }
}
