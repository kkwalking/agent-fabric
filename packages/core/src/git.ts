/**
 * Git helper operations.
 *
 * The platform runs work in place — it never clones, checks out, branches or
 * pushes — so the Git work that remains here is reading back what a frozen
 * revision range changed (see {@link diffBetween}). Credentials never enter
 * this module: a task diff is a read-only `git diff` against the task's own
 * workspace, and no remote is involved.
 *
 * Every command's captured output is passed through a `SecretRedactor` before
 * it can reach a log, an event or an error, so a value that happens to appear
 * in git's output never leaks.
 */
import { execFile } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "./errors.js";
import { SecretRedactor } from "./redaction.js";

function runGit(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; redactor?: SecretRedactor; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        timeout: opts.timeoutMs ?? 10 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) {
          const redact = (text: string) => (opts.redactor ? opts.redactor.redact(text) : text);
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (opts.signal?.aborted) {
            reject(new DomainError("agent-cancelled", `git ${args[0]} was cancelled`));
            return;
          }
          if (e.killed) {
            reject(new DomainError("source-network-failed", `git ${args[0]} timed out`));
            return;
          }
          reject(new Error(redact(String(stderr || e.message))));
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
    const onAbort = () => child.kill("SIGKILL");
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function gitEnv(credential: { env: Record<string, string> } | undefined): Record<string, string> {
  return { ...(credential?.env ?? {}) };
}

/* ------------------------------------------------------------------ */
/* Revision range diff (task artifacts)                                */
/* ------------------------------------------------------------------ */

/**
 * A materialization of `fromSha` or `toSha` that is not a commit in this
 * repository — a typo, a pruned history, or a revision from another repo.
 * Reported as `git-state-invalid`, which says the right thing about a frozen
 * SHA rather than about a remote operation.
 */
function revisionInDiffRangeError(revision: string, dir: string): DomainError {
  return new DomainError(
    "git-state-invalid",
    `The revision "${revision}" is not a commit in ${dir}`,
    "a task diff needs both endpoints to exist in the task workspace; one of the frozen SHAs is unknown here, or the workspace is gone"
  );
}

/** Read-only git args that keep repository config out of the diff. */
function diffSettingsArgs(): string[] {
  return [
    "--no-color",
    "--no-ext-diff", // a repo's diff.external must never execute here
    "--no-textconv", // ...nor its textconv filters
    "--find-renames", // a pure rename shows as "old => new", not delete+add
    "--src-prefix=a/", // diff.noprefix / diff.mnemonicPrefix cannot rewrite these
    "--dst-prefix=b/",
  ];
}

/** Default cap for a task diff patch (256 KiB), overridable per call. */
export const DEFAULT_DIFF_MAX_BYTES = 256 * 1024;

/** A unified diff between two frozen revisions, plus its stat. */
export interface RevisionDiff {
  /** Unified patch, whole or capped (see `truncated`). */
  patch: string;
  /** True when `patch` was capped; `files` still describes the whole diff. */
  truncated: boolean;
  /** The cap `patch` was held to — an audit is never silent about the cut. */
  maxBytes: number;
  /** Whole-diff stat; always complete, even when the patch is not. */
  files: DiffStat;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  /**
   * Additions/deletions the patch cannot show as text (binary files, and
   * anything past the cap). Counted separately so the totals are never
   * presented as if the visible patch explained them.
   */
  binaryFiles: number;
}

/** The tail marker of a capped patch — machine-checkable and human-legible. */
export function diffTruncationMarker(o: { maxBytes: number; stat: DiffStat }): string {
  return `\n... [diff truncated at ${o.maxBytes} bytes; ${o.stat.filesChanged} files changed total (${o.stat.insertions} insertions, ${o.stat.deletions} deletions)] ...\n`;
}

/**
 * Parses `git diff --numstat` output into the diff's stat. Binary entries
 * print `-` for both counts and contribute to nothing but the file count.
 * Numeric fields are matched strictly, so a `-` can never become `NaN`.
 */
export function parseDiffNumstat(text: string): DiffStat {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const match = /^(-|\d+)\t(-|\d+)\t/.exec(line);
    if (!match) continue;
    filesChanged += 1;
    if (match[1] === "-" || match[2] === "-") {
      binaryFiles += 1;
      continue;
    }
    insertions += Number(match[1]);
    deletions += Number(match[2]);
  }
  return { filesChanged, insertions, deletions, binaryFiles };
}

/**
 * The options a diff needs: the binary to run, an optional credential env, and
 * the timeout/redaction/cancellation the child process honors.
 */
export interface DiffGitContext {
  bin?: string;
  credential?: { env: Record<string, string> };
  timeoutMs?: number;
  redactor?: SecretRedactor;
  signal?: AbortSignal;
}

/**
 * The unified diff between two revisions of `repoDir` (an artifact input, so
 * it keeps the full stat alongside the patch).
 *
 * Read-only by construction: it runs `diff` and `rev-parse` only, and never
 * touches the index, the working tree, or any ref. The range is two-dot — the
 * actual difference from `fromSha` to `toSha` — because a frozen final commit
 * is a descendant of its frozen base, so `...` (merge-base) would report the
 * wrong thing for exactly the case this exists for.
 *
 * `opts.maxBytes` caps the *patch* (default {@link DEFAULT_DIFF_MAX_BYTES}):
 * beyond it the patch ends with {@link diffTruncationMarker} and `truncated`
 * is true. The stat is unaffected — it is measured separately by numstat, so
 * a truncated patch still reports the true file/line counts.
 *
 * An endpoint that is not a commit in `repoDir` throws a `DomainError`
 * (`git-state-invalid`); nothing is ever silently diffed against the wrong
 * revision or reported as an empty diff.
 */
export async function diffBetween(
  ctx: DiffGitContext,
  repoDir: string,
  fromSha: string,
  toSha: string,
  opts: { maxBytes?: number } = {}
): Promise<RevisionDiff> {
  const bin = ctx.bin ?? process.env.AGENTFABRIC_GIT_BIN ?? "git";
  const exec = async (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> => {
    try {
      return await runGit(bin, args, {
        cwd,
        env: gitEnv(ctx.credential),
        timeoutMs: ctx.timeoutMs,
        redactor: ctx.redactor,
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError("git-state-invalid", err instanceof Error ? err.message : String(err));
    }
  };
  const resolveCommit = async (revision: string): Promise<string> => {
    // `-C` because the child's cwd is not the repository — it is a scratch
    // directory, so a hostile repoDir can never make this write there.
    try {
      const { stdout } = await exec(["-C", repoDir, "rev-parse", "--verify", "--quiet", `${revision}^{commit}`], tmpdir());
      const sha = stdout.trim();
      if (!sha) throw revisionInDiffRangeError(revision, repoDir);
      return sha;
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw revisionInDiffRangeError(revision, repoDir);
    }
  };

  // Resolve both endpoints *before* diffing: git happily diffs a revision that
  // is not a commit (a tag, a tree, a missing one it reads as "nothing"), and
  // an artifact that silently shows the wrong change is worse than a failure.
  await resolveCommit(fromSha);
  await resolveCommit(toSha);

  // The patch is written to a file and read back with a hard cap: a task that
  // rewrote a generated bundle must not put a 200 MB diff into the store.
  const scratch = await mkdtemp(join(tmpdir(), "af-diff-"));
  const patchPath = join(scratch, "diff.patch");
  try {
    await exec(
      ["-C", repoDir, "diff", ...diffSettingsArgs(), `--output=${patchPath}`, "--end-of-options", `${fromSha}..${toSha}`],
      scratch
    );
    const numstat = await exec(["-C", repoDir, "diff", ...diffSettingsArgs(), "--numstat", "--end-of-options", `${fromSha}..${toSha}`], scratch);
    const files = parseDiffNumstat(numstat.stdout);

    const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? DEFAULT_DIFF_MAX_BYTES));
    const handle = await open(patchPath, "r");
    let head = Buffer.alloc(0);
    try {
      head = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(head, 0, maxBytes, 0);
      head = head.subarray(0, bytesRead);
      const truncated = (await handle.stat()).size > bytesRead;
      const patch = truncated
        ? `${head.toString("utf8")}${diffTruncationMarker({ maxBytes, stat: files })}`
        : head.toString("utf8");
      return { patch, truncated, maxBytes, files };
    } finally {
      await handle.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
