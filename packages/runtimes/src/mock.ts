import { createHash } from "node:crypto";
import type { AgentRuntimeAdapter, RuntimeCapability, RuntimeContext, RuntimeResult } from "@agentfabric/core";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Capabilities of the simulated harness: it has native sessions it can
 * resume, and it can produce its own handoff summary — which makes the
 * mock the reference implementation for the Resume/Handoff flows.
 */
export const mockCapabilities: Partial<RuntimeCapability> = {
  supportsNativeSession: true,
  supportsNativeResume: true,
  supportsStreamingEvents: true,
  supportsHandoffGeneration: true,
  supportsWorkspace: true,
  supportsInteractiveExecution: true,
};

/**
 * A simulated agent runtime used for demos, tests and CI.
 *
 * It walks through a realistic agent lifecycle (model calls, tool calls,
 * shell commands, file changes, artifacts) without requiring any model
 * provider or container. Configure through runtime.config:
 *
 *   { steps?: number; delayMs?: number; fail?: boolean; modelCalls?: number }
 */
export const mockAdapter: AgentRuntimeAdapter = {
  kind: "mock",
  name: "Mock Agent",
  capabilities: mockCapabilities,

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const cfg = (ctx.runtime.config ?? {}) as { steps?: number; delayMs?: number; fail?: boolean; modelCalls?: number; echoPrompt?: boolean };
    const steps = cfg.steps ?? 4;
    const delayMs = cfg.delayMs ?? 400;
    const modelCalls = cfg.modelCalls ?? 2;

    // Simulated harness-native session: deterministic per task+prompt so
    // the same task resumes "the same" session on the same harness.
    const resumed = ctx.continuity === "resume" && ctx.runtimeSession?.nativeSessionRef;
    const nativeSessionRef =
      resumed
        ? ctx.runtimeSession!.nativeSessionRef
        : `mock-ses-${createHash("sha1").update(`${ctx.task.id}:${ctx.task.prompt}`).digest("hex").slice(0, 12)}`;

    await ctx.log(`Mock runtime started (steps=${steps}, delay=${delayMs}ms, continuity=${ctx.continuity})`);
    // The instruction for this run: the rendered handoff for continuity
    // runs, otherwise the task's original prompt.
    const instruction = ctx.run.inputInstruction ?? ctx.task.prompt;
    if (resumed) {
      await ctx.emit("runtime.session.resumed", {
        runtime: "mock",
        nativeSessionRef,
        message: `Mock harness resumed its native session ${nativeSessionRef}`,
      });
    } else {
      await ctx.emit("runtime.session.created", {
        runtime: "mock",
        nativeSessionRef,
        message: `Mock harness created native session ${nativeSessionRef}`,
      });
    }

    await ctx.emit("agent.message", { role: "user", content: instruction }, { level: "info" });

    // Profile system instructions (v4 §10) are part of the runtime input,
    // not just stored metadata — surface them so the wiring is observable.
    if (ctx.systemInstructions?.trim()) {
      await ctx.emit("agent.message", {
        role: "system",
        content: ctx.systemInstructions,
        source: "agent-profile",
      }, { level: "info" });
    }

    for (let i = 0; i < modelCalls; i++) {
      await sleep(delayMs, ctx.signal);
      const inTokens = 120 + i * 37;
      const outTokens = 40 + i * 23;
      ctx.recordUsage({
        inputTokens: inTokens,
        outputTokens: outTokens,
        cachedTokens: i === 0 ? 0 : inTokens,
        modelRequests: 1,
        estimatedCost: 0.0002 * (inTokens + outTokens) / 1000,
        byModel: ctx.model
          ? { [ctx.model.name]: { inputTokens: inTokens, outputTokens: outTokens, cachedTokens: 0, requests: 1, cost: 0.0002 * (inTokens + outTokens) / 1000 } }
          : undefined,
      });
      await ctx.emit("model.request", { model: ctx.model?.name, requestId: `req_${i + 1}`, inputTokens: inTokens });
      await ctx.emit("model.response", { model: ctx.model?.name, requestId: `req_${i + 1}`, outputTokens: outTokens });
    }

    await sleep(delayMs, ctx.signal);
    await ctx.emit("tool.started", { tool: "read_file", path: "README.md" });
    await sleep(delayMs / 2, ctx.signal);
    await ctx.emit("tool.completed", { tool: "read_file", path: "README.md" });

    await ctx.emit("shell.command", { command: "ls -la", cwd: ctx.workspacePath ?? "." });
    await ctx.emit("shell.output", { line: "drwxr-xr-x  README.md  src  package.json" });

    await sleep(delayMs, ctx.signal);
    await ctx.emit("file.created", { path: "REPORT.md" });
    await ctx.emit("file.modified", { path: "src/index.ts" });

    await ctx.addArtifact({
      name: "REPORT.md",
      kind: "report",
      mime: "text/markdown",
      content: `# Agent Report\n\nTask: ${ctx.task.title}\n\nStatus: ✅ completed (mock)\n`,
    });
    await ctx.addArtifact({
      name: "final-message.txt",
      kind: "text",
      mime: "text/plain",
      content: instruction,
    });

    await ctx.emit("agent.message", {
      role: "assistant",
      content: `Mock agent finished: ${ctx.task.title}. Next: review REPORT.md in the workspace.`,
    }, { level: "info" });
    await ctx.log("Mock runtime finished");

    if (cfg.fail) {
      return { error: "Mock runtime configured to fail (config.fail = true)", exitCode: 1 };
    }
    return {
      exitCode: 0,
      nativeSessionRef,
      runtimeVersion: "mock-1.0",
      nativeSessionMetadata: { simulated: true, continuity: ctx.continuity },
      // Harness-generated handoff (spec v1 §7): the mock harness produces
      // its own high-quality work summary for the next continuation.
      handoffContent: {
        originalTask: `#${ctx.task.title}: ${ctx.task.prompt}`,
        currentObjective: ctx.task.title,
        progressSummary: `Mock harness completed "${ctx.task.title}" (${ctx.continuity}${resumed ? ", resumed native session" : ""}).`,
        completedWork: ["Read README.md", "Wrote REPORT.md", "Modified src/index.ts"],
        remainingWork: ["Review REPORT.md in the workspace", "Confirm the task is done"],
        importantDecisions: ["Kept existing API surface unchanged"],
        relevantFiles: ["REPORT.md", "src/index.ts"],
        workspaceStatus: ctx.workspace ? `Workspace "${ctx.workspace.name}" at ${ctx.workspacePath}` : "no workspace attached",
        artifacts: ["REPORT.md (report)", "final-message.txt (text)"],
        testBuildStatus: "No test/build signals recorded (mock run).",
        previousRunResult: "Mock run completed successfully (exit 0).",
        notesForNextAgent: "This summary comes from the mock harness itself.",
      },
    };
  },

  async cancel(ctx) {
    await ctx.log("Mock runtime cancelled", "warn");
  },

  describe() {
    return { simulated: true, needsDocker: false, needsModel: false };
  },
};
