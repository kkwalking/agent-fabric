import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { execFile } from "node:child_process";
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
  renderHandoffBody,
  toHandoffListRow,
  HandoffUnavailableError,
  HandoffRequiredError,
  type NewTaskInput,
  type ContinueTaskInput,
  type Run,
  type Task,
} from "@agentfabric/core";
import { buildRegistry, codexThreadSource, claudeCodeThreadSource, createDockerContainerOps } from "@agentfabric/runtimes";

export interface ServerOptions {
  dataDir: string;
  staticDir?: string;
}

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json(data);
}

function fail(res: Response, err: unknown, status = 400): void {
  const message = err instanceof Error ? err.message : String(err);
  // Machine-readable code so a client can offer the explicit degraded
  // fallback instead of just printing the message.
  const code = (err as { code?: string } | undefined)?.code;
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
}

/**
 * A handoff that could not be produced by the model is a conflict, not a
 * missing resource: the caller may retry accepting a degraded context.
 */
function failContinue(res: Response, err: unknown): void {
  if (err instanceof HandoffUnavailableError) {
    // 409 Conflict: the continuation is possible, but the client must
    // decide whether a degraded context is acceptable.
    res.status(409).json({ error: err.message, code: err.code, allowDegraded: true });
    return;
  }
  if (err instanceof HandoffRequiredError) {
    // 409 Conflict: a handoff is an explicit action — the client must
    // generate one first, then retry the continuation.
    res.status(409).json({ error: err.message, code: err.code, generateHandoff: true });
    return;
  }
  fail(res, err, 404);
}

/**
 * Aborts when the client goes away before the response is sent, so a long
 * (possibly chunked) handoff generation stops instead of running on for a
 * caller that will never read the result. `writableEnded` distinguishes a
 * normal response from a dropped connection.
 */
function requestAbort(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
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
  const runs = new RunService(store, bus, registry, createDockerContainerOps(), undefined, {
    codex: codexThreadSource,
    "claude-code": claudeCodeThreadSource,
  });
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
  // Reveal the stored API key on demand (the eye button in the provider
  // editor). Raw keys never appear in list/get responses, only here.
  app.get("/api/providers/:id/api-key", (req, res) => {
    const p = providers.get(req.params.id);
    if (!p) return fail(res, new Error("Provider not found"), 404);
    const secret = p.apiKeySecretId ? secrets.getWithValue(p.apiKeySecretId) : undefined;
    ok(res, { apiKey: secret?.value });
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

  /* ---------------- local harness threads (v6 §2/§6/§7/§8) ---------------- */

  // Harness-native auth availability (v6 §2): detects installed/logged-in
  // without ever touching the harness's token material.
  app.get("/api/harness/:kind/auth-status", async (req, res) => {
    try {
      const status = await runs.harnessAuthStatus(req.params.kind);
      status ? ok(res, status) : fail(res, new Error(`Runtime kind "${req.params.kind}" has no harness-native auth check`), 404);
    } catch (e) {
      fail(res, e, 500);
    }
  });

  // Local thread discovery (v6 §6/§11): newest first, optionally narrowed
  // to a workspace (its path) and a result limit.
  app.get("/api/harness/:kind/threads", async (req, res) => {
    try {
      const limitRaw = Number(req.query.limit);
      let cwd: string | undefined = typeof req.query.cwd === "string" && req.query.cwd ? req.query.cwd : undefined;
      if (!cwd && typeof req.query.workspaceId === "string" && req.query.workspaceId) {
        const ws = workspaces.get(req.query.workspaceId);
        if (!ws) return fail(res, new Error("Workspace not found"), 404);
        cwd = ws.path;
      }
      ok(res, await runs.listHarnessThreads(req.params.kind, { cwd, limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined }));
    } catch (e) {
      fail(res, e, 500);
    }
  });

  // Read an existing thread without executing the model again (v6 §7).
  app.get("/api/harness/:kind/threads/:threadId", async (req, res) => {
    try {
      ok(res, await runs.readHarnessThread(req.params.kind, req.params.threadId));
    } catch (e) {
      fail(res, e, 404);
    }
  });

  // Adopt an existing thread into AgentFabric (v6 §8): read → associate the
  // workspace the caller chose (existing, newly named, or none) →
  // (optional) generate handoff toward another harness.
  app.post("/api/harness/:kind/threads/import", async (req, res) => {
    try {
      const body = req.body ?? {};
      if (typeof body.threadId !== "string" || !body.threadId) throw new Error("threadId is required");
      const result = await runs.importHarnessThread({
        runtimeKind: req.params.kind as never,
        threadId: body.threadId,
        workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : undefined,
        createWorkspaceName: typeof body.createWorkspaceName === "string" ? body.createWorkspaceName : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        prompt: typeof body.prompt === "string" ? body.prompt : undefined,
        targetRuntimeId: typeof body.targetRuntimeId === "string" ? body.targetRuntimeId : undefined,
        userNotes: typeof body.userNotes === "string" ? body.userNotes : undefined,
      });
      ok(res, result, 201);
    } catch (e) {
      fail(res, e);
    }
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

  // Task Thread read model (v5 §24/§35): an aggregate of everything the
  // thread page renders — task, workspace, and per-run events, artifacts
  // and consumed handoff. Pure projection over existing records; no new
  // Message/Conversation/Session domain model.
  app.get("/api/tasks/:id/thread", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) return fail(res, new Error("Task not found"), 404);
    const taskRuns = runs.forTask(task.id);
    // The thread's current workspace follows the latest run (a continuation
    // may have overridden it), falling back to the task default.
    const currentWorkspaceId = taskRuns[taskRuns.length - 1]?.workspaceId ?? task.workspaceId;
    // Explicitly requested handoff waiting in the thread: the next turn
    // (any harness) consumes it as the sole context. It is looked up by the
    // flag that turn actually consumes (`awaitingNextTurn`), not through the
    // latest run's `generatedHandoffId` — that pointer is history: it names
    // whichever handoff was generated from that run, possibly long ago and
    // possibly since discarded. Reading it hid a freshly armed handoff as
    // soon as the page that requested it went away.
    const pendingHandoff = handoffs.list({ taskId: task.id }).find((h) => h.awaitingNextTurn) ?? null;
    ok(res, {
      task,
      workspace: currentWorkspaceId ? workspaces.get(currentWorkspaceId) ?? null : null,
      pendingHandoff,
      runs: taskRuns.map((run) => ({
        run,
        events: runs.events(run.id),
        artifacts: artifacts.list(run.id),
        previousHandoff: run.previousHandoffId ? handoffs.get(run.previousHandoffId) ?? null : null,
      })),
    });
  });

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
      ok(res, await runs.continueTask(req.params.id, body, { signal: requestAbort(res) }), 201);
    } catch (e) {
      failContinue(res, e);
    }
  });

  // Pre-generate the task's handoff toward a runtime without starting a run
  // (the UI fires this when the user confirms a harness switch). The next
  // continue reuses the stored summary instead of regenerating it. This is
  // an explicit request: a missing model summary is an error, not a digest.
  app.post("/api/tasks/:id/handoff", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { runtimeId?: string };
      ok(res, await runs.generateHandoff(req.params.id, body.runtimeId, { signal: requestAbort(res) }), 201);
    } catch (e) {
      failContinue(res, e);
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

  // Reads are pure reads. A handoff's content is projected from its
  // checkpoint once, when it is generated (`handoffCheckpointToContent` +
  // `assembleHandoffContextBundle`); nothing re-parses, re-projects or repairs
  // a stored record here. A record that is wrong is discarded and regenerated,
  // never patched at read time (AGENTS.md: "No compatibility logic for old
  // data").
  //
  // The list is an index: a handoff carries up to a full handoff budget of
  // preserved context (150K tokens on a 1M model), which no table needs. The
  // full record — context bundle, budget accounting, rendered body — is
  // `GET /api/handoffs/:id`.
  app.get("/api/handoffs", (req, res) => {
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    ok(res, handoffs.list({ taskId, runId }).map(toHandoffListRow));
  });
  app.get("/api/handoffs/:id", (req, res) => {
    const h = handoffs.get(req.params.id);
    if (!h) return fail(res, new Error("Handoff not found"), 404);
    // Rendered body = the exact text the consuming harness receives ahead of
    // its `# Your instruction`; consumers let the UI link to that full text.
    const consumedByRunIds = runs.list().filter((r) => r.previousHandoffId === h.id).map((r) => r.id);
    ok(res, { ...h, renderedPrompt: renderHandoffBody(h), consumedByRunIds });
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

  /* ---------------- proxy ---------------- */

  /**
   * Probes an HTTP/SOCKS5 proxy from the server host (where local harness
   * processes run) by fetching a 204 endpoint through it. Uses curl so
   * both proxy protocols work without extra dependencies; socks5h also
   * resolves DNS through the proxy, matching what a blocked target
   * actually experiences.
   */
  app.post("/api/proxy/test", (req, res) => {
    const { scheme = "http", host, port } = req.body ?? {};
    const hostText = typeof host === "string" ? host.trim() : "";
    const portNumber = Number(port);
    if (!hostText || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      fail(res, "Proxy host and a valid port (1–65535) are required");
      return;
    }
    const proxyUrl = `${scheme === "socks5" ? "socks5h" : "http"}://${hostText}:${portNumber}`;
    const started = Date.now();
    execFile(
      "curl",
      ["-x", proxyUrl, "-sS", "-o", "/dev/null", "-m", "8", "-w", "%{http_code}", "https://www.gstatic.com/generate_204"],
      { timeout: 12_000 },
      (err, stdout, stderr) => {
        const latencyMs = Date.now() - started;
        if (err) {
          ok(res, { ok: false, proxyUrl, latencyMs, error: (stderr ?? err.message).toString().trim() });
          return;
        }
        const status = parseInt(stdout.toString().trim(), 10);
        ok(res, {
          ok: status >= 200 && status < 400,
          proxyUrl,
          status: Number.isNaN(status) ? undefined : status,
          latencyMs,
          error: status >= 400 ? `proxy reachable but target returned HTTP ${status}` : undefined,
        });
      }
    );
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
