import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeAdapter,
  NetworkPolicy,
  ResourceLimits,
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
  exitCode: number | null;
}

function dockerBin(): string {
  return process.env.AGENTFABRIC_DOCKER_BIN ?? "docker";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  // Ephemeral runtimes remove the container automatically on exit; persistent
  // runtimes keep it so the runtime/session survives the run.
  if (ctx.runtime.ephemeral !== false) args.push("--rm");

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
      resolve({ containerId, exitCode: code });
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

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const image = ctx.runtime.image ?? process.env.AGENTFABRIC_DEFAULT_IMAGE ?? "node:22-alpine";
    const command = ctx.runtime.command?.length
      ? ctx.runtime.command
      : ["sh", "-c", "echo hello from agent-fabric container; pwd; ls -la"];

    try {
      const outcome = await runDockerContainer(ctx, {
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
    // Persistent runtimes keep their container after the run (spec §4).
    if (ctx.runtime.ephemeral === false) return;
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
