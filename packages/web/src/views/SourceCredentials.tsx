import { useState } from "react";
import { del, get, post } from "../api";
import { ErrorBox, Field, Modal, useAsync } from "../components";
import { useT } from "../i18n-react";

/**
 * Source Credentials (v11 §4) — a section of the settings panel.
 *
 * Global, Project-independent Git credentials. The sensitive value is always a
 * Secret: creating a credential writes the secret in the same step, and
 * afterwards only the masked preview is ever shown — the API never returns the
 * value again (v11 §4.2/§34).
 *
 * These are settings, not project data: a Project only references a credential
 * by id, so the list belongs beside the other global settings rather than in a
 * top-level page of its own.
 */
export function CredentialsSection() {
  const t = useT();
  const credentials = useAsync<any[]>(() => get("/api/source-credentials"), []);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    type: "https-token",
    host: "",
    username: "",
    value: "",
    passphrase: "",
    knownHosts: "",
  });

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await post("/api/source-credentials", {
        name: form.name,
        type: form.type,
        host: form.host || undefined,
        username: form.username || undefined,
        value: form.value,
        passphrase: form.type === "ssh-key" ? form.passphrase || undefined : undefined,
        knownHosts: form.type === "ssh-key" ? form.knownHosts || undefined : undefined,
      });
      setAdding(false);
      setForm({ name: "", type: "https-token", host: "", username: "", value: "", passphrase: "", knownHosts: "" });
      credentials.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Deleting a credential discards a stored token or key — the API never returns
   * the value again, so "removed by accident" means re-issuing the secret at the
   * provider. Ask first, the way every other destructive action in the app does.
   */
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);

  const remove = async (id: string) => {
    setError(null);
    try {
      await del(`/api/source-credentials/${id}`);
      credentials.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="right">
          <button className="small" onClick={() => credentials.reload()}>{t("common.refresh")}</button>{" "}
          <button className="small primary" onClick={() => setAdding(true)}>{t("credentials.add")}</button>
        </span>
      </div>
      <ErrorBox message={error} />

      {(credentials.data ?? []).length === 0 ? (
        <div className="card muted">{t("credentials.empty")}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("credentials.col.name")}</th><th>{t("credentials.col.type")}</th>
                <th>{t("credentials.col.host")}</th><th>{t("credentials.col.username")}</th>
                <th>{t("credentials.col.secret")}</th><th />
              </tr>
            </thead>
            <tbody>
              {(credentials.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.type}</td>
                  <td className="muted">{c.host ?? "-"}</td>
                  <td className="muted">{c.username ?? "-"}</td>
                  <td className="muted">{c.secretMasked ?? "-"}</td>
                  <td className="actions">
                    <button className="small danger" onClick={() => setPendingRemove({ id: c.id, name: c.name })}>
                      {t("credentials.removeRow")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <Modal title={t("credentials.addTitle")} onClose={() => setAdding(false)}>
          <div className="form-grid-2">
            <Field label={t("credentials.f.name")}>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("credentials.f.namePh")} />
            </Field>
            <Field label={t("credentials.f.type")}>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="https-token">{t("credentials.type.token")}</option>
                <option value="ssh-key">{t("credentials.type.ssh")}</option>
              </select>
            </Field>
            <Field label={t("credentials.f.host")}>
              <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="github.com" />
            </Field>
            <Field label={t("credentials.f.username")}>
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder={form.type === "ssh-key" ? "git" : "x-access-token"}
              />
            </Field>
          </div>
          <Field label={form.type === "ssh-key" ? t("credentials.f.valueSsh") : t("credentials.f.valueToken")}>
            <textarea
              rows={form.type === "ssh-key" ? 6 : 2}
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              placeholder={form.type === "ssh-key" ? "-----BEGIN OPENSSH PRIVATE KEY-----" : "ghp_…"}
            />
          </Field>
          {form.type === "ssh-key" && (
            <>
              <Field label={t("credentials.f.passphrase")}>
                <input type="password" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} />
              </Field>
              <Field label={t("credentials.f.knownHosts")}>
                <textarea rows={2} value={form.knownHosts} onChange={(e) => setForm({ ...form, knownHosts: e.target.value })} />
              </Field>
            </>
          )}
          <p className="muted">{t("credentials.createNote")}</p>
          <div className="modal-actions">
            <button onClick={() => setAdding(false)}>{t("common.cancel")}</button>
            <button className="primary" disabled={busy || !form.name || !form.value} onClick={create}>{t("common.create")}</button>
          </div>
        </Modal>
      )}
      {pendingRemove && (
        <Modal title={t("credentials.remove")} onClose={() => setPendingRemove(null)}>
          <p>{t("credentials.removeQuestion", { name: pendingRemove.name })}</p>
          <div className="row-end">
            <button onClick={() => setPendingRemove(null)}>{t("common.cancel")}</button>
            <button
              className="danger"
              onClick={() => {
                const target = pendingRemove;
                setPendingRemove(null);
                void remove(target.id);
              }}
            >
              {t("credentials.remove")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
