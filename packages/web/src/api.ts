
/**
 * HTTP error carrying the server's machine-readable code. A
 * `handoff-unavailable` error means the continuation is still possible if
 * the user explicitly accepts a degraded context (`allowDegraded`).
 */
import type { Translate } from "./i18n";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly allowDegraded?: boolean,
    /** Full response body, for errors that carry actionable detail (e.g. the
     *  board's `requiresGitInitialization` + resolved `path`). */
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Response cache for GETs.
 *
 * The UI reads the same small lists from many views (`/api/models`,
 * `/api/providers`, `/api/workspaces`, …): walking the nav used to re-fetch each
 * one every time a view mounted — measured 25 requests for 9 distinct resources
 * over nine clicks. Two things are cached here:
 *
 * - **In-flight requests**, so two views mounting at once share one round trip.
 * - **Fresh responses**, for `GET_TTL_MS`. A view that remounts within that
 *   window renders immediately instead of flashing its loading state.
 *
 * The cache is invalidated wholesale by any write (`post`/`put`/`patch`/`del`):
 * a local loopback server makes a re-fetch cheap, and a stale list after a
 * mutation is a bug users would notice. `reload()` on a view bypasses the cache
 * — an explicit refresh must reach the server.
 */
const GET_TTL_MS = 5_000;
const fresh = new Map<string, { at: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

/** Drops every cached GET. Called after a write. */
export function invalidateApiCache(): void {
  fresh.clear();
  inFlight.clear();
}

/** The cached GET for `path` if it is still fresh; otherwise runs `load`. */
export async function cachedGet<T>(path: string, load: () => Promise<T>, force = false): Promise<T> {
  if (!force) {
    const hit = fresh.get(path);
    if (hit && Date.now() - hit.at < GET_TTL_MS) return hit.value as T;
    const pending = inFlight.get(path);
    if (pending) return (await pending) as T;
  }
  const request = load().then((value) => {
    fresh.set(path, { at: Date.now(), value });
    inFlight.delete(path);
    return value;
  });
  // A failure must not be cached: the next view should retry, not reuse an error.
  request.catch(() => inFlight.delete(path));
  inFlight.set(path, request);
  return request;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; code?: string; allowDegraded?: boolean };
    throw new ApiError(
      body.error ?? `${res.status} ${res.statusText}`,
      res.status,
      body.code,
      body.allowDegraded,
      body as Record<string, unknown>
    );
  }
  return data as T;
}

/**
 * GET, served from the cache described above. `force` is for an explicit
 * refresh (a user asked for it), not for a view mounting.
 */
export const get = <T>(p: string, headers?: HeadersInit, force = false) =>
  cachedGet<T>(p, () => api<T>(p, { headers }), force);

/** Writes: the cache cannot know what they changed, so it is dropped. */
const write = async <T>(path: string, init: RequestInit): Promise<T> => {
  try {
    return await api<T>(path, init);
  } finally {
    invalidateApiCache();
  }
};

export const post = <T>(p: string, body?: unknown, signal?: AbortSignal, headers?: HeadersInit) =>
  write<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined, signal, headers });
export const put = <T>(p: string, body?: unknown, headers?: HeadersInit) =>
  write<T>(p, { method: "PUT", body: body ? JSON.stringify(body) : undefined, headers });
export const patch = <T>(p: string, body?: unknown, headers?: HeadersInit) =>
  write<T>(p, { method: "PATCH", body: body ? JSON.stringify(body) : undefined, headers });
export const del = <T>(p: string, headers?: HeadersInit) => write<T>(p, { method: "DELETE", headers });

/**
 * "Ago" labels have to advance on their own.
 *
 * `fmtRelative` is computed during render, so a list showing "2m ago" keeps
 * saying "2m ago" until something else re-renders it. A shared ticker re-renders
 * the subscribers once a minute — one timer for the whole app, and only while
 * the window is visible (a background window does not need its labels to age).
 * Returns an unsubscribe function; when the last subscriber leaves, the timer
 * stops.
 */
const clockSubscribers = new Set<() => void>();
let clockTimer: number | undefined;
let clockUnsubs: Array<() => void> = [];

function stopClock(): void {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
  clockTimer = undefined;
  for (const off of clockUnsubs) off();
  clockUnsubs = [];
}

export function subscribeClock(onTick: () => void): () => void {
  clockSubscribers.add(onTick);
  if (clockTimer === undefined) {
    const start = () => {
      if (clockTimer !== undefined) return;
      // 30s, not 60: a label must never be off by a whole minute.
      clockTimer = window.setInterval(() => {
        for (const fn of clockSubscribers) fn();
      }, 30_000);
    };
    if (document.visibilityState === "visible") start();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        for (const fn of clockSubscribers) fn();
        start();
      } else if (clockTimer !== undefined) {
        window.clearInterval(clockTimer);
        clockTimer = undefined;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    clockUnsubs.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  return () => {
    clockSubscribers.delete(onTick);
    if (clockSubscribers.size === 0) stopClock();
  };
}

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

/**
 * Absolute timestamp, in the one format the app shows.
 *
 * `toLocaleString()` with no options gives whatever the host locale and OS
 * settings produce — a 12-hour clock in one window and 24-hour in the next,
 * and a different separator for every field order. Exported so the places that
 * used to format dates themselves (and drift) share this one.
 */
export function fmtDateTime(iso?: string): string {
  if (!iso) return "-";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "-";
  return new Date(at).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Alias kept for the call sites that read as "the time". */
export const fmtTime = fmtDateTime;

/**
 * Money, with only the digits it actually has.
 *
 * `toFixed(6)` printed `$0.000012` for one cheap request and `$0.000000` for a
 * free one — six characters of noise on every figure in every table. The Usage
 * page grew its own copy of this rule; this is that rule, so the run list, the
 * run inspector and Usage cannot disagree about what a number looks like.
 */
export function fmtCost(cost?: number): string {
  if (cost == null || !Number.isFinite(cost)) return "-";
  if (cost === 0) return "$0";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** "—" instead of "$0" when there is nothing to report (turn metadata, v5 §11). */
export function fmtCostShort(cost?: number): string {
  if (cost == null || cost === 0) return "-";
  return fmtCost(cost);
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

/**
 * Relative time for list views: "3m ago" / "2h ago" / a date beyond a week.
 *
 * Takes the translator rather than reading a global one, because every list
 * view that shows a timestamp has to follow the UI language — an English
 * "2h ago" inside a Chinese page is exactly the bug this signature prevents.
 * The clock ticker that keeps these labels fresh lives in this module too.
 */
export function fmtRelative(t: Translate, iso?: string): string {
  if (!iso) return "-";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "-";
  const diff = Date.now() - at;
  if (diff < 60_000) return t("rel.justNow");
  if (diff < 3_600_000) return t("rel.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("rel.hoursAgo", { n: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("rel.daysAgo", { n: Math.floor(diff / 86_400_000) });
  return fmtDateTime(iso);
}

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/**
 * Copy text to the clipboard. The async Clipboard API only exists in
 * secure contexts (localhost counts, plain-http LAN access doesn't), so
 * fall back to a temporary textarea + execCommand there. Returns whether
 * the copy actually landed — callers must surface failures instead of
 * dropping them silently.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the execCommand path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand("copy");
    ta.remove();
    return copied;
  } catch {
    return false;
  }
}
