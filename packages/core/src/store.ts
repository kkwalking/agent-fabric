import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ID,
  Provider,
  Model,
  Runtime,
  Workspace,
  Task,
  Run,
  RunEvent,
  Artifact,
  Secret,
  AgentProfile,
  AppConfig,
  Handoff,
  RuntimeSessionRef,
  RuntimeNativeState,
} from "./types.js";

export type CollectionName =
  | "providers"
  | "models"
  | "runtimes"
  | "workspaces"
  | "tasks"
  | "runs"
  | "eventShards"
  | "artifacts"
  | "secrets"
  | "profiles"
  | "handoffs"
  | "runtimeSessions"
  | "nativeStates"
  | "config";

/**
 * Per-run index row for the event shards. Event payloads never enter
 * db.json — they live append-only in `events/<runId>.jsonl` under the
 * data dir; this row is all db.json carries.
 */
export interface EventShardIndex {
  runId: ID;
  /** Shard file path relative to the data dir. */
  file: string;
  count: number;
  bytes: number;
  /** Highest event seq in the shard; recovers the global seq counter on load. */
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Database {
  providers: Provider[];
  models: Model[];
  runtimes: Runtime[];
  workspaces: Workspace[];
  tasks: Task[];
  runs: Run[];
  eventShards: EventShardIndex[];
  artifacts: Artifact[];
  secrets: Secret[];
  profiles: AgentProfile[];
  handoffs: Handoff[];
  runtimeSessions: RuntimeSessionRef[];
  nativeStates: RuntimeNativeState[];
  config: AppConfig;
}

export function newId(prefix = "id"): ID {
  const rand = randomBytes(6).toString("hex");
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function emptyDatabase(): Database {
  return {
    providers: [],
    models: [],
    runtimes: [],
    workspaces: [],
    tasks: [],
    runs: [],
    eventShards: [],
    artifacts: [],
    secrets: [],
    profiles: [],
    handoffs: [],
    runtimeSessions: [],
    nativeStates: [],
    config: {},
  };
}

/**
 * A tiny JSON-file-backed repository.
 *
 * All state is kept in memory and persisted to `data/db.json` after each
 * mutation (atomic write via temp file + rename). Good enough for the MVP
 * and trivially replaceable by a real database later.
 */
export class Store {
  private db: Database = emptyDatabase();
  private seq = 1;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  readonly file: string;
  /** Base directory holding db.json; also used for derived data (e.g. git workspace clones). */
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = join(dataDir, "db.json");
  }

  static async open(dataDir: string): Promise<Store> {
    const store = new Store(dataDir);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Database> & {
        /** Legacy unified sessions (v2 §1–§5): dropped on load. */
        sessions?: unknown;
        /**
         * Legacy in-db event payloads (pre-shard): dropped on load —
         * events live in per-run JSONL shards, db.json keeps only the
         * eventShards index.
         */
        events?: unknown;
      };
      delete parsed.sessions;
      delete parsed.events;
      this.db = { ...emptyDatabase(), ...parsed };
      if (!Array.isArray(this.db.providers)) this.db.providers = [];
      if (!Array.isArray(this.db.models)) this.db.models = [];
      if (!Array.isArray(this.db.runtimes)) this.db.runtimes = [];
      if (!Array.isArray(this.db.workspaces)) this.db.workspaces = [];
      if (!Array.isArray(this.db.tasks)) this.db.tasks = [];
      if (!Array.isArray(this.db.runs)) this.db.runs = [];
      if (!Array.isArray(this.db.eventShards)) this.db.eventShards = [];
      if (!Array.isArray(this.db.artifacts)) this.db.artifacts = [];
      if (!Array.isArray(this.db.secrets)) this.db.secrets = [];
      if (!Array.isArray(this.db.profiles)) this.db.profiles = [];
      if (!Array.isArray(this.db.handoffs)) this.db.handoffs = [];
      if (!Array.isArray(this.db.runtimeSessions)) this.db.runtimeSessions = [];
      if (!Array.isArray(this.db.nativeStates)) this.db.nativeStates = [];
      if (!this.db.config) this.db.config = {};
      // v2 §3: strip legacy unified-session fields so old databases stop
      // referencing the removed AgentFabric Session abstraction.
      for (const t of this.db.tasks) delete (t as { sessionId?: unknown }).sessionId;
      for (const r of this.db.runs) delete (r as { sessionId?: unknown }).sessionId;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.db = emptyDatabase();
      } else {
        throw err;
      }
    }
    // The event counter is global and must stay monotonic across process
    // restarts. Left at its constructor value it restarts at 1 on every
    // load and hands out seq numbers that already exist — and since a run's
    // events are read back sorted by seq, a freshly written event (a
    // handoff row, a tool result) silently renders *before* the work that
    // preceded it instead of appending to it. The counter recovers from the
    // shards' lastSeq high-water marks.
    this.seq = this.db.eventShards.reduce((max, s) => Math.max(max, s.lastSeq), 0) + 1;
  }

  private async persist(): Promise<void> {
    this.dirty = true;
    if (this.saving) {
      // Serialize writes; coalesce by awaiting the previous one.
      this.saving = this.saving.then(() => this.flush());
    } else {
      this.saving = this.flush();
    }
    await this.saving;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.db, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  snapshot(): Database {
    return JSON.parse(JSON.stringify(this.db)) as Database;
  }

  config(): AppConfig {
    return this.db.config;
  }

  async updateConfig(patch: AppConfig): Promise<AppConfig> {
    this.db.config = { ...this.db.config, ...patch };
    await this.persist();
    return this.db.config;
  }

  /* ---------- events: per-run JSONL shards, indexed in db.json ---------- */

  private shardPath(runId: ID): string {
    return join(this.dataDir, "events", `${runId}.jsonl`);
  }

  /**
   * Appends one event to its run's shard file and upserts the run's index
   * row. The append is the payload write; only the (small) index row is
   * persisted into db.json.
   */
  async appendEvent(event: RunEvent): Promise<void> {
    const line = JSON.stringify(event);
    await mkdir(dirname(this.shardPath(event.runId)), { recursive: true });
    await appendFile(this.shardPath(event.runId), line + "\n", "utf8");
    const bytes = Buffer.byteLength(line) + 1;
    const now = new Date().toISOString();
    const shard = this.db.eventShards.find((s) => s.runId === event.runId);
    if (shard) {
      shard.count += 1;
      shard.bytes += bytes;
      shard.lastSeq = Math.max(shard.lastSeq, event.seq);
      shard.updatedAt = now;
    } else {
      this.db.eventShards.push({
        runId: event.runId,
        file: join("events", `${event.runId}.jsonl`),
        count: 1,
        bytes,
        lastSeq: event.seq,
        createdAt: now,
        updatedAt: now,
      });
    }
    await this.persist();
  }

  /**
   * A run's events, read back from its shard file sorted by seq. Returns
   * [] for runs without a shard (no events yet, or a dropped legacy
   * database).
   */
  async readEvents(runId: ID): Promise<RunEvent[]> {
    const shard = this.db.eventShards.find((s) => s.runId === runId);
    if (!shard) return [];
    let raw: string;
    try {
      raw = await readFile(join(this.dataDir, shard.file), "utf8");
    } catch {
      return [];
    }
    const events: RunEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as RunEvent);
      } catch {
        /* a torn tail line from a crash mid-append is skipped */
      }
    }
    return events.sort((a, b) => a.seq - b.seq);
  }

  listEventShards(): EventShardIndex[] {
    return this.db.eventShards;
  }

  /* ---------- generic collection helpers ---------- */

  list<T>(col: CollectionName): T[] {
    return this.db[col] as unknown as T[];
  }

  get<T extends { id: ID }>(col: CollectionName, id: ID): T | undefined {
    const arr = this.db[col] as unknown as T[];
    return arr.find((x) => x.id === id);
  }

  async insert<T extends { id: ID }>(col: CollectionName, item: T): Promise<T> {
    const arr = this.db[col] as unknown as T[];
    arr.push(item);
    await this.persist();
    return item;
  }

  async update<T extends { id: ID }>(col: CollectionName, id: ID, patch: Partial<T>): Promise<T | undefined> {
    const arr = this.db[col] as unknown as T[];
    const idx = arr.findIndex((x) => x.id === id);
    if (idx === -1) return undefined;
    arr[idx] = { ...arr[idx], ...patch };
    await this.persist();
    return arr[idx];
  }

  async remove(col: CollectionName, id: ID): Promise<boolean> {
    const arr = this.db[col] as unknown as Array<{ id: ID }>;
    const idx = arr.findIndex((x) => x.id === id);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    await this.persist();
    return true;
  }

  /** Persist arbitrary in-place mutations made by the caller. */
  async commit(): Promise<void> {
    await this.persist();
  }

  nextSeq(): number {
    return this.seq++;
  }

  /** Wipe everything (used by tests / `af reset`). */
  async reset(): Promise<void> {
    this.db = emptyDatabase();
    this.seq = 1;
    await this.persist();
    await rm(this.file, { force: true });
    await rm(join(this.dataDir, "events"), { recursive: true, force: true });
  }
}
