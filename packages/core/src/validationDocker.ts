/**
 * Disposable validation runtime (v11 hardening §6, Option B).
 *
 * Validation commands are untrusted code, so they never execute on the
 * AgentFabric host. This module is the default `SandboxedStepExecutor`: each
 * validation step runs in its **own** throwaway container that mounts the
 * task workspace and nothing else.
 *
 * Properties the design guarantees:
 *
 * - **Fresh container per step.** The agent's runtime is gone (or never
 *   reachable); validation cannot inherit the agent's process state.
 * - **Allowlisted environment only.** `docker run -e` is passed exactly the
 *   environment `buildValidationEnvironment` produced — never the host's
 *   `process.env`, never a Git credential, never the Docker socket.
 * - **Workspace is the only host path.** One read-write bind mount; no
 *   `-v /var/run/docker.sock`, no home directory, no data dir.
 * - **No credentials by construction.** The Source Credential is materialized
 *   only inside `SourceCredentialService.resolve` for a Git operation; this
 *   module has no access to the secret store at all.
 * - **Destroyed afterwards**, even on timeout or cancellation.
 *
 * The image is a build/test toolchain image, resolved from the task's runtime
 * when it names one, else from `AGENTFABRIC_VALIDATION_IMAGE`, else the
 * documented default.
 */
import { spawn } from "node:child_process";
import type { StepOutcome, SandboxedStepExecutor } from "./validation.js";

/** Default validation image when nothing else is configured. */
export const DEFAULT_VALIDATION_IMAGE = "node:22-alpine";

/** Container-side mount point of the task workspace. */
export const VALIDATION_WORKSPACE_MOUNT = "/workspace";

export function dockerBin(): string {
  return process.env.AGENTFABRIC_DOCKER_BIN ?? "docker";
}

/** Image a validation run uses. */
export function validationImage(configured?: string): string {
  return configured?.trim() || process.env.AGENTFABRIC_VALIDATION_IMAGE || DEFAULT_VALIDATION_IMAGE;
}

/** Runs one `docker` invocation, bounded by `timeoutMs`. */
function execDocker(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(dockerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, stdout, stderr, timedOut });
    };
    child.on("error", (err) => {
      stderr += String(err);
      done(-1);
    });
    child.on("close", (code) => done(code));
  });
}

export interface DockerValidationExecutorOptions {
  /** AgentFabric data directory (used only to namespace container names). */
  dataDir?: string;
  /** Image override; the supervisor passes the task runtime's image. */
  image?: string;
  /** Per-step wall clock budget for the container itself. */
  graceMs?: number;
}

/**
 * Builds the disposable-container validation executor. `image` is the
 * toolchain image the container runs (the task runtime's image when it names
 * one, else the configured default).
 */
export function dockerValidationExecutor(dataDir?: string): (image?: string) => SandboxedStepExecutor {
  return (imageOverride?: string): SandboxedStepExecutor => {
    return async (opts): Promise<StepOutcome> => {
      const image = validationImage(imageOverride);
      const name = `af-validate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const args = [
        "run",
        "--rm",
        "--name",
        name,
        // The workspace is the ONLY host path visible to the command.
        "-v",
        `${opts.cwd}:${VALIDATION_WORKSPACE_MOUNT}:rw`,
        "-w",
        VALIDATION_WORKSPACE_MOUNT,
        // The allowlisted environment, verbatim — no host inheritance.
        ...Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "--label",
        "agentfabric.validation=true",
        image,
        "sh",
        "-c",
        opts.step.command,
      ];

      const timeoutMs = opts.timeoutMs;
      // The step's own timeout kills the container; docker's own client is
      // bounded slightly above it so the container is reaped first.
      const started = Date.now();
      const outcome = await execDocker(args, timeoutMs, opts.signal);
      const elapsed = Date.now() - started;

      const output = `${outcome.stdout}${outcome.stderr}`;
      if (opts.signal?.aborted) {
        await execDocker(["rm", "-f", name], 30_000);
        return { exitCode: null, timedOut: false, output, error: "Validation was cancelled", errorCode: "validation-runtime-failed" };
      }
      if (outcome.timedOut || elapsed >= timeoutMs) {
        // Best effort: `--rm` reaps it, but a killed client can leave it behind.
        await execDocker(["rm", "-f", name], 30_000);
        return { exitCode: null, timedOut: true, output };
      }
      // A docker-level failure (no daemon, missing image) is NOT a failing
      // test: it means validation could not run at all.
      if (
        outcome.code === -1 ||
        /Cannot connect to the Docker daemon|No such image|docker: not found|error during connect|pull access denied/i.test(outcome.stderr)
      ) {
        return {
          exitCode: outcome.code,
          timedOut: false,
          output,
          error: `The isolated validation runtime could not start: ${outcome.stderr.trim().split("\n").slice(-2).join(" ")}`,
          errorCode: "validation-runtime-unavailable",
        };
      }
      return { exitCode: outcome.code, timedOut: false, output };
    };
  };
}
