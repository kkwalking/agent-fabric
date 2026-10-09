/**
 * At-rest encryption for Secret values (AES-256-GCM).
 *
 * Secret values live in `db.json` beside everything else, so anyone who can
 * read that file can read every Provider API key and every Git credential in
 * it — and a Git credential is repository write access. This module is the
 * single place that turns a plaintext value into its stored form and back:
 *
 *   enc:v1:<iv_base64>:<auth_tag_base64>:<ciphertext_base64>
 *
 * The key is 32 random bytes in `<dataDir>/secret.key`, written as hex (so it
 * can be backed up by hand) with mode 0600, and generated the first time it is
 * needed. It never leaves this process: it is not logged, not stored in
 * db.json, and not part of any API response or error message.
 *
 * There is no fallback path. A stored value that is not in the `enc:v1:`
 * format is a pre-encryption record — the read path refuses it loudly
 * (`secret-legacy-format`) rather than guessing — and a value whose auth tag
 * does not verify (`secret-decrypt-failed`) is never returned as garbage, as
 * the ciphertext, or as an empty string.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "./errors.js";

/** Stored-value prefix identifying the `enc:v1` ciphertext format. */
export const ENCRYPTED_SECRET_PREFIX = "enc:v1:";

/** Name of the key file inside the data dir. */
export const SECRET_KEY_FILE = "secret.key";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEX_KEY = /^[0-9a-f]{64}$/;

/** Encrypts plaintext values for storage and decrypts them back. */
export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
}

/** True when a stored value is in the encrypted `enc:v1:` format. */
export function isEncryptedSecretValue(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_SECRET_PREFIX);
}

/**
 * The Secret key for a data dir: read `secret.key`, or create it (32 random
 * bytes, hex, mode 0600) on first use. Synchronous on purpose — the key is 32
 * bytes and the read path (`SecretService.getWithValue`) is synchronous.
 *
 * A key file that exists but is not a 32-byte hex key is a hard failure, not
 * something to overwrite: overwriting it would silently orphan every value
 * already encrypted with it.
 */
export function loadOrCreateSecretKey(dataDir: string): Buffer {
  const file = join(dataDir, SECRET_KEY_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DomainError("secret-key-invalid", `The Secret key file could not be read: ${file}`);
    }
    mkdirSync(dataDir, { recursive: true });
    const created = randomBytes(KEY_BYTES);
    writeFileSync(file, `${created.toString("hex")}\n`, { mode: 0o600 });
    // `mode` is subject to the process umask; chmod makes 0600 a fact.
    chmodSync(file, 0o600);
    return created;
  }
  const hex = text.trim().toLowerCase();
  if (!HEX_KEY.test(hex)) {
    throw new DomainError(
      "secret-key-invalid",
      `The Secret key file is not a 32-byte hex key: ${file}`,
      "restore secret.key from backup — a new key cannot decrypt values written with the old one"
    );
  }
  return Buffer.from(hex, "hex");
}

/** A cipher bound to one key. Encrypt/decrypt never touch the filesystem. */
export function createSecretCipher(key: Buffer): SecretCipher {
  if (key.length !== KEY_BYTES) {
    throw new DomainError("secret-key-invalid", `A Secret key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${ENCRYPTED_SECRET_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
    },

    decrypt(stored: string): string {
      const [ivB64, tagB64, ciphertextB64] = splitStoredValue(stored);
      const iv = Buffer.from(ivB64, "base64");
      const authTag = Buffer.from(tagB64, "base64");
      if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new DomainError("secret-decrypt-failed", "The stored Secret value is malformed (bad IV or auth tag length)");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      try {
        return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
      } catch {
        throw new DomainError(
          "secret-decrypt-failed",
          "The stored Secret value failed authentication — it was encrypted with a different key (secret.key replaced or deleted), or the stored value was altered",
          "re-create the Secret with the correct value"
        );
      }
    },
  };
}

/**
 * Encrypts one plaintext value for storage under `dataDir`. Used by every
 * writer of the `secrets` collection, so no service can accidentally store a
 * plaintext value.
 */
export function encryptSecretValue(dataDir: string, plaintext: string): string {
  return createSecretCipher(loadOrCreateSecretKey(dataDir)).encrypt(plaintext);
}

/**
 * Decrypts one stored value read from `dataDir`. Callers must have checked
 * `isEncryptedSecretValue` first: a plaintext (pre-encryption) record is a
 * `secret-legacy-format` refusal, not a decrypt failure.
 */
export function decryptSecretValue(dataDir: string, stored: string): string {
  return createSecretCipher(loadOrCreateSecretKey(dataDir)).decrypt(stored);
}

/** Splits `enc:v1:<iv>:<authTag>:<ciphertext>`; the ciphertext may be empty. */
function splitStoredValue(stored: string): [string, string, string] {
  if (!isEncryptedSecretValue(stored)) {
    throw new DomainError(
      "secret-decrypt-failed",
      "The stored Secret value is not in the enc:v1 format",
      "plaintext (pre-encryption) records are refused as secret-legacy-format"
    );
  }
  const parts = stored.slice(ENCRYPTED_SECRET_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new DomainError(
      "secret-decrypt-failed",
      "The stored Secret value is malformed (expected enc:v1:<iv>:<authTag>:<ciphertext>)"
    );
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}
