import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { sep, resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  Store,
  EventBus,
  RunService,
  ExecutionSupervisor,
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
  ProjectService,
  SourceCredentialService,
  WorkspaceLockService,
  seedDefaults,
  effectiveCapabilities,
  runtimeIsolation,
  renderHandoffBody,
  redactWebhookUrl,
  projectConfigProviders,
  providersToConfigSection,
  toHandoffListRow,
  HandoffUnavailableError,
  HandoffRequiredError,
  DomainError,
  isDomainError,
  httpStatusForCode,
  type AppConfig,
  type Provider,
  type Model,
  type NewTaskInput,
  type ContinueTaskInput,
  type StartProjectTaskInput,
  type Run,
  type Task,
  KanbanService,
} from "@agentfabric/core";
import { loadOrCreateToken, requireToken, TOKEN_COOKIE } from "./auth.js";
import {
  CONFIG_SCHEMA,
  SCHEMA_REF,
  changedConfigKeys,
  configFilePath,
  parseConfigText,
  readConfigFile,
  revisionOf,
  writeConfigFile,
  type ConfigFileRead,
  type SettingsFileInfo,
  type SettingsHistoryEntry,
} from "./settings.js";
import { teardownWork } from "./shutdown.js";
import { KanbanSessionRuntime } from "./kanban/sessions.js";
import { registerKanbanRoutes } from "./kanban/routes.js";
import { createKanbanUpgradeHandler } from "./kanban/ws.js";
import { pruneKanbanHooks } from "./kanban/hooks.js";
import {
  buildRegistry,
  codexThreadSource,
  claudeCodeThreadSource,
  zcodeThreadSource,
  piThreadSource,
  dshThreadSource,
  createDockerContainerOps,
  dockerBin,
  execDocker,
} from "@agentfabric/runtimes";

export interface ServerOptions {
  dataDir: string;
  staticDir?: string;
  /**
   * Absolute callback URL harness hooks POST to (v13 M3). The process entry
   * point passes the real listening port; tests pass their ephemeral one.
   */
  hookBaseUrl?: string;
  /**
   * Port to listen on. When given, the server listens itself and only resolves
   * once it accepts connections — the desktop app relies on that to load its
   * window without racing the socket. Omitted (the CLI entry point and tests
   * create their own HTTP server), it does not listen at all.
   */
  port?: number;
  /** Receives this server's own log lines (in addition to the console). */
  onLog?: (line: string) => void;
  /**
   * Restarts the server after POST `/api/settings/apply` has applied the
   * edited configuration file; `changed` names the top-level keys whose value
   * changed. Absent means "this host cannot restart me" and the endpoint
   * answers `restarted: false`, so the page says plainly that the running
   * process still holds the old configuration instead of implying a restart
   * happened.
   */
  restart?: (changed: string[]) => void;
  /**
   * Keys changed by the config file that this boot is applying (a restart
   * finished the apply). Recorded in the history so the page can still show
   * which section changed, even though the change happened in a process that
   * has since exited.
   */
  appliedFromRestart?: string[];
}

/** What `createServer` hands back: the Express app plus its teardown. */
export interface ServerHandle {
  app: Express;
  /**
   * Stops everything this server started: the background purge timer and the
   * processes/containers of the work in flight. **Synchronous on purpose** —
   * see the shutdown section in `createServer` for why it must not yield to
   * the event loop.
   */
  shutdown(): void;
  /** Raw HTTP upgrade handler for terminal websockets (v13 §5.1). */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * The listening server — present only when `ServerOptions.port` was given
   * (the server bound the port itself). Its upgrade handler is already wired.
   */
  server?: ReturnType<typeof createHttpServer>;
}

/**
 * Wraps an async route handler so a rejected promise reaches the error
 * middleware below. Express 4 does not catch rejections itself: without this,
 * a failed `await` (e.g. `store.persist()` hitting a full disk) leaves the
 * client waiting forever instead of answering 500.
 */
export const ah = <T extends RequestHandler>(fn: T): RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * CORS is reflected for loopback origins only (`http://localhost:<port>`,
 * `http://127.0.0.1:<port>`). Everything else gets no CORS header at all, so
 * a page on another origin cannot read a response even if it reaches the
 * port — and it cannot get a preflight approved for the custom headers below.
 */
/**
 * The built web UI, re-checked on each request.
 *
 * The dev loop starts the API server and the web build together, and the
 * build wins or loses that race depending on the machine. Looking the
 * directory up at boot would leave a server that started first serving 404s
 * until it was restarted, which is exactly the "I changed the UI and saw
 * nothing" trap. A missing build is reported as such (503), not as a blank
 * page.
 */
function staticDirCandidate(configured: string): string | undefined {
  if (existsSync(resolve(configured, "index.html"))) return configured;
  // The configured path is the first candidate the launcher found (or the
  // env override); re-probe the conventional locations so a later build lands.
  const enabled = process.env.AGENTFABRIC_WEB_DIR;
  if (enabled && existsSync(resolve(enabled, "index.html"))) return enabled;
  return undefined;
}

const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

/**
 * Keys in a hand-edited config file that this build does not know.
 *
 * A misspelled key would otherwise be stored and silently do nothing (the
 * file is the only writer, so there is no UI to catch the typo). The schema
 * served next to the file tells an editor the same thing; this is the server
 * refusing to accept the document.
 */
function unknownConfigKeys(config: AppConfig): string[] {
  const known = Object.keys(CONFIG_SCHEMA.properties);
  return Object.keys(config as Record<string, unknown>)
    .filter((key) => !known.includes(key))
    .sort();
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  return origin !== undefined && LOOPBACK_ORIGIN.test(origin);
}

/**
 * Whether a request path is under the API. Case-insensitive because Express's
 * router matches routes case-insensitively: `/API/providers` runs the same
 * handler as `/api/providers`, so the auth gate must treat them the same.
 */
function isApiPath(path: string): boolean {
  return path.toLowerCase().startsWith("/api");
}

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, origin?: string) => void) => {
    callback(null, isLoopbackOrigin(origin) ? origin : undefined);
  },
  // `Authorization` for the bearer token, `X-AgentFabric-Reveal` for the
  // explicit api-key reveal confirmation below.
  allowedHeaders: ["Authorization", "Content-Type", "X-AgentFabric-Reveal"],
};

/**
 * The placeholder the config read returns in place of every stored secret
 * (webhook URL path, header values). A write that sends it back verbatim
 * means "unchanged" — see `configFromClient`. Same token `maskSecret` uses.
 */
const REDACTED_SECRET = "***";

/**
 * Sets the browser's API credential as a middleware. Only plain page loads
 * get the cookie — API responses and static assets do not need it, and not
 * re-setting it keeps every API response free of credential material.
 */
const authCookie: (token: string) => RequestHandler = (token) => (req, res, next) => {
  if (req.method === "GET" && !isApiPath(req.path)) {
    res.cookie(TOKEN_COOKIE, token, { httpOnly: true, sameSite: "strict", path: "/" });
  }
  next();
};

/**
 * Extra guard on the one endpoint that returns a stored API key in the
 * clear: the caller must state the intent in a custom header. A cross-site
 * page cannot set a custom header without a CORS preflight, and this server
 * only approves preflights for loopback origins — so this is defense in
 * depth behind the token, not a substitute for it.
 */
const requireRevealConfirmation: RequestHandler = (req, res, next) => {
  if (req.get("X-AgentFabric-Reveal") !== "1") {
    res.status(403).json({
      error: "Revealing a stored API key requires the X-AgentFabric-Reveal: 1 header",
      code: "reveal-not-confirmed",
    });
    return;
  }
  next();
};

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
 * Domain failures carry their own HTTP status (v11 §22): a missing project is
 * a 404, a locked workspace or an existing branch is a 409, an auth failure
 * is a 403. The code is always forwarded so the UI can offer the right retry.
 */
function failDomain(res: Response, err: unknown): void {
  if (isDomainError(err)) {
    res.status(httpStatusForCode(err.code)).json({ error: err.message, code: err.code, stage: err.stage });
    return;
  }
  fail(res, err);
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
  // A domain error keeps its mapping (a named-but-missing runtime is a 502
  // with `runtime-create-failed`, not a 404 that hides the real cause);
  // plain errors keep the historical 404 default (a missing task).
  if (isDomainError(err)) return failDomain(res, err);
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

/**
 * Builds the API server and returns it together with its teardown.
 *
 * `createApp` (below) is the narrow form used by tests and callers that never
 * stop the server; the process entry point uses this one so SIGTERM/SIGINT
 * have something to call.
 */
export async function createServer(options: ServerOptions): Promise<ServerHandle> {
  // Route this server's log lines to the caller as well as the console: the
  // desktop app runs the server in its own process and needs the lines without
  // scraping its stdout. The callback runs *after* the line reached the
  // console, and a throwing or re-entrant callback must not affect logging —
  // an earlier version let the callback's own `console.log` re-enter this
  // wrapper and print forever. Restored by `shutdown()`.
  const onLog = options.onLog;
  const consoleLog = console.log;
  let inCallback = false;
  if (onLog) {
    console.log = (...args: unknown[]) => {
      consoleLog(...args);
      // The callback may log itself (the desktop app writes to stderr, but a
      // future caller may not). Re-entering here would print forever, so the
      // callback's own lines go to the console only.
      if (inCallback) return;
      inCallback = true;
      try {
        onLog(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
      } catch {
        /* the console line is the record; the callback is best-effort */
      } finally {
        inCallback = false;
      }
    };
  }

  const store = await Store.open(options.dataDir);
  await seedDefaults(store);

  /* ---------------- configuration file ---------------- */

  // See `./settings.ts`. The file is created **only when missing**, so a host
  // that starts the server directly (tests, embedders) still gets one. An
  // existing file is never rewritten here: an editor may hold it with unsaved
  // changes, and every rewrite changes the byte image whose hash the Settings
  // page compares against the applied revision — two writers, one file, and
  // every read would report an unapplied edit that nobody made.
  const configFile = configFilePath(store.dataDir);
  if (!existsSync(configFile)) {
    try {
      await writeConfigFile(configFile, store.config(), SCHEMA_REF);
    } catch (err) {
      throw new Error(
        `Could not write the configuration file ${configFile}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  /** The file content the running config was last synchronised with. */
  let appliedConfig = { revision: revisionOf((await readConfigFile(configFile)).text), at: new Date().toISOString() };
  let settingsHistory: SettingsHistoryEntry[] =
    options.appliedFromRestart && options.appliedFromRestart.length > 0
      ? [{ at: appliedConfig.at, source: "file", keys: options.appliedFromRestart }]
      : [];
  const recordSettingsChange = (source: SettingsHistoryEntry["source"], keys: string[], at: string) => {
    if (keys.length === 0) return;
    settingsHistory = [{ at, source, keys }, ...settingsHistory].slice(0, 20);
  };

  const bus = new EventBus();
  const registry = buildRegistry();

  const providers = new ProviderService(store);
  const models = new ModelService(store);

  /* ---------------- providers & models live in the config file ---------------- */
  //
  // `providers` in `<dataDir>/config.json` is the declaration; the store's
  // `providers` / `models` collections are the projection every consumer reads.
  // The two are synchronised in exactly two places:
  // - here, at boot — a file that declares providers replaces the projection
  //   (a provider removed from the file is removed); a file that declares none
  //   (an older file) is seeded *from* the projection once, so an install that
  //   configured its providers in the UI before this existed keeps them;
  // - after every write from the LLM page (`writeProvidersToConfig`), so the
  //   file is never stale relative to what the UI shows.
  const syncProvidersFromConfig = async (config: AppConfig): Promise<void> => {
    if (!config.providers) {
      // An install that configured its providers before they moved into the
      // file: copy the records into the file once. Their model ids were random;
      // the file's are `mod_<name>`, so a reference to a dropped id (the handoff
      // model) is rewritten to the model that now plays that role instead of
      // pointing at a model a restart cannot find.
      const legacy = store.list<Model>("models");
      const legacyHandoff = config.handoff?.modelId;
      const legacyModel = legacyHandoff ? legacy.find((m) => m.id === legacyHandoff) : undefined;
      if (store.list<Provider>("providers").length > 0) await writeProvidersToConfig();
      if (legacyModel) {
        const migrated = providers.list().find((p) => p.id === legacyModel.providerId);
        const current = (await readConfigFile(configFile)).parsed ?? {};
        const declaredName = current.providers
          ?.find((entry) => entry.id === migrated?.id)
          ?.models?.find((m) => m.name === legacyModel.name)?.name;
        if (declaredName) {
          await store.updateConfig({ handoff: { ...config.handoff, modelId: `mod_${declaredName}` } });
          const rewritten = (await readConfigFile(configFile)).parsed ?? {};
          await writeConfigFile(
            configFile,
            { ...rewritten, handoff: { ...(rewritten.handoff ?? {}), modelId: `mod_${declaredName}` } },
            SCHEMA_REF
          );
          appliedConfig = { revision: revisionOf((await readConfigFile(configFile)).text), at: appliedConfig.at };
        }
      }
      return;
    }
    const { providers: projected, models: projectedModels } = projectConfigProviders(config.providers);
    store.replaceCollection("providers", projected);
    store.replaceCollection("models", projectedModels);
    await store.updateConfig(config);
  };
  /** Writes the live provider/model records back into the file's `providers`. */
  const writeProvidersToConfig = async (): Promise<void> => {
    const current = (await readConfigFile(configFile)).parsed ?? {};
    const section = providersToConfigSection(providers.list(), models.list());
    await writeConfigFile(configFile, { ...current, providers: section }, SCHEMA_REF);
    const before = store.config();
    await store.updateConfig({ providers: section });
    appliedConfig = { revision: revisionOf((await readConfigFile(configFile)).text), at: new Date().toISOString() };
    recordSettingsChange("ui", changedConfigKeys(before, store.config()), appliedConfig.at);
  };
  await syncProvidersFromConfig(store.config());
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
  const projects = new ProjectService(store);
  const sourceCredentials = new SourceCredentialService(store);
  const workspaceLocks = new WorkspaceLockService(store);
  const runs = new RunService(store, bus, registry, createDockerContainerOps(), undefined, {
    codex: codexThreadSource,
    "claude-code": claudeCodeThreadSource,
    zcode: zcodeThreadSource,
    pi: piThreadSource,
    dsh: dshThreadSource,
  });
  // The board is a separate product surface from Project Coding Tasks: it
  // launches local CLIs in PTYs. Its records are not separate any more (a
  // board project is a Project, a started card is a Task with Runs), so it
  // writes through the same services.
  const kanban = new KanbanService(store, {
    projects,
    tasks,
    runs,
    workspaces,
    runtimes,
    runtimeSessions,
  });
  const kanbanRuntime = new KanbanSessionRuntime(kanban, {
    dataDir: store.dataDir,
    hookBaseUrl:
      options.hookBaseUrl ??
      `http://127.0.0.1:${process.env.AGENTFABRIC_PORT ?? 7377}/kanban-hooks/ingest`,
  });
  // The execution supervisor owns the Project-based task lifecycle (v11 §13).
  const supervisor = new ExecutionSupervisor(store, bus, runs);
  // Re-arm keep-alive idle timers from container labels after a restart.
  await runs.recoverKeepAliveContainers();
  // A restart leaves no lifecycle running: mark in-flight project tasks as
  // interrupted (workspace preserved) and reclaim their workspace locks.
  const recovered = await supervisor.recoverInterrupted();
  if (recovered.tasks.length > 0) {
    console.log(`[agent-fabric] marked ${recovered.tasks.length} interrupted project task(s) after restart: ${recovered.tasks.join(", ")}`);
  }
  // Board PTYs do not survive a restart either; the records must say so
  // instead of pretending a dead agent is still running (v13 §3.4).
  const interruptedSessions = await kanban.recoverInterrupted();
  if (interruptedSessions.length > 0) {
    console.log(`[agent-fabric] marked ${interruptedSessions.length} interrupted board session(s) after restart`);
  }
  // Per-session hook configs carry capability tokens; no session is live at
  // boot, so last run's leftovers are pruned. Worktrees are left alone.
  await pruneKanbanHooks(store.dataDir);

  // Background purge (失败要响): soft-deleted tasks older than the
  // retention window are physically removed with their runs, events,
  // artifacts, handoffs and session refs. Runs once at boot, then hourly;
  // a failing pass is logged loudly, never swallowed.
  const purgeDeletedTasks = async () => {
    try {
      const purged = await tasks.purgeExpired();
      if (purged.length > 0) console.log(`[agent-fabric] purged ${purged.length} expired deleted task(s): ${purged.join(", ")}`);
    } catch (err) {
      console.error("[agent-fabric] deleted-task purge failed:", err);
    }
  };
  await purgeDeletedTasks();
  const purgeTimer = setInterval(purgeDeletedTasks, 60 * 60 * 1000);
  purgeTimer.unref();

  const app = express();
  // The token is generated on first start and lives in the data directory
  // (`<dataDir>/token`, mode 0o600). It never reaches a log line, the store
  // or any response body.
  const token = await loadOrCreateToken(options.dataDir);
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "10mb" }));

  /* ---------------- authentication ---------------- */

  // Static assets stay open: the browser cannot load the page (and therefore
  // cannot obtain the cookie) if the page itself needs the cookie. Loading a
  // GET page is what hands the browser its credential.
  app.use(authCookie(token));

  // Everything under /api requires the token. `GET /api/health` is the one
  // exemption: it carries no sensitive information and is what a supervisor
  // or e2e script probes before any credential is available.
  //
  // The path test is case-insensitive on purpose: Express routes match
  // case-insensitively (`/API/providers` reaches the `/api/providers`
  // handler), so a case-sensitive gate here would leave an unauthenticated
  // route reachable by capitalization alone.
  const auth = requireToken(token);
  app.use((req, res, next) => {
    if (!isApiPath(req.path)) return next();
    if (req.method === "GET" && req.path.toLowerCase() === "/api/health") return next();
    // The config file's `$schema` points here, and a JSON-schema resolver in an
    // editor has no token: the schema is a description of the format, carries
    // no user data, and without it an editor cannot validate the file at all.
    // Every /api/settings/* route is matched case-insensitively here for the
    // same reason as the isApiPath test below.
    if (req.method === "GET" && req.path.toLowerCase() === "/api/settings/schema") return next();
    auth(req, res, next);
  });

  /* ---------------- board (v13) ---------------- */
  // Registered inside the authenticated /api region: the terminal data itself
  // travels over the websocket upgrade handler returned below.
  registerKanbanRoutes(app, { kanban, runtime: kanbanRuntime, projects, workspaces });

  /* ---------------- health ---------------- */

  app.get("/api/health", (_req, res) => ok(res, { status: "ok", time: new Date().toISOString() }));

  /**
   * Can this machine run a containerized runtime?
   *
   * A Project task refuses to run anywhere but an isolated runtime, so with no
   * Docker the user is stuck — and until now nothing on screen could tell them
   * whether Docker was missing, stopped, or fine. Two separate questions get two
   * separate answers: is the CLI there at all, and does the daemon respond.
   */
  app.get("/api/docker/status", async (_req, res) => {
    const bin = dockerBin();
    try {
      const version = await execDocker(["version", "--format", "{{.Server.Version}}"], 8_000);
      const serverVersion = version.stdout.trim();
      if (version.code !== 0 || !serverVersion) {
        // The CLI answered but the daemon did not: "installed but not running"
        // is a different fix from "not installed", so keep them apart.
        return ok(res, {
          available: false,
          binary: bin,
          reason: "daemon-unreachable",
          detail: (version.stderr || version.stdout).trim().slice(0, 400) || null,
        });
      }
      return ok(res, { available: true, binary: bin, version: serverVersion });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // ENOENT means the binary is not on PATH — report it as such rather than
      // as a generic failure the user cannot act on.
      const notInstalled = /ENOENT|not found/i.test(message);
      return ok(res, {
        available: false,
        binary: bin,
        reason: notInstalled ? "not-installed" : "probe-failed",
        detail: message.slice(0, 400),
      });
    }
  });

  //
  // Counts, not lists: this is the start page, and with thousands of tasks and
  // runs the difference is between sending 13 rows of numbers and sending every
  // record just to read `.length` off it.
  app.get("/api/dashboard", (_req, res) => {
    ok(res, {
      counts: {
        providers: providers.list().length,
        models: models.list().length,
        runtimes: runtimes.list().length,
        workspaces: workspaces.list().length,
        tasks: tasks.list({ deleted: false }).length,
        deletedTasks: tasks.list({ deleted: true }).length,
        runs: runs.list().length,
        artifacts: artifacts.list().length,
        secrets: secrets.list().length,
        agents: profiles.list().length,
        handoffs: handoffs.list().length,
        runtimeSessions: runtimeSessions.list().length,
        nativeStates: nativeStates.list().length,
        projects: projects.list().length,
        sourceCredentials: sourceCredentials.list().length,
      },
      usage: usage.summary(),
    });
  });

  /* ---------------- providers ---------------- */

  /**
   * A provider as the API hands it out: no key material.
   *
   * A provider declared in the config file may carry an inlined `apiKey`. That
   * record is the projection of a file the user can read anyway, but the API
   * still must not echo a raw key back as a field: `apiKeySecretId` is dropped
   * in favour of the masked `apiKeyMasked`, which is exactly what the Secret
   * store providers already expose.
   */
  const providerForClient = (p: Provider): Provider => ({
    ...p,
    apiKeySecretId: undefined,
    ...(p.apiKeyMasked ? { apiKeyMasked: p.apiKeyMasked } : {}),
  });

  app.get("/api/providers", (_req, res) => ok(res, providers.list().map(providerForClient)));
  app.post("/api/providers", async (req, res) => {
    try {
      const created = await providers.create(req.body);
      await writeProvidersToConfig();
      ok(res, providerForClient(created), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/providers/:id", (req, res) => {
    const p = providers.get(req.params.id);
    p ? ok(res, providerForClient(p)) : fail(res, new Error("Provider not found"), 404);
  });
  // Reveal the stored API key on demand (the eye button in the provider
  // editor). Raw keys never appear in list/get responses, only here — and
  // only for a caller that states the intent in a header (see
  // `requireRevealConfirmation`).
  app.get("/api/providers/:id/api-key", requireRevealConfirmation, ah(async (req, res) => {
    const p = providers.get(req.params.id);
    if (!p) return fail(res, new Error("Provider not found"), 404);
    // Two homes for a key (see `ConfigProvider`): the encrypted Secret store for
    // one typed into the form, the config file itself for one inlined there.
    if (p.apiKeySecretId) return ok(res, { apiKey: secrets.getWithValue(p.apiKeySecretId)?.value });
    const file = (await readConfigFile(configFile)).parsed ?? {};
    const entry = (file.providers ?? []).find((candidate) => candidate.id === p.id);
    ok(res, { apiKey: entry?.apiKey });
  }));
  app.put("/api/providers/:id", async (req, res) => {
    try {
      const p = await providers.update(req.params.id, req.body);
      if (!p) return fail(res, new Error("Provider not found"), 404);
      await writeProvidersToConfig();
      ok(res, providerForClient(p));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post(
    "/api/providers/:id/enable",
    ah(async (req, res) => {
      const p = await providers.setEnabled(req.params.id, true);
      if (!p) return fail(res, new Error("Provider not found"), 404);
      await writeProvidersToConfig();
      ok(res, providerForClient(p));
    })
  );
  app.post(
    "/api/providers/:id/disable",
    ah(async (req, res) => {
      const p = await providers.setEnabled(req.params.id, false);
      if (!p) return fail(res, new Error("Provider not found"), 404);
      await writeProvidersToConfig();
      ok(res, providerForClient(p));
    })
  );
  app.delete(
    "/api/providers/:id",
    ah(async (req, res) => {
      const removed = await providers.remove(req.params.id);
      if (!removed) return fail(res, new Error("Provider not found"), 404);
      await writeProvidersToConfig();
      ok(res, { ok: true });
    })
  );

  /* ---------------- models ---------------- */

  app.get("/api/models", (_req, res) => ok(res, models.list()));
  app.post("/api/models", async (req, res) => {
    try {
      const created = await models.create(req.body);
      await writeProvidersToConfig();
      ok(res, created, 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get("/api/models/:id", (req, res) => {
    const m = models.get(req.params.id);
    m ? ok(res, m) : fail(res, new Error("Model not found"), 404);
  });
  app.put(
    "/api/models/:id",
    ah(async (req, res) => {
      const m = await models.update(req.params.id, req.body);
      if (!m) return fail(res, new Error("Model not found"), 404);
      await writeProvidersToConfig();
      ok(res, m);
    })
  );
  app.delete(
    "/api/models/:id",
    ah(async (req, res) => {
      const removed = await models.remove(req.params.id);
      if (!removed) return fail(res, new Error("Model not found"), 404);
      await writeProvidersToConfig();
      ok(res, { ok: true });
    })
  );

  /* ---------------- runtimes ---------------- */

  // `?usableInTask=true` serves the task composers' runtime list: enabled
  // runtimes the product allows to execute a task. The list is the server's
  // decision — the client renders it, it does not re-derive it; submit and
  // continue enforce the same rule server-side.
  app.get("/api/runtimes", (req, res) => {
    if (req.query.usableInTask === "true") {
      return ok(res, runtimes.enabled().filter((r) => r.usableInTask));
    }
    ok(res, runtimes.list());
  });
  // The runtimes a Project Coding Task may actually use (v11 hardening §4):
  // enabled, usable in tasks, and isolated. The Projects/Task forms read this
  // so the user is never offered a runtime that will be refused at submit.
  app.get("/api/runtimes/project-eligible", (_req, res) => {
    ok(
      res,
      runtimes
        .enabled()
        .filter((r) => r.usableInTask && runtimeIsolation(r).sandboxed)
        .map((r) => ({ ...r, isolation: runtimeIsolation(r) }))
    );
  });
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
  app.put(
    "/api/runtimes/:id",
    ah(async (req, res) => {
      const r = await runtimes.update(req.params.id, req.body);
      r ? ok(res, r) : fail(res, new Error("Runtime not found"), 404);
    })
  );
  app.post(
    "/api/runtimes/:id/enable",
    ah(async (req, res) => {
      const r = await runtimes.setEnabled(req.params.id, true);
      r ? ok(res, r) : fail(res, new Error("Runtime not found"), 404);
    })
  );
  app.post(
    "/api/runtimes/:id/disable",
    ah(async (req, res) => {
      const r = await runtimes.setEnabled(req.params.id, false);
      r ? ok(res, r) : fail(res, new Error("Runtime not found"), 404);
    })
  );
  app.delete(
    "/api/runtimes/:id",
    ah(async (req, res) => {
      const removed = await runtimes.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Runtime not found"), 404);
    })
  );

  // Effective harness capabilities (spec v1 §17): adapter declarations
  // overridden by the runtime record.
  app.get("/api/runtimes/:id/capabilities", (req, res) => {
    const r = runtimes.get(req.params.id);
    if (!r) return fail(res, new Error("Runtime not found"), 404);
    ok(res, effectiveCapabilities(registry.get(r.kind), r));
  });

  // Isolation verdict (v11 hardening §4.2): read from capability metadata
  // (`executionBackend` / `containerized` / `image`), never from the name.
  app.get("/api/runtimes/:id/isolation", (req, res) => {
    const r = runtimes.get(req.params.id);
    if (!r) return fail(res, new Error("Runtime not found"), 404);
    ok(res, runtimeIsolation(r));
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
  app.put(
    "/api/workspaces/:id",
    ah(async (req, res) => {
      const w = await workspaces.update(req.params.id, req.body);
      w ? ok(res, w) : fail(res, new Error("Workspace not found"), 404);
    })
  );
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
  app.delete(
    "/api/workspaces/:id",
    ah(async (req, res) => {
      const removed = await workspaces.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Workspace not found"), 404);
    })
  );

  /* ---------------- secrets ---------------- */

  app.get("/api/secrets", (_req, res) => ok(res, secrets.list()));
  app.post("/api/secrets", async (req, res) => {
    try {
      ok(res, await secrets.create(req.body), 201);
    } catch (e) {
      fail(res, e);
    }
  });
  app.delete(
    "/api/secrets/:id",
    ah(async (req, res) => {
      const removed = await secrets.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Secret not found"), 404);
    })
  );

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
  app.put(
    "/api/agents/:id",
    ah(async (req, res) => {
      const p = await profiles.update(req.params.id, req.body);
      p ? ok(res, p) : fail(res, new Error("Agent not found"), 404);
    })
  );
  app.delete(
    "/api/agents/:id",
    ah(async (req, res) => {
      const removed = await profiles.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Agent not found"), 404);
    })
  );

  /* ---------------- projects (v11 §2/§3) ---------------- */

  app.get("/api/projects", (_req, res) => ok(res, projects.list()));
  app.post("/api/projects", async (req, res) => {
    try {
      ok(res, await projects.create(req.body), 201);
    } catch (e) {
      failDomain(res, e);
    }
  });
  app.get("/api/projects/:id", (req, res) => {
    const p = projects.get(req.params.id);
    p ? ok(res, p) : fail(res, new Error("Project not found"), 404);
  });
  app.put("/api/projects/:id", async (req, res) => {
    try {
      const p = await projects.update(req.params.id, req.body);
      p ? ok(res, p) : fail(res, new Error("Project not found"), 404);
    } catch (e) {
      failDomain(res, e);
    }
  });
  app.delete(
    "/api/projects/:id",
    ah(async (req, res) => {
      const removed = await projects.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Project not found"), 404);
    })
  );
  // Tasks that belong to this project (the Project detail page's list).
  app.get("/api/projects/:id/tasks", (req, res) => {
    if (!projects.get(req.params.id)) return fail(res, new Error("Project not found"), 404);
    const ids = new Set(projects.taskIds(req.params.id));
    ok(res, tasks.list({ deleted: false }).filter((t) => ids.has(t.id)));
  });

  // Start a Project-based Task (v11 §39): the platform creates the managed
  // workspace, prepares the source and runs the whole lifecycle. Users never
  // create a Workspace by hand. The body is the `StartProjectTaskInput`
  // contract verbatim — including the Task-level `skills` / `mcpServers`
  // overrides (v11 §25/§26), which fall back to the Project's lists when the
  // field is absent.
  app.post("/api/projects/:id/tasks", async (req, res) => {
    if (!projects.get(req.params.id)) return fail(res, new Error("Project not found"), 404);
    try {
      const body = (req.body ?? {}) as Partial<StartProjectTaskInput>;
      const result = await supervisor.startTask({ ...body, projectId: req.params.id } as StartProjectTaskInput);
      ok(res, result, 201);
    } catch (e) {
      failDomain(res, e);
    }
  });

  /* ---------------- source credentials (v11 §4) ---------------- */
  // Sensitive values live in Secrets; these endpoints only ever return
  // metadata plus the masked preview (v11 §4.2).

  app.get("/api/source-credentials", (_req, res) => ok(res, sourceCredentials.list()));
  app.post("/api/source-credentials", async (req, res) => {
    try {
      ok(res, await sourceCredentials.create(req.body), 201);
    } catch (e) {
      failDomain(res, e);
    }
  });
  app.get("/api/source-credentials/:id", (req, res) => {
    const c = sourceCredentials.getView(req.params.id);
    c ? ok(res, c) : fail(res, new Error("Source credential not found"), 404);
  });
  app.put("/api/source-credentials/:id", async (req, res) => {
    try {
      const c = await sourceCredentials.update(req.params.id, req.body);
      c ? ok(res, c) : fail(res, new Error("Source credential not found"), 404);
    } catch (e) {
      failDomain(res, e);
    }
  });
  app.delete(
    "/api/source-credentials/:id",
    ah(async (req, res) => {
      const removed = await sourceCredentials.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Source credential not found"), 404);
    })
  );

  /* ---------------- tasks ---------------- */

  // Reads and lifecycle actions only. A Task is never created here: it is
  // either started in a Project (`POST /api/projects/:id/tasks`, which owns
  // the managed Workspace and the whole lifecycle) or submitted as a classic
  // non-project run (`POST /api/runs`). A bare `insert` of a task row would
  // produce a record with no Runtime resolution, Workspace or Run — a shape
  // no other endpoint accepts.
  //
  // Live tasks by default; `?deleted=true` serves the recoverable-deleted
  // list (Trash). A deleted task is invisible to task-scoped reads and
  // actions until restored.
  app.get("/api/tasks", (req, res) => ok(res, tasks.list({ deleted: req.query.deleted === "true" })));
  app.get("/api/tasks/:id", (req, res) => {
    const t = tasks.getLive(req.params.id);
    t ? ok(res, t) : fail(res, new Error("Task not found"), 404);
  });
  // Soft delete: the task (with its runs and history) stays recoverable
  // until the retention window expires and the purge pass removes it.
  app.delete(
    "/api/tasks/:id",
    ah(async (req, res) => {
      const t = await tasks.softDelete(req.params.id);
      t ? ok(res, t) : fail(res, new Error("Task not found"), 404);
    })
  );
  app.post(
    "/api/tasks/:id/restore",
    ah(async (req, res) => {
      const t = await tasks.restore(req.params.id);
      t ? ok(res, t) : fail(res, new Error("Deleted task not found"), 404);
    })
  );
  // Rename in place, and detach from a workspace. A task's prompt and runtime
  // are what its runs were recorded against, so they are not editable here; the
  // title and the workspace link are labels, and both are editable. An empty
  // title is a caller error, not "clear it"; an empty workspaceId *is* the way
  // to clear the link.
  app.patch(
    "/api/tasks/:id",
    ah(async (req, res) => {
      const body = req.body as { title?: unknown; workspaceId?: unknown };
      const patch: { title?: string; workspaceId?: string } = {};
      if (body?.title !== undefined) {
        if (typeof body.title !== "string") {
          return fail(res, new DomainError("config-invalid", "title must be a string"), 400);
        }
        const title = body.title.trim();
        if (!title) return fail(res, new DomainError("config-invalid", "A task title cannot be empty"), 400);
        patch.title = title;
      }
      // `workspaceId: ""` detaches the task from its workspace (used when a
      // workspace is deleted); any other value must name a workspace that
      // exists, so a typo cannot leave a dangling reference behind.
      if (body?.workspaceId !== undefined) {
        if (typeof body.workspaceId !== "string") {
          return fail(res, new DomainError("config-invalid", "workspaceId must be a string"), 400);
        }
        const workspaceId = body.workspaceId.trim();
        if (workspaceId && !workspaces.get(workspaceId)) {
          return fail(res, new DomainError("workspace-invalid", `Workspace not found: ${workspaceId}`), 404);
        }
        patch.workspaceId = workspaceId;
      }
      if (Object.keys(patch).length === 0) {
        return fail(res, new DomainError("config-invalid", "PATCH /api/tasks/:id accepts { title, workspaceId }"), 400);
      }
      const t = await tasks.update(req.params.id, patch);
      t ? ok(res, t) : fail(res, new Error("Task not found"), 404);
    })
  );
  app.get("/api/tasks/:id/runs", (req, res) => ok(res, runs.forTask(req.params.id)));

  /* ---------------- project task lifecycle (v11 §23/§31/§32/§40) ---------------- */

  // Task Detail: everything the page needs to answer "is the agent
  // developing, testing, committing or pushing" — project, source, base ref
  // and commit, working branch, workspace, phase, the three statuses, the
  // final commit and the remote branch.
  app.get("/api/tasks/:id/detail", (req, res) => {
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
    try {
      ok(res, supervisor.taskDetail(req.params.id));
    } catch (e) {
      failDomain(res, e);
    }
  });

  // Cancel: the runtime is stopped, cleanup runs, the workspace and its
  // uncommitted modifications survive (v11 §32).
  app.post("/api/tasks/:id/cancel", async (req, res) => {
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
    try {
      const task = await supervisor.cancelTask(req.params.id);
      task ? ok(res, task) : fail(res, new Error("Task not found"), 404);
    } catch (e) {
      failDomain(res, e);
    }
  });

  // Retry Agent Run: a NEW run continues on the same workspace (v11 §31).
  app.post("/api/tasks/:id/retry-run", async (req, res) => {
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
    try {
      const body = (req.body ?? {}) as { instruction?: string; runtimeId?: string; modelId?: string };
      ok(res, await supervisor.retryRun(req.params.id, body), 201);
    } catch (e) {
      failDomain(res, e);
    }
  });

  // Retry Validation: re-runs validation only — no agent, no model call.
  app.post("/api/tasks/:id/retry-validation", async (req, res) => {
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
    try {
      const task = await supervisor.retryValidation(req.params.id);
      task ? ok(res, task) : fail(res, new Error("Task not found"), 404);
    } catch (e) {
      failDomain(res, e);
    }
  });

  // Retry Publish: re-pushes the already-committed revision — no agent, no
  // model call (v11 §23/§31).
  app.post("/api/tasks/:id/retry-publish", async (req, res) => {
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
    try {
      const task = await supervisor.retryPublish(req.params.id);
      task ? ok(res, task) : fail(res, new Error("Task not found"), 404);
    } catch (e) {
      failDomain(res, e);
    }
  });

  // Workspace locks currently held (one writer per managed workspace, §36).
  app.get("/api/workspace-locks", (_req, res) => ok(res, workspaceLocks.list()));

  // Task Thread read model (v5 §24/§35): an aggregate of everything the
  // thread page renders — task, workspace, and per-run events, artifacts
  // and consumed handoff. Pure projection over existing records; no new
  // Message/Conversation/Session domain model.
  app.get(
    "/api/tasks/:id/thread",
    ah(async (req, res) => {
      const task = tasks.getLive(req.params.id);
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
        runs: await Promise.all(
          taskRuns.map(async (run) => ({
            run,
            events: await runs.events(run.id),
            artifacts: artifacts.list(run.id),
            previousHandoff: run.previousHandoffId ? handoffs.get(run.previousHandoffId) ?? null : null,
          }))
        ),
      });
    })
  );

  // Preview of the resume-vs-handoff decision (spec v1 §18: make the
  // continuity explicit before executing).
  app.get("/api/tasks/:id/continue-options", (req, res) => {
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
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
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
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
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
    try {
      const body = (req.body ?? {}) as { runtimeId?: string };
      ok(res, await runs.generateHandoff(req.params.id, body.runtimeId, { signal: requestAbort(res) }), 201);
    } catch (e) {
      failContinue(res, e);
    }
  });

  // Explicit native-thread sync for a task that adopted a harness session
  // (v6 §8): re-read the harness's own thread and append the turns that
  // happened there after adoption. The task page's Refresh button is the
  // only trigger — there is no background polling.
  app.post("/api/tasks/:id/sync-thread", async (req, res) => {
    if (!tasks.getLive(req.params.id)) return fail(res, new Error("Task not found"), 404);
    try {
      ok(res, await runs.syncImportedThread(req.params.id));
    } catch (e) {
      fail(res, e);
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
  app.post(
    "/api/runs/:id/cancel",
    ah(async (req, res) => {
      const r = await runs.cancel(req.params.id);
      r ? ok(res, r) : fail(res, new Error("Run not found"), 404);
    })
  );
  app.get("/api/runs/:id/events", ah(async (req, res) => ok(res, await runs.events(req.params.id))));
  app.get(
    "/api/runs/:id/logs",
    ah(async (req, res) => {
      res.type("text/plain").send((await runs.logs(req.params.id)).join("\n"));
    })
  );

  // SSE: real-time events for a single run.
  app.get(
    "/api/runs/:id/events/stream",
    ah(async (req, res) => {
      const runId = req.params.id;
      sseHeaders(res);
      const initial = await runs.events(runId);
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
    })
  );

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
  // NOTE: registered before "/api/handoffs/:id" so "model" is never read as an id.
  //
  // The handoff summarizer model (Handoffs page). Stored in config
  // (`handoff.modelId`); unset = the covered run's own model, else the first
  // enabled model. Setting one validates loudly: a model the handoff path
  // could not use is rejected here, and one that turns unusable later fails
  // generation loudly instead of silently falling back (orchestrator).
  app.get("/api/handoffs/model", (_req, res) => {
    const modelId = store.config().handoff?.modelId;
    const model = modelId ? models.get(modelId) : undefined;
    const provider = model ? providers.get(model.providerId) : undefined;
    ok(res, {
      modelId: modelId ?? null,
      modelName: model ? (model.alias ?? model.name) : undefined,
      providerName: provider?.name,
      // Only meaningful when something is configured.
      ...(modelId ? { usable: Boolean(model?.enabled && provider?.enabled) } : {}),
    });
  });
  app.put(
    "/api/handoffs/model",
    ah(async (req, res) => {
      const { modelId } = (req.body ?? {}) as { modelId?: string | null };
      if (modelId == null || modelId === "") {
        await store.updateConfig({ handoff: {} });
        return ok(res, { modelId: null });
      }
      const model = models.get(modelId);
      if (!model || !model.enabled) return fail(res, `Model not found or disabled: ${modelId}`, 404);
      const provider = providers.get(model.providerId);
      if (!provider || !provider.enabled) return fail(res, `The model's provider is missing or disabled: ${modelId}`, 400);
      await store.updateConfig({ handoff: { modelId } });
      ok(res, { modelId: model.id, modelName: model.alias ?? model.name, providerName: provider.name, usable: true });
    })
  );
  app.get("/api/handoffs/:id", (req, res) => {
    const h = handoffs.get(req.params.id);
    if (!h) return fail(res, new Error("Handoff not found"), 404);
    // Rendered body = the exact text the consuming harness receives ahead of
    // its `# Your instruction`; consumers let the UI link to that full text.
    const consumedByRunIds = runs.list().filter((r) => r.previousHandoffId === h.id).map((r) => r.id);
    ok(res, { ...h, renderedPrompt: renderHandoffBody(h), consumedByRunIds });
  });
  // Fold user-provided notes into an existing handoff (spec v1 §7).
  //
  // Routed through `ah`: a rejected `await` here must reach the error
  // middleware, never surface as an unhandled rejection (which kills the
  // process). `notes` is validated as a string up front — a JSON number or
  // object would otherwise throw on `.trim()`.
  app.post(
    "/api/handoffs/:id/notes",
    ah(async (req, res) => {
      const notes = (req.body as { notes?: unknown } | undefined)?.notes;
      if (typeof notes !== "string" || !notes.trim()) {
        return fail(res, new Error("notes is required"));
      }
      const h = await handoffs.addUserNotes(req.params.id, notes);
      h ? ok(res, h) : fail(res, new Error("Handoff not found"), 404);
    })
  );
  app.delete(
    "/api/handoffs/:id",
    ah(async (req, res) => {
      const removed = await handoffs.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Handoff not found"), 404);
    })
  );

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
  app.post(
    "/api/runtime-sessions/:id/expire",
    ah(async (req, res) => {
      const s = await runtimeSessions.expire(req.params.id);
      s ? ok(res, s) : fail(res, new Error("Runtime session not found"), 404);
    })
  );
  app.delete(
    "/api/runtime-sessions/:id",
    ah(async (req, res) => {
      const removed = await runtimeSessions.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Runtime session not found"), 404);
    })
  );

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
  app.delete(
    "/api/native-states/:id",
    ah(async (req, res) => {
      const removed = await nativeStates.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Native state not found"), 404);
    })
  );

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
      // `res.type()` throws on a malformed mime, and the throw would land in
      // the error middleware *after* the header is half-set — answer with a
      // plain text/plain instead of crashing the request. A bad mime on a
      // stored artifact is data, not a platform failure; the fallback is
      // logged so it is visible rather than silent.
      try {
        res.type(a.mime ?? "text/plain");
      } catch {
        console.error(`[agent-fabric] artifact ${a.id} has an invalid mime (${JSON.stringify(a.mime)}); serving as text/plain`);
        res.type("text/plain");
      }
      res.send(a.content);
    } else if (a.path) {
      res.send({ path: a.path, note: "Artifact is stored on disk; use workspace path to read it." });
    } else {
      fail(res, new Error("Artifact has no content"), 404);
    }
  });
  app.delete(
    "/api/artifacts/:id",
    ah(async (req, res) => {
      const removed = await artifacts.remove(req.params.id);
      removed ? ok(res, { ok: true }) : fail(res, new Error("Artifact not found"), 404);
    })
  );

  /* ---------------- usage & config ---------------- */

  app.get("/api/usage", (_req, res) => ok(res, usage.summary()));

  /**
   * A webhook URL *is* its credential (Slack's incoming webhooks are the path
   * itself), so the read is redacted the same way `DeliveryResult.url` is.
   * Header values are credentials too — a webhook commonly authenticates with
   * `Authorization: Bearer …` — so every value is replaced by a fixed mask;
   * header *names* survive, since they are routing information a settings UI
   * needs to display. The write returns the same redacted shape — echoing the
   * URL back would put the secret in the browser for no benefit, since the
   * caller just sent it. `urlSet` tells a client whether a webhook is
   * configured without revealing which one.
   */
  const configForClient = () => {
    const config = store.config();
    const notifications = config.notifications;
    if (!notifications) return config;
    const { url, headers, ...rest } = notifications;
    return {
      ...config,
      notifications: {
        ...rest,
        ...(url ? { url: redactWebhookUrl(url), urlSet: true } : { urlSet: false }),
        ...(headers ? { headers: Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED_SECRET])) } : {}),
      },
    };
  };

  /**
   * The inverse of `configForClient`, for the write path.
   *
   * Every config client edits by round-trip — `af config <key> <value>` and
   * the Settings page both GET the document, change one field and PUT the
   * whole thing back — so the redacted values come back in the body. Storing
   * them verbatim would replace the real secrets with placeholders, silently:
   * the URL placeholder is a syntactically valid URL and the header mask is
   * just a string, so nothing downstream would complain. An incoming value
   * that is exactly the redacted form of the stored one therefore means
   * "unchanged"; anything else is stored as sent. `urlSet` is a read-side
   * projection and is never persisted.
   *
   * The shape is validated here rather than trusted: a non-string URL (or a
   * non-object `notifications`) would otherwise be persisted and poison every
   * later read (`redactWebhookUrl` calls `url.replace`) and the notification
   * delivery path. Throwing makes the PUT answer 400 while the stored config
   * stays untouched.
   */
  const configFromClient = (body: unknown): AppConfig => {
    const incoming = (body ?? {}) as Record<string, unknown>;
    const next = incoming.notifications;
    if (next === undefined || next === null) return incoming as AppConfig;
    if (typeof next !== "object" || Array.isArray(next)) {
      throw new DomainError("config-invalid", "notifications must be an object");
    }
    const { urlSet: _urlSet, ...notifications } = next as Record<string, unknown>;
    const storedNotifications = store.config().notifications;
    const stored = storedNotifications?.url;
    if (notifications.url !== undefined && typeof notifications.url !== "string") {
      throw new DomainError("config-invalid", "notifications.url must be a string");
    }
    const url =
      typeof notifications.url === "string" && stored && notifications.url === redactWebhookUrl(stored)
        ? stored
        : notifications.url;
    const headers = notifications.headers;
    let restoredHeaders: Record<string, string> | undefined;
    if (headers !== undefined) {
      if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
        throw new DomainError("config-invalid", "notifications.headers must be an object of strings");
      }
      const storedHeaders = storedNotifications?.headers ?? {};
      restoredHeaders = Object.fromEntries(
        Object.entries(headers as Record<string, unknown>).map(([name, value]) => {
          if (typeof value !== "string") {
            throw new DomainError("config-invalid", `notifications.headers["${name}"] must be a string`);
          }
          // The mask means "unchanged": restore the stored value for this
          // exact header name (matched case-insensitively, like HTTP).
          if (value === REDACTED_SECRET) {
            const storedName = Object.keys(storedHeaders).find((k) => k.toLowerCase() === name.toLowerCase());
            if (storedName === undefined) {
              throw new DomainError(
                "config-invalid",
                `notifications.headers["${name}"] is masked but no stored value exists — send the real value or omit the header`
              );
            }
            return [name, storedHeaders[storedName]];
          }
          return [name, value];
        })
      );
    }
    return {
      ...incoming,
      notifications: {
        ...notifications,
        ...(url !== undefined ? { url } : {}),
        ...(restoredHeaders !== undefined ? { headers: restoredHeaders } : {}),
      },
    } as AppConfig;
  };

  /**
   * The running config and the file it is kept in.
   *
   * `pending` is what makes hand editing safe to reason about: it says the file
   * on disk is not what this process is running — because it failed to parse,
   * or because it was edited after the last apply — so the Settings page can
   * offer "apply and restart" instead of implying the edit already took effect.
   */
  const settingsFileInfo = async (file?: ConfigFileRead): Promise<SettingsFileInfo> => {
    const current = file ?? (await readConfigFile(configFile));
    const pending = current.parsed === undefined || current.revision !== appliedConfig.revision;
    return { path: configFile, config: configForClient(), file: current, pending };
  };

  app.get("/api/config", (_req, res) => ok(res, configForClient()));
  app.put(
    "/api/config",
    ah(async (req, res) => {
      try {
        const before = store.config();
        const next = configFromClient(req.body);
        const at = new Date().toISOString();
        // A save replaces the settings it names and keeps everything else.
        //
        // Two rules, both learned the hard way:
        // - **The file's key set wins.** Sections the file on disk no longer
        //   has are dropped even if the running config still carries them, so
        //   deleting a key by hand and pressing apply removes it. (Merging over
        //   the in-memory config instead made a deleted `docker` block come
        //   back on the next save from the UI.)
        // - **Nothing read-side is written back.** `urlSet`, the redacted
        //   webhook form and `$schema` describe the document; storing them as
        //   settings would put a placeholder over a real webhook URL. `server`
        //   belongs to the entry point (the address the process bound) and is
        //   carried over untouched.
        const onDisk = (await readConfigFile(configFile)).parsed ?? {};
        const stored: Record<string, unknown> = { ...(onDisk as Record<string, unknown>) };
        if (!("server" in stored) && "server" in before) stored.server = (before as Record<string, unknown>).server;
        for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
          if (key === "$schema" || key === "server") continue;
          if (value === undefined || value === null || (typeof value === "object" && Object.keys(value).length === 0)) {
            delete stored[key];
          } else {
            stored[key] = value;
          }
        }
        // The file is written first: a save the server accepted must be the
        // same document a later restart reads.
        await writeConfigFile(configFile, stored as AppConfig, SCHEMA_REF);
        await store.updateConfig(stored as AppConfig);
        appliedConfig = { revision: revisionOf((await readConfigFile(configFile)).text), at };
        recordSettingsChange("ui", changedConfigKeys(before, stored as AppConfig), at);
      } catch (e) {
        return failDomain(res, e);
      }
      ok(res, configForClient());
    })
  );

  /* ---------------- settings file ---------------- */

  app.get("/api/settings/schema", (_req, res) => ok(res, CONFIG_SCHEMA));

  app.get(
    "/api/settings/file",
    ah(async (_req, res) => ok(res, { ...(await settingsFileInfo()), applied: appliedConfig, history: settingsHistory }))
  );

  /**
   * Opens the config file in the host's text editor.
   *
   * Pathless on purpose: the client names an action, not a path — a browser page
   * must not be able to ask a server that can run processes to open an arbitrary
   * file. macOS gets `open -t`, which forces the default *text* editor and
   * bypasses a `.json` file association; other platforms use the desktop opener.
   */
  app.post(
    "/api/settings/open",
    ah(async (_req, res) => {
      // The file is the record of the running config, so it always exists by the
      // time a server answers; a missing one is the entry point's problem.
      if (!existsSync(configFile)) {
        return fail(res, new Error(`The configuration file ${configFile} does not exist`), 500);
      }
      const [bin, args] =
        process.platform === "darwin"
          ? ["open", ["-t", configFile]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", configFile]]
            : ["xdg-open", [configFile]];
      await new Promise<void>((resolve, reject) => {
        execFile(bin, args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
      }).catch((err: unknown) => {
        throw new DomainError(
          "settings-open-failed",
          `Could not open ${configFile}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      ok(res, { path: configFile });
    })
  );

  /**
   * Validates the file on disk without applying it.
   *
   * The Settings page uses this to say whether a restart would come back clean
   * before it offers one — a restart over a broken file would bring the server
   * up on whatever it last ran.
   */
  app.get(
    "/api/settings/validate",
    ah(async (_req, res) => {
      const file = await readConfigFile(configFile);
      const unknown = file.parsed ? unknownConfigKeys(file.parsed) : [];
      ok(res, {
        path: configFile,
        ok: file.parsed !== undefined && unknown.length === 0,
        error: file.error,
        unknownKeys: unknown,
        revision: file.revision,
        appliedRevision: appliedConfig.revision,
      });
    })
  );

  /**
   * Applies the file on disk: writes it into the store, then triggers the
   * caller's restart hook. `ok` never means "now running": the store is
   * updated synchronously but the process that reads the file's effect (the
   * supervisor's model choice, harness processes) is only restarted after the
   * response, so the answer says what happened and what is about to.
   */
  app.post(
    "/api/settings/apply",
    ah(async (_req, res) => {
      const file = await readConfigFile(configFile);
      if (!file.parsed) return fail(res, new Error(`The configuration file could not be parsed: ${file.error}`), 400);
      const unknown = unknownConfigKeys(file.parsed);
      if (unknown.length > 0) {
        return fail(res, new Error(`Unknown configuration key(s): ${unknown.join(", ")}`), 400);
      }
      if (file.revision === appliedConfig.revision) {
        return ok(res, { ok: true, applied: false, restarted: false, path: configFile });
      }
      let changed: string[] = [];
      try {
        const before = store.config();
        await store.updateConfig(file.parsed);
        const at = new Date().toISOString();
        appliedConfig = { revision: file.revision, at };
        // A hand-edited provider list takes effect with the rest of the file:
        // the projection is rebuilt from the document just applied.
        if (file.parsed.providers) {
          const { providers: projected, models: projectedModels } = projectConfigProviders(file.parsed.providers);
          store.replaceCollection("providers", projected);
          store.replaceCollection("models", projectedModels);
        }
        changed = changedConfigKeys(before, file.parsed);
        recordSettingsChange("file", changed, at);
      } catch (e) {
        return failDomain(res, e);
      }
      const restarted = options.restart !== undefined;
      if (restarted) {
        // After the response: the caller must learn that the apply succeeded
        // even though its own connection is about to go away.
        res.on("finish", () => {
          try {
            options.restart?.(changed);
          } catch (err) {
            console.error("[agent-fabric] restart after applying the configuration file failed:", err);
          }
        });
      }
      ok(res, { ok: true, applied: true, restarted, path: configFile });
    })
  );

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

  /* ---------------- errors ---------------- */
  //
  // Registered after every route: a handler routed through `ah` (or one that
  // calls `next(err)` itself) ends up here. Domain failures keep their stable
  // code → HTTP mapping (`failDomain`); a client error the middleware itself
  // produced (body-parser rejects a malformed JSON body with `.status` 400,
  // an oversized one with 413) answers that status instead of a misleading
  // 500; anything else is a platform bug and answers 500 instead of leaving
  // the request open.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (isDomainError(err)) return failDomain(res, err);
    const clientStatus = (err as { status?: unknown } | undefined)?.status;
    const isClientError = typeof clientStatus === "number" && clientStatus >= 400 && clientStatus < 500;
    if (!isClientError) console.error("[agent-fabric] unhandled error in request handler:", err);
    const message = err instanceof Error ? err.message : String(err);
    const status = isClientError ? clientStatus : 500;
    const body = { error: message, code: isClientError ? "invalid-request" : "internal-error" };
    // The failing handler may have set a Content-Type this response cannot
    // serialize under (that is exactly how one artifact bug produced a 500
    // whose body was a stack trace): drop it, and if `.json()` still throws,
    // end the response so the client is never left waiting.
    res.removeHeader("Content-Type");
    try {
      res.status(status).json(body);
    } catch {
      res.status(status).end();
    }
  });

  /* ---------------- static web UI ---------------- */

  const configuredStaticDir = options.staticDir;
  if (configuredStaticDir) {
    // Resolved per request rather than only at boot: the dev loop starts the
    // API server before (or while) the first web build finishes, and a build
    // that lands later must be served without restarting the server.
    //
    // Vite emits content-hashed file names under `assets/` and an unhashed
    // `index.html`. Caching the hashed files forever removes every revalidation
    // from the window's second and later loads (the desktop app is the main
    // consumer: same files, same machine, no network); `index.html` must stay
    // uncached so a rebuilt UI is picked up. Without this, every asset was
    // re-validated on each start — a loopback round trip each, but the
    // revalidation also delays first paint.
    const staticOptions = { setHeaders: (res: Response, filePath: string) => {
      if (filePath.includes(`${sep}assets${sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    } };
    app.use((req, res, next) => {
      const dir = staticDirCandidate(configuredStaticDir);
      if (!dir) {
        next();
        return;
      }
      express.static(dir, staticOptions)(req, res, next);
    });
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      const dir = staticDirCandidate(configuredStaticDir);
      if (!dir) {
        res
          .status(503)
          .type("text/plain")
          .send("The web UI is not built yet. Run `npm run build:web` (or `npm run dev`, which watches it).");
        return;
      }
      res.sendFile("index.html", { root: dir });
    });
  }

  /* ---------------- shutdown ---------------- */

  // The work this process is still doing. A shutdown must stop it, and the
  // records must not claim anything about it (v11 §32: only the user
  // cancels): the Run keeps the phase the lifecycle last wrote, and the next
  // start's `recoverInterrupted()` reads that phase and names the honest next
  // step (retry agent / validation / publish).
  const inFlightTaskIds = () => tasks.list({ deleted: false }).filter((t) => supervisor.isRunning(t.id)).map((t) => t.id);
  const inFlightRunIds = () => runs.list().filter((r) => runs.isExecuting(r.id)).map((r) => r.id);

  let stopped = false;
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(purgeTimer);
    if (onLog) console.log = consoleLog;
    // Board PTYs are host processes too; kill them before anything else can
    // return early. Their records stay non-terminal and the next boot marks
    // them interrupted (recoverInterrupted).
    kanbanRuntime.stopAll();
    const taskIds = inFlightTaskIds();
    const runIds = inFlightRunIds();
    if (taskIds.length === 0 && runIds.length === 0) return;
    console.log(`[agent-fabric] stopping in-flight work: ${taskIds.length} task(s), ${runIds.length} run(s)`);
    teardownWork({ taskIds, runIds, log: (message) => console.log(`[agent-fabric] ${message}`) });
  };

  const upgrade = createKanbanUpgradeHandler({ token, runtime: kanbanRuntime });
  if (options.port !== undefined) {
    const listenPort = options.port;
    // An explicit HTTP server (rather than `app.listen`) so the kanban
    // terminal websocket shares the same port and auth token (v13 §5.1).
    const server = createHttpServer(app);
    server.on("upgrade", upgrade);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return { app, shutdown, upgrade, server };
  }

  return { app, shutdown, upgrade };
}

/** The app alone (tests, callers that never stop the server). */
export async function createApp(options: ServerOptions): Promise<Express> {
  return (await createServer(options)).app;
}

function reqClose(req: Request, res: Response, onClose: () => void): void {
  req.on("close", onClose);
  res.on("close", onClose);
}
