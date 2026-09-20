import { useState } from "react";
import { get, post } from "../api";
import { ErrorBox, Icon, useAsync } from "../components";
import { HARNESS_NATIVE_KINDS, HARNESS_THREAD_SOURCES } from "../harness";
import { modelOptionLabel } from "../presentation";
import { navigate } from "../router";

/**
 * New Task (v5 §14): the user describes a Task, not a Run. Submitting
 * creates the Task + Run #1 and lands on the Task Thread — never on the
 * Run Detail page.
 *
 * Every selector shows a concrete, visible default instead of a "default"
 * pseudo-option: runtime → built-in Pi Agent, model → first model of the
 * first configured provider, workspace → first configured workspace. A
 * missing prerequisite (no LLM, no workspace) blocks submission with a
 * pointer to the right settings tab — except for harness-native runtimes
 * (Codex + ChatGPT, Claude Code + Claude.ai — v6 §3/v7 §3), which need
 * neither a provider nor a model.
 *
 * Discovery of work that started outside AgentFabric lives on its own page
 * (/sessions, v6 §6/§11, v7 §9/§11): this page is where a task is
 * described; that one is where existing local harness sessions are found
 * and adopted.
 */

export function NewTaskView() {
  // The composer's runtime list is served, not derived: `?usableInTask=true`
  // returns the enabled runtimes the product allows to execute a task.
  // Submit enforces the same rule server-side.
  const runtimes = useAsync<any[]>(() => get("/api/runtimes?usableInTask=true"), []);
  const providers = useAsync<any[]>(() => get("/api/providers"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);
  const profiles = useAsync<any[]>(() => get("/api/agents"), []);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [runtimeChoice, setRuntimeChoice] = useState("");
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [modelChoice, setModelChoice] = useState("");
  const [modelTouched, setModelTouched] = useState(false);
  const [workspaceChoice, setWorkspaceChoice] = useState("");
  const [profileId, setProfileId] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runtimeList = runtimes.data ?? [];
  // Only runtimes that may execute a task are offered (`usableInTask`):
  // discovery-only kinds (zcode, dsh) never start a task, they are adopted
  // from the Sessions page.
  const selectableRuntimes = runtimeList.filter((r: any) => r.enabled && r.usableInTask);
  const modelList = models.data ?? [];
  const workspaceList = workspaces.data ?? [];
  const providerList = providers.data ?? [];
  const profile = (profiles.data ?? []).find((p: any) => p.id === profileId);
  const inList = (list: any[], id?: string) => Boolean(id && list.some((x) => x.id === id));

  // Visible defaults — the submitted ids are always the concrete values on
  // screen. Choosing an Agent profile visibly re-resolves the fields the
  // user has not touched.
  const builtinPi = selectableRuntimes.find((r: any) => r.kind === "pi");
  const effectiveRuntimeId = runtimeTouched
    ? runtimeChoice
    : inList(selectableRuntimes, profile?.runtimeId)
      ? profile.runtimeId
      : builtinPi?.id ?? selectableRuntimes[0]?.id ?? "";
  const effectiveRuntime = runtimeList.find((r: any) => r.id === effectiveRuntimeId);
  // Harness-native runtimes (v6 §2/§3, v7 §2/§3) run on their own account —
  // Codex's ChatGPT or Claude Code's Claude.ai login and default model. No
  // provider/model binding applies.
  const harnessNative =
    effectiveRuntime?.credentialSource === "harness-native" ||
    HARNESS_NATIVE_KINDS.has(effectiveRuntime?.kind ?? "");

  const firstProviderWithModels = (() => {
    const withModels = providerList.filter((p: any) => modelList.some((m: any) => m.providerId === p.id));
    return withModels.find((p: any) => p.enabled) ?? withModels[0];
  })();
  const providerDefaultModelId = firstProviderWithModels
    ? modelList.find((m: any) => m.providerId === firstProviderWithModels.id)?.id ?? ""
    : "";
  const effectiveModelId = modelTouched
    ? modelChoice
    : inList(modelList, profile?.modelId)
      ? profile.modelId
      : providerDefaultModelId || (modelList[0]?.id ?? "");

  const effectiveWorkspaceId = inList(workspaceList, workspaceChoice) ? workspaceChoice : workspaceList[0]?.id ?? "";

  const missingModel = !harnessNative && !models.loading && modelList.length === 0;
  const missingWorkspace = !workspaces.loading && workspaceList.length === 0;

  const submit = async () => {
    if (!prompt.trim() || busy || missingModel || missingWorkspace) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<any>("/api/runs", {
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        runtimeId: effectiveRuntimeId || undefined,
        // Harness-native runtimes never bind an AgentFabric model (v6 §3).
        modelId: harnessNative ? undefined : effectiveModelId || undefined,
        workspaceId: effectiveWorkspaceId || undefined,
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
      {missingModel && (
        <ErrorBox message="尚未配置任何 LLM 模型 — 请先前往 LLM 页面添加 Provider 与模型，再回来发起任务（或在 Runtime 选择 Codex / Claude Code，使用其自有登录）" />
      )}
      {missingWorkspace && (
        <ErrorBox message="尚未配置 Workspace — 请先前往 Workspaces 页面创建一个，再回来选择" />
      )}
      <ErrorBox message={error} />

      <div className="composer new-task-composer">
        <textarea
          rows={5}
          autoFocus
          placeholder="随心输入，描述一个任务…"
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
          <select
            className="pill"
            value={effectiveRuntimeId}
            onChange={(e) => { setRuntimeChoice(e.target.value); setRuntimeTouched(true); }}
            title="Runtime"
          >
            {selectableRuntimes.map((r: any) => (
              <option key={r.id} value={r.id}>Runtime: {r.name} ({r.kind})</option>
            ))}
          </select>
          {harnessNative ? (
            <span
              className="pill harness-native-note"
              title="Harness-native credentials (v6): this runtime runs on its own logged-in account (Codex + ChatGPT) and its own default model — no AgentFabric provider or API key is needed or used."
            >
              Model: harness account (no AgentFabric model)
            </span>
          ) : (
            <select
              className="pill"
              value={effectiveModelId}
              onChange={(e) => { setModelChoice(e.target.value); setModelTouched(true); }}
              title="Model"
            >
              {modelList.map((m: any) => (
                <option key={m.id} value={m.id}>Model: {modelOptionLabel(providerList, m)}</option>
              ))}
            </select>
          )}
          <select
            className="pill"
            value={effectiveWorkspaceId}
            onChange={(e) => setWorkspaceChoice(e.target.value)}
            title="Workspace (required)"
          >
            {workspaceList.map((w: any) => (
              <option key={w.id} value={w.id}>Workspace: {w.name}</option>
            ))}
          </select>
          <select className="pill" value={profileId} onChange={(e) => setProfileId(e.target.value)} title="Agent profile">
            <option value="">Agent: none</option>
            {(profiles.data ?? []).map((p: any) => (
              <option key={p.id} value={p.id}>Agent: {p.name}</option>
            ))}
          </select>
          <select className="pill" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)} title="Container lifecycle">
            <option value="">
              Lifecycle:{" "}
              {effectiveRuntime
                ? `${effectiveRuntime.name} default (${effectiveRuntime.lifecycle?.mode ?? (effectiveRuntime.ephemeral === false ? "persistent" : "ephemeral")})`
                : "runtime default"}
            </option>
            <option value="ephemeral">Lifecycle: ephemeral</option>
            <option value="keep-alive">Lifecycle: keep-alive</option>
            <option value="persistent">Lifecycle: persistent</option>
          </select>
          <button
            className="send"
            title="Create task (⌘↵)"
            disabled={busy || !prompt.trim() || missingModel || missingWorkspace}
            onClick={submit}
          >
            {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={16} />}
          </button>
        </div>
      </div>

      {/* Existing local harness work lives on its own page (v6 §6, v7 §9) —
          this page only describes new tasks. */}
      <p className="sub sessions-pointer">
        Already working in {HARNESS_THREAD_SOURCES.map((s) => s.label).join(" / ")} on this machine?{" "}
        <a
          href="/sessions"
          onClick={(e) => {
            e.preventDefault();
            navigate("/sessions");
          }}
        >
          Local harness sessions
        </a>{" "}
        lists what is there and continues it here.
      </p>
    </div>
  );
}
