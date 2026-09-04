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

function dockerBin(): string {
  return process.env.AGENTFABRIC_DOCKER_BIN ?? "docker";
}

function execDocker(args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

function commonRunArgs(
  ctx: RuntimeContext,
  opts: DockerRunOptions,
  extraLabels: Record<string, string> = {}
): string[] {
  const args: string[] = [];
  if (opts.workspaceMount) {
    const mode = ctx.runtime.filesystemPolicy?.readOnly ? "ro" : "rw";
    args.push("-v", `${opts.workspaceMount.hostPath}:${opts.workspaceMount.containerPath}:${mode}`);
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  const limits = opts.resourceLimits ?? ctx.runtime.resourceLimits;
  if (limits?.cpu) args.push("--cpus", limits.cpu);
  if (limits?.memory) args.push("--memory", limits.memory);
  if (limits?.pids) args.push("--pids-limit", String(limits.pids));
  const net = opts.networkPolicy ?? ctx.runtime.networkPolicy;
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

  const reuseName = ctx.reusableContainer?.name ?? `af-keep-${ctx.runtime.id}`;
  let containerName = reuseName;
  let containerId = ctx.reusableContainer?.containerId;

  if (!containerId) {
    // Create a long-lived keep-alive container, labelled for recovery.
    containerName = opts.name ?? `af-keep-${ctx.runtime.id}`;
    const wsLabel = ctx.workspace?.id ?? "";
    const args = [
      "run", "-d",
      "--name", containerName,
      "--entrypoint", "sh",
      ...commonRunArgs(ctx, opts, {
        "agentfabric.keepalive": "true",
        "agentfabric.runtime": ctx.runtime.id,
        "agentfabric.workspace": wsLabel,
      }),
      opts.image,
      ...KEEP_ALIVE_COMMAND,
    ];
    await ctx.emit("shell.command", { command: `docker ${args.join(" ")}`, cwd: ctx.workspacePath ?? ".", container: containerName });
    const created = await execDocker(args);
    const id = created.stdout.trim().split("\n")[0];
    if (!id) {
      return { exitCode: created.code ?? -1, error: `Failed to create keep-alive container: ${created.stderr || "no container id returned"}` };
    }
    containerId = id;
    await ctx.emit("shell.output", { line: `keep-alive container ${containerId} created (${containerName})`, stream: "docker" });
  }

  // Run the actual command inside the (existing or fresh) container.
  const outcome = await execDockerInContainer(ctx, containerId, containerName, opts.command);
  return { containerId, containerName, exitCode: outcome.exitCode, error: outcome.error };
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

  return new Promise((resolve) => {
    const child = spawn(dockerBin(), ["exec", containerName, ...command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    const onAbort = () => child.kill("SIGKILL");
    ctx.signal.addEventListener("abort", onAbort, { once: true });

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
 * Merges resource limits from the task, its execution policy and the
 * runtime (in that order of precedence). Policy cpu/memory act as
 * defaults that can be overridden by task.resourceLimits.
 */
export function mergedResourceLimits(ctx: RuntimeContext): ResourceLimits | undefined {
  const base = ctx.task.resourceLimits ?? ctx.runtime.resourceLimits;
  const policy = ctx.task.policy;
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
        networkPolicy: ctx.task.policy?.network ?? ctx.runtime.networkPolicy,
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
