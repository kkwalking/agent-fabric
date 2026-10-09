/**
 * Minimal HTTP client for the AgentFabric REST API.
 *
 * Every request carries the server's bearer token (resolved by `auth.ts`,
 * lazily so that argument errors surface before credential errors). The
 * token value never appears in an error message — a 401 is reported as
 * "missing or invalid credentials" plus the path the token is expected at.
 */
import { resolveToken, tokenFilePath } from "./auth.js";

export class ApiClient {
  private resolved?: string;

  constructor(public baseUrl: string, private readonly explicitToken?: string) {}

  /** Resolve once, on the first request: missing credentials must fail loudly. */
  private token(): string {
    return (this.resolved ??= resolveToken(this.explicitToken));
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token()}` };
    if (hasBody) headers["Content-Type"] = "application/json";
    return headers;
  }

  /** A 401 is a client-side credential problem, not a generic HTTP failure. */
  private unauthorized(method: string, path: string): Error {
    return new Error(
      `unauthorized (${method} ${path}): the API token is missing or invalid.\n` +
        `The server's token lives at ${tokenFilePath()} — override it with --token <t> or AGENTFABRIC_TOKEN ` +
        `(start the server once if that file does not exist yet).`
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 401) throw this.unauthorized(method, path);
    if (!res.ok) {
      const message = (data as { error?: string } | null)?.error ?? text ?? res.statusText;
      throw new Error(`${method} ${path} -> ${res.status}: ${message}`);
    }
    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body ?? {});
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body ?? {});
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /**
   * Stream SSE lines from a path, calling onEvent per data line.
   * When onEvent returns `true` the stream is cancelled and the promise resolves.
   */
  async stream(path: string, onEvent: (data: unknown) => boolean | void): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(false) });
    if (res.status === 401) throw this.unauthorized("GET", path);
    if (!res.ok || !res.body) {
      throw new Error(`stream ${path} failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const stop = onEvent(JSON.parse(line.slice(6)));
              if (stop === true) {
                await reader.cancel();
                return;
              }
            } catch {
              /* skip malformed */
            }
          }
        }
      }
    }
  }
}
