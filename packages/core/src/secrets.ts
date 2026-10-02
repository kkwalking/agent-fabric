/**
 * Secret scope authorization (v11 hardening §7/§8).
 *
 * A Secret's `scope` is an **authorization boundary**, not a label. The rule
 * this module enforces is deliberately blunt and lives at the one boundary
 * every secret consumer goes through (`SecretService.resolve` and the
 * provisioning / validation / MCP builders that call it):
 *
 *   `scope = "git"` → usable ONLY by the Git Credential Broker
 *                     (clone / fetch / remote inspection / push)
 *
 * A `git`-scoped secret is the repository write credential. It must never be
 * reachable from the agent runtime — not through task `secretIds`, not
 * through a runtime's `secretIds`, not through an agent profile, not through
 * a generated MCP configuration, not through a validation command's
 * environment. Even an explicit caller that passes the secret id is refused
 * here, because the guarantee has to hold for call paths that do not exist
 * yet (§8.3).
 *
 * Every other scope (`env`, `provider`, `runtime`, `mcp`, `validation`,
 * `service`, …) is ordinary secret material and is resolved for whichever
 * purpose asked. The boundary is one-directional on purpose: the thing that
 * needs protecting is the Git credential.
 */
import { DomainError } from "./errors.js";
import type { Secret } from "./types.js";

/** The authorization scopes AgentFabric recognizes. */
export type SecretScope = "git" | "provider" | "runtime" | "mcp" | "validation" | "env" | "service";

/** Why a secret is being resolved. */
export type SecretPurpose =
  /** Injected into the agent's runtime environment (task/run/runtime/profile/MCP). */
  | "agent-runtime"
  /** Written into the generated MCP server configuration. */
  | "mcp"
  /** Handed to a validation command inside the isolated validation runtime. */
  | "validation"
  /** Used to authenticate a model provider call (control plane). */
  | "provider"
  /** Used by the Git Credential Broker for one Git operation. */
  | "git";

/** The scopes each purpose may resolve. Git is exclusive to the broker. */
const SCOPE_ALLOWLIST: Record<SecretPurpose, SecretScope[] | "all-except-git"> = {
  "agent-runtime": "all-except-git",
  mcp: "all-except-git",
  validation: "all-except-git",
  provider: "all-except-git",
  git: ["git"],
};

/** Human-readable name of a purpose, used in refusal messages. */
const PURPOSE_LABEL: Record<SecretPurpose, string> = {
  "agent-runtime": "the agent runtime environment",
  mcp: "a generated MCP server configuration",
  validation: "the validation environment",
  provider: "a model provider call",
  git: "a Git operation",
};

/**
 * The domain error code a refusal carries. Validation has its own code so
 * the task view can say "this secret is not a validation secret" rather than
 * the generic scope error (§34).
 */
function refusalCode(purpose: SecretPurpose): "validation-secret-not-allowed" | "secret-scope-not-allowed" {
  return purpose === "validation" ? "validation-secret-not-allowed" : "secret-scope-not-allowed";
}

/** True when a secret of `scope` may be resolved for `purpose`. */
export function isSecretAllowedForPurpose(scope: string | undefined, purpose: SecretPurpose): boolean {
  const effective = (scope ?? "env") as SecretScope;
  const allow = SCOPE_ALLOWLIST[purpose];
  if (allow === "all-except-git") return effective !== "git";
  return allow.includes(effective);
}

/**
 * Throws unless the secret may be used for `purpose`. Called from the
 * resolution boundary, never from a UI or a request handler: a new caller
 * that forgets to check still cannot obtain a Git credential.
 */
export function assertSecretAllowed(secret: Pick<Secret, "id" | "name" | "scope">, purpose: SecretPurpose): void {
  if (isSecretAllowedForPurpose(secret.scope, purpose)) return;
  const code = refusalCode(purpose);
  throw new DomainError(
    code,
    `Secret "${secret.name}" has scope "${secret.scope ?? "env"}" and cannot be used for ${PURPOSE_LABEL[purpose]}`,
    purpose === "git"
      ? "only a git-scoped Source Credential secret may be used for Git operations"
      : "git-scoped secrets are reserved for the Git credential broker (clone / fetch / push)"
  );
}

/**
 * Resolves secret ids for one purpose, enforcing the scope policy for each.
 * Unknown ids are skipped exactly as before (an optional reference that no
 * longer resolves is not an authorization failure); a *present* secret whose
 * scope forbids the purpose is always a loud failure.
 */
export function resolveSecretsForPurpose(
  ids: string[] | undefined,
  purpose: SecretPurpose,
  lookup: (id: string) => Secret | undefined
): Secret[] {
  if (!ids?.length) return [];
  const resolved: Secret[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const secret = lookup(id);
    if (!secret) continue;
    assertSecretAllowed(secret, purpose);
    resolved.push(secret);
  }
  return resolved;
}

/**
 * Builds the environment a secret contributes to a runtime: one variable per
 * secret, named after the secret. Shared by the agent runtime and the
 * validation environment so both behave identically.
 */
export function secretEnvironment(secrets: Secret[]): Record<string, string> {
  return Object.fromEntries(secrets.map((s) => [s.name, s.value ?? ""]));
}
