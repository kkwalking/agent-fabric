/**
 * Directory browsing for the board's "Add project" dialog (v13 §八).
 *
 * The dialog is a server-path picker, not a text field: the user types a path,
 * the server lists the matching subdirectories, and every entry says whether it
 * is a Git repository. Browsing is read-only — nothing here creates, moves or
 * deletes files.
 *
 * There is deliberately no sandbox root: AgentFabric is a local tool whose
 * server already runs with the user's own filesystem permissions, and the agent
 * PTYs it launches can read the same paths. Pretending the picker is confined
 * would be security theater; the UI is honest that it shows local folders.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { DomainError } from "@agentfabric/core";
import { isGitRepositoryAtRoot } from "./git.js";

export interface KanbanDirectoryEntry {
  name: string;
  path: string;
  /** True when this directory itself is a Git work tree root. */
  isGitRepository: boolean;
}

export interface KanbanDirectoryListing {
  /** Filesystem root (`/` on POSIX), so the UI can render an absolute path. */
  rootPath: string;
  currentPath: string;
  /** `null` at the filesystem root. */
  parentPath: string | null;
  entries: KanbanDirectoryEntry[];
}

/**
 * Expands the shorthand a user types. `~` is the only shorthand accepted; a
 * relative path resolves against the server process's working directory, which
 * is the same rule the rest of the CLI/server uses.
 */
export function expandKanbanPath(input: string): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (trimmed === "" || trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

/**
 * Lists the directories under `inputPath`.
 *
 * Hidden directories are skipped (they are almost never a board project, and a
 * home directory full of dotfiles would bury the useful entries). Entries are
 * sorted by name so the dropdown is stable between keystrokes.
 */
export async function listKanbanDirectories(inputPath?: string): Promise<KanbanDirectoryListing> {
  const currentPath = expandKanbanPath(inputPath ?? "~");
  let info;
  try {
    info = await stat(currentPath);
  } catch (err) {
    throw new DomainError(
      "kanban-path-invalid",
      `Cannot read folder "${currentPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!info.isDirectory()) {
    throw new DomainError("kanban-path-invalid", `"${currentPath}" is a file, not a folder`);
  }

  let names: string[];
  try {
    const entries = await readdir(currentPath, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (err) {
    throw new DomainError(
      "kanban-path-invalid",
      `Cannot list folder "${currentPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const entries: KanbanDirectoryEntry[] = await Promise.all(
    names.map(async (name) => {
      const path = join(currentPath, name);
      return { name, path, isGitRepository: isGitRepositoryAtRoot(path) };
    })
  );

  const rootPath = parse(currentPath).root;
  const parentPath = currentPath === rootPath ? null : dirname(currentPath);
  return { rootPath, currentPath, parentPath, entries };
}
