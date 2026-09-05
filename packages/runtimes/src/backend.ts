import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  BackendExit,
  BackendProcess,
  BackendSpawnOptions,
  ExecutionBackend,
  RuntimeContext,
} from "@agentfabric/core";
import {
  commonRunArgs,
  dockerBin,
  ensureKeepAliveContainer,
  killContainerProcesses,
  mergedResourceLimits,
} from "./docker.js";

/**
 * Execution backends (v2 §7/§8): the carrier *under* a harness adapter.
 *
 *   Harness Adapter → Execution Backend → (local process | Docker container)
 *
 * A backend is a dumb pipe: it streams raw stdout/stderr lines to the
 * adapter and reports the exit code. It never flattens the harness's
 * structured output into shell logs — protocol parsing, native session
 * extraction and usage parsing all stay in the harness adapter, which is
 * therefore identical for local and containerized execution.
 */

/** Wraps a readable stream into an async iterator of lines. */
function streamLines(stream: Readable | null): AsyncIterable<string> {
  if (!stream) {
    return {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<string>> {
          return { value: undefined as never, done: true };
        },
      }),
    };
  }
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  const rl = createInterface({ input: stream });
  rl.on("line", (line: string) => {
    queue.push(line);
    notify?.();
    notify = null;
  });
  rl.on("close", () => {
    done = true;
    notify?.();
    notify = null;
  });
  return {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<string>> {
        for (;;) {
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          if (done) return { value: undefined as never, done: true };
          await new Promise<void>((resolvePromise) => (notify = resolvePromise));
        }
      },
    }),
  };
}

/** Resolves when the child exits; never rejects (spawn errors become `spawnError`). */
function childExited(child: ReturnType<typeof spawn>): Promise<BackendExit> {
  return new Promise((resolvePromise) => {
    child.once("error", (err: Error) => resolvePromise({ code: null, spawnError: err }));
    child.once("close", (code: number | null) => resolvePromise({ code }));
  });
}

/* ------------------------------------------------------------------ */
/* Local backend                                                       */
/* ------------------------------------------------------------------ */

/**
 * Spawns the harness CLI as a local process. `command[0]` is the binary
 * (resolved from PATH or overridden via AGENTFABRIC_*_BIN by the adapter).
 */
export const localExecutionBackend: ExecutionBackend = {
  type: "local",

  async spawn(ctx: RuntimeContext, command: string[], opts: BackendSpawnOptions = {}): Promise<BackendProcess> {
    const [bin, ...args] = command;
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = childExited(child);
    const onAbort = () => child.kill("SIGTERM");
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    // Race guard: the run may have been aborted while this spawn was being
    // prepared — the listener above would never fire.
    if (ctx.signal.aborted) onAbort();
    exited.then(() => ctx.signal.removeEventListener("abort", onAbort));
    return {
      stdout: streamLines(child.stdout),
      stderr: streamLines(child.stderr),
      exited,
      kill: () => child.kill("SIGKILL"),
    };
  },
};

/* ------------------------------------------------------------------ */
/* Docker backend                                                      */
/* ------------------------------------------------------------------ */

function dockerWorkspaceMount(ctx: RuntimeContext, opts: BackendSpawnOptions) {
  return ctx.workspacePath && opts.workspaceContainerPath
    ? { hostPath: ctx.workspacePath, containerPath: opts.workspaceContainerPath }
    : undefined;
}

function dockerNativeStateMount(ctx: RuntimeContext) {
  return ctx.nativeState
    ? { hostPath: ctx.nativeState.path, containerPath: ctx.nativeState.mountPath }
    : undefined;
}

/**
 * Runs the harness command inside a Docker container while keeping its
 * stdout/stderr as raw line streams for the adapter to parse — the
 * container never downgrades structured harness output (v2 §7).
 *
 * The workspace *and* the runtime's opaque native-state directory are
 * bind-mounted, so ephemeral containers lose neither the work nor the
 * harness's own session store (v2 §15).
 */
export const dockerExecutionBackend: ExecutionBackend = {
  type: "docker",

  async spawn(ctx: RuntimeContext, command: string[], opts: BackendSpawnOptions = {}): Promise<BackendProcess> {
    const image = opts.image;
    if (!image) throw new Error("Containerized runtime has no Docker image configured");

    const mounts = {
      env: opts.env,
      workspaceMount: dockerWorkspaceMount(ctx, opts),
      nativeStateMount: dockerNativeStateMount(ctx),
      extraMounts: opts.extraMounts,
      resourceLimits: mergedResourceLimits(ctx),
      // Network mode comes from the resolved execution policy (v4 §18);
      // the runtime field remains a fallback for direct invocations.
      networkPolicy: ctx.policy?.network ?? ctx.runtime.networkPolicy,
    };
    const workdir = mounts.workspaceMount?.containerPath ?? "/";

    /* ---- keep-alive: exec inside the leased/created container ---- */
    if (ctx.lifecycle.mode === "keep-alive") {
      const kept = await ensureKeepAliveContainer(ctx, { ...mounts, image });
      if (kept.error || !kept.containerId || !kept.containerName) {
        throw new Error(kept.error ?? "Failed to prepare keep-alive container");
      }
      const args = ["exec", "-w", workdir];
      for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
      args.push(kept.containerName, ...(opts.containerCommand ?? command.slice(1)));
      const child = spawn(dockerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
      const exited = childExited(child).then((exit) => ({ ...exit, containerId: kept.containerId }));
      // Killing the local docker CLI is not enough: the harness process
      // keeps running inside the container (v4 §23) — pkill it there.
      // Harness images expose the harness binary as the entrypoint, so
      // the in-container process matches the local binary's basename
      // (unless an explicit containerCommand leads with something else).
      const inContainerBin = opts.containerCommand?.[0] ?? basename(command[0]);
      const stopHarnessProcess = () => {
        if (!inContainerBin) return Promise.resolve();
        return killContainerProcesses(kept.containerName!, inContainerBin).catch(() => {
          /* best effort — the orchestrator destroys the container (v4 §24) */
        });
      };
      const onAbort = () => {
        void stopHarnessProcess().finally(() => child.kill("SIGKILL"));
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      // Race guard: abort may have landed while the keep-alive container
      // was being prepared, before this exec child existed.
      if (ctx.signal.aborted) onAbort();
      exited.then(() => ctx.signal.removeEventListener("abort", onAbort));
      return {
        stdout: streamLines(child.stdout),
        stderr: streamLines(child.stderr),
        exited,
        kill: () => {
          void stopHarnessProcess().finally(() => child.kill("SIGKILL"));
        },
      };
    }

    /* ---- ephemeral / persistent: one container per run ---- */
    const name = `af-${ctx.run.id}`;
    const cidFile = join(tmpdir(), `${name}.cid`);
    const args = ["run", "--name", name, "--cidfile", cidFile, "-w", workdir];
    // Ephemeral runs remove the container automatically on exit; the
    // harness state survives in the mounted native-state directory.
    if (ctx.lifecycle.mode === "ephemeral") args.push("--rm");
    args.push(...commonRunArgs(ctx, mounts));
    // Harness images expose the harness as their entrypoint, so the local
    // binary name is dropped; `containerCommand` overrides explicitly.
    args.push(image, ...(opts.containerCommand ?? command.slice(1)));

    const child = spawn(dockerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const exited = childExited(child).then(async (exit) => {
      // Recover the container id from the cidfile after exit (the file
      // disappears once an --rm container is reaped).
      let containerId: string | undefined;
      try {
        containerId = (await readFile(cidFile, "utf8")).trim() || undefined;
      } catch {
        /* no cid file */
      }
      try {
        await rm(cidFile, { force: true });
      } catch {
        /* ignore */
      }
      return { ...exit, containerId };
    });
    const onAbort = () => {
      // Best-effort force-remove the container, then kill the CLI.
      const killer = spawn(dockerBin(), ["rm", "-f", name], { stdio: "ignore" });
      killer.on("close", () => child.kill("SIGKILL"));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    // Race guard: see the local backend.
    if (ctx.signal.aborted) onAbort();
    exited.then(() => ctx.signal.removeEventListener("abort", onAbort));

    return {
      stdout: streamLines(child.stdout),
      stderr: streamLines(child.stderr),
      exited,
      kill: () => child.kill("SIGKILL"),
    };
  },
};

/** Picks the execution backend for a run (docker when containerized). */
export function selectBackend(ctx: RuntimeContext): ExecutionBackend {
  return ctx.runtime.containerized ? dockerExecutionBackend : localExecutionBackend;
}
