export function table(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return "(empty)";
  const keys = columns ?? Object.keys(rows[0] ?? {});
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const pad = (s: string, w: number) => s.padEnd(w);
  const header = keys.map((k, i) => pad(k, widths[i])).join("  ");
  const lines = rows.map((r) => keys.map((k, i) => pad(String(r[k] ?? ""), widths[i])).join("  "));
  return [header, ...lines].join("\n");
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

export function statusColor(status: string): string {
  const colors: Record<string, string> = {
    completed: "\x1b[32m",
    running: "\x1b[36m",
    starting: "\x1b[36m",
    pending: "\x1b[33m",
    failed: "\x1b[31m",
    cancelled: "\x1b[90m",
    timeout: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  return `${colors[status] ?? ""}${status}${reset}`;
}
