import { useState } from "react";
import { get, post, fmtRelative } from "../api";
import { ErrorBox, Icon, Modal, useAsync } from "../components";
import { HARNESS_THREAD_LIMIT, HARNESS_THREAD_SOURCES, type HarnessThreadSourceMeta } from "../harness";
import { navigate } from "../router";

/** Directory segments of a workspace path, ignoring a trailing slash. */
function workspaceDirSegments(ws: any): string[] {
  const path = typeof ws?.path === "string" ? ws.path : "";
  return path.split("/").filter(Boolean);
}

/**
 * Labels for the workspace filter: the last two segments of the directory,
 * so a nested repo stays tellable apart from the workspace it sits in
 * ("code-vision-workspace/agent" versus "code-vision-workspace"). The full
 * path is the option's title.
 */
export function workspaceLabels(workspaces: any[]): Map<string, string> {
  return new Map(
    workspaces.map((w: any) => {
      const segments = workspaceDirSegments(w);
      return [w.id, segments.slice(-2).join("/") || w?.name || "workspace"];
    })
  );
}

/**
 * Sessions (/sessions): local harness thread discovery (v6 §6/§11, v7
 * §9/§11) on its own page. Work that started in an external harness on
 * this machine — Claude Code sessions, Codex threads — is listed per
 * harness tab and adopted on demand: reading a thread never re-runs the
 * model; "Continue in AgentFabric" reads it, associates its workspace and
 * lands on the task thread, where a handoff can be generated explicitly
 * when the task needs a new native session.
 *
 * Creation stays on New task: this page is where existing local work is
 * found and taken over, not where a task is described.
 */
export function SessionsView() {
  const [kind, setKind] = useState<string>(HARNESS_THREAD_SOURCES[0].kind);
  const [workspaceChoice, setWorkspaceChoice] = useState("");
  const runtimes = useAsync<any[]>(() => get("/api/runtimes"), []);
  const workspaces = useAsync<any[]>(() => get("/api/workspaces"), []);

  const runtimeList = runtimes.data ?? [];
  const workspaceList = workspaces.data ?? [];
  // A workspace filter is an explicit choice here — the page starts with
  // every local thread, newest first, since it is not bound to the
  // workspace currently being composed for.
  const workspaceId = workspaceList.some((w: any) => w.id === workspaceChoice) ? workspaceChoice : "";

  const active = HARNESS_THREAD_SOURCES.find((s) => s.kind === kind) ?? HARNESS_THREAD_SOURCES[0];
  const enabledFor = (k: string) => runtimeList.some((r: any) => r.kind === k && r.enabled);
  const labels = workspaceLabels(workspaceList);

  return (
    <div className="new-task">
      <div className="row" style={{ marginBottom: 4 }}>
        <h1>Local harness sessions</h1>
        <span className="right">
          <button className="small" onClick={() => navigate("/new")}>New task</button>
        </span>
      </div>
      <p className="sub">
        Work that started outside AgentFabric, in a harness installed on this machine. Adopting a session reads
        its history — it never re-runs the model — so you can continue it here, and generate a handoff explicitly
        when it needs a new native session.
      </p>

      <div className="tab-bar">
        {HARNESS_THREAD_SOURCES.map((src) => (
          <button
            key={src.kind}
            className={`tab ${src.kind === active.kind ? "active" : ""}`}
            onClick={() => setKind(src.kind)}
          >
            {src.label} {src.noun}
          </button>
        ))}
      </div>

      <div className="sessions-filter">
        <select
          className="pill"
          value={workspaceId}
          onChange={(e) => setWorkspaceChoice(e.target.value)}
          title="Narrow discovery to one workspace's directory"
        >
          <option value="">All workspaces</option>
          {workspaceList.map((w: any) => (
            // The directory is the identity here (discovery filters on its
            // path), so label options by it and keep the full path in the
            // option's title — a workspace record's own name may be
            // anything, including a whole prompt.
            <option key={w.id} value={w.id} title={w.path ?? undefined}>
              {labels.get(w.id)}
            </option>
          ))}
        </select>
        <span className="muted">
          {workspaceId
            ? `Only sessions whose working directory is ${labels.get(workspaceId)}.`
            : `Newest local ${active.noun.toLowerCase()} across every workspace.`}
        </span>
      </div>

      {/* Each tab owns its data: switching away and back re-reads the harness. */}
      <HarnessThreadsPanel
        key={active.kind}
        source={active}
        enabled={enabledFor(active.kind)}
        workspaceId={workspaceId}
        workspaces={workspaceList}
        onAdopted={() => workspaces.reload()}
      />
    </div>
  );
}

/**
 * One harness's local sessions: auth availability (detection only, never
 * credentials — v6 §2, v7 §2), discovery, and adoption.
 */
function HarnessThreadsPanel({
  source,
  enabled,
  workspaceId,
  workspaces,
  onAdopted,
}: {
  source: HarnessThreadSourceMeta;
  enabled: boolean;
  workspaceId: string;
  workspaces: any[];
  onAdopted: () => void;
}) {
  const { kind, label, noun, hint } = source;
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // Adoption asks where the work belongs before it commits (v6 §8): the
  // cwd decides, and a session run in a scratch or nested directory must
  // not silently become a new workspace record.
  const [adopting, setAdopting] = useState<any | null>(null);

  const auth = useAsync<any>(() => get(`/api/harness/${kind}/auth-status`), [kind, enabled]);
  const threads = useAsync<any[]>(
    () =>
      enabled
        ? get(
            `/api/harness/${kind}/threads?limit=${HARNESS_THREAD_LIMIT}${workspaceId ? `&workspaceId=${workspaceId}` : ""}`
          )
        : Promise.resolve([]),
    [kind, enabled, workspaceId]
  );

  if (!enabled) {
    return (
      <div className="card muted">
        No enabled {label} runtime — enable it on the Runtimes page to discover local {noun.toLowerCase()} on this
        machine.
      </div>
    );
  }

  const adopt = async (thread: any, choice: { create: boolean; workspaceId?: string; name?: string }) => {
    setImporting(thread.id);
    setImportError(null);
    try {
      // Adopting reads the thread and opens the task thread — never the run
      // inspector (v5 §14, v6 §8). The workspace is the user's explicit
      // choice here, so the server never has to guess one.
      const r = await post<any>(`/api/harness/${kind}/threads/import`, {
        threadId: thread.id,
        workspaceId: choice.workspaceId,
        createWorkspaceName: choice.create ? choice.name : undefined,
      });
      navigate(`/tasks/${r.taskId}`);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
      setImporting(null);
      setAdopting(null);
    }
  };

  const list = threads.data ?? [];

  return (
    <div>
      <div className="row">
        <span className="muted">
          Work that started {hint}.
        </span>
        <span className="right">
          <button className="small" onClick={() => { threads.reload(); auth.reload(); }}>Refresh</button>
        </span>
      </div>

      {/* Harness-native auth availability — detection only, never credentials. */}
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
        <div className="muted">
          No local {label} {noun.toLowerCase()} found{workspaceId ? " in this workspace" : ""}.
        </div>
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
                  {t.source && <span> · {t.source}</span>}
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
                    title="Read this session, choose its workspace and continue it as an AgentFabric task"
                    onClick={() => setAdopting(t)}
                  >
                    {importing === t.id ? <span className="spinner" /> : "Continue in AgentFabric"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {adopting && (
        <AdoptThreadModal
          source={source}
          thread={adopting}
          workspaces={workspaces}
          busy={importing === adopting.id}
          onCancel={() => setAdopting(null)}
          onConfirm={(choice) => adopt(adopting, choice)}
        />
      )}
    </div>
  );
}

/**
 * Where the adopted session's work belongs (v6 §8 "Associate Workspace").
 * Adoption reads a session that ran somewhere on this machine, and that
 * directory is the one judgement the user is better at than we are: it may
 * already be a workspace, it may be a scratch directory that deserves no
 * record at all, or it may be new. Everything here is explicit — the
 * server is told which of the three, and never guesses.
 */
function AdoptThreadModal({
  source,
  thread,
  workspaces,
  busy,
  onCancel,
  onConfirm,
}: {
  source: HarnessThreadSourceMeta;
  thread: any;
  workspaces: any[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: { create: boolean; workspaceId?: string; name?: string }) => void;
}) {
  const cwd: string | undefined = typeof thread.cwd === "string" && thread.cwd ? thread.cwd : undefined;
  const segments = cwd ? cwd.split("/").filter(Boolean) : [];
  const takenNames = new Set(workspaces.map((w: any) => w.name));
  let suggested = segments[segments.length - 1] ?? "";
  for (let n = 2; takenNames.has(suggested); n++) suggested = `${segments[segments.length - 1]}-${n}`;

  const exact = cwd ? workspaces.find((w: any) => w.path === cwd) : undefined;
  const [name, setName] = useState(suggested);
  const [mode, setMode] = useState<"create" | "reuse" | "none">(exact ? "reuse" : "create");
  const [reuseId, setReuseId] = useState<string>(exact?.id ?? workspaces[0]?.id ?? "");

  const labels = workspaceLabels(workspaces);
  const reuse = workspaces.find((w: any) => w.id === reuseId);
  // The server takes `workspaceId` for reuse and `createWorkspaceName` for a
  // new record; neither means "adopt without a workspace".
  const choice =
    mode === "reuse" && reuse
      ? { create: false, workspaceId: reuse.id }
      : mode === "create" && name.trim()
        ? { create: true, name: name.trim() }
        : { create: false };

  return (
    <Modal title={`Continue ${source.label} ${source.noun.toLowerCase()}`} onClose={onCancel}>
      <div className="adopt-thread">
        <div className="adopt-thread-title">{thread.title ?? thread.id}</div>
        {thread.preview && <div className="muted adopt-thread-preview">{thread.preview}</div>}
        <div className="adopt-thread-cwd">
          <span className="muted">Working directory</span>
          {cwd ? <code title={cwd}>{cwd}</code> : <em>not recorded in this session's transcript</em>}
        </div>

        {cwd ? (
          <>
            <label className="adopt-choice">
              <input type="radio" checked={mode === "create"} onChange={() => setMode("create")} />
              <span>
                New workspace
                <input
                  type="text"
                  value={name}
                  disabled={mode !== "create"}
                  onChange={(e) => setName(e.target.value)}
                  title="Name for the new workspace record — the directory itself is used in place"
                />
              </span>
            </label>
            <label className="adopt-choice">
              <input
                type="radio"
                checked={mode === "reuse"}
                disabled={workspaces.length === 0}
                onChange={() => setMode("reuse")}
              />
              <span>
                Existing workspace
                <select
                  value={reuseId}
                  disabled={mode !== "reuse" || workspaces.length === 0}
                  onChange={(e) => setReuseId(e.target.value)}
                >
                  {workspaces.map((w: any) => (
                    <option key={w.id} value={w.id} title={w.path ?? undefined}>
                      {labels.get(w.id)}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          </>
        ) : (
          <p className="muted">
            This session never recorded a working directory, so there is nothing to associate.
          </p>
        )}

        <label className="adopt-choice">
          <input type="radio" checked={mode === "none"} onChange={() => setMode("none")} />
          <span>
            No workspace
            <span className="muted">
              Adopt the history only. Continuing it later runs without a working directory.
            </span>
          </span>
        </label>

        {mode === "reuse" && reuse && reuse.path !== cwd && (
          <p className="muted adopt-note">
            The session ran in {cwd ?? "—"}, this workspace points at {reuse.path}. Continuing it there keeps the
            workspace's directory, not the session's.
          </p>
        )}

        <div className="row adopt-actions">
          <span className="right">
            <button className="small" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="small primary" onClick={() => onConfirm(choice)} disabled={busy || (mode === "create" && !name.trim())}>
              {busy ? <span className="spinner" /> : "Continue"}
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
