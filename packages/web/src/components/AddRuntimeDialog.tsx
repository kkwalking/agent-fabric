import { useState } from "react";
import { ApiError, post } from "../api";
import { Icon } from "../components";
import { useT } from "../i18n-react";

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The harnesses a runtime can wrap on this machine.
 *
 * Every one of them runs in a Task — a Task is the unit of work and a runtime
 * is how it runs, so "can this be used for a task" is not a question a user
 * answers when adding one. `mock` and `custom` are deliberately absent: they
 * are wiring for tests and for records made outside the UI, not something to
 * choose from a menu.
 */
const HARNESSES = [
  { kind: "opencode", label: "OpenCode" },
  { kind: "pi", label: "Pi Agent" },
  { kind: "codex", label: "Codex" },
  { kind: "claude-code", label: "Claude Code" },
  { kind: "zcode", label: "ZCode" },
  { kind: "dsh", label: "DSH (DeepSeek)" },
] as const;

/**
 * Images the app already builds and ships for container runs. A runtime is
 * one of exactly two things — a local harness or a containerised one — and the
 * containerised form is only as real as the images that exist, so the list is
 * fixed here rather than a free-text field a user could fill with a typo.
 */
const ISOLATED_IMAGES = [{ image: "node:22-alpine", label: "node:22-alpine" }] as const;

/**
 * "Add runtime" dialog.
 *
 * Adding a runtime is a small, self-contained act — name it, pick how it runs,
 * done — so it is a dialog over the list, like every other create action in the
 * app. It used to be an inline card on the page that pushed the table down and
 * stayed open after a successful create.
 *
 * The form used to also ask for `usableInTask`, a container command and the
 * `executionBackend`/"containerized" pair. Those were three ways to express one
 * choice — local harness, or containerised harness — and a command line that
 * nobody should have to write to run an agent. The choice is now two cards.
 */
export function AddRuntimeDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"local" | "isolated">("local");
  const [kind, setKind] = useState<string>(HARNESSES[0].kind);
  const [image, setImage] = useState<string>(ISOLATED_IMAGES[0].image);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const harnessLabel = HARNESSES.find((h) => h.kind === kind)?.label ?? kind;
  const canAdd = name.trim().length > 0 && !busy;

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    setError(null);
    try {
      // `usableInTask` is not sent: a task-capable runtime is the only kind
      // there is, and the server decides the default.
      const body: Record<string, unknown> =
        mode === "isolated"
          ? {
              name: name.trim(),
              kind: "docker",
              image,
              containerized: true,
              executionBackend: "isolated",
              description: description.trim() || undefined,
            }
          : {
              name: name.trim(),
              kind,
              containerized: false,
              executionBackend: "local",
              description: description.trim() || undefined,
            };
      await post("/api/runtimes", body);
      onAdded();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal board-dialog add-runtime-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("runtime.add.title")}
      >
        <header className="board-dialog-head">
          <span className="board-dialog-title">
            <Icon name="box" size={15} />
            {t("runtime.add.title")}
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
              <span className="board-dialog-label">{t("runtime.add.name")}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
                placeholder={
                  mode === "isolated"
                    ? t("runtime.add.namePlaceholder.isolated")
                    : t("runtime.add.namePlaceholder.local", { harness: harnessLabel })
                }
                autoFocus
              />
            </div>

            <div className="board-dialog-field">
              <span className="board-dialog-label">{t("runtime.add.how")}</span>
              <div className="runtime-mode" role="radiogroup" aria-label={t("runtime.add.how")}>
                {(
                  [
                    { value: "local", title: t("runtime.add.mode.local"), hint: t("runtime.add.mode.localHint") },
                    { value: "isolated", title: t("runtime.add.mode.isolated"), hint: t("runtime.add.mode.isolatedHint") },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={mode === option.value}
                    className={`runtime-mode-card${mode === option.value ? " active" : ""}`}
                    disabled={busy}
                    onClick={() => setMode(option.value)}
                  >
                    <span className="runtime-mode-title">
                      <Icon name={option.value === "local" ? "cpu" : "box"} size={14} />
                      {option.title}
                    </span>
                    <span className="runtime-mode-hint">{option.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {mode === "local" ? (
              <div className="board-dialog-field">
                <span className="board-dialog-label">{t("runtime.add.harness")}</span>
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                  disabled={busy}
                >
                  {HARNESSES.map((h) => (
                    <option key={h.kind} value={h.kind}>
                      {h.label}
                    </option>
                  ))}
                </select>
                <p className="board-hint">{t("runtime.add.harnessHint")}</p>
              </div>
            ) : (
              <div className="board-dialog-field">
                <span className="board-dialog-label">{t("runtime.add.image")}</span>
                <select
                  value={image}
                  onChange={(event) => setImage(event.target.value)}
                  disabled={busy}
                >
                  {ISOLATED_IMAGES.map((i) => (
                    <option key={i.image} value={i.image}>
                      {i.label}
                    </option>
                  ))}
                </select>
                <p className="board-hint">{t("runtime.add.imageHint")}</p>
              </div>
            )}

            <div className="board-dialog-field">
              <span className="board-dialog-label">{t("runtime.add.description")}</span>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={busy}
                placeholder={t("runtime.add.descriptionPlaceholder")}
              />
            </div>
          </form>

          {error && <div className="board-hint warn board-dialog-error">{error}</div>}
        </div>

        <footer className="board-dialog-foot">
          <button className="small" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="small primary" onClick={() => void add()} disabled={!canAdd}>
            {busy ? t("common.saving") : t("common.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}
