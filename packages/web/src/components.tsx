import { KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useState } from "react";
import { copyText, subscribeClock } from "./api";

export type IconName =
  | "grid"
  | "play"
  | "history"
  | "cloud"
  | "cpu"
  | "box"
  | "bot"
  | "folder"
  | "key"
  | "archive"
  | "chart"
  | "gear"
  | "search"
  | "bell"
  | "compose"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "chevron"
  | "eye"
  | "eyeOff"
  | "trash"
  | "more"
  | "plus"
  | "terminal"
  | "refresh"
  | "stop"
  | "branch"
  | "folderOpen"
  | "restore"
  | "close"
  | "edit"
  | "star"
  | "compass"
  | "sidebar"
  | "newSession";

const iconPaths: Record<IconName, ReactNode> = {
  star: (
    <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .74 4.3L8 11.6l-3.84 2 .74-4.3-3.1-3 4.3-.6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.2l5.5 3.8-5.5 3.8z" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  cpu: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  ),
  box: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="M3.3 7 12 12l8.7-5" />
      <path d="M12 22V12" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="2.5" />
      <path d="M12 9V5" />
      <circle cx="12" cy="4" r="1.2" />
      <circle cx="9" cy="14" r="0.4" fill="currentColor" />
      <circle cx="15" cy="14" r="0.4" fill="currentColor" />
      <path d="M9.5 17.2h5" />
    </>
  ),
  folder: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  key: (
    <>
      <circle cx="8" cy="16" r="4.2" />
      <path d="M11 13 19.5 4.5" />
      <path d="m15.5 8.5 3 3" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1.2" />
      <path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5" />
      <path d="M10 12.5h4" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7.5 15v3M12.5 10v8M17.5 6v12" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  compose: (
    <>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.4 2.6a2.12 2.12 0 1 1 3 3L12 15l-4 1 1-4Z" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="m4 4 16 16" />
      <path d="M10.3 5.7A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.4 17.4 0 0 1-2.9 3.8" />
      <path d="M6.3 6.9C3.9 8.7 2.5 12 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.2-.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
      <path d="m19 6-.9 13.1a2 2 0 0 1-2 1.9H7.9a2 2 0 0 1-2-1.9L5 6" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  // Vertical kebab (the three-dot task menu)
  more: (
    <>
      <circle cx="12" cy="5.4" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.6" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  terminal: (
    <>
      <path d="m5 7 4 4-4 4" />
      <path d="M13 17h6" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="9" r="2.4" />
      <path d="M6 8.4v7.2" />
      <path d="M18 11.4c0 3.4-2.6 4.9-9.4 5.9" />
    </>
  ),
  restore: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  folderOpen: (
    <>
      <path d="M3 8.5V6a2 2 0 0 1 2-2h3.1a2 2 0 0 1 1.6.8l1.2 1.6H18a2 2 0 0 1 2 2v1.6" />
      <path d="M3.2 10.4h18l-2 8.6a2 2 0 0 1-2 1.5H5.2a2 2 0 0 1-2-1.5Z" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  // Panel dismissal (Settings close).
  close: <path d="M6 6l12 12M18 6 6 18" />,
  // "Edit on disk": a pencil over a sheet.
  edit: (
    <>
      <path d="M4 20h4l10-10a2.12 2.12 0 0 0-3-3L5 17Z" />
      <path d="M4 20v-3" />
    </>
  ),
  // Language switch: a compass rose, i.e. "this is a locale choice".
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-2 5-4 1 2-5z" />
    </>
  ),
  /**
   * Rail collapse/expand: a panel outline with a filled rail column on the
   * left (the reference UI's own control). The rail reads as "the part that
   * goes away", so one icon serves both directions.
   */
  sidebar: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M9.2 4.5v15" />
      <path d="M5.6 8.2h1.6M5.6 11.4h1.6" />
    </>
  ),
  /** "New session": a plus inside a speech bubble. */
  newSession: (
    <>
      <path d="M20.5 11.4a8.2 8.2 0 0 1-11.9 7.3L4 20l1.3-4.6A8.2 8.2 0 1 1 20.5 11.4Z" />
      <path d="M12 8.6v5.6M9.2 11.4h5.6" />
    </>
  ),
  stop: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  /** An extra class for the few places that treat one icon differently (a
   *  workspace's folder, a collapsing chevron). */
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {iconPaths[name]}
    </svg>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

/**
 * Loads data for a view.
 *
 * `fn` reads through the API cache (`get`), so a remount within its TTL is
 * instant. `reload()` is the exception: it re-runs `fn` with `force`, because a
 * user pressing refresh must reach the server rather than the cache.
 */
export function useAsync<T>(
  fn: (force: boolean) => Promise<T>,
  deps: unknown[] = []
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // `null` until the first reload: the mount pass goes through the cache, every
  // later pass is an explicit refresh.
  const [tick, setTick] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn(tick !== null)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => (t ?? 0) + 1) };
}

/**
 * Re-renders once a minute so "3m ago" labels move without user interaction
 * (see `subscribeClock`). Used by the rows that show a relative timestamp.
 */
export function useMinuteClock(): void {
  const [, setTick] = useState(0);
  useEffect(() => subscribeClock(() => setTick((t) => t + 1)), []);
}

/**
 * Polls while `active`, and only while the window is visible.
 *
 * A background window throttles timers anyway, so the requests it does issue
 * only wake the server and burn battery — a task view left open behind another
 * app does not need to refresh every two seconds. Coming back to the window
 * refreshes once immediately, so the first painted state is current rather
 * than up to one interval old.
 */
export function usePolling(reload: () => void, intervalMs: number, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const start = () => {
      if (timer !== undefined) return;
      timer = window.setInterval(reload, intervalMs);
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        reload();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload, intervalMs, active]);
}

/**
 * Props for a clickable row that should also be reachable by keyboard.
 *
 * `<div onClick>` is mouse-only: a keyboard user cannot tab to it, and screen
 * readers do not announce it as actionable. These rows navigate somewhere, so
 * they get `role="button"`, are tab-focusable, and activate on Enter/Space —
 * the same contract `CardTile` on the board already implements.
 */
export function clickableRow(onActivate: () => void): {
  role: "button";
  tabIndex: 0;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
} {
  return {
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}

/**
 * Page controls for a list that grows without bound.
 *
 * Rows are paged rather than virtualised: these lists are cards and table rows
 * with per-row menus, and a page of 50 keeps both the DOM and the re-render
 * cost flat while staying simple (no measurement, no scroll anchoring). The
 * label says which rows are shown and how many exist, so paging never hides the
 * size of the list.
 */
export function Pager({
  page,
  pageCount,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="pager">
      <span className="muted">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <span className="pager-actions">
        <button className="small" disabled={page === 0} onClick={() => onChange(0)} title="First page">«</button>
        <button className="small" disabled={page === 0} onClick={() => onChange(page - 1)}>Prev</button>
        <button className="small" disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)}>Next</button>
        <button className="small" disabled={page >= pageCount - 1} onClick={() => onChange(pageCount - 1)} title="Last page">»</button>
      </span>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}

/**
 * Minimal confirmation dialog. Clicking the overlay or pressing Escape
 * counts as cancel — callers just close without committing.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>Error: {message}</div>;
}

/**
 * Copy-to-clipboard button with visible feedback: the label swaps to
 * "copied ✓" briefly, or to "copy failed" when the clipboard write
 * fails (possible outside secure contexts) — never silently.
 */
export function CopyButton({ text, label, title, className = "small" }: {
  text: string;
  label: string;
  title?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      className={className}
      title={title}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "ok" : "fail");
        window.setTimeout(() => setState("idle"), 1500);
      }}
    >
      {state === "ok" ? "copied ✓" : state === "fail" ? "copy failed" : label}
    </button>
  );
}

export function emptyTableHint(loading: boolean, error: string | null) {
  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="muted" style={{ color: "var(--red)" }}>{error}</div>;
  return <div className="muted">No items yet.</div>;
}
