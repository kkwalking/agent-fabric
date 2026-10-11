/**
 * Fire-and-forget event emission.
 *
 * Adapters emit events from stream callbacks (`child.stdout.on("data", …)`,
 * the harness line loop) where nothing awaits the returned promise. A
 * rejected `ctx.emit` there — a full disk failing `store.appendEvent`, a
 * transient fs error — would otherwise become an unhandled rejection, and
 * under Node's default that terminates the whole server process, taking
 * every other in-flight run down with it.
 *
 * The event is genuinely lost when the store cannot write it (the run's
 * own terminal-state write will fail loudly soon after), but the process
 * survives and the failure is reported on stderr instead of vanishing.
 */
export function fireAndForget(what: string, promise: Promise<unknown>): void {
  void promise.catch((err) => {
    console.error(`[agent-fabric] ${what} could not be recorded:`, err instanceof Error ? err.message : err);
  });
}
