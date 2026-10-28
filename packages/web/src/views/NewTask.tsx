import { useState } from "react";
import { get, post } from "../api";
import { ErrorBox, Field, Icon, useAsync } from "../components";
import { HARNESS_NATIVE_KINDS } from "../harness";
import { useT } from "../i18n-react";
import { modelOptionLabel } from "../presentation";
import { navigate } from "../router";

/**
 * New Task (v5 §14): the user describes a Task, not a Run. Submitting
 * creates the Task + Run #1 and lands on the Task Thread.
 *
 * AgentFabric is a control plane over local harnesses, so the composer asks
 * for exactly three things:
 *
 * - **Workspace** — an absolute directory on this machine. The task runs
 *   *in place*: no clone, no branch, no push. Git writes (commit, push) are
 *   the harness's business, never the platform's.
 * - **Runtime** — any runtime usable in tasks, host or container: a local
 *   harness (OpenCode, Pi, Codex, Claude Code, DSH) or a Docker-isolated
 *   runtime. The list is deliberately **not** filtered by isolation — the
 *   workspace says what directory is mounted, the runtime says where the
 *   agent process runs, and both combinations are legitimate.
 * - **Model** — skipped for harness-native runtimes, which run on their own
 *   logged-in account and default model (v6 §3, v7 §3).
 *
 * There is no Project here. A Project used to own a repository, a clone and a
 * branch; all three decisions are gone, and so is the form that asked for
 * them. The workspace carries the default runtime/model a task inherits when
 * the user does not pick one.
 *
 * Discovery of work that started outside AgentFabric lives on its own page
 * (/sessions, v6 §6/§11, v7 §9/§11): this page is where a task is described;
 * that one is where existing local harness sessions are found and adopted.
 */

export function NewTaskView() {
  const t = useT();
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);
  const runtimes = useAsync<any[]>(() => get("/api/runtimes?usableInTask=true"), []);
  const providers = useAsync<any[]>(() => get("/api/providers"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [workspaceChoice, setWorkspaceChoice] = useState("");
  const [runtimeChoice, setRuntimeChoice] = useState("");
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [modelChoice, setModelChoice] = useState("");
  const [modelTouched, setModelTouched] = useState(false);
  // Container lifecycle for the task, decided at creation and immutable
  // afterwards; `ephemeral` is what the server materializes when unset.
  const [lifecycle, setLifecycle] = useState("ephemeral");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inline workspace creation: a task needs a directory, and sending the user
  // to another page to add one is a needless round trip.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");

  const workspaceList = workspaces.data ?? [];
  const providerList = providers.data ?? [];
  const modelList = models.data ?? [];
  const selectableRuntimes = (runtimes.data ?? []).filter((r: any) => r.enabled && r.usableInTask);
  const inList = (list: any[], id?: string) => Boolean(id && list.some((x) => x.id === id));

  // Visible defaults — the submitted ids are always the concrete values on
  // screen. Switching workspace re-resolves the runtime/model the user has
  // not touched, because the workspace carries those defaults.
  const effectiveWorkspaceId = inList(workspaceList, workspaceChoice)
    ? workspaceChoice
    : workspaceList[0]?.id ?? "";
  const workspace = workspaceList.find((w: any) => w.id === effectiveWorkspaceId);

  const builtinPi = selectableRuntimes.find((r: any) => r.kind === "pi");
  const effectiveRuntimeId = runtimeTouched
    ? runtimeChoice
    : inList(selectableRuntimes, workspace?.runtimeId)
      ? workspace.runtimeId
      : builtinPi?.id ?? selectableRuntimes[0]?.id ?? "";
  const effectiveRuntime = selectableRuntimes.find((r: any) => r.id === effectiveRuntimeId);
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
  // Explicit > workspace default > runtime default > first enabled model.
  const effectiveModelId = modelTouched
    ? modelChoice
    : inList(modelList, workspace?.modelId)
      ? workspace.modelId
      : inList(modelList, effectiveRuntime?.defaultModelId)
        ? effectiveRuntime.defaultModelId
        : providerDefaultModelId || (modelList[0]?.id ?? "");

  const missingWorkspace = !workspaces.loading && workspaceList.length === 0;
  const missingRuntime = !runtimes.loading && selectableRuntimes.length === 0;
  const missingModel = !harnessNative && !models.loading && modelList.length === 0;
  const blocked = missingWorkspace || missingRuntime || missingModel;

  const createWorkspace = async () => {
    const path = newPath.trim();
    if (!path || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await post<any>("/api/workspaces", {
        name: newName.trim() || path.split("/").filter(Boolean).pop() || path,
        type: "local",
        path,
      });
      setCreating(false);
      setNewName("");
      setNewPath("");
      workspaces.reload();
      setWorkspaceChoice(created.id);
      // The new workspace's own defaults decide the runtime/model until the
      // user touches those pills.
      setRuntimeTouched(false);
      setModelTouched(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!prompt.trim() || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<any>("/api/runs", {
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        runtimeId: effectiveRuntimeId || undefined,
        modelId: harnessNative ? undefined : effectiveModelId || undefined,
        workspaceId: effectiveWorkspaceId || undefined,
        lifecycle: { mode: lifecycle },
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
      <h1>{t("newtask.title")}</h1>
      <p className="sub">{t("newtask.sub")}</p>
      {missingWorkspace && <ErrorBox message={t("newtask.missingWorkspace")} />}
      {missingRuntime && <ErrorBox message={t("newtask.missingRuntime")} />}
      {missingModel && <ErrorBox message={t("newtask.missingModel")} />}
      <ErrorBox message={error} />

      <div className="composer new-task-composer">
        <textarea
          rows={5}
          autoFocus
          placeholder={t("newtask.prompt.placeholder")}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <input
          placeholder={t("newtask.title.placeholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {/* Inline workspace creation. The path is the whole definition of a
            workspace: the task runs there in place, so nothing is cloned and
            nothing is asked about branches. */}
        {creating && (
          <div className="new-task-details">
            <div className="form-grid-2">
              <Field label={t("newtask.workspace.name")}>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t("newtask.workspace.namePlaceholder")}
                />
              </Field>
              <Field label={t("newtask.workspace.path")}>
                <input
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder={t("newtask.workspace.pathPlaceholder")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createWorkspace();
                  }}
                />
              </Field>
            </div>
            <div className="modal-actions">
              <button onClick={() => setCreating(false)}>{t("newtask.workspace.cancel")}</button>
              <button className="primary" disabled={busy || !newPath.trim()} onClick={createWorkspace}>
                {t("newtask.workspace.create")}
              </button>
            </div>
          </div>
        )}
        <div className="composer-bar">
          {workspaceList.length > 0 && (
            <select
              className="pill"
              value={effectiveWorkspaceId}
              onChange={(e) => {
                setWorkspaceChoice(e.target.value);
                // The runtime/model a task inherits come from the workspace.
                setRuntimeTouched(false);
                setModelTouched(false);
              }}
              title={t("newtask.workspace.title")}
            >
              {workspaceList.map((w: any) => (
                <option key={w.id} value={w.id}>
                  {t("newtask.option.workspace", { name: w.name })}
                </option>
              ))}
            </select>
          )}
          <button className="pill" onClick={() => setCreating((v) => !v)} title={t("newtask.workspace.newTitle")}>
            {t("newtask.workspace.new")}
          </button>
          {/* Hidden rather than rendered empty when no runtime is usable: the
              ErrorBox above already explains why, and submit is blocked. */}
          {selectableRuntimes.length > 0 && (
            <select
              className="pill"
              value={effectiveRuntimeId}
              onChange={(e) => {
                setRuntimeChoice(e.target.value);
                setRuntimeTouched(true);
              }}
              title={t("newtask.runtime.title")}
            >
              {selectableRuntimes.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {t("newtask.option.runtime", { name: r.name, kind: r.kind })}
                </option>
              ))}
            </select>
          )}
          {harnessNative ? (
            <span className="pill harness-native-note" title={t("newtask.model.harnessNote.title")}>
              {t("newtask.model.harnessNote")}
            </span>
          ) : (
            <select
              className="pill"
              value={effectiveModelId}
              onChange={(e) => {
                setModelChoice(e.target.value);
                setModelTouched(true);
              }}
              title={t("newtask.model.title")}
            >
              {modelList.map((m: any) => (
                <option key={m.id} value={m.id}>
                  {t("newtask.option.model", { name: modelOptionLabel(providerList, m) })}
                </option>
              ))}
            </select>
          )}
          {/* The lifecycle belongs to the Task, not the runtime: chosen here,
              once, and inherited by every later turn of this task. */}
          <select
            className="pill"
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value)}
            title={t("newtask.lifecycle.title")}
          >
            <option value="ephemeral">{t("newtask.option.lifecycle.ephemeral")}</option>
            <option value="keep-alive">{t("newtask.option.lifecycle.keepAlive")}</option>
            <option value="persistent">{t("newtask.option.lifecycle.persistent")}</option>
          </select>
          <button
            className="send"
            title={t("newtask.submit.title")}
            disabled={busy || !prompt.trim() || blocked}
            onClick={submit}
          >
            {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={16} />}
          </button>
        </div>
      </div>

      {/* Existing local harness work lives on its own page (v6 §6, v7 §9) —
          this page only describes new tasks. */}
      <p className="sub sessions-pointer">
        {t("newtask.sessions")}{" "}
        <a
          href="/sessions"
          onClick={(e) => {
            e.preventDefault();
            navigate("/sessions");
          }}
        >
          {t("newtask.sessions.link")}
        </a>
      </p>
    </div>
  );
}
