import type { ID, RuntimeLifecycle, RuntimeLifecycleMode } from "./types.js";

/** Default idle window for keep-alive containers: 10 minutes. */
export const DEFAULT_KEEP_ALIVE_IDLE_MS = 10 * 60 * 1000;

/**
 * Materializes the lifecycle a Task will run under, **at creation time**.
 *
 * This is the only place a lifecycle is ever derived. The result is written
 * onto the Task, and every Run copies it verbatim from there — so no read
 * path ever resolves, defaults or repairs the value. A caller that passes
 * nothing gets `ephemeral`, and that decision is then frozen in the record
 * like any explicit choice.
 */
export function taskLifecycle(declared?: RuntimeLifecycle): RuntimeLifecycle {
  const mode: RuntimeLifecycleMode = declared?.mode ?? "ephemeral";
  return {
    mode,
    idleTimeoutMs: declared?.idleTimeoutMs ?? DEFAULT_KEEP_ALIVE_IDLE_MS,
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
 * A listed keep-alive container whose retention window the caller resolved
 * from the durable Run record. The labels only ever carry identity (runtime /
 * workspace / task) — correct forever, because a keep-alive container is
 * scoped to one task (v4 §21) — while the *window* cannot live in a label:
 * labels are written at creation and immutable, but the container is
 * retained again by every later run that reuses it.
 */
export interface RecoverableContainer extends ManagedContainerInfo {
  /** The newest Run that used this container; its window is the truth. */
  runId: ID;
  idleTimeoutMs: number;
  retainedAt: string;
  expiresAt: string;
}

/**
 * Re-arms keep-alive leases after a restart: containers whose idle
 * timeout already passed are destroyed, the rest get timers for their
 * *remaining* window so idle containers never leak — and are never
 * granted more time than they actually have.
 */
export async function recoverKeepAliveContainers(manager: ContainerLeaseManager, containers: RecoverableContainer[]): Promise<void> {
  const leases: ContainerLease[] = containers.map((info) => {
    const labels = info.labels ?? {};
    return {
      containerId: info.containerId,
      containerName: info.name,
      runtimeId: labels["agentfabric.runtime"] ?? "unknown",
      workspaceId: labels["agentfabric.workspace"] || undefined,
      taskId: labels["agentfabric.task"] || undefined,
      runId: info.runId,
      idleTimeoutMs: info.idleTimeoutMs,
      retainedAt: info.retainedAt,
      expiresAt: info.expiresAt,
    };
  });
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
