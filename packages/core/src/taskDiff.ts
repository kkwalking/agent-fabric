/**
 * The Task Diff artifact: what one task actually changed.
 *
 * A task's value is the code it produced, and the platform already freezes
 * `baseCommitSha..finalCommitSha` at Git finalization. This module is the
 * bridge from that frozen range to an artifact a user can open: it is
 * deliberately two pure functions over already-computed values, so it can be
 * unit-tested without a Store, a Service, or a workspace.
 *
 * The projection happens **once, at generation time**: the patch is rendered
 * (and capped) when the artifact is built, and the counts written next to it
 * are the counts that diff had at that moment. Re-reading an artifact never
 * re-diffs a repository.
 */
import {
  DEFAULT_DIFF_MAX_BYTES,
  diffTruncationMarker,
  type DiffStat,
  type RevisionDiff,
} from "./git.js";
import type { ArtifactDraft } from "./runtime.js";

export { DEFAULT_DIFF_MAX_BYTES };

/** The artifact name a task diff is always published under. */
export const TASK_DIFF_ARTIFACT_NAME = "task-diff.patch";

/** Media type of the diff artifact; the content route serves it as text. */
export const TASK_DIFF_MIME = "text/x-diff";

/** Where the diff came from — the two frozen revisions and how they relate. */
export interface TaskDiffProvenance {
  baseCommitSha: string;
  finalCommitSha: string;
  /** Present when the artifact records a branch to open the diff against. */
  branch?: string;
  /** What the range means, e.g. "the first successful Git finalization". */
  description?: string;
}

/**
 * One line stating exactly which revisions this artifact covers, so the file
 * is self-describing after it has left AgentFabric (download, copy, paste
 * into a review tool).
 */
export function taskDiffProvenanceLine(o: TaskDiffProvenance): string {
  const branch = o.branch ? ` on ${o.branch}` : "";
  const description = o.description ? ` (${o.description})` : "";
  return `# task diff ${o.baseCommitSha}..${o.finalCommitSha}${branch}${description}\n`;
}

/**
 * The patch header for an artifact: provenance first, then the cap notice when
 * the body below it was cut, then the diff itself. Both notes are plain `#`
 * comment lines of the kind git itself ignores, so the file still applies.
 */
export function renderTaskDiffPatch(diff: RevisionDiff, provenance: TaskDiffProvenance): string {
  const lines = [
    taskDiffProvenanceLine(provenance),
    `# ${summarizeTaskDiff(diff.files)}\n`,
  ];
  if (diff.truncated) {
    lines.push(diffTruncationMarker({ maxBytes: diff.maxBytes, stat: diff.files }));
  }
  return `${lines.join("")}\n${diff.patch}`;
}

/**
 * The human-readable summary of a diff, used as the artifact's `meta.summary`
 * and as the one-line answer to "what did this task change?".
 */
export function summarizeTaskDiff(stat: DiffStat): string {
  const files = `${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"} changed`;
  const binary = stat.binaryFiles > 0 ? ` (${stat.binaryFiles} binary)` : "";
  return `${files}, ${stat.insertions} insertion${stat.insertions === 1 ? "" : "s"}(+), ${stat.deletions} deletion${stat.deletions === 1 ? "" : "s"}(-)${binary}`;
}

/**
 * Builds the artifact draft for a task's diff.
 *
 * `ArtifactDraft` has no numeric stat fields and `types.ts` is owned
 * elsewhere, so everything the UI needs beyond the patch itself travels in
 * `meta` (structured) and in the patch header (durable): `truncated` is both
 * a meta flag and a visible marker line, and the counts are meta values that
 * already equal the ones printed in the header.
 */
export function taskDiffArtifactDraft(o: {
  diff: RevisionDiff;
  provenance: TaskDiffProvenance;
}): ArtifactDraft {
  return {
    name: TASK_DIFF_ARTIFACT_NAME,
    kind: "diff",
    mime: TASK_DIFF_MIME,
    content: renderTaskDiffPatch(o.diff, o.provenance),
    meta: {
      baseCommitSha: o.provenance.baseCommitSha,
      finalCommitSha: o.provenance.finalCommitSha,
      branch: o.provenance.branch,
      filesChanged: o.diff.files.filesChanged,
      insertions: o.diff.files.insertions,
      deletions: o.diff.files.deletions,
      binaryFiles: o.diff.files.binaryFiles,
      truncated: o.diff.truncated,
      maxBytes: o.diff.maxBytes,
      summary: summarizeTaskDiff(o.diff.files),
    },
  };
}
