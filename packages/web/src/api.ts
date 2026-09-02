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

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
