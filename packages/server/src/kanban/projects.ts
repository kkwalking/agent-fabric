/**
 * "Add project" orchestration for the board (v13 §2.1).
 *
 * The dialog sends either a local folder or a clone URL. This module owns the
 * parts the dialog must not fake: path expansion, the Git-optional decision
 * (add as-is / initialize a repository / ask the user), cloning, and duplicate
 * detection. Record creation itself stays in `KanbanService`.
 *
 * The Git confirmation is part of the flow, not an error path: a folder that is
 * not a repository is a perfectly good board project, and the user is the one
 * who decides whether they want Git-backed worktree cards in it.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DomainError } from "@agentfabric/core";
import type { KanbanProject, KanbanService } from "@agentfabric/core";
import { expandKanbanPath } from "./fs.js";
import {
  cloneGitRepository,
  deriveRepoNameFromUrl,
  initializeGitRepository,
  isGitRepositoryAtRoot,
} from "./git.js";

/** How the user answered (or did not answer) the "this folder is not Git" question. */
export type KanbanGitInitChoice = "ask" | "init" | "skip";

export interface AddKanbanProjectInput {
  /** Absolute folder (or `~/…`) for the new board project. */
  path?: string;
  /** Clone URL; mutually exclusive with a plain `path` meaning "use as-is". */
  gitUrl?: string;
  /** Folder name used when a clone has no destination (also used in the UI). */
  folderName?: string;
  /** Display name; defaults to the folder's basename. */
  name?: string;
  gitInit?: KanbanGitInitChoice;
}

export type AddKanbanProjectResult =
  | { kind: "created"; project: KanbanProject }
  | { kind: "requires-git-init"; path: string };

function normalizeGitInit(value: unknown): KanbanGitInitChoice {
  if (value === "init" || value === "skip") return value;
  return "ask";
}

function assertFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new DomainError(
      "kanban-path-invalid",
      `"${name}" is not a valid folder name — use a single path segment without slashes`
    );
  }
  return trimmed;
}

async function assertDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    throw new DomainError(
      "kanban-path-invalid",
      `Folder does not exist: ${path} (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (!info.isDirectory()) {
    throw new DomainError("kanban-path-invalid", `Not a folder: ${path}`);
  }
}

/** The clone target a URL/folder-name pair resolves to, before any I/O. */
export function resolveCloneTarget(input: AddKanbanProjectInput): string {
  const gitUrl = (input.gitUrl ?? "").trim();
  if (!gitUrl) throw new DomainError("kanban-path-invalid", "A clone URL is required");
  if (input.path && input.path.trim()) return expandKanbanPath(input.path);
  const derived = input.folderName?.trim() ? assertFolderName(input.folderName) : deriveRepoNameFromUrl(gitUrl);
  if (!derived) {
    throw new DomainError(
      "kanban-path-invalid",
      `Could not derive a folder name from "${gitUrl}" — set a folder name`
    );
  }
  return join(homedir(), derived);
}

/**
 * Adds a board project from a folder or a clone URL.
 *
 * Returns `requires-git-init` instead of creating the project when the folder
 * is not a Git repository and the caller has not decided yet; the dialog then
 * offers "Add without Git" / "Initialize Git repository".
 */
export async function addKanbanProject(
  kanban: KanbanService,
  input: AddKanbanProjectInput
): Promise<AddKanbanProjectResult> {
  const gitUrl = typeof input.gitUrl === "string" ? input.gitUrl.trim() : "";
  const pathInput = typeof input.path === "string" ? input.path.trim() : "";
  if (!gitUrl && !pathInput) {
    throw new DomainError("kanban-path-invalid", "Choose a folder or a Git repository URL");
  }

  let projectPath: string;
  if (gitUrl) {
    projectPath = resolveCloneTarget(input);
    if (!isGitRepositoryAtRoot(projectPath)) {
      await cloneGitRepository(gitUrl, projectPath);
    }
  } else {
    projectPath = expandKanbanPath(pathInput);
  }

  await assertDirectory(projectPath);

  // Report the duplicate before asking about Git: "this folder is already a
  // board" is the useful answer, and no Git question would change it.
  const existing = kanban.listProjects().find((project) => resolve(project.rootPath) === resolve(projectPath));
  if (existing) {
    throw new DomainError(
      "kanban-project-duplicate",
      `This folder is already a board project: ${existing.name} (${existing.rootPath})`
    );
  }

  const gitInit = normalizeGitInit(input.gitInit);
  if (!isGitRepositoryAtRoot(projectPath)) {
    if (gitInit === "init") {
      await initializeGitRepository(projectPath);
    } else if (gitInit !== "skip") {
      return { kind: "requires-git-init", path: projectPath };
    }
  }

  const project = await kanban.createProject({
    rootPath: projectPath,
    ...(input.name?.trim() ? { name: input.name } : {}),
  });
  return { kind: "created", project };
}
