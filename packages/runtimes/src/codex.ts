import { execFile } from "node:child_process";
import type {
  AgentRuntimeAdapter,
  HarnessAuthStatus,
  ProviderCompatibility,
  RuntimeCapability,
  RuntimeContext,
  RuntimeResult,
  RunEvent,
  Usage,
} from "@agentfabric/core";
import { runHarnessCommand } from "./harness.js";

/**
 * Codex Local harness adapter (v6).
 *
 * Runs the user's own `codex` CLI as a local AgentFabric harness:
 *
 * - **Harness-native authentication** (v6 §2): Codex's ChatGPT login and
 *   subscription are used through Codex itself. AgentFabric never reads,
 *   copies or stores Codex's access token, refresh token or auth files —
 *   it only probes `codex --version` / `codex login status`.
 * - **No AgentFabric Provider/Model binding** (v6 §3): Codex uses its
 *   own account and default model configuration; a model override would
 *   be Codex-harness config, never the AgentFabric Provider → Model
 *   chain.
 * - **Local execution only** (v6 §13): the whole point is reusing the
 *   logged-in CLI on this machine; containerized runs are refused.
 *
 * Protocol verified against codex-cli 0.153.x (`codex exec --json`,
 * one JSON object per stdout line):
 *
 * - {"type":"thread.started","thread_id":"<uuid>"} — first line of every
 *   run; the thread id is the native session reference (resumed with
 *   `codex exec resume <id>`).
 * - {"type":"turn.started"}
 * - {"type":"item.started"|"item.updated"|"item.completed","item":{…}}
 *   with item.type ∈ agent_message | reasoning | command_execution |
 *   file_change | mcp_tool_call | web_search | todo_list | error.
 * - {"type":"turn.completed","usage":{input_tokens,
 *   cached_input_tokens, cache_write_input_tokens, output_tokens,
 *   reasoning_output_tokens}} — authoritative per-turn usage.
 * - {"type":"turn.failed","error":{"message":"…"}} and
 *   {"type":"error","message":"…"} — failures; usage-limit exhaustion
 *   arrives here (v6 §10).
 */

/** Local binary; overridable for tests and non-default installs. */
export function codexBin(): string {
  return process.env.AGENTFABRIC_CODEX_BIN ?? "codex";
}

/**
 * Codex harness capabilities (v6 §4/§5): native Codex threads with
 * resume, streamed exec events, workspace-aware. Handoff summaries stay
 * AgentFabric-assisted (Codex does not provide them through exec).
 */
export const codexCapabilities: Partial<RuntimeCapability> = {
  supportsNativeSession: true,
  supportsNativeResume: true,
  supportsStreamingEvents: true,
  supportsHandoffGeneration: false,
  supportsWorkspace: true,
  supportsInteractiveExecution: false,
};

export const CODEX_LOCAL_ONLY_HINT =
  "Codex Local runs on your machine on purpose — it reuses the Codex CLI's own ChatGPT login and subscription, " +
  "which cannot be carried into a container. Containerized Codex is out of scope for this phase (v6 §13).";

/* ------------------------------------------------------------------ */
/* Event mapping (v6 §5)                                               */
/* ------------------------------------------------------------------ */

interface CodexExecEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string } | string;
  usage?: CodexTurnUsage;
  item?: CodexExecItem;
  [key: string]: unknown;
}

interface CodexExecItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

/** codex turn.completed usage object. */
interface CodexTurnUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  [key: string]: unknown;
}

function errorText(err: CodexExecEvent["error"]): string | undefined {
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  return undefined;
}

/**
 * Maps a codex exec JSONL line to AgentFabric standard events.
 *
 * item.* phases map onto the unified event set (v6 §5): agent_message →
 * agent.message, reasoning → agent.thinking, command_execution →
 * shell.command/shell.output, file_change → file.created/modified,
 * mcp_tool_call → tool.started/completed, web_search → tool.completed.
 */
export function mapCodexEvent(raw: string, runId: string, seq: () => number): RunEvent | RunEvent[] | null {
  let evt: CodexExecEvent;
  try {
    evt = JSON.parse(raw) as CodexExecEvent;
  } catch {
    return null;
  }
  const type = evt.type ?? "unknown";
  const base = () => {
    const n = seq();
    return { id: `evt_${runId}_${n}`, runId, seq: n, timestamp: new Date().toISOString() };
  };

  switch (type) {
    case "thread.started":
      return {
        ...base(),
        type: "run.progress",
        level: "info",
        source: "codex",
        data: { phase: "thread", threadId: evt.thread_id },
      };

    case "turn.started":
      return { ...base(), type: "run.progress", level: "debug", source: "codex", data: { phase: "turn_start" } };

    case "turn.completed":
      // Usage is parsed separately (parseCodexUsage) into the accumulator.
      return { ...base(), type: "run.progress", level: "debug", source: "codex", data: { phase: "turn_end" } };

    case "turn.failed": {
      const message = errorText(evt.error) ?? raw;
      return {
        ...base(),
        type: "runtime.error",
        level: "error",
        source: "codex",
        data: { error: message, phase: "turn_failed", usageLimit: detectCodexUsageLimit(message) },
      };
    }

    case "error": {
      const message = typeof evt.message === "string" ? evt.message : raw;
      // Codex emits transient stream notes ("Reconnecting… 1/5") on the
      // same event; those are retries, not failures.
      if (/reconnect/i.test(message)) {
        return { ...base(), type: "log", level: "debug", source: "codex", data: { line: message } };
      }
      return {
        ...base(),
        type: "runtime.error",
        level: "error",
        source: "codex",
        data: { error: message, usageLimit: detectCodexUsageLimit(message) },
      };
    }

    case "item.started":
    case "item.updated":
    case "item.completed":
      return mapCodexItem(evt, type, base);

    default:
      // Unknown-but-JSON lines stay visible as raw debug events.
      return { ...base(), type: "log", level: "debug", source: "codex", data: { line: raw } };
  }
}

function mapCodexItem(
  evt: CodexExecEvent,
  phase: "item.started" | "item.updated" | "item.completed",
  base: () => { id: string; runId: string; seq: number; timestamp: string }
): RunEvent | RunEvent[] | null {
  const item = evt.item;
  if (!item) return null;
  const kind = item.type ?? "";
  const completed = phase === "item.completed";
  const data = (extra: Record<string, unknown>) => ({ ...extra, itemPhase: phase });

  switch (kind) {
    case "agent_message":
      if (!completed || typeof item.text !== "string" || !item.text) return null;
      return {
        ...base(),
        type: "agent.message",
        level: "info",
        source: "codex",
        data: data({ content: item.text, role: "assistant" }),
      };

    case "reasoning":
      if (!completed || typeof item.text !== "string" || !item.text) return null;
      return {
        ...base(),
        type: "agent.thinking",
        level: "debug",
        source: "codex",
        data: data({ content: item.text }),
      };

    case "command_execution": {
      if (completed) {
        return {
          ...base(),
          type: "shell.output",
          level: item.status === "failed" ? "warn" : "info",
          source: "codex",
          data: data({
            output: typeof item.aggregated_output === "string" ? item.aggregated_output : "",
            exitCode: item.exit_code ?? null,
            status: item.status,
          }),
        };
      }
      return {
        ...base(),
        type: "shell.command",
        level: "info",
        source: "codex",
        data: data({ command: item.command, backend: "local", source: "codex" }),
      };
    }

    case "file_change": {
      if (!completed) return null;
      // One event per changed path; codex emits file_change only at
      // completion.
      const changes = (item.changes ?? []).filter((c): c is { path: string; kind?: string } => typeof c.path === "string" && Boolean(c.path));
      if (changes.length === 0) return null;
      return changes.map((change) => ({
        ...base(),
        type: (change.kind === "add" ? "file.created" : "file.modified") as "file.created" | "file.modified",
        level: "info" as const,
        source: "codex",
        data: data({ path: change.path, changeKind: change.kind ?? "update", status: item.status }),
      }));
    }

    case "mcp_tool_call": {
      const tool = item.server && item.tool ? `${item.server}/${item.tool}` : (item.tool ?? "mcp_tool");
      if (completed) {
        const errText = errorText(item.error as CodexExecEvent["error"]);
        return {
          ...base(),
          type: "tool.completed",
          level: errText || item.status === "failed" ? "warn" : "info",
          source: "codex",
          data: data({ tool, toolCallId: item.id, result: item.result ?? item.error ?? null, isError: Boolean(errText) || item.status === "failed" }),
        };
      }
      return {
        ...base(),
        type: "tool.started",
        level: "info",
        source: "codex",
        data: data({ tool, toolCallId: item.id, args: item.arguments }),
      };
    }

    case "web_search":
      // codex reports searches only at completion.
      if (!completed) return null;
      return {
        ...base(),
        type: "tool.completed",
        level: "info",
        source: "codex",
        data: data({
          tool: "web_search",
          toolCallId: item.id,
          args: typeof item.query === "string" ? { query: item.query } : undefined,
          result: item.result,
        }),
      };

    case "todo_list": {
      const todos = Array.isArray(item.items) ? item.items : undefined;
      if (!todos) return null;
      return {
        ...base(),
        type: "run.progress",
        level: "debug",
        source: "codex",
        data: data({ phase: "todo", todos }),
      };
    }

    case "error": {
      if (!completed) return null;
      const message = typeof item.message === "string" ? item.message : JSON.stringify(item);
      return {
        ...base(),
        type: "runtime.error",
        level: "warn",
        source: "codex",
        data: data({ error: message, nonFatal: true }),
      };
    }

    default:
      return { ...base(), type: "log", level: "debug", source: "codex", data: { line: JSON.stringify(item) } };
  }
}

/**
 * Extracts the Codex thread id from a `thread.started` line — the opaque
 * native session reference (v6 §4): runtimeKind = codex,
 * nativeSessionRef = thread id, resume via `codex exec resume <id>`.
 */
export function extractCodexSessionRef(raw: string): string | undefined {
  try {
    const evt = JSON.parse(raw) as CodexExecEvent;
    if (evt.type === "thread.started" && typeof evt.thread_id === "string" && evt.thread_id) return evt.thread_id;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the authoritative per-turn usage from `turn.completed` (v6 §5).
 * Codex reports no per-token cost — the ChatGPT subscription is not
 * metered per request — so `estimatedCost` stays undefined and cost is
 * shown as 0 rather than fabricated.
 */
export function parseCodexUsage(raw: string): Usage | undefined {
  let evt: CodexExecEvent;
  try {
    evt = JSON.parse(raw) as CodexExecEvent;
  } catch {
    return undefined;
  }
  if (evt.type !== "turn.completed") return undefined;
  const u = evt.usage;
  if (!u) return undefined;
  const usage: Usage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cachedTokens: (u.cached_input_tokens ?? 0) + (u.cache_write_input_tokens ?? 0),
    reasoningTokens: u.reasoning_output_tokens ?? 0,
    modelRequests: 1,
  };
  return usage;
}

/* ------------------------------------------------------------------ */
/* Usage-limit detection (v6 §10)                                      */
/* ------------------------------------------------------------------ */

const CODEX_USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit reached/i,
  /(?:hit|reached|exceeded|met)\s+(?:your\s+|the\s+)?(?:usage|plan|rate)\s+(?:limit|cap)/i,
  /usage\s+cap\b/i,
  /insufficient_quota/i,
  /quota exceeded/i,
  /limit\s+resets\s+(?:at|in)/i,
];

/**
 * Recognizes Codex subscription-quota exhaustion in an error message
 * (v6 §10). Canonical CLI strings include "You've hit your usage limit.
 * Try again in X hours Y minutes." and "usage limit reached" — matched
 * case-insensitively, plus the API-side quota signatures.
 */
export function detectCodexUsageLimit(message: string | undefined): boolean {
  if (!message) return false;
  return CODEX_USAGE_LIMIT_PATTERNS.some((re) => re.test(message));
}

/* ------------------------------------------------------------------ */
/* Harness-native auth (v6 §2/§12)                                     */
/* ------------------------------------------------------------------ */

function capture(bin: string, args: string[], timeoutMs = 15_000): Promise<{ code: number | null; out: string; failed?: Error }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
        out: `${stdout ?? ""}${stderr ?? ""}`.trim(),
        failed: err && !stdout ? err : undefined,
      });
    });
  });
}

/**
 * Detects Codex CLI availability and login state using Codex's own
 * surfaces (v6 §2): `codex --version` and `codex login status`. No token
 * material, auth file or `~/.codex` content is ever read — Codex owns
 * its identity end to end (v6 §12).
 */
export async function codexAuthStatus(bin = codexBin()): Promise<HarnessAuthStatus> {
  const version = await capture(bin, ["--version"], 10_000);
  if (version.failed || version.code !== 0 || !/codex/i.test(version.out)) {
    return {
      installed: false,
      loggedIn: false,
      ok: false,
      detail: version.failed ? String(version.failed.message ?? version.failed) : undefined,
      hint: "Install the Codex CLI (https://developers.openai.com/codex/) and make sure `codex` is on PATH.",
    };
  }
  const versionText = version.out.split("\n")[0]?.trim();
  const login = await capture(bin, ["login", "status"], 15_000);
  const out = login.out.toLowerCase();
  const loggedIn = login.code === 0 && /logged in/.test(out) && !/not logged in/.test(out);
  return {
    installed: true,
    loggedIn,
    ok: loggedIn,
    version: versionText,
    detail: loggedIn ? login.out.split("\n")[0]?.trim() : login.out.split("\n")[0]?.trim() || `exit ${login.code}`,
    hint: loggedIn
      ? undefined
      : "Run `codex login` in a terminal to sign in with ChatGPT, then retry — AgentFabric never handles Codex credentials itself.",
  };
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

/** Codex consumes no AgentFabric provider configuration (v6 §3). */
export const codexProviderCompatibility: ProviderCompatibility = {
  customProvider: false,
  baseUrl: false,
  customHeaders: false,
  supportedModelParameters: [],
};

/**
 * Builds the codex exec CLI args for a run.
 *
 * Model selection is deliberately absent (v6 §3): Codex uses its own
 * account default. Resume passes the thread id to `codex exec resume`.
 */
function buildArgs(ctx: RuntimeContext): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check"];
  // Sandbox: policy shell-deny narrows Codex to read-only; otherwise the
  // workspace-write default (codex's non-interactive default is read-only,
  // which cannot do real task work). Explicit override via runtime.config.
  const configSandbox = ctx.runtime.config?.sandbox;
  const sandbox =
    typeof configSandbox === "string" && ["read-only", "workspace-write", "danger-full-access"].includes(configSandbox)
      ? configSandbox
      : ctx.policy?.shell === "deny"
        ? "read-only"
        : "workspace-write";
  args.push("--sandbox", sandbox);
  // Native resume: continue the harness's own thread (v6 §4/§5).
  if (ctx.runtimeSession?.nativeSessionRef) {
    args.push("resume", ctx.runtimeSession.nativeSessionRef);
  }
  return args;
}

/**
 * Codex Local runtime adapter (v6 §1). Local execution only (§13);
 * harness-native ChatGPT auth (§2); no AgentFabric model binding (§3).
 */
export const codexAdapter: AgentRuntimeAdapter = {
  kind: "codex",
  name: "Codex (ChatGPT)",
  capabilities: codexCapabilities,
  credentialSource: "harness-native",
  // No providerCompatibility on purpose: Codex runs on its own account;
  // declaring an empty one would silence the orchestrator's warning while
  // claiming structure it does not have.

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    if (ctx.runtime.containerized) {
      await ctx.emit("runtime.error", { error: CODEX_LOCAL_ONLY_HINT, backend: "docker", source: "codex" }, { level: "error" });
      return { error: `Containerized Codex refused to start: ${CODEX_LOCAL_ONLY_HINT}` };
    }
    // Fail fast with an actionable message when the harness's own login is
    // missing (v6 §2) — better than a confusing harness-internal error.
    const auth = await codexAuthStatus();
    if (!auth.installed || !auth.loggedIn) {
      const message = auth.hint ?? "Codex CLI is not available";
      await ctx.emit("runtime.error", { error: message, source: "codex", installed: auth.installed, loggedIn: auth.loggedIn }, { level: "error" });
      return { error: message };
    }

    const basePrompt = ctx.run.inputInstruction ?? ctx.task.prompt;
    // Agent-profile system instructions have no native Codex flag; deliver
    // them as a leading block instead of silently dropping them.
    const prompt = ctx.systemInstructions?.trim()
      ? `${ctx.systemInstructions.trim()}\n\n---\n\n${basePrompt}`
      : basePrompt;

    return runHarnessCommand(ctx, {
      bin: codexBin(),
      args: buildArgs(ctx),
      prompt,
      source: "codex",
      mapLine: mapCodexEvent,
      extractSessionRef: extractCodexSessionRef,
      parseUsage: parseCodexUsage,
      describeFailure: ({ lastError }) => {
        if (!lastError) return undefined;
        // Keep the harness's own message (the generic "exited with code"
        // would hide it) and classify quota exhaustion (v6 §10).
        if (detectCodexUsageLimit(lastError)) {
          return { error: lastError, errorKind: "usage-limit" as const };
        }
        return { error: lastError };
      },
    });
  },

  async cancel(ctx) {
    await ctx.log("Codex run cancelled", "warn");
  },

  async checkAuth() {
    return codexAuthStatus();
  },

  describe() {
    return {
      needsDocker: false,
      needsModel: false,
      cli: codexBin(),
      credentialSource: "harness-native",
      executionBackend: "local",
    };
  },
};
