import type { RunEvent } from "./types.js";

export type EventListener = (event: RunEvent) => void;

/**
 * In-memory event bus. Runtime adapters publish standard AgentFabric
 * events here; the orchestrator persists them and the API server fans
 * them out to SSE subscribers.
 */
export class EventBus {
  private listeners = new Map<string, Set<EventListener>>();
  private all = new Set<EventListener>();

  onRun(runId: string, listener: EventListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  onAll(listener: EventListener): () => void {
    this.all.add(listener);
    return () => this.all.delete(listener);
  }

  publish(event: RunEvent): void {
    const set = this.listeners.get(event.runId);
    if (set) {
      for (const l of [...set]) l(event);
    }
    for (const l of [...this.all]) l(event);
  }

  removeRun(runId: string): void {
    this.listeners.delete(runId);
  }

  /** Total subscriber count (useful for diagnostics). */
  size(): number {
    let n = this.all.size;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}
