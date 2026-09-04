import type { RuntimeContext, RuntimeResult, RunEvent } from "@agentfabric/core";
import { selectBackend } from "./backend.js";

/**
 * The shared harness execution loop (v2 §8): one code path for local and
 * containerized execution.
 *
 *   Harness Adapter → Execution Backend → (local process | container)
 *
 * The adapter supplies the harness-specific pieces (CLI args builder,
 * JSONL event mapper, native-session extractor); this loop:
 * 1. spawns the command on the selected execution backend,
 * 2. streams every stdout line through the *same* parser regardless of
 *    the backend — harness event parsing, native session id extraction,
 *    usage parsing and error parsing are therefore identical for local
 *    and containerized runs,
 * 3. collects the exit code and container id into the RuntimeResult.
 */
export interface HarnessExecutionOptions {
  /** Local binary (ignored by the containerized backend). */
  bin: string;
  /** Harness CLI arguments (shared by both backends). */
  args: string[];
  /** The instruction appended as the final argument. */
  prompt: string;
  /** Event source label ("opencode" / "pi"). */
  source: string;
  /** Docker image (containerized backend only). */
  image?: string;
  /** Container-side path the workspace is mounted at. */
  workspaceContainerPath?: string;
  /** Maps one raw stdout line to a standard event (null = not JSON). */
  mapLine: (raw: string, runId: string, seq: () => number) => RunEvent | null;
  /** Extracts the harness's opaque native session reference from a line. */
  extractSessionRef: (raw: string) => string | undefined;
  /** Harness version reported on the RuntimeResult, when known. */
  runtimeVersion?: string;
}

export async function runHarnessCommand(ctx: RuntimeContext, opts: HarnessExecutionOptions): Promise<RuntimeResult> {
  const backend = selectBackend(ctx);
  const cwd = ctx.workspacePath ?? ctx.runtime.cwd ?? process.cwd();
  const fullCommand = [opts.bin, ...opts.args, opts.prompt];
  // Display form masks the (possibly multi-line) instruction.
  const display = `${[opts.bin, ...opts.args].join(" ")} <prompt>`;

  await ctx.emit("shell.command", {
    command: display,
    cwd: backend.type === "docker" ? (opts.workspaceContainerPath ?? "/") : cwd,
    backend: backend.type,
    source: opts.source,
  });

  let proc;
  try {
    proc = await backend.spawn(ctx, fullCommand, {
      image: opts.image,
      cwd,
      env: ctx.env,
      workspaceContainerPath: opts.workspaceContainerPath,
      // Explicit in-container command prefix (e.g. ["node", "/pi.js"] for
      // images without a harness entrypoint). Default: the harness image's
      // entrypoint is the harness, so only the args run inside.
      containerCommand: Array.isArray(ctx.runtime.config?.containerCommand)
        ? [...(ctx.runtime.config.containerCommand as string[]), ...opts.args, opts.prompt]
        : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.emit("runtime.error", { error: message, backend: backend.type, source: opts.source });
    return { error: `${opts.source} execution backend failed: ${message}` };
  }

  let seq = 0;
  let nativeSessionRef: string | undefined;
  const consume = (stream: AsyncIterable<string>, stderr: boolean) =>
    (async () => {
      for await (const line of stream) {
        if (!line.trim()) continue;
        if (stderr) {
          void ctx.log(line, "warn");
          continue;
        }
        // Capture the harness's own session id (opaque to AgentFabric).
        if (!nativeSessionRef) nativeSessionRef = opts.extractSessionRef(line);
        const mapped = opts.mapLine(line, ctx.run.id, () => ++seq);
        if (mapped) {
          void ctx.emit(mapped.type, mapped.data, { level: mapped.level, source: opts.source });
        }
      }
    })().catch(() => {
      /* a broken stream must not fail the run */
    });

  // Drain stdout and stderr concurrently so neither pipe can deadlock.
  const drained = Promise.all([consume(proc.stdout, false), consume(proc.stderr, true)]);
  const exit = await proc.exited;
  await drained;

  if (exit.spawnError) {
    return { error: `Failed to start ${opts.source} (${backend.type}): ${exit.spawnError.message}`, nativeSessionRef };
  }
  if (ctx.signal.aborted) {
    return { exitCode: exit.code ?? 1, error: `${opts.source} run aborted`, nativeSessionRef, containerId: exit.containerId };
  }
  if (exit.code !== 0) {
    return {
      exitCode: exit.code ?? 1,
      error: `${opts.source} exited with code ${exit.code}`,
      nativeSessionRef,
      containerId: exit.containerId,
    };
  }
  return {
    exitCode: 0,
    nativeSessionRef,
    containerId: exit.containerId,
    runtimeVersion: opts.runtimeVersion,
  };
}
