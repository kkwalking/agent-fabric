import { ReactNode, useEffect, useRef, useState } from "react";
import { del, get, post, put, fmtTime, shortId } from "../api";
import { StatusBadge, useAsync, ErrorBox, Field, Modal } from "../components";
import { AddRuntimeDialog } from "../components/AddRuntimeDialog";
import { useI18n, useT } from "../i18n-react";
import type { MessageKey, Translate } from "../i18n";

interface Column {
  key: string;
  label: MessageKey;
  render?: (row: any) => ReactNode;
}

interface CreateField {
  key: string;
  label: MessageKey;
  type?: "text" | "password" | "textarea" | "select";
  options?: string[];
  placeholder?: string;
  required?: boolean;
}

interface Config {
  /** The list's name; its singular is used in "Add …" and the description. */
  title: MessageKey;
  titleOne: MessageKey;
  path: string;
  columns: Column[];
  createFields: CreateField[];
  rowActions?: (row: any, reload: () => void, t: Translate) => ReactNode;
  /**
   * Row click opens a detail modal — for resources whose attributes don't
   * fit the table. `reload` refreshes the list (the modal re-reads the row
   * by id, so toggles reflect in place); `close` dismisses it.
   */
  detail?: (row: any, helpers: { reload: () => void; close: () => void; t: Translate }) => ReactNode;
  detailTitle?: (row: any, t: Translate) => string;
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
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "-";
  // Deliberately shorter than `fmtDateTime`: these two columns are narrow and
  // a resource never needs its year. Same parsing, same 24-hour-safe options.
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const configs: Record<string, Config> = {
  runtimes: {
    title: "resources.kind.runtimes",
    titleOne: "resources.kind.runtimes.one",
    path: "/api/runtimes",
    columns: [
      { key: "id", label: "resources.col.id", render: (r) => <Id value={r.id} /> },
      { key: "name", label: "resources.col.name", render: (r) => <span className="nw">{r.name}</span> },
      { key: "kind", label: "resources.col.kind" },
      { key: "enabled", label: "resources.col.enabled", render: (r) => <StatusBadge status={r.enabled ? "running" : "cancelled"} /> },
      {
        // The column states whether the runtime runs in a container, so an
        // operator can see the execution backend without opening the record.
        key: "executionBackend",
        label: "resources.col.isolation",
        render: (r) => (r.executionBackend ?? (r.containerized ? "isolated" : "host")),
      },
    ],
    createFields: [
      { key: "name", label: "resources.f.name", required: true },
      { key: "kind", label: "resources.f.kind", type: "select", options: ["opencode", "pi", "codex", "claude-code", "zcode", "dsh", "docker", "mock", "custom"] },
      { key: "executionBackend", label: "resources.f.executionBackend", type: "select", options: ["isolated", "host"] },
      { key: "containerized", label: "resources.f.containerized", type: "select", options: ["true", "false"] },
      { key: "image", label: "resources.f.image", placeholder: "node:22-alpine" },
      { key: "command", label: "resources.f.command", placeholder: "sh -c echo hello" },
      { key: "description", label: "resources.f.description" },
    ],
    rowActions: (row, reload, t) => (
      <>
        <button className="small" onClick={() => toggleRuntime(row, reload)}>{t(row.enabled ? "resources.a.disable" : "resources.a.enable")}</button>
        <button className="small danger" onClick={() => removeItem({ path: "/api/runtimes", id: row.id, name: row.name, reload, onError: reportActionError })}>{t("resources.a.delete")}</button>
      </>
    ),
    detailTitle: (r, t) => t("resources.detail.title", { name: r.name }),
    detail: (r, { reload, close, t }) => (
      <>
        <dl className="detail-list">
          <dt>{t("resources.col.id")}</dt><dd className="mono">{r.id}</dd>
          <dt>{t("resources.col.name")}</dt><dd>{r.name}</dd>
          <dt>{t("resources.col.kind")}</dt><dd>{r.kind}</dd>
          <dt>{t("resources.col.description")}</dt><dd>{r.description ?? "—"}</dd>
          <dt>{t("resources.detail.credentials")}</dt>
          <dd>{r.credentialSource === "harness-native" ? t("resources.detail.harnessNative") : "AgentFabric"}</dd>
          <dt>{t("resources.col.enabled")}</dt><dd>{r.enabled ? t("resources.yes") : t("resources.no")}</dd>
          <dt>{t("resources.f.executionBackend")}</dt><dd>{r.executionBackend ?? (r.containerized ? "isolated" : "host")}</dd>
          <dt>{t("resources.f.containerized")}</dt><dd>{String(Boolean(r.containerized))}</dd>
          <dt>{t("resources.f.image")}</dt><dd>{r.image ?? "—"}</dd>
          <dt>{t("resources.detail.command")}</dt><dd>{Array.isArray(r.command) && r.command.length > 0 ? r.command.join(" ") : "—"}</dd>
          <dt>{t("resources.detail.cwd")}</dt><dd>{r.cwd ?? "—"}</dd>
          <dt>{t("resources.detail.defaultModel")}</dt><dd>{r.defaultModelId ?? "—"}</dd>
          <dt>{t("resources.detail.contextWindow")}</dt><dd>{r.contextWindow ?? "—"}</dd>
          <dt>{t("resources.detail.envKeys")}</dt><dd>{Object.keys(r.env ?? {}).join(", ") || "—"}</dd>
          <dt>{t("resources.detail.created")}</dt><dd>{fmtSaved(r.createdAt)}</dd>
          <dt>{t("resources.detail.updated")}</dt><dd>{fmtSaved(r.updatedAt)}</dd>
        </dl>
        <div className="row">
          <span className="right">
            <button className="small" onClick={() => toggleRuntime(r, reload)}>{r.enabled ? t("resources.a.disable") : t("resources.a.enable")}</button>
            <button className="small danger" onClick={() => { removeItem({ path: "/api/runtimes", id: r.id, name: r.name, reload, onError: reportActionError }); close(); }}>{t("resources.a.delete")}</button>
          </span>
        </div>
      </>
    ),
  },
  agents: {
    title: "resources.kind.agents",
    titleOne: "resources.kind.agents.one",
    path: "/api/agents",
    columns: [
      { key: "id", label: "resources.col.id", render: (r) => <Id value={r.id} /> },
      { key: "name", label: "resources.col.name", render: (r) => <span className="nw">{r.name}</span> },
      { key: "description", label: "resources.col.description", render: (r) => r.description ?? "-" },
      { key: "runtimeId", label: "resources.col.runtime", render: (r) => <Id value={r.runtimeId ?? "-"} /> },
      { key: "modelId", label: "resources.col.model", render: (r) => <Id value={r.modelId ?? "-"} /> },
    ],
    createFields: [
      { key: "name", label: "resources.f.name", required: true },
      { key: "description", label: "resources.f.description" },
      { key: "runtimeId", label: "resources.f.runtimeId", placeholder: "rt_…" },
      { key: "modelId", label: "resources.f.modelId", placeholder: "mod_…" },
      { key: "systemInstructions", label: "resources.f.systemInstructions", type: "textarea" },
    ],
    rowActions: (row, reload, t) => (
      <button className="small danger" onClick={() => removeItem({ path: "/api/agents", id: row.id, name: row.name, reload, onError: reportActionError })}>{t("resources.a.delete")}</button>
    ),
  },
  workspaces: {
    title: "resources.kind.workspaces",
    titleOne: "resources.kind.workspaces.one",
    path: "/api/workspaces",
    columns: [
      { key: "id", label: "resources.col.id", render: (r) => <Id value={r.id} /> },
      { key: "name", label: "resources.col.name", render: (r) => <span className="nw">{r.name}</span> },
      { key: "type", label: "resources.col.type" },
      { key: "source", label: "resources.col.source", render: (r) => r.source ?? "create" },
      { key: "path", label: "resources.col.path", render: (r) => <Clip value={r.path ?? r.repoUrl ?? "-"} max={220} /> },
      { key: "status", label: "resources.col.status", render: (r) => <StatusBadge status={r.status === "missing" ? "failed" : "completed"} /> },
      { key: "lastSavedAt", label: "resources.col.lastSaved", render: (r) => <span className="nw" title={r.lastSavedAt}>{fmtSaved(r.lastSavedAt)}</span> },
    ],
    createFields: [
      { key: "name", label: "resources.f.name", required: true },
      { key: "type", label: "resources.f.type", type: "select", options: ["local", "git", "volume"] },
      { key: "path", label: "resources.f.localPath", placeholder: "/path/to/repo" },
      { key: "repoUrl", label: "resources.f.repoUrl" },
      { key: "branch", label: "resources.f.branch" },
    ],
    rowActions: (row, reload, t) => (
      <>
        <button
          className="small"
          onClick={async () => {
            await post(`/api/workspaces/${row.id}/save`);
            reload();
          }}
          title={t("resources.a.saveTip")}
        >
          {t("resources.a.save")}
        </button>
        <button className="small danger" onClick={() => removeItem({ path: "/api/workspaces", id: row.id, name: row.name, reload, onError: reportActionError })}>{t("resources.a.delete")}</button>
      </>
    ),
  },
};

/**
 * How `removeItem` asks for confirmation.
 *
 * These row actions are plain functions inside a config object, not components,
 * so they cannot own React state. The view installs an asker once (see
 * ResourceView) rather than each call site reaching for `window.confirm`, whose
 * native dialog both breaks the app's look and blocks the packaged UI checks.
 * Unset = refuse: a delete that cannot ask must not happen.
 */
let askDelete: ((label: string) => Promise<boolean>) | null = null;

let refuseDeleteNoAsker = "Refusing to delete without a confirmation dialog installed";

/**
 * Where a row action reports a failure, installed by the view for the same
 * reason as `askDelete`: these actions are plain functions, not components.
 * Before this existed a failed toggle or delete was an unhandled rejection —
 * the button did nothing and said nothing.
 */
let reportActionError: (message: string) => void = (message) => {
  console.error(message);
};

/**
 * Deletes one row, after asking.
 *
 * `name` is what the question shows: an id identifies the row to the code, not
 * to the person reading "Delete rt_mvven…?". Every failure is reported through
 * `onError` — a delete used to be a bare `await del()`, so a rejected request
 * became an unhandled rejection and the row simply stayed there with nothing
 * said.
 */
async function removeItem(opts: {
  path: string;
  id: string;
  name: string;
  reload: () => void;
  onError: (message: string) => void;
}) {
  const { path, id, name, reload, onError } = opts;
  if (!askDelete) {
    onError(refuseDeleteNoAsker);
    return;
  }
  if (!(await askDelete(name))) return;
  try {
    await del(path + "/" + id);
    reload();
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
  }
}

async function toggleRuntime(row: any, reload: () => void) {
  try {
    await post(`/api/runtimes/${row.id}/${row.enabled ? "disable" : "enable"}`);
    reload();
  } catch (e) {
    reportActionError(e instanceof Error ? e.message : String(e));
  }
}


/**
 * Lightweight harness runtime status (v6 §12, v7 §16): for each enabled
 * harness-native runtime, show CLI installed / authenticated / credential
 * source / execution backend — availability detection only. Sensitive
 * credential material is never displayed or read.
 */
function HarnessStatusCard() {
  const t = useT();
  const runtimes = useAsync<any[]>(() => get("/api/runtimes"), []);
  const kinds = [...new Set(
    (runtimes.data ?? [])
      .filter((r) => r.enabled && ["claude-code", "codex"].includes(r.kind))
      .map((r) => r.kind)
  )];
  return (
    <div className="card">
      <h2>{t("resources.harness.title")}</h2>
      <p className="sub">{t("resources.harness.desc")}</p>
      {kinds.length === 0 ? (
        <div className="muted">{t("resources.harness.none")}</div>
      ) : (
        kinds.map((kind) => <HarnessStatusRow key={kind} kind={kind} runtimes={runtimes.data ?? []} />)
      )}
    </div>
  );
}

function HarnessStatusRow({ kind, runtimes }: { kind: string; runtimes: any[] }) {
  const t = useT();
  const auth = useAsync<any>(() => get(`/api/harness/${kind}/auth-status`), [kind]);
  const runtime = runtimes.find((r) => r.kind === kind && r.enabled);
  const status = auth.data;
  return (
    <div style={{ marginBottom: 12 }}>
      <strong>{runtime?.name ?? kind}</strong>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("resources.harness.installed")}</th><th scope="col">{t("resources.harness.authenticated")}</th>
            <th scope="col">{t("resources.harness.credentialSource")}</th><th scope="col">{t("resources.harness.backend")}</th>
            <th scope="col">{t("resources.harness.detail")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{status ? (status.installed ? "✓" : "✗") : "…"}</td>
            <td>{status ? (status.loggedIn ? "✓" : "✗") : "…"}</td>
            <td>{t("resources.detail.harnessNative")}</td>
            <td>{runtime?.containerized ? "docker" : "local"}</td>
            <td className="muted">
              {status?.detail ?? (auth.error ? auth.error : t("resources.harness.checking"))}
              {status?.version ? ` · ${status.version}` : ""}
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      {status && !status.ok && status.hint && <div className="muted">{status.hint}</div>}
      {auth.error && <div className="muted">{t("resources.harness.authUnavailable", { error: auth.error })}</div>}
    </div>
  );
}

export function ResourceView({ kind }: { kind: string }) {
  const t = useT();
  refuseDeleteNoAsker = t("resources.delete.noAsker");
  const cfg = configs[kind];
  const { data, error, loading, reload } = useAsync<any[]>((force) => get(cfg.path, undefined, force), [cfg.path]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Detail modal holds the row *id*: after an action reloads the list, the
  // modal re-reads the fresh row, so toggles reflect without reopening.
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailRow = data?.find((r) => r.id === detailId);

  // Install the confirmation the row actions ask through; the resolver is held
  // in a ref so the promise survives re-renders of the modal.
  const [deleteLabel, setDeleteLabel] = useState<string | null>(null);
  const deleteResolver = useRef<((ok: boolean) => void) | null>(null);
  // A failed row action is not a load error: the list is fine, one click was
  // not, so the message sits above the table and the list stays readable.
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    askDelete = (label) =>
      new Promise<boolean>((resolve) => {
        deleteResolver.current = resolve;
        setDeleteLabel(label);
      });
    reportActionError = (message) => setActionError(message);
    return () => {
      // A row action awaiting an answer must not hang if the view goes away.
      deleteResolver.current?.(false);
      deleteResolver.current = null;
      askDelete = null;
      reportActionError = (message) => console.error(message);
    };
  }, []);
  const answerDelete = (ok: boolean) => {
    setDeleteLabel(null);
    deleteResolver.current?.(ok);
    deleteResolver.current = null;
  };

  if (!cfg) return <div>{t("resources.unknown", { kind })}</div>;

  const submit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = { ...form };
      if (cfg.path === "/api/runtimes") {
        if (body.command) body.command = String(body.command).split(" ");
        // The form carries strings; every boolean-typed field must be
        // coerced, not just the one someone remembered: the server stores
        // what it is given, and the string "false" is truthy — a runtime
        // would claim containerized isolation it does not have. Unset ("")
        // is dropped so the server's kind default applies.
        for (const key of ["usableInTask", "containerized"]) {
          if (body[key] === "true" || body[key] === "false") {
            body[key] = body[key] === "true";
          } else {
            delete body[key];
          }
        }
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
        <h1>{t(cfg.title)}</h1>
        <span className="right">
          <button className="primary" onClick={() => setShowCreate(true)}>
            {t("resources.add")}
          </button>
        </span>
      </div>
      <p className="sub">{t("resources.subtitle", { name: t(cfg.title) })}</p>
      {actionError && (
        <div className="card action-error" role="alert">
          <span>{t("resources.actionFailed")}</span>
          <span className="mono">{actionError}</span>
          <button className="small" onClick={() => setActionError(null)}>{t("common.close")}</button>
        </div>
      )}

      {showCreate && kind === "runtimes" && (
        <AddRuntimeDialog
          onClose={() => setShowCreate(false)}
          onAdded={() => {
            setShowCreate(false);
            reload();
          }}
        />
      )}
      {/* Other resource kinds keep the inline card: their create forms are a few
          plain fields, and only runtimes had grown into a page of choices. */}
      {showCreate && kind !== "runtimes" && (
        <div className="card">
          <h2>{t("resources.addTitle", { name: t(cfg.titleOne) })}</h2>
          {cfg.createFields.map((f) => (
            <Field key={f.key} label={t(f.label)}>
              {f.type === "select" ? (
                <select value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}>
                  <option value="">{t("resources.select")}</option>
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
          {saveError && <div className="muted" style={{ color: "var(--signal-red)" }}>{saveError}</div>}
          <button className="primary" disabled={saving} onClick={submit}>
            {saving ? t("common.saving") : t("common.create")}
          </button>
        </div>
      )}

      <ErrorBox message={error} />
      <div className="card">
        {data && data.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{cfg.columns.map((c) => <th key={c.key} scope="col">{t(c.label)}</th>)}<th scope="col" className="actions"></th></tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr
                    key={row.id}
                    className={cfg.detail ? "clickable" : undefined}
                    title={cfg.detail ? t("resources.details") : undefined}
                    onClick={cfg.detail ? () => setDetailId(row.id) : undefined}
                  >
                    {cfg.columns.map((c) => <td key={c.key}>{c.render ? c.render(row) : String(row[c.key] ?? "")}</td>)}
                    <td className="actions" onClick={(e) => e.stopPropagation()}>{cfg.rowActions?.(row, reload, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted">{loading ? t("common.loading") : t("resources.empty")}</div>
        )}
      </div>

      {detailRow && cfg.detail && (
        <Modal
          title={cfg.detailTitle ? cfg.detailTitle(detailRow, t) : t("resources.detailsTitle")}
          onClose={() => setDetailId(null)}
        >
          {cfg.detail(detailRow, { reload, close: () => setDetailId(null), t })}
        </Modal>
      )}

      {kind === "runtimes" && <HarnessStatusCard />}

      {deleteLabel && (
        <Modal title={t("resources.delete.title")} onClose={() => answerDelete(false)}>
          <p>{t("resources.delete.question", { name: deleteLabel })}</p>
          <div className="modal-actions">
            <button onClick={() => answerDelete(false)}>{t("common.cancel")}</button>
            <button className="danger" onClick={() => answerDelete(true)}>{t("common.delete")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
