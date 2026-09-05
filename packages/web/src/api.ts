export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>(p);
export const post = <T>(p: string, body?: unknown) => api<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined });
export const put = <T>(p: string, body?: unknown) => api<T>(p, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
export const del = <T>(p: string) => api<T>(p, { method: "DELETE" });

/** Subscribe to an SSE endpoint. Returns an unsubscribe function. */
export function subscribeSSE(path: string, onEvent: (data: unknown) => void): () => void {
  const es = new EventSource(path);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    /* EventSource auto-reconnects */
  };
  return () => es.close();
}

export function fmtTime(iso?: string): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

export function fmtCost(cost?: number): string {
  if (cost == null) return "-";
  return `$${cost.toFixed(6)}`;
}

/** Compact cost for turn metadata, e.g. $0.002 / $1.23 (v5 §11). */
export function fmtCostShort(cost?: number): string {
  if (cost == null || cost === 0) return "-";
  if (cost < 0.01) return `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Compact duration for turn metadata, e.g. 840ms / 18s / 1m 2s (v5 §11). */
export function fmtDuration(ms?: number): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Compact token count for turn metadata, e.g. 1.2k (v5 §11). */
export function fmtTokens(n?: number): string {
  if (n == null) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Relative time for list views: "3m ago" / "2h ago" / date. */
export function fmtRelative(iso?: string): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
