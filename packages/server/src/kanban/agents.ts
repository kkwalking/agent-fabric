/**
 * Interactive CLI agent catalog for the board (v13 §4).
 *
 * This is deliberately separate from `@agentfabric/runtimes`: those adapters
 * run harnesses **headless** and parse structured events for a Run. The board
 * launches the same binaries as **interactive** sessions and lets the agent
 * own its UI, in one of two transports:
 *
 * - `pty`: the CLI is a TUI. `node-pty` hands its screen bytes to xterm.
 * - `acp`: the CLI is an Agent Client Protocol server. AgentFabric speaks the
 *   protocol and renders the conversation itself.
 *
 * DSH has no TUI, so it uses `acp`; the other agents keep their own TUI.
 * Conflating the transports would either break a TUI (structured flags) or
 * break the protocol (raw bytes).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DomainError } from "@agentfabric/core";
import type { KanbanAgentKind, KanbanCard, KanbanSessionTransport, Workspace } from "@agentfabric/core";
import { detectHarnessCli, harnessCliSpec } from "../harnessCli.js";

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
  /**
   * argv emitted before the permission/model flags. Some CLIs are launchers
   * whose first positional selects the profile/entry point (DSH:
   * `dsh --profile acp …`), so the launch is not just "binary + prompt".
   */
  baseArgs?: string[];
  /** Prompt delivery: a positional argv element, a flag + value, or the protocol. */
  prompt: { kind: "positional" } | { kind: "flag"; flag: string } | { kind: "afterDoubleDash" } | { kind: "acp" };
  /** How the board talks to this agent; see the module comment. */
  transport: KanbanSessionTransport;
  permissionModes: KanbanPermissionMode[];
  defaultPermissionModeId: string;
  modelFlag: string | null;
  interactiveTui: boolean;
  installHint: string;
  /**
   * argv that continues the harness's own previous session. Omitted when the
   * CLI has no resume surface (Pi) — such a card cannot be released and
   * reattached, so the runtime keeps its process alive instead.
   */
  resumeArgs?: (nativeSessionId: string) => string[];
  /** Extra check besides the binary (e.g. a DSH profile). May probe the CLI. */
  availability?: () => { available: boolean; hint?: string } | Promise<{ available: boolean; hint?: string }>;
}

const PERMISSION_DEFAULT: KanbanPermissionMode = {
  id: "default",
  label: "Default",
  description: "Use the CLI's own permission behavior.",
  args: [],
  risky: false,
};

/**
 * DSH ACP is the board's interactive surface for DSH (there is no DSH TUI).
 * The profile is a shipped app template: the launcher materializes
 * `$DSH_HOME/profiles/acp` from it on first use, so asking the CLI itself is
 * the only honest availability check. The probe is cached for the process
 * lifetime — it is a boot check, not state that changes under a board.
 */
let acpProbe: Promise<{ available: boolean; hint?: string }> | undefined;

function dshAcpProfile(): Promise<{ available: boolean; hint?: string }> {
  // Once the launcher has materialized the profile, the profile directory is
  // the fact; probing `--help` on every first start would spawn Electron for
  // no new information.
  if (existsSync(dshAcpProfileDir())) return Promise.resolve({ available: true });
  acpProbe ??= execFileAsync("dsh", ["--profile", "acp", "--help"], { timeout: 20_000 })
    .then(() => ({ available: true }))
    .catch((err: unknown) => ({
      available: false,
      hint:
        "DSH with the ACP app is required for interactive board sessions: run `dsh --profile acp --help` once, " +
        "or upgrade DSH (0.2.1+ ships the acp profile). " +
        (err instanceof Error ? err.message : String(err)),
    }));
  return acpProbe;
}

export const KANBAN_AGENTS: readonly KanbanAgentEntry[] = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    prompt: { kind: "positional" },
    transport: "pty",
    defaultPermissionModeId: "default",
    modelFlag: "--model",
    interactiveTui: true,
    installHint: "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/quickstart",
    resumeArgs: (sessionId) => ["--resume", sessionId],
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
    transport: "pty",
    defaultPermissionModeId: "default",
    modelFlag: "--model",
    interactiveTui: true,
    installHint: "Install Pi: https://github.com/badlogic/pi-mono",
    permissionModes: [
      PERMISSION_DEFAULT,
      { id: "approve", label: "Trust workspace files", description: "Trust workspace-local files for this run.", args: ["--approve"], risky: true },
      { id: "no-approve", label: "Ignore workspace files", description: "Ignore workspace-local configuration for this run.", args: ["--no-approve"], risky: false },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    prompt: { kind: "flag", flag: "--prompt" },
    transport: "pty",
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
    // DSH is a profile launcher; `acp` is the interactive stdio app. The
    // prompt travels over the protocol, not argv.
    baseArgs: ["--profile", "acp"],
    prompt: { kind: "acp" },
    transport: "acp",
    defaultPermissionModeId: "default",
    // The ACP handshake advertises model config options; the card model is
    // not wired to them yet, so the catalog claims no model flag.
    modelFlag: null,
    interactiveTui: false,
    installHint: "Install DSH (0.2.1+) and make sure `dsh --profile acp` starts.",
    availability: dshAcpProfile,
    // ACP asks the client before sensitive tools run; "auto" answers allow
    // without a human in the loop.
    permissionModes: [
      {
        id: "default",
        label: "Ask",
        description: "Ask in the card before a sensitive tool runs.",
        args: [],
        risky: false,
      },
      {
        id: "auto",
        label: "Auto-approve",
        description: "Allow every tool permission request without asking.",
        args: [],
        risky: true,
      },
    ],
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

/**
 * Whether the agent's CLI is on this machine, and where.
 *
 * Detection (`../harnessCli.ts`) rather than `which`: the server may run from a
 * Dock-launched app whose PATH is launchd's, in which case every npm/bun/nvm/
 * Homebrew-installed CLI is invisible to `which` while it is installed and
 * runnable. The row also carries the resolved path so the launch uses exactly
 * the binary the board said was there.
 */
async function locate(binary: string): Promise<{ installed: boolean; path?: string; offPath: boolean; problem?: string }> {
  const spec = harnessCliSpec(binary);
  if (!spec) {
    const installed = await binaryAvailable(binary);
    return { installed, offPath: false };
  }
  const detection = await detectHarnessCli(spec);
  return {
    installed: detection.path !== undefined,
    ...(detection.path ? { path: detection.path } : {}),
    offPath: detection.offPath,
    ...(detection.problem ? { problem: detection.problem } : {}),
  };
}

export interface KanbanAgentView {
  id: KanbanAgentKind;
  label: string;
  available: boolean;
  installHint: string;
  interactiveTui: boolean;
  transport: KanbanSessionTransport;
  modelFlag: string | null;
  permissionModes: Array<{ id: string; label: string; risky: boolean }>;
  /** Absolute path of the CLI detection found; absent when not installed. */
  cliPath?: string;
  /**
   * The CLI is installed in a folder the terminal's PATH does not have, so
   * `which <command>` there finds nothing — the case where a user is sure the
   * tool is missing. False when the terminal's PATH could not be read.
   */
  cliOffPath: boolean;
}

export async function listKanbanAgents(): Promise<KanbanAgentView[]> {
  return Promise.all(
    KANBAN_AGENTS.map(async (entry) => {
      const located = await locate(entry.binary);
      const installed = located.installed;
      const extra = installed ? await entry.availability?.() : undefined;
      const available = installed && (extra?.available ?? true);
      return {
        id: entry.id,
        label: entry.label,
        available,
        installHint: !installed ? entry.installHint : extra?.hint ?? entry.installHint,
        interactiveTui: entry.interactiveTui,
        transport: entry.transport,
        modelFlag: entry.modelFlag,
        permissionModes: entry.permissionModes.map(({ id, label, risky }) => ({ id, label, risky })),
        ...(located.path ? { cliPath: located.path } : {}),
        cliOffPath: located.offPath,
      };
    })
  );
}

export interface KanbanLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  interactiveTui: boolean;
  transport: KanbanSessionTransport;
}

/**
 * Builds the argv/env for one card. The prompt is always one argv element —
 * never interpolated into a shell string — except for the ACP transport,
 * where the session runtime sends it over the protocol after the handshake.
 *
 * `file` is the executable to run: the one the caller resolved (`executable`,
 * from `resolveKanbanAgentExecutable`) when it has one, else the bare command
 * name, which the spawn resolves against PATH. The caller passing it in is what
 * keeps the process that starts identical to the one the availability check
 * approved — reading a process-wide cache here instead let a stale entry from an
 * earlier check decide which binary ran.
 */
export function buildKanbanLaunch(
  card: KanbanCard,
  workspace: Workspace,
  options: { resumeSessionId?: string; executable?: string } = {}
): KanbanLaunch {
  const entry = getKanbanAgent(card.agentId);
  const file = options.executable ?? entry.binary;
  const modes = entry.permissionModes;
  const selected =
    modes.find((mode) => mode.id === card.permissionModeId) ??
    modes.find((mode) => mode.id === entry.defaultPermissionModeId) ??
    PERMISSION_DEFAULT;

  const args: string[] = [...(entry.baseArgs ?? []), ...selected.args];
  if (entry.modelFlag && card.model) args.push(entry.modelFlag, card.model);

  // Continue the harness's own session instead of starting a new one. The
  // prompt is not re-sent: the resumed session already holds it, and handing
  // it over again would replay the same instruction as a second turn.
  if (options.resumeSessionId && entry.resumeArgs) {
    args.push(...entry.resumeArgs(options.resumeSessionId));
    return {
      file,
      args,
      env: {
        ...(selected.env ?? {}),
        AGENTFABRIC_KANBAN_CARD_ID: card.id,
        AGENTFABRIC_KANBAN_WORKSPACE_ID: workspace.id,
      },
      interactiveTui: entry.interactiveTui,
      transport: entry.transport,
    };
  }

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
    case "acp":
      // The prompt is a protocol request, not an argv element.
      break;
  }

  const env: Record<string, string> = {
    ...(selected.env ?? {}),
    AGENTFABRIC_KANBAN_CARD_ID: card.id,
    AGENTFABRIC_KANBAN_WORKSPACE_ID: workspace.id,
  };

  return { file, args, env, interactiveTui: entry.interactiveTui, transport: entry.transport };
}

/** Absolute $DSH_HOME, mirroring the harness's own launcher. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** Locations that must exist for a DSH ACP launch to be plausible. */
export function dshAcpProfileDir(): string {
  return join(dshHome(), "profiles", "acp");
}

/**
 * Throw the right loud error before spawning a process that cannot start, and
 * hand back the executable that was approved.
 *
 * The check is detection's, not `which`'s: a CLI installed in `~/.local/bin`
 * or an nvm Node folder is runnable from the server (its PATH has those
 * folders) even when the terminal that starts the board would not find it. The
 * returned path is what `buildKanbanLaunch` must run: resolving twice would let
 * the two answers differ.
 */
export async function assertKanbanAgentAvailable(card: KanbanCard): Promise<{ executable?: string }> {
  const entry = getKanbanAgent(card.agentId);
  const located = await locate(entry.binary);
  if (!located.installed) {
    throw new DomainError(
      "kanban-agent-not-installed",
      `${entry.label} (${entry.binary}) is not on PATH — ${located.problem ?? entry.installHint}`
    );
  }
  const extra = await entry.availability?.();
  if (extra && !extra.available) {
    throw new DomainError("kanban-agent-profile-missing", `${entry.label}: ${extra.hint ?? "profile is missing"}`);
  }
  return located.path ? { executable: located.path } : {};
}
