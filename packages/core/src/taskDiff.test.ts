/**
 * Task diff artifacts: the patch a completed task produces, and its stat.
 *
 * Every case runs against a real git CLI in a throwaway temp repository — the
 * point of this module is that what the user sees is the *actual* diff between
 * two frozen revisions, so a fake git would prove nothing. Nothing here
 * touches `~/.fabric`, a real remote, or any path outside its own temp dir.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DomainError } from "./errors.js";
import { DEFAULT_DIFF_MAX_BYTES, diffBetween, parseDiffNumstat, type DiffStat } from "./git.js";
import {
  TASK_DIFF_ARTIFACT_NAME,
  TASK_DIFF_MIME,
  summarizeTaskDiff,
  taskDiffArtifactDraft,
  taskDiffProvenanceLine,
} from "./taskDiff.js";

const execFileAsync = promisify(execFile);

/** A scratch repository plus the raw git calls to build revisions in it. */
interface Scratch {
  dir: string;
  git: (args: string[]) => Promise<string>;
  commit: (message?: string) => Promise<string>;
  write: (path: string, content: string) => void;
  head: () => Promise<string>;
}

let scratchCounter = 0;
const created: string[] = [];

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp repo whose git sees no user config at all: identity comes from `-c`,
 * `HOME` points into the scratch dir and the system config is off, so the
 * developer's own `~/.gitconfig` (hooks, signing, diff drivers) cannot leak
 * into a test result.
 */
function makeScratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), `af-taskdiff-${scratchCounter++}-`));
  created.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-c",
        "user.name=AgentFabric Test",
        "-c",
        "user.email=af@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } }
    );
    return String(stdout);
  };
  return {
    dir: repo,
    git,
    commit: async (message = "commit") => {
      await git(["add", "-A"]);
      await git(["commit", "--quiet", "-m", message]);
      return (await git(["rev-parse", "HEAD"])).trim();
    },
    write: (path, content) => writeFileSync(join(repo, path), content),
    head: async () => (await git(["rev-parse", "HEAD"])).trim(),
  };
}

async function initRepo(): Promise<Scratch> {
  const s = makeScratch();
  await s.git(["init", "--quiet"]);
  return s;
}

function numberedLines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}\n`).join("");
}

/** The read-only guarantees a diff must never break. */
async function assertReadOnly(s: Scratch, headBefore: string, statusBefore: string): Promise<void> {
  assert.equal(await s.head(), headBefore, "HEAD moved");
  assert.equal(await s.git(["status", "--porcelain"]), statusBefore, "working tree changed");
}

async function assertGitStateInvalid(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof DomainError, `expected a DomainError, got ${String(err)}`);
    assert.equal(err.code, "git-state-invalid");
    return true;
  });
}

describe("diffBetween", () => {
  test("single file modification: patch lines and counts are exact", async () => {
    const s = await initRepo();
    s.write("a.txt", "one\ntwo\nthree\n");
    const base = await s.commit("base");
    s.write("a.txt", "one\nTWO\nthree\nfour\n");
    const final = await s.commit("change");

    const headBefore = await s.head();
    const statusBefore = await s.git(["status", "--porcelain"]);
    const diff = await diffBetween({ bin: "git" }, s.dir, base, final);

    assert.equal(diff.truncated, false);
    assert.equal(diff.maxBytes, DEFAULT_DIFF_MAX_BYTES);
    assert.deepEqual(diff.files, { filesChanged: 1, insertions: 2, deletions: 1, binaryFiles: 0 });
    assert.match(diff.patch, /^-two$/m);
    assert.match(diff.patch, /^\+TWO$/m);
    assert.match(diff.patch, /^\+four$/m);
    assert.ok(!diff.patch.includes("[diff truncated"), "a small diff must not carry a truncation marker");

    await assertReadOnly(s, headBefore, statusBefore);
  });

  test("added and deleted files are counted, including a whole-file deletion", async () => {
    const s = await initRepo();
    s.write("keep.txt", "keep\n");
    s.write("gone.txt", "line1\nline2\n");
    const base = await s.commit("base");
    rmSync(join(s.dir, "gone.txt"));
    s.write("added.txt", "new1\nnew2\nnew3\n");
    const final = await s.commit("add and remove");

    const diff = await diffBetween({ bin: "git" }, s.dir, base, final);
    assert.deepEqual(diff.files, { filesChanged: 2, insertions: 3, deletions: 2, binaryFiles: 0 });
    assert.match(diff.patch, /^--- \/dev\/null\n\+\+\+ b\/added\.txt$/m);
    assert.match(diff.patch, /^--- a\/gone\.txt\n\+\+\+ \/dev\/null$/m);
  });

  test("a renamed file stays one entry, not a delete plus an add", async () => {
    const s = await initRepo();
    s.write("old-name.txt", numberedLines(60));
    const base = await s.commit("base");
    await s.git(["mv", "old-name.txt", "new-name.txt"]);
    s.write("new-name.txt", `${numberedLines(60).replace("line-5\n", "CHANGED\n")}`);
    const final = await s.commit("rename and tweak");

    const diff = await diffBetween({ bin: "git" }, s.dir, base, final);
    assert.deepEqual(diff.files, { filesChanged: 1, insertions: 1, deletions: 1, binaryFiles: 0 });
    assert.match(diff.patch, /^rename from old-name\.txt$/m);
    assert.match(diff.patch, /^rename to new-name\.txt$/m);
  });

  test("a binary file never yields NaN counts", async () => {
    const s = await initRepo();
    s.write("text.txt", "hello\n");
    const base = await s.commit("base");
    // Bytes git cannot diff: numstat reports "-\t-" for this entry.
    writeFileSync(join(s.dir, "logo.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
    s.write("text.txt", "hello world\n");
    const final = await s.commit("add binary");

    const diff = await diffBetween({ bin: "git" }, s.dir, base, final);
    assert.deepEqual(diff.files, { filesChanged: 2, insertions: 1, deletions: 1, binaryFiles: 1 });
    assert.ok(Number.isInteger(diff.files.insertions) && Number.isInteger(diff.files.deletions));
    assert.match(diff.patch, /Binary files \/dev\/null and b\/logo\.bin differ/);
  });

  test("only a binary file changed: the file count survives, the line counts are zero", async () => {
    const s = await initRepo();
    writeFileSync(join(s.dir, "logo.bin"), Buffer.from([0, 1, 2, 0]));
    const base = await s.commit("base");
    writeFileSync(join(s.dir, "logo.bin"), Buffer.from([9, 8, 7, 0, 5]));
    const final = await s.commit("change binary");

    const diff = await diffBetween({ bin: "git" }, s.dir, base, final);
    assert.deepEqual(diff.files, { filesChanged: 1, insertions: 0, deletions: 0, binaryFiles: 1 });
    assert.match(diff.patch, /Binary files/);
  });

  test("a patch over maxBytes is capped, and only the patch is capped", async () => {
    const s = await initRepo();
    s.write("big.txt", numberedLines(4000));
    const base = await s.commit("base");
    s.write("big.txt", numberedLines(4000, "CHANGED"));
    const final = await s.commit("rewrite");

    const maxBytes = 4096;
    const diff = await diffBetween({ bin: "git" }, s.dir, base, final, { maxBytes });

    assert.equal(diff.truncated, true);
    assert.equal(diff.maxBytes, maxBytes);
    // The patch body is capped...
    assert.ok(diff.patch.length < 8192, `the patch was not capped: ${diff.patch.length} bytes`);
    assert.ok(diff.patch.startsWith("diff --git a/big.txt b/big.txt\n"), "a capped patch still starts like a real diff");
    // ...and ends with a marker naming the cap and the true totals.
    assert.ok(
      diff.patch.endsWith(
        "\n... [diff truncated at 4096 bytes; 1 files changed total (4000 insertions, 4000 deletions)] ...\n"
      ),
      `unexpected patch tail: ${JSON.stringify(diff.patch.slice(-160))}`
    );
    // ...while the stat still describes the whole diff.
    assert.deepEqual(diff.files, { filesChanged: 1, insertions: 4000, deletions: 4000, binaryFiles: 0 });
  });

  test("maxBytes is honored as a hard cap, down to a tiny value", async () => {
    const s = await initRepo();
    s.write("big.txt", numberedLines(400));
    const base = await s.commit("base");
    s.write("big.txt", numberedLines(400, "CHANGED"));
    const final = await s.commit("rewrite");

    const diff = await diffBetween({ bin: "git" }, s.dir, base, final, { maxBytes: 64 });
    assert.equal(diff.truncated, true);
    assert.equal(diff.maxBytes, 64);
    assert.ok(diff.patch.startsWith("diff --git a/big.txt"), "the first 64 bytes are still the patch head");
    assert.ok(diff.patch.includes("[diff truncated at 64 bytes;"));
    assert.equal(diff.files.filesChanged, 1);
  });

  test("no changes between two identical revisions: empty patch, zero counts, no error", async () => {
    const s = await initRepo();
    s.write("a.txt", "same\n");
    const base = await s.commit("base");
    s.write("b.txt", "other\n");
    const final = await s.commit("other");

    for (const sha of [base, final]) {
      const diff = await diffBetween({ bin: "git" }, s.dir, sha, sha);
      assert.equal(diff.patch, "");
      assert.equal(diff.truncated, false);
      assert.deepEqual(diff.files, { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 });
    }
  });

  test("an unknown revision throws git-state-invalid, never an empty diff", async () => {
    const s = await initRepo();
    s.write("a.txt", "a\n");
    const base = await s.commit("base");
    s.write("a.txt", "b\n");
    const final = await s.commit("change");

    for (const [from, to] of [
      ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", final],
      [base, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
      ["not-a-revision", final],
      ["--stat", final], // an option is not a revision, and must not become one
      ["", final],
    ]) {
      await assertGitStateInvalid(() => diffBetween({ bin: "git" }, s.dir, from, to));
    }
  });

  test("tags and branches resolve to their commit", async () => {
    const s = await initRepo();
    s.write("a.txt", "a\n");
    const base = await s.commit("base");
    await s.git(["tag", "v1", base]);
    s.write("a.txt", "b\n");
    const final = await s.commit("change");
    await s.git(["tag", "annotated", "-m", "annotate", final]);

    for (const [from, to] of [
      ["v1", "annotated"],
      [base, "annotated"],
    ]) {
      const diff = await diffBetween({ bin: "git" }, s.dir, from, to);
      assert.deepEqual(diff.files, { filesChanged: 1, insertions: 1, deletions: 1, binaryFiles: 0 });
    }

    await s.git(["branch", "base-branch", base]);
    const viaBranch = await diffBetween({ bin: "git" }, s.dir, "base-branch", final);
    assert.deepEqual(viaBranch.files, { filesChanged: 1, insertions: 1, deletions: 1, binaryFiles: 0 });
  });

  test("the range is two-dot: both sides of a non-ancestor pair are reported", async () => {
    // The platform's own ranges are always ancestor → descendant (a frozen
    // base and its final commit), but the function is a plain two-dot diff:
    // the patch is the real difference between the two revisions, not the
    // difference from their merge base.
    const s = await initRepo();
    s.write("shared.txt", "v1\n");
    const root = await s.commit("root");
    await s.git(["checkout", "--quiet", "-b", "side", root]);
    s.write("side.txt", "side\n");
    const sideTip = await s.commit("side work");
    await s.git(["checkout", "--quiet", "main"]);
    s.write("main.txt", "main\n");
    const mainTip = await s.commit("main work");

    const forward = await diffBetween({ bin: "git" }, s.dir, root, mainTip);
    assert.match(forward.patch, /^\+\+\+ b\/main\.txt$/m);
    assert.ok(!forward.patch.includes("side.txt"), "side.txt is not in root..main");

    // root and sideTip are not related by ancestry to mainTip... but sideTip
    // and mainTip are siblings: a three-dot diff here would hide the removal
    // of side.txt entirely.
    const across = await diffBetween({ bin: "git" }, s.dir, sideTip, mainTip);
    assert.match(across.patch, /^--- a\/side\.txt$/m, "two-dot reports side.txt as removed");
    assert.match(across.patch, /^\+\+\+ b\/main\.txt$/m);
  });

  test("hostile repository config cannot alter or execute during the diff", async () => {
    const s = await initRepo();
    s.write("a.txt", "a\n");
    const base = await s.commit("base");
    s.write("a.txt", "b\n");
    const final = await s.commit("change");

    const marker = join(s.dir, "..", "external-diff-ran");
    await s.git(["config", "diff.external", `sh -c 'touch ${marker}'`]);
    await s.git(["config", "diff.noprefix", "true"]);
    await s.git(["config", "diff.mnemonicPrefix", "true"]);
    s.write(".gitattributes", "a.txt diff=hostile\n");

    const diff = await diffBetween({ bin: "git" }, s.dir, base, final);
    assert.equal(existsSync(marker), false, "diff.external must never execute");
    assert.match(diff.patch, /^diff --git a\/a\.txt b\/a\.txt$/m, "prefixes must stay a/ and b/ despite diff.noprefix");
    assert.match(diff.patch, /^\+b$/m);
  });

  test("calling it changes nothing in the repository", async () => {
    const s = await initRepo();
    s.write("a.txt", "a\n");
    const base = await s.commit("base");
    s.write("a.txt", "b\n");
    const final = await s.commit("b commit");
    // Dirty on purpose: an untracked file next to a committed change.
    s.write("untracked.txt", "pending\n");
    const headBefore = await s.head();
    const statusBefore = await s.git(["status", "--porcelain"]);
    assert.ok(statusBefore.includes("untracked.txt"), "the fixture must start dirty");

    await diffBetween({ bin: "git" }, s.dir, base, final);

    await assertReadOnly(s, headBefore, statusBefore);
  });

  test("a missing repository fails loudly instead of reporting an empty diff", async () => {
    const s = await initRepo();
    s.write("a.txt", "a\n");
    const base = await s.commit("base");
    s.write("a.txt", "b\n");
    const final = await s.commit("change");

    await assertGitStateInvalid(() => diffBetween({ bin: "git" }, join(s.dir, "gone"), base, final));
  });

  test("the signal is honored (a cancelled task diff cannot hang the lifecycle)", async () => {
    const s = await initRepo();
    s.write("a.txt", "a\n");
    const base = await s.commit("base");
    s.write("a.txt", "b\n");
    const final = await s.commit("change");

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => diffBetween({ bin: "git", signal: controller.signal }, s.dir, base, final),
      (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "agent-cancelled");
        return true;
      }
    );
    // The abort ran before anything else did; the repository is untouched.
    const diff = await diffBetween({ bin: "git" }, s.dir, base, final);
    assert.deepEqual(diff.files, { filesChanged: 1, insertions: 1, deletions: 1, binaryFiles: 0 });
  });
});

describe("parseDiffNumstat", () => {
  test("splits text, binary and rename entries without NaN", () => {
    const stat = parseDiffNumstat("-\t-\tlogo.bin\n12\t3\tsrc/app.ts\n0\t0\tdocs/old.md => docs/new.md\n");
    assert.deepEqual(stat, { filesChanged: 3, insertions: 12, deletions: 3, binaryFiles: 1 });
  });

  test("handles empty output and blank lines", () => {
    assert.deepEqual(parseDiffNumstat(""), { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 });
    assert.deepEqual(parseDiffNumstat("\n\n"), { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 });
  });

  test("a single '-' field never becomes a number", () => {
    const stat = parseDiffNumstat("-\t-\timg.png\n-\t-\tother.png\n");
    assert.deepEqual(stat, { filesChanged: 2, insertions: 0, deletions: 0, binaryFiles: 2 });
    assert.ok(!Number.isNaN(stat.insertions) && !Number.isNaN(stat.deletions));
  });

  test("a path containing spaces and tabs is still one entry", () => {
    const stat = parseDiffNumstat("2\t1\tsome dir/with space.ts\n");
    assert.deepEqual(stat, { filesChanged: 1, insertions: 2, deletions: 1, binaryFiles: 0 });
  });
});

describe("task diff artifact", () => {
  const stat: DiffStat = { filesChanged: 3, insertions: 12, deletions: 4, binaryFiles: 1 };
  const diff = { patch: "diff --git a/x b/x\n", truncated: false, maxBytes: DEFAULT_DIFF_MAX_BYTES, files: stat };
  const provenance = { baseCommitSha: "a".repeat(40), finalCommitSha: "b".repeat(40), branch: "af/task-1-fix" };

  test("the draft is the diff kind, named task-diff.patch, with a self-describing header", () => {
    const draft = taskDiffArtifactDraft({ diff, provenance });
    assert.equal(draft.name, TASK_DIFF_ARTIFACT_NAME);
    assert.equal(draft.kind, "diff");
    assert.equal(draft.mime, TASK_DIFF_MIME);
    assert.ok(draft.content!.startsWith(taskDiffProvenanceLine(provenance)));
    assert.ok(draft.content!.includes("# 3 files changed, 12 insertions(+), 4 deletions(-) (1 binary)\n"));
    assert.ok(draft.content!.includes(diff.patch));
    assert.equal(draft.meta!.filesChanged, 3);
    assert.equal(draft.meta!.binaryFiles, 1);
    assert.equal(draft.meta!.truncated, false);
    assert.equal(draft.meta!.summary, summarizeTaskDiff(stat));
  });

  test("a truncated diff says so in the meta AND in the file itself", () => {
    const draft = taskDiffArtifactDraft({
      diff: { ...diff, truncated: true, maxBytes: 1024 },
      provenance,
    });
    assert.equal(draft.meta!.truncated, true);
    assert.equal(draft.meta!.maxBytes, 1024);
    assert.ok(draft.content!.includes("[diff truncated at 1024 bytes; 3 files changed total (12 insertions, 4 deletions)]"));
    // The counts stay the whole diff's even though the body is cut.
    assert.equal(draft.meta!.insertions, 12);
    assert.equal(draft.meta!.deletions, 4);
    assert.equal(draft.meta!.truncated, true);
  });

  test("summarizeTaskDiff speaks English for singular and empty diffs", () => {
    assert.equal(
      summarizeTaskDiff({ filesChanged: 1, insertions: 1, deletions: 1, binaryFiles: 0 }),
      "1 file changed, 1 insertion(+), 1 deletion(-)"
    );
    assert.equal(
      summarizeTaskDiff({ filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 }),
      "0 files changed, 0 insertions(+), 0 deletions(-)"
    );
  });

  test("a real diff and its artifact agree end to end", async () => {
    const s = await initRepo();
    s.write("src.txt", "alpha\n");
    const base = await s.commit("base");
    s.write("src.txt", "alpha\nbeta\n");
    const final = await s.commit("add beta");

    const real = await diffBetween({ bin: "git" }, s.dir, base, final);
    const draft = taskDiffArtifactDraft({ diff: real, provenance: { baseCommitSha: base, finalCommitSha: final } });

    assert.equal(draft.meta!.filesChanged, real.files.filesChanged);
    assert.equal(draft.meta!.insertions, 1);
    assert.match(draft.content!, /^\+beta$/m);
    assert.ok(draft.content!.includes(`# task diff ${base}..${final}\n`));
  });

  test("a capped diff reaches the artifact capped, with complete numbers", async () => {
    const s = await initRepo();
    s.write("big.txt", numberedLines(3000));
    const base = await s.commit("base");
    s.write("big.txt", numberedLines(3000, "CHANGED"));
    const final = await s.commit("rewrite");

    const real = await diffBetween({ bin: "git" }, s.dir, base, final, { maxBytes: 2048 });
    const draft = taskDiffArtifactDraft({ diff: real, provenance: { baseCommitSha: base, finalCommitSha: final } });

    assert.equal(draft.meta!.truncated, true);
    assert.equal(draft.meta!.filesChanged, 1);
    assert.equal(draft.meta!.insertions, 3000);
    assert.ok(draft.content!.includes("[diff truncated at 2048 bytes; 1 files changed total (3000 insertions, 3000 deletions)]"));
  });
});
