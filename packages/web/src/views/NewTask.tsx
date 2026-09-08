import { useState } from "react";
import { get, post, fmtRelative } from "../api";
import { ErrorBox, Icon, useAsync } from "../components";
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
 * Below the composer, Local Harness Threads (v6 §6/§11, v7 §9/§11) let
 * the user adopt work that started outside AgentFabric: pick a Codex
 * thread or Claude Code session, "Continue in AgentFabric", then hand it
 * off to another harness from the task thread.
 */

/** Harnesses exposing local thread/session discovery (v7 §9). */
const HARNESS_THREAD_SOURCES = [
  { kind: "claude-code", label: "Claude Code", noun: "Sessions", hint: "in the Claude Code CLI on this machine" },
  { kind: "codex", label: "Codex", noun: "Threads", hint: "in the Codex CLI or IDE extension" },
] as const;

/** Harness kinds that authenticate with their own account (v6 §2/v7 §2). */
const HARNESS_NATIVE_KINDS = new Set(["codex", "claude-code"]);

export function NewTaskView() {
  const runtimes = useAsync<any[]>(() => get("/api/runtimes"), []);
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
  const modelList = models.data ?? [];
  const workspaceList = workspaces.data ?? [];
  const providerList = providers.data ?? [];
  const profile = (profiles.data ?? []).find((p: any) => p.id === profileId);
  const inList = (list: any[], id?: string) => Boolean(id && list.some((x) => x.id === id));

  // Visible defaults — the submitted ids are always the concrete values on
  // screen. Choosing an Agent profile visibly re-resolves the fields the
  // user has not touched.
  const builtinPi =
    runtimeList.find((r: any) => r.kind === "pi" && r.enabled) ?? runtimeList.find((r: any) => r.kind === "pi");
  const effectiveRuntimeId = runtimeTouched
    ? runtimeChoice
    : inList(runtimeList, profile?.runtimeId)
      ? profile.runtimeId
      : builtinPi?.id ?? runtimeList.find((r: any) => r.enabled)?.id ?? runtimeList[0]?.id ?? "";
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
            {runtimeList.map((r: any) => (
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
                <option key={m.id} value={m.id}>Model: {m.alias ?? m.name}</option>
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

      {HARNESS_THREAD_SOURCES.map((src) => (
        <LocalHarnessThreadsPanel
          key={src.kind}
          kind={src.kind}
          label={src.label}
          noun={src.noun}
          hint={src.hint}
          enabled={runtimeList.some((r: any) => r.kind === src.kind && r.enabled)}
          workspaceId={effectiveWorkspaceId}
        />
      ))}
    </div>
  );
}

/* ================================================================== */
/* Local harness thread discovery (v6 §6/§11, v7 §9/§11)               */
/* ================================================================== */

/**
 * Lists a harness's local threads/sessions that already exist on this
 * machine (created outside AgentFabric) and adopts them: Continue in
 * AgentFabric reads the thread, associates its workspace and lands on
 * the task thread, where switching to another harness generates the
 * handoff (v6 §8, v7 §11).
 */
function LocalHarnessThreadsPanel({
  kind,
  label,
  noun,
  hint,
  enabled,
  workspaceId,
}: {
  kind: string;
  label: string;
  noun: string;
  hint: string;
  enabled: boolean;
  workspaceId: string;
}) {
  const [thisWorkspaceOnly, setThisWorkspaceOnly] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const auth = useAsync<any>(() => get(`/api/harness/${kind}/auth-status`), [kind, enabled]);
  const threads = useAsync<any[]>(
    () =>
      enabled
        ? get(`/api/harness/${kind}/threads${thisWorkspaceOnly && workspaceId ? `?workspaceId=${workspaceId}&limit=20` : "?limit=20"}`)
        : Promise.resolve([]),
    [kind, enabled, thisWorkspaceOnly, workspaceId]
  );

  if (!enabled) return null;

  const adopt = async (threadId: string) => {
    setImporting(threadId);
    setImportError(null);
    try {
      const r = await post<any>(`/api/harness/${kind}/threads/import`, { threadId });
      navigate(`/tasks/${r.taskId}`);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
      setImporting(null);
    }
  };

  const list = threads.data ?? [];

  return (
    <section className="threads-panel">
      <div className="section-head">
        <h2>Local {label} {noun}</h2>
        <label className="muted threads-filter" title="Only threads whose working directory matches the selected workspace">
          <input
            type="checkbox"
            checked={thisWorkspaceOnly}
            onChange={(e) => setThisWorkspaceOnly(e.target.checked)}
          />{" "}
          This workspace only
        </label>
        <button className="small right" onClick={threads.reload}>Refresh</button>
      </div>
      <p className="muted sub">
        Work that started {hint}. Adopting a {noun.toLowerCase().replace(/s$/, "")} reads its history — it never
        re-runs the model — so you can continue it here and hand it off to another harness.
      </p>

      {/* Harness-native auth availability (v6 §2, v7 §2) — detection only, never credentials. */}
      {auth.data && !auth.data.ok && (
        <div className="card auth-hint">
          <strong>{auth.data.installed ? `${label} CLI not logged in` : `${label} CLI not installed`}</strong>
          <div className="muted">{auth.data.hint ?? `Install the ${label} CLI and sign in to use ${label} Local.`}</div>
        </div>
      )}
      {auth.data?.ok && auth.data.detail && (
        <p className="muted auth-ok">
          <Icon name="key" size={12} /> {auth.data.detail}
          {auth.data.version ? ` · ${auth.data.version}` : ""}
        </p>
      )}
      <ErrorBox message={threads.error ? `${label} thread discovery failed: ${threads.error}` : null} />
      <ErrorBox message={importError} />

      {threads.loading ? (
        <div className="muted">Loading local {label} {noun.toLowerCase()}…</div>
      ) : list.length === 0 && !threads.error ? (
        <div className="muted">No local {label} {noun.toLowerCase()} found{thisWorkspaceOnly ? " in this workspace" : ""}.</div>
      ) : (
        <div className="thread-items">
          {list.map((t: any) => (
            <div key={t.id} className={`thread-item${t.adopted ? " adopted" : ""}`}>
              <div className="thread-item-main">
                <div className="thread-item-title" title={t.preview ?? t.title ?? t.id}>
                  {t.title ?? t.id}
                </div>
                <div className="thread-item-meta muted">
                  {t.cwd ? <span title={t.cwd}>{t.cwd.split("/").slice(-2).join("/")}</span> : <span>no workspace</span>}
                  {t.updatedAt && <span> · updated {fmtRelative(t.updatedAt)}</span>}
                  {t.turnCount != null && <span> · {t.turnCount} turn{t.turnCount === 1 ? "" : "s"}</span>}
                  {t.model && <span> · {t.model}</span>}
                </div>
              </div>
              <div className="thread-item-actions">
                {t.adopted ? (
                  <button className="small" onClick={() => navigate(`/tasks/${t.adoptedTaskId}`)}>
                    In AgentFabric ↗
                  </button>
                ) : (
                  <button
                    className="small primary"
                    disabled={importing !== null}
                    title="Read this thread, adopt its workspace and continue it as an AgentFabric task"
                    onClick={() => adopt(t.id)}
                  >
                    {importing === t.id ? <span className="spinner" /> : "Continue in AgentFabric"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
