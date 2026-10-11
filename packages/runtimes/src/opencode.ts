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
import { fireAndForget } from "./fireAndForget.js";
import {
  buildOpenCodeConfig,
  OPENCODE_KNOWN_PROVIDER_IDS,
  providerSlug,
  splitModelParameters,
  writeOpenCodeConfig,
  type OpenCodePermissionRule,
} from "./provider-config.js";

/**
 * OpenCode harness adapter — protocol shapes verified against the
 * OpenCode 2 CLI (`opencode run --format json`, 2.x line):
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
 * v2 differences from v1 that this adapter depends on:
 * - `--variant` was removed; a variant rides the model selector as
 *   `-m <provider>/<model>#<variant>`.
 * - `run` starts a background service (`opencode serve --service`) and
 *   serves the run through it, caching the config it first read. Every
 *   run therefore passes `--standalone` so it owns its process — without
 *   it, the second run of a runtime keeps using the first run's rewritten
 *   `OPENCODE_CONFIG` and fails with "Model unavailable".
 * - the tool_use part carries its call id in `id` (v1 used `callID`).
 * - an error carries its kind in `error.type` (v1 used `error.name`).
 * - tools are named `shell` (not `bash`) and `subagent` (not `task`),
 *   with `edit` covering edit/write/patch.
 *
 * Sessions live under $XDG_DATA_HOME/opencode (~/.local/share/opencode)
 * and resume with `--session <ses_id>`; v2 keeps them in a SQLite
 * database there rather than per-session JSON files, which is opaque to
 * this adapter either way.
 */
interface OpenCodeEvent {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: OpenCodePart;
  error?: {
    name?: string;
    /** v2 error kind, e.g. "provider.no-route". */
    type?: string;
    message?: string;
    data?: { message?: string };
  };
  [key: string]: unknown;
}

interface OpenCodePart {
  type?: string;
  text?: string;
  tool?: string;
  /**
   * Tool call id. v1 emitted it as `callID`; v2 puts it in `id` and uses
   * `partID` for the part itself, so both spellings are read here.
   */
  callID?: string;
  id?: string;
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

/** Container image override for containerized opencode (v3 §10, plan A). */
export function opencodeImage(): string | undefined {
  return process.env.AGENTFABRIC_OPENCODE_IMAGE;
}

/**
 * Where the OpenCode Dockerfile reference lives. The official image
 * (`ghcr.io/anomalyco/opencode`) is a minimal Alpine build carrying only
 * ripgrep, so it fails the Harness Execution Contract's python3 + curl
 * requirement; `docker/opencode.Dockerfile` derives from it and adds
 * exactly those two tools.
 */
export const OPENCODE_IMAGE_CONTRACT_HINT =
  "Containerized OpenCode requires an OpenCode Runtime Image (a container whose entrypoint is the opencode CLI " +
  "with its state under /root/.local/share/opencode, plus python3 and curl for the agent's own commands). " +
  "Configure `image` on the runtime or set AGENTFABRIC_OPENCODE_IMAGE. " +
  "A reference Dockerfile is provided at docker/opencode.Dockerfile in the AgentFabric repository " +
  "( Harness Execution Contract: docs/harness-image-contract.md ).";

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
 * Containerized capabilities (v2 §11, v3 §16/§17): a runtime image whose
 * entrypoint is the `opencode` CLI plus the opaque native-state directory
 * ($XDG_DATA_HOME/opencode → /root/.local/share/opencode) mounted by the
 * execution backend make containerized runs capability-equivalent to local
 * ones — streaming stays structured and native sessions survive container
 * destruction. Without a configured image the effective-capability
 * computation narrows these to "cannot run" (v3 §10).
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
  // One seq() call: the id and the seq must agree (two calls gave the id a
  // number the seq never had).
  const n = seq();
  const base = {
    id: `evt_${runId}_${n}`,
    runId,
    seq: n,
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
          // v2 moved the call id from `callID` to `id`; without it the UI
          // cannot pair a tool result with its call.
          callID: part?.callID ?? part?.id,
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
        // v2 names the error kind `type` ("provider.no-route"); v1 used `name`.
        data: { error: message, name: err?.name ?? err?.type, sessionID: evt.sessionID },
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
 *
 * Known upstream defect (anomalyco/opencode#53207): the v2 CLI drops the
 * FINAL step_finish from stdout — its forwarding loop goes into
 * finalizing once `session.wait()` resolves and only lets
 * `session.execution.*` through (which carry no usage), so a text-only
 * run reports nothing and every run undercounts its last step. The
 * server-side event stream and the session DB still hold the data; only
 * the CLI's stdout loses it, and AgentFabric consumes stdout by design
 * (native state stays opaque). Do not "fix" this here — there is no
 * renamed event to parse; intermediate tool steps still arrive and are
 * what the real tests anchor their usage assertions to.
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

/**
 * opencode 2 permission actions a tool allowlist can grant or deny — the
 * canonical names, verified against the CLI's own resolved config
 * (`opencode debug config`). The v1 spellings (`bash`, `write`, `patch`,
 * `task`) are aliases v2 folds into `shell` / `edit` / `subagent`, so
 * listing them separately would emit several rules for one action and let
 * the last one silently win.
 */
const OPENCODE_TOOLS = [
  "apply_patch",
  "edit",
  "execute",
  "glob",
  "grep",
  "list",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "todowrite",
  "todoread",
  "webfetch",
  "websearch",
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
 * The model variant for this run — the provider-specific reasoning effort
 * (v4 §7). The runtime's configured `variant` is the base; a model-level
 * `reasoningEffort` overrides it. v2 has no `--variant` flag: the variant
 * rides the model selector as `<provider>/<model>#<variant>`.
 */
function resolveVariant(ctx: RuntimeContext): string | undefined {
  const reasoningEffort = ctx.model?.parameters?.reasoningEffort;
  if (typeof reasoningEffort === "string" && reasoningEffort) return reasoningEffort;
  const configured = ctx.runtime.config?.variant;
  return configured ? String(configured) : undefined;
}

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
  // `--standalone` must follow the `run` subcommand (v2 rejects it before).
  // It keeps each run in its own process: v2's `run` otherwise starts a
  // background service that caches the config it first read, so the next
  // run of the same runtime would silently keep the previous run's
  // OPENCODE_CONFIG (a rewritten provider/model never takes effect).
  const args = ["run", "--standalone", "--format", "json"];
  const variant = resolveVariant(ctx);
  const selector = variant ? `#${variant}` : "";
  if (ctx.provider && ctx.model) {
    args.push("-m", `${providerSlug(ctx.provider)}/${ctx.model.name}${selector}`);
  } else if (ctx.model) {
    args.push("-m", `${ctx.model.name}${selector}`);
  }
  if (useAgentfabricAgent) {
    args.push("--agent", "agentfabric");
  } else if (ctx.runtime.config?.agent) {
    args.push("--agent", String(ctx.runtime.config.agent));
  }
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
  fireAndForget(
    "opencode parameter warning",
    ctx.emit(
      "log",
      {
        line: `opencode ignores unsupported model parameters: ${keys.join(", ")} (supported: ${OPENCODE_SUPPORTED_MODEL_PARAMETERS.join(", ")})`,
        kind: "config-warning",
        scope: "model-parameters",
        unsupported: keys,
        supported: [...OPENCODE_SUPPORTED_MODEL_PARAMETERS],
      },
      { level: "warn", source: "opencode" }
    )
  );
}

/**
 * Generates the run's `opencode.json` (v4 §1/§3/§4/§10/§15/§16) and
 * wires `OPENCODE_CONFIG` to it:
 *
 * - provider entry from the AgentFabric provider (npm package per type,
 *   baseURL, `{env:…}` API key, custom headers);
 * - `permissions` rules from the resolved policy (shell → shell rule)
 *   followed by one rule per tool in the allowlist;
 * - an `agentfabric` agent carrying the profile's system instructions
 *   whenever they are configured.
 *
 * Local runs point at the host file directly; containerized runs mount
 * it read-only and point at the container path.
 */
async function prepareProviderConfig(ctx: RuntimeContext): Promise<boolean> {
  if (!ctx.provider) return false;
  const policy = ctx.policy;
  // Shell policy → opencode's native permission system (v4 §15/§16).
  // Headless `opencode run` cannot answer "ask" prompts — the harness
  // reports the request as unanswerable and the tool call fails.
  // opencode gates the shell tool's `workdir` parameter behind its
  // external_directory permission (built-in default "ask"), so a plain
  // allow policy must allow it too, or any workdir-using call is
  // rejected even when it points inside the workspace.
  const shell = policy?.shell ?? "allow";
  // Ordered rules: v2 matches last-wins, so the shell policy goes first
  // and the tool allowlist (which skips `shell`) refines it.
  const permissions: OpenCodePermissionRule[] = [
    { action: "shell", resource: "*", effect: shell === "deny" ? "deny" : shell === "ask" ? "ask" : "allow" },
  ];
  if (shell === "allow") {
    permissions.push({ action: "external_directory", resource: "*", effect: "allow" });
  }

  const toolAllow = policy?.toolPermissions;
  const unknownTools = (toolAllow ?? []).filter((t) => !(OPENCODE_TOOLS as readonly string[]).includes(t));
  // An allowlist denies everything it does not name: v2 defaults an
  // unmatched action to "ask", which a headless run cannot answer, so the
  // denial must be explicit to be honest about what happened.
  if (toolAllow?.length) {
    for (const tool of OPENCODE_TOOLS) {
      if (tool === "shell") continue; // the shell policy already decided this one
      permissions.push({ action: tool, resource: "*", effect: toolAllow.includes(tool) ? "allow" : "deny" });
    }
  }

  const needAgent = Boolean(ctx.systemInstructions?.trim());
  const agent = needAgent
    ? {
        prompt: ctx.systemInstructions,
        // No `#variant` here: v2 does not parse it in the agent's model
        // field, and the CLI `-m` selector wins over it anyway.
        ...(ctx.model ? { model: `${providerSlug(ctx.provider)}/${ctx.model.name}` } : {}),
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
        line: "opencode runs headless and cannot answer 'ask' permission prompts — shell tool calls will be rejected (set policy.shell to allow/deny, or policy.autoApprove)",
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
      permissions,
      agent,
      builtinPassthrough,
      containerized: Boolean(ctx.runtime.containerized),
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
      permissions,
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
 * survive container destruction (v2 §15). There is no default image: the
 * official one ships neither python3 nor curl, so a runtime names an
 * image built from docker/opencode.Dockerfile (v3 §10/§11/§12 — the
 * image is part of the Harness Execution Contract).
 */
export const opencodeAdapter: AgentRuntimeAdapter = {
  kind: "opencode",
  name: "OpenCode",
  capabilities: opencodeCapabilities,
  containerizedCapabilities: opencodeContainerizedCapabilities,
  nativeStateMountPath: "/root/.local/share/opencode",
  providerCompatibility: opencodeProviderCompatibility,
  // No defaultImage on purpose (v3 §10 plan A): the official image is a
  // minimal Alpine build without python3/curl, so it fails the contract.
  // A containerized runtime must name an image explicitly.

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    if (ctx.runtime.containerized) {
      const image = ctx.runtime.image ?? opencodeImage();
      if (!image) {
        await ctx.emit(
          "runtime.error",
          { error: OPENCODE_IMAGE_CONTRACT_HINT, backend: "docker", source: "opencode" },
          { level: "error" }
        );
        return { error: `Containerized OpenCode refused to start: ${OPENCODE_IMAGE_CONTRACT_HINT}` };
      }
    }
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
    return { needsDocker: false, needsModel: false, cli: opencodeBin(), requiresImageWhenContainerized: true };
  },
};
