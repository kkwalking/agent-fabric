import { Store, newId } from "./store.js";
import { now } from "./services.js";
import type {
  Artifact,
  Handoff,
  HandoffContent,
  HandoffSource,
  ID,
  Run,
  RunEvent,
  RuntimeKind,
  Task,
  Workspace,
} from "./types.js";

const MAX_TEXT = 2000;

function clip(text: string | undefined, max = MAX_TEXT): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/* ------------------------------------------------------------------ */
/* AgentFabric-assisted handoff generation (spec v1 §7)                */
/* ------------------------------------------------------------------ */

export interface AssistedHandoffInput {
  task: Task;
  run: Run;
  events: RunEvent[];
  artifacts: Artifact[];
  workspace?: Workspace;
  /** Name of the runtime that produced the run, for attribution. */
  runtimeName?: string;
}

const TEST_FAIL_RE = /\b(\d+\s+(failing|failed))|(\btests?\s+fail)|(\bFAIL\b)|(build failed)|(compilation error)/i;
const TEST_PASS_RE = /\b(\d+\s+pass(ing)?)|(\ball tests passed?)|(\bPASS\b)|(build succeeded)|(build success)/i;
const NEXT_RE = /^(next|todo|remaining|then|follow.?up|still|left|待办|接下来|剩余|尚未)/i;
const DECISION_RE = /\b(decid(ed|e|s)|chose|chosen|we'?ll use|approach|trade-?off|决定|选择|方案)\b/i;

/**
 * Builds a semantic handoff from AgentFabric's own records: the task,
 * the run result, agent messages, workspace status, file changes,
 * artifacts and logs. Deliberately heuristic — AgentFabric orchestrates
 * execution, it does not model agent cognition (spec v1 §22.7).
 */
export function buildAssistedHandoffContent(input: AssistedHandoffInput): HandoffContent {
  const { task, run, events, artifacts, workspace } = input;

  const agentMessages = events
    .filter((e) => e.type === "agent.message")
    .map((e) => String(e.data?.content ?? e.data?.text ?? e.data?.message ?? ""))
    .filter((c) => c.trim().length > 0);
  const finalMessage = agentMessages[agentMessages.length - 1];

  const changedFiles = [...new Set(
    events
      .filter((e) => e.type === "file.created" || e.type === "file.modified")
      .map((e) => String(e.data?.path ?? ""))
      .filter(Boolean)
  )];
  const toolsUsed = [...new Set(
    events
      .filter((e) => e.type === "tool.completed")
      .map((e) => String(e.data?.tool ?? ""))
      .filter(Boolean)
  )];
  const shellLines = events
    .filter((e) => e.type === "shell.output" || e.type === "log")
    .map((e) => String(e.data?.line ?? e.data?.message ?? ""));

  const completedWork: string[] = [];
  for (const f of changedFiles) completedWork.push(`Changed file: ${f}`);
  for (const t of toolsUsed.slice(0, 10)) completedWork.push(`Used tool: ${t}`);
  for (const a of artifacts) completedWork.push(`Produced artifact: ${a.name}`);

  const remainingWork: string[] = [];
  if (finalMessage) {
    for (const line of finalMessage.split("\n").map((l) => l.replace(/^[-**\s]+/, "").trim())) {
      if (line && NEXT_RE.test(line)) remainingWork.push(clip(line, 200)!);
    }
  }
  if (run.status !== "completed") {
    remainingWork.push(`Previous run ended with status "${run.status}"${run.error ? `: ${run.error}` : ""} — verify what was actually finished.`);
  }
  if (remainingWork.length === 0) {
    remainingWork.push("No explicit remaining-work list was recorded; inspect the workspace and continue the original task.");
  }

  const importantDecisions = agentMessages
    .flatMap((m) => m.split("\n"))
    .map((l) => l.replace(/^[-**\s]+/, "").trim())
    .filter((l) => l.length > 8 && DECISION_RE.test(l))
    .slice(0, 5)
    .map((l) => clip(l, 300)!);

  const failedSignals = shellLines.filter((l) => TEST_FAIL_RE.test(l));
  const passSignals = shellLines.filter((l) => TEST_PASS_RE.test(l));
  const testBuildStatus = failedSignals.length
    ? clip(failedSignals[failedSignals.length - 1], 300)
    : passSignals.length
      ? clip(passSignals[passSignals.length - 1], 300)
      : "No explicit test/build result signals found in the run output.";

  const workspaceStatus = workspace
    ? `Workspace "${workspace.name}" (${workspace.type}) at ${workspace.path ?? workspace.repoUrl ?? "unknown"}${workspace.lastSavedAt ? `, last saved ${workspace.lastSavedAt}` : ", not saved since the last run"}.`
    : "No workspace was attached to the previous run.";

  return {
    originalTask: clip(`#${task.title}: ${task.prompt}`),
    currentObjective: clip(task.title, 200),
    progressSummary: clip(
      `Run ${run.id} on ${input.runtimeName ?? run.runtimeName ?? "previous runtime"} ${run.status}` +
      ` (${events.length} events, ${run.usage?.modelRequests ?? 0} model calls).` +
      (finalMessage ? ` Final agent message: ${clip(finalMessage, 600)}` : "")
    ),
    completedWork: completedWork.length ? completedWork : undefined,
    remainingWork,
    importantDecisions: importantDecisions.length ? importantDecisions : undefined,
    relevantFiles: changedFiles.length ? changedFiles : undefined,
    workspaceStatus,
    artifacts: artifacts.length ? artifacts.map((a) => `${a.name} (${a.kind})`) : undefined,
    testBuildStatus,
    previousRunResult: clip(
      `Run ${run.id} finished with status "${run.status}"` +
      (run.error ? `, error: ${run.error}` : "") +
      `; usage: ${run.usage?.inputTokens ?? 0} in / ${run.usage?.outputTokens ?? 0} out tokens, cost ${run.cost ?? 0}.`
    ),
    notesForNextAgent:
      `This handoff was assembled by AgentFabric from execution records (not from the previous harness's internal state). ` +
      `The workspace is shared; inspect it directly. There is no shared session with the previous agent.`,
  };
}

/* ------------------------------------------------------------------ */
/* Handoff → prompt rendering (inject into the next harness)           */
/* ------------------------------------------------------------------ */

/**
 * Renders a handoff as a markdown briefing that becomes part of the next
 * Run's input instruction. The new harness creates its own new native
 * session — only semantics cross the boundary, never session state.
 *
 * The workspace section is always rendered (both render paths): the
 * next agent starts with the workspace as its working directory and the
 * checkpoint's file references are relative to it, so the workspace
 * identity is load-bearing and must never depend on the previous
 * agent's summary mentioning it.
 *
 * When the handoff carries a pi-style compaction checkpoint
 * (`content.compactionSummary`), it is embedded verbatim: the checkpoint
 * is already the exact context summary pi's compaction would inject
 * into a compacted session, so re-rendering it section-by-section would
 * only lose fidelity. The remaining structured fields are rendered
 * otherwise (harness-generated and heuristic fallback handoffs).
 */
export function renderHandoffPrompt(handoff: Handoff, instruction: string): string {
  const c = handoff.content;
  const lines: string[] = [
    `You are continuing an existing task on a new agent harness (${handoff.toRuntimeName ?? "new runtime"}).`,
    `A previous agent (${handoff.fromRuntimeName ?? handoff.fromRuntimeKind ?? "previous runtime"}) already worked on it.`,
    `There is NO shared session between you and the previous agent — work from the handoff below and the shared workspace.`,
    ``,
    `# Workspace`,
    c.workspaceStatus ?? "No workspace was attached to the previous run.",
    `This shared workspace is your current working directory: every relative path in the handoff below refers to it. Do not assume another directory is the project.`,
    ``,
    `# Handoff from ${handoff.fromRuntimeName ?? handoff.fromRuntimeKind ?? "previous agent"} (run ${handoff.fromRunId})`,
  ];

  if (c.compactionSummary) {
    lines.push("", "## Context checkpoint", "", c.compactionSummary);
  } else {
    const section = (title: string, value: string | string[] | undefined) => {
      if (value === undefined) return;
      lines.push("", `## ${title}`);
      if (Array.isArray(value)) value.forEach((v) => lines.push(`- ${v}`));
      else lines.push(value);
    };
    section("Original task", c.originalTask);
    section("Current objective", c.currentObjective);
    section("Progress summary", c.progressSummary);
    section("Completed work", c.completedWork);
    section("Remaining work", c.remainingWork);
    section("Important decisions", c.importantDecisions);
    section("User constraints", c.userConstraints);
    section("Relevant files", c.relevantFiles);
    section("Artifacts", c.artifacts);
    section("Test / build status", c.testBuildStatus);
    section("Previous run result", c.previousRunResult);
    section("Notes for you", c.notesForNextAgent);
  }
  if (handoff.userNotes) {
    lines.push("", `## Notes from the user`, handoff.userNotes);
  }
  lines.push("", `# Your instruction`, instruction);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* HandoffService                                                      */
/* ------------------------------------------------------------------ */

export interface NewHandoffInput {
  taskId: ID;
  fromRunId: ID;
  fromRuntimeId?: ID;
  fromRuntimeName?: string;
  fromRuntimeKind?: RuntimeKind;
  toRuntimeId?: ID;
  toRuntimeName?: string;
  toRuntimeKind?: RuntimeKind;
  source: HandoffSource;
  sources?: HandoffSource[];
  content: HandoffContent;
  userNotes?: string;
  workspaceId?: ID;
  artifactIds?: ID[];
}

export class HandoffService {
  constructor(private store: Store) {}

  list(filter?: { taskId?: ID; runId?: ID }): Handoff[] {
    const all = this.store.list<Handoff>("handoffs");
    const filtered = all.filter(
      (h) =>
        (!filter?.taskId || h.taskId === filter.taskId) &&
        (!filter?.runId || h.fromRunId === filter.runId)
    );
    return filtered
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: ID): Handoff | undefined {
    return this.store.get<Handoff>("handoffs", id);
  }

  async create(input: NewHandoffInput): Promise<Handoff> {
    const sources = [...new Set([...(input.sources ?? []), input.source])];
    const handoff: Handoff = {
      id: newId("hoff"),
      taskId: input.taskId,
      fromRunId: input.fromRunId,
      fromRuntimeId: input.fromRuntimeId,
      fromRuntimeName: input.fromRuntimeName,
      fromRuntimeKind: input.fromRuntimeKind,
      toRuntimeId: input.toRuntimeId,
      toRuntimeName: input.toRuntimeName,
      toRuntimeKind: input.toRuntimeKind,
      source: input.source,
      sources,
      content: input.content,
      userNotes: input.userNotes,
      workspaceId: input.workspaceId,
      artifactIds: input.artifactIds ?? [],
      createdAt: now(),
    };
    return this.store.insert("handoffs", handoff);
  }

  /**
   * Attach user-provided notes to a handoff (spec v1 §7: user-provided
   * handoff). The notes are kept verbatim and folded into the content.
   */
  async addUserNotes(id: ID, notes: string): Promise<Handoff | undefined> {
    const handoff = this.get(id);
    if (!handoff) return undefined;
    const constraints = new Set(handoff.content.userConstraints ?? []);
    constraints.add(notes.trim());
    return this.store.update<Handoff>("handoffs", id, {
      userNotes: handoff.userNotes ? `${handoff.userNotes}\n${notes}` : notes,
      content: { ...handoff.content, userConstraints: [...constraints] },
      sources: [...new Set([...(handoff.sources ?? []), "user" as HandoffSource])],
    });
  }

  async remove(id: ID): Promise<boolean> {
    return this.store.remove("handoffs", id);
  }
}
