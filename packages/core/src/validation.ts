/**
 * Validation (v11 §20).
 *
 * Validation runs *after* the agent finished and *before* Git finalization:
 * it is the platform's own check that the produced code is acceptable
 * (typecheck / test / lint / build — whatever the Project or Task defines).
 *
 * A validation failure is its own outcome, never a plain "task failed": the
 * caller records it as `validation-failed` / `validation-timeout` and can
 * retry validation alone, without re-running the agent (v11 §31).
 *
 * Steps run on the AgentFabric host inside the Task's workspace directory —
 * the same durable working copy the runtime had mounted — so a container that
 * has already been destroyed changes nothing about what is validated.
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
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Streamed as `shell.command` / `shell.output` events by the caller. */
  onStepStart?: (step: ValidationStep, command: string) => void | Promise<void>;
  onOutput?: (step: ValidationStep, chunk: string, stream: "stdout" | "stderr") => void | Promise<void>;
  defaultTimeoutMs?: number;
}

export type ValidationRunner = (opts: ValidationRunOptions) => Promise<ValidationRunResult>;

/** How much step output is retained on the record (tail, for the UI). */
const OUTPUT_TAIL_CHARS = 4000;

function runStep(
  step: ValidationStep,
  opts: ValidationRunOptions
): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  const timeoutMs = step.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_VALIDATION_STEP_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    const child = execFile(
      "sh",
      ["-c", step.command],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
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

/** The real runner: `sh -c <command>` per step, in order, in the workspace. */
export function createValidationRunner(): ValidationRunner {
  return async (opts: ValidationRunOptions): Promise<ValidationRunResult> => {
    if (opts.steps.length === 0) return { status: "skipped", steps: [] };
    const results: ValidationStepResult[] = [];
    for (const step of opts.steps) {
      if (opts.signal?.aborted) {
        results.push({ name: step.name, command: step.command, status: "skipped" });
        return { status: "failed", steps: results, error: "Validation was cancelled", errorCode: "validation-failed" };
      }
      await opts.onStepStart?.(step, step.command);
      const startedAt = Date.now();
      const outcome = await runStep(step, opts);
      const durationMs = Date.now() - startedAt;
      const required = step.required ?? true;
      const passed = !outcome.timedOut && outcome.exitCode === 0;
      const status: ValidationStepResult["status"] = outcome.timedOut ? "timeout" : passed ? "passed" : "failed";
      results.push({
        name: step.name,
        command: step.command,
        status,
        exitCode: outcome.exitCode,
        durationMs,
        output: outcome.output.length > OUTPUT_TAIL_CHARS ? outcome.output.slice(-OUTPUT_TAIL_CHARS) : outcome.output,
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
  };
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
