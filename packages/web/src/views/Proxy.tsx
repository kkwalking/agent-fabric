import { useState } from "react";
import { get, post, put } from "../api";
import { useAsync, ErrorBox, Field } from "../components";

type Scheme = "http" | "socks5";

interface ProxyForm {
  enabled: boolean;
  scheme: Scheme;
  host: string;
  port: string;
}

interface ProxyTestResult {
  ok: boolean;
  proxyUrl: string;
  status?: number;
  latencyMs: number;
  error?: string;
}

const DEFAULT_FORM: ProxyForm = { enabled: false, scheme: "http", host: "", port: "" };

/** Parses the port input; null when not a valid port number. */
function parsePort(port: string): number | null {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export function ProxyView() {
  const { data, error } = useAsync<{ proxy?: Partial<ProxyForm> & { port?: number } }>(() => get("/api/config"), []);
  if (error) return <div><h1>Proxy</h1><ErrorBox message={error} /></div>;
  if (!data) return <div><h1>Proxy</h1><div className="muted">Loading…</div></div>;
  const p = data.proxy ?? {};
  return (
    <ProxyFormView
      initial={{
        enabled: Boolean(p.enabled),
        scheme: p.scheme === "socks5" ? "socks5" : "http",
        host: p.host ?? "",
        port: p.port != null ? String(p.port) : "",
      }}
    />
  );
}

function ProxyFormView({ initial }: { initial: ProxyForm }) {
  const [form, setForm] = useState<ProxyForm>(initial);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  const patch = (next: Partial<ProxyForm>) => {
    setForm((f) => ({ ...f, ...next }));
    setSaved(false);
  };

  const save = async () => {
    const host = form.host.trim();
    const port = parsePort(form.port);
    if (form.enabled && (!host || port == null)) {
      setFormError("启用代理时需要填写地址和 1–65535 之间的端口");
      return;
    }
    try {
      await put("/api/config", {
        proxy: {
          enabled: form.enabled,
          scheme: form.scheme,
          host,
          ...(port != null ? { port } : {}),
        },
      });
      setFormError(null);
      setSaved(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const runTest = async () => {
    const host = form.host.trim();
    const port = parsePort(form.port);
    if (!host || port == null) {
      setTestResult({ ok: false, proxyUrl: "", latencyMs: 0, error: "请先填写有效的地址和端口" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await post<ProxyTestResult>("/api/proxy/test", { scheme: form.scheme, host, port }));
    } catch (e) {
      setTestResult({ ok: false, proxyUrl: "", latencyMs: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <h1>Proxy</h1>
      <p className="sub">
        为后续任务启动的 harness 进程注入标准代理环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY）。
        运行中的任务不受影响；关闭开关时不注入任何变量，harness 继承 server 自身的环境。
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        <label className="check">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          启用代理（默认关闭）
        </label>

        <Field label="协议">
          <select value={form.scheme} onChange={(e) => patch({ scheme: e.target.value as Scheme })}>
            <option value="http">http</option>
            <option value="socks5">socks5</option>
          </select>
        </Field>
        <Field label="地址">
          <input
            className="mono"
            value={form.host}
            placeholder="127.0.0.1"
            onChange={(e) => patch({ host: e.target.value })}
          />
        </Field>
        <Field label="端口">
          <input
            className="mono"
            value={form.port}
            placeholder="7890"
            inputMode="numeric"
            onChange={(e) => patch({ port: e.target.value })}
          />
        </Field>

        <div className="row">
          <button className="primary" onClick={save}>保存</button>
          <button onClick={runTest} disabled={testing}>{testing ? "测试中…" : "测试连接"}</button>
          {saved && <span className="muted">saved ✓</span>}
        </div>
        {formError && <div className="muted" style={{ color: "var(--red)" }}>{formError}</div>}
        {testResult && (
          <div className="muted" style={{ color: testResult.ok ? "var(--green)" : "var(--red)" }}>
            {testResult.ok
              ? `✓ 连接成功（HTTP ${testResult.status ?? "?"} · ${testResult.latencyMs}ms）— 经 ${testResult.proxyUrl} 可访问外网`
              : `✗ 连接失败：${testResult.error ?? "未知错误"}`}
          </div>
        )}

        <div className="hint">
          容器化任务会自动把 127.0.0.1 / localhost 改写为 host.docker.internal；
          NO_PROXY 始终包含 localhost, 127.0.0.1, ::1，本地回环流量不走代理。
          测试连接从 server 所在机器发起（与本地 harness 同一网络环境）。
        </div>
      </div>
    </div>
  );
}
