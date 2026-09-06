import { ReactNode, useEffect, useState } from "react";

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
  | "plus"
  | "terminal"
  | "refresh"
  | "stop";

const iconPaths: Record<IconName, ReactNode> = {
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
  plus: <path d="M12 5v14M5 12h14" />,
  terminal: (
    <>
      <path d="m5 7 4 4-4 4" />
      <path d="M13 17h6" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  stop: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
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

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
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
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>Error: {message}</div>;
}

export function emptyTableHint(loading: boolean, error: string | null) {
  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="muted" style={{ color: "var(--red)" }}>{error}</div>;
  return <div className="muted">No items yet.</div>;
}
