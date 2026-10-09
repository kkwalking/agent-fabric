/**
 * Process-level teardown helpers for a graceful shutdown.
 *
 * Three things must hold when the platform stops:
 *
 * 1. **The store is never corrupted.** Every mutation is an atomic temp-file +
 *    rename, so whatever is on disk is a complete document; a stop can lose
 *    the newest mutation, never break the file. Nothing here writes anything.
 * 2. **No orphan work.** The harness CLIs, `git` and local `docker` clients a
 *    Run spawned are killed, and the containers those killed clients could no
 *    longer remove are force-removed here.
 * 3. **No false record.** A stop is not a user action, so nothing here writes
 *    a terminal status: the Run keeps the phase its lifecycle last committed,
 *    and the next start's `ExecutionSupervisor.recoverInterrupted()` reads
 *    that phase and reports the precise next step (retry agent / validation /
 *    publish). Recording `cancelled` here would destroy that information.
 *
 * Everything is synchronous and best-effort. Synchronous is the point: the
 * caller exits the process immediately afterwards, so no shutdown step may
 * depend on the event loop turning — and a blocked event loop is exactly what
 * guarantees that no half-stopped lifecycle gets a chance to write "failed"
 * over the interrupted state (3). Every external command is bounded, and the
 * teardown as a whole respects a deadline.
 */
import { execFileSync } from "node:child_process";
import { dockerBin } from "@agentfabric/runtimes";

/** Bound for one `pgrep` probe; a wedged probe must not stall the shutdown. */
const PROBE_TIMEOUT_MS = 2_000;
/** Upper bound for one `docker` invocation; the deadline usually cuts it shorter. */
const DOCKER_TIMEOUT_MS = 15_000;
/** Default budget for the whole teardown. */
export const DEFAULT_TEARDOWN_DEADLINE_MS = 10_000;

/** Validation containers are a class (no task/run label) — matched by label. */
const VALIDATION_CONTAINER_FILTER = "label=agentfabric.validation=true";

function run(bin: string, args: string[], timeoutMs: number): string {
  return execFileSync(bin, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * The timeout one step may use, clamped to what is left of the deadline.
 * `null` means the deadline is spent and the step must not start. The teardown
 * runs synchronously, so it must bound itself: the caller's `setTimeout`
 * watchdog cannot fire while this is on the stack.
 */
function budgetUntil(deadline: number): number | null {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  return Math.max(500, Math.min(DOCKER_TIMEOUT_MS, remaining));
}

/**
 * Every descendant of `pid`. `pgrep -P` only lists direct children, so the
 * tree is walked level by level.
 *
 * Used to stop the processes a Run spawned: harness CLIs, `git`, `curl` and
 * the local `docker` clients. They are all spawned in this process's group
 * (never detached), so they cannot outlive an explicit walk like this one.
 */
export function descendantPids(pid: number, deadline = Date.now() + DEFAULT_TEARDOWN_DEADLINE_MS): number[] {
  const found: number[] = [];
  const pending = [pid];
  while (pending.length > 0) {
    const probe = budgetUntil(deadline);
    if (probe === null) break;
    const current = pending.shift()!;
    let children: number[];
    try {
      children = run("pgrep", ["-P", String(current)], Math.min(PROBE_TIMEOUT_MS, probe))
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      // A non-zero exit means "no children"; a missing `pgrep` means the same
      // for our purposes. Neither is fatal to the shutdown.
      children = [];
    }
    for (const child of children) {
      if (found.includes(child)) continue;
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

/** Kills every descendant of `pid` (children before their parents). */
export function killDescendants(pid: number, deadline?: number): number[] {
  const pids = descendantPids(pid, deadline);
  // Reverse order: a killed parent cannot spawn new work after its children.
  for (const child of [...pids].reverse()) {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return pids;
}

/** Container ids matching one `docker ps` filter (empty when docker is absent). */
function containerIds(filter: string, timeoutMs: number): string[] {
  try {
    return run(dockerBin(), ["ps", "-aq", "--filter", filter], timeoutMs)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // No docker, no daemon, or a broken client: there is nothing to remove,
    // and the shutdown must not fail because of it.
    return [];
  }
}

/** Force-removes every container matching the filters. Returns the ids removed. */
export function removeContainers(filters: string[], deadline: number): string[] {
  const ids = new Set<string>();
  for (const filter of filters) {
    const probe = budgetUntil(deadline);
    if (probe === null) break;
    for (const id of containerIds(filter, probe)) ids.add(id);
  }
  if (ids.size === 0) return [];
  const removal = budgetUntil(deadline);
  if (removal === null) return [];
  try {
    run(dockerBin(), ["rm", "-f", ...ids], removal);
  } catch {
    /* best effort: a container that refuses removal is reported, not fatal */
  }
  return [...ids];
}

export interface TeardownOptions {
  /**
   * Tasks whose lifecycle is in flight **in this process**. Their agent
   * containers carry `agentfabric.task=<id>` (ephemeral, persistent and
   * keep-alive alike), which is what makes the removal precise: containers of
   * tasks this instance is not running are never touched.
   */
  taskIds: string[];
  /** Runs executing in this process (classic, non-project runs). */
  runIds: string[];
  /** Overall budget; the teardown starts no new step past it. */
  deadlineMs?: number;
  log?: (message: string) => void;
}

export interface TeardownResult {
  killedPids: number[];
  removedContainers: string[];
  /** True when the deadline cut the teardown short. */
  expired: boolean;
}

/**
 * Stops everything the running work started: the process tree (harness CLIs,
 * `git`, local `docker` clients) and then the containers whose removal those
 * killed clients can no longer perform.
 */
export function teardownWork(opts: TeardownOptions): TeardownResult {
  const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_TEARDOWN_DEADLINE_MS);
  const log = opts.log ?? (() => {});
  const killedPids = killDescendants(process.pid, deadline);
  if (killedPids.length > 0) log(`stopped ${killedPids.length} child process(es) of the running work`);

  const filters = [
    ...opts.taskIds.map((id) => `label=agentfabric.task=${id}`),
    ...opts.runIds.map((id) => `label=agentfabric.run=${id}`),
    // Validation sandboxes are disposable and carry no task/run label, so
    // they are matched as a class. Validation only runs inside a Task
    // lifecycle, so a classic run's shutdown never reaches this filter — and
    // an idle server (no in-flight work at all) never probes docker.
    ...(opts.taskIds.length > 0 ? [VALIDATION_CONTAINER_FILTER] : []),
  ];
  const removedContainers = removeContainers(filters, deadline);
  if (removedContainers.length > 0) log(`force-removed ${removedContainers.length} container(s) of the running work`);

  return { killedPids, removedContainers, expired: Date.now() > deadline };
}
