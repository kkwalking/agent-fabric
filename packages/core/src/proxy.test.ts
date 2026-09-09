/**
 * Tests for the global harness proxy (Proxy page): env-layer construction,
 * loopback rewrite for containerized runs, and the disabled/incomplete
 * no-op contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProxyEnv } from "./proxy.js";

test("proxy disabled or absent injects nothing", () => {
  assert.deepEqual(buildProxyEnv(undefined), {});
  assert.deepEqual(buildProxyEnv({}), {});
  assert.deepEqual(buildProxyEnv({ enabled: false, host: "127.0.0.1", port: 7890 }), {});
});

test("incomplete or out-of-range proxy config injects nothing", () => {
  assert.deepEqual(buildProxyEnv({ enabled: true }), {});
  assert.deepEqual(buildProxyEnv({ enabled: true, host: "  ", port: 7890 }), {});
  assert.deepEqual(buildProxyEnv({ enabled: true, host: "127.0.0.1" }), {});
  assert.deepEqual(buildProxyEnv({ enabled: true, host: "127.0.0.1", port: 0 }), {});
  assert.deepEqual(buildProxyEnv({ enabled: true, host: "127.0.0.1", port: 70000 }), {});
});

test("enabled http proxy sets the standard variable set plus NO_PROXY", () => {
  const env = buildProxyEnv({ enabled: true, scheme: "http", host: "127.0.0.1", port: 7890 });
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
    assert.equal(env[name], "http://127.0.0.1:7890", name);
  }
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
});

test("socks5 scheme is honored", () => {
  const env = buildProxyEnv({ enabled: true, scheme: "socks5", host: "proxy.lan", port: 7891 });
  assert.equal(env.HTTPS_PROXY, "socks5://proxy.lan:7891");
});

test("containerized runs rewrite a loopback proxy host to host.docker.internal", () => {
  const env = buildProxyEnv({ enabled: true, scheme: "http", host: "127.0.0.1", port: 7890 }, true);
  assert.equal(env.HTTPS_PROXY, "http://host.docker.internal:7890");
  const localhost = buildProxyEnv({ enabled: true, host: "localhost", port: 7890 }, true);
  assert.equal(localhost.HTTPS_PROXY, "http://host.docker.internal:7890");
  // Non-loopback hosts pass through untouched.
  const lan = buildProxyEnv({ enabled: true, host: "192.168.1.10", port: 7890 }, true);
  assert.equal(lan.HTTPS_PROXY, "http://192.168.1.10:7890");
});
