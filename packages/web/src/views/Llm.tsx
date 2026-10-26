import { useEffect, useRef, useState } from "react";
import { del, get, post, put } from "../api";
import { useAsync, clickableRow, ErrorBox, Icon, Modal } from "../components";
import { useT } from "../i18n-react";

interface ProviderRow {
  id: string;
  name: string;
  type?: string;
  remark?: string;
  website?: string;
  baseUrl?: string;
  apiKeyMasked?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

interface ModelRow {
  id: string;
  providerId: string;
  name: string;
  alias?: string;
  parameters?: Record<string, unknown>;
  enabled: boolean;
}

/** 接口格式选项（value 为后端 ProviderType）。 */
const API_FORMATS: Array<{ value: string; label: string }> = [
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "openai", label: "OpenAI（旧）" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "自定义" },
];

const formatLabel = (value?: string) => API_FORMATS.find((f) => f.value === value)?.label ?? value ?? "-";

/* ------------------------------------------------------------------ */
/* LLM：供应商列表 + 编辑页                                            */
/* ------------------------------------------------------------------ */

/**
 * Providers and their models, as a section of the settings panel.
 *
 * It is the panel's page rather than a view of its own because it edits a
 * section of the same configuration file the other pages edit (`providers`),
 * and because the file is the record: the server rewrites that section on
 * every save here, so `Open configuration file` shows exactly what this page
 * holds. `embedded` only drops the page-level frame the panel provides; the
 * list and the editor are the same components either way.
 */
export function LlmView({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const providers = useAsync<ProviderRow[]>(() => get("/api/providers"), []);
  const models = useAsync<ModelRow[]>(() => get("/api/models"), []);
  // null = 列表页；"new" = 新增；否则为正在编辑的 provider id
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadAll = () => {
    providers.reload();
    models.reload();
  };

  // Deleting a provider takes its models with it, so it asks first. Rendered as
  // the app's own Modal, not window.confirm: the native dialog is the one place
  // the UI breaks its own look, and it blocks the page, which puts it out of
  // reach of the packaged UI checks.
  const [pendingProviderDelete, setPendingProviderDelete] = useState<ProviderRow | null>(null);

  const removeProvider = async (p: ProviderRow) => {
    try {
      await del(`/api/providers/${p.id}`);
      reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleProvider = async (p: ProviderRow) => {
    try {
      await post(`/api/providers/${p.id}/${p.enabled ? "disable" : "enable"}`);
      reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (editing) {
    return (
      <ProviderEditor
        providerId={editing === "new" ? undefined : editing}
        onBack={() => {
          setEditing(null);
          reloadAll();
        }}
        onOpened={(id) => setEditing(id)}
      />
    );
  }

  return (
    <div>
      <div className={embedded ? "row settings-llm-head" : "row"}>
        {!embedded && <h1>{t("llm.title")}</h1>}
        <span className="right">
          <button className="primary" onClick={() => setEditing("new")}>{t("llm.addProvider")}</button>
        </span>
      </div>
      {!embedded && (
        <p className="sub">{t("llm.subtitle")}</p>
      )}
      <ErrorBox message={error} />

      {(providers.data ?? []).length === 0 ? (
        <div className="card muted">{providers.loading ? t("common.loading") : t("llm.empty")}</div>
      ) : (
        (providers.data ?? []).map((p) => {
          const modelCount = (models.data ?? []).filter((m) => m.providerId === p.id).length;
          return (
            <div className="card provider-card" key={p.id}>
              <div className="row">
                <div className="grow provider-summary" {...clickableRow(() => setEditing(p.id))}>
                  <div className="provider-name">
                    {p.name}
                    <span className="badge">{formatLabel(p.type)}</span>
                    <span className="badge">{t("llm.models.count", { n: modelCount })}</span>
                    {!p.enabled && <span className="badge cancelled">{t("llm.disabled")}</span>}
                  </div>
                  <div className="muted provider-meta">
                    {p.baseUrl ? <span className="mono">{p.baseUrl}</span> : <span>{t("llm.noBaseUrl")}</span>}
                    {p.apiKeyMasked ? <span> · Key <span className="mono">{p.apiKeyMasked}</span></span> : <span> · {t("llm.noApiKey")}</span>}
                    {p.remark ? <span> · {p.remark}</span> : null}
                  </div>
                </div>
                <button className="small" onClick={() => setEditing(p.id)}>{t("llm.edit")}</button>
                <button className="small" onClick={() => toggleProvider(p)}>{p.enabled ? t("llm.disable") : t("llm.enable")}</button>
                <button className="small danger" onClick={() => setPendingProviderDelete(p)}>{t("llm.delete")}</button>
              </div>
            </div>
          );
        })
      )}
      <ErrorBox message={providers.error} />
      {pendingProviderDelete && (
        <Modal title={t("llm.delete.title")} onClose={() => setPendingProviderDelete(null)}>
          <p>{t("llm.delete.question", { name: pendingProviderDelete.name })}</p>
          <p className="muted">{t("llm.delete.body")}</p>
          <div className="modal-actions">
            <button onClick={() => setPendingProviderDelete(null)}>{t("common.cancel")}</button>
            <button
              className="danger"
              onClick={() => {
                const target = pendingProviderDelete;
                setPendingProviderDelete(null);
                void removeProvider(target);
              }}
            >
              {t("llm.delete")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 编辑供应商（含模型配置区）                                          */
/* ------------------------------------------------------------------ */

function ProviderEditor({
  providerId,
  onBack,
  onOpened,
}: {
  providerId?: string;
  onBack: () => void;
  /** 新建保存成功后回调，父级据此记录新 provider id。 */
  onOpened: (id: string) => void;
}) {
  const t = useT();
  const isNew = !providerId;
  const existing = useAsync<ProviderRow | null>(
    () => (providerId ? get<ProviderRow>(`/api/providers/${providerId}`) : Promise.resolve(null)),
    [providerId]
  );
  const [form, setForm] = useState({
    name: "",
    remark: "",
    website: "",
    type: "openai-responses",
    baseUrl: "",
    apiKey: "",
    headers: "",
  });
  const [showKey, setShowKey] = useState(false);
  /** 输入框里的 Key 是否为刚取回的已保存 Key（隐藏时清空，恢复「留空则不修改」）。 */
  const [revealedSavedKey, setRevealedSavedKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);
  /** 新建保存成功后的 provider id；此后展示模型配置区。 */
  const [createdId, setCreatedId] = useState<string | undefined>(undefined);
  const hydratedFor = useRef<string | null>(null);

  const effectiveId = providerId ?? createdId;

  useEffect(() => {
    const p = existing.data;
    if (p && hydratedFor.current !== p.id) {
      hydratedFor.current = p.id;
      setForm({
        name: p.name ?? "",
        remark: p.remark ?? "",
        website: p.website ?? "",
        type: p.type ?? "openai-responses",
        baseUrl: p.baseUrl ?? "",
        apiKey: "",
        headers: p.headers && Object.keys(p.headers).length > 0 ? JSON.stringify(p.headers, null, 2) : "",
      });
    }
  }, [existing.data]);

  const setField = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setSavedMsg(false);
  };

  /** 手动编辑 API Key 时不再视为「取回的已保存 Key」。 */
  const setApiKey = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, apiKey: e.target.value }));
    setRevealedSavedKey(false);
    setSavedMsg(false);
  };

  /** 眼睛按钮：输入中的 Key 直接切换明文；已保存的 Key 向后端取回后明文显示。 */
  const toggleShowKey = async () => {
    if (showKey) {
      setShowKey(false);
      if (revealedSavedKey) {
        setRevealedSavedKey(false);
        setForm((f) => ({ ...f, apiKey: "" }));
      }
      return;
    }
    if (form.apiKey) {
      setShowKey(true);
      return;
    }
    if (!effectiveId || !existing.data?.apiKeyMasked) return;
    try {
      setError(null);
      // 已保存的 Key 属于敏感内容：服务端只认显式确认头（X-AgentFabric-Reveal: 1）才回传。
      const d = await get<{ apiKey?: string }>(`/api/providers/${effectiveId}/api-key`, {
        "X-AgentFabric-Reveal": "1",
      });
      if (d.apiKey) {
        setForm((f) => ({ ...f, apiKey: d.apiKey! }));
        setRevealedSavedKey(true);
        setShowKey(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError(t("llm.saveNameRequired"));
      return;
    }
    let headers: Record<string, string> | undefined;
    if (form.headers.trim()) {
      try {
        const parsed = JSON.parse(form.headers) as Record<string, unknown>;
        headers = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v)])
        );
      } catch {
        setError(t("llm.saveHeadersInvalid"));
        return;
      }
    }
    setSaving(true);
    setError(null);
    setSavedMsg(false);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        type: form.type,
        remark: form.remark,
        website: form.website,
        baseUrl: form.baseUrl,
        headers,
      };
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      if (providerId) {
        await put(`/api/providers/${providerId}`, body);
      } else {
        const created = await post<ProviderRow>("/api/providers", body);
        setCreatedId(created.id);
        onOpened(created.id);
      }
      setForm((f) => ({ ...f, apiKey: "" }));
      setSavedMsg(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* 吸顶头：保存与结果反馈都在这一条上，滚到页面任何位置都可见。 */}
      <div className="editor-head">
        <div className="editor-head-bar">
          <button className="back-btn" onClick={onBack} title={t("llm.editor.back")}>
            <Icon name="arrowLeft" size={17} />
          </button>
          <h1>{isNew ? t("llm.editor.new") : t("llm.editor.edit")}</h1>
          <span className="right">
            {savedMsg && <span className="muted">{t("common.saved")}</span>}
            <button className="primary" disabled={saving} onClick={save}>{saving ? t("common.saving") : t("common.save")}</button>
          </span>
        </div>
        <ErrorBox message={error} />
      </div>

      <div className="card">
        <div className="form-grid-2">
          <label>
            {t("llm.f.name")}
            <input value={form.name} onChange={setField("name")} placeholder={t("llm.f.namePh")} />
          </label>
          <label>
            {t("llm.f.remark")}
            <input value={form.remark} onChange={setField("remark")} placeholder={t("llm.f.remarkPh")} />
          </label>
        </div>
        <label>
          {t("llm.f.website")}
          <input value={form.website} onChange={setField("website")} placeholder={t("llm.f.websitePh")} />
        </label>
        <label>
          {t("llm.f.format")}
          <select value={form.type} onChange={setField("type")}>
            {API_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <div className="hint">{t("llm.f.formatHint")}</div>
        </label>
        <label>
          {t("llm.f.apiKey")}
          <span className="key-wrap">
            <input
              type={showKey ? "text" : "password"}
              value={form.apiKey}
              onChange={setApiKey}
              placeholder={
                existing.data?.apiKeyMasked
                  ? t("llm.f.apiKeySaved", { masked: existing.data.apiKeyMasked })
                  : "sk-…"
              }
              autoComplete="new-password"
            />
            {(form.apiKey || existing.data?.apiKeyMasked) && (
              <button
                type="button"
                className="eye"
                onClick={() => void toggleShowKey()}
                title={showKey ? t("llm.hide") : t("llm.show")}
              >
                <Icon name={showKey ? "eyeOff" : "eye"} size={16} />
              </button>
            )}
          </span>
        </label>
        <label>
          {t("llm.f.baseUrl")}
          <input className="mono" value={form.baseUrl} onChange={setField("baseUrl")} placeholder="https://api.example.com/v1" />
          <div className="hint">{t("llm.f.baseUrlHint")}</div>
        </label>
        <label>
          {t("llm.f.headers")}
          <textarea
            className="mono"
            rows={3}
            value={form.headers}
            onChange={(e) => {
              setForm((f) => ({ ...f, headers: e.target.value }));
              setSavedMsg(false);
            }}
            placeholder={t("llm.f.headersPh")}
          />
          <div className="hint">{t("llm.f.headersHint")}</div>
        </label>
      </div>

      {effectiveId ? (
        <ModelConfig providerId={effectiveId} />
      ) : (
        <div className="card muted">{t("llm.saveProviderFirst")}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 模型配置（供应商内联编辑，参照模型配置列表）                        */
/* ------------------------------------------------------------------ */

interface EditableModel {
  key: string;
  /** 已保存的模型 id；undefined 表示尚未保存的新行。 */
  modelId?: string;
  name: string;
  alias: string;
  parametersText: string;
  enabled: boolean;
  dirty: boolean;
}

function ModelConfig({ providerId }: { providerId: string }) {
  const t = useT();
  const { data } = useAsync<ModelRow[]>(() => get("/api/models"), [providerId]);
  const [rows, setRowsState] = useState<EditableModel[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // rows 的镜像 ref：保存时读最新值，避免 onBlur 等闭包拿到旧状态。
  const rowsRef = useRef<EditableModel[]>([]);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // 卸载时清掉所有未触发的防抖保存定时器：否则切换页面后它们仍会
  // 触发，对已卸载组件 setState（React 告警），且保存语义不明确。
  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      for (const timer of Object.values(timers)) clearTimeout(timer);
    };
  }, []);

  const setRows = (updater: (rs: EditableModel[]) => EditableModel[]) => {
    setRowsState((rs) => {
      const next = updater(rs ?? []);
      rowsRef.current = next;
      return next;
    });
  };

  // 仅在初次加载时以服务端数据初始化行；此后以本地编辑为准（自动保存）。
  useEffect(() => {
    if (!data || rows) return;
    setRowsState(
      data
        .filter((m) => m.providerId === providerId)
        .map((m) => ({
          key: m.id,
          modelId: m.id,
          name: m.name,
          alias: m.alias ?? "",
          parametersText:
            m.parameters && Object.keys(m.parameters).length > 0 ? JSON.stringify(m.parameters, null, 2) : "",
          enabled: m.enabled,
          dirty: false,
        }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, providerId]);

  /** 更新一行并安排防抖自动保存（输入停顿 800ms 后）。 */
  const patchRow = (key: string, patch: Partial<EditableModel>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, dirty: true } : r)));
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => void saveByKey(key), 800);
  };

  const addRow = () =>
    setRows((rs) => [
      ...rs,
      {
        key: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: "",
        alias: "",
        parametersText: "",
        enabled: true,
        dirty: false,
      },
    ]);

  const saveByKey = async (key: string) => {
    clearTimeout(saveTimers.current[key]);
    const row = rowsRef.current.find((r) => r.key === key);
    if (!row || !row.dirty) return;
    if (!row.name.trim()) {
      if (!row.modelId) return; // 新行还没填模型 ID，等填了再保存
      setError(t("llm.models.idRequired"));
      return;
    }
    let parameters: Record<string, unknown> | undefined;
    if (row.parametersText.trim()) {
      try {
        parameters = JSON.parse(row.parametersText);
      } catch {
        setError(t("llm.models.paramsInvalid", { name: row.name }));
        return;
      }
    }
    try {
      setError(null);
      const body = {
        name: row.name.trim(),
        alias: row.alias.trim() || undefined,
        parameters,
        enabled: row.enabled,
      };
      if (row.modelId) {
        await put(`/api/models/${row.modelId}`, body);
      } else {
        const created = await post<ModelRow>("/api/models", { ...body, providerId });
        setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, key: created.id, modelId: created.id, dirty: false } : r)));
        return;
      }
      setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, dirty: false } : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Same reasoning as the provider delete: a saved model asks through the app's
  // Modal; a row that was never saved is only local state and just goes away.
  const [pendingModelDelete, setPendingModelDelete] = useState<EditableModel | null>(null);

  const removeRow = async (row: EditableModel) => {
    if (!row.modelId) {
      clearTimeout(saveTimers.current[row.key]);
      setRows((rs) => rs.filter((r) => r.key !== row.key));
      return;
    }
    setPendingModelDelete(row);
  };

  const confirmModelDelete = async () => {
    const row = pendingModelDelete;
    setPendingModelDelete(null);
    if (!row?.modelId) return;
    clearTimeout(saveTimers.current[row.key]);
    try {
      await del(`/api/models/${row.modelId}`);
      setRows((rs) => rs.filter((r) => r.key !== row.key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleEnabled = (row: EditableModel, enabled: boolean) => {
    patchRow(row.key, { enabled });
    void saveByKey(row.key);
  };

  const saveByKeyAndMark = (key: string) => void saveByKey(key);

  return (
    <div className="card">
      <div className="section-head">
        <strong>{t("llm.models.title")}</strong>
        <span className="right">
          <button className="small" onClick={addRow}><Icon name="plus" size={13} /> {t("llm.models.add")}</button>
        </span>
      </div>

      {rows === null ? (
        <div className="muted">{t("common.loading")}</div>
      ) : (
        <>
          {rows.length > 0 && (
            <div className="model-grid model-grid-head">
              <span />
              <span>{t("llm.models.col.id")}</span>
              <span>{t("llm.models.col.displayName")}</span>
              <span />
            </div>
          )}
          <div className="model-list">
            {rows.map((row) => (
              <div className="model-item" key={row.key}>
                <div className="model-grid model-row">
                  <button
                    className={`chev ${expanded[row.key] ? "open" : ""}`}
                    onClick={() => setExpanded((e) => ({ ...e, [row.key]: !e[row.key] }))}
                    title={t("llm.models.more")}
                  >
                    <Icon name="chevron" size={14} />
                  </button>
                  <input
                    className="mono"
                    value={row.name}
                    placeholder={t("llm.models.idPh")}
                    onChange={(e) => patchRow(row.key, { name: e.target.value })}
                    onBlur={() => saveByKeyAndMark(row.key)}
                  />
                  <input
                    value={row.alias}
                    placeholder={t("llm.models.col.displayName")}
                    onChange={(e) => patchRow(row.key, { alias: e.target.value })}
                    onBlur={() => saveByKeyAndMark(row.key)}
                  />
                  <button className="trash" onClick={() => removeRow(row)} title={t("llm.models.delete")}>
                    <Icon name="trash" size={15} />
                  </button>
                </div>
                {expanded[row.key] && (
                  <div className="model-detail">
                    <label>
                      {t("llm.models.params")}
                      <textarea
                        className="mono"
                        rows={3}
                        value={row.parametersText}
                        placeholder='{"temperature": 0.7}'
                        onChange={(e) => patchRow(row.key, { parametersText: e.target.value })}
                        onBlur={() => saveByKeyAndMark(row.key)}
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(e) => toggleEnabled(row, e.target.checked)}
                      />
                      {t("llm.models.enabled")}
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>
          {rows.length === 0 && (
            <div className="muted">{t("llm.models.empty")}</div>
          )}
          <div className="hint">{t("llm.models.hint")}</div>
        </>
      )}
      <ErrorBox message={error} />
      {pendingModelDelete && (
        <Modal title={t("llm.models.delete.title")} onClose={() => setPendingModelDelete(null)}>
          <p>{t("llm.models.delete.question", { name: pendingModelDelete.name })}</p>
          <p className="muted">{t("llm.models.delete.body")}</p>
          <div className="modal-actions">
            <button onClick={() => setPendingModelDelete(null)}>{t("common.cancel")}</button>
            <button className="danger" onClick={() => void confirmModelDelete()}>
              {t("common.delete")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
