/**
 * Git plumbing used while *adding* a board project (v13 §2.1).
 *
 * Board projects are folder-first: a plain folder is a first-class project. The
 * only Git actions this module performs are the two the "Add project" dialog
 * offers explicitly — cloning a repository and initializing one — plus reading
 * the branch list that seeds a worktree card's base ref.
 *
 * Every failure is a `DomainError` with a stable code and the CLI's own stderr,
 * so the dialog can show what git actually said instead of "something failed".
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { DomainError } from "@agentfabric/core";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** Identity used only when the initial commit cannot be authored otherwise. */
const FALLBACK_IDENTITY_ARGS = ["-c", "user.name=AgentFabric", "-c", "user.email=agentfabric@localhost"];

function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (err) {
    throw new DomainError("kanban-git-command-failed", `git ${args[0]} failed: ${stderrOf(err)}`);
  }
}

/** True when `path` itself (not a parent) is a Git work tree root. */
export function isGitRepositoryAtRoot(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Derives a folder name from a clone URL, for the dialog's default folder name.
 * Handles HTTPS, SSH (`git@host:user/repo.git`) and local paths.
 */
export function deriveRepoNameFromUrl(gitUrl: string): string | null {
  const trimmed = gitUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const sshMatch = /^[^@/\s]+@[^:/\s]+:(.+)$/u.exec(trimmed);
  const pathPart = sshMatch?.[1] ?? trimmed;
  const lastSegment = basename(pathPart).replace(/\.git$/u, "");
  return lastSegment || null;
}

/**
 * `git init` plus an initial commit, so a freshly initialized project can
 * immediately back worktree cards (a worktree needs at least one commit).
 * The user's configured identity is used when present; a neutral identity is
 * only a fallback so initialization never dead-ends.
 */
export async function initializeGitRepository(path: string): Promise<void> {
  await runGit(["init", "--quiet"], path);
  const head = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: path }).catch(() => null);
  if (head) return;
  await runGit(["add", "-A"], path);
  try {
    await runGit(["commit", "--allow-empty", "--quiet", "-m", "Initial commit"], path);
  } catch {
    await runGit([...FALLBACK_IDENTITY_ARGS, "commit", "--allow-empty", "--quiet", "-m", "Initial commit"], path);
  }
}

/**
 * Clones `gitUrl` into `targetPath` (exactly `git clone` semantics: an existing
 * empty directory is allowed, a non-empty one is refused). The parent directory
 * must already exist so a typo in the destination cannot create a deep tree.
 */
export async function cloneGitRepository(gitUrl: string, targetPath: string): Promise<void> {
  const parent = dirname(targetPath);
  let parentOk = false;
  try {
    parentOk = (await stat(parent)).isDirectory();
  } catch {
    parentOk = false;
  }
  if (!parentOk) {
    throw new DomainError("kanban-path-invalid", `Clone destination folder does not exist: ${parent}`);
  }

  let targetExists = false;
  try {
    const targetInfo = await stat(targetPath);
    if (!targetInfo.isDirectory()) {
      throw new DomainError("kanban-path-invalid", `Clone destination is a file, not a folder: ${targetPath}`);
    }
    const existing = await readdir(targetPath);
    if (existing.length > 0) {
      throw new DomainError(
        "kanban-path-invalid",
        `Clone destination is not empty: ${targetPath} — pick an empty folder or a new folder name`
      );
    }
    targetExists = true;
  } catch (err) {
    if (err instanceof DomainError) throw err;
    targetExists = false;
  }

  if (!targetExists) {
    await mkdir(targetPath, { recursive: false }).catch((err: unknown) => {
      throw new DomainError(
        "kanban-path-invalid",
        `Cannot create clone destination "${targetPath}": ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  try {
    await execFileAsync("git", ["clone", "--quiet", "--", gitUrl.trim(), targetPath], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (err) {
    // A failed clone must not leave a half-created folder behind.
    if (!targetExists) await rm(targetPath, { recursive: true, force: true });
    throw new DomainError("kanban-git-command-failed", `git clone failed: ${stderrOf(err)}`);
  }
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
