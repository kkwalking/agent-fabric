import type { AgentRuntimeAdapter, RuntimeContext, RuntimeResult } from "@agentfabric/core";

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

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const cfg = (ctx.runtime.config ?? {}) as { steps?: number; delayMs?: number; fail?: boolean; modelCalls?: number; echoPrompt?: boolean };
    const steps = cfg.steps ?? 4;
    const delayMs = cfg.delayMs ?? 400;
    const modelCalls = cfg.modelCalls ?? 2;

    await ctx.log(`Mock runtime started (steps=${steps}, delay=${delayMs}ms)`);
    await ctx.emit("agent.message", { role: "user", content: ctx.task.prompt }, { level: "info" });

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
      content: ctx.task.prompt,
    });

    await ctx.emit("agent.message", { role: "assistant", content: `Mock agent finished: ${ctx.task.title}` }, { level: "info" });
    await ctx.log("Mock runtime finished");

    if (cfg.fail) {
      return { error: "Mock runtime configured to fail (config.fail = true)", exitCode: 1 };
    }
    return { exitCode: 0 };
  },

  async cancel(ctx) {
    await ctx.log("Mock runtime cancelled", "warn");
  },

  describe() {
    return { simulated: true, needsDocker: false, needsModel: false };
  },
};
