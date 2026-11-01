/**
 * The model catalog each interactive harness offers.
 *
 * The board sends a card's model straight to the CLI, so a free-text field let
 * users type a value the CLI would reject. Every agent here exposes its own
 * list; this module reads those lists and caches them for a minute.
 *
 * - DSH: no command lists models — the catalog is assembled at runtime and
 *   published in `session/new`'s `model` option. Read through one short ACP
 *   handshake, with persistence redirected to a throwaway directory.
 * - Claude Code: its picker options are the `modelPicker` table in
 *   `~/.claude/settings.json` (the aliases Sonnet/Opus/Haiku when unset).
 * - Pi: `pi --list-models` prints a provider/model table.
 * - OpenCode: `opencode models` prints `provider/model` rows.
 *
 * A listing command that answers with **nothing** is treated as a failed read,
 * not as an agent that offers no models: `opencode models` talks to OpenCode's
 * background service, and on a machine where that service is not up yet the
 * first invocation starts it, prints an empty list and exits 0 — the next
 * invocation sees the catalog. Believing the first answer cached "no models"
 * for a minute and left the New Task form with an empty picker.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DomainError } from "@agentfabric/core";
import type { KanbanAgentKind } from "@agentfabric/core";
import { detectHarnessCli, harnessCliSpec, type HarnessCliId } from "../harnessCli.js";
import { AcpSession, type AcpConfigOption } from "./acp.js";

const execFileAsync = promisify(execFile);

export interface KanbanModelOption {
  /** Exact value the app accepts (a CLI model id, or ACP's opaque route). */
  value: string;
  /** Name the app shows for this model. */
  label: string;
  /** Provider group the app files it under, when it groups its models. */
  group?: string;
}

const CACHE_TTL_MS = 60_000;
/**
 * How many times a listing command is polled before its answer is believed.
 *
 * OpenCode's catalog arrives in stages after its background service starts
 * (0 → 18 → 40 rows measured), so the read waits for two agreeing answers. Four
 * attempts at 250 ms covers that warm-up in well under a second while keeping a
 * broken CLI from holding the request open.
 */
const LISTING_POLL_ATTEMPTS = 4;
const LISTING_POLL_DELAY_MS = 250;
const cached = new Map<string, { at: number; models: KanbanModelOption[] }>();
const inFlight = new Map<string, Promise<KanbanModelOption[]>>();

/**
 * Flattens the ACP `model` option into picker rows. ACP groups some catalogs
 * by provider (`{ group, options }`) and leaves others flat; both shapes keep
 * the provider identity so the form can render `optgroup`s.
 */
export function flattenModelOptions(
  option: Pick<AcpConfigOption, "options"> | undefined
): KanbanModelOption[] {
  if (!option?.options) return [];
  const models: KanbanModelOption[] = [];
  for (const entry of option.options) {
    if ("group" in entry) {
      for (const model of entry.options) {
        models.push({
          value: model.value,
          label: model.name,
          ...(entry.name ? { group: entry.name } : {}),
        });
      }
    } else {
      models.push({ value: entry.value, label: entry.name });
    }
  }
  return models;
}

/** Parses Pi's fixed-width `provider model ...` table. */
export function parsePiModels(output: string): KanbanModelOption[] {
  const models: KanbanModelOption[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+)\s{2,}(\S+)\s{2,}/u.exec(line);
    if (!match) continue;
    const [, provider, model] = match;
    if (!provider || !model || provider === "provider" || model === "model") continue;
    models.push({ value: `${provider}/${model}`, label: model, group: provider });
  }
  return models;
}

/** Parses `opencode models`, whose rows are `provider/model`. */
export function parseOpenCodeModels(output: string): KanbanModelOption[] {
  const models: KanbanModelOption[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const value = line.trim();
    if (!value || value.includes(" ")) continue;
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) continue;
    models.push({
      value,
      label: value.slice(slash + 1),
      group: value.slice(0, slash),
    });
  }
  return models;
}

/** Reads Claude Code's model picker table; aliases are the fallback. */
export function claudeModelsFromSettings(raw: unknown): KanbanModelOption[] {
  const options = (raw as { modelPicker?: { options?: unknown } } | undefined)?.modelPicker?.options;
  if (Array.isArray(options)) {
    const models: KanbanModelOption[] = [];
    const seen = new Set<string>();
    for (const entry of options) {
      if (!entry || typeof entry !== "object") continue;
      const { model, label } = entry as { model?: unknown; label?: unknown };
      if (typeof model !== "string" || !model || seen.has(model)) continue;
      seen.add(model);
      models.push({
        value: model,
        label: typeof label === "string" && label ? label : model,
      });
    }
    if (models.length > 0) return models;
  }
  return [
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "haiku", label: "Haiku" },
  ];
}

/** The models one agent offers, cached for a minute. */
export async function listAgentModels(agent: KanbanAgentKind): Promise<KanbanModelOption[]> {
  const hit = cached.get(agent);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.models;
  let pending = inFlight.get(agent);
  if (!pending) {
    pending = probe(agent)
      .then((models) => {
        cached.set(agent, { at: Date.now(), models });
        return models;
      })
      .finally(() => inFlight.delete(agent));
    inFlight.set(agent, pending);
  }
  return pending;
}

async function probe(agent: KanbanAgentKind): Promise<KanbanModelOption[]> {
  switch (agent) {
    case "dsh":
      return probeDsh();
    case "claude":
      return probeClaude();
    case "pi":
      return parsePiModels(await runListingCli("pi", ["--list-models"]));
    case "opencode":
      return parseOpenCodeModels(await runListingCli("opencode", ["models"]));
    default:
      throw new DomainError(
        "kanban-model-catalog-unavailable",
        `${agent} does not expose a model catalog`
      );
  }
}

/**
 * Polls a listing command until its answer settles, and returns the settled text.
 *
 * `opencode models` is answered by OpenCode's own background service. On a cold
 * machine the first invocation starts that service and returns **nothing**; the
 * next ones return a growing list as providers finish loading (measured here:
 * 0 rows, then 18, then the full 40). Believing any of the early answers made
 * the New Task form show no models at all, or a picker missing two thirds of
 * them, and the wrong answer was then cached for a minute.
 *
 * "Settled" is therefore *two consecutive non-empty reads that agree*, not "a
 * read that returned something". The wait is bounded: after the attempts run
 * out the last non-empty read is returned as the catalog (it is what the CLI
 * said, and an incomplete list is still usable), while a command that answered
 * **only** with nothing is a failed read — reported loudly, never cached as
 * "this agent offers no models".
 */
async function runListingCli(id: HarnessCliId, args: string[]): Promise<string> {
  const settled = await pollListingUntilSettled(() => runCli(id, args));
  if (settled === undefined) {
    throw new DomainError(
      "kanban-model-catalog-unavailable",
      `${id} listed no models (ran \`${id} ${args.join(" ")}\` ${LISTING_POLL_ATTEMPTS} times)`
    );
  }
  return settled;
}

/**
 * The decision above, separated from process launching so it can be tested: it
 * reads until two consecutive non-empty answers carry the same number of rows,
 * and returns `undefined` when every attempt answered with nothing.
 */
export async function pollListingUntilSettled(
  read: () => Promise<string>,
  attempts: number = LISTING_POLL_ATTEMPTS,
  delayMs: number = LISTING_POLL_DELAY_MS
): Promise<string | undefined> {
  let last: string | undefined;
  let previousCount = -1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const output = await read();
    const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    if (lines.length === previousCount) return output;
    previousCount = lines.length;
    last = output;
  }
  return last;
}

/** Models the DSH acp profile offers, read from one throwaway handshake. */
async function probeDsh(): Promise<KanbanModelOption[]> {
  const executable = await executableFor("dsh");
  const dir = await mkdtemp(join(tmpdir(), "af-dsh-models-"));
  const patch = join(dir, "patch.yml");
  await writeFile(
    patch,
    `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(join(dir, "sessions"))}\n`,
    "utf8"
  );

  const acp = new AcpSession({
    file: executable,
    args: ["--profile", "acp", "--patch", patch],
    cwd: dir,
    env: {},
  });
  try {
    await acp.initialize();
    const created = await acp.newSession(dir);
    const models = flattenModelOptions(created.configOptions.find((option) => option.id === "model"));
    if (models.length === 0) {
      throw new DomainError("kanban-model-catalog-unavailable", "DSH advertised no models");
    }
    return models;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "kanban-model-catalog-unavailable",
      `Could not read DSH's model list: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    acp.stop();
    // Give the process group a moment to die before removing its temp store;
    // `rm --force` is still the last word if it is slow.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function probeClaude(): Promise<KanbanModelOption[]> {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const path = join(dir, "settings.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return claudeModelsFromSettings(raw);
  } catch (error) {
    // A missing settings file is normal: Claude then uses its stock aliases.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return claudeModelsFromSettings(undefined);
    throw new DomainError(
      "kanban-model-catalog-unavailable",
      `Could not read Claude Code's model list (${path}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function runCli(id: HarnessCliId, args: string[]): Promise<string> {
  const executable = await executableFor(id);
  try {
    const { stdout } = await execFileAsync(executable, args, {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new DomainError(
      "kanban-model-catalog-unavailable",
      `Could not read the ${id} model list: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function executableFor(id: HarnessCliId): Promise<string> {
  const spec = harnessCliSpec(id);
  const detection = spec ? await detectHarnessCli(spec) : undefined;
  if (!detection?.path) {
    throw new DomainError("kanban-model-catalog-unavailable", `${id} is not installed, so its model list cannot be read`);
  }
  return detection.path;
}
