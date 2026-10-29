import { useEffect, useState } from "react";
import { ApiError, get, post } from "../../api";
import { Icon } from "../../components";
import { useT } from "../../i18n-react";
import { DirectoryAutocomplete } from "./DirectoryAutocomplete";
import type { BoardWorkspace, KanbanDirectoryListing } from "./types";

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

interface DesktopBridge {
  pickDirectory?: (defaultPath?: string) => Promise<string | null>;
}

/** The desktop preload's folder chooser; absent in a plain browser. */
function nativeDirectoryPicker(): DesktopBridge["pickDirectory"] {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as unknown as { agentfabric?: DesktopBridge }).agentfabric;
  return typeof bridge?.pickDirectory === "function" ? bridge.pickDirectory : undefined;
}

/**
 * "Add workspace" dialog (v13 §2.1).
 *
 * A workspace is a directory on this machine, so the dialog asks for its
 * absolute path (and, from the rail, an optional name). There is no clone and
 * no Git question — Git is optional, and a plain folder boards exactly the way
 * a repository does.
 *
 * The response is the created workspace row, which is why the added directory
 * appears in the sidebar as well as on the board.
 */
export function AddWorkspaceDialog({
  onClose,
  onAdded,
  mode = "board",
}: {
  onClose: () => void;
  onAdded: (workspace: BoardWorkspace) => void;
  /**
   * `board` adds a workspace carrying board settings; `workspace` adds an
   * ordinary local workspace from the rail. Both are the same record — the
   * difference is only the endpoint and whether board settings are attached.
   */
  mode?: "board" | "workspace";
}) {
  const t = useT();
  const [pathInput, setPathInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceMode = mode === "workspace";
  const pickDirectory = nativeDirectoryPicker();

  const chooseDirectory = async () => {
    if (!pickDirectory) return;
    try {
      const picked = await pickDirectory(pathInput.trim() || undefined);
      if (picked) setPathInput(picked);
    } catch (err) {
      setError(errorText(err));
    }
  };

  // Seed the field with the server's home directory so the picker lists
  // something useful before the user types anything.
  useEffect(() => {
    let alive = true;
    get<{ listing: KanbanDirectoryListing }>("/api/kanban/fs")
      .then((response) => {
        if (!alive) return;
        setPathInput((current) => current || response.listing.currentPath);
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

  const add = async () => {
    const rootPath = pathInput.trim();
    if (!rootPath) {
      setError(t(workspaceMode ? "workspace.add.needPath" : "board.addWorkspace.needPath"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (workspaceMode) {
        const name = nameInput.trim() || rootPath.split("/").filter(Boolean).pop() || rootPath;
        const workspace = await post<BoardWorkspace>("/api/workspaces", {
          name,
          type: "local",
          path: rootPath,
        });
        onAdded(workspace);
      } else {
        const response = await post<{ workspace: BoardWorkspace }>("/api/kanban/workspaces", {
          rootPath,
        });
        onAdded(response.workspace);
      }
      // The rail and the New Task form both keep workspace lists mounted; let
      // them re-read instead of waiting for the five-second GET cache to age
      // out or the user to navigate away and back.
      window.dispatchEvent(new Event("agentfabric:workspaces-changed"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const canAdd = Boolean(pathInput.trim()) && !busy;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal board-dialog add-workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(workspaceMode ? "workspace.add.title" : "board.addWorkspace.title")}
      >
        <header className="board-dialog-head">
          <span className="board-dialog-title">
            <Icon name="folderOpen" size={15} />
            {t(workspaceMode ? "workspace.add.title" : "board.addWorkspace.title")}
          </span>
          <button
            className="board-dialog-close"
            onClick={onClose}
            disabled={busy}
            aria-label={t("board.detail.close")}
          >
            ✕
          </button>
        </header>

        <div className="board-dialog-body">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            {workspaceMode && (
              <div className="board-dialog-field">
                <span className="board-dialog-label">{t("workspace.add.name")}</span>
                <input
                  value={nameInput}
                  onChange={(event) => setNameInput(event.target.value)}
                  disabled={busy}
                  placeholder={t("workspace.add.namePlaceholder")}
                />
              </div>
            )}
            <div className="board-dialog-field">
              <span className="board-dialog-label">
                {t(workspaceMode ? "workspace.add.path" : "board.addWorkspace.folderPath")}
              </span>
              <DirectoryAutocomplete
                value={pathInput}
                onChange={setPathInput}
                disabled={busy}
                placeholder={t(
                  workspaceMode ? "workspace.add.searchPath" : "board.addWorkspace.searchPath"
                )}
                onSubmit={() => void add()}
                onBrowse={workspaceMode && pickDirectory ? () => void chooseDirectory() : undefined}
                nativeOnly={workspaceMode && Boolean(pickDirectory)}
                autoFocus
              />
            </div>
            <p className="board-hint">
              {t(workspaceMode ? "workspace.add.hint" : "board.addWorkspace.pathHint")}
            </p>
          </form>

          {error && <div className="board-hint warn board-dialog-error">{error}</div>}
        </div>

        <footer className="board-dialog-foot">
          <button className="small" onClick={onClose} disabled={busy}>
            {t(workspaceMode ? "workspace.add.cancel" : "board.addWorkspace.cancel")}
          </button>
          <button className="small primary" onClick={() => void add()} disabled={!canAdd}>
            {busy
              ? t(workspaceMode ? "workspace.add.submitting" : "board.addWorkspace.adding")
              : t(workspaceMode ? "workspace.add.submit" : "board.addWorkspace.add")}
          </button>
        </footer>
      </div>
    </div>
  );
}
