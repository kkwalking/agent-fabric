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

/**
 * "Add workspace" dialog (v13 §2.1).
 *
 * A board workspace is a directory on this machine, so the dialog asks for
 * exactly one thing: its absolute path. There is no clone and no Git question —
 * Git is optional, and a plain folder boards exactly the way a repository does.
 *
 * The response is the created workspace row, which is why the added directory
 * appears in the sidebar as well as on the board.
 */
export function AddWorkspaceDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (workspace: BoardWorkspace) => void;
}) {
  const t = useT();
  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(t("board.addWorkspace.needPath"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await post<{ workspace: BoardWorkspace }>("/api/kanban/workspaces", {
        rootPath,
      });
      onAdded(response.workspace);
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
        aria-label={t("board.addWorkspace.title")}
      >
        <header className="board-dialog-head">
          <span className="board-dialog-title">
            <Icon name="folderOpen" size={15} />
            {t("board.addWorkspace.title")}
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
            <div className="board-dialog-field">
              <span className="board-dialog-label">{t("board.addWorkspace.folderPath")}</span>
              <DirectoryAutocomplete
                value={pathInput}
                onChange={setPathInput}
                disabled={busy}
                placeholder={t("board.addWorkspace.searchPath")}
                onSubmit={() => void add()}
                autoFocus
              />
            </div>
            <p className="board-hint">{t("board.addWorkspace.pathHint")}</p>
          </form>

          {error && <div className="board-hint warn board-dialog-error">{error}</div>}
        </div>

        <footer className="board-dialog-foot">
          <button className="small" onClick={onClose} disabled={busy}>
            {t("board.addWorkspace.cancel")}
          </button>
          <button className="small primary" onClick={() => void add()} disabled={!canAdd}>
            {busy ? t("board.addWorkspace.adding") : t("board.addWorkspace.add")}
          </button>
        </footer>
      </div>
    </div>
  );
}
