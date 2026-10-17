import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { get } from "../../api";
import { Icon } from "../../components";
import type { KanbanDirectoryEntry, KanbanDirectoryListing } from "./types";

/**
 * Server-path picker (v13 §八).
 *
 * Typing lists matching subfolders on the machine the server runs on; each entry
 * says whether it is a Git repository. The interaction mirrors the Cline Kanban
 * fork's directory field: debounce, split the input into parent + prefix, list
 * the parent's children, filter by the prefix, arrow-key through them, and a
 * selection appends `/` so the next listing shows that folder's contents.
 */
export function DirectoryAutocomplete({
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  autoFocus = false,
  onSubmit,
  inputRef: externalRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Called on Enter when no suggestion is highlighted. */
  onSubmit?: () => void;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const [entries, setEntries] = useState<KanbanDirectoryEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [debounced, setDebounced] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? internalRef;
  const fetchIdRef = useRef(0);
  /** Do not pop the dropdown open on mount; only after a real interaction. */
  const interactedRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), 250);
    return () => window.clearTimeout(timer);
  }, [value]);

  const { requestPath, prefix } = splitPathInput(debounced);

  useEffect(() => {
    if (disabled) {
      setEntries([]);
      setOpen(false);
      return;
    }
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    get<{ listing: KanbanDirectoryListing }>(
      `/api/kanban/fs?path=${encodeURIComponent(requestPath)}`
    )
      .then((response) => {
        if (fetchId !== fetchIdRef.current) return;
        const lowered = prefix.toLowerCase();
        const filtered = prefix
          ? response.listing.entries.filter((entry) => entry.name.toLowerCase().startsWith(lowered))
          : response.listing.entries;
        setEntries(filtered);
        setHighlighted(-1);
        setOpen(interactedRef.current && filtered.length > 0);
      })
      .catch(() => {
        if (fetchId !== fetchIdRef.current) return;
        setEntries([]);
        setOpen(false);
      })
      .finally(() => {
        if (fetchId === fetchIdRef.current) setLoading(false);
      });
  }, [requestPath, prefix, disabled]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const select = useCallback(
    (entry: KanbanDirectoryEntry) => {
      interactedRef.current = true;
      onChange(`${entry.path.replace(/\/+$/u, "")}/`);
      setOpen(false);
      setHighlighted(-1);
      inputRef.current?.focus();
    },
    [inputRef, onChange]
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // The first Escape closes the dropdown; the dialog must not swallow it.
      event.preventDefault();
      event.stopPropagation();
      if (open) {
        setOpen(false);
        setHighlighted(-1);
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    if (!open || entries.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => (current < entries.length - 1 ? current + 1 : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => (current > 0 ? current - 1 : entries.length - 1));
      return;
    }
    if (event.key === "Enter" && highlighted >= 0) {
      event.preventDefault();
      const entry = entries[highlighted];
      if (entry) select(entry);
      return;
    }
    if (event.key === "Enter" && onSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="dir-input" ref={containerRef}>
      <div className="dir-input-field">
        <Icon name="folder" size={14} />
        <input
          ref={inputRef}
          className="mono dir-input-text"
          value={value}
          onChange={(event) => {
            interactedRef.current = true;
            onChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (interactedRef.current && entries.length > 0) setOpen(true);
          }}
          onMouseDown={() => {
            interactedRef.current = true;
          }}
          placeholder={placeholder ?? "/absolute/path/to/folder"}
          aria-label={ariaLabel ?? "Folder path"}
          autoFocus={autoFocus}
          disabled={disabled}
          spellCheck={false}
        />
        {loading && <span className="dir-input-busy">…</span>}
      </div>
      {open && entries.length > 0 && (
        <div className="dir-menu" role="listbox" aria-label="Matching folders">
          {entries.slice(0, 100).map((entry, index) => (
            <button
              type="button"
              key={entry.path}
              role="option"
              aria-selected={index === highlighted}
              className={`dir-item ${index === highlighted ? "active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                select(entry);
              }}
              onMouseEnter={() => setHighlighted(index)}
            >
              <Icon name="folder" size={13} />
              <span className="dir-item-name">{entry.name}</span>
              {entry.isGitRepository && <span className="board-chip git">git</span>}
              <span className="dir-item-path mono">{entry.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Splits what the user typed into "which folder do I list" and "what prefix do
 * I filter by". `~` and a trailing slash are handled explicitly so the field
 * behaves the same as the fork's picker.
 */
export function splitPathInput(value: string): { requestPath: string; prefix: string } {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "~" || trimmed === "~/" || trimmed === "~\\") {
    return { requestPath: "~", prefix: "" };
  }
  if (/[\\/]$/u.test(trimmed)) {
    const stripped = trimmed.replace(/[\\/]+$/u, "");
    return { requestPath: stripped === "" ? "/" : stripped, prefix: "" };
  }
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) return { requestPath: "~", prefix: trimmed };
  const parent = trimmed.slice(0, separator);
  return { requestPath: parent === "" ? "/" : parent, prefix: trimmed.slice(separator + 1) };
}
