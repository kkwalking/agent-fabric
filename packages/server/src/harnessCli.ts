/**
 * Where the local harness CLIs actually are on this machine.
 *
 * A CLI installed by npm, bun, volta, asdf, mise, Homebrew or a vendor's own
 * installer usually lands in a folder that is **not** on the server's PATH:
 *
 * - the macOS desktop app is started by launchd (Dock, Finder, a login item),
 *   which hands it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing a shell profile
 *   adds — so `~/.local/bin/codex`, `~/.nvm/versions/node/v24/bin/pi`,
 *   `~/.opencode/bin/opencode` and `/opt/homebrew/bin/…` are all invisible;
 * - `npm run dev` inherits whatever terminal started it, which is one shell's
 *   PATH, not necessarily the one the user's CLIs were installed into.
 *
 * Asking `which <name>` therefore answered "not installed" for CLIs the user
 * runs every day (the board then said "本机没有安装任何 agent CLI"). Detection
 * answers the question the way a terminal would:
 *
 * 1. **the folders user tools are installed in** (`userBinDirs`: npm's prefixes,
 *    bun, volta, asdf, mise, pnpm, cargo, `~/.local/bin`, Homebrew, …), added to
 *    this process's PATH at boot so every later spawn — board PTY, run adapter,
 *    docker client — inherits them;
 * 2. **the login shell's PATH** (`loginShellPath`): `$SHELL -ilc` is asked what
 *    a terminal opened now has, because a profile (`nvm use`, `eval "$(direnv…)"`)
 *    can put a folder in PATH that no fixed list knows about. Cached for a
 *    minute, bounded by a timeout: a slow profile must never hold a request up;
 * 3. **the configured override** (`codex.bin` and friends in `config.json`), and
 *    it is never second-guessed: a path that does not exist is reported as the
 *    problem instead of silently falling back to a different binary.
 *
 * A CLI found in a folder the terminal's PATH does not have is reported with
 * `offPath`, so the UI can say *why* a terminal cannot run it — the exact case
 * where a user believes the tool is missing while it is merely off PATH.
 *
 * This mirrors how magpie (a Go desktop app with the same launchd problem)
 * handles it: `proc.UserPath` seeds the known folders and merges the login
 * shell's PATH, `proc.FindTool` looks past PATH, and `CLI.OffPath` tells the
 * user their terminal's PATH is missing the folder.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import type { AppConfig } from "@agentfabric/core";

/** The harness CLIs the board and the Settings page know by name. */
export type HarnessCliId = "claude" | "codex" | "opencode" | "pi" | "dsh";

/** One CLI as the catalog knows it: its id, the command, the config section. */
export interface HarnessCliSpec {
  id: HarnessCliId;
  /** Command name as a terminal types it. */
  command: string;
  /** Key in `AppConfig` holding `{ bin }`, when the file can override it. */
  configKey?: "claudeCode" | "codex" | "opencode" | "pi" | "dsh";
  /** Environment variable the adapters already read for the same override. */
  envVar: string;
}

export const HARNESS_CLIS: readonly HarnessCliSpec[] = [
  { id: "claude", command: "claude", configKey: "claudeCode", envVar: "AGENTFABRIC_CLAUDE_BIN" },
  { id: "codex", command: "codex", configKey: "codex", envVar: "AGENTFABRIC_CODEX_BIN" },
  { id: "opencode", command: "opencode", configKey: "opencode", envVar: "AGENTFABRIC_OPENCODE_BIN" },
  { id: "pi", command: "pi", configKey: "pi", envVar: "AGENTFABRIC_PI_BIN" },
  { id: "dsh", command: "dsh", configKey: "dsh", envVar: "AGENTFABRIC_DSH_BIN" },
];

/** How a CLI was found. */
export type HarnessCliSource = "configured" | "path" | "user-dirs" | "login-shell";

/** What detection knows about one CLI. */
export interface HarnessCliDetection {
  id: HarnessCliId;
  command: string;
  /** Absolute path of the executable; absent when it was not found. */
  path?: string;
  /** Version the CLI itself reported, when it answered. */
  version?: string;
  source?: HarnessCliSource;
  /**
   * True when the folder it was found in is not on the terminal's PATH, so
   * `which <command>` in a terminal opened now does not find it. False when the
   * terminal's PATH could not be read (unknown is not "off").
   */
  offPath: boolean;
  /**
   * Why the CLI is unusable, when it is: the configured path does not exist, the
   * file is not executable, … Absent for a found CLI.
   */
  problem?: string;
}

/** What the detection endpoint reports beside the rows. */
export interface HarnessCliReport {
  clis: HarnessCliDetection[];
  /** The login shell asked for its PATH, and whether it answered. */
  shell: { command: string | null; pathFound: boolean };
}

/* ------------------------------------------------------------------ */
/* Folders user tools are installed in                                 */
/* ------------------------------------------------------------------ */

const isWindows = process.platform === "win32";

/** Whether `p` is a directory that exists. */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `p` is a file this process may execute. */
export function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `$HOME`-relative folder, or "" when the variable is unusable. */
function homeDir(sub: string): string {
  return join(homedir(), sub);
}

/** The `bin` folder of the npm prefix `~/.npmrc` names, "" when it names none. */
function npmPrefixBin(): string {
  try {
    for (const line of readFileSync(homeDir(".npmrc"), "utf8").split("\n")) {
      const [key, ...rest] = line.split("=");
      if (!key || key.trim() !== "prefix") continue;
      let value = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
      if (isAbsolute(value)) return join(value, "bin");
    }
  } catch {
    /* no ~/.npmrc, or unreadable: nothing to add */
  }
  return "";
}

/** Node version folders of a manager, highest version first (v22 before v9). */
function nodeVersionBins(root: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const versionOf = (name: string): number[] =>
    (/(\d+)\.(\d+)\.(\d+)/.exec(name)?.slice(1) ?? []).map(Number);
  return names
    .filter((name) => /^v?\d+\.\d+\.\d+/.test(name) && isDir(join(root, name, suffix)))
    .sort((a, b) => {
      const [va, vb] = [versionOf(a), versionOf(b)];
      for (let i = 0; i < 3; i += 1) {
        const diff = (vb[i] ?? 0) - (va[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map((name) => join(root, name, suffix));
}

/**
 * nvm's Node folders, the one a terminal gets first: its `alias/default`
 * version when that is installed, else the highest — never "whichever sorts
 * last", which is what `ls` order would give (v9 after v22).
 */
function nvmBins(): string[] {
  const root = process.env.NVM_DIR && isAbsolute(process.env.NVM_DIR) ? process.env.NVM_DIR : homeDir(".nvm");
  const bins = nodeVersionBins(join(root, "versions", "node"), "bin");
  if (bins.length <= 1) return bins;
  let wanted = "";
  try {
    wanted = readFileSync(join(root, "alias", "default"), "utf8").trim().replace(/^v/, "");
  } catch {
    /* no default alias: the highest is the best guess */
  }
  if (!wanted) return bins;
  const match = bins.find((bin) => basename(join(bin, "..")) === `v${wanted}` || basename(join(bin, "..")) === wanted);
  return match ? [match, ...bins.filter((bin) => bin !== match)] : bins;
}

/**
 * The folders a user's command-line tools are installed in that exist here.
 *
 * Ordered as a terminal would reach them: PATH comes first (the caller looks
 * there before this list), then the managers' own folders. Only existing
 * directories are returned, so nothing downstream stats a folder twice.
 */
export function userBinDirs(): string[] {
  const home = homedir();
  const envDir = (name: string, sub: string): string => {
    const value = process.env[name];
    return value && isAbsolute(value) ? join(value, sub) : "";
  };
  const candidates = [
    homeDir(".local/bin"),
    homeDir(".npm-global/bin"),
    homeDir(".npm/bin"),
    npmPrefixBin(),
    envDir("NPM_CONFIG_PREFIX", "bin"),
    homeDir(".bun/bin"),
    envDir("BUN_INSTALL", "bin"),
    homeDir(".volta/bin"),
    envDir("VOLTA_HOME", "bin"),
    homeDir(".asdf/shims"),
    homeDir(".local/share/mise/shims"),
    homeDir(".local/share/pnpm"),
    envDir("PNPM_HOME", ""),
    homeDir("Library/pnpm"),
    homeDir(".cargo/bin"),
    envDir("CARGO_HOME", "bin"),
    homeDir(".deno/bin"),
    envDir("DENO_INSTALL", "bin"),
    // Vendor installers that keep their own tree: OpenCode's curl installer
    // (`~/.opencode/bin`), Claude Code's (`~/.local/bin`, already above).
    homeDir(".opencode/bin"),
    homeDir(".local/share/opencode/bin"),
    ...nvmBins(),
    ...nodeVersionBins(
      process.env.FNM_DIR && isAbsolute(process.env.FNM_DIR)
        ? join(process.env.FNM_DIR, "node-versions")
        : join(home, ".local/share/fnm/node-versions"),
      "installation/bin"
    ),
    ...nodeVersionBins(join(home, "Library/Application Support/fnm/node-versions"), "installation/bin"),
    ...nodeVersionBins(join(home, ".local/share/mise/installs/node"), "bin"),
    ...(isWindows ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/home/linuxbrew/.linuxbrew/bin"]),
  ];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of candidates) {
    if (!dir || !isAbsolute(dir) || seen.has(dir) || !isDir(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/* ------------------------------------------------------------------ */
/* PATH                                                                */
/* ------------------------------------------------------------------ */

/** PATH entries as folders, empty strings dropped. */
export function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
}

/** Appends the folders PATH lacks, keeping the ones it has first. */
function addToPath(dirs: string[]): void {
  const current = pathDirs();
  const seen = new Set(current);
  const added = dirs.filter((dir) => dir && isAbsolute(dir) && !seen.has(dir) && seen.add(dir));
  if (added.length === 0) return;
  process.env.PATH = [...current, ...added].join(delimiter);
}

/**
 * Adds the folders user tools are installed in to this process's PATH.
 *
 * Called once at boot so that everything the server later spawns — the board's
 * PTY, a run's harness, the docker client — resolves the same binaries the
 * detection reports. Idempotent: a second call adds nothing.
 */
export function ensureUserPath(): void {
  addToPath(userBinDirs());
}

/* ------------------------------------------------------------------ */
/* The login shell's PATH                                              */
/* ------------------------------------------------------------------ */

/** Marks the answer in whatever the profile prints before it. */
const SHELL_MARK = "__agentfabric_path__";

/** How long one question to the shell may take. */
const SHELL_TIMEOUT_MS = 4_000;

/** How long the answer is trusted before the shell is asked again. */
const LOGIN_PATH_TTL_MS = 60_000;

/** The shell a terminal here opens: `$SHELL`, else zsh, else sh. */
export function loginShell(): string {
  const shell = process.env.SHELL;
  if (shell && isAbsolute(shell)) return shell;
  return isDir("/bin") ? "/bin/zsh" : "/bin/sh";
}

/**
 * The command that prints the shell's PATH between two marks.
 *
 * It runs `/bin/sh` *inside* the shell, exactly as magpie's probe does: every
 * one of zsh, bash, fish and nushell hands a child its exported environment, so
 * what sh prints is the PATH an agent started from this shell would get — not
 * an unexported variable the shell expanded for itself. nushell needs `^` to
 * run sh as an external command.
 */
function shellProbeCommand(shell: string): string {
  const probe = `/bin/sh -c 'printf "${SHELL_MARK}%s${SHELL_MARK}" "$PATH"'`;
  return basename(shell) === "nu" ? `^${probe}` : probe;
}

/** Runs a command, resolving with what it printed; never rejects. */
function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      // No stdin: an interactive shell that reads it would wait forever.
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolvePromise({ code: typeof err.code === "number" ? err.code : null, stdout: typeof stdout === "string" ? stdout : "" });
          return;
        }
        resolvePromise({ code: 0, stdout: typeof stdout === "string" ? stdout : "" });
      }
    );
  });
}

/** Reads the marked PATH out of what the shell printed. */
export function parseShellPath(output: string): string[] | null {
  const start = output.indexOf(SHELL_MARK);
  if (start < 0) return null;
  const rest = output.slice(start + SHELL_MARK.length);
  const end = rest.indexOf(SHELL_MARK);
  if (end < 0) return null;
  const value = rest.slice(0, end);
  // A shell that printed the reference instead of expanding it (nushell before
  // its `^` form) says nothing usable.
  if (value === "" || value === "$PATH") return null;
  return value.split(delimiter).filter((dir) => dir.length > 0);
}

interface LoginPathAnswer {
  shell: string;
  dirs: string[] | null;
}

/**
 * Names everything a kept answer depends on: the folders looked in and the
 * shell asked.
 *
 * Answers are kept per stamp, not just per CLI. `PATH` is process state that
 * changes under a long-lived server — and under a test suite, where each case
 * points PATH at its own fake CLI — so an answer kept across a PATH change
 * would report a CLI that is no longer there (or miss one that now is). magpie
 * stamps its lookups with the PATH folders' identity for the same reason.
 */
function environmentStamp(): string {
  return [
    process.env.PATH ?? "",
    process.env.SHELL ?? "",
    process.env.HOME ?? "",
    process.env.NVM_DIR ?? "",
    process.env.BUN_INSTALL ?? "",
    process.env.VOLTA_HOME ?? "",
    process.env.NPM_CONFIG_PREFIX ?? "",
    process.env.PNPM_HOME ?? "",
  ].join("\0");
}

let loginPathCache: { at: number; stamp: string; answer: LoginPathAnswer } | undefined;
let loginPathPending: { stamp: string; promise: Promise<LoginPathAnswer> } | undefined;

/**
 * Asks the login shell what PATH a terminal opened now has; `null` when it did
 * not answer (no shell, a profile that hangs, a profile that hands the shell
 * over to something else).
 *
 * Asked as an interactive login shell first — many people put PATH in
 * `.zshrc`/`.bashrc` under an `interactive` test — then as a plain login shell,
 * which still reads `.zprofile`, `.bash_profile` and `config.fish`. The answer
 * is cached for a minute (per environment stamp) and shared by concurrent
 * callers.
 */
export function loginShellPath(options: { refresh?: boolean } = {}): Promise<LoginPathAnswer> {
  const stamp = environmentStamp();
  if (options.refresh) loginPathCache = undefined;
  const cached = loginPathCache;
  if (cached && cached.stamp === stamp && Date.now() - cached.at < LOGIN_PATH_TTL_MS) {
    return Promise.resolve(cached.answer);
  }
  if (loginPathPending && loginPathPending.stamp === stamp) return loginPathPending.promise;
  const shell = loginShell();
  const promise = (async () => {
    for (const flags of ["-ilc", "-lc"]) {
      const { code, stdout } = await run(shell, [flags, shellProbeCommand(shell)], SHELL_TIMEOUT_MS);
      const dirs = code === 0 ? parseShellPath(stdout) : null;
      if (dirs) {
        const answer: LoginPathAnswer = { shell, dirs };
        // Later spawns should resolve what the shell's PATH resolves. This
        // changes PATH, so the answer is kept under the *new* stamp.
        addToPath(dirs);
        loginPathCache = { at: Date.now(), stamp: environmentStamp(), answer };
        return answer;
      }
    }
    const answer: LoginPathAnswer = { shell, dirs: null };
    loginPathCache = { at: Date.now(), stamp: environmentStamp(), answer };
    return answer;
  })().finally(() => {
    if (loginPathPending?.promise === promise) loginPathPending = undefined;
  });
  loginPathPending = { stamp, promise };
  return promise;
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/** Candidate file names for a command on this platform. */
function namesFor(command: string): string[] {
  if (!isWindows) return [command];
  return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
}

/** The command's executable in `dir`, "" when there is none. */
function inDir(command: string, dir: string): string {
  for (const name of namesFor(command)) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return "";
}

/** The command on PATH, "" when it is not there. */
function onPath(command: string): string {
  for (const dir of pathDirs()) {
    const found = inDir(command, dir);
    if (found) return found;
  }
  return "";
}

/** The command in the first of `dirs` that has it, "" when none does. */
function inDirs(command: string, dirs: string[]): string {
  for (const dir of dirs) {
    const found = inDir(command, dir);
    if (found) return found;
  }
  return "";
}

/** The version token in what `--version` printed, "" when there is none. */
export function parseVersion(output: string): string {
  const first = output.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?)/.exec(first);
  return match?.[1] ?? "";
}

/** How long a version probe may take. */
const VERSION_TIMEOUT_MS = 5_000;

/** The version `path` reports, "" when it does not answer in time. */
async function versionOf(path: string): Promise<string> {
  const { stdout } = await run(path, ["--version"], VERSION_TIMEOUT_MS);
  return parseVersion(stdout);
}

/** How long one detection result is trusted before the CLI is probed again. */
const DETECTION_TTL_MS = 60_000;

/** Kept answers, keyed by the CLI, its explicit choice and the environment. */
let detectionCache = new Map<string, { at: number; value: HarnessCliDetection }>();

/** Drops every kept answer: the next detection looks again, right now. */
export function forgetDetection(): void {
  detectionCache = new Map();
  loginPathCache = undefined;
}

/** The configured override for a CLI, trimmed; "" when the file sets none. */
export function configuredBin(config: AppConfig | undefined, spec: HarnessCliSpec): string {
  if (!config || !spec.configKey) return "";
  const section = config[spec.configKey] as { bin?: string } | undefined;
  const value = section?.bin;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The override actually in force for a CLI, and where it came from.
 *
 * The adapters read `AGENTFABRIC_*_BIN`, so an environment value is what runs —
 * an operator's variable, or the file's (boot copies it there). Detection
 * reports the same choice the run will use: reporting the file's path while a
 * variable overrides it would show a CLI that is not the one spawned.
 */
export function explicitBin(
  config: AppConfig | undefined,
  spec: HarnessCliSpec
): { path: string; origin: "environment" | "config" } | undefined {
  const fromEnv = (process.env[spec.envVar] ?? "").trim();
  if (fromEnv) return { path: fromEnv, origin: "environment" };
  const fromFile = configuredBin(config, spec);
  return fromFile ? { path: fromFile, origin: "config" } : undefined;
}

/** Whether `dir` is one of the folders `dirs` lists (both cleaned). */
function containsDir(dirs: string[], dir: string): boolean {
  const target = dir.replace(/\/+$/, "");
  return dirs.some((entry) => entry.replace(/\/+$/, "") === target);
}

/** How much of detection to do; see `detectHarnessCli`. */
export interface DetectionOptions {
  config?: AppConfig;
  /** Drops the kept answers and looks again. */
  refresh?: boolean;
  /**
   * Asks each found CLI for its version (one process each). Off unless asked:
   * the board's start path only needs the path.
   */
  probeVersion?: boolean;
}

/**
 * Finds one CLI; asks its version only when `probeVersion` is set.
 *
 * The order is: an explicit choice (the environment's `AGENTFABRIC_*_BIN`, else
 * the config file's `bin`) — and only that, an explicit choice is never
 * second-guessed — then PATH, then the folders user tools live in, then the
 * login shell's PATH folders the process does not have. The first hit wins, and
 * `source` says which rule found it.
 */
export async function detectHarnessCli(
  spec: HarnessCliSpec,
  options: DetectionOptions = {}
): Promise<HarnessCliDetection> {
  const explicit = explicitBin(options.config, spec);
  // The environment is part of the key: PATH changes under a long-lived server
  // (and under every test case), and an answer kept across that change would
  // name a CLI that is no longer there, or miss one that now is.
  const cacheKey = `${spec.id}\0${explicit?.path ?? ""}\0${environmentStamp()}`;
  const cached = detectionCache.get(cacheKey);
  if (!options.refresh && cached && Date.now() - cached.at < DETECTION_TTL_MS) return cached.value;

  const keep = (value: HarnessCliDetection): HarnessCliDetection => {
    // Kept under the environment the answer was actually found in (looking may
    // have added the login shell's folders to PATH).
    detectionCache.set(`${spec.id}\0${explicit?.path ?? ""}\0${environmentStamp()}`, { at: Date.now(), value });
    return value;
  };
  const missing = (problem?: string): HarnessCliDetection =>
    keep({ id: spec.id, command: spec.command, offPath: false, ...(problem ? { problem } : {}) });

  if (explicit) {
    // An explicit value may be a bare command (the Settings field is free text):
    // resolve it like PATH would, otherwise treat it as a file.
    const path = isAbsolute(explicit.path)
      ? isExecutable(explicit.path)
        ? explicit.path
        : ""
      : (onPath(explicit.path) || inDirs(explicit.path, userBinDirs()));
    if (!path) {
      const where = explicit.origin === "environment" ? `${spec.envVar} (${explicit.path})` : explicit.path;
      return missing(`the configured path ${where} is not an executable file`);
    }
    return keep(await found(spec, path, "configured", options));
  }

  const onProcessPath = onPath(spec.command);
  if (onProcessPath) return keep(await found(spec, onProcessPath, "path", options));

  const inUserDirs = inDirs(spec.command, userBinDirs());
  if (inUserDirs) return keep(await found(spec, inUserDirs, "user-dirs", options));

  // The shell's PATH is asked last: it is the slowest question, and the fixed
  // folders above answer for every common installer without it.
  const login = await loginShellPath({ refresh: options.refresh });
  if (login.dirs) {
    const inShell = inDirs(spec.command, login.dirs.filter((dir) => isDir(dir)));
    if (inShell) return keep(await found(spec, inShell, "login-shell", options));
  }
  return missing();
}

/**
 * Builds the row for a CLI found at `path`.
 *
 * The version is only asked for when `probeVersion` says so: it costs one
 * `<cli> --version` process per CLI, and the board's start path (which runs this
 * on every card start) has no use for it — an ACP/TUI binary started for
 * `--version` is a process that had nothing to do. The Settings page, which
 * shows the version, asks for it.
 */
async function found(
  spec: HarnessCliSpec,
  path: string,
  source: HarnessCliSource,
  options: DetectionOptions
): Promise<HarnessCliDetection> {
  const version = options.probeVersion ? await versionOf(path) : "";
  const login = await loginShellPath({ refresh: options.refresh });
  return {
    id: spec.id,
    command: spec.command,
    path,
    source,
    // Unknown terminal PATH means "cannot tell", never "off".
    offPath: source !== "path" && login.dirs !== null && !containsDir(login.dirs, dirname(path)),
    ...(version ? { version } : {}),
  };
}

/**
 * Detection for every known CLI, in parallel (the version probes are the slow
 * part, one process each).
 */
export async function detectHarnessClis(options: DetectionOptions = {}): Promise<HarnessCliReport> {
  // The report is the Settings page's view: it names the version, so it asks.
  const detection = { ...options, probeVersion: true };
  const [clis, login] = await Promise.all([
    Promise.all(HARNESS_CLIS.map((spec) => detectHarnessCli(spec, detection))),
    loginShellPath({ refresh: options.refresh }),
  ]);
  return {
    clis,
    shell: { command: login.shell, pathFound: login.dirs !== null },
  };
}

/** The detection row for a command name, `undefined` for an unknown command. */
export function harnessCliSpec(command: string): HarnessCliSpec | undefined {
  return HARNESS_CLIS.find((spec) => spec.command === command || spec.id === command);
}

/** The values this process itself wrote into `AGENTFABRIC_*_BIN`. */
const appliedBins = new Map<string, string>();

/**
 * Puts the configured `bin` overrides where the harness adapters read them.
 *
 * The adapters take `AGENTFABRIC_*_BIN` from the environment, and that is what
 * this writes — but a variable somebody else set (an operator, a test's fake
 * CLI) is never overwritten by the file: an explicit environment wins.
 *
 * An in-process restart re-enters this with a freshly read config, so a value
 * this function wrote earlier is replaced, and one the new config no longer
 * sets is removed again — otherwise the previous boot's path would outlive the
 * setting that asked for it.
 *
 * A configured path that does not exist is still written: detection reports it
 * as the problem, and the spawn fails with that path in the message instead of
 * quietly running a different binary.
 */
export function applyConfiguredHarnessBins(config: AppConfig | undefined): string[] {
  const applied: string[] = [];
  for (const spec of HARNESS_CLIS) {
    const configured = configuredBin(config, spec);
    const current = process.env[spec.envVar];
    const mine = appliedBins.get(spec.envVar);
    // A variable that is set but is not ours belongs to the environment.
    if (current !== undefined && current !== mine) continue;
    if (!configured) {
      if (mine !== undefined) delete process.env[spec.envVar];
      appliedBins.delete(spec.envVar);
      continue;
    }
    process.env[spec.envVar] = configured;
    appliedBins.set(spec.envVar, configured);
    applied.push(`${spec.envVar}=${configured}`);
  }
  return applied;
}
