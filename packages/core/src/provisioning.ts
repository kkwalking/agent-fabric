/**
 * Runtime provisioning (v11 §25/§26).
 *
 * Before a runtime starts, the supervisor makes sure the execution
 * environment has what the Project asked for — as overridden by the Task:
 *
 * - **Skills** — skill directories copied into a per-run provisioning
 *   directory and mounted read-only into the runtime.
 * - **MCP** — the final MCP configuration generated from the resolved MCP
 *   servers, with Secret references resolved at provisioning time.
 *
 * Both lists resolve as `Task 显式 > Project`: a Task that declares its own
 * `skills` / `mcpServers` **replaces** the Project's list (it does not merge
 * with it), and a Task that declares neither inherits the Project's. The
 * replacement is deliberate: a skill/MCP list is a set of capabilities, and
 * an override that silently kept the inherited entries could not express
 * "this Task must not have that one".
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
import { validationToolScript, VALIDATION_TOOL_FILE_NAME, VALIDATION_VERDICT_FILE_NAME } from "./validationTool.js";
import { VALIDATION_TOOL_CONTAINER_PATH, VALIDATION_OUTPUT_CONTAINER_PATH } from "./validation.js";

/** Canonical mount points inside a container runtime. */
export const SKILLS_MOUNT_PATH = "/root/.agentfabric/skills";
export const MCP_CONFIG_MOUNT_PATH = "/root/.agentfabric/mcp.json";

/** Env var the runtime reads to find the provisioned skills. */
export const SKILLS_ENV_VAR = "AGENTFABRIC_SKILLS_DIR";
/** Env var the runtime reads to find the generated MCP configuration. */
export const MCP_CONFIG_ENV_VAR = "AGENTFABRIC_MCP_CONFIG";
/**
 * Env var pointing the Validation Agent at its verdict output directory
 * (v12 §5.1). The judge prompt carries the absolute path too; the env var
 * makes the channel available to any harness without prompt parsing.
 */
export const VALIDATION_OUTPUT_ENV_VAR = "AGENTFABRIC_VALIDATION_OUTPUT";

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
  /**
   * Validation judge run (v12 §4.1): generate the verdict tool script and a
   * **read-write** output directory, and skip the Project's skills / MCP
   * provisioning — the judge's only tool is the verdict submission.
   *
   * `containerized` decides which paths the judge is told about: a container
   * sees the canonical `/root/.agentfabric/...` mount points, a host runtime
   * sees the host paths (Project Coding Tasks require a containerized
   * runtime, so the host case is only reachable through the explicit
   * `allowHostExecution` operator policy).
   */
  validationJudge?: { containerized: boolean };
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
  /**
   * Read-write mounts (v12 §4.1). Exactly one caller uses this: the judge
   * run's verdict output directory — the judge must be able to write its
   * verdict while the workspace stays read-only.
   */
  writableMounts: Array<{ hostPath: string; containerPath: string }>;
  /** Env vars exposing the provisioned paths to the harness. */
  env: Record<string, string>;
  /** Judge runs only: host path of the verdict output directory. */
  validationOutputDir?: string;
  /** Judge runs only: the path the judge must invoke the verdict tool by. */
  validationToolPath?: string;
  /** Judge runs only: the path the judge must write the verdict to. */
  validationVerdictPath?: string;
  cleanup(): Promise<void>;
}

/**
 * Where one judge run's tool and verdict live (v12 §4.1).
 *
 * Provisioning and the judge instruction must agree on these — the tool
 * script is baked with the verdict path, and the prompt tells the judge the
 * same one — so both derive them from this single function. A containerized
 * runtime sees the canonical mount points; a host runtime sees the host
 * paths.
 */
export function validationJudgePaths(
  dataDir: string,
  runId: string,
  containerized: boolean
): { hostDir: string; toolPath: string; verdictPath: string; outputHostDir: string } {
  const hostDir = join(dataDir, "provisioning", runId);
  const outputHostDir = join(hostDir, "validation-output");
  return containerized
    ? {
        hostDir,
        outputHostDir,
        toolPath: VALIDATION_TOOL_CONTAINER_PATH,
        verdictPath: `${VALIDATION_OUTPUT_CONTAINER_PATH}/${VALIDATION_VERDICT_FILE_NAME}`,
      }
    : {
        hostDir,
        outputHostDir,
        toolPath: join(hostDir, VALIDATION_TOOL_FILE_NAME),
        verdictPath: join(outputHostDir, VALIDATION_VERDICT_FILE_NAME),
      };
}

/**
 * Copies one skill directory. `source` is the host path configured on the
 * Project (or on the Task, when it overrides the list); a missing directory
 * is a loud failure (a silently missing skill would make the agent behave
 * differently than configured).
 */
async function provisionSkill(skill: ProjectSkill, dest: string): Promise<void> {
  await cp(skill.path, dest, { recursive: true, dereference: true, force: true });
}

/**
 * The skills this run provisions: the Task's list when it declares one,
 * else the Project's. `undefined` (not declared) inherits; an explicit empty
 * list means "no skills", which is a legitimate override.
 */
export function resolveSkills(task?: Pick<Task, "skills">, project?: Pick<Project, "skills">): ProjectSkill[] {
  return (task?.skills ?? project?.skills) ?? [];
}

/** The MCP servers this run generates configuration for. Same rule as `resolveSkills`. */
export function resolveMcpServers(task?: Pick<Task, "mcpServers">, project?: Pick<Project, "mcpServers">): McpServerConfig[] {
  return (task?.mcpServers ?? project?.mcpServers) ?? [];
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
  const writableMounts: Array<{ hostPath: string; containerPath: string }> = [];
  const env: Record<string, string> = {};

  /* ---- Judge run (v12 §4.1): the verdict tool, nothing else ---- */
  if (opts.validationJudge) {
    const containerized = opts.validationJudge.containerized;
    const paths = validationJudgePaths(opts.dataDir, opts.runId, containerized);
    // The tool script and the output directory travel together: the script
    // is baked with the output path, so the judge never has to guess it.
    await mkdir(paths.outputHostDir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, VALIDATION_TOOL_FILE_NAME), validationToolScript(paths.verdictPath), { mode: 0o700 });
    if (containerized) {
      extraMounts.push({ hostPath: join(dir, VALIDATION_TOOL_FILE_NAME), containerPath: VALIDATION_TOOL_CONTAINER_PATH });
      // Read-write: the judge's one legitimate write target. It lives under
      // the run's provisioning dir (outside the workspace), so nothing the
      // judge writes here can reach the repository or the final commit.
      writableMounts.push({ hostPath: paths.outputHostDir, containerPath: VALIDATION_OUTPUT_CONTAINER_PATH });
      env[VALIDATION_OUTPUT_ENV_VAR] = VALIDATION_OUTPUT_CONTAINER_PATH;
    } else {
      env[VALIDATION_OUTPUT_ENV_VAR] = paths.outputHostDir;
    }
    return {
      dir,
      skills: [],
      mcpServers: [],
      extraMounts,
      writableMounts,
      env,
      validationOutputDir: paths.outputHostDir,
      validationToolPath: paths.toolPath,
      validationVerdictPath: paths.verdictPath,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  const skills = resolveSkills(opts.task, opts.project);
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

  const servers = resolveMcpServers(opts.task, opts.project);
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
    writableMounts,
    env,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
