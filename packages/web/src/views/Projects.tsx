import { useState } from "react";
import { del, get, post, put, fmtRelative, shortId } from "../api";
import { ErrorBox, Field, Icon, Modal, StatusBadge, clickableRow, useMinuteClock, useAsync } from "../components";
import { statusLabel, type Translate } from "../i18n";
import { useT } from "../i18n-react";
import { navigate } from "../router";

/**
 * Projects (v11 §2/§39): a Project is the long-lived codebase AgentFabric
 * develops against. It owns the Git source and the execution defaults every
 * Task inherits — it never holds a working copy (that is the Task's managed
 * Workspace) and never holds credential material (that is a Source
 * Credential, referenced by id).
 */

function lifecycleChips(t: Translate, task: any) {
  const execution = task.execution ?? {};
  const agent = execution.agent?.status;
  const validation = execution.validation?.status;
  const publish = execution.publish?.status;
  return (
    <>
      <span className="meta-chip"><span className="muted">{t("projects.chip.phase")}</span> {statusLabel(t, execution.phase)}</span>
      <span className="meta-chip"><span className="muted">{t("projects.chip.agent")}</span> {statusLabel(t, agent)}</span>
      <span className="meta-chip"><span className="muted">{t("projects.chip.validation")}</span> {statusLabel(t, validation)}</span>
      <span className="meta-chip"><span className="muted">{t("projects.chip.publish")}</span> {statusLabel(t, publish)}</span>
    </>
  );
}

/**
 * The retry a failure stage permits — the client-side mirror of
 * `retryKindForFailure` (core/errors.ts). The table must not test the raw
 * stage: workspace/source/runtime/finalization failures all recover through
 * the agent retry (a new run on the same workspace), so gating on
 * `stage === "agent"` hid the retry button for every one of them.
 */
function retryKind(stage: string | undefined): "agent" | "validation" | "publish" | "none" {
  switch (stage) {
    case "workspace":
    case "source":
    case "runtime":
    case "agent":
    case "finalization":
      return "agent";
    case "validation":
      return "validation";
    case "publish":
      return "publish";
    default:
      return "none";
  }
}

function ProjectTaskTable({ tasks, onAction }: { tasks: any[]; onAction?: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (task: any, action: "retry-run" | "retry-validation" | "retry-publish" | "cancel") => {
    setBusy(task.id);
    setError(null);
    try {
      await post(`/api/tasks/${task.id}/${action}`, {});
      onAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (tasks.length === 0) return <div className="card muted">{t("projects.tasksEmpty")}</div>;
  return (
    <div>
      <ErrorBox message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("projects.thTask")}</th>
              <th>{t("projects.thWorkingBranch")}</th>
              <th>{t("projects.thPhase")}</th>
              <th>{t("projects.thAgent")}</th>
              <th>{t("projects.thValidation")}</th>
              <th>{t("projects.thPublish")}</th>
              <th>{t("projects.thUpdated")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const execution = task.execution ?? {};
              const failure = execution.failure;
              const kind = retryKind(failure?.stage);
              const live = ["preparing", "running", "validating", "finalizing", "publishing"].includes(execution.status);
              return (
                <tr key={task.id}>
                  <td>
                    <a onClick={() => navigate(`/tasks/${task.id}`)}>{task.title}</a>
                    <div className="muted" style={{ fontSize: 12 }}>{shortId(task.id)}</div>
                    {failure && (
                      <div className="muted" style={{ fontSize: 12, color: "var(--red)" }}>
                        [{failure.stage}] {failure.code}
                      </div>
                    )}
                  </td>
                  <td className="muted">{task.workingBranch ?? "-"}</td>
                  <td>{statusLabel(t, execution.phase)}</td>
                  <td>{statusLabel(t, execution.agent?.status)}</td>
                  <td>{statusLabel(t, execution.validation?.status)}</td>
                  <td>
                    {statusLabel(t, execution.publish?.status)}
                    {execution.publish?.remoteBranch ? <div className="muted" style={{ fontSize: 12 }}>{execution.publish.remoteBranch}</div> : null}
                  </td>
                  <td className="muted">{fmtRelative(t, execution.updatedAt ?? task.createdAt)}</td>
                  <td className="actions">
                    <button className="small" onClick={() => navigate(`/tasks/${task.id}/lifecycle`)}>{t("projects.lifecycle")}</button>{" "}
                    {live && <button className="small danger" disabled={busy === task.id} onClick={() => act(task, "cancel")}>{t("projects.cancel")}</button>}
                    {!live && kind === "agent" && <button className="small" disabled={busy === task.id} onClick={() => act(task, "retry-run")}>{t("projects.retryRun")}</button>}
                    {!live && kind === "validation" && <button className="small" disabled={busy === task.id} onClick={() => act(task, "retry-validation")}>{t("projects.retryValidation")}</button>}
                    {/* Same gate as the lifecycle page: publish is retryable only while a frozen revision exists and the task is not already pushed. */}
                    {!live && kind === "publish" && execution.frozenRevision?.finalCommitSha && execution.publish?.status !== "pushed" && (
                      <button className="small" disabled={busy === task.id} onClick={() => act(task, "retry-publish")}>{t("projects.retryPublish")}</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ProjectsView() {
  const t = useT();
  // "3m ago" labels move on their own (see `useMinuteClock`).
  useMinuteClock();
  const projects = useAsync<any[]>(() => get("/api/projects"), []);
  const credentials = useAsync<any[]>(() => get("/api/source-credentials"), []);
  // Project Coding Tasks require an isolated runtime (v11 hardening §4), so
  // the project default may only be one of those. The server refuses the rest.
  const runtimes = useAsync<any[]>(() => get("/api/runtimes/project-eligible"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    sourceType: "git" as "git" | "directory",
    remoteUrl: "",
    path: "",
    credentialId: "",
    defaultBranch: "main",
    runtimeId: "",
    modelId: "",
    validation: "",
    push: true,
    autoCommit: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const validationPrompt = form.validation.trim();
      const isGit = form.sourceType === "git";
      const project = await post<{ id: string }>("/api/projects", {
        name: form.name,
        source: isGit
          ? {
              type: "git",
              remoteUrl: form.remoteUrl,
              credentialId: form.credentialId || undefined,
              defaultBranch: form.defaultBranch || undefined,
            }
          : { type: "directory", path: form.path, defaultBranch: form.defaultBranch || undefined },
        execution: {
          runtimeId: form.runtimeId || undefined,
          modelId: form.modelId || undefined,
        },
        // Empty = no validation configured (the cycle is skipped); an empty
        // prompt would be a config error, so it is never sent (v12 §3.1).
        ...(validationPrompt ? { validation: { prompt: validationPrompt } } : {}),
        git: { push: form.push, autoCommit: form.autoCommit },
      });
      setCreating(false);
      navigate(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (projects.error) return <ErrorBox message={projects.error} />;

  return (
    <div>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>{t("projects.title")}</h1>
        <span className="right">
          <button className="small" onClick={() => projects.reload()}>{t("common.refresh")}</button>{" "}
          <button className="small primary" onClick={() => setCreating(true)}>{t("projects.new")}</button>
        </span>
      </div>
      <p className="sub">
        {t("projects.sub")}
      </p>

      <ErrorBox message={error} />

      {(projects.data ?? []).length === 0 ? (
        <div className="card muted">
          {t("projects.empty")}
          <a onClick={() => setCreating(true)}>{t("projects.new")}</a>
          {t("projects.emptyAfter")}
        </div>
      ) : (
        <div className="task-list">
          {(projects.data ?? []).map((project) => (
            <div key={project.id} className="task-item card" {...clickableRow(() => navigate(`/projects/${project.id}`))}>
              <div className="task-item-main">
                <div className="task-item-head">
                  <strong className="task-item-title">{project.name}</strong>
                </div>
                <div className="task-item-meta">
                  <span className="meta-chip">
                    {project.source?.type === "directory"
                      ? project.source?.path
                      : project.source?.remoteUrl}
                  </span>
                  <span className="meta-chip">
                    <span className="muted">{t("projects.chip.branch")}</span> {project.source?.defaultBranch ?? "-"}
                  </span>
                  <span className="meta-chip">
                    <span className="muted">{t("projects.chip.credential")}</span>
                    {project.source?.type === "directory"
                      ? t("projects.label.notApplicableDirectory")
                      : project.source?.credentialId
                        ? t("projects.label.configured")
                        : t("projects.label.public")}
                  </span>
                  <span className="meta-chip">
                    <span className="muted">{t("projects.chip.validation")}</span> {project.validation?.prompt ? t("projects.label.configured") : t("projects.label.none")}
                  </span>
                </div>
              </div>
              <div className="task-item-side">
                <span className="muted task-item-time">
                  {project.source?.type === "directory" ? t("projects.label.directory") : project.source?.provider ?? "-"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal title={t("projects.new")} onClose={() => setCreating(false)}>
          <div className="form-grid-2">
            <Field label={t("projects.field.name")}>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="agent-fabric" />
            </Field>
            <Field label={t("projects.field.source")}>
              <select
                value={form.sourceType}
                onChange={(e) => setForm({ ...form, sourceType: e.target.value as "git" | "directory" })}
              >
                <option value="git">{t("projects.field.gitRepository")}</option>
                <option value="directory">{t("projects.field.directory")}</option>
              </select>
            </Field>
            {form.sourceType === "git" ? (
              <>
                <Field label={t("projects.field.repoUrl")}>
                  <input
                    value={form.remoteUrl}
                    onChange={(e) => setForm({ ...form, remoteUrl: e.target.value })}
                    placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
                  />
                </Field>
                <Field label={t("projects.field.credentialOptional")}>
                  <select value={form.credentialId} onChange={(e) => setForm({ ...form, credentialId: e.target.value })}>
                    <option value="">{t("projects.field.publicNoCredential")}</option>
                    {(credentials.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.type}{c.host ? ` · ${c.host}` : ""})
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              <Field label={t("projects.field.directoryPath")}>
                <input
                  value={form.path}
                  onChange={(e) => setForm({ ...form, path: e.target.value })}
                  placeholder="/Users/me/code/my-repo"
                />
              </Field>
            )}
            <Field label={t("projects.field.defaultBranch")}>
              <input value={form.defaultBranch} onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })} />
            </Field>
            <Field label={t("projects.field.defaultRuntime")}>
              <select value={form.runtimeId} onChange={(e) => setForm({ ...form, runtimeId: e.target.value })}>
                <option value="">{t("projects.field.choosePerTask")}</option>
                {(runtimes.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>{r.name} ({r.kind})</option>
                ))}
              </select>
            </Field>
            <Field label={t("projects.field.defaultModel")}>
              <select value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
                <option value="">{t("projects.field.runtimeDefault")}</option>
                {(models.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>{m.alias ?? m.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t("projects.field.validation")}>
            <textarea
              rows={3}
              value={form.validation}
              onChange={(e) => setForm({ ...form, validation: e.target.value })}
              placeholder={t("projects.field.validationPlaceholder")}
            />
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.autoCommit} onChange={(e) => setForm({ ...form, autoCommit: e.target.checked })} />
            {t("projects.field.autoCommit")}
          </label>
          {form.sourceType === "git" && (
            <label className="check">
              <input type="checkbox" checked={form.push} onChange={(e) => setForm({ ...form, push: e.target.checked })} />
              {t("projects.field.push")}
            </label>
          )}
          <div className="modal-actions">
            <button onClick={() => setCreating(false)}>{t("projects.cancelBtn")}</button>
            <button
              className="primary"
              disabled={busy || !form.name || (form.sourceType === "git" ? !form.remoteUrl : !form.path)}
              onClick={create}
            >
              {t("projects.create")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function ProjectDetailView({ projectId }: { projectId: string }) {
  const t = useT();
  const project = useAsync<any>(() => get(`/api/projects/${projectId}`), [projectId]);
  const tasks = useAsync<any[]>(() => get(`/api/projects/${projectId}/tasks`), [projectId]);
  const credentials = useAsync<any[]>(() => get("/api/source-credentials"), []);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: "",
    sourceType: "git" as "git" | "directory",
    remoteUrl: "",
    path: "",
    credentialId: "",
    defaultBranch: "",
  });
  const [busy, setBusy] = useState(false);
  /**
   * Deleting a Project throws away the only description of where the code comes
   * from; the tasks that ran from it stay, but the definition does not come back.
   * Ask first, like every other destructive action.
   *
   * Declared up here with the other hooks: the early returns below would
   * otherwise make the hook list depend on whether the project has loaded yet.
   */
  const [confirmRemove, setConfirmRemove] = useState(false);


  if (project.error) return <ErrorBox message={project.error} />;
  if (!project.data) return <div className="muted">{t("common.loading")}</div>;
  const p = project.data;
  const credential = (credentials.data ?? []).find((c) => c.id === p.source?.credentialId);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/projects/${projectId}`, {
        name: form.name,
        // The source type is part of the form: switching git ↔ directory is an
        // edit like any other, and `ProjectService` validates the new pairing.
        source:
          form.sourceType === "git"
            ? {
                type: "git",
                remoteUrl: form.remoteUrl,
                credentialId: form.credentialId || undefined,
                defaultBranch: form.defaultBranch || undefined,
              }
            : { type: "directory", path: form.path, defaultBranch: form.defaultBranch || undefined },
      });
      setEditing(false);
      project.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await del(`/api/projects/${projectId}`);
      navigate("/projects");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <button className="back-btn with-label" onClick={() => navigate("/projects")}>
        <Icon name="arrowLeft" size={14} /> {t("projects.title")}
      </button>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>{p.name}</h1>
        <span className="right">
          <button className="small" onClick={() => tasks.reload()}>{t("common.refresh")}</button>{" "}
          <button
            className="small"
            onClick={() => {
              setForm({
                name: p.name,
                sourceType: p.source?.type === "directory" ? "directory" : "git",
                remoteUrl: p.source?.remoteUrl ?? "",
                path: p.source?.path ?? "",
                credentialId: p.source?.credentialId ?? "",
                defaultBranch: p.source?.defaultBranch ?? "",
              });
              setEditing(true);
            }}
          >
            {t("common.edit")}
          </button>{" "}
          <button className="small danger" onClick={() => setConfirmRemove(true)}>{t("common.delete")}</button>{" "}
          <button className="small primary" onClick={() => navigate(`/projects/${projectId}/tasks/new`)}>{t("tasks.new")}</button>
        </span>
      </div>
      <ErrorBox message={error} />
      {confirmRemove && (
        <Modal title={t("projects.deleteTitle")} onClose={() => setConfirmRemove(false)}>
          <p>
            {t("projects.deleteQuestion", { name: p.name })}
          </p>
          <p className="muted">{t("projects.deleteBody")}</p>
          <div className="row-end">
            <button onClick={() => setConfirmRemove(false)}>{t("common.cancel")}</button>
            <button
              className="danger"
              onClick={() => {
                setConfirmRemove(false);
                void remove();
              }}
            >
              {t("projects.deleteConfirm")}
            </button>
          </div>
        </Modal>
      )}

      <div className="card">
        {/* dl/dt/dd: `.detail-list` is a two-column grid whose label/value
            split comes from the dt/dd elements (see ResourceView). Wrapper
            divs would collapse each pair into one cell and overlap. */}
        <dl className="detail-list">
          <dt>{p.source?.type === "directory" ? t("projects.detail.directory") : t("projects.detail.repository")}</dt>
          <dd className="mono">
            {p.source?.type === "directory" ? p.source?.path : p.source?.remoteUrl}
          </dd>
          <dt>{t("projects.detail.sourceType")}</dt>
          <dd>{p.source?.type === "directory" ? t("projects.detail.directorySource") : p.source?.provider ?? "git"}</dd>
          <dt>{t("projects.detail.defaultBranch")}</dt>
          <dd>{p.source?.defaultBranch ?? "-"}</dd>
          <dt>{t("projects.detail.credential")}</dt>
          <dd>
            {p.source?.type === "directory"
              ? t("projects.detail.credentialNA")
              : credential
                ? `${credential.name} (${credential.type}${credential.secretMasked ? ` · ${credential.secretMasked}` : ""})`
                : t("projects.detail.publicNoCredential")}
          </dd>
          <dt>{t("projects.detail.defaultRuntime")}</dt>
          <dd>{p.execution?.runtimeId ?? "-"}</dd>
          <dt>{t("projects.detail.defaultModel")}</dt>
          <dd>{p.execution?.modelId ?? "-"}</dd>
          <dt>{t("projects.detail.validation")}</dt>
          <dd>{p.validation?.prompt ?? t("common.none")}</dd>
          <dt>{t("projects.detail.publish")}</dt>
          <dd>
            autoCommit={String(p.git?.autoCommit ?? true)}{" "}
            {p.source?.type === "directory"
              ? t("projects.detail.pushNever")
              : `push=${String(p.git?.push ?? true)} remote=${p.git?.remote ?? "origin"}`}
          </dd>
          <dt>{t("projects.detail.skills")}</dt>
          <dd>{(p.skills ?? []).map((s: any) => s.name).join(", ") || t("common.none")}</dd>
          <dt>{t("projects.detail.mcp")}</dt>
          <dd>{(p.mcpServers ?? []).map((s: any) => s.name).join(", ") || t("common.none")}</dd>
        </dl>
      </div>

      <h2 style={{ marginTop: 20 }}>{t("projects.detail.tasks")}</h2>
      <ProjectTaskTable tasks={tasks.data ?? []} onAction={() => tasks.reload()} />

      {editing && (
        <Modal title={t("projects.editTitle")} onClose={() => setEditing(false)}>
          <div className="form-grid-2">
            <Field label={t("projects.field.name")}>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t("projects.field.source")}>
              <select
                value={form.sourceType}
                onChange={(e) => setForm({ ...form, sourceType: e.target.value as "git" | "directory" })}
              >
                <option value="git">{t("projects.field.gitRepository")}</option>
                <option value="directory">{t("projects.field.directory")}</option>
              </select>
            </Field>
            {form.sourceType === "directory" && (
              <Field label={t("projects.field.directoryPathShort")}>
                <input value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
              </Field>
            )}
            {form.sourceType === "git" && (
              <Field label={t("projects.field.repoUrl")}>
                <input value={form.remoteUrl} onChange={(e) => setForm({ ...form, remoteUrl: e.target.value })} />
              </Field>
            )}
            {form.sourceType === "git" && (
              <Field label={t("projects.field.credential")}>
                <select value={form.credentialId} onChange={(e) => setForm({ ...form, credentialId: e.target.value })}>
                  <option value="">{t("projects.field.publicNoCredential")}</option>
                  {(credentials.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t("projects.field.defaultBranch")}>
              <input value={form.defaultBranch} onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })} />
            </Field>
          </div>
          <div className="modal-actions">
            <button onClick={() => setEditing(false)}>{t("common.cancel")}</button>
            <button className="primary" disabled={busy} onClick={save}>{t("projects.save")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function NewProjectTaskView({ projectId }: { projectId: string }) {
  const t = useT();
  const project = useAsync<any>(() => get(`/api/projects/${projectId}`), [projectId]);
  // Isolated runtimes only: a Project Coding Task never falls back to a host
  // runtime, so the selector must not offer one (v11 hardening §4).
  const runtimes = useAsync<any[]>(() => get("/api/runtimes/project-eligible"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const [form, setForm] = useState({
    instruction: "",
    title: "",
    baseRef: "",
    workingBranch: "",
    branchMode: "new",
    runtimeId: "",
    modelId: "",
    // Chosen here, once: the Task owns it and every later run inherits it.
    lifecycle: "ephemeral",
    validation: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const validationPrompt = form.validation.trim();
      const result = await post<{ task: { id: string } }>(`/api/projects/${projectId}/tasks`, {
        instruction: form.instruction,
        title: form.title || undefined,
        baseRef: form.baseRef || undefined,
        workingBranch: form.workingBranch || undefined,
        branchMode: form.branchMode,
        runtimeId: form.runtimeId || undefined,
        modelId: form.modelId || undefined,
        lifecycle: { mode: form.lifecycle },
        // Empty = inherit the Project's validation; never an empty prompt.
        ...(validationPrompt ? { validation: { prompt: validationPrompt } } : {}),
      });
      navigate(`/tasks/${result.task.id}/lifecycle`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const defaultBranch = project.data?.source?.defaultBranch ?? "main";

  return (
    <div>
      <button className="back-btn with-label" onClick={() => navigate(`/projects/${projectId}`)}>
        <Icon name="arrowLeft" size={14} /> {project.data?.name ?? t("projects.title")}
      </button>
      <h1>{t("projects.newTaskTitle")}</h1>
      <p className="sub">
        {t("projects.newTaskSub")}
      </p>
      <ErrorBox message={error} />

      <div className="card">
        <Field label={t("projects.field.instruction")}>
          <textarea
            rows={5}
            value={form.instruction}
            onChange={(e) => setForm({ ...form, instruction: e.target.value })}
            placeholder={t("projects.field.instructionPlaceholder")}
          />
        </Field>
        <div className="form-grid-2">
          <Field label={t("projects.field.title")}>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t("projects.field.titlePlaceholder")} />
          </Field>
          <Field label={t("projects.field.baseRef", { branch: defaultBranch })}>
            <input value={form.baseRef} onChange={(e) => setForm({ ...form, baseRef: e.target.value })} placeholder={defaultBranch} />
          </Field>
          <Field label={t("projects.field.workingBranch")}>
            <input value={form.workingBranch} onChange={(e) => setForm({ ...form, workingBranch: e.target.value })} placeholder={t("projects.field.workingBranchPlaceholder")} />
          </Field>
          <Field label={t("projects.field.branchMode")}>
            <select value={form.branchMode} onChange={(e) => setForm({ ...form, branchMode: e.target.value })}>
              <option value="new">{t("projects.field.branchModeNew")}</option>
              <option value="continue">{t("projects.field.branchModeContinue")}</option>
            </select>
          </Field>
          <Field label={t("projects.field.runtimeOverride")}>
            <select value={form.runtimeId} onChange={(e) => setForm({ ...form, runtimeId: e.target.value })}>
              <option value="">{t("projects.field.projectDefault")}</option>
              {(runtimes.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({r.kind})</option>
              ))}
            </select>
          </Field>
          <Field label={t("projects.field.modelOverride")}>
            <select value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
              <option value="">{t("projects.field.projectDefault")}</option>
              {(models.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.alias ?? m.name}</option>
              ))}
            </select>
          </Field>
          <Field label={t("projects.field.lifecycle")}>
            <select value={form.lifecycle} onChange={(e) => setForm({ ...form, lifecycle: e.target.value })}>
              <option value="ephemeral">{t("projects.field.lifecycleEphemeral")}</option>
              <option value="keep-alive">{t("projects.field.lifecycleKeepAlive")}</option>
              <option value="persistent">{t("projects.field.lifecyclePersistent")}</option>
            </select>
          </Field>
        </div>
        <Field label={project.data?.validation?.prompt ? t("projects.field.validationOverrideKeep") : t("projects.field.validation")}>
          <textarea
            rows={3}
            value={form.validation}
            onChange={(e) => setForm({ ...form, validation: e.target.value })}
            placeholder={project.data?.validation?.prompt || t("projects.field.validationPlaceholder")}
          />
        </Field>
        <div className="modal-actions">
          <button onClick={() => navigate(`/projects/${projectId}`)}>{t("common.cancel")}</button>
          <button className="primary" disabled={busy || !form.instruction.trim()} onClick={start}>{t("projects.startTask")}</button>
        </div>
      </div>
    </div>
  );
}
