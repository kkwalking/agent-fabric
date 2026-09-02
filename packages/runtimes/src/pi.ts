import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentRuntimeAdapter, RuntimeContext, RuntimeResult, RunEvent } from "@agentfabric/core";
import { runDockerContainer, mergedResourceLimits } from "./docker.js";

interface PiEvent {
  type: string;
  [key: string]: unknown;
}

function piBin(): string {
  return process.env.AGENTFABRIC_PI_BIN ?? "pi";
}

/**
 * Maps a pi JSONL event to an AgentFabric standard event.
 * Pi's JSON mode is less structured than opencode's, so we use a tolerant
 * mapping and never drop a line — unknown types become log lines.
 */
export function mapPiEvent(raw: string, runId: string, seq: () => number): RunEvent | null {
  let evt: PiEvent;
  try {
    evt = JSON.parse(raw) as PiEvent;
  } catch {
    return null;
  }
  const type = evt.type ?? "unknown";
  const timestamp = (evt.timestamp as string) ?? new Date().toISOString();
  const data = { ...(evt as Record<string, unknown>) };
  delete data.type;
  const base = { id: `evt_${runId}_${seq()}`, runId, seq: seq(), timestamp, data };

  const text =
    (evt as Record<string, any>).text ??
    (evt as Record<string, any>).content ??
    (evt as Record<string, any>).message?.content ??
    (evt as Record<string, any>).output;

  if (type === "message") {
    const role = (evt as Record<string, any>).role ?? "assistant";
    return { ...base, type: "agent.message", level: "info", source: "pi", data: { content: text ?? "", role, raw: data } };
  }
  if (type === "tool" || type === "tool_call") {
    const tool = (evt as Record<string, any>).tool?.name ?? (evt as Record<string, any>).tool ?? (evt as Record<string, any>).name ?? "unknown";
    const state = (evt as Record<string, any>).state ?? (evt as Record<string, any>).status;
    const isStart = state === "started" || state === "start" || state === "running" || !state;
    return {
      ...base,
      type: isStart ? "tool.started" : "tool.completed",
      level: "info",
      source: "pi",
      data: { tool, state, ...data },
    };
  }
  if (type === "bash" || type === "shell" || type === "command") {
    const command = (evt as Record<string, any>).command ?? (evt as Record<string, any>).cmd ?? text;
    const state = (evt as Record<string, any>).state;
    if (state === "started" || state === "running") {
      return { ...base, type: "shell.command", level: "info", source: "pi", data: { command, ...data } };
    }
    return { ...base, type: "shell.output", level: "info", source: "pi", data: { line: text ?? command ?? "", ...data } };
  }
  if (type === "error") {
    return { ...base, type: "runtime.error", level: "error", source: "pi", data };
  }
  if (type === "usage") {
    return { ...base, type: "model.response", level: "debug", source: "pi", data };
  }
  if (type === "session" || type === "info") {
    return { ...base, type: "log", level: "info", source: "pi", data: { line: `pi: ${JSON.stringify(data)}` } };
  }
  return { ...base, type: "log", level: "debug", source: "pi", data: { line: raw } };
}

function buildArgs(ctx: RuntimeContext): string[] {
  const args = ["--print", "--mode", "json"];
  if (ctx.provider && ctx.model) {
    args.push("--provider", ctx.provider.name);
    args.push("--model", ctx.model.name);
  } else if (ctx.model) {
    args.push("--model", ctx.model.name);
  }
  if (ctx.session) {
    args.push("--session", ctx.session.id);
  } else {
    args.push("--no-session");
  }
  const tools = ctx.task.policy?.toolPermissions;
  if (tools && tools.length > 0) {
    args.push("--tools", tools.join(","));
  }
  if (ctx.task.policy?.shell === "deny") {
    args.push("--no-tools");
  }
  if (ctx.runtime.config?.thinking) args.push("--thinking", String(ctx.runtime.config.thinking));
  return args;
}

/**
 * Pi Agent Runtime adapter.
 *
 * Default: spawns the local `pi --print --mode json` CLI, streaming its
 * JSONL output as AgentFabric standard events.
 *
 * `containerized: true`: runs `pi` inside a Docker image via the shared
 * Docker helper (runtime.image must contain the pi CLI).
 */
export const piAdapter: AgentRuntimeAdapter = {
  kind: "pi",
  name: "Pi Agent",

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const args = buildArgs(ctx);
    const prompt = ctx.task.prompt;
    const cwd = ctx.workspacePath ?? ctx.runtime.cwd ?? process.cwd();

    if (ctx.runtime.containerized) {
      const image = ctx.runtime.image ?? "node:22-alpine";
      const outcome = await runDockerContainer(ctx, {
        image,
        command: [...args, prompt],
        env: ctx.env,
        workspaceMount: ctx.workspacePath ? { hostPath: ctx.workspacePath, containerPath: "/workspace" } : undefined,
        resourceLimits: mergedResourceLimits(ctx),
        networkPolicy: ctx.task.policy?.network ?? ctx.runtime.networkPolicy,
      });
      return outcome.exitCode === 0 ? { exitCode: 0 } : { exitCode: outcome.exitCode ?? 1, error: `Pi container exited with code ${outcome.exitCode}` };
    }

    await ctx.emit("shell.command", { command: `${piBin()} ${args.join(" ")} <prompt>`, cwd });
    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn(piBin(), [...args, prompt], {
        cwd,
        env: { ...process.env, ...ctx.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const rl = createInterface({ input: child.stdout });
      let seq = 0;
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const mapped = mapPiEvent(line, ctx.run.id, () => ++seq);
        if (mapped) {
          void ctx.emit(mapped.type, mapped.data, { level: mapped.level, source: "pi" });
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
        resolve({ error: `Failed to start pi: ${err.message}` });
      });
      child.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        if (ctx.signal.aborted) {
          resolve({ exitCode: code ?? 1, error: "Pi run aborted" });
          return;
        }
        if (code !== 0) {
          resolve({ exitCode: code ?? 1, error: `Pi exited with code ${code}` });
          return;
        }
        resolve({ exitCode: 0 });
      });
    });
  },

  async cancel(ctx) {
    await ctx.log("Pi run cancelled", "warn");
  },

  describe() {
    return { needsDocker: false, needsModel: false, cli: piBin() };
  },
};
