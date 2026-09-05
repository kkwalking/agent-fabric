import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeAdapter,
  ContainerOps,
  ManagedContainerInfo,
  NetworkPolicy,
  ResourceLimits,
  RuntimeCapability,
  RuntimeContext,
  RuntimeResult,
} from "@agentfabric/core";

export interface DockerRunOptions {
  image: string;
  command: string[];
  env?: Record<string, string>;
  workspaceMount?: { hostPath: string; containerPath: string };
  /** Opaque harness-native state mount (v2 §13–§15). */
  nativeStateMount?: { hostPath: string; containerPath: string };
  /** Extra read-only mounts, e.g. generated harness config (v4 §1). */
  extraMounts?: Array<{ hostPath: string; containerPath: string }>;
  resourceLimits?: ResourceLimits;
  networkPolicy?: NetworkPolicy;
  entrypoint?: string[];
  name?: string;
}

export interface DockerRunOutcome {
  containerId?: string;
  containerName?: string;
  exitCode: number | null;
  error?: string;
}

export function dockerBin(): string {
  return process.env.AGENTFABRIC_DOCKER_BIN ?? "docker";
}

export function execDocker(args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(dockerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err);
      resolvePromise({ code: -1, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Keep-alive containers idle on `sleep infinity` until destroyed. */
const KEEP_ALIVE_COMMAND = ["-c", "sleep infinity"];

/**
 * Best-effort termination of harness processes inside a running
 * container (v4 §23): killing the local `docker exec` client alone
 * leaves the remote process running — explicitly pkill it first. The
 * caller's container destroy (`docker rm -f`) remains the hard
 * guarantee; this just stops the process promptly.
 */
export async function killContainerProcesses(container: string, pattern: string): Promise<void> {
  await execDocker(["exec", container, "pkill", "-9", "-f", pattern], 20_000);
}

/**
 * Container operations backed by the Docker CLI: destroys containers and
 * lists keep-alive containers so their idle timers survive restarts.
 */
export function createDockerContainerOps(): ContainerOps {
  return {
    async destroy(containerId: string): Promise<void> {
      await execDocker(["rm", "-f", containerId], 30_000);
    },
    async listKeepAlive(): Promise<ManagedContainerInfo[]> {
      const { code, stdout } = await execDocker(
        ["ps", "-a", "--filter", "label=agentfabric.keepalive=true", "--format", "{{.ID}}\t{{.Names}}\t{{.Labels}}"],
        30_000
      );
      if (code !== 0) return [];
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [containerId, name, labelsRaw] = line.split("\t");
          const labels: Record<string, string> = {};
          for (const pair of (labelsRaw ?? "").split(",")) {
            const idx = pair.indexOf("=");
            if (idx > 0) labels[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
          }
          return { containerId, name, labels };
        });
    },
  };
}

export function commonRunArgs(
  ctx: RuntimeContext,
  opts: Pick<DockerRunOptions, "workspaceMount" | "nativeStateMount" | "extraMounts" | "env" | "resourceLimits" | "networkPolicy">,
  extraLabels: Record<string, string> = {}
): string[] {
  const args: string[] = [];
  if (opts.workspaceMount) {
    // Read-only vs read-write comes from the resolved execution policy
    // (v4 §17) — never from a runtime-specific bypass.
    const readOnly = ctx.policy?.filesystem?.readOnly ?? ctx.runtime.filesystemPolicy?.readOnly;
    const mode = readOnly ? "ro" : "rw";
    args.push("-v", `${opts.workspaceMount.hostPath}:${opts.workspaceMount.containerPath}:${mode}`);
  }
  // The harness's private state is always mounted read-write: the harness
  // must be able to persist its native session store here (v2 §13).
  if (opts.nativeStateMount) {
    args.push("-v", `${opts.nativeStateMount.hostPath}:${opts.nativeStateMount.containerPath}:rw`);
  }
  // AgentFabric-generated harness config is mounted read-only (v4 §1).
  for (const mount of opts.extraMounts ?? []) {
    args.push("-v", `${mount.hostPath}:${mount.containerPath}:ro`);
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  // Resource limits and network mode come from the resolved run
  // configuration (v4 §18/§19) — falls back to explicit options/runtime
  // fields for direct adapter invocations outside RunService.
  const limits = opts.resourceLimits ?? ctx.resourceLimits ?? ctx.runtime.resourceLimits;
  if (limits?.cpu) args.push("--cpus", limits.cpu);
  if (limits?.memory) args.push("--memory", limits.memory);
  if (limits?.pids) args.push("--pids-limit", String(limits.pids));
  const net = opts.networkPolicy ?? ctx.policy?.network ?? ctx.runtime.networkPolicy;
  if (net && net.enabled === false) args.push("--network", "none");
  args.push("--label", `agentfabric.run=${ctx.run.id}`);
  args.push("--label", `agentfabric.task=${ctx.task.id}`);
  for (const [k, v] of Object.entries(extraLabels)) args.push("--label", `${k}=${v}`);
  return args;
}

/**
 * Runs a command inside a Docker container and streams the output as
 * `shell.command` / `shell.output` events. The container is named after
 * the run, resource limits and network policy are applied, and the
 * workspace is mounted read-write (or read-only per policy).
 */
export async function runDockerContainer(
  ctx: RuntimeContext,
  opts: DockerRunOptions
): Promise<DockerRunOutcome> {
  const name = opts.name ?? `af-${ctx.run.id}`;
  const cidFile = join(tmpdir(), `${name}.cid`);
  const args = ["run", "--name", name, "--cidfile", cidFile];
  // Ephemeral runtimes remove the container automatically on exit;
  // keep-alive/persistent runtimes keep it so it can be reused or
  // handed to the lease manager (spec v1 §1).
  if (ctx.lifecycle.mode === "ephemeral") args.push("--rm");

  args.push(...commonRunArgs(ctx, opts));

  args.push(opts.image);
  if (opts.entrypoint) args.push(...opts.entrypoint);
  args.push(...opts.command);

  const display = `docker run ${args.slice(1, -opts.command.length).join(" ")} ${opts.image} ${opts.command.join(" ")}`;
  await ctx.emit("shell.command", { command: display, cwd: ctx.workspacePath ?? ".", container: name });

  return new Promise<DockerRunOutcome>((resolve, reject) => {
    const child = spawn(dockerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";

    const onAbort = () => {
      // Best-effort force-remove the container.
      const killer = spawn(dockerBin(), ["rm", "-f", name], { stdio: "ignore" });
      killer.on("close", () => {
        child.kill("SIGKILL");
      });
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) void ctx.emit("shell.output", { line, stream: "stdout" });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) void ctx.log(line, "warn");
      }
    });

    child.on("error", (err) => {
      ctx.signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", async (code, signal) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (stdoutBuf.trim()) await ctx.emit("shell.output", { line: stdoutBuf, stream: "stdout" });
      if (stderrBuf.trim()) await ctx.log(stderrBuf, "warn");
      let containerId: string | undefined;
      try {
        containerId = (await readFile(cidFile, "utf8")).trim();
      } catch {
        /* no cid file */
      }
      if (containerId) {
        await ctx.emit("shell.output", { line: `container ${containerId} exited (code=${code}, signal=${signal ?? "none"})`, stream: "docker" });
      }
      // Cleanup the cid file; container removal handled by --rm or explicit rm.
      try {
        await rm(cidFile, { force: true });
      } catch {
        /* ignore */
      }
      resolve({ containerId, containerName: name, exitCode: code });
    });
  });
}

/**
 * Keep-alive lifecycle (spec v1 §1 Session Keep-Alive):
 * - reuse: the orchestrator hands back a retained container via
 *   `ctx.reusableContainer`; the command runs inside it via docker exec.
 * - first run: a long-lived container (`sleep infinity`) is created and
 *   labelled for lease recovery, then the command runs inside it.
 * Destruction after the idle timeout is handled by the core lease
 * manager, never by the adapter.
 */
export async function runDockerWithLifecycle(
  ctx: RuntimeContext,
  opts: DockerRunOptions
): Promise<DockerRunOutcome> {
  if (ctx.lifecycle.mode !== "keep-alive") {
    return runDockerContainer(ctx, opts);
  }

  const created = await ensureKeepAliveContainer(ctx, opts);
  if (created.error) {
    return { exitCode: -1, error: created.error };
  }
  const { containerId, containerName } = created;

  // Run the actual command inside the (existing or fresh) container.
  const outcome = await execDockerInContainer(ctx, containerId!, containerName!, opts.command);
  return { containerId, containerName, exitCode: outcome.exitCode, error: outcome.error };
}

/**
 * Returns the keep-alive container for this run: the reusable one from
 * `ctx.reusableContainer` when the orchestrator leased one, otherwise a
 * freshly created long-lived `sleep infinity` container labelled for
 * restart recovery. The container is scoped to the run's logical
 * execution context (runtime + workspace + task, v4 §21) — its name and
 * labels carry the task id so one task's state is never inherited by
 * another.
 */
export async function ensureKeepAliveContainer(
  ctx: RuntimeContext,
  opts: Pick<DockerRunOptions, "image" | "env" | "workspaceMount" | "nativeStateMount" | "extraMounts" | "resourceLimits" | "networkPolicy" | "name">
): Promise<{ containerId?: string; containerName?: string; error?: string }> {
  const defaultName = `af-keep-${ctx.runtime.id}-${ctx.task.id}`;
  const reuseName = ctx.reusableContainer?.name ?? defaultName;
  let containerName = reuseName;
  let containerId = ctx.reusableContainer?.containerId;

  if (!containerId) {
    // Create a long-lived keep-alive container, labelled for recovery.
    containerName = opts.name ?? defaultName;
    const args = [
      "run", "-d",
      "--name", containerName,
      "--entrypoint", "sh",
      ...commonRunArgs(ctx, opts, {
        "agentfabric.keepalive": "true",
        "agentfabric.runtime": ctx.runtime.id,
        "agentfabric.workspace": ctx.workspace?.id ?? "",
        "agentfabric.task": ctx.task.id,
      }),
      opts.image!,
      ...KEEP_ALIVE_COMMAND,
    ];
    await ctx.emit("shell.command", { command: `docker ${args.join(" ")}`, cwd: ctx.workspacePath ?? ".", container: containerName });
    const created = await execDocker(args);
    const id = created.stdout.trim().split("\n")[0];
    if (!id) {
      return { error: `Failed to create keep-alive container: ${created.stderr || "no container id returned"}` };
    }
    containerId = id;
    await ctx.emit("shell.output", { line: `keep-alive container ${containerId} created (${containerName})`, stream: "docker" });
  }
  return { containerId, containerName };
}

export async function execDockerInContainer(
  ctx: RuntimeContext,
  containerId: string,
  containerName: string,
  command: string[]
): Promise<{ exitCode: number | null; error?: string }> {
  await ctx.emit("shell.command", {
    command: `docker exec ${containerName} ${command.join(" ")}`,
    cwd: ctx.workspacePath ?? ".",
    container: containerName,
  });
  // A keep-alive container may have been stopped (host restart etc.);
  // start it before exec.
  const state = await execDocker(["inspect", "-f", "{{.State.Running}}", containerId], 20_000);
  if (state.stdout.trim() === "false") {
    await ctx.emit("shell.output", { line: `keep-alive container ${containerName} is stopped; starting…`, stream: "docker" });
    await execDocker(["start", containerId], 60_000);
  }

  // Killing only the local `docker exec` client leaves the harness
  // process running inside the container (v4 §23). On abort, pkill the
  // in-container process (its binary leads the command) first, then kill
  // the client. The orchestrator destroys the container afterwards when
  // the run was aborted (v4 §24).
  const inContainerBin = command[0];
  const stopContainerProcess = () => {
    if (!inContainerBin) return Promise.resolve();
    return killContainerProcesses(containerName, inContainerBin).catch(() => {
      /* best effort — the container destroy is the hard guarantee */
    });
  };

  return new Promise((resolve) => {
    const child = spawn(dockerBin(), ["exec", containerName, ...command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    const onAbort = () => {
      void stopContainerProcess().finally(() => child.kill("SIGKILL"));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    // Race guard: the abort may predate this child (v4 §23).
    if (ctx.signal.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) void ctx.emit("shell.output", { line, stream: "stdout" });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) void ctx.log(line, "warn");
    });
    child.on("error", (err) => {
      ctx.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode: -1, error: `docker exec failed: ${err.message}` });
    });
    child.on("close", async (code) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (stdoutBuf.trim()) await ctx.emit("shell.output", { line: stdoutBuf, stream: "stdout" });
      if (stderrBuf.trim()) await ctx.log(stderrBuf, "warn");
      resolve({ exitCode: code });
    });
  });
}

/**
 * Resource limits as consumed by the docker backends: the resolved run
 * configuration wins (v4 §19 — task/profile/run-override updates must
 * reach the container); the legacy task/runtime merge remains as a
 * fallback for direct adapter invocations outside RunService.
 */
export function mergedResourceLimits(ctx: RuntimeContext): ResourceLimits | undefined {
  if (ctx.resourceLimits) return ctx.resourceLimits;
  const base = ctx.task.resourceLimits ?? ctx.runtime.resourceLimits;
  const policy = ctx.policy ?? ctx.task.policy;
  if (!policy?.cpu && !policy?.memory) return base;
  return {
    ...(base ?? {}),
    cpu: base?.cpu ?? policy.cpu,
    memory: base?.memory ?? policy.memory,
  };
}

/**
 * Generic Docker runtime: executes a fixed command inside an image and
 * treats the whole container as an "agent" for the MVP. Real agent CLIs
 * (opencode / pi) can be run through this adapter with `containerized`.
 */
export const dockerAdapter: AgentRuntimeAdapter = {
  kind: "docker",
  name: "Docker (generic)",
  capabilities: {
    supportsStreamingEvents: true,
    supportsWorkspace: true,
  } satisfies Partial<RuntimeCapability>,

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const image = ctx.runtime.image ?? process.env.AGENTFABRIC_DEFAULT_IMAGE ?? "node:22-alpine";
    const command = ctx.runtime.command?.length
      ? ctx.runtime.command
      : ["sh", "-c", "echo hello from agent-fabric container; pwd; ls -la"];

    try {
      const outcome = await runDockerWithLifecycle(ctx, {
        image,
        command,
        env: ctx.env,
        workspaceMount: ctx.workspacePath
          ? { hostPath: ctx.workspacePath, containerPath: String(ctx.runtime.config?.mountPath ?? "/workspace") }
          : undefined,
        resourceLimits: mergedResourceLimits(ctx),
        networkPolicy: ctx.policy?.network ?? ctx.runtime.networkPolicy,
      });

      if (ctx.signal.aborted) {
        return { exitCode: outcome.exitCode ?? 1, error: "Container run aborted", containerId: outcome.containerId };
      }
      if (outcome.error) {
        return { exitCode: outcome.exitCode ?? 1, error: outcome.error, containerId: outcome.containerId };
      }
      if (outcome.exitCode !== 0) {
        return { exitCode: outcome.exitCode ?? 1, error: `Container exited with code ${outcome.exitCode}`, containerId: outcome.containerId };
      }
      await ctx.addArtifact({
        name: "container-output.txt",
        kind: "text",
        content: `Container ${outcome.containerId ?? "unknown"} finished with exit code ${outcome.exitCode ?? "?"}`,
      });
      return { exitCode: 0, containerId: outcome.containerId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.emit("runtime.error", { error: msg, hint: "Is the Docker daemon running?" });
      await ctx.log(`Docker error: ${msg}`, "error");
      return { error: `Docker runtime failed: ${msg}` };
    }
  },

  async cleanup(ctx) {
    // Ephemeral only: keep-alive containers are owned by the core lease
    // manager; persistent containers are kept by design (spec v1 §1).
    if (ctx.lifecycle.mode !== "ephemeral") return;
    const name = `af-${ctx.run.id}`;
    try {
      await new Promise<void>((resolve) => {
        const child = spawn(dockerBin(), ["rm", "-f", name], { stdio: "ignore" });
        child.on("close", () => resolve());
      });
    } catch {
      /* best effort */
    }
  },

  describe() {
    return { needsDocker: true, generic: true };
  },
};
