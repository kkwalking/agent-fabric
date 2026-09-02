#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiClient } from "./client.js";
import { table, pretty, statusColor } from "./format.js";

function apiUrl(): string {
  return process.env.AGENTFABRIC_API ?? "http://localhost:7377";
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("af")
    .description("AgentFabric CLI — run any agent, on any model, in any environment")
    .version("0.1.0")
    .option("--api <url>", "AgentFabric API base URL", apiUrl())
    .option("--json", "output raw JSON")
    .showHelpAfterError();

  const client = (cmd: Command): ApiClient => new ApiClient(cmd.opts().api ?? apiUrl());
  const json = (cmd: Command): boolean => Boolean(cmd.opts().json);

  /* ---------------- config ---------------- */

  program
    .command("config")
    .description("view or update AgentFabric config")
    .argument("[key]", "config key (dot notation, e.g. server.port)")
    .argument("[value]", "new value (JSON parsed)")
    .action(async (key: string | undefined, value: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (key === undefined) {
        const cfg = await c.get<unknown>("/api/config");
        console.log(json(cmd) ? pretty(cfg) : pretty(cfg));
        return;
      }
      if (value === undefined) {
        const cfg = (await c.get<Record<string, unknown>>("/api/config")) ?? {};
        const parts = key.split(".");
        let cur: unknown = cfg;
        for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
        console.log(cur === undefined ? "(not set)" : JSON.stringify(cur));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
      const cfg = (await c.get<Record<string, unknown>>("/api/config")) ?? {};
      const parts = key.split(".");
      let cur = cfg;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = cur[parts[i]] ?? {};
        cur = cur[parts[i]] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = parsed;
      const updated = await c.put<unknown>("/api/config", cfg);
      console.log(json(cmd) ? pretty(updated) : "config updated");
    });

  /* ---------------- providers ---------------- */

  program
    .command("providers")
    .description("manage LLM providers")
    .argument("<action>", "list | add | update | remove")
    .argument("[name]", "provider name or id")
    .option("--type <type>", "openai | openai-compatible | anthropic | custom")
    .option("--base-url <url>", "custom API endpoint / base URL")
    .option("--api-key <key>", "API key (stored as a Secret)")
    .option("--header <k=v>", "extra header (repeatable)")
    .option("--enabled <bool>", "enable/disable", "true")
    .action(async (action: string, name: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const rows = await c.get<Record<string, unknown>[]>("/api/providers");
        if (json(cmd)) return console.log(pretty(rows));
        console.log(table(rows.map((p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl ?? "", key: p.apiKeyMasked ?? "-", enabled: p.enabled }))));
        return;
      }
      if (action === "add") {
        if (!name) throw new Error("usage: af providers add <name> --type <type> [--base-url] [--api-key]");
        const headers: Record<string, string> = {};
        for (const h of (cmd.opts().header ?? []) as string[]) {
          const idx = h.indexOf("=");
          if (idx > 0) headers[h.slice(0, idx)] = h.slice(idx + 1);
        }
        const p = await c.post<unknown>("/api/providers", {
          name,
          type: cmd.opts().type ?? "openai-compatible",
          baseUrl: cmd.opts().baseUrl,
          apiKey: cmd.opts().apiKey,
          headers: Object.keys(headers).length ? headers : undefined,
          enabled: cmd.opts().enabled !== "false",
        });
        console.log(json(cmd) ? pretty(p) : `provider created: ${(p as { id: string }).id}`);
        return;
      }
      if (action === "update") {
        if (!name) throw new Error("usage: af providers update <id> [flags]");
        const body: Record<string, unknown> = {};
        if (cmd.opts().type) body.type = cmd.opts().type;
        if (cmd.opts().baseUrl !== undefined) body.baseUrl = cmd.opts().baseUrl;
        if (cmd.opts().apiKey !== undefined) body.apiKey = cmd.opts().apiKey;
        if (cmd.opts().enabled !== "true") body.enabled = false;
        const p = await c.put<unknown>(`/api/providers/${name}`, body);
        console.log(json(cmd) ? pretty(p) : `provider updated: ${(p as { id: string }).id}`);
        return;
      }
      if (action === "remove") {
        if (!name) throw new Error("usage: af providers remove <id>");
        const r = await c.delete<unknown>(`/api/providers/${name}`);
        console.log(json(cmd) ? pretty(r) : "provider removed");
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  /* ---------------- models ---------------- */

  program
    .command("models")
    .description("manage models")
    .argument("<action>", "list | add | remove")
    .argument("[name]", "model name or id")
    .option("--provider <id>", "provider id")
    .option("--alias <alias>", "convenient alias")
    .option("--param <k=v>", "model parameter (repeatable)")
    .action(async (action: string, name: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const rows = await c.get<Record<string, unknown>[]>("/api/models");
        if (json(cmd)) return console.log(pretty(rows));
        console.log(table(rows.map((m) => ({ id: m.id, name: m.name, alias: m.alias ?? "-", provider: m.providerId, enabled: m.enabled }))));
        return;
      }
      if (action === "add") {
        if (!name) throw new Error("usage: af models add <name> --provider <id> [--alias]");
        const params: Record<string, unknown> = {};
        for (const p of (cmd.opts().param ?? []) as string[]) {
          const idx = p.indexOf("=");
          if (idx > 0) params[p.slice(0, idx)] = p.slice(idx + 1);
        }
        const m = await c.post<unknown>("/api/models", {
          providerId: cmd.opts().provider,
          name,
          alias: cmd.opts().alias,
          parameters: Object.keys(params).length ? params : undefined,
        });
        console.log(json(cmd) ? pretty(m) : `model created: ${(m as { id: string }).id}`);
        return;
      }
      if (action === "remove") {
        if (!name) throw new Error("usage: af models remove <id>");
        const r = await c.delete<unknown>(`/api/models/${name}`);
        console.log(json(cmd) ? pretty(r) : "model removed");
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  /* ---------------- runtimes ---------------- */

  program
    .command("runtimes")
    .description("manage agent runtimes")
    .argument("<action>", "list | add | enable | disable | remove")
    .argument("[name]", "runtime name or id")
    .option("--kind <kind>", "opencode | pi | docker | mock | custom")
    .option("--image <image>", "docker image (for containerized runtimes)")
    .option("--command <cmd>", "command inside container (docker kind)")
    .option("--containerized", "run inside a Docker container")
    .option("--persistent", "keep the runtime/container after the run")
    .option("--description <text>", "description")
    .action(async (action: string, name: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const rows = await c.get<Record<string, unknown>[]>("/api/runtimes");
        if (json(cmd)) return console.log(pretty(rows));
        console.log(
          table(
            rows.map((r) => ({
              id: r.id,
              name: r.name,
              kind: r.kind,
              image: r.image ?? "-",
              containerized: r.containerized,
              enabled: r.enabled,
              ephemeral: r.ephemeral,
            }))
          )
        );
        return;
      }
      if (action === "add") {
        if (!name) throw new Error("usage: af runtimes add <name> --kind <kind> [--image] [--containerized]");
        const r = await c.post<unknown>("/api/runtimes", {
          name,
          kind: cmd.opts().kind ?? "docker",
          image: cmd.opts().image,
          command: cmd.opts().command ? String(cmd.opts().command).split(" ") : undefined,
          containerized: Boolean(cmd.opts().containerized),
          ephemeral: !cmd.opts().persistent,
          description: cmd.opts().description,
        });
        console.log(json(cmd) ? pretty(r) : `runtime created: ${(r as { id: string }).id}`);
        return;
      }
      if (action === "enable" || action === "disable") {
        if (!name) throw new Error(`usage: af runtimes ${action} <id>`);
        const r = await c.post<unknown>(`/api/runtimes/${name}/${action}`);
        console.log(json(cmd) ? pretty(r) : `runtime ${action}d: ${name}`);
        return;
      }
      if (action === "remove") {
        if (!name) throw new Error("usage: af runtimes remove <id>");
        const r = await c.delete<unknown>(`/api/runtimes/${name}`);
        console.log(json(cmd) ? pretty(r) : "runtime removed");
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  /* ---------------- workspaces ---------------- */

  program
    .command("workspaces")
    .description("manage workspaces")
    .argument("<action>", "list | add | remove")
    .argument("[name]", "workspace name or id")
    .option("--path <dir>", "local directory path")
    .option("--type <type>", "local | git | volume", "local")
    .option("--repo <url>", "git repository URL")
    .option("--branch <branch>", "git branch")
    .action(async (action: string, name: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const rows = await c.get<Record<string, unknown>[]>("/api/workspaces");
        if (json(cmd)) return console.log(pretty(rows));
        console.log(table(rows.map((w) => ({ id: w.id, name: w.name, type: w.type, path: w.path ?? w.repoUrl ?? "-" }))));
        return;
      }
      if (action === "add") {
        if (!name) throw new Error("usage: af workspaces add <name> --path <dir>");
        const w = await c.post<unknown>("/api/workspaces", {
          name,
          type: cmd.opts().type,
          path: cmd.opts().path,
          repoUrl: cmd.opts().repo,
          branch: cmd.opts().branch,
        });
        console.log(json(cmd) ? pretty(w) : `workspace created: ${(w as { id: string }).id}`);
        return;
      }
      if (action === "remove") {
        if (!name) throw new Error("usage: af workspaces remove <id>");
        const r = await c.delete<unknown>(`/api/workspaces/${name}`);
        console.log(json(cmd) ? pretty(r) : "workspace removed");
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  /* ---------------- secrets ---------------- */

  program
    .command("secrets")
    .description("manage secrets (values never appear in logs/events)")
    .argument("<action>", "list | add | remove")
    .argument("[name]", "secret name or id")
    .option("--value <value>", "secret value")
    .option("--scope <scope>", "provider | git | runtime | env | service", "env")
    .action(async (action: string, name: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const rows = await c.get<Record<string, unknown>[]>("/api/secrets");
        if (json(cmd)) return console.log(pretty(rows));
        console.log(table(rows.map((s) => ({ id: s.id, name: s.name, scope: s.scope, masked: s.masked }))));
        return;
      }
      if (action === "add") {
        if (!name) throw new Error("usage: af secrets add <name> --value <value>");
        const s = await c.post<unknown>("/api/secrets", { name, value: cmd.opts().value, scope: cmd.opts().scope });
        console.log(json(cmd) ? pretty(s) : `secret created: ${(s as { id: string }).id} (${(s as { masked: string }).masked})`);
        return;
      }
      if (action === "remove") {
        if (!name) throw new Error("usage: af secrets remove <id>");
        const r = await c.delete<unknown>(`/api/secrets/${name}`);
        console.log(json(cmd) ? pretty(r) : "secret removed");
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  /* ---------------- agents (profiles) ---------------- */

  program
    .command("agents")
    .description("manage reusable agent profiles")
    .argument("<action>", "list | add | remove")
    .argument("[name]", "agent name or id")
    .option("--runtime <id>", "runtime id")
    .option("--model <id>", "model id or alias")
    .option("--system-prompt <text>", "system instructions")
    .option("--tool <tool>", "tool allowlist (repeatable)")
    .option("--shell <policy>", "allow | deny | ask", "allow")
    .option("--max-duration <ms>", "max execution time in ms")
    .action(async (action: string, name: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const rows = await c.get<Record<string, unknown>[]>("/api/agents");
        if (json(cmd)) return console.log(pretty(rows));
        console.log(table(rows.map((a) => ({ id: a.id, name: a.name, runtime: a.runtimeId ?? "-", model: a.modelId ?? "-", description: a.description ?? "" }))));
        return;
      }
      if (action === "add") {
        if (!name) throw new Error("usage: af agents add <name> [--runtime] [--model]");
        const tools = (cmd.opts().tool ?? []) as string[];
        const a = await c.post<unknown>("/api/agents", {
          name,
          runtimeId: cmd.opts().runtime,
          modelId: cmd.opts().model,
          systemInstructions: cmd.opts().systemPrompt,
          tools: tools.length ? tools : undefined,
          policy: {
            shell: cmd.opts().shell,
            maxDurationMs: cmd.opts().maxDuration ? Number(cmd.opts().maxDuration) : undefined,
          },
        });
        console.log(json(cmd) ? pretty(a) : `agent created: ${(a as { id: string }).id}`);
        return;
      }
      if (action === "remove") {
        if (!name) throw new Error("usage: af agents remove <id>");
        const r = await c.delete<unknown>(`/api/agents/${name}`);
        console.log(json(cmd) ? pretty(r) : "agent removed");
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  /* ---------------- run ---------------- */

  program
    .command("run")
    .description('submit a task and execute it (use "-" to read prompt from stdin)')
    .argument("[prompt]", "task prompt")
    .option("--title <text>", "task title")
    .option("--runtime <id>", "runtime id")
    .option("--model <id>", "model id or alias")
    .option("--workspace <id>", "workspace id")
    .option("--session <id>", "session id to continue")
    .option("--profile <id>", "agent profile id")
    .option("--tool <tool>", "tool allowed for this task (repeatable)")
    .option("--timeout <ms>", "task timeout in ms")
    .option("--from-repo", "use the current directory as the workspace")
    .option("--follow", "stream events live until the run finishes")
    .option("--no-wait", "submit and return immediately")
    .action(async (prompt: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      const opts = cmd.opts();
      let text = prompt;
      if (text === "-") {
        text = readFileSync(0, "utf8").trim();
      }
      if (!text) throw new Error('usage: af run "<prompt>" [--runtime] [--model] [--from-repo] [--follow]');

      let workspaceId = opts.workspace;
      if (opts.fromRepo) {
        const abs = resolve(process.cwd());
        const ws = await c.post<{ id: string }>("/api/workspaces", {
          name: `repo-${abs.split("/").pop()}`,
          type: "local",
          path: abs,
        });
        workspaceId = ws.id;
        console.error(`workspace: ${ws.id} (${abs})`);
      }

      const result = await c.post<{ task: { id: string }; run: Record<string, unknown> }>("/api/runs", {
        prompt: text,
        title: opts.title,
        runtimeId: opts.runtime,
        modelId: opts.model,
        workspaceId,
        sessionId: opts.session,
        profileId: opts.profile,
        tools: (opts.tool as string[] | undefined)?.length ? opts.tool : undefined,
        timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
      });
      const runId = result.run.id as string;
      console.log(json(cmd) ? pretty(result) : `task ${result.task.id} -> run ${runId} (${result.run.status})`);

      if (opts.follow) {
        await followRun(c, runId, json(cmd));
      } else if (opts.wait !== false) {
        await waitForRun(c, runId, opts.timeout ? Number(opts.timeout) : undefined, json(cmd));
      }
    });

  program
    .command("tasks")
    .description("list submitted tasks")
    .action(async (_opts: unknown, cmd: Command) => {
      const c = client(cmd);
      const rows = await c.get<Record<string, unknown>[]>("/api/tasks");
      if (json(cmd)) return console.log(pretty(rows));
      console.log(table(rows.map((t) => ({ id: t.id, title: t.title, runtime: t.runtimeId ?? "-", createdAt: t.createdAt }))));
    });

  program
    .command("usage")
    .description("show aggregated usage & cost")
    .action(async (_opts: unknown, cmd: Command) => {
      const c = client(cmd);
      const u = await c.get<Record<string, unknown>>("/api/usage");
      if (json(cmd)) return console.log(pretty(u));
      console.log(
        table([
          {
            runs: u.runs,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cachedTokens: u.cachedTokens,
            requests: u.modelRequests,
            cost: u.estimatedCost,
          },
        ])
      );
      console.log("\nby model:");
      console.log(table(
        Object.entries((u.byModel as Record<string, Record<string, unknown>>) ?? {}).map(([name, m]) => ({ model: name, ...m }))
      ));
      console.log("\nby provider:");
      console.log(table(
        Object.entries((u.byProvider as Record<string, Record<string, unknown>>) ?? {}).map(([id, p]) => ({ provider: id, ...p }))
      ));
    });

  /* ---------------- runs ---------------- */

  program
    .command("runs")
    .description("manage runs")
    .argument("<action>", "list | show | cancel | rerun | logs | events")
    .argument("[id]", "run id")
    .option("--follow", "stream events live (for show)")
    .action(async (action: string, id: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const rows = await c.get<Record<string, unknown>[]>("/api/runs");
        if (json(cmd)) return console.log(pretty(rows));
        console.log(
          table(
            rows.map((r) => ({
              id: r.id,
              title: (r.taskTitle as string).slice(0, 40),
              status: r.status,
              runtime: r.runtimeName ?? "-",
              model: r.modelName ?? "-",
              cost: r.cost ?? 0,
              createdAt: r.createdAt,
            }))
          )
        );
        return;
      }
      if (!id) throw new Error(`usage: af runs ${action} <id>`);
      if (action === "show") {
        const r = await c.get<Record<string, unknown>>(`/api/runs/${id}`);
        if (json(cmd)) return console.log(pretty(r));
        console.log(pretty(r));
        if (cmd.opts().follow) await followRun(c, id, false);
        return;
      }
      if (action === "cancel") {
        const r = await c.post<unknown>(`/api/runs/${id}/cancel`);
        console.log(json(cmd) ? pretty(r) : `run ${id} -> ${(r as { status: string }).status}`);
        return;
      }
      if (action === "rerun") {
        const r = await c.post<unknown>(`/api/runs/${id}/rerun`);
        console.log(json(cmd) ? pretty(r) : `re-run created: ${(r as { run: { id: string } }).run.id}`);
        return;
      }
      if (action === "logs") {
        const text = await c.get<string>(`/api/runs/${id}/logs`);
        process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
        return;
      }
      if (action === "events") {
        const evts = await c.get<Record<string, unknown>[]>("/api/runs/" + id + "/events");
        if (json(cmd)) return console.log(pretty(evts));
        for (const e of evts) console.log(`${e.timestamp}  ${e.type}  ${JSON.stringify(e.data)}`);
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  /* ---------------- sessions ---------------- */

  program
    .command("sessions")
    .description("manage sessions")
    .argument("<action>", "list | create | resume | close")
    .argument("[id]", "session id (for resume/close)")
    .argument("[prompt]", "prompt (for resume)")
    .option("--name <name>", "session name")
    .option("--runtime <id>", "runtime id")
    .option("--model <id>", "model id")
    .option("--workspace <id>", "workspace id")
    .action(async (action: string, id: string | undefined, prompt: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const rows = await c.get<Record<string, unknown>[]>("/api/sessions");
        if (json(cmd)) return console.log(pretty(rows));
        console.log(table(rows.map((s) => ({ id: s.id, name: s.name ?? "-", status: s.status, runs: (s.runIds as string[]).length, cost: s.cost ?? 0 }))));
        return;
      }
      if (action === "create") {
        const s = await c.post<unknown>("/api/sessions", {
          name: cmd.opts().name,
          runtimeId: cmd.opts().runtime,
          modelId: cmd.opts().model,
          workspaceId: cmd.opts().workspace,
        });
        console.log(json(cmd) ? pretty(s) : `session created: ${(s as { id: string }).id}`);
        return;
      }
      if (action === "resume") {
        if (!id || !prompt) throw new Error("usage: af sessions resume <id> \"<prompt>\"");
        const r = await c.post<unknown>(`/api/sessions/${id}/resume`, { prompt });
        console.log(json(cmd) ? pretty(r) : `run created: ${(r as { run: { id: string } }).run.id} on session ${id}`);
        return;
      }
      if (action === "close") {
        if (!id) throw new Error("usage: af sessions close <id>");
        const s = await c.post<unknown>(`/api/sessions/${id}/close`);
        console.log(json(cmd) ? pretty(s) : `session ${id} closed`);
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  /* ---------------- artifacts ---------------- */

  program
    .command("artifacts")
    .description("manage artifacts")
    .argument("<action>", "list | get")
    .argument("[id]", "artifact id")
    .option("--run <id>", "filter by run id")
    .option("--output <file>", "write content to file (for get)")
    .action(async (action: string, id: string | undefined, _opts: unknown, cmd: Command) => {
      const c = client(cmd);
      if (action === "list") {
        const qs = cmd.opts().run ? `?runId=${cmd.opts().run}` : "";
        const rows = await c.get<Record<string, unknown>[]>(`/api/artifacts${qs}`);
        if (json(cmd)) return console.log(pretty(rows));
        console.log(table(rows.map((a) => ({ id: a.id, run: a.runId, name: a.name, kind: a.kind, size: a.size ?? 0 }))));
        return;
      }
      if (action === "get") {
        if (!id) throw new Error("usage: af artifacts get <id> [--output file]");
        const a = await c.get<Record<string, unknown>>(`/api/artifacts/${id}`);
        if (json(cmd) && !cmd.opts().output) return console.log(pretty(a));
        if (cmd.opts().output) {
          const content = await c.get<string>(`/api/artifacts/${id}/content`);
          const { writeFileSync } = await import("node:fs");
          writeFileSync(cmd.opts().output, content);
          console.log(`written ${cmd.opts().output}`);
          return;
        }
        console.log(pretty(a));
        return;
      }
      throw new Error(`unknown action: ${action}`);
    });

  return program;
}

/* ---------------- helpers ---------------- */

async function followRun(c: ApiClient, runId: string, rawJson: boolean): Promise<void> {
  const seen = new Set<string>();
  const terminal = new Set(["run.completed", "run.failed", "run.cancelled", "run.timeout"]);
  await c.stream(`/api/runs/${runId}/events/stream`, (evt) => {
    const e = evt as { id: string; type: string; data: Record<string, unknown>; timestamp: string };
    if (seen.has(e.id)) return;
    seen.add(e.id);
    if (rawJson) {
      console.log(JSON.stringify(e));
    } else {
      const line = String(e.data?.line ?? e.data?.message ?? e.data?.text ?? e.data?.content ?? "");
      const label = e.type === "log" ? "" : `[${e.type}] `;
      if (line) console.log(`${label}${line}`);
      else if (e.type.startsWith("run.") || e.type.startsWith("tool.") || e.type.startsWith("model.")) {
        console.log(`${e.type} ${JSON.stringify(e.data)}`);
      }
    }
    return terminal.has(e.type);
  });
  const r = await c.get<{ status: string; cost?: number; artifactIds: string[] }>(`/api/runs/${runId}`);
  console.log(`\nrun ${runId}: ${statusColor(r.status)}  cost=$ ${r.cost ?? 0}  artifacts=${r.artifactIds.length}`);
}

async function waitForRun(c: ApiClient, runId: string, timeoutMs: number | undefined, rawJson: boolean): Promise<void> {
  const deadline = Date.now() + (timeoutMs ?? 10 * 60 * 1000) + 5000;
  for (;;) {
    const r = await c.get<{ status: string; usage?: unknown; artifactIds: string[]; cost?: number }>(`/api/runs/${runId}`);
    if (["completed", "failed", "cancelled", "timeout"].includes(r.status)) {
      if (rawJson) {
        console.log(JSON.stringify(r));
      } else {
        console.log(`\nrun ${runId}: ${statusColor(r.status)}  cost=$ ${r.cost ?? 0}  artifacts=${r.artifactIds.length}`);
      }
      return;
    }
    if (Date.now() > deadline) {
      console.error(`run ${runId} still ${r.status} (waited too long)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

buildProgram().parseAsync(process.argv).catch((err) => {
  console.error(`\x1b[31merror:\x1b[0m ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
