import { ReactNode, useState } from "react";
import { del, get, post, put, fmtTime, shortId } from "../api";
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
  runtimes: {
    title: "Runtimes",
    path: "/api/runtimes",
    columns: [
      { key: "id", label: "ID", render: (r) => <span className="mono">{r.id}</span> },
      { key: "name", label: "Name" },
      { key: "kind", label: "Kind" },
      { key: "image", label: "Image", render: (r) => <span className="mono">{r.image ?? "-"}</span> },
      { key: "containerized", label: "Container", render: (r) => String(Boolean(r.containerized)) },
      { key: "lifecycle", label: "Lifecycle", render: (r) => r.lifecycle?.mode ?? (r.ephemeral === false ? "persistent" : "ephemeral") },
      { key: "enabled", label: "Enabled", render: (r) => <StatusBadge status={r.enabled ? "running" : "cancelled"} /> },
    ],
    createFields: [
      { key: "name", label: "Name", required: true },
      { key: "kind", label: "Kind", type: "select", options: ["opencode", "pi", "docker", "mock", "custom"] },
      { key: "image", label: "Docker image", placeholder: "node:22-alpine" },
      { key: "command", label: "Container command (docker kind)", placeholder: "sh -c echo hello" },
      { key: "lifecycle", label: "Container lifecycle", type: "select", options: ["ephemeral", "keep-alive", "persistent"] },
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
      { key: "source", label: "Source", render: (r) => r.source ?? "create" },
      { key: "path", label: "Path / Repo", render: (r) => <span className="mono">{r.path ?? r.repoUrl ?? "-"}</span> },
      { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status === "missing" ? "failed" : "completed"} /> },
      { key: "lastSavedAt", label: "Last saved", render: (r) => r.lastSavedAt ?? "-" },
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
        </button>{" "}
        <button className="small danger" onClick={() => removeItem("/api/workspaces", row.id, reload)}>delete</button>
      </>
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

async function toggleRuntime(row: any, reload: () => void) {
  await post(`/api/runtimes/${row.id}/${row.enabled ? "disable" : "enable"}`);
  reload();
}

/**
 * Harness-native session references and opaque native states, shown as
 * runtime metadata (v2 §5): these belong to each harness — they are not
 * a unified AgentFabric session resource.
 */
function RuntimeNativeSessionsCard() {
  const refs = useAsync<any[]>(() => get("/api/runtime-sessions"), []);
  const states = useAsync<any[]>(() => get("/api/native-states"), []);
  const allRefs = refs.data ?? [];
  const allStates = states.data ?? [];

  return (
    <div className="card">
      <h2>Native sessions (per harness)</h2>
      <p className="sub">
        Opaque references into each harness's own session store. Pi sessions and OpenCode sessions are different
        things — AgentFabric never converts between them. Same harness → Resume; different harness → Handoff.
      </p>
      {allRefs.length > 0 ? (
        <table>
          <thead>
            <tr><th>Runtime</th><th>Harness</th><th>Native reference</th><th>Version</th><th>Resume</th><th>Backend</th><th>Last used run</th><th>Created</th></tr>
          </thead>
          <tbody>
            {allRefs.slice(0, 20).map((s) => (
              <tr key={s.id}>
                <td>{s.runtimeName ?? "-"}</td>
                <td>{s.runtimeKind}</td>
                <td className="mono" title={s.nativeSessionRef}>{s.nativeSessionRef}</td>
                <td className="muted">{s.runtimeVersion ?? "-"}</td>
                <td>{s.resumeSupported ? "yes" : "no"}</td>
                <td className="muted">{s.executionBackend ?? "-"}</td>
                <td className="mono">{shortId(s.runId)}</td>
                <td className="muted">{fmtTime(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted">No native session references yet.</div>
      )}

      <h2 style={{ marginTop: 18 }}>Native state storage (opaque)</h2>
      <p className="sub">Harness-private state directories mounted into containers so native sessions survive container destruction.</p>
      {allStates.length > 0 ? (
        <table>
          <thead>
            <tr><th>Runtime</th><th>Harness</th><th>Mounted at</th><th>Last used run</th><th>Host path</th></tr>
          </thead>
          <tbody>
            {allStates.map((s) => (
              <tr key={s.id}>
                <td className="mono">{shortId(s.runtimeId)}</td>
                <td>{s.runtimeKind}</td>
                <td className="mono">{s.mountPath}</td>
                <td className="mono">{s.lastUsedRunId ? shortId(s.lastUsedRunId) : "-"}</td>
                <td className="mono muted" title={s.path}>{s.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted">No native state yet (created automatically for containerized harness runs).</div>
      )}
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

  if (!cfg) return <div>Unknown resource kind: {kind}</div>;

  const submit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = { ...form };
      if (cfg.path === "/api/runtimes") {
        if (body.command) body.command = String(body.command).split(" ");
        if (body.lifecycle) body.lifecycle = { mode: body.lifecycle };
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

      {kind === "runtimes" && <RuntimeNativeSessionsCard />}
    </div>
  );
}
