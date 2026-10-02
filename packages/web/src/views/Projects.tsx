import { useState } from "react";
import { del, get, post, put, fmtRelative, shortId } from "../api";
import { ErrorBox, Field, Icon, Modal, StatusBadge, useAsync } from "../components";
import { navigate } from "../router";

/**
 * Projects (v11 §2/§39): a Project is the long-lived codebase AgentFabric
 * develops against. It owns the Git source and the execution defaults every
 * Task inherits — it never holds a working copy (that is the Task's managed
 * Workspace) and never holds credential material (that is a Source
 * Credential, referenced by id).
 */

function parseValidationSteps(text: string): { name: string; command: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((command) => ({ name: command.split(/\s+/)[0] || "step", command }));
}

function lifecycleChips(task: any) {
  const execution = task.execution ?? {};
  const agent = execution.agent?.status;
  const validation = execution.validation?.status;
  const publish = execution.publish?.status;
  return (
    <>
      <span className="meta-chip"><span className="muted">phase</span> {execution.phase ?? "-"}</span>
      <span className="meta-chip"><span className="muted">agent</span> {agent ?? "-"}</span>
      <span className="meta-chip"><span className="muted">validation</span> {validation ?? "-"}</span>
      <span className="meta-chip"><span className="muted">publish</span> {publish ?? "-"}</span>
    </>
  );
}

function ProjectTaskTable({ tasks, onAction }: { tasks: any[]; onAction?: () => void }) {
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

  if (tasks.length === 0) return <div className="card muted">No tasks in this project yet.</div>;
  return (
    <div>
      <ErrorBox message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Working branch</th>
              <th>Phase</th>
              <th>Agent</th>
              <th>Validation</th>
              <th>Publish</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const execution = task.execution ?? {};
              const failure = execution.failure;
              const kind = failure?.stage;
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
                  <td>{execution.phase ?? "-"}</td>
                  <td>{execution.agent?.status ?? "-"}</td>
                  <td>{execution.validation?.status ?? "-"}</td>
                  <td>
                    {execution.publish?.status ?? "-"}
                    {execution.publish?.remoteBranch ? <div className="muted" style={{ fontSize: 12 }}>{execution.publish.remoteBranch}</div> : null}
                  </td>
                  <td className="muted">{fmtRelative(execution.updatedAt ?? task.createdAt)}</td>
                  <td className="actions">
                    <button className="small" onClick={() => navigate(`/tasks/${task.id}/lifecycle`)}>lifecycle</button>{" "}
                    {live && <button className="small danger" disabled={busy === task.id} onClick={() => act(task, "cancel")}>cancel</button>}
                    {!live && kind === "agent" && <button className="small" disabled={busy === task.id} onClick={() => act(task, "retry-run")}>retry run</button>}
                    {!live && kind === "validation" && <button className="small" disabled={busy === task.id} onClick={() => act(task, "retry-validation")}>retry validation</button>}
                    {!live && kind === "publish" && <button className="small" disabled={busy === task.id} onClick={() => act(task, "retry-publish")}>retry publish</button>}
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
  const projects = useAsync<any[]>(() => get("/api/projects"), []);
  const credentials = useAsync<any[]>(() => get("/api/source-credentials"), []);
  // Project Coding Tasks require an isolated runtime (v11 hardening §4), so
  // the project default may only be one of those. The server refuses the rest.
  const runtimes = useAsync<any[]>(() => get("/api/runtimes/project-eligible"), []);
  const models = useAsync<any[]>(() => get("/api/models"), []);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    remoteUrl: "",
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
      const steps = parseValidationSteps(form.validation);
      const project = await post<{ id: string }>("/api/projects", {
        name: form.name,
        source: {
          remoteUrl: form.remoteUrl,
          credentialId: form.credentialId || undefined,
          defaultBranch: form.defaultBranch || undefined,
        },
        execution: {
          runtimeId: form.runtimeId || undefined,
          modelId: form.modelId || undefined,
        },
        ...(steps.length ? { validation: { steps } } : {}),
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
        <h1>Projects</h1>
        <span className="right">
          <button className="small" onClick={() => projects.reload()}>refresh</button>{" "}
          <button className="small primary" onClick={() => setCreating(true)}>New project</button>
        </span>
      </div>
      <p className="sub">
        A Project is the codebase you keep working on: it binds a Git repository (and optionally a Source
        Credential) and provides the execution defaults every Task inherits. Tasks get their own managed
        Workspace and working branch automatically.
      </p>

      <ErrorBox message={error} />

      {(projects.data ?? []).length === 0 ? (
        <div className="card muted">
          No projects yet — create one with <a onClick={() => setCreating(true)}>New project</a>.
        </div>
      ) : (
        <div className="task-list">
          {(projects.data ?? []).map((project) => (
            <div key={project.id} className="task-item card" onClick={() => navigate(`/projects/${project.id}`)}>
              <div className="task-item-main">
                <div className="task-item-head">
                  <strong className="task-item-title">{project.name}</strong>
                </div>
                <div className="task-item-meta">
                  <span className="meta-chip">{project.source?.remoteUrl}</span>
                  <span className="meta-chip">
                    <span className="muted">branch</span> {project.source?.defaultBranch ?? "-"}
                  </span>
                  <span className="meta-chip">
                    <span className="muted">credential</span> {project.source?.credentialId ? "configured" : "public"}
                  </span>
                  <span className="meta-chip">
                    <span className="muted">validation</span> {project.validation?.steps?.length ?? 0}
                  </span>
                </div>
              </div>
              <div className="task-item-side">
                <span className="muted task-item-time">{project.source?.provider ?? "-"}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal title="New project" onClose={() => setCreating(false)}>
          <div className="form-grid-2">
            <Field label="Name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="agent-fabric" />
            </Field>
            <Field label="Repository URL">
              <input
                value={form.remoteUrl}
                onChange={(e) => setForm({ ...form, remoteUrl: e.target.value })}
                placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
              />
            </Field>
            <Field label="Credential (optional — public repositories need none)">
              <select value={form.credentialId} onChange={(e) => setForm({ ...form, credentialId: e.target.value })}>
                <option value="">(public / no credential)</option>
                {(credentials.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.type}{c.host ? ` · ${c.host}` : ""})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Default branch">
              <input value={form.defaultBranch} onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })} />
            </Field>
            <Field label="Default runtime (optional — isolated runtimes only)">
              <select value={form.runtimeId} onChange={(e) => setForm({ ...form, runtimeId: e.target.value })}>
                <option value="">(choose per task)</option>
                {(runtimes.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>{r.name} ({r.kind})</option>
                ))}
              </select>
            </Field>
            <Field label="Default model (optional)">
              <select value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
                <option value="">(runtime default)</option>
                {(models.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>{m.alias ?? m.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Validation (one command per line — typecheck / test / lint / build)">
            <textarea
              rows={3}
              value={form.validation}
              onChange={(e) => setForm({ ...form, validation: e.target.value })}
              placeholder={"npm run typecheck\nnpm test"}
            />
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.autoCommit} onChange={(e) => setForm({ ...form, autoCommit: e.target.checked })} />
            Commit the agent's remaining changes automatically
          </label>
          <label className="check">
            <input type="checkbox" checked={form.push} onChange={(e) => setForm({ ...form, push: e.target.checked })} />
            Push the working branch when the task completes
          </label>
          <div className="modal-actions">
            <button onClick={() => setCreating(false)}>Cancel</button>
            <button className="primary" disabled={busy || !form.name || !form.remoteUrl} onClick={create}>Create</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function ProjectDetailView({ projectId }: { projectId: string }) {
  const project = useAsync<any>(() => get(`/api/projects/${projectId}`), [projectId]);
  const tasks = useAsync<any[]>(() => get(`/api/projects/${projectId}/tasks`), [projectId]);
  const credentials = useAsync<any[]>(() => get("/api/source-credentials"), []);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", remoteUrl: "", credentialId: "", defaultBranch: "" });
  const [busy, setBusy] = useState(false);

  if (project.error) return <ErrorBox message={project.error} />;
  if (!project.data) return <div className="muted">Loading…</div>;
  const p = project.data;
  const credential = (credentials.data ?? []).find((c) => c.id === p.source?.credentialId);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/projects/${projectId}`, {
        name: form.name,
        source: {
          remoteUrl: form.remoteUrl,
          credentialId: form.credentialId || undefined,
          defaultBranch: form.defaultBranch || undefined,
        },
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
      <button className="back-btn" onClick={() => navigate("/projects")}>
        <Icon name="arrowLeft" size={14} /> Projects
      </button>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>{p.name}</h1>
        <span className="right">
          <button className="small" onClick={() => tasks.reload()}>refresh</button>{" "}
          <button
            className="small"
            onClick={() => {
              setForm({
                name: p.name,
                remoteUrl: p.source?.remoteUrl ?? "",
                credentialId: p.source?.credentialId ?? "",
                defaultBranch: p.source?.defaultBranch ?? "",
              });
              setEditing(true);
            }}
          >
            edit
          </button>{" "}
          <button className="small danger" onClick={remove}>delete</button>{" "}
          <button className="small primary" onClick={() => navigate(`/projects/${projectId}/tasks/new`)}>New task</button>
        </span>
      </div>
      <ErrorBox message={error} />

      <div className="card">
        <div className="detail-list">
          <div><span className="muted">Repository</span><span>{p.source?.remoteUrl}</span></div>
          <div><span className="muted">Provider</span><span>{p.source?.provider ?? "-"}</span></div>
          <div><span className="muted">Default branch</span><span>{p.source?.defaultBranch ?? "-"}</span></div>
          <div>
            <span className="muted">Credential</span>
            <span>
              {credential ? `${credential.name} (${credential.type}${credential.secretMasked ? ` · ${credential.secretMasked}` : ""})` : "public — no credential"}
            </span>
          </div>
          <div><span className="muted">Default runtime</span><span>{p.execution?.runtimeId ?? "-"}</span></div>
          <div><span className="muted">Default model</span><span>{p.execution?.modelId ?? "-"}</span></div>
          <div>
            <span className="muted">Validation</span>
            <span>{(p.validation?.steps ?? []).map((s: any) => s.command).join(" · ") || "none"}</span>
          </div>
          <div>
            <span className="muted">Publish</span>
            <span>
              autoCommit={String(p.git?.autoCommit ?? true)} push={String(p.git?.push ?? true)} remote={p.git?.remote ?? "origin"}
            </span>
          </div>
          <div><span className="muted">Skills</span><span>{(p.skills ?? []).map((s: any) => s.name).join(", ") || "none"}</span></div>
          <div><span className="muted">MCP servers</span><span>{(p.mcpServers ?? []).map((s: any) => s.name).join(", ") || "none"}</span></div>
        </div>
      </div>

      <h2 style={{ marginTop: 20 }}>Tasks</h2>
      <ProjectTaskTable tasks={tasks.data ?? []} onAction={() => tasks.reload()} />

      {editing && (
        <Modal title="Edit project" onClose={() => setEditing(false)}>
          <div className="form-grid-2">
            <Field label="Name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Repository URL">
              <input value={form.remoteUrl} onChange={(e) => setForm({ ...form, remoteUrl: e.target.value })} />
            </Field>
            <Field label="Credential (optional)">
              <select value={form.credentialId} onChange={(e) => setForm({ ...form, credentialId: e.target.value })}>
                <option value="">(public / no credential)</option>
                {(credentials.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Default branch">
              <input value={form.defaultBranch} onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })} />
            </Field>
          </div>
          <div className="modal-actions">
            <button onClick={() => setEditing(false)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={save}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function NewProjectTaskView({ projectId }: { projectId: string }) {
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
    validation: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const steps = parseValidationSteps(form.validation);
      const result = await post<{ task: { id: string } }>(`/api/projects/${projectId}/tasks`, {
        instruction: form.instruction,
        title: form.title || undefined,
        baseRef: form.baseRef || undefined,
        workingBranch: form.workingBranch || undefined,
        branchMode: form.branchMode,
        runtimeId: form.runtimeId || undefined,
        modelId: form.modelId || undefined,
        ...(steps.length ? { validation: { steps } } : {}),
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
      <button className="back-btn" onClick={() => navigate(`/projects/${projectId}`)}>
        <Icon name="arrowLeft" size={14} /> {project.data?.name ?? "Project"}
      </button>
      <h1>New task</h1>
      <p className="sub">
        AgentFabric creates a managed Workspace for this task, clones the repository, checks out the base ref,
        creates the working branch and then runs the agent in an isolated runtime — validation runs in an
        isolated runtime too, and the source credential never enters the agent's environment. You never create
        a workspace by hand.
      </p>
      <ErrorBox message={error} />

      <div className="card">
        <Field label="Task instruction">
          <textarea
            rows={5}
            value={form.instruction}
            onChange={(e) => setForm({ ...form, instruction: e.target.value })}
            placeholder="Describe what the agent should change…"
          />
        </Field>
        <div className="form-grid-2">
          <Field label="Title (optional)">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="derived from the instruction" />
          </Field>
          <Field label={`Base ref (default: ${defaultBranch})`}>
            <input value={form.baseRef} onChange={(e) => setForm({ ...form, baseRef: e.target.value })} placeholder={defaultBranch} />
          </Field>
          <Field label="Working branch (leave empty to generate af/<task>-<slug>)">
            <input value={form.workingBranch} onChange={(e) => setForm({ ...form, workingBranch: e.target.value })} placeholder="auto-generated" />
          </Field>
          <Field label="Branch mode">
            <select value={form.branchMode} onChange={(e) => setForm({ ...form, branchMode: e.target.value })}>
              <option value="new">new — create a fresh branch (never overwrites an existing one)</option>
              <option value="continue">continue — build on an existing branch explicitly</option>
            </select>
          </Field>
          <Field label="Runtime override (optional — isolated runtimes only)">
            <select value={form.runtimeId} onChange={(e) => setForm({ ...form, runtimeId: e.target.value })}>
              <option value="">(project default)</option>
              {(runtimes.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({r.kind})</option>
              ))}
            </select>
          </Field>
          <Field label="Model override (optional)">
            <select value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
              <option value="">(project default)</option>
              {(models.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.alias ?? m.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Validation override (one command per line — replaces the project's)">
          <textarea rows={2} value={form.validation} onChange={(e) => setForm({ ...form, validation: e.target.value })} />
        </Field>
        <div className="modal-actions">
          <button onClick={() => navigate(`/projects/${projectId}`)}>Cancel</button>
          <button className="primary" disabled={busy || !form.instruction.trim()} onClick={start}>Start task</button>
        </div>
      </div>
    </div>
  );
}
