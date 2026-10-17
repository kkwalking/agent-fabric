/**
 * Harness hook wiring for board cards (v13 M3).
 *
 * The board needs to know when an interactive TUI finishes a turn so the card
 * can move to Review while the terminal stays open. Claude Code and OpenCode
 * expose hook surfaces; this module generates the per-session config and the
 * tiny commands/plugins that call back into AgentFabric.
 *
 * The callback carries a **per-session capability token**, not the global API
 * token: a harness (or anything it runs) can only move its own card, never call
 * the rest of the API. The endpoint lives outside `/api` because the global
 * token middleware owns that prefix; it validates the session token itself.
 *
 * Pi has no hook surface and DSH headless is one-shot (its clean exit already
 * moves the card). Those keep the explicit Mark for review fallback.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { KanbanAgentKind } from "@agentfabric/core";

export interface KanbanHookSetup {
  /** Extra argv appended to the agent launch (Claude `--settings`). */
  extraArgs: string[];
  /** Extra env (OpenCode `OPENCODE_CONFIG` plus the callback coordinates). */
  extraEnv: Record<string, string>;
  /** Directory holding the generated files; pruned when the session ends. */
  dir: string;
}

/** Shell-quote one argv word for a Claude hook command string. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A best-effort curl callback; a failed hook must never break the agent. */
export function buildHookCommand(options: {
  baseUrl: string;
  token: string;
  sessionId: string;
  event: string;
}): string {
  const body = JSON.stringify({ sessionId: options.sessionId, event: options.event });
  return [
    "curl",
    "-sS",
    "-m",
    "3",
    "-X",
    "POST",
    shellQuote(options.baseUrl),
    "-H",
    "'content-type: application/json'",
    "-H",
    shellQuote(`x-kanban-hook-token: ${options.token}`),
    "-d",
    shellQuote(body),
    ">/dev/null",
    "2>&1",
    "||",
    "true",
  ].join(" ");
}

function claudeSettings(baseUrl: string, token: string, sessionId: string): string {
  const command = (event: string) => buildHookCommand({ baseUrl, token, sessionId, event });
  return JSON.stringify(
    {
      hooks: {
        // Claude finished responding / is waiting for the user.
        Stop: [{ hooks: [{ type: "command", command: command("to_review") }] }],
        // A new user turn means the card is working again.
        UserPromptSubmit: [{ hooks: [{ type: "command", command: command("to_in_progress") }] }],
        // Permission prompts need a human; do not show the card as finished.
        Notification: [
          { matcher: "permission_prompt", hooks: [{ type: "command", command: command("needs_attention") }] },
        ],
      },
    },
    null,
    2
  );
}

/**
 * OpenCode v2 plugin. It reads the callback coordinates from the environment
 * (injected by the session runtime) and maps session lifecycle to the same two
 * intents Claude emits; no shell/curl dependency.
 */
const OPENCODE_PLUGIN = `export const KanbanPlugin = async () => {
  const url = process.env.AGENTFABRIC_KANBAN_HOOK_URL;
  const token = process.env.AGENTFABRIC_KANBAN_HOOK_TOKEN;
  const sessionId = process.env.AGENTFABRIC_KANBAN_SESSION_ID;
  if (!url || !token || !sessionId) return {};

  const notify = async (event) => {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-kanban-hook-token": token },
        body: JSON.stringify({ sessionId, event }),
      });
    } catch {
      // Best effort: a hook failure must never break OpenCode.
    }
  };

  return {
    event: async ({ event }) => {
      const type = event?.type;
      const status = event?.properties?.status?.type;
      if (type === "session.idle" || status === "idle") return notify("to_review");
      if (type === "session.busy" || status === "busy" || type === "session.error") {
        return notify("to_in_progress");
      }
    },
    "permission.ask": async (_permission, output) => {
      if (output?.status === "ask") await notify("needs_attention");
    },
  };
};
`;

export async function prepareKanbanHooks(options: {
  agentId: KanbanAgentKind;
  dataDir: string;
  sessionId: string;
  baseUrl: string;
  token: string;
}): Promise<KanbanHookSetup> {
  const dir = join(options.dataDir, "kanban", "provisioning", options.sessionId);
  const extraEnv: Record<string, string> = {
    AGENTFABRIC_KANBAN_SESSION_ID: options.sessionId,
    AGENTFABRIC_KANBAN_HOOK_URL: options.baseUrl,
    AGENTFABRIC_KANBAN_HOOK_TOKEN: options.token,
  };
  const extraArgs: string[] = [];

  if (options.agentId === "claude") {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const settingsPath = join(dir, "claude-settings.json");
    await writeFile(settingsPath, `${claudeSettings(options.baseUrl, options.token, options.sessionId)}\n`, {
      mode: 0o600,
    });
    extraArgs.push("--settings", settingsPath);
  } else if (options.agentId === "opencode") {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const pluginPath = join(dir, "kanban-plugin.mjs");
    const configPath = join(dir, "opencode.json");
    await writeFile(pluginPath, OPENCODE_PLUGIN, { mode: 0o600 });
    await writeFile(
      configPath,
      `${JSON.stringify({ plugin: [pathToFileURL(pluginPath).href] }, null, 2)}\n`,
      { mode: 0o600 }
    );
    extraEnv.OPENCODE_CONFIG = configPath;
  }

  return { extraArgs, extraEnv, dir };
}

export async function cleanupKanbanHooks(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Drops hook configs/tokens left behind by a crash or a fast shutdown. Called
 * once at boot, when no board session is live yet. Worktrees are NOT touched:
 * they may hold uncommitted user work.
 */
export async function pruneKanbanHooks(dataDir: string): Promise<void> {
  await rm(join(dataDir, "kanban", "provisioning"), { recursive: true, force: true }).catch(() => {});
}
