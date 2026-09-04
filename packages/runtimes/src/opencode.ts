import type { AgentRuntimeAdapter, RuntimeCapability, RuntimeContext, RuntimeResult, RunEvent } from "@agentfabric/core";
import { runHarnessCommand } from "./harness.js";

interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  [key: string]: unknown;
}

export function opencodeBin(): string {
  return process.env.AGENTFABRIC_OPENCODE_BIN ?? "opencode";
}

/**
 * OpenCode harness capabilities (spec v1 §17): it owns native sessions
 * and can resume them, streams events, and works inside a workspace.
 * It does not generate handoff summaries itself — AgentFabric-assisted
 * handoff covers that case.
 */
export const opencodeCapabilities: Partial<RuntimeCapability> = {
  supportsNativeSession: true,
  supportsNativeResume: true,
  supportsStreamingEvents: true,
  supportsHandoffGeneration: false,
  supportsWorkspace: true,
  supportsInteractiveExecution: false,
};

/**
 * Containerized capabilities (v2 §11): running behind Docker used to
 * silently downgrade OpenCode's JSONL protocol to shell logs, breaking
 * native resume. The execution-backend path now streams the raw output
 * to this adapter and mounts the opaque native-state directory, so the
 * containerized backend is capability-equivalent to local — and these
 * declarations say so truthfully.
 */
export const opencodeContainerizedCapabilities: Partial<RuntimeCapability> = {
  ...opencodeCapabilities,
};

/**
 * Maps an opencode JSONL event to an AgentFabric standard event.
 * Unknown event types degrade to log lines so nothing is lost.
 */
export function mapOpenCodeEvent(raw: string, runId: string, seq: () => number): RunEvent | null {
  let evt: OpenCodeEvent;
  try {
    evt = JSON.parse(raw) as OpenCodeEvent;
  } catch {
    return null;
  }
  const type = evt.type ?? "unknown";
  const timestamp = new Date(evt.timestamp ?? Date.now()).toISOString();
  const data = { ...(evt as Record<string, unknown>) };
  delete data.type;

  const base = {
    id: `evt_${runId}_${seq()}`,
    runId,
    seq: seq(),
    timestamp,
    data,
  };

  if (type.startsWith("message")) {
    const content =
      (evt as Record<string, any>).message?.text ??
      (evt as Record<string, any>).part?.text ??
      (evt as Record<string, any>).text ??
      "";
    const role = (evt as Record<string, any>).message?.role ?? "assistant";
    return {
      ...base,
      type: "agent.message",
      level: "info",
      source: "opencode",
      data: { content, role, raw: data },
    };
  }
  if (type === "tool.started" || type === "tool.completed") {
    const tool = (evt as Record<string, any>).tool?.name ?? (evt as Record<string, any>).tool ?? "unknown";
    return {
      ...base,
      type: type === "tool.started" ? "tool.started" : "tool.completed",
      level: "info",
      source: "opencode",
      data: { tool, ...data },
    };
  }
  if (type.startsWith("shell")) {
    const command = (evt as Record<string, any>).command?.command ?? (evt as Record<string, any>).command;
    const state = (evt as Record<string, any>).state;
    if (type === "shell.started" || state === "running") {
      return { ...base, type: "shell.command", level: "info", source: "opencode", data: { command, ...data } };
    }
    return { ...base, type: "shell.output", level: "info", source: "opencode", data: { line: command ?? JSON.stringify(data), ...data } };
  }
  if (type === "error") {
    return { ...base, type: "runtime.error", level: "error", source: "opencode", data };
  }
  if (type.startsWith("permission")) {
    return { ...base, type: "log", level: "warn", source: "opencode", data: { line: `permission: ${JSON.stringify(data)}` } };
  }
  return { ...base, type: "log", level: "debug", source: "opencode", data: { line: raw } };
}

/**
 * Extracts OpenCode's own session identifier from a raw JSONL line.
 * The value stays opaque — AgentFabric only stores it for resume.
 */
export function extractOpenCodeSessionRef(raw: string): string | undefined {
  try {
    const evt = JSON.parse(raw) as OpenCodeEvent;
    return typeof evt.sessionID === "string" && evt.sessionID ? evt.sessionID : undefined;
  } catch {
    return undefined;
  }
}

function buildArgs(ctx: RuntimeContext): string[] {
  const args = ["run", "--format", "json"];
  const model = ctx.model ? `${ctx.provider?.name ?? "provider"}/${ctx.model.name}` : undefined;
  if (model) args.push("-m", model);
  if (ctx.runtime.config?.agent) args.push("--agent", String(ctx.runtime.config.agent));
  if (ctx.runtime.config?.variant) args.push("--variant", String(ctx.runtime.config.variant));
  if (ctx.task.policy?.autoApprove) args.push("--auto");
  // Native resume: pass the harness's own session reference (spec v1 §3).
  if (ctx.runtimeSession?.nativeSessionRef) args.push("--session", ctx.runtimeSession.nativeSessionRef);
  if (ctx.runtime.config?.logLevel) args.push("--log-level", String(ctx.runtime.config.logLevel));
  return args;
}

/**
 * OpenCode Runtime adapter.
 *
 * One execution loop for both backends (v2 §7–§9): the adapter builds
 * the `opencode run --format json` command and hands it to the
 * execution backend — a local process or a Docker container. Either
 * way, the JSONL stdout is parsed here with the same mapper, the native
 * session id is extracted, and a stored native session reference is
 * resumed via `--session`.
 *
 * Containerized runs mount the runtime's opaque native-state directory
 * at OpenCode's data path so native sessions survive container
 * destruction (v2 §15).
 */
export const opencodeAdapter: AgentRuntimeAdapter = {
  kind: "opencode",
  name: "OpenCode",
  capabilities: opencodeCapabilities,
  containerizedCapabilities: opencodeContainerizedCapabilities,
  nativeStateMountPath: "/root/.local/share/opencode",

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    // This run's instruction: the rendered handoff for continuity runs,
    // otherwise the task's original prompt (spec v1 §20 Inject Handoff).
    const prompt = ctx.run.inputInstruction ?? ctx.task.prompt;
    return runHarnessCommand(ctx, {
      bin: opencodeBin(),
      args: buildArgs(ctx),
      prompt,
      source: "opencode",
      image: ctx.runtime.image ?? "ghcr.io/sst/opencode",
      workspaceContainerPath: "/workspace",
      mapLine: mapOpenCodeEvent,
      extractSessionRef: extractOpenCodeSessionRef,
    });
  },

  async cancel(ctx) {
    await ctx.log("OpenCode run cancelled", "warn");
  },

  describe() {
    return { needsDocker: false, needsModel: false, cli: opencodeBin() };
  },
};
