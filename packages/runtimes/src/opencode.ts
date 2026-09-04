import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentRuntimeAdapter, RuntimeCapability, RuntimeContext, RuntimeResult, RunEvent } from "@agentfabric/core";
import { runDockerWithLifecycle, mergedResourceLimits } from "./docker.js";

interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  [key: string]: unknown;
}

function opencodeBin(): string {
  return process.env.AGENTFABRIC_OPENCODE_BIN ?? "opencode";
}

/**
 * OpenCode harness capabilities (spec v1 §17): it owns native sessions
 * and can resume them, streams events, and works inside a workspace.
 * It does not generate handoff summaries itself — AgentFabric-assisted
 * handoff covers that case.
 */
export const opencodeCapabilities: Partial<RuntimeCapability> = {
  supportsNativeSession: true,
  supportsNativeResume: true,
  supportsStreamingEvents: true,
  supportsHandoffGeneration: false,
  supportsWorkspace: true,
  supportsInteractiveExecution: false,
};

/**
 * Maps an opencode JSONL event to an AgentFabric standard event.
 * Unknown event types degrade to log lines so nothing is lost.
 */
export function mapOpenCodeEvent(raw: string, runId: string, seq: () => number): RunEvent | null {
  let evt: OpenCodeEvent;
  try {
    evt = JSON.parse(raw) as OpenCodeEvent;
  } catch {
    return null;
  }
  const type = evt.type ?? "unknown";
  const timestamp = new Date(evt.timestamp ?? Date.now()).toISOString();
  const data = { ...(evt as Record<string, unknown>) };
  delete data.type;

  const base = {
    id: `evt_${runId}_${seq()}`,
    runId,
    seq: seq(),
    timestamp,
    data,
  };

  if (type.startsWith("message")) {
    const content =
      (evt as Record<string, any>).message?.text ??
      (evt as Record<string, any>).part?.text ??
      (evt as Record<string, any>).text ??
      "";
    const role = (evt as Record<string, any>).message?.role ?? "assistant";
    return {
      ...base,
      type: "agent.message",
      level: "info",
      source: "opencode",
      data: { content, role, raw: data },
    };
  }
  if (type === "tool.started" || type === "tool.completed") {
    const tool = (evt as Record<string, any>).tool?.name ?? (evt as Record<string, any>).tool ?? "unknown";
    return {
      ...base,
      type: type === "tool.started" ? "tool.started" : "tool.completed",
      level: "info",
      source: "opencode",
      data: { tool, ...data },
    };
  }
  if (type.startsWith("shell")) {
    const command = (evt as Record<string, any>).command?.command ?? (evt as Record<string, any>).command;
    const state = (evt as Record<string, any>).state;
    if (type === "shell.started" || state === "running") {
      return { ...base, type: "shell.command", level: "info", source: "opencode", data: { command, ...data } };
    }
    return { ...base, type: "shell.output", level: "info", source: "opencode", data: { line: command ?? JSON.stringify(data), ...data } };
  }
  if (type === "error") {
    return { ...base, type: "runtime.error", level: "error", source: "opencode", data };
  }
  if (type.startsWith("permission")) {
    return { ...base, type: "log", level: "warn", source: "opencode", data: { line: `permission: ${JSON.stringify(data)}` } };
  }
  return { ...base, type: "log", level: "debug", source: "opencode", data: { line: raw } };
}

function buildArgs(ctx: RuntimeContext): string[] {
  const args = ["run", "--format", "json"];
  const model = ctx.model ? `${ctx.provider?.name ?? "provider"}/${ctx.model.name}` : undefined;
  if (model) args.push("-m", model);
  if (ctx.runtime.config?.agent) args.push("--agent", String(ctx.runtime.config.agent));
  if (ctx.runtime.config?.variant) args.push("--variant", String(ctx.runtime.config.variant));
  if (ctx.task.policy?.autoApprove) args.push("--auto");
  // Native resume: pass the harness's own session reference (spec v1 §3).
  if (ctx.runtimeSession?.nativeSessionRef) args.push("--session", ctx.runtimeSession.nativeSessionRef);
  if (ctx.runtime.config?.logLevel) args.push("--log-level", String(ctx.runtime.config.logLevel));
  return args;
}

/**
 * OpenCode Runtime adapter.
 *
 * Default: spawns the local `opencode run --format json` CLI, streaming
 * its JSONL events as AgentFabric standard events. When a native session
 * reference was stored for this harness it is resumed via `--session`.
 *
 * `containerized: true`: runs `opencode run` inside a Docker image via the
 * shared Docker helper (runtime.image, e.g. `ghcr.io/sst/opencode`).
 */
export const opencodeAdapter: AgentRuntimeAdapter = {
  kind: "opencode",
  name: "OpenCode",
  capabilities: opencodeCapabilities,

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const args = buildArgs(ctx);
    // This run's instruction: the rendered handoff for continuity runs,
    // otherwise the task's original prompt (spec v1 §20 Inject Handoff).
    const prompt = ctx.run.inputInstruction ?? ctx.task.prompt;
    const cwd = ctx.workspacePath ?? ctx.runtime.cwd ?? process.cwd();

    if (ctx.runtime.containerized) {
      const image = ctx.runtime.image ?? "ghcr.io/sst/opencode";
      const outcome = await runDockerWithLifecycle(ctx, {
        image,
        command: [...args, prompt],
        env: ctx.env,
        workspaceMount: ctx.workspacePath ? { hostPath: ctx.workspacePath, containerPath: "/workspace" } : undefined,
        resourceLimits: mergedResourceLimits(ctx),
        networkPolicy: ctx.task.policy?.network ?? ctx.runtime.networkPolicy,
      });
      if (outcome.error) return { exitCode: outcome.exitCode ?? 1, error: outcome.error, containerId: outcome.containerId };
      return {
        exitCode: outcome.exitCode === 0 ? 0 : outcome.exitCode ?? 1,
        error: outcome.exitCode === 0 ? undefined : `OpenCode container exited with code ${outcome.exitCode}`,
        containerId: outcome.containerId,
      };
    }

    await ctx.emit("shell.command", { command: `${opencodeBin()} ${args.join(" ")} <prompt>`, cwd });
    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn(opencodeBin(), [...args, prompt], {
        cwd,
        env: { ...process.env, ...ctx.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const rl = createInterface({ input: child.stdout });
      let seq = 0;
      let nativeSessionRef: string | undefined;
      rl.on("line", (line) => {
        if (!line.trim()) return;
        // Capture the harness's own session id (opaque to AgentFabric).
        try {
          const raw = JSON.parse(line) as OpenCodeEvent;
          if (!nativeSessionRef && typeof raw.sessionID === "string" && raw.sessionID) {
            nativeSessionRef = raw.sessionID;
          }
        } catch {
          /* non-JSON line */
        }
        const mapped = mapOpenCodeEvent(line, ctx.run.id, () => ++seq);
        if (mapped) {
          void ctx.emit(mapped.type, mapped.data, { level: mapped.level, source: "opencode" });
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) void ctx.log(text, "warn");
      });

      const onAbort = () => child.kill("SIGTERM");
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ error: `Failed to start opencode: ${err.message}` });
      });
      child.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        if (ctx.signal.aborted) {
          resolve({ exitCode: code ?? 1, error: "OpenCode run aborted", nativeSessionRef });
          return;
        }
        if (code !== 0) {
          resolve({ exitCode: code ?? 1, error: `OpenCode exited with code ${code}`, nativeSessionRef });
          return;
        }
        resolve({ exitCode: 0, nativeSessionRef });
      });
    });
  },

  async cancel(ctx) {
    await ctx.log("OpenCode run cancelled", "warn");
  },

  describe() {
    return { needsDocker: false, needsModel: false, cli: opencodeBin() };
  },
};
