import type {
  AgentRuntimeAdapter,
  RuntimeCapability,
  RuntimeContext,
  RuntimeResult,
  RunEvent,
  Usage,
} from "@agentfabric/core";
import { runHarnessCommand } from "./harness.js";

/**
 * OpenCode harness adapter — protocol shapes verified against the
 * current OpenCode CLI (`opencode run --format json`, 1.x line):
 *
 * Every stdout line is one JSON object:
 *   {"type":"<t>","timestamp":<epoch ms>,"sessionID":"ses_…",…payload}
 * with exactly these `type` values:
 * - "step_start"  {part}        — a reasoning step begins
 * - "text"        {part}        — completed assistant text (part.text)
 * - "reasoning"   {part}        — reasoning text (only with --thinking)
 * - "tool_use"    {part}        — a tool call reached a terminal state;
 *                                 part.tool, part.state.status
 *                                 ("completed" | "error"), part.state
 *                                 {input, output?, error?, metadata}
 * - "step_finish" {part}        — step summary; part.tokens
 *                                 {input, output, reasoning,
 *                                  cache:{read, write}} and part.cost
 *                                 (single USD number)
 * - "error"       {error}       — session/prompt error
 *
 * Note the CLI only emits tool calls at *terminal* states, so
 * tool.started/tool.progress cannot be produced truthfully from
 * `run --format json` — completed tool calls map to tool.completed
 * (v3 §6: the adapter converts OpenCode's *native* events; it must not
 * invent AgentFabric-style ones).
 *
 * Sessions live under $XDG_DATA_HOME/opencode (~/.local/share/opencode,
 * storage/session/…) and resume with `--session <ses_id>`.
 */
interface OpenCodeEvent {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: OpenCodePart;
  error?: { name?: string; message?: string; data?: { message?: string } };
  [key: string]: unknown;
}

interface OpenCodePart {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  reason?: string;
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  [key: string]: unknown;
}

export function opencodeBin(): string {
  return process.env.AGENTFABRIC_OPENCODE_BIN ?? "opencode";
}

/**
 * Default container image (v3 §11): the currently maintained official
 * runtime image. The project moved off the stale `ghcr.io/sst/opencode`
 * name — `ghcr.io/anomalyco/opencode` is what the OpenCode publish
 * pipeline actually pushes (entrypoint `opencode`, runs as root, state
 * at /root/.local/share/opencode).
 */
export const OPENCODE_DEFAULT_IMAGE = "ghcr.io/anomalyco/opencode";

export function opencodeImage(): string {
  return process.env.AGENTFABRIC_OPENCODE_IMAGE ?? OPENCODE_DEFAULT_IMAGE;
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
 * Containerized capabilities (v2 §11, v3 §16/§17): the official image's
 * entrypoint is the `opencode` CLI and the opaque native-state directory
 * ($XDG_DATA_HOME/opencode → /root/.local/share/opencode) is mounted by
 * the execution backend, so containerized runs are capability-equivalent
 * to local ones — streaming stays structured and native sessions
 * survive container destruction.
 */
export const opencodeContainerizedCapabilities: Partial<RuntimeCapability> = {
  ...opencodeCapabilities,
};

/**
 * Maps an opencode `run --format json` line to an AgentFabric standard
 * event (v3 §6). Native event types are converted here; unknown types
 * degrade to raw debug logs so nothing is lost — identical for local
 * and containerized execution (v3 §7).
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
  const base = {
    id: `evt_${runId}_${seq()}`,
    runId,
    seq: seq(),
    timestamp,
  };

  switch (type) {
    case "step_start":
      return {
        ...base,
        type: "run.progress",
        level: "debug",
        source: "opencode",
        data: { phase: "step_start", sessionID: evt.sessionID },
      };

    case "text": {
      const text = evt.part?.text ?? "";
      return {
        ...base,
        type: "agent.message",
        level: "info",
        source: "opencode",
        data: { content: text, role: "assistant", sessionID: evt.sessionID },
      };
    }

    case "reasoning":
      return {
        ...base,
        type: "agent.thinking",
        level: "debug",
        source: "opencode",
        data: { content: evt.part?.text ?? "", sessionID: evt.sessionID },
      };

    case "tool_use": {
      // The CLI only reports terminal tool states; "error" is still a
      // completed tool call (with an error payload), not a runtime error.
      const part = evt.part;
      const status = part?.state?.status ?? "completed";
      const failed = status === "error";
      return {
        ...base,
        type: "tool.completed",
        level: failed ? "warn" : "info",
        source: "opencode",
        data: {
          tool: part?.tool ?? "unknown",
          callID: part?.callID,
          status,
          input: part?.state?.input,
          output: part?.state?.output,
          error: part?.state?.error,
          title: part?.state?.title,
          metadata: part?.state?.metadata,
          sessionID: evt.sessionID,
        },
      };
    }

    case "step_finish":
      return {
        ...base,
        type: "run.progress",
        level: "debug",
        source: "opencode",
        data: {
          phase: "step_finish",
          reason: evt.part?.reason,
          cost: evt.part?.cost,
          sessionID: evt.sessionID,
        },
      };

    case "error": {
      const err = evt.error;
      const message =
        err?.data?.message ?? err?.message ?? (typeof err === "object" ? JSON.stringify(err) : String(err));
      return {
        ...base,
        type: "runtime.error",
        level: "error",
        source: "opencode",
        data: { error: message, name: err?.name, sessionID: evt.sessionID },
      };
    }

    default:
      return { ...base, type: "log", level: "debug", source: "opencode", data: { line: raw } };
  }
}

/**
 * Extracts OpenCode's own session identifier from a raw JSONL line.
 * Every `run --format json` line carries the top-level `sessionID`;
 * the value stays opaque — AgentFabric only stores it for resume.
 */
export function extractOpenCodeSessionRef(raw: string): string | undefined {
  try {
    const evt = JSON.parse(raw) as OpenCodeEvent;
    return typeof evt.sessionID === "string" && evt.sessionID ? evt.sessionID : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts per-step usage from an opencode `step_finish` line (v3 §8):
 * tokens {input, output, reasoning, cache{read, write}} and a single
 * USD cost number. Each step_finish is one completed model request.
 */
export function parseOpenCodeUsage(raw: string): Usage | undefined {
  let evt: OpenCodeEvent;
  try {
    evt = JSON.parse(raw) as OpenCodeEvent;
  } catch {
    return undefined;
  }
  if (evt.type !== "step_finish" || !evt.part) return undefined;
  const tokens = evt.part.tokens;
  if (!tokens) return undefined;
  return {
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cachedTokens: (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0),
    reasoningTokens: tokens.reasoning ?? 0,
    modelRequests: 1,
    estimatedCost: typeof evt.part.cost === "number" ? evt.part.cost : undefined,
  };
}

function buildArgs(ctx: RuntimeContext): string[] {
  const args = ["run", "--format", "json"];
  const model = ctx.model ? `${ctx.provider?.name ?? "provider"}/${ctx.model.name}` : undefined;
  if (model) args.push("-m", model);
  if (ctx.runtime.config?.agent) args.push("--agent", String(ctx.runtime.config.agent));
  if (ctx.runtime.config?.variant) args.push("--variant", String(ctx.runtime.config.variant));
  if ((ctx.policy ?? ctx.task.policy)?.autoApprove) args.push("--auto");
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
 * session id is extracted from the envelope, and a stored native
 * session reference is resumed via `--session`.
 *
 * Containerized runs mount the runtime's opaque native-state directory
 * at OpenCode's data path ($XDG_DATA_HOME/opencode) so native sessions
 * survive container destruction (v2 §15). The default image is the
 * maintained official runtime image whose entrypoint *is* the CLI
 * (v3 §11/§12 — the image is part of the Harness Execution Contract).
 */
export const opencodeAdapter: AgentRuntimeAdapter = {
  kind: "opencode",
  name: "OpenCode",
  capabilities: opencodeCapabilities,
  containerizedCapabilities: opencodeContainerizedCapabilities,
  nativeStateMountPath: "/root/.local/share/opencode",
  defaultImage: OPENCODE_DEFAULT_IMAGE,

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    // This run's instruction: the rendered handoff for continuity runs,
    // otherwise the task's original prompt (spec v1 §20 Inject Handoff).
    const prompt = ctx.run.inputInstruction ?? ctx.task.prompt;
    return runHarnessCommand(ctx, {
      bin: opencodeBin(),
      args: buildArgs(ctx),
      prompt,
      source: "opencode",
      image: ctx.runtime.image ?? opencodeImage(),
      workspaceContainerPath: "/workspace",
      mapLine: mapOpenCodeEvent,
      extractSessionRef: extractOpenCodeSessionRef,
      parseUsage: parseOpenCodeUsage,
    });
  },

  async cancel(ctx) {
    await ctx.log("OpenCode run cancelled", "warn");
  },

  describe() {
    return { needsDocker: false, needsModel: false, cli: opencodeBin(), defaultImage: OPENCODE_DEFAULT_IMAGE };
  },
};
