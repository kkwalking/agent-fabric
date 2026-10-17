/**
 * Git worktree execution for board cards (v13 §3.3).
 *
 * A card in `worktree` mode runs in its own `git worktree add` checkout, so the
 * user's working tree is untouched and two cards can run in parallel. Worktree
 * mode is only offered when the board project root is itself a Git repository:
 * a plain folder / multi-repo parent / Google repo checkout has no single
 * worktree root, and guessing one would be wrong.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DomainError } from "@agentfabric/core";

const execFileAsync = promisify(execFile);

/** Where one session's worktree lives. Kept outside the project folder. */
export function kanbanWorktreePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "kanban", "worktrees", sessionId);
}

/**
 * Creates a detached worktree at `targetPath` from the project's current HEAD.
 * Detached on purpose: there is no commit/branch workflow yet (v13 M3), and a
 * named branch per card would leave clutter the user did not ask for. The card
 * may still name a base ref (a branch, tag or commit) to start from; without
 * one the project's current HEAD is used.
 */
export async function createKanbanWorktree(options: {
  rootPath: string;
  targetPath: string;
  /** Branch/tag/commit the checkout starts from. Defaults to `HEAD`. */
  baseRef?: string;
}): Promise<void> {
  if (!existsSync(join(options.rootPath, ".git"))) {
    throw new DomainError(
      "kanban-worktree-unavailable",
      `Worktree mode needs a Git repository at the project root (${options.rootPath} has no .git)`
    );
  }
  const baseRef = options.baseRef?.trim() || "HEAD";
  // Resolve first so an unknown ref fails loudly instead of creating a
  // worktree at some surprising commit.
  try {
    await execFileAsync(
      "git",
      ["-C", options.rootPath, "rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
      { timeout: 15_000 }
    );
  } catch {
    throw new DomainError(
      "base-ref-not-found",
      `Worktree base ref "${baseRef}" does not resolve in ${options.rootPath}`
    );
  }
  await mkdir(dirname(options.targetPath), { recursive: true });
  try {
    await execFileAsync(
      "git",
      ["-C", options.rootPath, "worktree", "add", "--detach", options.targetPath, baseRef],
      {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
  } catch (err) {
    await rm(options.targetPath, { recursive: true, force: true }).catch(() => {});
    const stderr =
      typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim() : "";
    throw new DomainError(
      "kanban-worktree-failed",
      `git worktree add failed${stderr ? `: ${stderr}` : `: ${err instanceof Error ? err.message : String(err)}`}`
    );
  }
}

/** Best-effort removal when a session could not start. Never removes user data. */
export async function removeKanbanWorktree(rootPath: string, targetPath: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", rootPath, "worktree", "remove", "--force", targetPath], { timeout: 30_000 });
  } catch {
    await rm(targetPath, { recursive: true, force: true }).catch(() => {});
  }
}
