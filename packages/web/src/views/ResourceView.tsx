import { ReactNode, useState } from "react";
import { del, get, post, put } from "../api";
import { StatusBadge, useAsync, ErrorBox, Field } from "../components";

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
}

const configs: Record<string, Config> = {
  providers: {
    title: "Providers",
    path: "/api/providers",
    columns: [
      { key: "id", label: "ID", render: (r) => <span className="mono">{r.id}</span> },
      { key: "name", label: "Name" },
      { key: "type", label: "Type" },
      { key: "baseUrl", label: "Base URL", render: (r) => <span className="mono">{r.baseUrl ?? "-"}</span> },
      { key: "apiKeyMasked", label: "API Key", render: (r) => <span className="mono">{r.apiKeyMasked ?? "-"}</span> },
      { key: "enabled", label: "Enabled", render: (r) => <StatusBadge status={r.enabled ? "running" : "cancelled"} /> },
    ],
    createFields: [
      { key: "name", label: "Name", required: true },
      { key: "type", label: "Type", type: "select", options: ["openai", "openai-compatible", "anthropic", "custom"] },
      { key: "baseUrl", label: "Base URL / API Endpoint", placeholder: "https://api.openai.com/v1" },
      { key: "apiKey", label: "API Key (stored as Secret)", type: "password" },
    ],
    rowActions: (row, reload) => (
      <>
        <button className="small" onClick={() => toggleEnabled(row, reload)}>{row.enabled ? "disable" : "enable"}</button>{" "}
        <button className="small danger" onClick={() => removeItem("/api/providers", row.id, reload)}>delete</button>
      </>
    ),
  },
  models: {
    title: "Models",
    path: "/api/models",
    columns: [
      { key: "id", label: "ID", render: (r) => <span className="mono">{r.id}</span> },
      { key: "name", label: "Model" },
      { key: "alias", label: "Alias", render: (r) => r.alias ?? "-" },
      { key: "providerId", label: "Provider", render: (r) => <span className="mono">{r.providerId}</span> },
      { key: "capabilities", label: "Capabilities", render: (r) => (r.capabilities ?? []).join(", ") || "-" },
      { key: "enabled", label: "Enabled", render: (r) => <StatusBadge status={r.enabled ? "running" : "cancelled"} /> },
    ],
    createFields: [
      { key: "name", label: "Model name / id", required: true, placeholder: "gpt-4o" },
      { key: "providerId", label: "Provider id", required: true, placeholder: "prov_…" },
      { key: "alias", label: "Alias", placeholder: "my-gpt" },
    ],
    rowActions: (row, reload) => (
      <button className="small danger" onClick={() => removeItem("/api/models", row.id, reload)}>delete</button>
    ),
  },
  runtimes: {
    title: "Runtimes",
    path: "/api/runtimes",
    columns: [
      { key: "id", label: "ID", render: (r) => <span className="mono">{r.id}</span> },
      { key: "name", label: "Name" },
      { key: "kind", label: "Kind" },
      { key: "image", label: "Image", render: (r) => <span className="mono">{r.image ?? "-"}</span> },
      { key: "containerized", label: "Container", render: (r) => String(Boolean(r.containerized)) },
      { key: "enabled", label: "Enabled", render: (r) => <StatusBadge status={r.enabled ? "running" : "cancelled"} /> },
    ],
    createFields: [
      { key: "name", label: "Name", required: true },
      { key: "kind", label: "Kind", type: "select", options: ["opencode", "pi", "docker", "mock", "custom"] },
      { key: "image", label: "Docker image", placeholder: "node:22-alpine" },
      { key: "command", label: "Container command (docker kind)", placeholder: "sh -c echo hello" },
      { key: "description", label: "Description" },
    ],
    rowActions: (row, reload) => (
      <>
        <button className="small" onClick={() => toggleRuntime(row, reload)}>{row.enabled ? "disable" : "enable"}</button>{" "}
        <button className="small danger" onClick={() => removeItem("/api/runtimes", row.id, reload)}>delete</button>
      </>
    ),
  },
  agents: {
    title: "Agents",
    path: "/api/agents",
    columns: [
      { key: "id", label: "ID", render: (r) => <span className="mono">{r.id}</span> },
      { key: "name", label: "Name" },
      { key: "description", label: "Description", render: (r) => r.description ?? "-" },
      { key: "runtimeId", label: "Runtime", render: (r) => <span className="mono">{r.runtimeId ?? "-"}</span> },
      { key: "modelId", label: "Model", render: (r) => <span className="mono">{r.modelId ?? "-"}</span> },
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
      { key: "id", label: "ID", render: (r) => <span className="mono">{r.id}</span> },
      { key: "name", label: "Name" },
      { key: "type", label: "Type" },
      { key: "path", label: "Path / Repo", render: (r) => <span className="mono">{r.path ?? r.repoUrl ?? "-"}</span> },
      { key: "mountPath", label: "Mount", render: (r) => <span className="mono">{r.mountPath}</span> },
    ],
    createFields: [
      { key: "name", label: "Name", required: true },
      { key: "type", label: "Type", type: "select", options: ["local", "git", "volume"] },
      { key: "path", label: "Local path", placeholder: "/path/to/repo" },
      { key: "repoUrl", label: "Git repo URL" },
      { key: "branch", label: "Branch" },
    ],
    rowActions: (row, reload) => (
      <button className="small danger" onClick={() => removeItem("/api/workspaces", row.id, reload)}>delete</button>
    ),
  },
  secrets: {
    title: "Secrets",
    path: "/api/secrets",
    columns: [
      { key: "id", label: "ID", render: (r) => <span className="mono">{r.id}</span> },
      { key: "name", label: "Name" },
      { key: "scope", label: "Scope" },
      { key: "masked", label: "Value", render: (r) => <span className="mono">{r.masked}</span> },
    ],
    createFields: [
      { key: "name", label: "Name", required: true },
      { key: "value", label: "Value", type: "password", required: true },
      { key: "scope", label: "Scope", type: "select", options: ["env", "provider", "git", "runtime", "service"] },
    ],
    rowActions: (row, reload) => (
      <button className="small danger" onClick={() => removeItem("/api/secrets", row.id, reload)}>delete</button>
    ),
  },
};

async function removeItem(path: string, id: string, reload: () => void) {
  if (!confirm(`Delete ${id}?`)) return;
  await del(path + "/" + id);
  reload();
}

async function toggleEnabled(row: any, reload: () => void) {
  await post(`/api/providers/${row.id}/${row.enabled ? "disable" : "enable"}`);
  reload();
}

async function toggleRuntime(row: any, reload: () => void) {
  await post(`/api/runtimes/${row.id}/${row.enabled ? "disable" : "enable"}`);
  reload();
}

export function ResourceView({ kind }: { kind: string }) {
  const cfg = configs[kind];
  const { data, error, loading, reload } = useAsync<any[]>(() => get(cfg.path), [cfg.path]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!cfg) return <div>Unknown resource kind: {kind}</div>;

  const submit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = { ...form };
      if (cfg.path === "/api/runtimes" && body.command) body.command = String(body.command).split(" ");
      if (cfg.path === "/api/runtimes") body.ephemeral = true;
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
          <table>
            <thead>
              <tr>{cfg.columns.map((c) => <th key={c.key}>{c.label}</th>)}<th></th></tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id}>
                  {cfg.columns.map((c) => <td key={c.key}>{c.render ? c.render(row) : String(row[c.key] ?? "")}</td>)}
                  <td>{cfg.rowActions?.(row, reload)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">{loading ? "Loading…" : "No items yet."}</div>
        )}
      </div>
    </div>
  );
}
