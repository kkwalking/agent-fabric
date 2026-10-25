/**
 * The configuration file — the one place the user's AgentFabric config is
 * written, read and validated.
 *
 * It lives at `<dataDir>/config.json` (default `~/.fabric/config.json`, mode
 * 0600) and holds every `AppConfig` field: proxies, harness CLI paths, docker
 * overrides, handoff model, notifications, automatic retry. When the file does
 * not exist it is created from the effective config, with `$schema` pointing at
 * the JSON Schema the server serves, so the file opens in an editor that offers
 * completion and inline documentation of each key.
 *
 * **The file is the fact, not a derived artifact.** It is written by two paths
 * only: a save from the Settings page (which fills in the fields and PUTs them)
 * and a manual edit followed by POST `/api/settings/reload`. The server does
 * not rewrite it on boot — an editor holding the file with unsaved changes must
 * not have them silently replaced underneath.
 *
 * A file that does not parse never replaces the running config (a running
 * server must not go down over a half-typed key): `read()` reports the parse
 * failure with the file's mtime, the error is visible in Settings, and the
 * previous config keeps being used until the file parses again.
 *
 * The schema and the `$schema` pointer are ours (the repository's own format),
 * so they are served from here rather than referenced from a remote URL.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "@agentfabric/core";

/** File name inside the data directory. */
export const CONFIG_FILE_NAME = "config.json";

/** Logical, stable identifier for the file in the schema's `$id`. */
const SCHEMA_ID = "https://agentfabric.dev/schemas/config.json";

export function configFilePath(dataDir: string): string {
  return join(dataDir, CONFIG_FILE_NAME);
}

/**
 * The JSON Schema for the config file.
 *
 * `additionalProperties: false` is the useful user-facing part: a misspelled
 * key (`prox.enabled`) is reported by the editor instead of being ignored.
 * Durations and retry numbers carry a description saying which takes effect
 * when — the file is edited by hand, so "what happens if I leave it out" has to
 * be answerable from the file itself.
 */
export const CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCHEMA_ID,
  title: "AgentFabric configuration",
  description:
    "AgentFabric settings. Saved by the Settings page, or edited by hand and applied with Restart; automatic retry values also apply to the next failure without a restart.",
  type: "object",
  additionalProperties: false,
  properties: {
    proxy: {
      type: "object",
      title: "Proxy",
      description:
        "Proxy injected into harness processes started by the server. Takes effect on the next task start; runs already in flight keep their environment.",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false, description: "Inject proxy environment variables into harness processes." },
        scheme: { enum: ["http", "socks5"], default: "http", description: "Proxy protocol." },
        host: { type: "string", description: "Proxy host, e.g. 127.0.0.1." },
        port: { type: "integer", minimum: 1, maximum: 65535, description: "Proxy port." },
      },
    },
    server: {
      type: "object",
      title: "Server",
      description: "Informational: the listen address is chosen by the process that starts the server (env or desktop app).",
      additionalProperties: false,
      properties: {
        host: { type: "string" },
        port: { type: "integer", minimum: 1, maximum: 65535 },
      },
    },
    docker: {
      type: "object",
      title: "Docker",
      additionalProperties: false,
      properties: {
        socket: { type: "string", description: "Docker socket path override." },
        defaultImage: { type: "string", description: "Image used when a containerized runtime has none of its own." },
      },
    },
    opencode: { type: "object", additionalProperties: false, properties: { bin: { type: "string", description: "opencode CLI path." } } },
    pi: { type: "object", additionalProperties: false, properties: { bin: { type: "string", description: "pi CLI path." } } },
    codex: { type: "object", additionalProperties: false, properties: { bin: { type: "string", description: "codex CLI path." } } },
    claudeCode: {
      type: "object",
      additionalProperties: false,
      properties: {
        bin: { type: "string", description: "claude CLI path." },
        projectsDir: { type: "string", description: "Override for the ~/.claude/projects transcript root." },
      },
    },
    handoff: {
      type: "object",
      title: "Handoff",
      additionalProperties: false,
      properties: {
        modelId: {
          type: "string",
          description:
            "Model that writes handoff checkpoints. Unset: the covered run's model, else the first enabled model. A model that exists but is unusable fails loudly instead of falling back.",
        },
      },
    },
    notifications: {
      type: "object",
      title: "Notifications",
      description: "Outbound webhook fired when a task reaches a terminal state. Takes effect on the next task.",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        url: { type: "string", description: "Webhook URL. Treat it as a credential: the Settings page shows it masked." },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "Extra request headers (e.g. Authorization)." },
        timeoutMs: { type: "integer", minimum: 100, description: "Request timeout in milliseconds." },
        on: {
          type: "array",
          items: { type: "string" },
          description: "Terminal statuses that fire the webhook; omit for the default set.",
        },
      },
    },
    providers: {
      type: "array",
      title: "Providers and models",
      description:
        "LLM providers and the models they serve. The file is the source: the LLM page rewrites this section when it saves, and editing it by hand then applying replaces the whole set (a provider left out here is removed). Takes effect on restart.",
      items: {
        type: "object",
        required: ["id", "type"],
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Stable identifier, e.g. `my-gateway`. Referenced by the rest of the file and by tasks." },
          name: { type: "string", description: "Display name; defaults to the id." },
          type: {
            enum: ["openai-responses", "openai-completions", "openai", "openai-compatible", "anthropic", "custom"],
            description: "API wire format the provider speaks.",
          },
          remark: { type: "string" },
          website: { type: "string" },
          baseUrl: { type: "string", description: "Endpoint / base URL for an OpenAI-compatible or custom provider." },
          apiKey: { type: "string", description: "Key in the clear, in this file (mode 0600). Either this or apiKeySecretId." },
          apiKeySecretId: {
            type: "string",
            description: "Reference to a key kept in AgentFabric's encrypted Secret store — what a key typed into the UI becomes.",
          },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "Extra request headers." },
          enabled: { type: "boolean", default: true },
          models: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              additionalProperties: false,
              properties: {
                name: { type: "string", description: "Model name as the provider understands it, e.g. `gpt-4o`." },
                alias: { type: "string", description: "Display name and submission alias; defaults to the name." },
                parameters: { type: "object", description: "Model parameters (temperature, maxTokens, …)." },
                capabilities: { type: "array", items: { type: "string" } },
                enabled: { type: "boolean", default: true },
              },
            },
          },
        },
      },
    },
    autoRetry: {
      type: "object",
      title: "Automatic retry",
      description:
        "Automatic retry of failures caused by the environment (network blip, sandbox that could not start). Takes effect on the next retry decision — no restart needed.",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true, description: "Default true." },
        maxAttempts: { type: "integer", minimum: 1, maximum: 10, description: "Attempts in one failure episode, including the first. Default 2." },
        baseDelayMs: { type: "integer", minimum: 100, description: "Backoff base: the wait before retry N is base × 2^(N-1)." },
        maxDelayMs: { type: "integer", minimum: 100, description: "Backoff cap." },
      },
    },
  },
} as const;

/**
 * The `$schema` value written into the file.
 *
 * A bare relative reference would be resolved against the file's own directory
 * (i.e. `<dataDir>/api/settings/schema`), which is not a URL any editor fetches,
 * so the path is server-absolute. That is enough for editors that try the
 * page's origin and the common loopback ports; an editor that needs a full URL
 * can still be pointed at one by hand.
 */
export const SCHEMA_REF = "/api/settings/schema";

/** What a read of the file found. */
export interface ConfigFileRead {
  path: string;
  /** Raw file text. */
  text: string;
  /** Parsed document, when the file is valid JSON with an object at the root. */
  parsed?: AppConfig;
  /** Why the file could not be used; absent when `parsed` is set. */
  error?: string;
  /** Last modification time (epoch ms); 0 when the file does not exist. */
  mtimeMs: number;
  /** Identity of the current content, so a client can tell whether it changed. */
  revision: string;
}

/** What the client needs to know about the file and the running config. */
export interface SettingsFileInfo {
  path: string;
  /** The config the running server is using. */
  config: unknown;
  /** The file's current content, or why it could not be read. */
  file: ConfigFileRead;
  /**
   * The file is known to hold something other than the running config: it
   * failed to parse, or its content has not been applied (edited after the
   * last load). Restarting applies it when it parses.
   */
  pending: boolean;
}

/** One line of the settings history. */
export interface SettingsHistoryEntry {
  at: string;
  /** `ui` — saved from the Settings page; `file` — applied from disk. */
  source: "ui" | "file";
  /** Top-level keys whose value changed, or `["*"]` for "the whole document". */
  keys: string[];
}

/**
 * Compares two config documents and names the top-level keys that differ.
 * An absent key and an explicitly empty one (`""`, `null`, `{}`) compare equal:
 * that is how "cleared in the editor" and "removed from the file" end up with
 * the same meaning, so clearing a field does not leave the old value behind.
 */
export function changedConfigKeys(before: AppConfig, after: AppConfig): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    const a = (before as Record<string, unknown>)[key];
    const b = (after as Record<string, unknown>)[key];
    if (isBlank(a) && isBlank(b)) continue;
    if (JSON.stringify(normalize(a)) !== JSON.stringify(normalize(b))) changed.push(key);
  }
  return changed.sort();
}

/** Empty objects and arrays are treated as "not set". */
function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)
  );
}

/** Drops keys whose value means "not set", recursively, for comparison only. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") return value === "" ? undefined : value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalize(inner);
    if (normalized !== undefined) out[key] = normalized;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Parses the file body; a non-object root is an error (the config is an object). */
export function parseConfigText(text: string): { parsed?: AppConfig; error?: string } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { error: "the root of the file must be a JSON object" };
  }
  // `$schema` is an editor hint, not a setting: it is stripped on the way in
  // so it never reaches the store or a later write.
  const { $schema: _schema, ...config } = document as Record<string, unknown>;
  return { parsed: config as AppConfig };
}

/**
 * Writes the config file atomically (temp file + rename, like the store), with
 * mode 0600 and a trailing newline. `$schema` is always the first key so the
 * file starts with the pointer that makes an editor validate it.
 */
export async function writeConfigFile(path: string, config: AppConfig, schemaRef: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify({ $schema: schemaRef, ...config }, null, 2)}\n`;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, path);
}

/** Reads the file; a missing file is reported as empty, not as an error. */
export async function readConfigFile(path: string): Promise<ConfigFileRead> {
  let text: string;
  let mtimeMs = 0;
  try {
    const info = await stat(path);
    mtimeMs = info.mtimeMs;
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { path, text: "", mtimeMs: 0, revision: revisionOf("") };
  }
  const { parsed, error } = parseConfigText(text);
  return { path, text, ...(parsed ? { parsed } : { error }), mtimeMs, revision: revisionOf(text) };
}

/** A short, stable identity for one file content. */
export function revisionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
