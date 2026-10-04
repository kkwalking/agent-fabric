import { useState } from "react";
import { get, post } from "../api";
import { ErrorBox, Field, Icon, useAsync } from "../components";
import { HARNESS_NATIVE_KINDS, HARNESS_THREAD_SOURCES } from "../harness";
import { modelOptionLabel } from "../presentation";
import { navigate } from "../router";

/**
 * New Task (v5 §14): the user describes a Task, not a Run. Submitting
 * creates the Task + Run #1 and lands on the Task Thread — never on the
 * Run Detail page.
 *
 * The composer has two modes and the Project selector is what picks between
 * them (v11 §39, which starts the Task flow at "Select Project"):
 *
 * - **Project mode** — the default whenever a Project exists. A Project
 *   defines the codebase, so the user chooses it first and then only the
 *   decisions a Task actually owns: base ref, working branch, branch mode
 *   and optional runtime/model overrides. There is deliberately **no
 *   Workspace selector**: `1 Task = 1 Managed Workspace` (v11 §5.1) and the
 *   platform creates it, so the working copy is not the user's to pick.
 *   Submission goes to `POST /api/projects/:id/tasks` and lands on the Task
 *   Lifecycle page, where phase / agent / validation / publish are visible.
 *
 * - **Workspace mode** — "Project: none", the advanced path v11 §5.4 and
 *   v11 hardening §37 require to stay available (non-project task, local
 *   runtime, external workspace). With no Project there is no codebase
 *   definition, so the working copy *is* the user's decision: the Workspace
 *   selector is what makes this mode meaningful. Submission goes to the
 *   classic `POST /api/runs` and lands on the Task Thread.
 *
 * Every selector shows a concrete, visible default instead of a "default"
 * pseudo-option: runtime → the Project's default, else built-in Pi Agent,
 * else the first eligible runtime; model → the Project's default, else the
 * runtime's default, else the first model of the first configured provider;
 * workspace → first configured workspace. A missing prerequisite (no LLM, no
 * workspace, no eligible runtime) blocks submission with a pointer to the
 * right settings tab — except for harness-native runtimes (Codex + ChatGPT,
 * Claude Code + Claude.ai — v6 §3/v7 §3), which need neither a provider nor
 * a model.
 *
 * The runtime list is mode-specific and served, never derived. A Project
 * Coding Task runs isolated or it does not run at all (v11 hardening §4), so
 * Project mode reads `/api/runtimes/project-eligible` — the same rule the
 * server enforces at submit. Rendering the unfiltered list here would put
 * runtimes on screen that the server then refuses.
 *
 * Discovery of work that started outside AgentFabric lives on its own page
 * (/sessions, v6 §6/§11, v7 §9/§11): this page is where a task is
 * described; that one is where existing local harness sessions are found
 * and adopted.
 */

export function NewTaskView() {
  // Two served runtime lists, one per mode. Both are fetched up front so
  // switching the Project selector never leaves the pill empty.
  const classicRuntimes = useAsync<any[]>(() => get("/api/runtimes?usableInTask=true"), []);
  const projectRuntimes = useAsync<any[]>(() => get("/api/runtimes/project-eligible"), []);
  const providers = useAsync<any[]>(() => get("/api/providers"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);
  const projects = useAsync<any[]>(() => get("/api/projects"), []);
  // AGENT_UI_HIDDEN: 下方的 Agent 选择器已注释。这个请求与 profileId 相关的
  // 默认值逻辑（effectiveRuntimeId / effectiveModelId 的 profile 分支、提交体
  // 里的 profileId 字段）原样保留——选择器隐藏期间 profileId 恒为 ""，这些
  // 分支不会命中；恢复入口只需取消注释带 AGENT_UI_HIDDEN 标记的块。
  const profiles = useAsync<any[]>(() => get("/api/agents"), []);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [runtimeChoice, setRuntimeChoice] = useState("");
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [modelChoice, setModelChoice] = useState("");
  const [modelTouched, setModelTouched] = useState(false);
  const [workspaceChoice, setWorkspaceChoice] = useState("");
  const [profileId, setProfileId] = useState("");
  // The Project selector: absent means "none" (workspace mode). The first
  // Project is the visible default so the primary flow — a coding task
  // against a real repository — is one keystroke away.
  const [projectChoice, setProjectChoice] = useState("");
  const [projectTouched, setProjectTouched] = useState(false);
  // Task-owned branch decisions (v11 §7/§8), only meaningful in Project mode.
  const [baseRef, setBaseRef] = useState("");
  const [workingBranch, setWorkingBranch] = useState("");
  const [branchMode, setBranchMode] = useState("new");
  // Container lifecycle for the task, decided at creation and immutable
  // afterwards; `ephemeral` is what the server materializes when unset.
  const [lifecycle, setLifecycle] = useState("ephemeral");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelList = models.data ?? [];
  const workspaceList = workspaces.data ?? [];
  const providerList = providers.data ?? [];
  const projectList = projects.data ?? [];
  const profile = (profiles.data ?? []).find((p: any) => p.id === profileId);
  const inList = (list: any[], id?: string) => Boolean(id && list.some((x) => x.id === id));

  const effectiveProjectId = projectTouched
    ? inList(projectList, projectChoice)
      ? projectChoice
      : ""
    : projectList[0]?.id ?? "";
  const effectiveProject = projectList.find((p: any) => p.id === effectiveProjectId);
  const projectMode = Boolean(effectiveProject);
  const projectDefaultBranch = effectiveProject?.source?.defaultBranch || "main";

  // Mode-specific runtime list. `project-eligible` already means enabled +
  // usableInTask + sandboxed, so the filter below is a no-op there; it is
  // what narrows the classic list.
  const runtimeSource = projectMode ? projectRuntimes : classicRuntimes;
  const selectableRuntimes = (runtimeSource.data ?? []).filter((r: any) => r.enabled && r.usableInTask);

  // Visible defaults — the submitted ids are always the concrete values on
  // screen. Choosing an Agent profile visibly re-resolves the fields the
  // user has not touched; so does switching Project, whose defaults the
  // Task inherits (v11 §24).
  const builtinPi = selectableRuntimes.find((r: any) => r.kind === "pi");
  const effectiveRuntimeId = runtimeTouched
    ? runtimeChoice
    : inList(selectableRuntimes, profile?.runtimeId)
      ? profile.runtimeId
      : inList(selectableRuntimes, effectiveProject?.execution?.runtimeId)
        ? effectiveProject.execution.runtimeId
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
  // Mirrors the supervisor's `resolveModelId`: explicit > Project default >
  // runtime default > first enabled model.
  const effectiveModelId = modelTouched
    ? modelChoice
    : inList(modelList, profile?.modelId)
      ? profile.modelId
      : inList(modelList, effectiveProject?.execution?.modelId)
        ? effectiveProject.execution.modelId
        : inList(modelList, effectiveRuntime?.defaultModelId)
          ? effectiveRuntime.defaultModelId
          : providerDefaultModelId || (modelList[0]?.id ?? "");

  const effectiveWorkspaceId = inList(workspaceList, workspaceChoice) ? workspaceChoice : workspaceList[0]?.id ?? "";

  const missingModel = !harnessNative && !models.loading && modelList.length === 0;
  // A Project Task gets its managed Workspace from the platform, so the
  // Workspace prerequisite only applies to workspace mode (v11 §5.1/§39).
  const missingWorkspace = !projectMode && !workspaces.loading && workspaceList.length === 0;
  // Refused at submit anyway (`runtime-not-isolated`); say so before the
  // click rather than after it.
  const missingProjectRuntime =
    projectMode && !projectRuntimes.loading && selectableRuntimes.length === 0;
  const blocked = missingModel || missingWorkspace || missingProjectRuntime;

  const submit = async () => {
    if (!prompt.trim() || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      if (effectiveProject) {
        // Project mode (v11 §39): the platform creates the managed
        // Workspace, clones the source and publishes the working branch.
        // No workspaceId is sent — that decision is not the user's here.
        const r = await post<any>(`/api/projects/${effectiveProject.id}/tasks`, {
          instruction: prompt.trim(),
          title: title.trim() || undefined,
          baseRef: baseRef.trim() || undefined,
          workingBranch: workingBranch.trim() || undefined,
          branchMode,
          runtimeId: effectiveRuntimeId || undefined,
          // Harness-native runtimes never bind an AgentFabric model (v6 §3).
          modelId: harnessNative ? undefined : effectiveModelId || undefined,
          profileId: profileId || undefined,
          lifecycle: { mode: lifecycle },
        });
        // Create Task → Run #1 → Task Thread (v5 §14). The thread is where
        // the run is watched; the lifecycle view is one click away from its
        // header, never the landing page — landing there hid the running
        // agent behind a status table.
        navigate(`/tasks/${r.task.id}`);
      } else {
        const r = await post<any>("/api/runs", {
          prompt: prompt.trim(),
          title: title.trim() || undefined,
          runtimeId: effectiveRuntimeId || undefined,
          modelId: harnessNative ? undefined : effectiveModelId || undefined,
          workspaceId: effectiveWorkspaceId || undefined,
          profileId: profileId || undefined,
          lifecycle: { mode: lifecycle },
        });
        // Create Task → Create Run #1 → Task Thread (v5 §14).
        navigate(`/tasks/${r.task.id}`);
      }
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
        system executes each step. Choose a Project for a coding task: the platform creates the task's own
        managed workspace, prepares the source and publishes the working branch. Pick “Project: none” to work
        in a workspace you manage yourself.
      </p>
      {missingModel && (
        <ErrorBox message="尚未配置任何 LLM 模型 — 请先前往 LLM 页面添加 Provider 与模型，再回来发起任务（或在 Runtime 选择 Codex / Claude Code，使用其自有登录）" />
      )}
      {missingWorkspace && (
        <ErrorBox message="尚未配置 Workspace — 请先前往 Workspaces 页面创建一个，再回来选择" />
      )}
      {missingProjectRuntime && (
        <ErrorBox message="没有可用于 Project Task 的隔离 Runtime — Project Coding Task 必须运行在 isolated Runtime 中（v11 hardening §4），不会降级到 Host。请前往 Runtimes 页面启用一个 containerized Runtime，或把 Project 改选为 none 走 Workspace 模式" />
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
        {/* Branch decisions exist only for a Project Task (v11 §7/§8): with
            no Project there is no source to branch from. */}
        {projectMode && (
          <details className="new-task-branch" open>
            <summary>Base ref &amp; working branch</summary>
            <div className="form-grid-2">
              <Field label={`Base ref (default: ${projectDefaultBranch})`}>
                <input
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                  placeholder={projectDefaultBranch}
                />
              </Field>
              <Field label="Working branch (leave empty to generate af/<task>-<slug>)">
                <input
                  value={workingBranch}
                  onChange={(e) => setWorkingBranch(e.target.value)}
                  placeholder="auto-generated"
                />
              </Field>
            </div>
            {/* Full width: the two modes need a sentence each to explain
                themselves, and half a grid column truncates them. */}
            <Field label="Branch mode">
              <select value={branchMode} onChange={(e) => setBranchMode(e.target.value)}>
                <option value="new">new — create a fresh branch (never overwrites an existing one)</option>
                <option value="continue">continue — build on an existing branch explicitly</option>
              </select>
            </Field>
          </details>
        )}
        <div className="composer-bar">
          {projectList.length > 0 && (
            <select
              className="pill"
              value={effectiveProjectId}
              onChange={(e) => {
                setProjectChoice(e.target.value);
                setProjectTouched(true);
                // Re-resolve runtime/model against the new Project's
                // defaults, and drop branch input that belonged to the
                // previous one.
                setRuntimeChoice("");
                setRuntimeTouched(false);
                setModelChoice("");
                setModelTouched(false);
                setBaseRef("");
                setWorkingBranch("");
              }}
              title={
                projectMode
                  ? "Project (v11 §39) — the codebase this task develops against. The platform creates the task's managed workspace."
                  : "Project: none (advanced, v11 §5.4) — no codebase definition, so you choose the workspace and the platform does not create one for you."
              }
            >
              {projectList.map((p: any) => (
                <option key={p.id} value={p.id}>Project: {p.name}</option>
              ))}
              {/* Kept short enough to render inside the pill's 240px cap;
                  the subtitle and the tooltip carry the full explanation. */}
              <option value="">Project: none — pick a workspace</option>
            </select>
          )}
          {/* Hidden rather than rendered empty when the mode offers no
              runtime: the ErrorBox above already explains why, and submit
              is blocked regardless. */}
          {selectableRuntimes.length > 0 && (
            <select
              className="pill"
              value={effectiveRuntimeId}
              onChange={(e) => { setRuntimeChoice(e.target.value); setRuntimeTouched(true); }}
              title={projectMode ? "Runtime (isolated runtimes only)" : "Runtime"}
            >
              {selectableRuntimes.map((r: any) => (
                <option key={r.id} value={r.id}>Runtime: {r.name} ({r.kind})</option>
              ))}
            </select>
          )}
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
          {/* Workspace mode only: a Project Task's working copy is managed
              (1 Task = 1 Managed Workspace, v11 §5.1), never chosen. */}
          {!projectMode && (
            <select
              className="pill"
              value={effectiveWorkspaceId}
              onChange={(e) => setWorkspaceChoice(e.target.value)}
              title="Workspace (required without a Project)"
            >
              {workspaceList.map((w: any) => (
                <option key={w.id} value={w.id}>Workspace: {w.name}</option>
              ))}
            </select>
          )}
          {/* AGENT_UI_HIDDEN: Agent Profile 选择器，恢复入口时取消注释。
          <select className="pill" value={profileId} onChange={(e) => setProfileId(e.target.value)} title="Agent profile">
            <option value="">Agent: none</option>
            {(profiles.data ?? []).map((p: any) => (
              <option key={p.id} value={p.id}>Agent: {p.name}</option>
            ))}
          </select>
          */}
          {/* The lifecycle belongs to the Task, not the runtime: chosen here,
              once, and inherited by every later turn of this task. */}
          <select
            className="pill"
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value)}
            title="Container lifecycle for this task — fixed for every run of the task"
          >
            <option value="ephemeral">Lifecycle: ephemeral (default)</option>
            <option value="keep-alive">Lifecycle: keep-alive</option>
            <option value="persistent">Lifecycle: persistent</option>
          </select>
          <button
            className="send"
            title="Create task (⌘↵)"
            disabled={busy || !prompt.trim() || blocked}
            onClick={submit}
          >
            {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={16} />}
          </button>
        </div>
      </div>

      {!projects.loading && projectList.length === 0 && (
        <p className="sub">
          No Projects yet.{" "}
          <a
            href="/projects"
            onClick={(e) => {
              e.preventDefault();
              navigate("/projects");
            }}
          >
            Create one
          </a>{" "}
          to bind a Git repository — the platform then creates the task's managed workspace, clones the source
          and publishes the working branch. Without a Project you pick an existing workspace instead.
        </p>
      )}

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
