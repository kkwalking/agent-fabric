import { useState } from "react";
import { get, post } from "../api";
import { useAsync, ErrorBox, Icon } from "../components";
import { navigate } from "../router";

/**
 * New Task (v5 §14): the user describes a Task, not a Run. Submitting
 * creates the Task + Run #1 and lands on the Task Thread — never on the
 * Run Detail page.
 */
export function NewTaskView() {
  const runtimes = useAsync<any[]>(() => get("/api/runtimes"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);
  const profiles = useAsync<any[]>(() => get("/api/agents"), []);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [runtimeId, setRuntimeId] = useState("");
  const [modelId, setModelId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<any>("/api/runs", {
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        runtimeId: runtimeId || undefined,
        modelId: modelId || undefined,
        workspaceId: workspaceId || undefined,
        profileId: profileId || undefined,
        lifecycle: lifecycle ? { mode: lifecycle } : undefined,
      });
      // Create Task → Create Run #1 → Task Thread (v5 §14).
      navigate(`/tasks/${r.task.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="new-task">
      <h1>New task</h1>
      <p className="sub">
        Describe what the agent should work on. One task, many runs — you stay in the same thread while the
        system executes each step.
      </p>
      <ErrorBox message={error} />

      <div className="composer new-task-composer">
        <textarea
          rows={5}
          autoFocus
          placeholder="Describe the task, e.g. 介绍一下当前项目"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <input
          placeholder="Task title (optional — defaults to the first line of the prompt)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="composer-bar">
          <select className="pill" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)} title="Runtime">
            <option value="">Runtime: default</option>
            {(runtimes.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>Runtime: {r.name} ({r.kind})</option>
            ))}
          </select>
          <select className="pill" value={modelId} onChange={(e) => setModelId(e.target.value)} title="Model">
            <option value="">Model: default</option>
            {(models.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>Model: {m.alias ?? m.name}</option>
            ))}
          </select>
          <select className="pill" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} title="Workspace">
            <option value="">Workspace: none</option>
            {(workspaces.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>Workspace: {w.name}</option>
            ))}
          </select>
          <select className="pill" value={profileId} onChange={(e) => setProfileId(e.target.value)} title="Agent profile">
            <option value="">Agent: none</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>Agent: {p.name}</option>
            ))}
          </select>
          <select className="pill" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)} title="Container lifecycle">
            <option value="">Lifecycle: runtime default</option>
            <option value="ephemeral">Lifecycle: ephemeral</option>
            <option value="keep-alive">Lifecycle: keep-alive</option>
            <option value="persistent">Lifecycle: persistent</option>
          </select>
          <button
            className="send"
            title="Create task (⌘↵)"
            disabled={busy || !prompt.trim()}
            onClick={submit}
          >
            {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
