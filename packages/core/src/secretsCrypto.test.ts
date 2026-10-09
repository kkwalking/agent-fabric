/**
 * Secret values at rest (AES-256-GCM).
 *
 * Every assertion here reads the **file on disk**, not just the in-memory
 * record: the property being protected is "reading db.json no longer hands
 * you the user's Provider API keys and Git credentials".
 *
 * The pre-encryption behaviour these tests replace — a plaintext value in
 * db.json — is the *dirty data* case: it stays listable and deletable, and
 * any attempt to read its value fails with `secret-legacy-format`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, newId } from "./store.js";
import { SecretService, ProviderService, SourceCredentialService } from "./services.js";
import { DomainError } from "./errors.js";
import {
  ENCRYPTED_SECRET_PREFIX,
  SECRET_KEY_FILE,
  createSecretCipher,
  isEncryptedSecretValue,
  loadOrCreateSecretKey,
} from "./secretCrypto.js";
import type { Secret } from "./types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "af-secretcrypto-"));
}

function dbPath(dir: string): string {
  return join(dir, "db.json");
}

/** The raw stored rows as they sit on disk. */
function storedSecrets(dir: string): Secret[] {
  const db = JSON.parse(readFileSync(dbPath(dir), "utf8")) as { secrets: Secret[] };
  return db.secrets;
}

function assertDomainCode(err: unknown, code: string): boolean {
  assert.ok(err instanceof DomainError, `expected a DomainError, got ${String(err)}`);
  assert.equal((err as DomainError).code, code);
  return true;
}

/** Captures console.error for the duration of `fn`. */
async function captureErrors<T>(fn: () => T | Promise<T>): Promise<{ result: T; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

describe("secret encryption at rest", () => {
  test("the key is 32 random bytes in `secret.key`, mode 0600, hex text", async () => {
    const dir = tempDir();
    const key = loadOrCreateSecretKey(dir);
    assert.equal(key.length, 32);

    const stat = statSync(join(dir, SECRET_KEY_FILE));
    assert.equal(stat.mode & 0o777, 0o600, "the key file is readable only by its owner");

    const text = readFileSync(join(dir, SECRET_KEY_FILE), "utf8").trim();
    assert.match(text, /^[0-9a-f]{64}$/, "the key is hex text, so it can be backed up by hand");
    assert.equal(Buffer.from(text, "hex").equals(key), true);

    // "首次需要即生成": a second call returns the same key, not a new one.
    assert.equal(loadOrCreateSecretKey(dir).equals(key), true);
    // …and a second process (fresh read of the same file) agrees.
    assert.equal(createSecretCipher(loadOrCreateSecretKey(dir)).decrypt(createSecretCipher(key).encrypt("v")), "v");
  });

  test("a created Secret's plaintext never reaches db.json", async () => {
    const dir = tempDir();
    const store = await Store.open(dir);
    const secrets = new SecretService(store);
    const plaintext = "sk-live-0123456789abcdef-PLAINTEXT-CANARY";
    const created = await secrets.create({ name: "PROVIDER_KEY", value: plaintext, scope: "provider" });

    // On disk: the value is ciphertext, and the key is not written down next
    // to it in any form.
    const raw = readFileSync(dbPath(dir), "utf8");
    assert.equal(raw.includes(plaintext), false, "the plaintext value must not appear in db.json");
    const keyHex = readFileSync(join(dir, SECRET_KEY_FILE), "utf8").trim();
    assert.equal(raw.includes(keyHex), false, "the key itself must never enter db.json");

    const row = storedSecrets(dir).find((s) => s.id === created.id)!;
    assert.equal(isEncryptedSecretValue(row.value!), true, "the stored value is in the enc:v1 format");
    assert.equal(row.value!.startsWith(ENCRYPTED_SECRET_PREFIX), true);
    assert.equal(row.value!.split(":").length, 5, "enc:v1:<iv>:<authTag>:<ciphertext>");

    // `masked` is still derived from the plaintext at creation, so listing
    // never needs to decrypt.
    assert.equal(row.masked, created.masked);
    assert.equal(secrets.list().find((s) => s.id === created.id)?.masked, created.masked);
  });

  test("getWithValue round-trips including multi-byte UTF-8, emoji and long values", async () => {
    const dir = tempDir();
    const store = await Store.open(dir);
    const secrets = new SecretService(store);
    const values: Record<string, string> = {
      unicode: "密钥-值-テスト-🔑",
      emoji: "🔐🗝️ a secret with 👨👩👧👦 family emoji",
      colonsAndNewlines: "line1\nline2:with:colons\n-----BEGIN KEY-----\nabc\n-----END KEY-----",
      long: "x".repeat(20_000),
      short: "tiny",
      emptyish: " ",
    };
    for (const [name, value] of Object.entries(values)) {
      const created = await secrets.create({ name, value });
      const read = secrets.getWithValue(created.id);
      assert.equal(read?.value, value, `round-trip failed for ${name}`);
    }
    // The value the API serves right after creation is the plaintext, not the
    // ciphertext the store holds.
    const created = await secrets.create({ name: "served", value: "served-plain-1234" });
    assert.equal(created.value, "served-plain-1234");
    assert.equal(store.get<Secret>("secrets", created.id)!.value!.startsWith(ENCRYPTED_SECRET_PREFIX), true);
  });

  test("ciphertext decrypts across a restart (fresh Store + SecretService over the same dir)", async () => {
    const dir = tempDir();
    const first = await Store.open(dir);
    const created = await new SecretService(first).create({ name: "RESUMED", value: "restart-me-please-42" });

    // A new process: nothing in memory, everything read back from disk.
    const second = await Store.open(dir);
    const read = new SecretService(second).getWithValue(created.id);
    assert.equal(read?.value, "restart-me-please-42");
  });

  test("a tampered ciphertext fails authentication instead of returning garbage", async () => {
    const dir = tempDir();
    const store = await Store.open(dir);
    const secrets = new SecretService(store);
    const created = await secrets.create({ name: "TAMPER", value: "tamper-target-value" });

    const db = JSON.parse(readFileSync(dbPath(dir), "utf8")) as { secrets: Secret[] };
    const row = db.secrets.find((s) => s.id === created.id)!;
    const parts = row.value!.split(":");
    const body = parts[4]!;
    // One base64 character changed: same length, different ciphertext.
    parts[4] = (body[0] === "A" ? "B" : "A") + body.slice(1);
    row.value = parts.join(":");
    writeFileSync(dbPath(dir), JSON.stringify(db, null, 2));

    const reopened = await Store.open(dir);
    const reopenedSecrets = new SecretService(reopened);
    assert.throws(() => reopenedSecrets.getWithValue(created.id), (err) => assertDomainCode(err, "secret-decrypt-failed"));
    // The record itself is still listable and removable — that is the repair path.
    assert.equal(reopenedSecrets.list().some((s) => s.id === created.id), true);
    assert.equal(await reopenedSecrets.remove(created.id), true);
    assert.equal(reopenedSecrets.getWithValue(created.id), undefined);
  });

  test("a replaced key file makes every decryption fail loudly (never silently empty)", async () => {
    const dir = tempDir();
    const store = await Store.open(dir);
    const created = await new SecretService(store).create({ name: "ROTATED", value: "written-with-the-old-key" });
    assert.equal(new SecretService(store).getWithValue(created.id)?.value, "written-with-the-old-key");

    // Someone deleted/replaced secret.key (or restored an older backup).
    writeFileSync(join(dir, SECRET_KEY_FILE), `${"ab".repeat(32)}\n`, { mode: 0o600 });

    const reopened = await Store.open(dir);
    const secrets = new SecretService(reopened);
    assert.throws(() => secrets.getWithValue(created.id), (err) => assertDomainCode(err, "secret-decrypt-failed"));
    // list() takes no part in decryption, so the UI can still show and delete it.
    assert.equal(secrets.list().some((s) => s.id === created.id), true);
    assert.equal(await secrets.remove(created.id), true);
  });

  test("a key file that is not a 32-byte hex key is refused, not overwritten", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, SECRET_KEY_FILE), "not-a-key\n", { mode: 0o600 });
    assert.throws(() => loadOrCreateSecretKey(dir), (err) => assertDomainCode(err, "secret-key-invalid"));
    // The bad file is left exactly as it was — a valid key elsewhere in a
    // backup must not be replaced by a fresh one we would then trust.
    assert.equal(readFileSync(join(dir, SECRET_KEY_FILE), "utf8"), "not-a-key\n");

    // A malformed *stored* value is its own refusal.
    const cipher = createSecretCipher(loadOrCreateSecretKey(tempDir()));
    for (const bad of ["enc:v1:only-two-parts", "enc:v1:a:b:c:d", "plain-text-value"]) {
      assert.throws(() => cipher.decrypt(bad), (err) => assertDomainCode(err, "secret-decrypt-failed"));
    }
  });

  test("decryption uses a fresh IV per write, so identical values differ on disk", async () => {
    const dir = tempDir();
    const store = await Store.open(dir);
    const secrets = new SecretService(store);
    const a = await secrets.create({ name: "a", value: "same-value-twice" });
    const b = await secrets.create({ name: "b", value: "same-value-twice" });
    const rows = storedSecrets(dir);
    const storedA = rows.find((s) => s.id === a.id)!.value!;
    const storedB = rows.find((s) => s.id === b.id)!.value!;
    assert.notEqual(storedA, storedB, "identical plaintexts must not produce identical stored values");
    assert.equal(secrets.getWithValue(a.id)?.value, "same-value-twice");
    assert.equal(secrets.getWithValue(b.id)?.value, "same-value-twice");
  });
});

describe("pre-encryption (plaintext) Secret records", () => {
  /** Writes a db.json holding one legacy plaintext secret, as an old build left it. */
  async function legacyStore(plaintext = "legacy-plaintext-canary"): Promise<{ dir: string; store: Store; id: string }> {
    const dir = tempDir();
    const id = newId("sec");
    const db = {
      secrets: [
        {
          id,
          name: "Legacy GitHub token",
          value: plaintext,
          masked: "leg***nary",
          scope: "git",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    writeFileSync(dbPath(dir), JSON.stringify(db, null, 2));
    return { dir, store: await Store.open(dir), id };
  }

  test("startup names the affected secrets loudly and never prints their values", async () => {
    const { store, id } = await legacyStore();
    const { lines } = await captureErrors(() => new SecretService(store));
    const output = lines.join("\n");
    assert.match(output, /plaintext format/, "the startup warning is loud about the format");
    assert.ok(output.includes(id), "the warning lists the affected secret id");
    assert.ok(output.includes("Legacy GitHub token"), "the warning lists the affected secret name");
    assert.equal(output.includes("legacy-plaintext-canary"), false, "the warning never echoes the value");
    assert.match(output, /remove|delete/i, "the warning says how to repair it");
  });

  test("reading the value is refused with secret-legacy-format; list and remove still work", async () => {
    const { store, id } = await legacyStore();
    const secrets = new SecretService(store);

    assert.throws(() => secrets.getWithValue(id), (err) => assertDomainCode(err, "secret-legacy-format"));
    // The message tells the user what to do and leaks nothing.
    try {
      secrets.getWithValue(id);
    } catch (err) {
      const message = (err as Error).message;
      assert.equal(message.includes("legacy-plaintext-canary"), false);
      assert.match(message, /remove|delete/i);
    }

    // list() / get() / remove() are the repair path: they must not decrypt.
    const listed = secrets.list().find((s) => s.id === id);
    assert.equal(listed?.name, "Legacy GitHub token");
    assert.equal(listed?.value, undefined, "list never serves a value");
    assert.equal(secrets.get(id)?.scope, "git");
    assert.equal(await secrets.remove(id), true);
    assert.equal(secrets.list().length, 0);

    // …and the removal is durable.
    const reopened = await Store.open((await legacyStore()).dir);
    assert.equal(reopened.list<Secret>("secrets").length, 1, "a fresh dir keeps its own record");
  });

  test("resolve()/resolveForGit() propagate the refusal instead of handing back a plaintext value", async () => {
    const { store, id } = await legacyStore();
    const secrets = new SecretService(store);
    assert.throws(() => secrets.resolveForGit([id]), (err) => assertDomainCode(err, "secret-legacy-format"));
    assert.throws(() => secrets.resolve([id], "agent-runtime"), (err) => assertDomainCode(err, "secret-legacy-format"));
  });

  test("new writes are encrypted even when a legacy record sits beside them", async () => {
    const { dir, store } = await legacyStore();
    const secrets = new SecretService(store);
    const fresh = await secrets.create({ name: "New", value: "new-value-1234" });
    assert.equal(storedSecrets(dir).find((s) => s.id === fresh.id)!.value!.startsWith(ENCRYPTED_SECRET_PREFIX), true);
    assert.equal(secrets.getWithValue(fresh.id)?.value, "new-value-1234");
  });
});

describe("every writer of the secrets collection encrypts", () => {
  test("provider API keys are stored as ciphertext and still resolve for a run", async () => {
    const dir = tempDir();
    const store = await Store.open(dir);
    const providers = new ProviderService(store);
    const apiKey = "sk-provider-api-key-canary-123456";
    const provider = await providers.create({ name: "OpenAI", type: "openai", apiKey });

    const raw = readFileSync(dbPath(dir), "utf8");
    assert.equal(raw.includes(apiKey), false, "the provider API key must not sit in db.json");
    assert.equal(JSON.stringify(provider).includes(apiKey), false, "the provider record never carries the key");
    assert.ok(provider.apiKeyMasked?.includes("***"));

    const secret = store.get<Secret>("secrets", provider.apiKeySecretId!)!;
    assert.equal(secret.value!.startsWith(ENCRYPTED_SECRET_PREFIX), true);
    assert.equal(new SecretService(store).getWithValue(provider.apiKeySecretId!)?.value, apiKey, "the run path can still read it");

    // Re-saving the key in the provider editor re-encrypts rather than reverting to plaintext.
    const rotated = "sk-provider-api-key-rotated-654321";
    await providers.update(provider.id, { apiKey: rotated });
    assert.equal(readFileSync(dbPath(dir), "utf8").includes(rotated), false, "a rotated key is encrypted too");
    assert.equal(new SecretService(store).getWithValue(provider.apiKeySecretId!)?.value, rotated);
    // The secret keeps its identity: same id, one row.
    assert.equal(storedSecrets(dir).filter((s) => s.id === provider.apiKeySecretId).length, 1);
  });

  test("Git credentials (token, private key, passphrase) are ciphertext and still resolve for Git", async () => {
    const dir = tempDir();
    const store = await Store.open(dir);
    const credentials = new SourceCredentialService(store);
    const token = "ghp_git-credential-canary-0001";
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\ncanary-private-key-material\n-----END OPENSSH PRIVATE KEY-----";
    const passphrase = "ssh-passphrase-canary";

    const https = await credentials.create({ name: "GitHub", type: "https-token", username: "octocat", value: token });
    const ssh = await credentials.create({ name: "Internal", type: "ssh-key", username: "git", value: key, passphrase });

    const raw = readFileSync(dbPath(dir), "utf8");
    for (const [label, value] of [["token", token], ["private key", key], ["passphrase", passphrase]] as const) {
      assert.equal(raw.includes(value), false, `the ${label} must not sit in db.json`);
    }
    // The API serves masks only.
    const served = JSON.stringify(credentials.list()) + JSON.stringify(credentials.getView(https.id));
    for (const value of [token, key, passphrase]) assert.equal(served.includes(value), false);

    // The credential broker is the one path that gets the plaintext.
    assert.deepEqual(credentials.resolve(https.id), { type: "https-token", username: "octocat", token });
    const sshInput = credentials.resolve(ssh.id)!;
    assert.equal(sshInput.type, "ssh-key");
    assert.equal(sshInput.privateKey, key);
    assert.equal(sshInput.passphrase, passphrase);

    // Rotation keeps the credential usable and the disk clean.
    const rotated = "ghp_git-credential-rotated-0002";
    await credentials.update(https.id, { value: rotated });
    assert.equal(readFileSync(dbPath(dir), "utf8").includes(rotated), false, "a rotated credential value is encrypted too");
    assert.equal(credentials.resolve(https.id)!.token, rotated);
  });

  test("a legacy plaintext credential fails at the broker boundary instead of being sent to a remote", async () => {
    const dir = tempDir();
    const secretId = newId("sec");
    writeFileSync(
      dbPath(dir),
      JSON.stringify({
        secrets: [
          {
            id: secretId,
            name: "Legacy token",
            value: "legacy-git-token-canary",
            masked: "leg***nary",
            scope: "git",
            createdAt: "",
            updatedAt: "",
          },
        ],
        sourceCredentials: [
          { id: "cred_1", name: "old", type: "https-token", secretId, createdAt: "", updatedAt: "" },
        ],
      })
    );
    const store = await Store.open(dir);
    const credentials = new SourceCredentialService(store);
    await captureErrors(() => new SecretService(store));
    assert.throws(() => credentials.resolve("cred_1"), (err) => assertDomainCode(err, "secret-legacy-format"));
    // The credential metadata is still visible for the user to delete/re-save.
    assert.equal(credentials.getView("cred_1")?.secretMasked, "leg***nary");
    assert.equal(await credentials.remove("cred_1"), true);
  });
});
