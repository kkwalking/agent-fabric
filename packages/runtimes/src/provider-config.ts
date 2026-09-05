/**
 * AgentFabric → harness provider configuration injection (v4 §1–§4).
 *
 * A Provider configured in AgentFabric (type, base URL, API key secret,
 * custom headers) must reach the *real* model requests made by the
 * harness — the user must never hand-configure the harness again. Each
 * harness consumes this config through its own native mechanism:
 *
 * - pi: a `models.json` provider entry merged into the pi agent dir
 *   (baseUrl + api + apiKey via `$ENV` interpolation + headers + models).
 * - opencode: a generated `opencode.json` referenced via `OPENCODE_CONFIG`
 *   (provider entry with npm package + baseURL + apiKey via `{env:…}` +
 *   headers, plus permission/agent policy sections).
 *
 * The API key itself always travels as the `AGENTFABRIC_PROVIDER_API_KEY`
 * environment variable and is referenced from the generated files — the
 * plaintext never lands in argv, event logs, or config files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Model, Provider, ProviderType } from "@agentfabric/core";

/** Env var carrying the provider API key into the harness process. */
export const PROVIDER_API_KEY_ENV = "AGENTFABRIC_PROVIDER_API_KEY";

/** Stable provider id used inside generated harness configs and argv. */
export function providerSlug(provider: Pick<Provider, "id" | "name">): string {
  const slug = provider.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `provider-${provider.id}`;
}

/**
 * pi's built-in provider ids (from its provider registry / env-api-key
 * table). A provider whose slug matches one of these *overrides* the
 * built-in instead of defining a new endpoint — so AgentFabric must not
 * invent a base URL or a placeholder key for it: the built-in endpoint,
 * models and the user's own auth (auth.json / env) keep working unless
 * the AgentFabric record explicitly configures them.
 */
export const PI_BUILTIN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "anthropic",
  "ant-ling",
  "azure-openai-responses",
  "openai",
  "deepseek",
  "nvidia",
  "google",
  "mistral",
  "groq",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "opencode",
  "opencode-go",
  "huggingface",
  "fireworks",
  "together",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "github-copilot",
  "amazon-bedrock",
  "google-vertex",
]);

/**
 * opencode provider ids that resolve natively (models.dev + auth.json).
 * A keyless, base-URL-less provider named after one of these passes
 * through to the harness's own registry instead of being overridden by a
 * generated entry with wrong endpoints.
 */
export const OPENCODE_KNOWN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "deepseek",
  "google",
  "groq",
  "mistral",
  "openrouter",
  "xai",
  "together",
  "fireworks",
  "cerebras",
  "azure",
  "bedrock",
  "ollama",
  "opencode",
  "azure-openai-responses",
]);

/**
 * The effective base URL for a provider: the configured value, else the
 * public default for the provider type (custom providers only — built-in
 * overrides inherit the harness's own endpoint). The harness must hit
 * exactly this endpoint (v4 §3).
 */
export function effectiveBaseUrl(
  provider: Pick<Provider, "type" | "baseUrl">,
  isBuiltinOverride = false
): string | undefined {
  if (provider.baseUrl) return provider.baseUrl;
  if (isBuiltinOverride) return undefined;
  return defaultBaseUrlForType(provider.type);
}

/** pi `api` value for a provider type (pi models.json). */
export function piApiForType(type: ProviderType): string {
  switch (type) {
    case "anthropic":
      return "anthropic-messages";
    case "openai-responses":
      return "openai-responses";
    case "openai-completions":
    case "openai":
    case "openai-compatible":
    case "custom":
    default:
      return "openai-completions";
  }
}

/** opencode npm package for a provider type (opencode.json). */
export function npmPackageForType(type: ProviderType): string {
  switch (type) {
    case "anthropic":
      return "@ai-sdk/anthropic";
    case "openai-responses":
    case "openai":
      return "@ai-sdk/openai";
    case "openai-completions":
    case "openai-compatible":
    case "custom":
    default:
      return "@ai-sdk/openai-compatible";
  }
}

/** Public default endpoint per provider type, used when no baseUrl is set. */
export function defaultBaseUrlForType(type: ProviderType): string | undefined {
  switch (type) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai-responses":
    case "openai":
    case "openai-completions":
      return "https://api.openai.com/v1";
    default:
      return undefined;
  }
}

/** Splits model parameters into supported vs unsupported for a harness. */
export function splitModelParameters(
  parameters: Record<string, unknown> | undefined,
  supported: readonly string[]
): { supported: Record<string, unknown>; unsupported: Record<string, unknown> } {
  const supportedParams: Record<string, unknown> = {};
  const unsupported: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (supported.includes(key)) supportedParams[key] = value;
    else unsupported[key] = value;
  }
  return { supported: supportedParams, unsupported };
}

/**
 * Emits an explicit warning event for configuration a harness cannot
 * honor (v4 §4/§8) — never silently dropped.
 */
export function describeUnsupported(
  kind: "parameter" | "header" | "baseUrl" | "provider",
  entries: Array<string | [string, unknown]>
): Array<Record<string, unknown>> {
  return entries.map((entry) =>
    typeof entry === "string" ? { kind, key: entry } : { kind, key: entry[0], value: entry[1] }
  );
}

/** Reads a JSON file, tolerating absence and parse errors (returns {}). */
function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export interface PiModelsJsonProvider {
  baseUrl?: string;
  api?: string;
  /** `$ENV`-interpolated API key reference — plaintext never written. */
  apiKey?: string;
  headers?: Record<string, string>;
  models?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Merges an AgentFabric provider into pi's `models.json` (v4 §1/§3/§4).
 *
 * The file is *merged*, never replaced: other providers the user keeps in
 * the same agent dir survive untouched; only this provider's namespace is
 * written. Re-using the pi built-in id when the slug matches (e.g. a
 * "deepseek" provider) is the documented override path: the built-in
 * endpoint, models and the user's own auth (auth.json / env) keep working
 * unless the AgentFabric record explicitly configures a value — so no
 * invented base URLs or placeholder keys for built-in overrides.
 */
export function writePiModelsJson(
  agentDir: string,
  provider: Provider,
  models: Model[]
): string {
  const path = `${agentDir}/models.json`;
  const doc = readJson(path) as { providers?: Record<string, PiModelsJsonProvider> };
  const providers = doc.providers ?? {};
  const slug = providerSlug(provider);
  const isBuiltinOverride = PI_BUILTIN_PROVIDER_IDS.has(slug);
  const entry: PiModelsJsonProvider = { ...(providers[slug] ?? {}) };

  const baseUrl = effectiveBaseUrl(provider, isBuiltinOverride);
  if (baseUrl) entry.baseUrl = baseUrl;
  else delete entry.baseUrl;

  // The api wire format is only pinned for custom endpoints; overriding a
  // built-in without one keeps the built-in's native API type.
  if (!isBuiltinOverride || provider.baseUrl) entry.api = piApiForType(provider.type);
  else delete entry.api;

  if (provider.apiKeySecretId) {
    // The key travels as an env var; models.json only references it.
    entry.apiKey = `$${PROVIDER_API_KEY_ENV}`;
  } else if (isBuiltinOverride) {
    // Built-in override without an AgentFabric key: let pi's own auth
    // resolution (auth.json / env var) supply the credential.
    delete entry.apiKey;
  } else if (!("apiKey" in entry)) {
    // Keyless custom endpoint (local vLLM/Ollama etc.) — pi requires
    // *some* auth value before models become selectable.
    entry.apiKey = "agentfabric-keyless";
  }

  if (provider.headers && Object.keys(provider.headers).length > 0) {
    entry.headers = { ...(entry.headers ?? {}), ...provider.headers };
  } else {
    delete entry.headers;
  }

  entry.models = models.map((m) => {
    const model: Record<string, unknown> = { id: m.name };
    if (typeof m.parameters?.maxTokens === "number") model.maxTokens = m.parameters.maxTokens;
    if (typeof m.parameters?.contextWindow === "number") model.contextWindow = m.parameters.contextWindow;
    return model;
  });
  providers[slug] = entry;
  writeJson(path, { ...doc, providers });
  return path;
}

/** The pi agent dir a run should use (host-side). */
export function piAgentDir(env: Record<string, string | undefined>, homeDir: string): string {
  return env.PI_CODING_AGENT_DIR ?? `${homeDir}/.pi/agent`;
}

export interface OpenCodeConfigOptions {
  provider: Provider;
  models: Model[];
  /** `permission` block from the resolved execution policy (v4 §15/§16). */
  permission?: Record<string, unknown>;
  /** Custom agent definition (system instructions + tools, v4 §10/§11). */
  agent?: { prompt?: string; tools?: Record<string, boolean>; model?: string };
  /** Extra top-level config merged in (e.g. default model). */
  extra?: Record<string, unknown>;
  /**
   * Built-in passthrough (v4 §3): when the provider has neither a base
   * URL nor an AgentFabric-managed key and its slug matches a provider
   * opencode knows natively, no provider entry is generated — the
   * harness's own registry and auth (auth.json) serve the run.
   */
  builtinPassthrough?: boolean;
}

export type OpenCodeConfig = Record<string, unknown>;

/**
 * Builds the generated `opencode.json` for a run (v4 §1/§3/§4/§10/§15).
 * Written by the adapter; `OPENCODE_CONFIG` points the harness at it.
 */
export function buildOpenCodeConfig(opts: OpenCodeConfigOptions): OpenCodeConfig {
  const { provider, models } = opts;
  const config: OpenCodeConfig = { $schema: "https://opencode.ai/config.json" };
  if (!opts.builtinPassthrough) {
    const providerEntry: Record<string, unknown> = {
      npm: npmPackageForType(provider.type),
      name: provider.name,
      options: {
        ...(effectiveBaseUrl(provider) ? { baseURL: effectiveBaseUrl(provider) } : {}),
        apiKey: `{env:${PROVIDER_API_KEY_ENV}}`,
        ...(provider.headers && Object.keys(provider.headers).length > 0 ? { headers: provider.headers } : {}),
      },
      models: Object.fromEntries(
        models.map((m) => {
          const entry: Record<string, unknown> = { name: m.alias ?? m.name };
          const limit: Record<string, number> = {};
          if (typeof m.parameters?.maxTokens === "number") limit.output = m.parameters.maxTokens;
          if (typeof m.parameters?.contextWindow === "number") limit.context = m.parameters.contextWindow;
          if (Object.keys(limit).length > 0) entry.limit = limit;
          return [m.name, entry];
        })
      ),
    };
    config.provider = { [providerSlug(provider)]: providerEntry };
  }
  if (opts.permission && Object.keys(opts.permission).length > 0) config.permission = opts.permission;
  if (opts.agent) config.agent = { agentfabric: opts.agent };
  return { ...config, ...(opts.extra ?? {}) };
}

/** Writes the generated opencode config; returns its host path. */
export function writeOpenCodeConfig(path: string, config: OpenCodeConfig): string {
  writeJson(path, config);
  return path;
}

/** Reads back a generated config (test/inspection helper). */
export function readOpenCodeConfig(path: string): OpenCodeConfig | undefined {
  return existsSync(path) ? readJson(path) : undefined;
}
