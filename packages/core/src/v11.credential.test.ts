/**
 * v11 Hardening §9/§10/§11/§28/§29 — credential host binding, transport
 * compatibility and leakage prevention.
 *
 * The promise under test:
 *
 *   A Source Credential is never sent to a host it is not scoped to, and a
 *   credential type that cannot authenticate a remote's transport is refused
 *   rather than silently misused.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "./store.js";
import { DomainError } from "./errors.js";
import {
  checkCredentialBinding,
  hostPatternMatches,
  materializeGitCredential,
  parseRemoteEndpoint,
} from "./git.js";
import { ProjectService, SourceCredentialService } from "./services.js";
import type { SourceCredential } from "./types.js";

const execFileAsync = promisify(execFile);

/** The unmistakable fake secret every leakage assertion searches for. */
const LEAK_CANARY = "AGENTFABRIC_TEST_SECRET_DO_NOT_LEAK";

before(() => {
  process.env.GIT_AUTHOR_NAME = "AgentFabric Test";
  process.env.GIT_AUTHOR_EMAIL = "af@example.test";
  process.env.GIT_COMMITTER_NAME = "AgentFabric Test";
  process.env.GIT_COMMITTER_EMAIL = "af@example.test";
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function credential(overrides: Partial<SourceCredential> = {}): SourceCredential {
  return {
    id: "cred_1",
    name: "test credential",
    type: "https-token",
    secretId: "sec_1",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/* ================================================================== */
/* 1. Remote host parsing (§10)                                        */
/* ================================================================== */

describe("v11 hardening: remote endpoint parsing", () => {
  test("extracts the host from every supported remote shape", () => {
    assert.deepEqual(parseRemoteEndpoint("https://github.com/org/repo.git"), { transport: "https", host: "github.com" });
    assert.deepEqual(parseRemoteEndpoint("http://git.example.com/org/repo.git"), { transport: "https", host: "git.example.com" });
    assert.deepEqual(parseRemoteEndpoint("ssh://git@gitlab.com/org/repo.git"), { transport: "ssh", host: "gitlab.com" });
    assert.deepEqual(parseRemoteEndpoint("git@github.com:org/repo.git"), { transport: "ssh", host: "github.com" });
    assert.deepEqual(parseRemoteEndpoint("git://git.example.com/repo.git"), { transport: "ssh", host: "git.example.com" });
    assert.deepEqual(parseRemoteEndpoint("ssh://git@git.example.com:2222/o/r.git"), { transport: "ssh", host: "git.example.com" });
  });

  test("a local path has no host and no transport to bind", () => {
    assert.deepEqual(parseRemoteEndpoint("/srv/git/repo.git"), { transport: "local" });
    assert.deepEqual(parseRemoteEndpoint("file:///srv/git/repo.git"), { transport: "local" });
  });

  test("hosts are compared case-insensitively and trailing dots are ignored", () => {
    assert.deepEqual(parseRemoteEndpoint("https://GitHub.COM/org/repo.git"), { transport: "https", host: "github.com" });
    assert.equal(hostPatternMatches("github.com", "GITHUB.com"), true);
  });

  test("wildcard patterns cover sub-domains only", () => {
    assert.equal(hostPatternMatches("*.internal.example.com", "git.internal.example.com"), true);
    assert.equal(hostPatternMatches("*.internal.example.com", "internal.example.com"), false);
    assert.equal(hostPatternMatches("*.internal.example.com", "evil-internal.example.com"), false);
    assert.equal(hostPatternMatches("*.internal.example.com", "git.internal.example.com.evil.test"), false);
    assert.equal(hostPatternMatches("github.com", "github.com"), true);
    assert.equal(hostPatternMatches("github.com", "notgithub.com"), false);
  });
});

/* ================================================================== */
/* 2. Host binding (§10/§28)                                           */
/* ================================================================== */

describe("v11 hardening: credential host binding", () => {
  test("HTTPS match: credential host = remote host → allowed", () => {
    const check = checkCredentialBinding(
      { name: "gh", type: "https-token", host: "github.com" },
      "https://github.com/a/b.git"
    );
    assert.equal(check.ok, true);
  });

  test("HTTPS mismatch: credential is never sent to an unauthorized host", () => {
    const check = checkCredentialBinding(
      { name: "gh", type: "https-token", host: "github.com" },
      "https://evil.example/a/b.git"
    );
    assert.equal(check.ok, false);
    assert.equal(check.code, "credential-host-mismatch");
    assert.match(check.message, /github\.com/);
    assert.match(check.message, /evil\.example/);
  });

  test("SSH match: credential host = remote host → allowed", () => {
    const check = checkCredentialBinding(
      { name: "gl", type: "ssh-key", host: "gitlab.com" },
      "git@gitlab.com:a/b.git"
    );
    assert.equal(check.ok, true);
  });

  test("SSH mismatch is rejected", () => {
    const check = checkCredentialBinding(
      { name: "gl", type: "ssh-key", host: "gitlab.com" },
      "git@other.example:a/b.git"
    );
    assert.equal(check.ok, false);
    assert.equal(check.code, "credential-host-mismatch");
  });

  test("a wildcard-scoped credential covers its sub-domains", () => {
    assert.equal(
      checkCredentialBinding({ name: "int", type: "ssh-key", host: "*.internal.example.com" }, "git@git.internal.example.com:a/b.git").ok,
      true
    );
    assert.equal(
      checkCredentialBinding({ name: "int", type: "ssh-key", host: "*.internal.example.com" }, "git@internal.example.com:a/b.git").ok,
      false
    );
  });

  test("an unscoped credential is a deliberate wildcard — the transport rule still applies", () => {
    assert.equal(checkCredentialBinding({ name: "any", type: "https-token" }, "https://anything.example/a/b.git").ok, true);
  });

  test("a local-path remote needs neither a host nor a transport match", () => {
    assert.equal(checkCredentialBinding({ name: "c", type: "https-token", host: "github.com" }, "/srv/git/repo.git").ok, true);
  });
});

/* ================================================================== */
/* 3. Transport compatibility (§10.2/§28)                              */
/* ================================================================== */

describe("v11 hardening: credential transport compatibility", () => {
  test("an HTTPS token cannot authenticate an SSH remote — explicit refusal, no downgrade", () => {
    const check = checkCredentialBinding({ name: "tok", type: "https-token", host: "github.com" }, "git@github.com:o/r.git");
    assert.equal(check.ok, false);
    assert.equal(check.code, "credential-transport-mismatch");
    assert.match(check.message, /HTTPS token/);
    assert.match(check.message, /ssh/);
  });

  test("an SSH key cannot be used as an HTTPS token", () => {
    const check = checkCredentialBinding({ name: "key", type: "ssh-key", host: "github.com" }, "https://github.com/o/r.git");
    assert.equal(check.ok, false);
    assert.equal(check.code, "credential-transport-mismatch");
  });

  test("transport mismatch is detected before host mismatch (the more fundamental problem first)", () => {
    const check = checkCredentialBinding({ name: "tok", type: "https-token", host: "github.com" }, "git@gitlab.com:o/r.git");
    assert.equal(check.code, "credential-transport-mismatch");
  });
});

/* ================================================================== */
/* 4. Project create / update fails early (§10.2)                      */
/* ================================================================== */

describe("v11 hardening: incompatible projects fail at configuration time", () => {
  test("creating a project with a mismatched credential host is refused", async () => {
    const store = await Store.open(tempDir("af-host-store-"));
    const credentials = new SourceCredentialService(store);
    const projects = new ProjectService(store);
    const credential = await credentials.create({
      name: "Personal GitHub",
      type: "https-token",
      host: "github.com",
      value: LEAK_CANARY,
    });

    await assert.rejects(
      () =>
        projects.create({
          name: "Wrong host",
          source: { remoteUrl: "https://evil.example/o/r.git", credentialId: credential.id },
        }),
      (err: unknown) => (err as DomainError).code === "credential-host-mismatch"
    );

    // The compatible pairing still works.
    const ok = await projects.create({
      name: "Right host",
      source: { remoteUrl: "https://github.com/o/r.git", credentialId: credential.id },
    });
    assert.equal(ok.source.credentialId, credential.id);
  });

  test("creating a project with an incompatible credential transport is refused", async () => {
    const store = await Store.open(tempDir("af-host-store-"));
    const credentials = new SourceCredentialService(store);
    const projects = new ProjectService(store);
    const sshKey = await credentials.create({
      name: "SSH key",
      type: "ssh-key",
      host: "github.com",
      value: "-----BEGIN KEY-----\nk\n-----END KEY-----",
    });
    await assert.rejects(
      () => projects.create({ name: "HTTPS repo", source: { remoteUrl: "https://github.com/o/r.git", credentialId: sshKey.id } }),
      (err: unknown) => (err as DomainError).code === "credential-transport-mismatch"
    );
  });

  test("updating a project's remote to a host the credential is not scoped to is refused", async () => {
    const store = await Store.open(tempDir("af-host-store-"));
    const credentials = new SourceCredentialService(store);
    const projects = new ProjectService(store);
    const credential = await credentials.create({
      name: "Personal GitHub",
      type: "https-token",
      host: "github.com",
      value: LEAK_CANARY,
    });
    const project = await projects.create({
      name: "Demo",
      source: { remoteUrl: "https://github.com/o/r.git", credentialId: credential.id },
    });
    await assert.rejects(
      () => projects.update(project.id, { source: { remoteUrl: "https://evil.example/o/r.git" } }),
      (err: unknown) => (err as DomainError).code === "credential-host-mismatch"
    );
    // The project is unchanged.
    assert.equal(projects.get(project.id)!.source.remoteUrl, "https://github.com/o/r.git");
  });

  test("a public project (no credential) is never host-bound", async () => {
    const store = await Store.open(tempDir("af-host-store-"));
    const projects = new ProjectService(store);
    const project = await projects.create({ name: "Public", source: { remoteUrl: "https://anything.example/o/r.git" } });
    assert.equal(project.source.credentialId, undefined);
  });
});

/* ================================================================== */
/* 5. Credential leakage prevention (§11/§29, AC-15/AC-16)             */
/* ================================================================== */

describe("v11 hardening: credential leakage prevention", () => {
  test("AC-15: an HTTPS token never reaches .git/config or the remote URL", async () => {
    const root = tempDir("af-leak-https-");
    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    await execFileAsync("git", ["init", "--quiet"], { cwd: seed });
    writeFileSync(join(seed, "README.md"), "# demo\n");
    await execFileAsync("git", ["add", "-A"], { cwd: seed });
    await execFileAsync("git", ["commit", "--quiet", "-m", "init"], { cwd: seed });
    const remote = join(root, "remote.git");
    await execFileAsync("git", ["clone", "--quiet", "--bare", seed, remote], { cwd: root });

    const credentialDir = join(root, "cred");
    const materialized = await materializeGitCredential(
      { type: "https-token", username: "x-access-token", token: LEAK_CANARY },
      credentialDir
    );
    try {
      // The token is in the child process env only.
      assert.equal(materialized.env.AGENTFABRIC_GIT_PASSWORD, LEAK_CANARY);
      assert.equal(materialized.args.join(" ").includes(LEAK_CANARY), false, "never in argv");
      // The askpass helper reads it back; it does not embed it.
      assert.equal(readFileSync(materialized.env.GIT_ASKPASS, "utf8").includes(LEAK_CANARY), false);
      // A real clone through the credential leaves no trace in .git/config.
      await execFileAsync(
        "git",
        [...materialized.args, "clone", "--quiet", remote, join(root, "clone")],
        { env: { ...process.env, ...materialized.env } }
      );
      const config = readFileSync(join(root, "clone", ".git", "config"), "utf8");
      assert.equal(config.includes(LEAK_CANARY), false);
      assert.match(config, new RegExp(`url = ${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    } finally {
      await materialized.cleanup();
    }
    assert.equal(existsSync(credentialDir), false, "the materialized credential is removed");
  });

  test("AC-15/§11.2: an SSH key is 0600, outside the workspace, and cleaned up", async () => {
    const root = tempDir("af-leak-ssh-");
    const credentialDir = join(root, "cred");
    const materialized = await materializeGitCredential(
      { type: "ssh-key", privateKey: `-----BEGIN KEY-----\n${LEAK_CANARY}\n-----END KEY-----`, passphrase: "p4ss" },
      credentialDir
    );
    try {
      const sshCommand = materialized.args.join(" ");
      assert.equal(sshCommand.includes(LEAK_CANARY), false, "key material never appears in argv");
      assert.match(sshCommand, /StrictHostKeyChecking=yes/);
      const keyPath = /-i (\S+)/.exec(sshCommand)![1];
      assert.equal(statSync(keyPath).mode & 0o777, 0o600, "the key file is 0600");
      // The key lives in the credential temp root, never in a workspace.
      // (realpath: macOS resolves /var → /private/var.)
      assert.equal(realpathSync(keyPath).startsWith(realpathSync(credentialDir)), true);
      // The registered secrets are the key *material* and the passphrase, so
      // the redactor replaces the whole PEM — including the canary inside it.
      assert.equal(materialized.secrets.some((v) => v.includes(LEAK_CANARY)), true);
      assert.equal(materialized.secrets.includes("p4ss"), true);
    } finally {
      await materialized.cleanup();
    }
    assert.equal(existsSync(credentialDir), false, "the key is removed after the operation");
  });

  test("AC-16/§29: the full lifecycle leaves no copy of the canary outside the secret store", async () => {
    const store = await Store.open(tempDir("af-leak-store-"));
    const credentials = new SourceCredentialService(store);
    const credential = await credentials.create({
      name: "canary",
      type: "https-token",
      host: "github.com",
      value: LEAK_CANARY,
    });
    // The Secret store holds it (that is what a Secret is)…
    const stored = store.get<{ value?: string }>("secrets", credential.secretId)!;
    assert.equal(stored.value, LEAK_CANARY);
    // …and nothing the API serves does.
    const served = JSON.stringify(credentials.list()) + JSON.stringify(credentials.getView(credential.id));
    assert.equal(served.includes(LEAK_CANARY), false);
    // The credential record itself is metadata only.
    assert.equal(JSON.stringify(credentials.get(credential.id)).includes(LEAK_CANARY), false);
  });

  test("§29: a credential temp root never survives an operation", async () => {
    const dataDir = tempDir("af-leak-data-");
    const store = await Store.open(dataDir);
    const credentials = new SourceCredentialService(store);
    const credential = await credentials.create({ name: "c", type: "https-token", value: LEAK_CANARY });
    const input = credentials.resolve(credential.id)!;
    const dir = join(dataDir, "git-credentials", "op-1");
    const materialized = await materializeGitCredential(input, dir);
    await materialized.cleanup();
    const root = join(dataDir, "git-credentials");
    assert.deepEqual(existsSync(root) ? readdirSync(root) : [], [], "no credential material is left behind");
  });
});
