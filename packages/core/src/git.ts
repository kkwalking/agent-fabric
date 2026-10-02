/**
 * Git operations for the Project source lifecycle (v11 §11/§12/§17/§18).
 *
 * Two properties are non-negotiable here:
 *
 * 1. **Credential isolation.** Git credentials never become a long-lived
 *    environment variable, a command argument, or part of a remote URL. They
 *    are materialized into a private temp directory for the duration of one
 *    operation and removed immediately afterwards:
 *    - HTTPS token → `GIT_ASKPASS` helper + process-local env (never argv,
 *      never `.git/config`, never a URL);
 *    - SSH key → 0600 key file + explicit `core.sshCommand` with
 *      `StrictHostKeyChecking=yes` (host keys are always verified).
 *    The remote URL stored in `.git/config` is always credential-free.
 *
 * 2. **No secret leakage.** Every command's captured output is passed through
 *    a `SecretRedactor` before it can reach a log, an event or an error, and
 *    the command *description* (what gets logged) is built from argv with all
 *    secret values redacted.
 *
 * The implementation is injected as a `GitOps` interface so the supervisor can
 * be tested against failure modes (auth failure, network failure, rejected
 * push, remote conflict) without a live server.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DomainError } from "./errors.js";
import { SecretRedactor, redactRemoteUrl, urlHasUserInfo } from "./redaction.js";
import type { SourceCredential, SourceCredentialType } from "./types.js";

/* ------------------------------------------------------------------ */
/* Credential materialization                                          */
/* ------------------------------------------------------------------ */

export interface GitCredentialInput {
  type: "https-token" | "ssh-key";
  username?: string;
  token?: string;
  privateKey?: string;
  passphrase?: string;
  /** known_hosts content; absent falls back to the host's own file. */
  knownHosts?: string;
}

/**
 * A credential made usable for exactly one operation. `args`/`env` go to the
 * git child process; `secrets` are the values that must never be observed;
 * `cleanup()` removes every trace.
 */
export interface MaterializedCredential {
  args: string[];
  env: Record<string, string>;
  secrets: string[];
  cleanup(): Promise<void>;
}

/** Default location for materialized credential material (per operation). */
export function gitCredentialTempRoot(dataDir: string, operation: string): string {
  return join(dataDir, "git-credentials", `${operation}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

/**
 * Materializes a credential into a private temp directory (mode 0700) and
 * returns the argv/env a single git operation needs.
 */
export async function materializeGitCredential(
  input: GitCredentialInput,
  dir: string
): Promise<MaterializedCredential> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
    // Leave no empty scaffold behind either; ENOTEMPTY (another operation is
    // still running) is expected and ignored.
    await rm(join(dir, ".."), { recursive: false, force: true }).catch(() => {});
  };

  if (input.type === "https-token") {
    if (!input.token) {
      throw new DomainError("source-credential-invalid", "The HTTPS credential has no token value");
    }
    // The token lives in the child process env only. The helper script reads
    // it back for git's credential prompt — argv and .git/config stay clean.
    const askpass = join(dir, "askpass.sh");
    await writeFile(
      askpass,
      [
        "#!/bin/sh",
        'case "$1" in',
        '  *sername*) printf "%s" "$AGENTFABRIC_GIT_USERNAME" ;;',
        '  *) printf "%s" "$AGENTFABRIC_GIT_PASSWORD" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 }
    );
    return {
      args: ["-c", "credential.helper="],
      env: {
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: "0",
        AGENTFABRIC_GIT_USERNAME: input.username || "x-access-token",
        AGENTFABRIC_GIT_PASSWORD: input.token,
      },
      secrets: [input.token],
      cleanup,
    };
  }

  if (input.type === "ssh-key") {
    if (!input.privateKey) {
      throw new DomainError("source-credential-invalid", "The SSH credential has no private key value");
    }
    const keyPath = join(dir, "id_key");
    await writeFile(keyPath, input.privateKey.endsWith("\n") ? input.privateKey : `${input.privateKey}\n`, { mode: 0o600 });
    const env: Record<string, string> = {};
    const sshArgs = ["-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "NumberOfPasswordPrompts=1"];
    if (input.knownHosts?.trim()) {
      const knownHostsPath = join(dir, "known_hosts");
      await writeFile(knownHostsPath, input.knownHosts.endsWith("\n") ? input.knownHosts : `${input.knownHosts}\n`, { mode: 0o600 });
      sshArgs.push("-o", `UserKnownHostsFile=${knownHostsPath}`);
    } else {
      // Host verification still applies — against the host's own known_hosts.
      sshArgs.push("-o", `UserKnownHostsFile=${join(homedir(), ".ssh", "known_hosts")}`);
    }
    const secrets: string[] = [input.privateKey];
    if (input.passphrase) {
      const askpass = join(dir, "ssh-askpass.sh");
      await writeFile(askpass, ["#!/bin/sh", 'printf "%s" "$AGENTFABRIC_SSH_PASSPHRASE"', ""].join("\n"), { mode: 0o700 });
      env.SSH_ASKPASS = askpass;
      env.SSH_ASKPASS_REQUIRE = "force";
      env.DISPLAY = env.DISPLAY ?? ":0";
      env.AGENTFABRIC_SSH_PASSPHRASE = input.passphrase;
      secrets.push(input.passphrase);
    }
    return {
      // The key *path* appears in argv; the key material never does.
      args: ["-c", `core.sshCommand=ssh ${sshArgs.join(" ")}`],
      env,
      secrets,
      cleanup,
    };
  }

  throw new DomainError("source-credential-invalid", `Unsupported credential type: ${String((input as { type?: string }).type)}`);
}

/* ------------------------------------------------------------------ */
/* Input validation (v11 §8.1/§42)                                     */
/* ------------------------------------------------------------------ */

const ALLOWED_URL_SCHEMES = ["https", "http", "ssh", "git", "file"];

/**
 * Validates a remote URL before it is ever handed to git. Rejects embedded
 * credentials (v11 §12), unknown schemes and control characters — a malicious
 * repository URL must fail loudly, not become a command.
 */
export function validateRemoteUrl(url: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: "remote URL is empty" };
  if (/[\s\u0000-\u001f]/.test(trimmed)) return { ok: false, reason: "remote URL contains whitespace or control characters" };
  if (trimmed.startsWith("-")) return { ok: false, reason: "remote URL must not start with '-'" };
  if (urlHasUserInfo(trimmed)) {
    return { ok: false, reason: "remote URL embeds credentials — configure a Source Credential instead" };
  }
  // scp-like syntax: git@github.com:org/repo.git
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(trimmed)) return { ok: true };
  // local absolute path (tests, self-hosted mirrors on disk)
  if (trimmed.startsWith("/")) return { ok: true };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed);
  if (!scheme) return { ok: false, reason: "remote URL must be an https/ssh/git URL, a git@host:path reference, or an absolute path" };
  if (!ALLOWED_URL_SCHEMES.includes(scheme[1].toLowerCase())) {
    return { ok: false, reason: `unsupported URL scheme "${scheme[1]}"` };
  }
  return { ok: true };
}

/** Ref patterns git itself refuses; checked before any ref reaches git. */
const INVALID_REF_CHARS = /[\s~^:?*\[\\\u0000-\u001f\u007f]/;
const INVALID_REF_SEQUENCES = ["..", "@{", "//", "\\"];

/**
 * Validates a branch name (v11 §8.1 "branch 名非法", §42 "malicious branch
 * name"). Mirrors `git check-ref-format --branch` closely enough that an
 * invalid name never reaches a git invocation.
 */
export function validateBranchName(name: string): { ok: true } | { ok: false; reason: string } {
  const branch = name.trim();
  if (!branch) return { ok: false, reason: "branch name is empty" };
  if (branch.length > 200) return { ok: false, reason: "branch name is too long (max 200 characters)" };
  if (branch.startsWith("-")) return { ok: false, reason: "branch name must not start with '-'" };
  if (branch.startsWith("/") || branch.endsWith("/")) return { ok: false, reason: "branch name must not start or end with '/'" };
  if (branch.endsWith(".")) return { ok: false, reason: "branch name must not end with '.'" };
  if (branch.endsWith(".lock")) return { ok: false, reason: "branch name must not end with '.lock'" };
  if (branch === "@") return { ok: false, reason: "branch name must not be '@'" };
  if (INVALID_REF_CHARS.test(branch)) return { ok: false, reason: "branch name contains invalid characters" };
  for (const seq of INVALID_REF_SEQUENCES) {
    if (branch.includes(seq)) return { ok: false, reason: `branch name must not contain "${seq}"` };
  }
  for (const part of branch.split("/")) {
    if (!part) return { ok: false, reason: "branch name must not contain empty path segments" };
    if (part.startsWith(".")) return { ok: false, reason: "branch path segments must not start with '.'" };
  }
  if (branch.startsWith("refs/")) return { ok: false, reason: "branch name must not be a full ref" };
  return { ok: true };
}

/** Slug used in system-generated branch names: `af/<taskId>-<slug>` (v11 §8). */
export function branchSlug(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "task";
}

/* ------------------------------------------------------------------ */
/* Remote host & credential binding (v11 hardening §9/§10)             */
/* ------------------------------------------------------------------ */

/** How a remote URL authenticates. */
export type RemoteTransport = "https" | "ssh" | "local";

export interface RemoteEndpoint {
  transport: RemoteTransport;
  /** Host the credential would be sent to; absent for a local path remote. */
  host?: string;
}

/** Case-insensitive host comparison (DNS names are case-insensitive). */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Extracts the real host and transport from a repository remote URL
 * (v11 hardening §10). Handles the three shapes AgentFabric accepts:
 *
 *   https://github.com/org/repo.git      → { https, github.com }
 *   ssh://git@gitlab.com/org/repo.git    → { ssh,   gitlab.com }
 *   git@github.com:org/repo.git          → { ssh,   github.com }
 *   /srv/git/repo.git                    → { local }
 *
 * Returns `undefined` for a URL that carries no host at all (a local path).
 */
export function parseRemoteEndpoint(remoteUrl: string): RemoteEndpoint | undefined {
  const url = remoteUrl.trim();
  if (!url) return undefined;
  if (url.startsWith("/") || url.startsWith("file://")) return { transport: "local" };

  // scp-like: user@host:path (no scheme, no port syntax)
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):/.exec(url);
  if (scp) return { transport: "ssh", host: normalizeHost(scp[1]) };

  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^/@\s]*)@)?([^/\s:]+)(?::(\d+))?/.exec(url);
  if (!match) return undefined;
  const scheme = match[1].toLowerCase();
  const host = normalizeHost(match[3]);
  if (!host) return undefined;
  if (scheme === "ssh" || scheme === "git") return { transport: "ssh", host };
  if (scheme === "http" || scheme === "https") return { transport: "https", host };
  return { transport: "local", host };
}

/** True when `pattern` (exact host or `*.suffix` wildcard) covers `host`. */
export function hostPatternMatches(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern);
  const h = normalizeHost(host);
  if (!p || !h) return false;
  if (p === h) return true;
  if (!p.startsWith("*.")) return false;
  const suffix = p.slice(1); // ".internal.example.com"
  // A wildcard covers sub-domains only — never the bare domain itself.
  return h.endsWith(suffix) && h.length > suffix.length;
}

/** Which transports each credential type can actually authenticate. */
const CREDENTIAL_TRANSPORTS: Record<SourceCredentialType, RemoteTransport[]> = {
  "https-token": ["https"],
  "ssh-key": ["ssh"],
};

export interface CredentialBindingCheck {
  ok: boolean;
  code: "credential-host-mismatch" | "credential-transport-mismatch";
  message: string;
  detail?: string;
}

/**
 * Verifies a Source Credential may be used against a repository remote
 * (v11 hardening §9/§10/§10.2). Two independent constraints:
 *
 * 1. **Host binding** — the credential's `host` (exact or `*.suffix`) must
 *    cover the remote's real host. A credential is never sent to a host it
 *    was not scoped to.
 * 2. **Transport compatibility** — an HTTPS token cannot authenticate an SSH
 *    remote and an SSH key cannot be an HTTPS token. There is no silent
 *    downgrade: the mismatch is an explicit refusal.
 *
 * A credential with no `host` is a wildcard by intent (the user did not scope
 * it); the transport rule still applies. Local-path remotes need neither.
 */
export function checkCredentialBinding(
  credential: Pick<SourceCredential, "name" | "type" | "host">,
  remoteUrl: string
): CredentialBindingCheck {
  const endpoint = parseRemoteEndpoint(remoteUrl);
  if (!endpoint || endpoint.transport === "local") return { ok: true, code: "credential-transport-mismatch", message: "" };

  const allowed = CREDENTIAL_TRANSPORTS[credential.type] ?? [];
  if (!allowed.includes(endpoint.transport)) {
    const wanted = endpoint.transport === "ssh" ? "an SSH key" : "an HTTPS token";
    const have = credential.type === "ssh-key" ? "an SSH key" : "an HTTPS token";
    return {
      ok: false,
      code: "credential-transport-mismatch",
      message: `Credential "${credential.name}" is ${have} but the repository remote uses ${endpoint.transport} — configure ${wanted}`,
      detail: "credential type and remote transport must agree; AgentFabric never downgrades a credential",
    };
  }

  if (credential.host && endpoint.host && !hostPatternMatches(credential.host, endpoint.host)) {
    return {
      ok: false,
      code: "credential-host-mismatch",
      message: `Credential "${credential.name}" is scoped to "${credential.host}" but the repository remote is on "${endpoint.host}"`,
      detail: "a source credential is never sent to an unauthorized host",
    };
  }
  return { ok: true, code: "credential-host-mismatch", message: "" };
}
export function generateWorkingBranch(taskId: string, title: string): string {
  const shortId = taskId.replace(/^task_/, "").slice(0, 8);
  return `af/${shortId}-${branchSlug(title)}`;
}

/* ------------------------------------------------------------------ */
/* Failure classification                                              */
/* ------------------------------------------------------------------ */

const AUTH_PATTERNS = [
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /permission denied \(publickey\)/i,
  /invalid username or password/i,
  /http basic: access denied/i,
  /remote: invalid credentials/i,
  /access denied/i,
  /403 forbidden/i,
  /host key verification failed/i,
  /terminal prompts disabled/i,
];

const NOT_FOUND_PATTERNS = [/repository not found/i, /does not exist/i, /not found/i, /no such file or directory/i];
const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /connection (refused|timed out|reset|closed)/i,
  /network is unreachable/i,
  /operation timed out/i,
  /failed to connect/i,
  /unable to access/i,
  /ssl|tls/i,
  /proxy/i,
];
const REJECTED_PATTERNS = [/\[rejected\]/i, /non-fast-forward/i, /failed to push some refs/i, /fetch first/i, /protected branch/i];

/**
 * Maps git's own stderr onto the domain error model (v11 §22). Auth is checked
 * before not-found: git reports a private repository's auth failure as
 * "repository not found" on purpose, and the user needs the real reason.
 */
export function classifyGitFailure(stderr: string, operation: string): DomainError {
  const text = stderr || "";
  const match = (patterns: RegExp[]): boolean => patterns.some((p) => p.test(text));
  if (match(AUTH_PATTERNS)) {
    return new DomainError(
      operation === "push" ? "git-push-auth-failed" : "source-auth-failed",
      operation === "push"
        ? "Pushing was rejected: the source credential could not authenticate"
        : "The repository could not be read: the source credential was rejected",
      text.trim().split("\n").slice(-3).join(" ")
    );
  }
  if (operation === "push" && match(REJECTED_PATTERNS)) {
    return new DomainError("git-push-rejected", "The remote rejected the push (the branch has diverged)", text.trim().split("\n").slice(-3).join(" "));
  }
  if (match(NOT_FOUND_PATTERNS)) {
    return new DomainError("source-not-found", "The repository does not exist or is not reachable", text.trim().split("\n").slice(-3).join(" "));
  }
  if (match(NETWORK_PATTERNS)) {
    return new DomainError("source-network-failed", "The repository could not be reached over the network", text.trim().split("\n").slice(-3).join(" "));
  }
  if (operation === "push") {
    return new DomainError("git-push-failed", "Pushing the working branch failed", text.trim().split("\n").slice(-3).join(" "));
  }
  if (operation === "commit") {
    return new DomainError("git-commit-failed", "Creating the final commit failed", text.trim().split("\n").slice(-3).join(" "));
  }
  return new DomainError("source-network-failed", `git ${operation} failed`, text.trim().split("\n").slice(-3).join(" "));
}

/* ------------------------------------------------------------------ */
/* GitOps                                                             */
/* ------------------------------------------------------------------ */

export interface GitStatus {
  branch?: string;
  head?: string;
  detached: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

export interface GitCommandOptions {
  dir: string;
  credential?: MaterializedCredential;
  timeoutMs?: number;
  /** Values to keep out of any error message (provider secrets etc.). */
  redactor?: SecretRedactor;
  /**
   * Cancels the underlying git process (v11 §32: cancelling a task must stop
   * the work it started, including an in-flight clone or push).
   */
  signal?: AbortSignal;
}

export interface GitOps {
  /** Human-readable binary name (diagnostics only). */
  readonly bin: string;
  clone(opts: { remoteUrl: string; dest: string; credential?: MaterializedCredential; timeoutMs?: number; redactor?: SecretRedactor; signal?: AbortSignal }): Promise<void>;
  fetch(opts: GitCommandOptions & { remoteUrl: string }): Promise<void>;
  setRemoteUrl(opts: GitCommandOptions & { url: string }): Promise<void>;
  isRepository(opts: { dir: string }): Promise<boolean>;
  resolveRevision(opts: GitCommandOptions & { ref: string }): Promise<string>;
  branchExists(opts: GitCommandOptions & { branch: string }): Promise<boolean>;
  remoteBranchSha(opts: GitCommandOptions & { remoteUrl: string; branch: string }): Promise<string | undefined>;
  createBranch(opts: GitCommandOptions & { branch: string; startPoint: string }): Promise<void>;
  checkout(opts: GitCommandOptions & { ref: string }): Promise<void>;
  currentBranch(opts: GitCommandOptions): Promise<string | undefined>;
  head(opts: GitCommandOptions): Promise<string | undefined>;
  status(opts: GitCommandOptions): Promise<GitStatus>;
  stageAll(opts: GitCommandOptions): Promise<void>;
  commit(opts: GitCommandOptions & { message: string; author?: { name: string; email: string } }): Promise<string>;
  commitsBetween(opts: GitCommandOptions & { from: string; to: string }): Promise<string[]>;
  push(opts: GitCommandOptions & { remote: string; branch: string }): Promise<void>;
  /**
   * Pushes one **exact revision** to a remote branch (v11 hardening §13):
   * `git push <remote> <sha>:refs/heads/<branch>`. This is the only publish
   * primitive a Project task uses, because it publishes the frozen
   * `finalCommitSha` regardless of what the local working tree or branch has
   * done since. Never forced, never a tag.
   */
  pushRevision(opts: GitCommandOptions & { remote: string; branch: string; revision: string }): Promise<void>;
}

/** The exact argv a git invocation used, redacted for logging. */
export function describeGitCommand(args: string[], redactor?: SecretRedactor): string {
  const joined = `git ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;
  return redactor ? redactor.redact(joined) : joined;
}

function runGit(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; redactor?: SecretRedactor; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        timeout: opts.timeoutMs ?? 10 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) {
          const redact = (text: string) => (opts.redactor ? opts.redactor.redact(text) : text);
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (opts.signal?.aborted) {
            reject(new DomainError("agent-cancelled", `git ${args[0]} was cancelled`));
            return;
          }
          if (e.killed) {
            reject(new DomainError("source-network-failed", `git ${args[0]} timed out`));
            return;
          }
          reject(new Error(redact(String(stderr || e.message))));
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
    const onAbort = () => child.kill("SIGKILL");
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function gitArgs(credential: MaterializedCredential | undefined, args: string[]): string[] {
  return [...(credential?.args ?? []), ...args];
}

function gitEnv(credential: MaterializedCredential | undefined): Record<string, string> {
  return { ...(credential?.env ?? {}) };
}

/** Real git CLI implementation. */
export function createGitOps(bin = process.env.AGENTFABRIC_GIT_BIN ?? "git"): GitOps {
  const exec = async (
    args: string[],
    opts: {
      cwd?: string;
      credential?: MaterializedCredential;
      timeoutMs?: number;
      redactor?: SecretRedactor;
      signal?: AbortSignal;
      operation: string;
    }
  ): Promise<{ stdout: string; stderr: string }> => {
    try {
      return await runGit(bin, args, {
        cwd: opts.cwd,
        env: gitEnv(opts.credential),
        timeoutMs: opts.timeoutMs,
        redactor: opts.redactor,
        signal: opts.signal,
      });
    } catch (err) {
      // A cancellation is already a domain decision — never reclassify it.
      if (err instanceof DomainError) throw err;
      // execFile's error message is the (already redacted) stderr.
      throw classifyGitFailure(err instanceof Error ? err.message : String(err), opts.operation);
    }
  };

  return {
    bin,

    async clone({ remoteUrl, dest, credential, timeoutMs, redactor, signal }) {
      await mkdir(join(dest, ".."), { recursive: true });
      await exec(gitArgs(credential, ["clone", "--quiet", "--no-tags", remoteUrl, dest]), {
        credential,
        timeoutMs,
        redactor,
        signal,
        operation: "clone",
      });
      // The remote URL is credential-free by construction; re-assert it so a
      // redirect or helper can never have rewritten it with userinfo.
      await exec(["remote", "set-url", "origin", remoteUrl], { cwd: dest, operation: "set-remote" });
    },

    async fetch({ dir, credential, timeoutMs, redactor, signal }) {
      // All heads → refs/remotes/origin/*, pruned: base refs resolve reliably
      // and deleted remote branches do not linger.
      await exec(gitArgs(credential, ["fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]), {
        cwd: dir,
        credential,
        timeoutMs,
        redactor,
        signal,
        operation: "fetch",
      });
    },

    async setRemoteUrl({ dir, url }) {
      await exec(["remote", "set-url", "origin", url], { cwd: dir, operation: "set-remote" });
    },

    async isRepository({ dir }) {
      try {
        const { stdout } = await runGit(bin, ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
        return stdout.trim() === "true";
      } catch {
        return false;
      }
    },

    async resolveRevision({ dir, ref, credential }) {
      // Try the ref as given, then as a remote-tracking branch. A bare SHA is
      // accepted too — the base ref may name a revision rather than a branch.
      for (const candidate of [ref, `refs/remotes/origin/${ref}`]) {
        try {
          const { stdout } = await runGit(bin, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
            cwd: dir,
            env: gitEnv(credential),
          });
          const sha = stdout.trim();
          if (sha) return sha;
        } catch {
          /* try the next form */
        }
      }
      throw new DomainError("base-ref-not-found", `The base ref "${ref}" does not exist in this repository`);
    },

    async branchExists({ dir, branch }) {
      try {
        const { stdout } = await runGit(bin, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: dir });
        return Boolean(stdout.trim());
      } catch {
        return false;
      }
    },

    async remoteBranchSha({ dir, remoteUrl, branch, credential, timeoutMs, redactor, signal }) {
      const { stdout } = await exec(
        gitArgs(credential, ["ls-remote", "--heads", remoteUrl, `refs/heads/${branch}`]),
        { cwd: dir, credential, timeoutMs, redactor, signal, operation: "ls-remote" }
      );
      const line = stdout.split("\n").map((l) => l.trim()).find(Boolean);
      if (!line) return undefined;
      return line.split(/\s+/)[0];
    },

    async createBranch({ dir, branch, startPoint }) {
      // `checkout -b` refuses to move an existing branch — branch collision is
      // an explicit error, never a silent overwrite (v11 §8.1).
      await exec(["checkout", "-b", branch, startPoint], { cwd: dir, operation: "branch" });
    },

    async checkout({ dir, ref }) {
      await exec(["checkout", "--quiet", ref], { cwd: dir, operation: "checkout" });
    },

    async currentBranch({ dir }) {
      try {
        const { stdout } = await runGit(bin, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
        const name = stdout.trim();
        return name && name !== "HEAD" ? name : undefined;
      } catch {
        return undefined;
      }
    },

    async head({ dir }) {
      try {
        const { stdout } = await runGit(bin, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: dir });
        return stdout.trim() || undefined;
      } catch {
        return undefined;
      }
    },

    async status({ dir }) {
      const { stdout } = await exec(["status", "--porcelain=v1", "-b", "--untracked-files=all"], { cwd: dir, operation: "status" });
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      const status: GitStatus = { detached: false, staged: [], unstaged: [], untracked: [], clean: true };
      for (const line of lines) {
        if (line.startsWith("## ")) {
          const info = line.slice(3);
          if (info.startsWith("HEAD (no branch)")) {
            status.detached = true;
          } else {
            status.branch = info.split("...")[0]?.split(" ")[0];
          }
          continue;
        }
        const x = line[0];
        const y = line[1];
        const path = line.slice(3).trim();
        if (x === "?" && y === "?") {
          status.untracked.push(path);
        } else {
          if (x !== " " && x !== "?") status.staged.push(path);
          if (y !== " " && y !== "?") status.unstaged.push(path);
        }
      }
      status.clean = status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0;
      return status;
    },

    async stageAll({ dir }) {
      await exec(["add", "-A"], { cwd: dir, operation: "add" });
    },

    async commit({ dir, message, author }) {
      const args = ["commit", "--quiet", "-m", message];
      if (author) args.push("--author", `${author.name} <${author.email}>`);
      await exec(args, { cwd: dir, operation: "commit" });
      const { stdout } = await runGit(bin, ["rev-parse", "HEAD"], { cwd: dir });
      return stdout.trim();
    },

    async commitsBetween({ dir, from, to }) {
      const { stdout } = await runGit(bin, ["log", "--format=%H", `${from}..${to}`], { cwd: dir });
      return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    },

    async push({ dir, remote, branch, credential, timeoutMs, redactor, signal }) {
      // Explicit refspec, never --force, never a bare `git push` that could
      // publish something else (v11 §18).
      await exec(
        gitArgs(credential, ["push", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`]),
        { cwd: dir, credential, timeoutMs, redactor, signal, operation: "push" }
      );
    },

    async pushRevision({ dir, remote, branch, revision, credential, timeoutMs, redactor, signal }) {
      // Publishing one frozen revision (v11 hardening §13/§15): the source is
      // a commit SHA, not a local branch, so nothing the working tree did
      // after finalization can ride along. The refspec is explicit, the
      // destination is this task's branch only, and there is no force flag.
      await exec(
        gitArgs(credential, ["push", "--quiet", remote, `${revision}:refs/heads/${branch}`]),
        { cwd: dir, credential, timeoutMs, redactor, signal, operation: "push" }
      );
    },
  };
}

/** Sanitized display form of a remote URL (never echoes userinfo). */
export function displayRemoteUrl(url: string): string {
  return redactRemoteUrl(url);
}
