import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainError, type Run, type RunService, type RuntimeService, type TaskService, type WorkspaceService } from "@agentfabric/core";

const kinds = ["codex", "claude-code", "pi"] as const;
const active = new Set(["pending", "starting", "running"]);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
type Delegation = { tokenSha256: string; workspaceIds: string[]; runtimeIds: string[] };
export type Services = {
  tasks: Pick<TaskService, "get" | "getLive">;
  runs: Pick<RunService, "get" | "submit" | "cancel" | "events">;
  runtimes: Pick<RuntimeService, "get">;
  workspaces: Pick<WorkspaceService, "get">;
};

export async function loadDelegation(dataDir: string): Promise<Delegation | undefined> {
  const file = join(dataDir, "mcp-delegation.json");
  const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  const config: unknown = JSON.parse(raw);
  const ids = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string" && identifier.test(id))
      && new Set(value).size === value.length;
  if (!object(config) || Object.keys(config).length !== 3 ||
    typeof config.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.tokenSha256) ||
    !ids(config.workspaceIds) || !ids(config.runtimeIds)) {
    throw new Error("mcp-delegation.json requires tokenSha256, workspaceIds and runtimeIds");
  }
  return { tokenSha256: config.tokenSha256, workspaceIds: config.workspaceIds, runtimeIds: config.runtimeIds };
}

export function authorized(config: Delegation, header: string | undefined): boolean {
  const token = /^Bearer ([a-f0-9]{64})$/i.exec(header ?? "")?.[1];
  return token !== undefined && timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(config.tokenSha256, "hex"));
}

class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const fields = {
  workspaceId: { type: "string", pattern: identifier.source },
  runtimeId: { type: "string", pattern: identifier.source },
  requestId: { type: "string", pattern: identifier.source, description: "Unique submission key. Reuse only to retry the same submission." },
  goal: { type: "string", minLength: 1, maxLength: 12000 },
  runId: { type: "string", pattern: identifier.source },
};
const definitions = {
  list_workspaces: { description: "List authorized workspace IDs and configured Codex, Claude Code, and Pi runtime IDs.", keys: [] },
  submit_task: { description: "Start a fresh Agent Fabric run in an authorized workspace using a listed runtime; returns IDs immediately.", keys: ["workspaceId", "runtimeId", "requestId", "goal"] },
  get_task: { description: "Check a delegated run by runId and retrieve its result after it finishes.", keys: ["runId"] },
  cancel_task: { description: "Request cancellation of a delegated run by runId. Workspace changes are preserved.", keys: ["runId"] },
} as const;
type ToolName = keyof typeof definitions;
export const isTool = (name: unknown): name is ToolName => typeof name === "string" && Object.hasOwn(definitions, name);
export const delegationTools = Object.entries(definitions).map(([name, { description, keys }]) => ({
  name, description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(keys.map((key) => [key, fields[key]])),
    required: keys,
    additionalProperties: false,
  },
}));

function summary(run: Run) {
  return { taskId: run.taskId, runId: run.id, status: run.status, runtimeId: run.runtimeId, workspaceId: run.workspaceId };
}

function toolResult(data: object, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError } : {}) };
}

export function delegationToolsFor(config: Delegation, { tasks, runs, runtimes, workspaces }: Services) {
  const pending = new Map<string, Promise<Run>>();
  function workspace(id: string) {
    return config.workspaceIds.includes(id) ? workspaces.get(id) : undefined;
  }
  function runtime(id: string) {
    const r = config.runtimeIds.includes(id) ? runtimes.get(id) : undefined;
    return r?.enabled && r.usableInTask && kinds.some((kind) => kind === r.kind) ? r : undefined;
  }
  function delegatedRun(runId: string): Run {
    const run = runs.get(runId);
    const task = run && tasks.getLive(run.taskId);
    if (!run || !task || task.metadata?.delegationRunId !== run.id ||
      !run.workspaceId || !workspace(run.workspaceId) || !run.runtimeId || !config.runtimeIds.includes(run.runtimeId)) {
      throw new ToolError("run-not-found", "No accessible delegated run has that ID.");
    }
    return run;
  }

  async function submit(args: Record<string, string>): Promise<Run> {
    const { workspaceId, runtimeId, requestId, goal } = args;
    if (!workspace(workspaceId)) throw new ToolError("workspace-not-allowed", "Select an authorized workspace from list_workspaces.");
    if (!runtime(runtimeId)) throw new ToolError("runtime-not-allowed", "Select an available runtime from list_workspaces.");
    const key = digest(requestId);
    const taskId = `task_mcp_${key}`;
    const runId = `run_mcp_${key}`;
    const fingerprint = digest(JSON.stringify([workspaceId, runtimeId, goal]));
    // Concurrent retries wait for the one submitter; on restart, the Task and
    // Run records bind the idempotency key to its first accepted request.
    const inflight = pending.get(taskId);
    if (inflight) await inflight;
    const existing = tasks.get(taskId);
    if (existing) {
      if (existing.metadata?.delegationFingerprint !== fingerprint) {
        throw new ToolError("request-id-conflict", "This requestId is already bound to another submission.");
      }
      const run = runs.get(runId);
      if (!run) throw new ToolError("submission-interrupted", "Submission stopped before a run was created. Inspect the task in Fabric before trying a new requestId.");
      return delegatedRun(runId);
    }
    const submission = runs.submit({
      // Adapters pass the prompt as a positional CLI argument. Use a fixed
      // prefix so a caller cannot supply a flag or a Pi @file argument.
      id: taskId, workspaceId, runtimeId, title: goal.trim().slice(0, 80),
      prompt: `Complete this delegated task:\n\n${goal}`,
      metadata: { source: "mcp-delegation", delegationRunId: runId, delegationFingerprint: fingerprint },
    }, { runId }).then(({ run }) => run);
    pending.set(taskId, submission);
    try {
      return await submission;
    } finally {
      pending.delete(taskId);
    }
  }

  return async (name: ToolName, inputs: unknown) => {
    try {
      const keys: readonly string[] = definitions[name].keys;
      const args = inputs === undefined ? {} : inputs;
      if (!object(args) || Object.keys(args).length !== keys.length || keys.some((key) =>
        !Object.hasOwn(args, key) || typeof args[key] !== "string" ||
        (key === "goal" ? !(args[key] as string).trim() || (args[key] as string).includes("\0") || (args[key] as string).length > 12000 : !identifier.test(args[key] as string)),
      )) throw new ToolError("invalid-arguments", `Expected only: ${keys.join(", ") || "no arguments"}.`);
      const strings = args as Record<string, string>;
      if (name === "list_workspaces") {
        return toolResult({
          workspaces: config.workspaceIds.flatMap((id) => {
            const ws = workspace(id);
            return ws ? [{ id, name: ws.name }] : [];
          }),
          runtimes: config.runtimeIds.flatMap((id) => {
            const r = runtime(id);
            return r ? [{ id, name: r.name, kind: r.kind }] : [];
          }),
        });
      }
      if (name === "submit_task") return toolResult(summary(await submit(strings)));
      const run = delegatedRun(strings.runId);
      if (name === "cancel_task") {
        const requested = active.has(run.status);
        const current = requested ? await runs.cancel(run.id) : run;
        if (!current) throw new ToolError("run-not-found", "The delegated run no longer exists.");
        return toolResult({ ...summary(current), cancellationRequested: requested });
      }
      if (active.has(run.status)) return toolResult(summary(run));
      const final = (await runs.events(run.id)).slice().reverse().find((event) => event.type === "agent.message" &&
        event.data.role === "assistant" && typeof event.data.content === "string" && event.data.content.trim());
      const answer = final?.data.content as string | undefined;
      return toolResult({
        ...summary(run), artifactIds: run.artifactIds,
        ...(run.errorKind ? { errorKind: run.errorKind } : {}),
        ...(answer === undefined ? {} : { answer: answer.slice(0, 24000), answerTruncated: answer.length > 24000 }),
      });
    } catch (error) {
      // Internal diagnostics may contain paths or credentials. Keep them off
      // the delegation wire; callers can inspect restricted details in Fabric.
      if (error instanceof ToolError) return toolResult({ code: error.code, message: error.message }, true);
      return toolResult({
        code: error instanceof DomainError ? error.code : "delegation-failed",
        message: "Agent Fabric could not complete this operation. Check the task and configuration in Fabric.",
      }, true);
    }
  };
}
