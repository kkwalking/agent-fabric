/**
 * Git plumbing for board projects (v13 §2.1).
 *
 * Board projects are folder-first: a plain folder is a first-class project, and
 * AgentFabric never clones or initializes one — the user points at a directory
 * that already exists. The only Git work left here is reading the branch list
 * that seeds a worktree card's base ref.
 *
 * Failures surface git's own stderr, so the board can show what git actually
 * said instead of "something failed".
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** True when `path` itself (not a parent) is a Git work tree root. */
export function isGitRepositoryAtRoot(path: string): boolean {
  return existsSync(join(path, ".git"));
}

export interface KanbanGitInfo {
  /** Current branch, or `null` when HEAD is detached / has no commit yet. */
  currentBranch: string | null;
  branches: string[];
  /** `main`/`master` when present, otherwise the current branch. */
  defaultBranch: string | null;
}

/**
 * Reads the branch list that seeds a worktree card's base ref. Returns `null`
 * for a folder that is not a Git repository (the board then offers Direct only).
 */
export async function readGitInfo(rootPath: string): Promise<KanbanGitInfo | null> {
  if (!isGitRepositoryAtRoot(rootPath)) return null;
  let currentBranch: string | null = null;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: rootPath,
      timeout: 15_000,
    });
    const branch = (result.stdout ?? "").trim();
    currentBranch = branch && branch !== "HEAD" ? branch : null;
  } catch {
    // A repository with no commits yet has no branch to report.
    currentBranch = null;
  }
  let branches: string[] = [];
  try {
    const result = await execFileAsync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
      cwd: rootPath,
      timeout: 15_000,
      maxBuffer: GIT_MAX_BUFFER,
    });
    branches = (result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    branches = [];
  }
  const defaultBranch = branches.includes("main")
    ? "main"
    : branches.includes("master")
      ? "master"
      : (currentBranch ?? branches[0] ?? null);
  return { currentBranch, branches, defaultBranch };
}
