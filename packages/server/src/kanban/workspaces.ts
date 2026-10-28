/**
 * "Add workspace" orchestration for the board.
 *
 * A board workspace **is** an ordinary `Workspace`: a directory on this
 * machine. Nothing is cloned and no repository is initialised — the board runs
 * local agent CLIs in the folder the user picked, and Git (if the folder has
 * any) is that folder's own business, never the platform's.
 */
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DomainError } from "@agentfabric/core";
import type { KanbanService, Workspace } from "@agentfabric/core";
import { expandKanbanPath } from "./fs.js";

export interface AddKanbanWorkspaceInput {
  /** Absolute folder (or `~/…`) for the new board workspace. */
  rootPath?: string;
  /** Display name; defaults to the folder's basename. */
  name?: string;
}

export type AddKanbanWorkspaceResult = { workspace: Workspace };

export async function addKanbanWorkspace(
  kanban: KanbanService,
  input: AddKanbanWorkspaceInput
): Promise<AddKanbanWorkspaceResult> {
  const raw = (input.rootPath ?? "").trim();
  if (!raw) {
    throw new DomainError("kanban-workspace-path-invalid", "A board workspace needs a directory path");
  }
  const expanded = expandKanbanPath(raw);
  if (!isAbsolute(expanded)) {
    throw new DomainError("kanban-workspace-path-invalid", `Board workspace path must be absolute: ${expanded}`);
  }
  const st = await stat(expanded).catch(() => undefined);
  if (!st?.isDirectory()) {
    throw new DomainError("kanban-workspace-path-invalid", `Board workspace path is not a directory: ${expanded}`);
  }
  const workspace = await kanban.addWorkspace({ rootPath: expanded, name: input.name });
  return { workspace };
}
