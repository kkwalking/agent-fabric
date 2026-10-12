/**
 * Validation (v12): a natural-language acceptance standard judged by a
 * separate Validation Agent.
 *
 * A Project or Task may declare a `validation.prompt` — "go build and the
 * full test suite pass", "no new TypeScript errors", whatever the user can
 * state. The supervisor runs it as a **second agent in a fresh container**
 * (a normal Run with `purpose: "validation"`), on a frozen commit (the
 * round's pin). A failed verdict sends the work back to the development
 * agent; three failed verdicts end the Task.
 *
 * This module owns the pure parts: config resolution, the judge / rework
 * instruction builders, and the verdict contract. The orchestration lives in
 * `supervisor.ts`; the verdict tool script lives in `validationTool.ts`.
 */
import type { ValidationConfig, ValidationVerdict } from "./types.js";

/** Verdicts allowed in one validation cycle when the config says nothing. */
export const DEFAULT_VALIDATION_MAX_ATTEMPTS = 3;

/** Container-side path of the generated verdict tool script. */
export const VALIDATION_TOOL_CONTAINER_PATH = "/root/.agentfabric/validation-tool.mjs";
/** Container-side directory the judge writes its verdict to. */
export const VALIDATION_OUTPUT_CONTAINER_PATH = "/root/.agentfabric/validation-output";

/**
 * The effective validation config: a Task's declaration replaces the
 * Project's entirely (same rule as skills / MCP, v12 §3), and no
 * declaration at all means the stage is skipped.
 */
export function resolveValidationConfig(
  taskConfig: ValidationConfig | undefined,
  projectConfig: ValidationConfig | undefined
): ValidationConfig | undefined {
  return taskConfig ?? projectConfig;
}

/**
 * A config that exists must be usable: an empty prompt is a configuration
 * error, never a silent skip (v12 §3.1). Returns the problem as a message
 * (or `undefined` when the config is fine); the write boundaries (project /
 * task creation and update) turn it into a `config-invalid` domain error,
 * so an invalid config never reaches a record.
 */
export function validationConfigProblem(config: ValidationConfig | undefined): string | undefined {
  if (config === undefined) return undefined;
  if (typeof config.prompt !== "string" || !config.prompt.trim()) {
    return "validation.prompt must be a non-empty string";
  }
  if (config.maxAttempts !== undefined && (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1)) {
    return "validation.maxAttempts must be a positive integer";
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Instructions                                                        */
/* ------------------------------------------------------------------ */

export interface JudgeInstructionInput {
  /** The original task instruction — what the development agent was asked to do. */
  taskInstruction: string;
  /** The user's acceptance standard. */
  validationPrompt: string;
  /** Commit the work is frozen at (the round's pin). */
  pinnedCommitSha: string;
  /** Revision the task started from. */
  baseCommitSha?: string;
  /** Host path / container path of the verdict tool script. */
  toolPath: string;
  /** Host path / container path the verdict must be written to. */
  outputPath: string;
  /** Workspace path inside the judge's environment. */
  workspacePath: string;
  /** 1-based round number and the cycle budget. */
  round: number;
  maxAttempts: number;
}

/**
 * The judge's instruction. It deliberately does **not** include the
 * development agent's conversation (v12 §4.2): the judge forms its own
 * opinion from the repository and from commands it runs itself.
 */
export function buildJudgeInstruction(input: JudgeInstructionInput): string {
  const diffHint = input.baseCommitSha
    ? `The task started from ${input.baseCommitSha}; \`git -C ${input.workspacePath} diff ${input.baseCommitSha.slice(0, 12)}..${input.pinnedCommitSha.slice(0, 12)}\` shows exactly what the development agent changed.`
    : `\`git -C ${input.workspacePath} log -1\` shows the frozen revision.`;
  return [
    "You are a validation agent. A development agent has finished work on a coding task, and your job is to decide — from actual evidence — whether the work satisfies the acceptance standard below.",
    "You are not the developer: do not fix anything, do not modify the repository.",
    "",
    "# The task the development agent was given",
    input.taskInstruction,
    "",
    "# Acceptance standard",
    input.validationPrompt,
    "",
    "# How to work",
    `- The repository is at ${input.workspacePath} and is mounted READ-ONLY. Any write there is detected and replayed away by the platform — do not attempt it.`,
    `- The work under review is frozen at commit ${input.pinnedCommitSha} (the workspace HEAD). ${diffHint}`,
    `- To build, test or inspect the code, copy the tree to a writable location first, for example:`,
    `    cp -a ${input.workspacePath} /tmp/review && cd /tmp/review`,
    "- Run whatever commands the acceptance standard requires and observe the real results.",
    "",
    "# Judging discipline",
    "- Base every conclusion on commands you actually ran and their output. Never judge from reading the code alone.",
    "- If something the standard requires cannot be run in this environment, say so in the verdict instead of guessing.",
    "",
    "# Submitting your verdict",
    "When you have decided, submit it by running:",
    `    node ${input.toolPath} --passed --summary "..." --evidence "..."`,
    "or, when the standard is not met:",
    `    node ${input.toolPath} --failed --summary "..." --unmet "..." --evidence "..."`,
    "- --summary: a 1-3 sentence conclusion.",
    "- --unmet: one flag per acceptance requirement that is NOT satisfied (required for a failure verdict).",
    '- --evidence: one flag per "command → observed result" pair (required; at least one).',
    `- The tool validates the payload and writes it to ${input.outputPath}; it exits non-zero with the reason when the payload is invalid — fix the payload and call it again.`,
    `- If the tool cannot run here, write the same JSON yourself to ${input.outputPath}:`,
    '    { "passed": <true|false>, "summary": "...", "unmet": ["..."], "evidence": ["..."] }',
    `This is round ${input.round} of at most ${input.maxAttempts}.`,
  ].join("\n");
}

export interface ReworkInstructionInput {
  /** The original task instruction. */
  taskInstruction: string;
  /** The failed verdict. */
  verdict: ValidationVerdict;
  /** 1-based round the verdict came from, and the cycle budget. */
  round: number;
  maxAttempts: number;
}

/**
 * The rework instruction: the original instruction plus the judge's
 * conclusion — **never** the validation prompt itself (v12 §4.3). The
 * development agent gets actionable findings, not the acceptance standard
 * to game.
 */
export function buildReworkInstruction(input: ReworkInstructionInput): string {
  const { verdict } = input;
  const lines = [
    input.taskInstruction,
    "",
    "---",
    `Your previous work did not pass validation (round ${input.round} of at most ${input.maxAttempts}). The validation agent's conclusion:`,
    "",
    verdict.summary,
  ];
  if (verdict.unmet.length > 0) {
    lines.push("", "Unmet requirements:", ...verdict.unmet.map((u) => `- ${u}`));
  }
  if (verdict.evidence.length > 0) {
    lines.push("", "Evidence the validation agent gathered (commands and observed results):", ...verdict.evidence.map((e) => `- ${e}`));
  }
  lines.push("", "Fix these specific problems. The workspace still contains all of your previous work — continue from it.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Verdict contract                                                    */
/* ------------------------------------------------------------------ */

export type VerdictParseResult = { ok: true; verdict: VerdictPayload } | { ok: false; error: string };

/** The payload the judge submits — the verdict minus the platform's bookkeeping. */
export interface VerdictPayload {
  passed: boolean;
  summary: string;
  unmet: string[];
  evidence: string[];
}

/**
 * Validates one verdict payload against the contract (v12 §5). Used twice:
 * by the generated tool script (so the judge gets immediate, actionable
 * feedback) and by the supervisor when it freezes the verdict at generation
 * time. The two must agree — this function is the contract.
 */
export function parseVerdictPayload(raw: unknown): VerdictParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "the verdict must be a JSON object" };
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.passed !== "boolean") {
    return { ok: false, error: "`passed` must be a boolean" };
  }
  if (typeof value.summary !== "string" || !value.summary.trim()) {
    return { ok: false, error: "`summary` must be a non-empty string" };
  }
  const unmet = toStringArray(value.unmet);
  if (unmet === undefined) {
    return { ok: false, error: "`unmet` must be an array of strings" };
  }
  const evidence = toStringArray(value.evidence);
  if (evidence === undefined) {
    return { ok: false, error: "`evidence` must be an array of strings" };
  }
  if (!value.passed && unmet.length === 0) {
    return { ok: false, error: "a failed verdict must name at least one unmet requirement" };
  }
  if (evidence.length === 0) {
    return { ok: false, error: "`evidence` must contain at least one command → result entry" };
  }
  return {
    ok: true,
    verdict: { passed: value.passed, summary: value.summary.trim(), unmet, evidence },
  };
}

function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}
