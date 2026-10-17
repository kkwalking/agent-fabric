/**
 * Interactive CLI agent catalog for the board (v13 §4).
 *
 * This is deliberately separate from `@agentfabric/runtimes`: those adapters
 * run harnesses **headless** and parse structured events for a Run. The board
 * launches the same binaries as **interactive TUIs inside a PTY** and lets the
 * agent own its UI. Conflating the two would either break the TUI (structured
 * flags) or break Run events (no JSON).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DomainError } from "@agentfabric/core";
import type { KanbanAgentKind, KanbanCard, KanbanProject } from "@agentfabric/core";

const execFileAsync = promisify(execFile);

export interface KanbanPermissionMode {
  id: string;
  label: string;
  description: string;
  args: string[];
  env?: Record<string, string>;
  risky: boolean;
}

export interface KanbanAgentEntry {
  id: KanbanAgentKind;
  label: string;
  binary: string;
  /** Prompt delivery: a positional argv element or a flag + value. */
  prompt: { kind: "positional" } | { kind: "flag"; flag: string } | { kind: "afterDoubleDash" };
  permissionModes: KanbanPermissionMode[];
  defaultPermissionModeId: string;
  modelFlag: string | null;
  interactiveTui: boolean;
  installHint: string;
  /** Extra check besides the binary (e.g. DSH headless profile). */
  availability?: () => { available: boolean; hint?: string };
}

const PERMISSION_DEFAULT: KanbanPermissionMode = {
  id: "default",
  label: "Default",
  description: "Use the CLI's own permission behavior.",
  args: [],
  risky: false,
};

/** DSH has no interactive TUI: the board runs its headless runner and shows the JSONL. */
function dshHeadlessProfile(): { available: boolean; hint?: string } {
  const profile = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", "headless", "package.json");
  if (existsSync(profile)) return { available: true };
  return {
    available: false,
    hint: "Create the headless profile once: dsh plugin --profile headless add @deepseek-ai/dsh-headless",
  };
}

export const KANBAN_AGENTS: readonly KanbanAgentEntry[] = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    prompt: { kind: "positional" },
    defaultPermissionModeId: "default",
    modelFlag: "--model",
    interactiveTui: true,
    installHint: "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/quickstart",
    permissionModes: [
      PERMISSION_DEFAULT,
      { id: "plan", label: "Plan", description: "Investigate and propose changes without editing files.", args: ["--permission-mode", "plan"], risky: false },
      { id: "acceptEdits", label: "Accept edits", description: "Accept file edits automatically; other actions still prompt.", args: ["--permission-mode", "acceptEdits"], risky: false },
      {
        id: "auto",
        label: "Auto",
        description: "Autonomous mode. Claude proceeds without asking for most permissions.",
        args: ["--permission-mode", "auto"],
        env: { CLAUDE_CODE_ENABLE_AUTO_MODE: "1" },
        risky: true,
      },
      { id: "bypass", label: "Bypass permissions", description: "Skip all permission checks. Only for disposable workspaces.", args: ["--dangerously-skip-permissions"], risky: true },
    ],
  },
  {
    id: "pi",
    label: "Pi",
    binary: "pi",
    prompt: { kind: "positional" },
    defaultPermissionModeId: "default",
    modelFlag: "--model",
    interactiveTui: true,
    installHint: "Install Pi: https://github.com/badlogic/pi-mono",
    permissionModes: [
      PERMISSION_DEFAULT,
      { id: "approve", label: "Trust project files", description: "Trust project-local files for this run.", args: ["--approve"], risky: true },
      { id: "no-approve", label: "Ignore project files", description: "Ignore project-local configuration for this run.", args: ["--no-approve"], risky: false },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    prompt: { kind: "flag", flag: "--prompt" },
    defaultPermissionModeId: "default",
    modelFlag: "--model",
    interactiveTui: true,
    installHint: "Install OpenCode: https://opencode.ai",
    permissionModes: [
      PERMISSION_DEFAULT,
      { id: "auto", label: "Auto-approve", description: "Auto-approve permissions that are not explicitly denied.", args: ["--auto"], risky: true },
    ],
  },
  {
    id: "dsh",
    label: "DSH",
    binary: "dsh",
    prompt: { kind: "afterDoubleDash" },
    defaultPermissionModeId: "default",
    modelFlag: null,
    interactiveTui: false,
    installHint: "Install DSH and its headless profile (see `dsh --help`).",
    availability: dshHeadlessProfile,
    // No permission/model flags in headless; the card's choice is ignored on purpose.
    permissionModes: [PERMISSION_DEFAULT],
  },
];

export function getKanbanAgent(id: KanbanAgentKind): KanbanAgentEntry {
  const entry = KANBAN_AGENTS.find((agent) => agent.id === id);
  if (!entry) throw new DomainError("kanban-agent-unknown", `Unknown kanban agent "${id}"`);
  return entry;
}

async function binaryAvailable(binary: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [binary]);
    return true;
  } catch {
    return false;
  }
}

export interface KanbanAgentView {
  id: KanbanAgentKind;
  label: string;
  available: boolean;
  installHint: string;
  interactiveTui: boolean;
  modelFlag: string | null;
  permissionModes: Array<{ id: string; label: string; risky: boolean }>;
}

export async function listKanbanAgents(): Promise<KanbanAgentView[]> {
  return Promise.all(
    KANBAN_AGENTS.map(async (entry) => {
      const installed = await binaryAvailable(entry.binary);
      const extra = entry.availability?.();
      const available = installed && (extra?.available ?? true);
      return {
        id: entry.id,
        label: entry.label,
        available,
        installHint: !installed ? entry.installHint : extra?.hint ?? entry.installHint,
        interactiveTui: entry.interactiveTui,
        modelFlag: entry.modelFlag,
        permissionModes: entry.permissionModes.map(({ id, label, risky }) => ({ id, label, risky })),
      };
    })
  );
}

export interface KanbanLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  interactiveTui: boolean;
}

/**
 * Builds the argv/env for one card. The prompt is always one argv element —
 * never interpolated into a shell string.
 */
export function buildKanbanLaunch(card: KanbanCard, project: KanbanProject): KanbanLaunch {
  const entry = getKanbanAgent(card.agentId);
  const modes = entry.permissionModes;
  const selected =
    modes.find((mode) => mode.id === card.permissionModeId) ??
    modes.find((mode) => mode.id === entry.defaultPermissionModeId) ??
    PERMISSION_DEFAULT;

  const args: string[] = [...selected.args];
  if (entry.modelFlag && card.model) args.push(entry.modelFlag, card.model);

  switch (entry.prompt.kind) {
    case "positional":
      args.push(card.prompt);
      break;
    case "flag":
      args.push(entry.prompt.flag, card.prompt);
      break;
    case "afterDoubleDash":
      args.push("--", card.prompt);
      break;
  }

  const env: Record<string, string> = {
    ...(selected.env ?? {}),
    AGENTFABRIC_KANBAN_CARD_ID: card.id,
    AGENTFABRIC_KANBAN_PROJECT_ID: project.id,
  };

  return { file: entry.binary, args, env, interactiveTui: entry.interactiveTui };
}

/** Throw the right loud error before spawning a process that cannot start. */
export async function assertKanbanAgentAvailable(card: KanbanCard): Promise<void> {
  const entry = getKanbanAgent(card.agentId);
  if (!(await binaryAvailable(entry.binary))) {
    throw new DomainError(
      "kanban-agent-not-installed",
      `${entry.label} (${entry.binary}) is not on PATH — ${entry.installHint}`
    );
  }
  const extra = entry.availability?.();
  if (extra && !extra.available) {
    throw new DomainError("kanban-agent-profile-missing", `${entry.label}: ${extra.hint ?? "profile is missing"}`);
  }
}
