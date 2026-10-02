/**
 * Runtime provisioning (v11 §25/§26).
 *
 * Before a runtime starts, the supervisor makes sure the execution
 * environment has what the Project asked for:
 *
 * - **Skills** — Project skill directories copied into a per-run provisioning
 *   directory and mounted read-only into the runtime.
 * - **MCP** — the final MCP configuration generated from the Project's MCP
 *   servers, with Secret references resolved at provisioning time.
 *
 * The properties the spec requires (v11 §25/§26) fall out of the design:
 * every run gets its own directory under `dataDir/provisioning/<runId>`,
 * provisioning is idempotent (the directory is rebuilt from scratch), nothing
 * is written into the user's repository or into another task's directory, no
 * long-lived container is involved, and `cleanup()` removes everything —
 * including the generated configuration that may hold injected secrets.
 *
 * MCP configuration is generated *from the control plane* (Project
 * configuration), never from repository content: a repository cannot grant
 * itself MCP access, secrets or network reach (v11 §27).
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig, Project, ProjectSkill, Task } from "./types.js";

/** Canonical mount points inside a container runtime. */
export const SKILLS_MOUNT_PATH = "/root/.agentfabric/skills";
export const MCP_CONFIG_MOUNT_PATH = "/root/.agentfabric/mcp.json";

/** Env var the runtime reads to find the provisioned skills. */
export const SKILLS_ENV_VAR = "AGENTFABRIC_SKILLS_DIR";
/** Env var the runtime reads to find the generated MCP configuration. */
export const MCP_CONFIG_ENV_VAR = "AGENTFABRIC_MCP_CONFIG";

export interface ProvisionEnvironmentOptions {
  dataDir: string;
  runId: string;
  project?: Project;
  task?: Task;
  /** Runtime override for the skills mount path. */
  skillsMountPath?: string;
  /** Runtime override for the MCP config mount path. */
  mcpConfigMountPath?: string;
  /** Resolves a Secret id to its plaintext value (never logged). */
  resolveSecret?: (id: string) => string | undefined;
}

export interface ProvisionedEnvironment {
  /** Host directory holding everything provisioned for this run. */
  dir: string;
  skillsHostDir?: string;
  skillsMountPath?: string;
  mcpConfigHostPath?: string;
  mcpConfigMountPath?: string;
  /** Names of the skills that were provisioned. */
  skills: string[];
  /** Names of the MCP servers written into the configuration. */
  mcpServers: string[];
  /** Read-only mounts the runtime backend must add. */
  extraMounts: Array<{ hostPath: string; containerPath: string }>;
  /** Env vars exposing the provisioned paths to the harness. */
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

/**
 * Copies one skill directory. `source` is the host path configured on the
 * Project; a missing directory is a loud failure (a silently missing skill
 * would make the agent behave differently than configured).
 */
async function provisionSkill(skill: ProjectSkill, dest: string): Promise<void> {
  await cp(skill.path, dest, { recursive: true, dereference: true, force: true });
}

/**
 * Builds the MCP configuration document for the resolved servers.
 *
 * Every secret reference goes through the caller's `resolveSecret`, which is
 * the scope-authorized resolver (v11 hardening §8): a `git`-scoped secret
 * referenced from an MCP server is refused at this boundary rather than
 * silently injected into the agent's environment.
 */
export function buildMcpConfigDocument(
  servers: McpServerConfig[],
  resolveSecret?: (id: string) => string | undefined
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.enabled === false) continue;
    const env: Record<string, string> = { ...(server.env ?? {}) };
    for (const secretId of server.secretIds ?? []) {
      // Secrets are injected as env values under the secret's own id-derived
      // name; the value never appears in a log or an API response.
      const value = resolveSecret?.(secretId);
      if (value !== undefined) env[`AGENTFABRIC_MCP_SECRET_${secretId}`] = value;
    }
    const entry: Record<string, unknown> = {};
    if (server.transport) entry.transport = server.transport;
    if (server.command) entry.command = server.command;
    if (server.args?.length) entry.args = server.args;
    if (server.url) entry.url = server.url;
    if (Object.keys(env).length) entry.env = env;
    mcpServers[server.name] = entry;
  }
  return { mcpServers };
}

/**
 * Provisions the run's execution environment. Safe to call again for the same
 * run: the directory is rebuilt, so a recovered run always ends up with the
 * configuration its Project currently describes.
 */
export async function provisionEnvironment(opts: ProvisionEnvironmentOptions): Promise<ProvisionedEnvironment> {
  const dir = join(opts.dataDir, "provisioning", opts.runId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const extraMounts: Array<{ hostPath: string; containerPath: string }> = [];
  const env: Record<string, string> = {};

  const skills = opts.project?.skills ?? [];
  const skillsMountPath = opts.skillsMountPath ?? SKILLS_MOUNT_PATH;
  let skillsHostDir: string | undefined;
  if (skills.length > 0) {
    skillsHostDir = join(dir, "skills");
    await mkdir(skillsHostDir, { recursive: true });
    for (const skill of skills) {
      if (!skill?.name || !skill?.path) continue;
      await provisionSkill(skill, join(skillsHostDir, skill.name));
    }
    extraMounts.push({ hostPath: skillsHostDir, containerPath: skillsMountPath });
    env[SKILLS_ENV_VAR] = skillsMountPath;
  }

  const servers = opts.project?.mcpServers ?? [];
  const mcpConfigMountPath = opts.mcpConfigMountPath ?? MCP_CONFIG_MOUNT_PATH;
  let mcpConfigHostPath: string | undefined;
  const provisionedServers: string[] = [];
  if (servers.some((s) => s.enabled !== false)) {
    mcpConfigHostPath = join(dir, "mcp.json");
    const document = buildMcpConfigDocument(servers, opts.resolveSecret);
    // 0600: the file may hold injected secret values, so it is never
    // world-readable and is removed at cleanup.
    await writeFile(mcpConfigHostPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    provisionedServers.push(...Object.keys(document.mcpServers as Record<string, unknown>));
    extraMounts.push({ hostPath: mcpConfigHostPath, containerPath: mcpConfigMountPath });
    env[MCP_CONFIG_ENV_VAR] = mcpConfigMountPath;
  }

  return {
    dir,
    skillsHostDir,
    skillsMountPath: skillsHostDir ? skillsMountPath : undefined,
    mcpConfigHostPath,
    mcpConfigMountPath: mcpConfigHostPath ? mcpConfigMountPath : undefined,
    skills: skills.map((s) => s.name),
    mcpServers: provisionedServers,
    extraMounts,
    env,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
