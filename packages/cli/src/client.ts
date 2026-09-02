/**
 * Minimal HTTP client for the AgentFabric REST API.
 */
export class ApiClient {
  constructor(public baseUrl: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
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
    const res = await fetch(`${this.baseUrl}${path}`);
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
