import { useCallback, useEffect, useState } from "react";
import { ApiError, get, post } from "../../api";
import { Icon } from "../../components";
import { DirectoryAutocomplete } from "./DirectoryAutocomplete";
import type { KanbanDirectoryListing, Project } from "./types";

type AddProjectTab = "path" | "clone";

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Mirrors the server's rule so the folder-name preview matches what it derives. */
export function deriveRepoNameFromUrl(gitUrl: string): string {
  const trimmed = gitUrl.trim().replace(/\/+$/u, "");
  if (!trimmed) return "";
  const sshMatch = /^[^@/\s]+@[^:/\s]+:(.+)$/u.exec(trimmed);
  const pathPart = sshMatch?.[1] ?? trimmed;
  const lastSegment = pathPart.split("/").pop() ?? "";
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -4) : lastSegment;
}

/** Client-side join used for the clone preview; the server resolves it for real. */
function joinPath(directory: string, name: string): string {
  const trimmedDir = directory.trim().replace(/\/+$/u, "");
  if (!name) return trimmedDir;
  return trimmedDir ? `${trimmedDir}/${name}` : name;
}

/**
 * "Add project" dialog (v13 §2.1).
 *
 * Two ways in, exactly like the fork: pick an existing folder from the server's
 * filesystem, or clone a Git URL. A folder that is not a Git repository is
 * valid — the server answers `requiresGitInitialization` and the user chooses
 * "add without Git" or "initialize a repository", rather than the platform
 * deciding for them.
 *
 * This is the only board-specific project call left: everything else about a
 * board project (list, rename, delete) is the ordinary Project API. The
 * response is the created `Project`, which is why an added project shows up on
 * the Projects page too.
 */
export function AddProjectDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (project: Project) => void;
}) {
  const [tab, setTab] = useState<AddProjectTab>("path");
  const [pathInput, setPathInput] = useState("");
  const [pendingGitInitPath, setPendingGitInitPath] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  const [cloneDest, setCloneDest] = useState("");
  const [cloneFolder, setCloneFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed both path fields with the server's home directory, and make sure the
  // first request works even before the user types anything.
  useEffect(() => {
    let alive = true;
    get<{ listing: KanbanDirectoryListing }>("/api/kanban/fs")
      .then((response) => {
        if (!alive) return;
        setPathInput((current) => current || response.listing.currentPath);
        setCloneDest((current) => current || response.listing.currentPath);
      })
      .catch(() => {
        /* The picker still accepts a typed path; the server validates it. */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const add = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const response = await post<{ project: Project }>("/api/kanban/projects", body);
        onAdded(response.project);
      } catch (err) {
        if (err instanceof ApiError && err.code === "kanban-project-not-git") {
          const resolved = typeof err.details?.path === "string" ? err.details.path : "";
          setPendingGitInitPath(resolved || String(body.path ?? ""));
          setError(null);
          return;
        }
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    },
    [onAdded]
  );

  const submitPath = () => {
    const path = pathInput.trim();
    if (!path) {
      setError("Choose a folder first.");
      return;
    }
    void add({ path });
  };

  const submitWithoutGit = () => {
    if (!pendingGitInitPath) return;
    void add({ path: pendingGitInitPath, gitInit: "skip" });
  };

  const submitInitializeGit = () => {
    if (!pendingGitInitPath) return;
    void add({ path: pendingGitInitPath, gitInit: "init" });
  };

  const submitClone = () => {
    const url = gitUrl.trim();
    if (!url) {
      setError("A Git repository URL is required.");
      return;
    }
    const folder = cloneFolder.trim() || deriveRepoNameFromUrl(url);
    const destination = cloneDest.trim();
    const target = folder ? joinPath(destination, folder) : undefined;
    void add({ gitUrl: url, ...(target ? { path: target } : {}) });
  };

  const switchTab = (next: AddProjectTab) => {
    if (busy) return;
    setTab(next);
    setPendingGitInitPath(null);
    setError(null);
  };

  const clonePreview = (() => {
    const url = gitUrl.trim();
    if (!url) return "";
    const folder = cloneFolder.trim() || deriveRepoNameFromUrl(url);
    return folder ? joinPath(cloneDest.trim() || "~", folder) : "";
  })();

  const isPathTab = tab === "path";
  const canAddPath = Boolean(pathInput.trim()) && !busy;
  const canClone = Boolean(gitUrl.trim()) && !busy;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal board-dialog add-project-dialog" role="dialog" aria-modal="true" aria-label="Add project">
        <header className="board-dialog-head">
          <span className="board-dialog-title">
            <Icon name="folderOpen" size={15} />
            Add project
          </span>
          <button className="board-dialog-close" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="board-dialog-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={isPathTab}
            className={`board-dialog-tab ${isPathTab ? "active" : ""}`}
            onClick={() => switchTab("path")}
            disabled={busy}
          >
            <Icon name="search" size={12} />
            Server path
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isPathTab}
            className={`board-dialog-tab ${!isPathTab ? "active" : ""}`}
            onClick={() => switchTab("clone")}
            disabled={busy}
          >
            <Icon name="branch" size={12} />
            Git clone
          </button>
        </div>

        <div className="board-dialog-body">
          {isPathTab ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (pendingGitInitPath) submitInitializeGit();
                else submitPath();
              }}
            >
              <div className="board-dialog-field">
                <span className="board-dialog-label">Folder path</span>
                <DirectoryAutocomplete
                  value={pathInput}
                  onChange={(next) => {
                    setPathInput(next);
                    setPendingGitInitPath(null);
                  }}
                  disabled={busy}
                  placeholder="Search or type an absolute path…"
                  onSubmit={() => (pendingGitInitPath ? submitInitializeGit() : submitPath())}
                />
              </div>
              <p className="board-hint">
                The folder is used as-is. Git is optional — a plain folder is a valid board project.
              </p>

              {pendingGitInitPath && (
                <div className="board-git-ask">
                  <div className="board-git-ask-title">This folder is not a Git repository</div>
                  <p className="board-git-ask-copy">
                    That is fine — a board works with plain folders. You can add it as-is, or initialize a
                    repository first if you want worktree cards for this project.
                  </p>
                  <p className="mono board-git-ask-path">{pendingGitInitPath}</p>
                </div>
              )}
            </form>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submitClone();
              }}
            >
              <div className="board-dialog-field">
                <label className="board-dialog-label" htmlFor="add-project-git-url">
                  Git repository URL
                </label>
                <input
                  id="add-project-git-url"
                  className="mono"
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  disabled={busy}
                  autoFocus
                />
              </div>
              <div className="board-clone-grid">
                <div className="board-dialog-field">
                  <span className="board-dialog-label">Clone into</span>
                  <DirectoryAutocomplete
                    value={cloneDest}
                    onChange={setCloneDest}
                    disabled={busy}
                    placeholder="Search or type a folder…"
                    ariaLabel="Clone destination folder"
                  />
                </div>
                <div className="board-dialog-field">
                  <label className="board-dialog-label" htmlFor="add-project-folder-name">
                    Folder name
                  </label>
                  <input
                    id="add-project-folder-name"
                    className="mono"
                    value={cloneFolder}
                    onChange={(event) => setCloneFolder(event.target.value.replace(/[\\/]/gu, ""))}
                    placeholder={deriveRepoNameFromUrl(gitUrl) || "repo-name"}
                    disabled={busy}
                  />
                </div>
              </div>
              <p className="board-hint">
                {clonePreview ? (
                  <>
                    Clones to <span className="mono">{clonePreview}</span>.
                  </>
                ) : (
                  "Paste a clone URL; the folder name defaults to the repository name."
                )}
              </p>
            </form>
          )}

          {error && <div className="board-hint warn board-dialog-error">{error}</div>}
        </div>

        <footer className="board-dialog-foot">
          <button className="small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {isPathTab ? (
            pendingGitInitPath ? (
              <>
                <button className="small" onClick={submitWithoutGit} disabled={busy}>
                  Add without Git
                </button>
                <button className="small primary" onClick={submitInitializeGit} disabled={busy}>
                  {busy ? "Initializing…" : "Initialize Git repository"}
                </button>
              </>
            ) : (
              <button className="small primary" onClick={submitPath} disabled={!canAddPath}>
                {busy ? "Adding…" : "Add project"}
              </button>
            )
          ) : (
            <button className="small primary" onClick={submitClone} disabled={!canClone}>
              {busy ? "Cloning…" : "Clone & add"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
