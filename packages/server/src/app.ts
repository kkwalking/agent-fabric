import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import {
  Store,
  EventBus,
  RunService,
  ProviderService,
  ModelService,
  RuntimeService,
  WorkspaceService,
  SecretService,
  ProfileService,
  TaskService,
  ArtifactService,
  UsageService,
  HandoffService,
  RuntimeSessionService,
  NativeStateService,
  seedDefaults,
  effectiveCapabilities,
  type NewTaskInput,
  type ContinueTaskInput,
  type Run,
  type Task,
} from "@agentfabric/core";
import { buildRegistry, createDockerContainerOps } from "@agentfabric/runtimes";

export interface ServerOptions {
  dataDir: string;
  staticDir?: string;
}

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json(data);
}

function fail(res: Response, err: unknown, status = 400): void {
  const message = err instanceof Error ? err.message : String(err);
  res.status(status).json({ error: message });
}

function sseHeaders(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
}

export async function createApp(options: ServerOptions): Promise<Express> {
  const store = await Store.open(options.dataDir);
  await seedDefaults(store);
  const bus = new EventBus();
  const registry = buildRegistry();

  const providers = new ProviderService(store);
  const models = new ModelService(store);
  const runtimes = new RuntimeService(store);
  const workspaces = new WorkspaceService(store);
  const secrets = new SecretService(store);
  const profiles = new ProfileService(store);
  const tasks = new TaskService(store);
  const artifacts = new ArtifactService(store);
  const usage = new UsageService(store);
  const handoffs = new HandoffService(store);
  const runtimeSessions = new RuntimeSessionService(store);
  const nativeStates = new NativeStateService(store);
  const runs = new RunService(store, bus, registry, createDockerContainerOps());
  // Re-arm keep-alive idle timers from container labels after a restart.
  await runs.recoverKeepAliveContainers();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  /* ---------------- health ---------------- */

  app.get("/api/health", (_req, res) => ok(res, { status: "ok", time: new Date().toISOString() }));

  app.get("/api/dashboard", (_req, res) => {
    ok(res, {
      counts: {
        providers: providers.list().length,
        models: models.list().length,
        runtimes: runtimes.list().length,
        workspaces: workspaces.list().length,
        tasks: tasks.list().length,
        runs: runs.list().length,
        artifacts: artifacts.list().length,
        secrets: secrets.list().length,
        agents: profiles.list().length,
        handoffs: handoffs.list().length,
        runtimeSessions: runtimeSessions.list().length,
        nativeStates: nativeStates.list().length,
      },
      recentRuns: runs.list().slice(0, 10),
      usage: usage.summary(),
    });
  });

  /* ---------------- providers ---------------- */

  app.get("/api/providers", (_req, res) => ok(res, providers.list()));
  app.post("/api/providers", async (req, res) => {
    try {
      ok(res, await providers.create(req.body), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/providers/:id", (req, res) => {
    const p = providers.get(req.params.id);
    p ? ok(res, p) : fail(res, new Error("Provider not found"), 404);
  });
  app.put("/api/providers/:id", async (req, res) => {
    try {
      const p = await providers.update(req.params.id, req.body);
      p ? ok(res, p) : fail(res, new Error("Provider not found"), 404);
    } catch (e) {
      fail(res, e);
    }
  });
  app.post("/api/providers/:id/enable", async (req, res) => {
    const p = await providers.setEnabled(req.params.id, true);
    p ? ok(res, p) : fail(res, new Error("Provider not found"), 404);
  });
  app.post("/api/providers/:id/disable", async (req, res) => {
    const p = await providers.setEnabled(req.params.id, false);
    p ? ok(res, p) : fail(res, new Error("Provider not found"), 404);
  });
  app.delete("/api/providers/:id", async (req, res) => {
    const removed = await providers.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Provider not found"), 404);
  });

  /* ---------------- models ---------------- */

  app.get("/api/models", (_req, res) => ok(res, models.list()));
  app.post("/api/models", async (req, res) => {
    try {
      ok(res, await models.create(req.body), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/models/:id", (req, res) => {
    const m = models.get(req.params.id);
    m ? ok(res, m) : fail(res, new Error("Model not found"), 404);
  });
  app.put("/api/models/:id", async (req, res) => {
    const m = await models.update(req.params.id, req.body);
    m ? ok(res, m) : fail(res, new Error("Model not found"), 404);
  });
  app.delete("/api/models/:id", async (req, res) => {
    const removed = await models.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Model not found"), 404);
  });

  /* ---------------- runtimes ---------------- */

  app.get("/api/runtimes", (_req, res) => ok(res, runtimes.list()));
  app.post("/api/runtimes", async (req, res) => {
    try {
      ok(res, await runtimes.create(req.body), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/runtimes/:id", (req, res) => {
    const r = runtimes.get(req.params.id);
    r ? ok(res, r) : fail(res, new Error("Runtime not found"), 404);
  });
  app.put("/api/runtimes/:id", async (req, res) => {
    const r = await runtimes.update(req.params.id, req.body);
    r ? ok(res, r) : fail(res, new Error("Runtime not found"), 404);
  });
  app.post("/api/runtimes/:id/enable", async (req, res) => {
    const r = await runtimes.setEnabled(req.params.id, true);
    r ? ok(res, r) : fail(res, new Error("Runtime not found"), 404);
  });
  app.post("/api/runtimes/:id/disable", async (req, res) => {
    const r = await runtimes.setEnabled(req.params.id, false);
    r ? ok(res, r) : fail(res, new Error("Runtime not found"), 404);
  });
  app.delete("/api/runtimes/:id", async (req, res) => {
    const removed = await runtimes.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Runtime not found"), 404);
  });

  // Effective harness capabilities (spec v1 §17): adapter declarations
  // overridden by the runtime record.
  app.get("/api/runtimes/:id/capabilities", (req, res) => {
    const r = runtimes.get(req.params.id);
    if (!r) return fail(res, new Error("Runtime not found"), 404);
    ok(res, effectiveCapabilities(registry.get(r.kind), r));
  });

  // Provider compatibility (v4 §4): which parts of an AgentFabric
  // Provider configuration this harness can genuinely honor.
  app.get("/api/runtimes/:id/provider-compatibility", (req, res) => {
    const r = runtimes.get(req.params.id);
    if (!r) return fail(res, new Error("Runtime not found"), 404);
    const adapter = registry.get(r.kind);
    ok(res, adapter?.providerCompatibility ?? null);
  });

  /* ---------------- workspaces ---------------- */

  app.get("/api/workspaces", (_req, res) => ok(res, workspaces.list()));
  app.post("/api/workspaces", async (req, res) => {
    try {
      ok(res, await workspaces.create(req.body), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  // Import an existing working directory or git repository (spec v1 §11).
  app.post("/api/workspaces/import", async (req, res) => {
    try {
      ok(res, await workspaces.import(req.body), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/workspaces/:id", (req, res) => {
    const w = workspaces.get(req.params.id);
    w ? ok(res, w) : fail(res, new Error("Workspace not found"), 404);
  });
  app.put("/api/workspaces/:id", async (req, res) => {
    const w = await workspaces.update(req.params.id, req.body);
    w ? ok(res, w) : fail(res, new Error("Workspace not found"), 404);
  });
  // Persist/verify the workspace after a run (spec v1 §11 Save).
  app.post("/api/workspaces/:id/save", async (req, res) => {
    try {
      const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
      ok(res, await workspaces.save(req.params.id, runId));
    } catch (e) {
      fail(res, e, 404);
    }
  });
  // Tasks & runs referencing this workspace (runtime-neutral usage).
  app.get("/api/workspaces/:id/usage", (req, res) => {
    const w = workspaces.get(req.params.id);
    if (!w) return fail(res, new Error("Workspace not found"), 404);
    ok(res, workspaces.usage(req.params.id));
  });
  app.delete("/api/workspaces/:id", async (req, res) => {
    const removed = await workspaces.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Workspace not found"), 404);
  });

  /* ---------------- secrets ---------------- */

  app.get("/api/secrets", (_req, res) => ok(res, secrets.list()));
  app.post("/api/secrets", async (req, res) => {
    try {
      ok(res, await secrets.create(req.body), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.delete("/api/secrets/:id", async (req, res) => {
    const removed = await secrets.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Secret not found"), 404);
  });

  /* ---------------- agent profiles ---------------- */

  app.get("/api/agents", (_req, res) => ok(res, profiles.list()));
  app.post("/api/agents", async (req, res) => {
    try {
      ok(res, await profiles.create(req.body), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/agents/:id", (req, res) => {
    const p = profiles.get(req.params.id);
    p ? ok(res, p) : fail(res, new Error("Agent not found"), 404);
  });
  app.put("/api/agents/:id", async (req, res) => {
    const p = await profiles.update(req.params.id, req.body);
    p ? ok(res, p) : fail(res, new Error("Agent not found"), 404);
  });
  app.delete("/api/agents/:id", async (req, res) => {
    const removed = await profiles.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Agent not found"), 404);
  });

  /* ---------------- tasks ---------------- */

  app.get("/api/tasks", (_req, res) => ok(res, tasks.list()));
  app.post("/api/tasks", async (req, res) => {
    try {
      ok(res, await tasks.create(req.body as NewTaskInput), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/tasks/:id", (req, res) => {
    const t = tasks.get(req.params.id);
    t ? ok(res, t) : fail(res, new Error("Task not found"), 404);
  });
  app.get("/api/tasks/:id/runs", (req, res) => ok(res, runs.forTask(req.params.id)));

  // Preview of the resume-vs-handoff decision (spec v1 §18: make the
  // continuity explicit before executing).
  app.get("/api/tasks/:id/continue-options", (req, res) => {
    try {
      const runtimeId = typeof req.query.runtimeId === "string" ? req.query.runtimeId : undefined;
      ok(res, runs.continueOptions(req.params.id, runtimeId));
    } catch (e) {
      fail(res, e, 404);
    }
  });

  // Continue a task: same harness → native Resume; different harness
  // (or no native resume) → Handoff (spec v1 §20).
  app.post("/api/tasks/:id/continue", async (req, res) => {
    try {
      const body = req.body as ContinueTaskInput;
      if (!body?.prompt) throw new Error("prompt is required");
      ok(res, await runs.continueTask(req.params.id, body), 201);
    } catch (e) {
      fail(res, e, 404);
    }
  });

  /* ---------------- runs ---------------- */

  app.get("/api/runs", (_req, res) => ok(res, runs.list()));
  app.post("/api/runs", async (req, res) => {
    try {
      const result = await runs.submit(req.body as NewTaskInput);
      ok(res, result, 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/runs/:id", (req, res) => {
    const r = runs.get(req.params.id);
    r ? ok(res, r) : fail(res, new Error("Run not found"), 404);
  });
  app.post("/api/runs/:id/cancel", async (req, res) => {
    const r = await runs.cancel(req.params.id);
    r ? ok(res, r) : fail(res, new Error("Run not found"), 404);
  });
  app.post("/api/runs/:id/rerun", async (req, res) => {
    try {
      ok(res, await runs.rerun(req.params.id), 201);
    } catch (e) {
      fail(res, e, 404);
    }
  });
  app.get("/api/runs/:id/events", (req, res) => ok(res, runs.events(req.params.id)));
  app.get("/api/runs/:id/logs", (req, res) => {
    res.type("text/plain").send(runs.logs(req.params.id).join("\n"));
  });

  // SSE: real-time events for a single run.
  app.get("/api/runs/:id/events/stream", (req, res) => {
    const runId = req.params.id;
    sseHeaders(res);
    const initial = runs.events(runId);
    for (const evt of initial) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
    const unsubscribe = bus.onRun(runId, (evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // SSE: global event stream across all runs (dashboard).
  app.get("/api/events/stream", (req, res) => {
    sseHeaders(res);
    const unsubscribe = bus.onAll((evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    reqClose(req, res, () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /* ---------------- handoffs (spec v1 §4–§8) ---------------- */

  app.get("/api/handoffs", (req, res) => {
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    ok(res, handoffs.list({ taskId, runId }));
  });
  app.get("/api/handoffs/:id", (req, res) => {
    const h = handoffs.get(req.params.id);
    h ? ok(res, h) : fail(res, new Error("Handoff not found"), 404);
  });
  // Fold user-provided notes into an existing handoff (spec v1 §7).
  app.post("/api/handoffs/:id/notes", async (req, res) => {
    const { notes } = (req.body ?? {}) as { notes?: string };
    if (!notes?.trim()) return fail(res, new Error("notes is required"));
    try {
      const h = await handoffs.addUserNotes(req.params.id, notes);
      h ? ok(res, h) : fail(res, new Error("Handoff not found"), 404);
    } catch (e) {
      fail(res, e);
    }
  });
  app.delete("/api/handoffs/:id", async (req, res) => {
    const removed = await handoffs.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Handoff not found"), 404);
  });

  /* ---------------- runtime session references (spec v1 §3/§9) ---------------- */

  app.get("/api/runtime-sessions", (req, res) => {
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
    const runtimeKind = typeof req.query.runtimeKind === "string" ? req.query.runtimeKind : undefined;
    const runtimeId = typeof req.query.runtimeId === "string" ? req.query.runtimeId : undefined;
    ok(res, runtimeSessions.list({ taskId, runtimeKind, runtimeId }));
  });
  app.get("/api/runtime-sessions/:id", (req, res) => {
    const s = runtimeSessions.get(req.params.id);
    s ? ok(res, s) : fail(res, new Error("Runtime session not found"), 404);
  });
  app.post("/api/runtime-sessions/:id/expire", async (req, res) => {
    const s = await runtimeSessions.expire(req.params.id);
    s ? ok(res, s) : fail(res, new Error("Runtime session not found"), 404);
  });
  app.delete("/api/runtime-sessions/:id", async (req, res) => {
    const removed = await runtimeSessions.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Runtime session not found"), 404);
  });

  /* ---------------- runtime native states (v2 §13–§15) ---------------- */
  // Opaque per-runtime state directories harnesses need for native
  // resume. Not a first-class user resource: surfaced for inspection
  // and lifecycle management only (create/mount/preserve happen inside
  // the orchestrator; delete is explicit).

  app.get("/api/native-states", (req, res) => {
    const runtimeId = typeof req.query.runtimeId === "string" ? req.query.runtimeId : undefined;
    ok(res, nativeStates.list({ runtimeId }));
  });
  app.get("/api/native-states/:id", (req, res) => {
    const s = nativeStates.get(req.params.id);
    s ? ok(res, s) : fail(res, new Error("Native state not found"), 404);
  });
  app.delete("/api/native-states/:id", async (req, res) => {
    const removed = await nativeStates.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Native state not found"), 404);
  });

  /* ---------------- containers (keep-alive inspection) ---------------- */

  app.get("/api/containers/kept", (_req, res) => ok(res, runs.keptContainers()));

  /* ---------------- artifacts ---------------- */

  app.get("/api/artifacts", (req, res) => {
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    ok(res, artifacts.list(runId));
  });
  app.get("/api/artifacts/:id", (req, res) => {
    const a = artifacts.get(req.params.id);
    a ? ok(res, a) : fail(res, new Error("Artifact not found"), 404);
  });
  app.get("/api/artifacts/:id/content", (req, res) => {
    const a = artifacts.get(req.params.id);
    if (!a) return fail(res, new Error("Artifact not found"), 404);
    if (a.content != null) {
      res.type(a.mime ?? "text/plain").send(a.content);
    } else if (a.path) {
      res.send({ path: a.path, note: "Artifact is stored on disk; use workspace path to read it." });
    } else {
      fail(res, new Error("Artifact has no content"), 404);
    }
  });
  app.delete("/api/artifacts/:id", async (req, res) => {
    const removed = await artifacts.remove(req.params.id);
    removed ? ok(res, { ok: true }) : fail(res, new Error("Artifact not found"), 404);
  });

  /* ---------------- usage & config ---------------- */

  app.get("/api/usage", (_req, res) => ok(res, usage.summary()));
  app.get("/api/config", (_req, res) => ok(res, store.config()));
  app.put("/api/config", async (req, res) => {
    ok(res, await store.updateConfig(req.body));
  });

  /* ---------------- static web UI ---------------- */

  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile("index.html", { root: options.staticDir });
    });
  }

  return app;
}

function reqClose(req: Request, res: Response, onClose: () => void): void {
  req.on("close", onClose);
  res.on("close", onClose);
}
