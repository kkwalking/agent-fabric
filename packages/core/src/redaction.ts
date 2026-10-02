/**
 * Secret redaction (v11 §34/§42).
 *
 * Credential material (HTTPS tokens, SSH private keys, passphrases, secret
 * values) must never reach a log line, an event payload, an API response, a
 * runtime stdout/stderr record, an error message, `.git/config` or task
 * metadata. Every value that passes through a lifecycle boundary is pushed
 * through one `SecretRedactor` so the guarantee is testable in one place.
 *
 * This is a safety net, not the primary control: the primary control is that
 * credentials are only materialized for the duration of a Git operation and
 * never written into configuration, argv, or the workspace.
 */

/** Placeholder substituted for redacted material. */
export const REDACTED = "***redacted***";

/** Values shorter than this are not treated as secrets (avoids mangling text). */
const MIN_SECRET_LENGTH = 4;

export class SecretRedactor {
  private values: string[] = [];

  constructor(values: Iterable<string | undefined> = []) {
    for (const v of values) this.add(v);
  }

  /** Register a secret value. Ignored when empty or too short to be one. */
  add(value: string | undefined | null): void {
    if (typeof value !== "string") return;
    if (value.length < MIN_SECRET_LENGTH) return;
    if (this.values.includes(value)) return;
    // Longest first: a token that contains another registered value must be
    // replaced as a whole, not partially.
    this.values.push(value);
    this.values.sort((a, b) => b.length - a.length);
  }

  addAll(values: Iterable<string | undefined>): void {
    for (const v of values) this.add(v);
  }

  /** All registered values, longest first. */
  list(): string[] {
    return [...this.values];
  }

  /** Redacts every registered value inside `text`. */
  redact(text: string): string {
    let out = text;
    for (const value of this.values) {
      if (out.includes(value)) out = out.split(value).join(REDACTED);
    }
    return out;
  }

  /** True when `text` still contains a registered value. */
  leaks(text: string): boolean {
    return this.values.some((value) => text.includes(value));
  }

  /**
   * Deep-redacts a JSON-ish value (event payloads, metadata, API responses).
   * Object keys are preserved; strings are redacted recursively.
   */
  redactValue<T>(value: T): T {
    if (this.values.length === 0) return value;
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.walk(v);
      return out;
    }
    return value;
  }
}

/** Convenience for one-off redaction. */
export function redactText(text: string, secrets: Iterable<string | undefined>): string {
  return new SecretRedactor(secrets).redact(text);
}

/**
 * Redacts the credential-looking parts of a remote URL. Used before a URL is
 * ever echoed: a user-supplied `https://user:token@host/repo.git` must not be
 * printed back verbatim.
 */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/, "$1***@");
}

/**
 * True when a URL embeds a credential — never acceptable in a remote URL
 * (v11 §12).
 *
 * For HTTP(S) any userinfo is a credential. For SSH/git the username
 * (`ssh://git@host/…`) is ordinary addressing, so only a password form
 * (`user:pass@`) is treated as an embedded credential.
 */
export function urlHasUserInfo(url: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return false;
  if (scheme === "ssh" || scheme === "git") return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/.test(url);
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@\s]+@/.test(url);
}
