/**
 * Validation (v11 §20, hardening §5/§6).
 *
 * Validation runs *after* the agent finished and *before* Git finalization:
 * it is the platform's own check that the produced code is acceptable
 * (typecheck / test / lint / build — whatever the Project or Task defines).
 *
 * A validation failure is its own outcome, never a plain "task failed": the
 * caller records it as `validation-failed` / `validation-timeout` and can
 * retry validation alone, without re-running the agent (v11 §31).
 *
 * **Validation commands are untrusted code** (v11 hardening §5). `npm test`,
 * `pytest`, `make test` all execute whatever the repository contains, so a
 * validation step is never run as a host shell command. The production path
 * is therefore `runSandboxedValidation`, which runs each step through an
 * isolated-runtime executor supplied by the supervisor (it owns runtime
 * lifecycle), with:
 *
 * - an **allowlisted** environment — no `process.env` inheritance (§6.1),
 * - no Git Source Credential (it is not a validation secret, §6.2),
 * - no Docker socket, no host filesystem beyond the workspace mount.
 *
 * `runHostValidation` remains for non-project tasks and local development;
 * it is never selected for a Project Coding Task.
 */
import { execFile } from "node:child_process";
import type { ValidationStep, ValidationStepResult } from "./types.js";

/** Default per-step budget. */
export const DEFAULT_VALIDATION_STEP_TIMEOUT_MS = 10 * 60 * 1000;

export interface ValidationRunResult {
  status: "passed" | "failed" | "timeout" | "skipped";
  steps: ValidationStepResult[];
  error?: string;
  errorCode?: "validation-failed" | "validation-timeout";
}

export interface ValidationRunOptions {
  /** Workspace directory the steps run in. */
  cwd: string;
  steps: ValidationStep[];
  /**
   * The complete environment the commands receive. Merged over
   * `VALIDATION_BASE_ENV`; the host's `process.env` is never involved
   * (v11 hardening §6.1/AC-7).
   */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Streamed as `shell.command` / `shell.output` events by the caller. */
  onStepStart?: (step: ValidationStep, command: string) => void | Promise<void>;
  onOutput?: (step: ValidationStep, chunk: string, stream: "stdout" | "stderr") => void | Promise<void>;
  defaultTimeoutMs?: number;
}

/**
 * The outcome of running one step somewhere. `error` means the *execution
 * environment* failed (image missing, runtime unavailable) — distinct from a
 * step that ran and exited non-zero.
 */
export interface StepOutcome {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  error?: string;
  /** Error code to report when `error` is set (defaults to validation-failed). */
  errorCode?: "validation-failed" | "validation-timeout" | "validation-runtime-failed" | "validation-runtime-unavailable";
  /** Container the step ran in, when it ran in one (isolation evidence). */
  containerId?: string;
}

/** Runs one validation command in the caller's isolated runtime. */
export type SandboxedStepExecutor = (opts: {
  step: ValidationStep;
  /** Workspace directory on the host (the runtime mounts it). */
  cwd: string;
  /** Allowlisted environment the command must receive. */
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void | Promise<void>;
}) => Promise<StepOutcome>;

export type ValidationRunner = (opts: ValidationRunOptions) => Promise<ValidationRunResult>;

/** How much step output is retained on the record (tail, for the UI). */
const OUTPUT_TAIL_CHARS = 4000;

/**
 * Environment variables every validation command may rely on regardless of
 * the host's environment. Deliberately tiny: enough for a shell to work and
 * for tools to find a writable temp directory, nothing that could carry a
 * host secret.
 */
export const VALIDATION_BASE_ENV: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "dumb",
  CI: "1",
  AGENTFABRIC_VALIDATION: "1",
};

/**
 * Builds the allowlisted environment for a validation run (v11 hardening
 * §6.1/§6.2). Anything not named here simply does not exist for the command:
 * there is no `...process.env` fallback anywhere on this path.
 */
export function buildValidationEnvironment(extra?: Record<string, string>): Record<string, string> {
  return { ...VALIDATION_BASE_ENV, ...(extra ?? {}) };
}

/**
 * Drives the steps through one executor, in order, and folds their outcomes.
 * The shared shape of both runners — only *where* a step runs differs.
 */
async function runSteps(
  opts: ValidationRunOptions,
  runOne: (step: ValidationStep, timeoutMs: number) => Promise<StepOutcome>
): Promise<ValidationRunResult> {
  if (opts.steps.length === 0) return { status: "skipped", steps: [] };
  const results: ValidationStepResult[] = [];
  for (const step of opts.steps) {
    if (opts.signal?.aborted) {
      results.push({ name: step.name, command: step.command, status: "skipped" });
      return { status: "failed", steps: results, error: "Validation was cancelled", errorCode: "validation-failed" };
    }
    await opts.onStepStart?.(step, step.command);
    const startedAt = Date.now();
    const timeoutMs = step.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_VALIDATION_STEP_TIMEOUT_MS;
    const outcome = await runOne(step, timeoutMs);
    const durationMs = Date.now() - startedAt;
    const tail = outcome.output.length > OUTPUT_TAIL_CHARS ? outcome.output.slice(-OUTPUT_TAIL_CHARS) : outcome.output;
    if (outcome.error) {
      // The sandbox itself failed (image missing, runtime unavailable). That
      // is not a failing test — it is validation that could not run, and it
      // is reported with its own code so the user retries the right thing.
      results.push({
        name: step.name,
        command: step.command,
        status: "failed",
        exitCode: outcome.exitCode,
        durationMs,
        output: tail,
      });
      return {
        status: "failed",
        steps: results,
        error: outcome.error,
        errorCode: outcome.errorCode === "validation-timeout" ? "validation-timeout" : "validation-failed",
      };
    }
    const required = step.required ?? true;
    const passed = !outcome.timedOut && outcome.exitCode === 0;
    const status: ValidationStepResult["status"] = outcome.timedOut ? "timeout" : passed ? "passed" : "failed";
    results.push({
      name: step.name,
      command: step.command,
      status,
      exitCode: outcome.exitCode,
      durationMs,
      output: tail,
    });
    if (!passed && required) {
      return {
        status: outcome.timedOut ? "timeout" : "failed",
        steps: results,
        error: outcome.timedOut
          ? `Validation step "${step.name}" timed out`
          : `Validation step "${step.name}" failed (exit code ${outcome.exitCode ?? "?"})`,
        errorCode: outcome.timedOut ? "validation-timeout" : "validation-failed",
      };
    }
  }
  return { status: "passed", steps: results };
}

/**
 * The production runner for a Project Coding Task (v11 hardening §6): every
 * step executes inside an isolated runtime through `execute`.
 */
export function runSandboxedValidation(opts: ValidationRunOptions, execute: SandboxedStepExecutor): Promise<ValidationRunResult> {
  const env = buildValidationEnvironment(opts.env);
  return runSteps(opts, (step, timeoutMs) =>
    execute({
      step,
      cwd: opts.cwd,
      env,
      timeoutMs,
      signal: opts.signal,
      onOutput: (chunk, stream) => opts.onOutput?.(step, chunk, stream),
    })
  );
}

/**
 * Runs one step as a host shell command with an allowlisted environment.
 * Kept for non-project tasks and local development; **never** used for a
 * Project Coding Task (v11 hardening §5).
 */
export function runHostValidation(opts: ValidationRunOptions): Promise<ValidationRunResult> {
  const env = buildValidationEnvironment(opts.env);
  return runSteps(opts, (step, timeoutMs) => runStepOnHost(step, { ...opts, env }, timeoutMs));
}

function runStepOnHost(step: ValidationStep, opts: ValidationRunOptions, timeoutMs: number): Promise<StepOutcome> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "sh",
      ["-c", step.command],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const output = `${String(stdout)}${String(stderr)}`;
        if (err) {
          const killed = Boolean((err as { killed?: boolean }).killed);
          resolvePromise({ exitCode: killed ? null : (err as { code?: number }).code ?? 1, timedOut: killed, output });
          return;
        }
        resolvePromise({ exitCode: 0, timedOut: false, output });
      }
    );
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", () => opts.signal?.removeEventListener("abort", onAbort));
    // Stream output as it arrives so the task view is live.
    child.stdout?.on("data", (chunk: Buffer) => void opts.onOutput?.(step, chunk.toString(), "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => void opts.onOutput?.(step, chunk.toString(), "stderr"));
  });
}

/**
 * The host runner behind the `ValidationRunner` seam (non-project tasks and
 * local development only).
 */
export function createValidationRunner(): ValidationRunner {
  return (opts) => runHostValidation(opts);
}

/** Resolves the effective validation config: Task override wins, else Project. */
export function resolveValidationConfig(
  taskConfig: { enabled?: boolean; steps: ValidationStep[] } | undefined,
  projectConfig: { enabled?: boolean; steps: ValidationStep[] } | undefined
): ValidationStep[] {
  const chosen = taskConfig ?? projectConfig;
  if (!chosen) return [];
  if (chosen.enabled === false) return [];
  return chosen.steps ?? [];
}
