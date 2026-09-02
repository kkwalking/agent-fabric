import { useState } from "react";
import { get, put } from "../api";
import { useAsync, ErrorBox, Field } from "../components";

export function SettingsView() {
  const { data, error, reload } = useAsync<any>(() => get("/api/config"), []);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    if (text == null) return;
    try {
      await put("/api/config", JSON.parse(text));
      setSaved(true);
      reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <h1>Settings</h1>
      <p className="sub">AgentFabric configuration (server, docker, opencode, pi).</p>
      <ErrorBox message={error} />
      {data && (
        <div className="card">
          <h2>Config (JSON)</h2>
          <textarea
            rows={14}
            value={text ?? JSON.stringify(data, null, 2)}
            onChange={(e) => { setText(e.target.value); setSaved(false); }}
          />
          <div className="row">
            <button className="primary" onClick={save} disabled={text == null}>save</button>
            {saved && <span className="muted">saved ✓</span>}
          </div>
        </div>
      )}
      <div className="card">
        <h2>Environment</h2>
        <table>
          <tbody>
            <tr><td className="mono">AGENTFABRIC_API</td><td className="muted">API base URL used by the CLI</td></tr>
            <tr><td className="mono">AGENTFABRIC_DATA_DIR</td><td className="muted">persistent data directory (db.json)</td></tr>
            <tr><td className="mono">AGENTFABRIC_OPENCODE_BIN</td><td className="muted">opencode CLI path override</td></tr>
            <tr><td className="mono">AGENTFABRIC_PI_BIN</td><td className="muted">pi CLI path override</td></tr>
            <tr><td className="mono">AGENTFABRIC_DOCKER_BIN</td><td className="muted">docker CLI path override</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
