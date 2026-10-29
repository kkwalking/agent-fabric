import { useState } from "react";
import { get, post, fmtRelative } from "../api";
import { ErrorBox, Modal, useAsync } from "../components";
import { HARNESS_THREAD_LIMIT, HARNESS_THREAD_SOURCES, type HarnessThreadSourceMeta } from "../harness";
import { useI18n } from "../i18n-react";
import { navigate } from "../router";

/** What a harness calls its local work: Codex "Threads", everything else "Sessions". */
function nounKey(noun: string): "sessions.noun.codex" | "sessions.noun.session" {
  return noun === "Threads" ? "sessions.noun.codex" : "sessions.noun.session";
}

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
export function workspaceLabels(workspaces: any[], fallback = "workspace"): Map<string, string> {
  return new Map(
    workspaces.map((w: any) => {
      const segments = workspaceDirSegments(w);
      return [w.id, segments.slice(-2).join("/") || w?.name || fallback];
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
  const { t } = useI18n();
  const [kind, setKind] = useState<string>(HARNESS_THREAD_SOURCES[0].kind);
  const [workspaceChoice, setWorkspaceChoice] = useState("");
  /** 递增触发当前 tab 的 threads / auth 重新读取。 */
  const [reloadSeq, setReloadSeq] = useState(0);
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
  const labels = workspaceLabels(workspaceList, t("sessions.filter.workspaceFallback"));

  return (
    <div className="new-task">
      <h1>{t("sessions.title")}</h1>
      <p className="sub">{t("sessions.subtitle")}</p>

      <div className="tab-bar">
        {HARNESS_THREAD_SOURCES.map((src) => (
          <button
            key={src.kind}
            className={`tab ${src.kind === active.kind ? "active" : ""}`}
            onClick={() => setKind(src.kind)}
          >
            {src.label} {t(nounKey(src.noun))}
          </button>
        ))}
      </div>

      <div className="sessions-filter">
        <select
          className="pill"
          value={workspaceId}
          onChange={(e) => setWorkspaceChoice(e.target.value)}
          title={t("sessions.filter.title")}
        >
          <option value="">{t("sessions.filter.all")}</option>
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
        <span className="right">
          <button className="small" onClick={() => setReloadSeq((s) => s + 1)}>{t("common.refresh")}</button>
        </span>
      </div>

      {/* Each tab owns its data: switching away and back re-reads the harness. */}
      <HarnessThreadsPanel
        key={active.kind}
        source={active}
        enabled={enabledFor(active.kind)}
        workspaceId={workspaceId}
        workspaces={workspaceList}
        reloadSeq={reloadSeq}
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
  reloadSeq,
  onAdopted,
}: {
  source: HarnessThreadSourceMeta;
  enabled: boolean;
  workspaceId: string;
  workspaces: any[];
  /** 父级 Refresh 按钮的递增序号，进入 deps 触发重读。 */
  reloadSeq: number;
  onAdopted: () => void;
}) {
  const { t } = useI18n();
  const { kind, label, noun } = source;
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // Adoption asks where the work belongs before it commits (v6 §8): the
  // cwd decides, and a session run in a scratch or nested directory must
  // not silently become a new workspace record.
  const [adopting, setAdopting] = useState<any | null>(null);

  const auth = useAsync<any>((force) => get(`/api/harness/${kind}/auth-status`, undefined, force), [kind, enabled, reloadSeq]);
  const threads = useAsync<any[]>(
    () =>
      enabled
        ? get(
            `/api/harness/${kind}/threads?limit=${HARNESS_THREAD_LIMIT}${workspaceId ? `&workspaceId=${workspaceId}` : ""}`
          )
        : Promise.resolve([]),
    [kind, enabled, workspaceId, reloadSeq]
  );

  if (!enabled) {
    return (
      <div className="card muted">
        {t("sessions.disabled", { label, noun: t(nounKey(noun)).toLowerCase() })}
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
      {/* Harness-native auth availability — detection only, never credentials. */}
      {auth.data && !auth.data.ok && (
        <div className="card auth-hint">
          <strong>
            {auth.data.installed
              ? t("sessions.auth.notLoggedIn", { label })
              : t("sessions.auth.notInstalled", { label })}
          </strong>
          <div className="muted">{auth.data.hint ?? t("sessions.auth.hint", { label })}</div>
        </div>
      )}
      <ErrorBox message={threads.error ? t("sessions.error.discovery", { label, error: threads.error }) : null} />
      <ErrorBox message={importError} />

      {threads.loading ? (
        <div className="muted">{t("sessions.loading", { label, noun: t(nounKey(noun)).toLowerCase() })}</div>
      ) : list.length === 0 && !threads.error ? (
        <div className="muted">
          {workspaceId
            ? t("sessions.empty.inWorkspace", { label, noun: t(nounKey(noun)).toLowerCase() })
            : t("sessions.empty", { label, noun: t(nounKey(noun)).toLowerCase() })}
        </div>
      ) : (
        <div className="thread-items">
          {list.map((item: any) => (
            <div key={item.id} className={`thread-item${item.adopted ? " adopted" : ""}`}>
              <div className="thread-item-main">
                <div className="thread-item-title" title={item.preview ?? item.title ?? item.id}>
                  {item.title ?? item.id}
                </div>
                <div className="thread-item-meta muted">
                  {item.cwd ? <span title={item.cwd}>{item.cwd.split("/").slice(-2).join("/")}</span> : <span>{t("sessions.row.noWorkspace")}</span>}
                  {item.updatedAt && <span> · {t("sessions.row.updated", { when: fmtRelative(t, item.updatedAt) })}</span>}
                  {item.turnCount != null && (
                    <span>
                      {" · "}
                      {item.turnCount === 1
                        ? t("sessions.row.turns", { n: item.turnCount })
                        : t("sessions.row.turnsPlural", { n: item.turnCount })}
                    </span>
                  )}
                  {item.model && <span> · {item.model}</span>}
                  {item.source && <span> · {item.source}</span>}
                </div>
              </div>
              <div className="thread-item-actions">
                {item.adopted ? (
                  <button className="small" onClick={() => navigate(`/tasks/${item.adoptedTaskId}`)}>
                    {t("sessions.row.inFabric")}
                  </button>
                ) : (
                  <button
                    className="small primary"
                    disabled={importing !== null}
                    title={t("sessions.row.continueTip")}
                    onClick={() => setAdopting(item)}
                  >
                    {importing === item.id ? <span className="spinner" /> : t("sessions.row.continue")}
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
 * already be a workspace, or it may be new. Every adoption therefore lands
 * the task in a workspace — continuing a session means continuing it in its
 * directory, so there is no "no workspace" adoption. The server is told
 * which of the two, and never guesses.
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
  const { t } = useI18n();
  const cwd: string | undefined = typeof thread.cwd === "string" && thread.cwd ? thread.cwd : undefined;
  const segments = cwd ? cwd.split("/").filter(Boolean) : [];
  const takenNames = new Set(workspaces.map((w: any) => w.name));
  let suggested = segments[segments.length - 1] ?? "";
  for (let n = 2; takenNames.has(suggested); n++) suggested = `${segments[segments.length - 1]}-${n}`;

  const exact = cwd ? workspaces.find((w: any) => w.path === cwd) : undefined;
  // A session whose directory already has a workspace leaves nothing to choose:
  // continuing it means continuing it in that record. Offering "new workspace"
  // there only ever produced a second record for one directory, which the server
  // now refuses (`workspace-duplicate`), so the form fixes the choice instead.
  const locked = exact !== undefined;
  const [name, setName] = useState(suggested);
  const [mode, setMode] = useState<"create" | "reuse">(exact ? "reuse" : "create");
  const [reuseId, setReuseId] = useState<string>(exact?.id ?? workspaces[0]?.id ?? "");

  const labels = workspaceLabels(workspaces, t("sessions.filter.workspaceFallback"));
  const reuse = workspaces.find((w: any) => w.id === reuseId);
  // The server takes `workspaceId` for reuse and `createWorkspaceName` for a
  // new record — one of them, always: adoption without a workspace is not a
  // case the form offers, so a thread with no recorded directory has nothing
  // to continue in and stays unadoptable.
  const choice = locked
    ? { create: false, workspaceId: exact.id }
    : mode === "reuse" && reuse
      ? { create: false, workspaceId: reuse.id }
      : { create: true, name: name.trim() };

  return (
    <Modal
      title={t("sessions.adopt.title", { label: source.label, noun: t(nounKey(source.noun)).toLowerCase() })}
      onClose={onCancel}
    >
      <div className="adopt-thread">
        <div className="adopt-thread-title">{thread.title ?? thread.id}</div>
        {thread.preview && <div className="muted adopt-thread-preview">{thread.preview}</div>}
        <div className="adopt-thread-cwd">
          <span className="muted">{t("sessions.adopt.cwd")}</span>
          {cwd ? <code title={cwd}>{cwd}</code> : <em>{t("sessions.adopt.cwdMissing")}</em>}
        </div>

        {cwd ? (
          locked ? (
            /* The session's directory is already a workspace, and the
               continuation belongs to that record: one row, nothing to edit. */
            <div className="adopt-choice adopt-choice-fixed">
              <span>
                {t("sessions.adopt.existing")}
                <span className="adopt-fixed">
                  {labels.get(exact.id) ?? exact.name}
                  <span className="muted">{t("sessions.adopt.fixedHint")}</span>
                </span>
              </span>
            </div>
          ) : (
            <>
              <label className="adopt-choice">
                <input type="radio" checked={mode === "create"} onChange={() => setMode("create")} />
                <span>
                  {t("sessions.adopt.newWorkspace")}
                  <input
                    type="text"
                    value={name}
                    disabled={mode !== "create"}
                    onChange={(e) => setName(e.target.value)}
                    title={t("sessions.adopt.newWorkspaceTip")}
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
                  {t("sessions.adopt.existing")}
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
          )
        ) : (
          <p className="muted">{t("sessions.adopt.noCwd")}</p>
        )}

        {mode === "reuse" && reuse && reuse.path !== cwd && (
          <p className="muted adopt-note">
            {t("sessions.adopt.mismatch", { cwd: cwd ?? "—", path: reuse.path })}
          </p>
        )}

        <div className="row adopt-actions">
          <span className="right">
            <button className="small" onClick={onCancel} disabled={busy}>{t("common.cancel")}</button>
            <button className="small primary" onClick={() => onConfirm(choice)} disabled={busy || !cwd || (!locked && mode === "create" && !name.trim())}>
              {busy ? <span className="spinner" /> : t("sessions.adopt.continue")}
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
