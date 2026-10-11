/**
 * Provider configuration injection: the containerized loopback rewrite.
 *
 * A provider that lives on the AgentFabric host (a local gateway on
 * 127.0.0.1, a mock endpoint) is reachable from inside a container only
 * via host.docker.internal — the same rewrite the proxy env layer
 * applies. The generated pi/opencode configs must carry the rewritten
 * URL, and host runs must keep the literal one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenCodeConfig,
  containerizedBaseUrl,
  writePiModelsJson,
} from "./provider-config.js";
import type { Model, Provider } from "@agentfabric/core";

test("containerizedBaseUrl rewrites only loopback hosts", () => {
  assert.equal(containerizedBaseUrl("http://127.0.0.1:3425"), "http://host.docker.internal:3425");
  assert.equal(containerizedBaseUrl("http://127.0.0.1:3425/v1"), "http://host.docker.internal:3425/v1");
  assert.equal(containerizedBaseUrl("https://localhost:8443"), "https://host.docker.internal:8443");
  assert.equal(containerizedBaseUrl("http://[::1]:3425"), "http://host.docker.internal:3425");
  // Non-loopback endpoints pass through untouched, formatting included.
  assert.equal(containerizedBaseUrl("https://api.example.com/v1"), "https://api.example.com/v1");
  assert.equal(containerizedBaseUrl("http://192.168.1.10:8080/v1"), "http://192.168.1.10:8080/v1");
  // A hostname that merely starts with "localhost" is not loopback.
  assert.equal(containerizedBaseUrl("https://localhost.example.com"), "https://localhost.example.com");
});

const provider: Provider = {
  id: "prov_test",
  name: "Local Gateway",
  type: "openai-completions",
  baseUrl: "http://127.0.0.1:3425",
  apiKeySecretId: "sec_test",
  apiKeyMasked: "***",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const model: Model = {
  id: "mod_test",
  providerId: provider.id,
  name: "local-model",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("writePiModelsJson rewrites a loopback base URL only for containerized runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-pc-"));
  writePiModelsJson(dir, provider, [model], { containerized: true });
  const doc = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
    providers: Record<string, { baseUrl?: string }>;
  };
  assert.equal(doc.providers["local-gateway"].baseUrl, "http://host.docker.internal:3425");

  const hostDir = mkdtempSync(join(tmpdir(), "af-pc-host-"));
  writePiModelsJson(hostDir, provider, [model]);
  const hostDoc = JSON.parse(readFileSync(join(hostDir, "models.json"), "utf8")) as {
    providers: Record<string, { baseUrl?: string }>;
  };
  assert.equal(hostDoc.providers["local-gateway"].baseUrl, "http://127.0.0.1:3425");
});

test("buildOpenCodeConfig rewrites a loopback base URL only for containerized runs", () => {
  const containerized = buildOpenCodeConfig({ provider, models: [model], containerized: true });
  const entry = (containerized.provider as Record<string, { options: { baseURL: string } }>)["local-gateway"];
  assert.equal(entry.options.baseURL, "http://host.docker.internal:3425");

  const host = buildOpenCodeConfig({ provider, models: [model] });
  const hostEntry = (host.provider as Record<string, { options: { baseURL: string } }>)["local-gateway"];
  assert.equal(hostEntry.options.baseURL, "http://127.0.0.1:3425");
});
