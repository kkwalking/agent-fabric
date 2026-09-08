import { execFile } from "node:child_process";
import type {
  AgentRuntimeAdapter,
  HarnessAuthStatus,
  RuntimeCapability,
  RuntimeContext,
  RuntimeResult,
  RunEvent,
  Usage,
} from "@agentfabric/core";
import { runHarnessCommand } from "./harness.js";

/**
 * Claude Code Local harness adapter (v7).
 *
 * Runs the user's own `claude` CLI as a local AgentFabric harness:
 *
 * - **Harness-native authentication** (v7 §2): Claude Code's Claude.ai
 *   login and subscription are used through Claude Code itself.
 *   AgentFabric never reads, copies or stores Claude Code's credentials
 *   (`~/.claude/.credentials.json`, keychain entries, OAuth tokens) — it
 *   only probes `claude --version` / `claude auth status` for
 *   availability, and never converts the subscription into an Anthropic
 *   Provider (v7 §21).
 * - **No AgentFabric Provider/Model binding** (v7 §3): Claude Code uses
 *   its own account, subscription and model configuration.
 * - **Local execution only** (v7 §18): the whole point is reusing the
 *   logged-in CLI on this machine; containerized runs are refused.
 *
 * Protocol verified against claude-cli 2.1.x (`claude -p <prompt>
 * --output-format stream-json --verbose`, one JSON object per stdout
 * line):
 *
 * - {"type":"system","subtype":"init","session_id":"<uuid>","model":…}
 *   — first meaningful line; session_id is the native session reference
 *   (resumed with `claude --resume <id> -p …`).
 * - {"type":"system","subtype":"hook_started"|"hook_response",…} —
 *   session hook noise; skipped.
 * - {"type":"assistant","message":{role, model, content[…], usage}} —
 *   one per model response; content blocks are text | thinking |
 *   tool_use ({id, name, input}).
 * - {"type":"user","message":{content:[{type:"tool_result",
 *   tool_use_id, content, is_error}]}} — tool results ride user-role
 *   messages.
 * - {"type":"result","subtype":"success"|"error_max_turns"|
 *   "error_during_execution","is_error":bool,"result":"…","usage":{…},
 *   "total_cost_usd":n,"duration_ms":n,"num_turns":n} — the final line;
 *   authoritative usage. Subscription-quota exhaustion surfaces here or
 *   as an early CLI error (v7 §14).
 */

/** Local binary; overridable for tests and non-default installs. */
export function claudeCodeBin(): string {
  return process.env.AGENTFABRIC_CLAUDE_BIN ?? "claude";
}

/**
 * Claude Code harness capabilities (v7 §17): native Claude sessions with
 * resume, streamed exec events, workspace-aware. Handoff summaries stay
 * AgentFabric-assisted (the result event carries no structured handoff).
 */
export const claudeCodeCapabilities: Partial<RuntimeCapability> = {
  supportsNativeSession: true,
  supportsNativeResume: true,
  supportsStreamingEvents: true,
  supportsHandoffGeneration: false,
  supportsWorkspace: true,
  supportsInteractiveExecution: false,
};

export const CLAUDE_CODE_LOCAL_ONLY_HINT =
  "Claude Code Local runs on your machine on purpose — it reuses the Claude Code CLI's own Claude.ai login and subscription, " +
  "which cannot be carried into a container. Containerized Claude Code is out of scope for this phase (v7 §18).";

/* ------------------------------------------------------------------ */
/* Event mapping (v7 §7)                                               */
/* ------------------------------------------------------------------ */

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: ClaudeResultUsage;
  message?: ClaudeMessage;
  [key: string]: unknown;
}

interface ClaudeMessage {
  role?: string;
  model?: string;
  content?: string | ClaudeContentBlock[];
  [key: string]: unknown;
}

type ClaudeContentBlock =
  | { type: "text"; text?: string; [key: string]: unknown }
  | { type: "thinking"; thinking?: string; [key: string]: unknown }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown; [key: string]: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

/** result-event usage object (Anthropic shape). */
interface ClaudeResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  [key: string]: unknown;
}

const FILE_WRITING_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const FILE_CREATING_TOOLS = new Set(["Write"]);

/**
 * Per-run mapper state: Claude reports tool calls and their results as
 * separate events correlated only by `tool_use_id`, so the mapper needs
 * the pending calls to give tool.completed / shell.output their tool
 * identity (the projector merges by toolCallId).
 */
export interface ClaudeEventMapperState {
  pendingTools: Map<string, { name: string; input: Record<string, unknown> }>;
}

export function newClaudeEventMapperState(): ClaudeEventMapperState {
  return { pendingTools: new Map() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Normalizes a tool_result content field (string | block array | …) to text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const rec = asRecord(block);
        return typeof rec.text === "string" ? rec.text : "";
      })
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/**
 * Maps one claude stream-json line to AgentFabric standard events (v7
 * §7): assistant text → agent.message, thinking → agent.thinking, Bash
 * tool_use → shell.command/shell.output, Edit/Write → file.modified /
 * file.created, other tools → tool.started/completed, error results →
 * runtime.error.
 */
export function mapClaudeEvent(
  raw: string,
  runId: string,
  seq: () => number,
  state: ClaudeEventMapperState = newClaudeEventMapperState()
): RunEvent | RunEvent[] | null {
  let evt: ClaudeStreamEvent;
  try {
    evt = JSON.parse(raw) as ClaudeStreamEvent;
  } catch {
    return null;
  }
  const type = evt.type ?? "unknown";
  const base = () => {
    const n = seq();
    return { id: `evt_${runId}_${n}`, runId, seq: n, timestamp: new Date().toISOString() };
  };

  switch (type) {
    case "system": {
      if (evt.subtype === "init") {
        return {
          ...base(),
          type: "run.progress",
          level: "debug",
          source: "claude-code",
          data: { phase: "session", sessionId: evt.session_id, model: evt.model, cwd: evt.cwd },
        };
      }
      // hook_started / hook_response carry session-hook plumbing (and can
      // be huge); they are not agent activity.
      return null;
    }

    case "assistant": {
      const message = evt.message;
      if (!message || message.role !== "assistant") return null;
      const model = typeof message.model === "string" ? message.model : undefined;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const out: RunEvent[] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          const text = typeof block.text === "string" ? block.text.trim() : "";
          if (text) {
            out.push({ ...base(), type: "agent.message", level: "info", source: "claude-code", data: { content: text, role: "assistant", model } });
          }
        } else if (block.type === "thinking") {
          const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
          if (text) {
            out.push({ ...base(), type: "agent.thinking", level: "debug", source: "claude-code", data: { content: text } });
          }
        } else if (block.type === "tool_use") {
          const id = typeof block.id === "string" ? block.id : undefined;
          const name = typeof block.name === "string" ? block.name : "tool";
          const input = asRecord(block.input);
          if (id) state.pendingTools.set(id, { name, input });
          if (name === "Bash") {
            out.push({
              ...base(),
              type: "shell.command",
              level: "info",
              source: "claude-code",
              data: { command: String(input.command ?? "(bash)"), backend: "local", source: "claude-code", toolCallId: id },
            });
          } else if (FILE_WRITING_TOOLS.has(name) || FILE_CREATING_TOOLS.has(name)) {
            // File activity is emitted when the result lands (success
            // known); record the intent here.
            out.push({
              ...base(),
              type: "tool.started",
              level: "debug",
              source: "claude-code",
              data: { tool: name, toolCallId: id, args: input },
            });
          } else {
            out.push({
              ...base(),
              type: "tool.started",
              level: "info",
              source: "claude-code",
              data: { tool: name, toolCallId: id, args: input },
            });
          }
        }
      }
      return out.length ? out : null;
    }

    case "user": {
      // Tool results ride user-role messages; a plain string content is
      // the echoed input (stream-json input mode) — not user activity.
      const message = evt.message;
      if (!message || !Array.isArray(message.content)) return null;
      const out: RunEvent[] = [];
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const pending = id ? state.pendingTools.get(id) : undefined;
        const name = pending?.name ?? "tool";
        const input = pending?.input ?? {};
        const text = resultText(block.content);
        const isError = Boolean(block.is_error);
        if (pending && id) state.pendingTools.delete(id);
        if (name === "Bash") {
          out.push({
            ...base(),
            type: "shell.output",
            level: isError ? "warn" : "info",
            source: "claude-code",
            data: { output: text, exitCode: null, status: isError ? "failed" : "completed", toolCallId: id },
          });
        } else if (FILE_WRITING_TOOLS.has(name) || FILE_CREATING_TOOLS.has(name)) {
          if (!isError) {
            out.push({
              ...base(),
              type: FILE_CREATING_TOOLS.has(name) ? ("file.created" as const) : ("file.modified" as const),
              level: "info",
              source: "claude-code",
              data: { path: String(input.file_path ?? input.path ?? "(file)"), changeKind: FILE_CREATING_TOOLS.has(name) ? "add" : "update" },
            });
          }
          out.push({
            ...base(),
            type: "tool.completed",
            level: isError ? "warn" : "info",
            source: "claude-code",
            data: { tool: name, toolCallId: id, result: text || undefined, isError },
          });
        } else {
          out.push({
            ...base(),
            type: "tool.completed",
            level: isError ? "warn" : "info",
            source: "claude-code",
            data: { tool: name, toolCallId: id, result: text || undefined, isError },
          });
        }
      }
      return out.length ? out : null;
    }

    case "result": {
      if (evt.is_error || (evt.subtype && evt.subtype !== "success")) {
        const message = typeof evt.result === "string" && evt.result ? evt.result : `claude result: ${evt.subtype ?? "error"}`;
        return {
          ...base(),
          type: "runtime.error",
          level: "error",
          source: "claude-code",
          data: { error: message, phase: evt.subtype, usageLimit: detectClaudeUsageLimit(message) },
        };
      }
      return {
        ...base(),
        type: "run.progress",
        level: "debug",
        source: "claude-code",
        data: { phase: "result", turns: evt.num_turns, durationMs: evt.duration_ms },
      };
    }

    default:
      // Unknown-but-JSON lines stay visible as raw debug events.
      return { ...base(), type: "log", level: "debug", source: "claude-code", data: { line: raw } };
  }
}

/**
 * Extracts the Claude Code session id from a stream line — the opaque
 * native session reference (v7 §5): runtimeKind = claude-code,
 * nativeSessionRef = session id, resume via `claude --resume <id>`.
 */
export function extractClaudeSessionRef(raw: string): string | undefined {
  try {
    const evt = JSON.parse(raw) as ClaudeStreamEvent;
    // Prefer the init line (the authoritative session opener); any early
    // event carrying session_id identifies the same session.
    if (typeof evt.session_id === "string" && evt.session_id) return evt.session_id;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the authoritative per-run usage from the final `result` event
 * (v7 §8). `total_cost_usd` is Claude Code's own accounting and is
 * passed through verbatim; AgentFabric never estimates subscription cost
 * against Anthropic API pricing — with no harness-reported number the
 * cost stays 0.
 */
export function parseClaudeUsage(raw: string): Usage | undefined {
  let evt: ClaudeStreamEvent;
  try {
    evt = JSON.parse(raw) as ClaudeStreamEvent;
  } catch {
    return undefined;
  }
  if (evt.type !== "result") return undefined;
  const u = evt.usage;
  const usage: Usage = {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cachedTokens: (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
    reasoningTokens: u?.output_tokens_details?.thinking_tokens ?? 0,
    modelRequests: 1,
    ...(typeof evt.duration_ms === "number" ? { durationMs: evt.duration_ms } : {}),
    ...(typeof evt.total_cost_usd === "number" ? { estimatedCost: evt.total_cost_usd } : {}),
  };
  return usage;
}

/* ------------------------------------------------------------------ */
/* Usage-limit detection (v7 §14)                                      */
/* ------------------------------------------------------------------ */

const CLAUDE_USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage_limit_reached/i,
  /usage limit reached/i,
  /(?:hit|reached|exceeded|met)\s+(?:your\s+|the\s+)?(?:weekly\s+|daily\s+|session\s+|5[-\s]?hour\s+)?(?:usage|plan|rate)\s*(?:limit|cap)/i,
  /(?:usage|plan|rate)\s*(?:limit|cap)\s+(?:reached|exceeded|hit)/i,
  /limit\s+resets\s+(?:at|on|in)/i,
  /you'?ve (?:hit|reached) your/i,
];

/**
 * Recognizes Claude.ai subscription-quota exhaustion in an error message
 * (v7 §14). Canonical CLI strings include "You've hit your usage limit"
 * and "usage limit reached" (plus the API-side `usage_limit_reached`
 * error type) — matched case-insensitively. This is a switch-harness
 * scenario, not a plain run failure.
 */
export function detectClaudeUsageLimit(message: string | undefined): boolean {
  if (!message) return false;
  return CLAUDE_USAGE_LIMIT_PATTERNS.some((re) => re.test(message));
}

/* ------------------------------------------------------------------ */
/* Harness-native auth (v7 §2/§16)                                     */
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

interface ClaudeAuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
}

/**
 * Detects Claude Code CLI availability and login state using Claude
 * Code's own surfaces (v7 §2): `claude --version` and
 * `claude auth status`. No token material, credentials file or keychain
 * entry is ever read — Claude Code owns its identity end to end (v7 §21).
 */
export async function claudeCodeAuthStatus(bin = claudeCodeBin()): Promise<HarnessAuthStatus> {
  const version = await capture(bin, ["--version"], 10_000);
  if (version.failed || version.code !== 0 || !/claude/i.test(version.out)) {
    return {
      installed: false,
      loggedIn: false,
      ok: false,
      detail: version.failed ? String(version.failed.message ?? version.failed) : undefined,
      hint: "Install the Claude Code CLI (https://claude.com/claude-code) and make sure `claude` is on PATH.",
    };
  }
  const versionText = version.out.split("\n")[0]?.trim();
  const login = await capture(bin, ["auth", "status"], 15_000);

  // `claude auth status` prints a JSON availability report — detection
  // only, never credentials.
  let parsed: ClaudeAuthStatusJson | undefined;
  try {
    parsed = JSON.parse(login.out) as ClaudeAuthStatusJson;
  } catch {
    parsed = undefined;
  }
  const loggedIn = parsed
    ? parsed.loggedIn === true
    : login.code === 0 && /logged in/i.test(login.out) && !/not logged in/i.test(login.out);

  const method = parsed?.authMethod === "oauth_token" ? "Claude.ai" : parsed?.authMethod;
  const detail = loggedIn
    ? [
        method ? `Logged in with ${method}` : "Logged in",
        parsed?.apiProvider ? ` (${parsed.apiProvider})` : "",
      ].join("")
    : login.out.split("\n")[0]?.trim() || `exit ${login.code}`;

  return {
    installed: true,
    loggedIn,
    ok: loggedIn,
    version: versionText,
    detail,
    hint: loggedIn
      ? undefined
      : "Run `claude login` in a terminal to sign in with your Claude.ai account, then retry — AgentFabric never handles Claude Code credentials itself.",
  };
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

const CLAUDE_PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);

/**
 * Builds the claude CLI args for a run.
 *
 * Model selection is deliberately absent (v7 §3): Claude Code uses its
 * own account default. Resume passes the session id to `--resume`.
 * Non-interactive runs cannot answer permission prompts, so the default
 * permission mode lets tools act (the local-harness equivalent of Codex's
 * workspace-write sandbox); explicit deny rules from the execution policy
 * still apply in every mode, and runtime.config.permissionMode overrides.
 */
function buildArgs(ctx: RuntimeContext): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];

  const configMode = ctx.runtime.config?.permissionMode;
  const mode =
    typeof configMode === "string" && CLAUDE_PERMISSION_MODES.has(configMode)
      ? configMode
      : ctx.policy?.autoApprove === false
        ? "acceptEdits"
        : "bypassPermissions";
  args.push("--permission-mode", mode);

  // Policy narrowing (v4 §11/§13): deny rules survive every permission
  // mode; an explicit tool allowlist is honored when configured.
  if (ctx.policy?.shell === "deny") {
    args.push("--disallowedTools", "Bash");
  }
  const allowed = ctx.policy?.toolPermissions;
  if (Array.isArray(allowed) && allowed.length > 0) {
    args.push("--allowedTools", allowed.join(","));
  }

  // Native resume: continue the harness's own session (v7 §6).
  if (ctx.runtimeSession?.nativeSessionRef) {
    args.push("--resume", ctx.runtimeSession.nativeSessionRef);
  }
  return args;
}

/**
 * Claude Code Local runtime adapter (v7 §1). Local execution only (§18);
 * harness-native Claude.ai auth (§2); no AgentFabric model binding (§3).
 */
export const claudeCodeAdapter: AgentRuntimeAdapter = {
  kind: "claude-code",
  name: "Claude Code (Claude.ai)",
  capabilities: claudeCodeCapabilities,
  credentialSource: "harness-native",
  // No providerCompatibility on purpose: Claude Code runs on its own
  // account; declaring an empty one would silence the orchestrator's
  // warning while claiming structure it does not have.

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    if (ctx.runtime.containerized) {
      await ctx.emit("runtime.error", { error: CLAUDE_CODE_LOCAL_ONLY_HINT, backend: "docker", source: "claude-code" }, { level: "error" });
      return { error: `Containerized Claude Code refused to start: ${CLAUDE_CODE_LOCAL_ONLY_HINT}` };
    }
    // Fail fast with an actionable message when the harness's own login is
    // missing (v7 §2) — better than a confusing harness-internal error.
    const auth = await claudeCodeAuthStatus();
    if (!auth.installed || !auth.loggedIn) {
      const message = auth.hint ?? "Claude Code CLI is not available";
      await ctx.emit("runtime.error", { error: message, source: "claude-code", installed: auth.installed, loggedIn: auth.loggedIn }, { level: "error" });
      return { error: message };
    }

    const args = buildArgs(ctx);
    // Agent-profile system instructions ride Claude Code's own append
    // flag (v4 §10) instead of being prefixed into the prompt.
    if (ctx.systemInstructions?.trim()) {
      args.push("--append-system-prompt", ctx.systemInstructions.trim());
    }

    const mapperState = newClaudeEventMapperState();
    return runHarnessCommand(ctx, {
      bin: claudeCodeBin(),
      args,
      prompt: ctx.run.inputInstruction ?? ctx.task.prompt,
      source: "claude-code",
      mapLine: (raw, runId, seq) => mapClaudeEvent(raw, runId, seq, mapperState),
      extractSessionRef: extractClaudeSessionRef,
      parseUsage: parseClaudeUsage,
      runtimeVersion: auth.version,
      describeFailure: ({ lastError }) => {
        if (!lastError) return undefined;
        // Keep the harness's own message (the generic "exited with code"
        // would hide it) and classify quota exhaustion (v7 §14).
        if (detectClaudeUsageLimit(lastError)) {
          return { error: lastError, errorKind: "usage-limit" as const };
        }
        return { error: lastError };
      },
    });
  },

  async cancel(ctx) {
    await ctx.log("Claude Code run cancelled", "warn");
  },

  async checkAuth() {
    return claudeCodeAuthStatus();
  },

  describe() {
    return {
      needsDocker: false,
      needsModel: false,
      cli: claudeCodeBin(),
      credentialSource: "harness-native",
      executionBackend: "local",
    };
  },
};
