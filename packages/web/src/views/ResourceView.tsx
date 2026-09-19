import { ReactNode, useState } from "react";
import { del, get, post, put, fmtTime, shortId } from "../api";
import { StatusBadge, useAsync, ErrorBox, Field, Modal } from "../components";

interface Column {
  key: string;
  label: string;
  render?: (row: any) => ReactNode;
}

interface CreateField {
  key: string;
  label: string;
  type?: "text" | "password" | "textarea" | "select";
  options?: string[];
  placeholder?: string;
  required?: boolean;
}

interface Config {
  title: string;
  path: string;
  columns: Column[];
  createFields: CreateField[];
  rowActions?: (row: any, reload: () => void) => ReactNode;
  /**
   * Row click opens a detail modal — for resources whose attributes don't
   * fit the table. `reload` refreshes the list (the modal re-reads the row
   * by id, so toggles reflect in place); `close` dismisses it.
   */
  detail?: (row: any, helpers: { reload: () => void; close: () => void }) => ReactNode;
  detailTitle?: (row: any) => string;
}

/** Long mono values (ids, paths) clip to an ellipsis; the full value stays in the hover tooltip. */
function Clip({ value, max }: { value: string; max: number }) {
  return (
    <span className="mono clip" title={value} style={{ maxWidth: max }}>
      {value}
    </span>
  );
}

/** Truncated id with the full value in the hover tooltip (same shape as the dashboard). */
function Id({ value }: { value: string }) {
  return (
    <span className="mono nw" title={value}>
      {shortId(value)}
    </span>
  );
}

/** "Sep 9, 11:15 PM" — minute precision keeps the column narrow; full ISO in the tooltip. */
function fmtSaved(iso?: string): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const configs: Record<string, Config> = {
  runtimes: {
    title: "Runtimes",
    path: "/api/runtimes",
    columns: [
      { key: "id", label: "ID", render: (r) => <Id value={r.id} /> },
      { key: "name", label: "Name", render: (r) => <span className="nw">{r.name}</span> },
      { key: "kind", label: "Kind" },
      { key: "enabled", label: "Enabled", render: (r) => <StatusBadge status={r.enabled ? "running" : "cancelled"} /> },
      { key: "usableInTask", label: "Usable in tasks", render: (r) => (r.usableInTask ? "yes" : "no") },
    ],
    createFields: [
      { key: "name", label: "Name", required: true },
      { key: "kind", label: "Kind", type: "select", options: ["opencode", "pi", "codex", "claude-code", "zcode", "docker", "mock", "custom"] },
      { key: "image", label: "Docker image", placeholder: "node:22-alpine" },
      { key: "command", label: "Container command (docker kind)", placeholder: "sh -c echo hello" },
      { key: "lifecycle", label: "Container lifecycle", type: "select", options: ["ephemeral", "keep-alive", "persistent"] },
      { key: "usableInTask", label: "Usable in tasks", type: "select", options: ["true", "false"] },
      { key: "description", label: "Description" },
    ],
    rowActions: (row, reload) => (
      <>
        <button className="small" onClick={() => toggleRuntime(row, reload)}>{row.enabled ? "disable" : "enable"}</button>
        <button className="small" onClick={() => toggleUsable(row, reload)}>{row.usableInTask ? "disallow in tasks" : "allow in tasks"}</button>
        <button className="small danger" onClick={() => removeItem("/api/runtimes", row.id, reload)}>delete</button>
      </>
    ),
    detailTitle: (r) => `Runtime: ${r.name}`,
    detail: (r, { reload, close }) => (
      <>
        <dl className="detail-list">
          <dt>ID</dt><dd className="mono">{r.id}</dd>
          <dt>Name</dt><dd>{r.name}</dd>
          <dt>Kind</dt><dd>{r.kind}</dd>
          <dt>Description</dt><dd>{r.description ?? "—"}</dd>
          <dt>Credentials</dt><dd>{r.credentialSource === "harness-native" ? "Harness native" : "AgentFabric"}</dd>
          <dt>Enabled</dt><dd>{r.enabled ? "yes" : "no"}</dd>
          <dt>Usable in tasks</dt><dd>{r.usableInTask ? "yes" : "no"}</dd>
          <dt>Lifecycle</dt><dd>{r.lifecycle?.mode ?? (r.ephemeral === false ? "persistent" : "ephemeral")}</dd>
          <dt>Containerized</dt><dd>{String(Boolean(r.containerized))}</dd>
          <dt>Image</dt><dd>{r.image ?? "—"}</dd>
          <dt>Command</dt><dd>{Array.isArray(r.command) && r.command.length > 0 ? r.command.join(" ") : "—"}</dd>
          <dt>Working directory</dt><dd>{r.cwd ?? "—"}</dd>
          <dt>Default model</dt><dd>{r.defaultModelId ?? "—"}</dd>
          <dt>Context window</dt><dd>{r.contextWindow ?? "—"}</dd>
          <dt>Env keys</dt><dd>{Object.keys(r.env ?? {}).join(", ") || "—"}</dd>
          <dt>Created</dt><dd>{fmtSaved(r.createdAt)}</dd>
          <dt>Updated</dt><dd>{fmtSaved(r.updatedAt)}</dd>
        </dl>
        <div className="row">
          <span className="right">
            <button className="small" onClick={() => toggleRuntime(r, reload)}>{r.enabled ? "disable" : "enable"}</button>
            <button className="small" onClick={() => toggleUsable(r, reload)}>{r.usableInTask ? "disallow in tasks" : "allow in tasks"}</button>
            <button className="small danger" onClick={() => { removeItem("/api/runtimes", r.id, reload); close(); }}>delete</button>
          </span>
        </div>
      </>
    ),
  },
  agents: {
    title: "Agents",
    path: "/api/agents",
    columns: [
      { key: "id", label: "ID", render: (r) => <Id value={r.id} /> },
      { key: "name", label: "Name", render: (r) => <span className="nw">{r.name}</span> },
      { key: "description", label: "Description", render: (r) => r.description ?? "-" },
      { key: "runtimeId", label: "Runtime", render: (r) => <Id value={r.runtimeId ?? "-"} /> },
      { key: "modelId", label: "Model", render: (r) => <Id value={r.modelId ?? "-"} /> },
    ],
    createFields: [
      { key: "name", label: "Name", required: true },
      { key: "description", label: "Description" },
      { key: "runtimeId", label: "Runtime id", placeholder: "rt_…" },
      { key: "modelId", label: "Model id", placeholder: "mod_…" },
      { key: "systemInstructions", label: "System instructions", type: "textarea" },
    ],
    rowActions: (row, reload) => (
      <button className="small danger" onClick={() => removeItem("/api/agents", row.id, reload)}>delete</button>
    ),
  },
  workspaces: {
    title: "Workspaces",
    path: "/api/workspaces",
    columns: [
      { key: "id", label: "ID", render: (r) => <Id value={r.id} /> },
      { key: "name", label: "Name", render: (r) => <span className="nw">{r.name}</span> },
      { key: "type", label: "Type" },
      { key: "source", label: "Source", render: (r) => r.source ?? "create" },
      { key: "path", label: "Path / Repo", render: (r) => <Clip value={r.path ?? r.repoUrl ?? "-"} max={220} /> },
      { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status === "missing" ? "failed" : "completed"} /> },
      { key: "lastSavedAt", label: "Last saved", render: (r) => <span className="nw" title={r.lastSavedAt}>{fmtSaved(r.lastSavedAt)}</span> },
    ],
    createFields: [
      { key: "name", label: "Name", required: true },
      { key: "type", label: "Type", type: "select", options: ["local", "git", "volume"] },
      { key: "path", label: "Local path", placeholder: "/path/to/repo" },
      { key: "repoUrl", label: "Git repo URL" },
      { key: "branch", label: "Branch" },
    ],
    rowActions: (row, reload) => (
      <>
        <button
          className="small"
          onClick={async () => {
            await post(`/api/workspaces/${row.id}/save`);
            reload();
          }}
          title="Persist/verify the workspace (containers are disposable, workspaces are durable)"
        >
          save
        </button>
        <button className="small danger" onClick={() => removeItem("/api/workspaces", row.id, reload)}>delete</button>
      </>
    ),
  },
};

async function removeItem(path: string, id: string, reload: () => void) {
  if (!confirm(`Delete ${id}?`)) return;
  await del(path + "/" + id);
  reload();
}

async function toggleRuntime(row: any, reload: () => void) {
  await post(`/api/runtimes/${row.id}/${row.enabled ? "disable" : "enable"}`);
  reload();
}

async function toggleUsable(row: any, reload: () => void) {
  await put(`/api/runtimes/${row.id}`, { usableInTask: !row.usableInTask });
  reload();
}

/**
 * Lightweight harness runtime status (v6 §12, v7 §16): for each enabled
 * harness-native runtime, show CLI installed / authenticated / credential
 * source / execution backend — availability detection only. Sensitive
 * credential material is never displayed or read.
 */
function HarnessStatusCard() {
  const runtimes = useAsync<any[]>(() => get("/api/runtimes"), []);
  const kinds = [...new Set(
    (runtimes.data ?? [])
      .filter((r) => r.enabled && ["claude-code", "codex"].includes(r.kind))
      .map((r) => r.kind)
  )];
  return (
    <div className="card">
      <h2>Harness runtime status</h2>
      <p className="sub">
        Local coding harnesses run on their own logged-in account (Codex + ChatGPT, Claude Code + Claude.ai).
        AgentFabric only detects availability — credentials stay with the harness and are never displayed or read.
      </p>
      {kinds.length === 0 ? (
        <div className="muted">No harness-native runtime enabled.</div>
      ) : (
        kinds.map((kind) => <HarnessStatusRow key={kind} kind={kind} runtimes={runtimes.data ?? []} />)
      )}
    </div>
  );
}

function HarnessStatusRow({ kind, runtimes }: { kind: string; runtimes: any[] }) {
  const auth = useAsync<any>(() => get(`/api/harness/${kind}/auth-status`), [kind]);
  const runtime = runtimes.find((r) => r.kind === kind && r.enabled);
  const status = auth.data;
  return (
    <div style={{ marginBottom: 12 }}>
      <strong>{runtime?.name ?? kind}</strong>
      <table>
        <thead>
          <tr><th>CLI installed</th><th>Authenticated</th><th>Credential source</th><th>Execution backend</th><th>Detail</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>{status ? (status.installed ? "✓" : "✗") : "…"}</td>
            <td>{status ? (status.loggedIn ? "✓" : "✗") : "…"}</td>
            <td>Harness native</td>
            <td>{runtime?.containerized ? "docker" : "local"}</td>
            <td className="muted">
              {status?.detail ?? (auth.error ? auth.error : "checking…")}
              {status?.version ? ` · ${status.version}` : ""}
            </td>
          </tr>
        </tbody>
      </table>
      {status && !status.ok && status.hint && <div className="muted">{status.hint}</div>}
      {auth.error && <div className="muted">Auth check unavailable: {auth.error}</div>}
    </div>
  );
}

export function ResourceView({ kind }: { kind: string }) {
  const cfg = configs[kind];
  const { data, error, loading, reload } = useAsync<any[]>(() => get(cfg.path), [cfg.path]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Detail modal holds the row *id*: after an action reloads the list, the
  // modal re-reads the fresh row, so toggles reflect without reopening.
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailRow = data?.find((r) => r.id === detailId);

  if (!cfg) return <div>Unknown resource kind: {kind}</div>;

  const submit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = { ...form };
      if (cfg.path === "/api/runtimes") {
        if (body.command) body.command = String(body.command).split(" ");
        if (body.lifecycle) body.lifecycle = { mode: body.lifecycle };
        // The form carries strings; unset ("") falls back to the server's
        // kind default.
        if (body.usableInTask === "true" || body.usableInTask === "false") {
          body.usableInTask = body.usableInTask === "true";
        } else {
          delete body.usableInTask;
        }
        delete body.ephemeral;
      }
      await post(cfg.path, body);
      setForm({});
      setShowCreate(false);
      reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="row">
        <h1>{cfg.title}</h1>
        <span className="right">
          <button className="primary" onClick={() => setShowCreate((v) => !v)}>{showCreate ? "close" : "+ add"}</button>
        </span>
      </div>
      <p className="sub">Manage {cfg.title.toLowerCase()} through the AgentFabric API.</p>

      {showCreate && (
        <div className="card">
          <h2>Add {cfg.title.slice(0, -1)}</h2>
          {cfg.createFields.map((f) => (
            <Field key={f.key} label={f.label}>
              {f.type === "select" ? (
                <select value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}>
                  <option value="">— select —</option>
                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea rows={3} value={form[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              ) : (
                <input
                  type={f.type === "password" ? "password" : "text"}
                  value={form[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
          {saveError && <div className="muted" style={{ color: "var(--red)" }}>{saveError}</div>}
          <button className="primary" disabled={saving} onClick={submit}>{saving ? "saving…" : "create"}</button>
        </div>
      )}

      <ErrorBox message={error} />
      <div className="card">
        {data && data.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{cfg.columns.map((c) => <th key={c.key}>{c.label}</th>)}<th className="actions"></th></tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr
                    key={row.id}
                    className={cfg.detail ? "clickable" : undefined}
                    title={cfg.detail ? "Click for details" : undefined}
                    onClick={cfg.detail ? () => setDetailId(row.id) : undefined}
                  >
                    {cfg.columns.map((c) => <td key={c.key}>{c.render ? c.render(row) : String(row[c.key] ?? "")}</td>)}
                    <td className="actions" onClick={(e) => e.stopPropagation()}>{cfg.rowActions?.(row, reload)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted">{loading ? "Loading…" : "No items yet."}</div>
        )}
      </div>

      {detailRow && cfg.detail && (
        <Modal title={cfg.detailTitle ? cfg.detailTitle(detailRow) : "Details"} onClose={() => setDetailId(null)}>
          {cfg.detail(detailRow, { reload, close: () => setDetailId(null) })}
        </Modal>
      )}

      {kind === "runtimes" && <HarnessStatusCard />}
    </div>
  );
}
