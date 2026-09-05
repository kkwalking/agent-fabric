import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRuntimeAdapter,
  ProviderCompatibility,
  RuntimeCapability,
  RuntimeContext,
  RuntimeResult,
  RunEvent,
  Usage,
} from "@agentfabric/core";
import { runHarnessCommand } from "./harness.js";
import {
  buildOpenCodeConfig,
  OPENCODE_KNOWN_PROVIDER_IDS,
  providerSlug,
  splitModelParameters,
  writeOpenCodeConfig,
} from "./provider-config.js";

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

/** Model parameter keys opencode genuinely applies (v4 §7/§8). */
const OPENCODE_SUPPORTED_MODEL_PARAMETERS = ["maxTokens", "contextWindow", "reasoningEffort"] as const;

/** opencode built-in tools an agent tools map can toggle. */
const OPENCODE_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "list",
  "patch",
  "todowrite",
  "todoread",
  "webfetch",
  "task",
] as const;

/** Where the generated config is mounted inside a container. */
const OPENCODE_CONFIG_CONTAINER_PATH = "/root/.agentfabric/opencode.json";

/**
 * Provider compatibility (v4 §4): the generated opencode.json carries the
 * full AgentFabric provider definition — npm adapter, base URL, env-
 * templated API key and custom headers all reach the real requests.
 */
export const opencodeProviderCompatibility: ProviderCompatibility = {
  customProvider: true,
  baseUrl: true,
  customHeaders: true,
  supportedModelParameters: [...OPENCODE_SUPPORTED_MODEL_PARAMETERS],
};

/**
 * Builds the opencode CLI args for a run. Policy comes only from the
 * resolved run policy (v4 §13); the model selector uses the AgentFabric
 * provider slug registered in the generated config. When AgentFabric
 * injected an `agentfabric` agent (system instructions / tool policy),
 * that agent wins over a user-configured `runtime.config.agent` — the
 * profile's configuration must reach the harness (v4 §10).
 */
function buildArgs(ctx: RuntimeContext, useAgentfabricAgent: boolean): string[] {
  const policy = ctx.policy;
  const args = ["run", "--format", "json"];
  if (ctx.provider && ctx.model) {
    args.push("-m", `${providerSlug(ctx.provider)}/${ctx.model.name}`);
  } else if (ctx.model) {
    args.push("-m", ctx.model.name);
  }
  if (useAgentfabricAgent) {
    args.push("--agent", "agentfabric");
  } else if (ctx.runtime.config?.agent) {
    args.push("--agent", String(ctx.runtime.config.agent));
  }
  if (ctx.runtime.config?.variant) args.push("--variant", String(ctx.runtime.config.variant));
  const reasoningEffort = ctx.model?.parameters?.reasoningEffort;
  if (typeof reasoningEffort === "string") args.push("--variant", reasoningEffort);
  if (policy?.autoApprove) args.push("--auto");
  // Native resume: pass the harness's own session reference (spec v1 §3).
  if (ctx.runtimeSession?.nativeSessionRef) args.push("--session", ctx.runtimeSession.nativeSessionRef);
  if (ctx.runtime.config?.logLevel) args.push("--log-level", String(ctx.runtime.config.logLevel));
  return args;
}

/**
 * Emits explicit warnings for model parameters opencode cannot honor
 * (v4 §8) — configuration is never silently dropped.
 */
function warnUnsupportedParameters(ctx: RuntimeContext): void {
  if (!ctx.model?.parameters) return;
  const { unsupported } = splitModelParameters(ctx.model.parameters, OPENCODE_SUPPORTED_MODEL_PARAMETERS);
  const keys = Object.keys(unsupported);
  if (keys.length === 0) return;
  void ctx.emit(
    "log",
    {
      line: `opencode ignores unsupported model parameters: ${keys.join(", ")} (supported: ${OPENCODE_SUPPORTED_MODEL_PARAMETERS.join(", ")})`,
      kind: "config-warning",
      scope: "model-parameters",
      unsupported: keys,
      supported: [...OPENCODE_SUPPORTED_MODEL_PARAMETERS],
    },
    { level: "warn", source: "opencode" }
  );
}

/**
 * Generates the run's `opencode.json` (v4 §1/§3/§4/§10/§15/§16) and
 * wires `OPENCODE_CONFIG` to it:
 *
 * - provider entry from the AgentFabric provider (npm package per type,
 *   baseURL, `{env:…}` API key, custom headers);
 * - `permission` from the resolved policy (shell deny → bash deny);
 * - an `agentfabric` agent carrying the profile's system instructions
 *   and the tool allowlist whenever either is configured.
 *
 * Local runs point at the host file directly; containerized runs mount
 * it read-only and point at the container path.
 */
async function prepareProviderConfig(ctx: RuntimeContext): Promise<boolean> {
  if (!ctx.provider) return false;
  const policy = ctx.policy;
  // Shell policy → opencode's native permission system (v4 §15/§16).
  // Headless `opencode run` cannot answer "ask" prompts — the harness
  // logs "permission requested: …; auto-rejecting" and the tool call
  // fails. opencode gates bash's `workdir` parameter behind its
  // external_directory permission (built-in default "ask"), so a plain
  // allow policy must allow it too, or any workdir-using call is
  // auto-rejected even when it points inside the workspace.
  const shell = policy?.shell ?? "allow";
  const permission: Record<string, unknown> =
    shell === "deny"
      ? { bash: "deny" }
      : shell === "ask"
        ? { bash: "ask" }
        : { bash: "allow", external_directory: "allow" };

  const toolAllow = policy?.toolPermissions;
  const unknownTools = (toolAllow ?? []).filter((t) => !(OPENCODE_TOOLS as readonly string[]).includes(t));
  const needAgent = Boolean(ctx.systemInstructions?.trim()) || Boolean(toolAllow?.length) || shell === "deny";
  const agent = needAgent
    ? {
        ...(ctx.systemInstructions?.trim() ? { prompt: ctx.systemInstructions } : {}),
        ...(ctx.model ? { model: `${providerSlug(ctx.provider)}/${ctx.model.name}` } : {}),
        ...(toolAllow?.length
          ? {
              tools: Object.fromEntries(
                OPENCODE_TOOLS.map((tool) => [
                  tool,
                  (shell === "deny" && tool === "bash") ? false : toolAllow.includes(tool),
                ])
              ),
            }
          : shell === "deny"
            ? { tools: { bash: false } }
            : {}),
      }
    : undefined;

  if (unknownTools.length > 0) {
    await ctx.emit(
      "log",
      {
        line: `opencode does not know these tools (ignored): ${unknownTools.join(", ")} (known: ${OPENCODE_TOOLS.join(", ")})`,
        kind: "config-warning",
        scope: "tools",
        unsupported: unknownTools,
      },
      { level: "warn", source: "opencode" }
    );
  }
  if (shell === "ask") {
    await ctx.emit(
      "log",
      {
        line: "opencode runs headless and cannot answer 'ask' permission prompts — bash tool calls will be auto-rejected (set policy.shell to allow/deny, or policy.autoApprove)",
        kind: "config-warning",
        scope: "permission",
        shell,
      },
      { level: "warn", source: "opencode" }
    );
  }

  const hostDir = join(ctx.dataDir, "harness-state", ctx.runtime.id);
  mkdirSync(hostDir, { recursive: true });
  const hostPath = join(hostDir, "opencode.json");
  // Built-in passthrough (v4 §3): a provider with neither a base URL nor
  // an AgentFabric key whose slug opencode knows natively is served by
  // the harness's own registry + auth instead of an overriding entry.
  const slug = providerSlug(ctx.provider);
  const builtinPassthrough =
    !ctx.provider.baseUrl &&
    !ctx.provider.apiKeySecretId &&
    OPENCODE_KNOWN_PROVIDER_IDS.has(slug);
  writeOpenCodeConfig(
    hostPath,
    buildOpenCodeConfig({
      provider: ctx.provider,
      models: ctx.providerModels ?? (ctx.model ? [ctx.model] : []),
      permission: Object.keys(permission).length > 0 ? permission : undefined,
      agent,
      builtinPassthrough,
    })
  );

  if (ctx.runtime.containerized) {
    ctx.env.OPENCODE_CONFIG = OPENCODE_CONFIG_CONTAINER_PATH;
  } else {
    ctx.env.OPENCODE_CONFIG = hostPath;
  }
  await ctx.emit(
    "log",
    {
      line: `opencode provider config injected: ${slug}${builtinPassthrough ? " (built-in passthrough — harness-native auth applies)" : ""} (OPENCODE_CONFIG=${ctx.env.OPENCODE_CONFIG})`,
      kind: "config-injected",
      scope: "provider",
      provider: ctx.provider.name,
      slug,
      baseUrl: ctx.provider.baseUrl,
      hasCustomHeaders: Boolean(ctx.provider.headers && Object.keys(ctx.provider.headers).length > 0),
      builtinPassthrough,
      shellPolicy: shell,
      permission,
      agentInjected: Boolean(agent),
    },
    { level: "info", source: "opencode" }
  );
  return Boolean(agent);
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
  providerCompatibility: opencodeProviderCompatibility,

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    // Provider configuration first: OPENCODE_CONFIG must exist before
    // opencode resolves -m <provider>/<model> (v4 §1).
    const useAgentfabricAgent = await prepareProviderConfig(ctx);
    warnUnsupportedParameters(ctx);
    // This run's instruction: the rendered handoff for continuity runs,
    // otherwise the task's original prompt (spec v1 §20 Inject Handoff).
    const prompt = ctx.run.inputInstruction ?? ctx.task.prompt;
    const hostConfig = join(ctx.dataDir, "harness-state", ctx.runtime.id, "opencode.json");
    return runHarnessCommand(ctx, {
      bin: opencodeBin(),
      args: buildArgs(ctx, useAgentfabricAgent),
      prompt,
      source: "opencode",
      image: ctx.runtime.image ?? opencodeImage(),
      workspaceContainerPath: "/workspace",
      extraMounts: ctx.runtime.containerized
        ? [{ hostPath: hostConfig, containerPath: OPENCODE_CONFIG_CONTAINER_PATH }]
        : undefined,
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
