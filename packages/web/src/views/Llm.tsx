import { useEffect, useRef, useState } from "react";
import { del, get, post, put } from "../api";
import { useAsync, ErrorBox, Icon } from "../components";

interface ProviderRow {
  id: string;
  name: string;
  type?: string;
  remark?: string;
  website?: string;
  baseUrl?: string;
  apiKeyMasked?: string;
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

export function LlmView() {
  const providers = useAsync<ProviderRow[]>(() => get("/api/providers"), []);
  const models = useAsync<ModelRow[]>(() => get("/api/models"), []);
  // null = 列表页；"new" = 新增；否则为正在编辑的 provider id
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadAll = () => {
    providers.reload();
    models.reload();
  };

  const removeProvider = async (p: ProviderRow) => {
    if (!confirm(`删除供应商「${p.name}」？其模型列表会一并删除。`)) return;
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
      <div className="row">
        <h1>LLM</h1>
        <span className="right">
          <button className="primary" onClick={() => setEditing("new")}>+ 新增供应商</button>
        </span>
      </div>
      <p className="sub">统一配置模型供应商：在供应商内维护接口格式、API Key、Base URL 以及可用的模型列表。</p>
      <ErrorBox message={error} />

      {(providers.data ?? []).length === 0 ? (
        <div className="card muted">{providers.loading ? "Loading…" : "还没有供应商，点击右上角「新增供应商」创建。"}</div>
      ) : (
        (providers.data ?? []).map((p) => {
          const modelCount = (models.data ?? []).filter((m) => m.providerId === p.id).length;
          return (
            <div className="card provider-card" key={p.id}>
              <div className="row">
                <div className="grow provider-summary" onClick={() => setEditing(p.id)}>
                  <div className="provider-name">
                    {p.name}
                    <span className="badge">{formatLabel(p.type)}</span>
                    <span className="badge">{modelCount} 个模型</span>
                    {!p.enabled && <span className="badge cancelled">已停用</span>}
                  </div>
                  <div className="muted provider-meta">
                    {p.baseUrl ? <span className="mono">{p.baseUrl}</span> : <span>未配置 Base URL</span>}
                    {p.apiKeyMasked ? <span> · Key <span className="mono">{p.apiKeyMasked}</span></span> : <span> · 未配置 API Key</span>}
                    {p.remark ? <span> · {p.remark}</span> : null}
                  </div>
                </div>
                <button className="small" onClick={() => setEditing(p.id)}>编辑</button>
                <button className="small" onClick={() => toggleProvider(p)}>{p.enabled ? "停用" : "启用"}</button>
                <button className="small danger" onClick={() => removeProvider(p)}>删除</button>
              </div>
            </div>
          );
        })
      )}
      <ErrorBox message={providers.error} />
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
  });
  const [showKey, setShowKey] = useState(false);
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
      });
    }
  }, [existing.data]);

  const setField = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setSavedMsg(false);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("请填写供应商名称");
      return;
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
      <div className="editor-head">
        <button className="back-btn" onClick={onBack} title="返回列表">
          <Icon name="arrowLeft" size={17} />
        </button>
        <h1>{isNew ? "新增供应商" : "编辑供应商"}</h1>
      </div>

      <div className="card">
        <div className="form-grid-2">
          <label>
            供应商名称
            <input value={form.name} onChange={setField("name")} placeholder="例如：OpenAI、魔力方舟" />
          </label>
          <label>
            备注
            <input value={form.remark} onChange={setField("remark")} placeholder="可选" />
          </label>
        </div>
        <label>
          官网链接
          <input value={form.website} onChange={setField("website")} placeholder="https://example.com（可选）" />
        </label>
        <label>
          接口格式
          <select value={form.type} onChange={setField("type")}>
            {API_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <div className="hint">选择 AI 服务的 API 接口格式</div>
        </label>
        <label>
          API Key
          <span className="key-wrap">
            <input
              type={showKey ? "text" : "password"}
              value={form.apiKey}
              onChange={setField("apiKey")}
              placeholder={
                existing.data?.apiKeyMasked ? `已保存 ${existing.data.apiKeyMasked}，留空则不修改` : "sk-…"
              }
              autoComplete="new-password"
            />
            <button
              type="button"
              className="eye"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? "隐藏" : "显示"}
            >
              <Icon name={showKey ? "eyeOff" : "eye"} size={16} />
            </button>
          </span>
        </label>
        <label>
          Base URL
          <input className="mono" value={form.baseUrl} onChange={setField("baseUrl")} placeholder="https://api.example.com/v1" />
          <div className="hint">自定义 API 端点地址</div>
        </label>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="primary" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存"}</button>
          {savedMsg && <span className="muted">已保存 ✓</span>}
        </div>
        <ErrorBox message={error} />
      </div>

      {effectiveId ? (
        <ModelConfig providerId={effectiveId} />
      ) : (
        <div className="card muted">保存供应商后即可配置模型列表。</div>
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
  const { data } = useAsync<ModelRow[]>(() => get("/api/models"), [providerId]);
  const [rows, setRowsState] = useState<EditableModel[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // rows 的镜像 ref：保存时读最新值，避免 onBlur 等闭包拿到旧状态。
  const rowsRef = useRef<EditableModel[]>([]);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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
      setError("模型 ID 不能为空");
      return;
    }
    let parameters: Record<string, unknown> | undefined;
    if (row.parametersText.trim()) {
      try {
        parameters = JSON.parse(row.parametersText);
      } catch {
        setError(`模型 ${row.name} 的参数不是合法 JSON，未保存`);
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

  const removeRow = async (row: EditableModel) => {
    if (row.modelId && !confirm(`删除模型「${row.name}」？`)) return;
    clearTimeout(saveTimers.current[row.key]);
    try {
      if (row.modelId) await del(`/api/models/${row.modelId}`);
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
        <strong>模型配置</strong>
        <span className="right">
          <button className="small" onClick={addRow}><Icon name="plus" size={13} /> 添加模型</button>
        </span>
      </div>

      {rows === null ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          {rows.length > 0 && (
            <div className="model-grid model-grid-head">
              <span />
              <span>模型 ID</span>
              <span>显示名称</span>
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
                    title="更多设置"
                  >
                    <Icon name="chevron" size={14} />
                  </button>
                  <input
                    className="mono"
                    value={row.name}
                    placeholder="例如 gpt-4o"
                    onChange={(e) => patchRow(row.key, { name: e.target.value })}
                    onBlur={() => saveByKeyAndMark(row.key)}
                  />
                  <input
                    value={row.alias}
                    placeholder="显示名称"
                    onChange={(e) => patchRow(row.key, { alias: e.target.value })}
                    onBlur={() => saveByKeyAndMark(row.key)}
                  />
                  <button className="trash" onClick={() => removeRow(row)} title="删除模型">
                    <Icon name="trash" size={15} />
                  </button>
                </div>
                {expanded[row.key] && (
                  <div className="model-detail">
                    <label>
                      参数（JSON）
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
                      启用该模型
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>
          {rows.length === 0 && (
            <div className="muted">暂无模型，点击右上角「添加模型」手动添加。</div>
          )}
          <div className="hint">配置可用的模型及其显示名称；编辑后自动保存。</div>
        </>
      )}
      <ErrorBox message={error} />
    </div>
  );
}
