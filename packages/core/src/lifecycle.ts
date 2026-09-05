import type { ID, Runtime, RuntimeLifecycle, RuntimeLifecycleMode } from "./types.js";

/** Default idle window for keep-alive containers: 10 minutes. */
export const DEFAULT_KEEP_ALIVE_IDLE_MS = 10 * 60 * 1000;

/**
 * Resolves the effective container lifecycle policy for a Run
 * (spec v1 §1). Precedence: per-run override > runtime.lifecycle >
 * legacy `ephemeral` flag > ephemeral default.
 */
export function resolveLifecycle(
  runtime: Runtime | undefined,
  override?: RuntimeLifecycle
): RuntimeLifecycle {
  if (override?.mode) {
    return { mode: override.mode, idleTimeoutMs: override.idleTimeoutMs };
  }
  if (runtime?.lifecycle?.mode) {
    return {
      mode: runtime.lifecycle.mode,
      idleTimeoutMs: runtime.lifecycle.idleTimeoutMs,
    };
  }
  // Legacy MVP flag: ephemeral === false meant "keep the container".
  const mode: RuntimeLifecycleMode = runtime?.ephemeral === false ? "persistent" : "ephemeral";
  return { mode, idleTimeoutMs: DEFAULT_KEEP_ALIVE_IDLE_MS };
}

/** Normalize an unresolved lifecycle (e.g. missing idle timeout). */
export function normalizeLifecycle(lifecycle: RuntimeLifecycle | undefined): RuntimeLifecycle {
  return {
    mode: lifecycle?.mode ?? "ephemeral",
    idleTimeoutMs: lifecycle?.idleTimeoutMs ?? DEFAULT_KEEP_ALIVE_IDLE_MS,
  };
}

/**
 * Pluggable container operations so the lease manager stays
 * infrastructure-neutral (Docker in production, fakes in tests).
 */
export interface ContainerOps {
  /** Force-remove a container. Must be idempotent. */
  destroy(containerId: string): Promise<void>;
  /**
   * List containers this AgentFabric instance retained under the
   * keep-alive lifecycle, with their orchestration labels. Used to
   * re-arm idle-destroy timers after a restart. Optional: without it,
   * keep-alive recovery is skipped (containers may linger until manual
   * cleanup).
   */
  listKeepAlive?(): Promise<ManagedContainerInfo[]>;
}

/** A container tracked via orchestration labels (recovery input). */
export interface ManagedContainerInfo {
  containerId: string;
  name?: string;
  labels?: Record<string, string>;
}

/**
 * Re-arms keep-alive leases from container labels after a restart:
 * containers whose idle timeout already passed are destroyed, the rest
 * get fresh timers so idle containers never leak.
 */
export async function recoverKeepAliveContainers(manager: ContainerLeaseManager, infos: ManagedContainerInfo[]): Promise<void> {
  const leases: ContainerLease[] = [];
  for (const info of infos) {
    const labels = info.labels ?? {};
    if (labels["agentfabric.keepalive"] !== "true") continue;
    leases.push({
      containerId: info.containerId,
      containerName: info.name ?? labels["agentfabric.name"],
      runtimeId: labels["agentfabric.runtime"] ?? "unknown",
      workspaceId: labels["agentfabric.workspace"] || undefined,
      taskId: labels["agentfabric.task"] || undefined,
      runId: labels["agentfabric.run"] ?? "unknown",
      idleTimeoutMs: DEFAULT_KEEP_ALIVE_IDLE_MS,
      retainedAt: labels["agentfabric.retained"] ?? new Date().toISOString(),
      expiresAt: labels["agentfabric.expires"] ?? new Date(Date.now() + DEFAULT_KEEP_ALIVE_IDLE_MS).toISOString(),
    });
  }
  await manager.recover(leases);
}

/**
 * Tracks containers retained after a Run under the `keep-alive` lifecycle
 * and destroys them once their idle timeout expires (spec v1 §1).
 *
 * A subsequent Run can `acquire()` the kept container before the timeout
 * — but only within the *same logical execution context*: runtime +
 * workspace + task (v4 §21/§22). Keep-alive preserves the current task's
 * running environment for a short follow-up; it is not a warm pool, so a
 * retained container is never handed to an unrelated task even on the
 * same runtime and workspace.
 *
 * Leases can be persisted by the caller and re-armed with `recover()`
 * after a restart so idle containers do not leak.
 */
export interface ContainerLease {
  containerId: string;
  containerName?: string;
  runtimeId: ID;
  runtimeKind?: string;
  workspaceId?: ID;
  taskId?: ID;
  runId: ID;
  idleTimeoutMs: number;
  retainedAt: string;
  expiresAt: string;
}

export class ContainerLeaseManager {
  private leases = new Map<string, ContainerLease>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    private ops: ContainerOps,
    private hooks: {
      onDestroyed?: (lease: ContainerLease) => void | Promise<void>;
    } = {}
  ) {}

  /**
   * Lease identity = the logical execution context (v4 §21): runtime +
   * workspace + task. Task A's harness state must never be inherited by
   * task B, so the task id participates in the key.
   */
  private key(runtimeId: ID, workspaceId?: ID, taskId?: ID): string {
    return `${runtimeId}::${workspaceId ?? "-"}::${taskId ?? "-"}`;
  }

  /**
   * Retain a container after a finished Run. Any previous lease for the
   * same (runtime, workspace) is destroyed first — only one kept container
   * per key is meaningful.
   */
  async retain(lease: Omit<ContainerLease, "retainedAt" | "expiresAt"> & { retainedAt?: string }): Promise<ContainerLease> {
    const key = this.key(lease.runtimeId, lease.workspaceId, lease.taskId);
    const previous = this.leases.get(key);
    if (previous && previous.containerId !== lease.containerId) {
      await this.evict(key);
    }
    const retainedAt = lease.retainedAt ?? new Date().toISOString();
    const expiresAt = new Date(Date.parse(retainedAt) + lease.idleTimeoutMs).toISOString();
    const full: ContainerLease = { ...lease, retainedAt, expiresAt };
    this.leases.set(key, full);
    this.arm(key, full);
    return full;
  }

  /**
   * Acquire a kept container for a new Run in the same execution context
   * (runtime + workspace + task), before its idle timeout. Consumes the
   * lease (the container becomes the new Run's execution environment).
   */
  acquire(runtimeId: ID, workspaceId?: ID, taskId?: ID): ContainerLease | undefined {
    const key = this.key(runtimeId, workspaceId, taskId);
    const lease = this.leases.get(key);
    if (!lease) return undefined;
    this.clearTimer(key);
    this.leases.delete(key);
    return lease;
  }

  peek(runtimeId: ID, workspaceId?: ID, taskId?: ID): ContainerLease | undefined {
    return this.leases.get(this.key(runtimeId, workspaceId, taskId));
  }

  list(): ContainerLease[] {
    return [...this.leases.values()];
  }

  /** Destroy a lease's container immediately (e.g. explicit release). */
  async evict(key: string): Promise<void> {
    const lease = this.leases.get(key);
    if (!lease) return;
    this.clearTimer(key);
    this.leases.delete(key);
    try {
      await this.ops.destroy(lease.containerId);
    } finally {
      await this.hooks.onDestroyed?.(lease);
    }
  }

  /** Destroy a specific container's lease by container id, if tracked. */
  async evictContainer(containerId: string): Promise<void> {
    const entry = [...this.leases.entries()].find(([, l]) => l.containerId === containerId);
    if (entry) await this.evict(entry[0]);
  }

  private arm(key: string, lease: ContainerLease): void {
    this.clearTimer(key);
    if (this.stopped) return;
    const remaining = Date.parse(lease.expiresAt) - Date.now();
    const timer = setTimeout(() => {
      void this.evict(key).catch(() => {});
    }, Math.max(0, remaining));
    // Do not keep the Node process alive just to destroy a container.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(key, timer);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  /**
   * Re-arm leases restored from persistent state after a restart.
   * Leases whose timeout already passed are destroyed immediately.
   */
  async recover(leases: ContainerLease[]): Promise<void> {
    for (const lease of leases) {
      const key = this.key(lease.runtimeId, lease.workspaceId, lease.taskId);
      if (Date.parse(lease.expiresAt) <= Date.now()) {
        this.leases.set(key, lease);
        await this.evict(key);
      } else {
        await this.retain(lease);
      }
    }
  }

  /** Clear all timers without destroying containers (server shutdown). */
  stop(): void {
    this.stopped = true;
    for (const key of [...this.timers.keys()]) this.clearTimer(key);
  }
}
