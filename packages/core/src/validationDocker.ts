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

/** The buffered result of one `docker` invocation. */
interface DockerCallResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The process surface `execDocker` needs; `node:child_process` provides it. */
export interface DockerChildProcess {
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * The one process seam of this module: it launches `docker` and returns the
 * pipes `execDocker` reads. The default is `node:child_process.spawn`; tests
 * inject a fake to assert the constructed argv/env without a real daemon.
 */
export type DockerSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: ["ignore", "pipe", "pipe"] }
) => DockerChildProcess;

/** Runs one `docker` invocation through `spawnImpl`, bounded by `timeoutMs`. */
function execDocker(spawnImpl: DockerSpawn, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<DockerCallResult> {
  return new Promise((resolvePromise) => {
    const child = spawnImpl(dockerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
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
  /**
   * Process launcher. Defaults to `node:child_process.spawn`; tests inject a
   * fake so the constructed argv/env can be asserted without a Docker daemon.
   */
  spawnImpl?: DockerSpawn;
}

/**
 * Builds the disposable-container validation executor. `image` is the
 * toolchain image the container runs (the task runtime's image when it names
 * one, else the configured default).
 *
 * `dataDirOrOptions` keeps the original `dockerValidationExecutor(dataDir)`
 * call shape; the options form exists so a test can inject `spawnImpl`.
 */
export function dockerValidationExecutor(
  dataDirOrOptions?: string | DockerValidationExecutorOptions
): (image?: string) => SandboxedStepExecutor {
  const options: DockerValidationExecutorOptions =
    typeof dataDirOrOptions === "string" ? { dataDir: dataDirOrOptions } : (dataDirOrOptions ?? {});
  const spawnImpl = options.spawnImpl ?? spawn;
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
        // Egress policy: validation commands are untrusted code, so they run
        // under the Task's resolved network policy — the same rule the agent
        // container follows (runtimes/docker.ts). `enabled === false` means
        // no network at all, never docker's default bridge.
        ...(opts.network?.enabled === false ? ["--network", "none"] : []),
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
      const outcome = await execDocker(spawnImpl, args, timeoutMs, opts.signal);

      const output = `${outcome.stdout}${outcome.stderr}`;
      if (opts.signal?.aborted) {
        await execDocker(spawnImpl, ["rm", "-f", name], 30_000);
        return { exitCode: null, timedOut: false, output, error: "Validation was cancelled", errorCode: "validation-runtime-failed" };
      }
      // `timedOut` is set by the very timer that killed the container, so it
      // is the only honest signal. Comparing wall-clock elapsed time against
      // the budget instead would misreport a step that *finished in time* as
      // a timeout whenever the measurement lands on the boundary (Date.now()
      // is millisecond-granular), discarding a passing result.
      if (outcome.timedOut) {
        // Best effort: `--rm` reaps it, but a killed client can leave it behind.
        await execDocker(spawnImpl, ["rm", "-f", name], 30_000);
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
