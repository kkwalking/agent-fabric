import { useEffect, useMemo, useRef, useState } from "react";
import { del, fmtRelative, get, patch, put } from "../api";
import { Icon } from "../components";
import { useT } from "../i18n-react";
import { navigate } from "../router";

/**
 * The sidebar's workspace tree: every Task, grouped by the Workspace it
 * actually runs in, most recent first.
 *
 * Why a Workspace and not a Project: a Task has always carried the
 * `workspaceId` it runs in, whereas a Project is optional (a plain task has
 * none) and is only set for Project-sourced work. Grouping by the record the
 * Task really has keeps every task visible, and a Project-sourced Task still
 * lands under its Project because a Project's managed workspace is named after
 * it.
 *
 * The list is the primary navigation: opening the app shows it, and clicking a
 * row opens that Task. Each workspace shows its most recent few tasks with an
 * "expand" control, so a long history does not turn the rail into a scroll bar.
 */

/**
 * How many sessions a workspace shows, and how many more each click adds.
 *
 * A workspace collects every task that ever ran in it, so the list has to open
 * small. The first view is deliberately short; "show N more" then pages by ten,
 * matching how the reference UI reveals a long history without dumping it.
 */
const INITIAL_VISIBLE = 6;
const EXPAND_STEP = 10;

/**
 * Pinned sessions, kept in this browser.
 *
 * Pinning is a reading preference ("keep this one on top for me"), not a fact
 * about the task, so it does not belong in the store: no other client needs it
 * and the server would have to grow a field that only this list reads.
 */
const PINNED_KEY = "agentfabric.pinnedTasks";

function readPinned(): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PINNED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writePinned(pinned: Set<string>): void {
  try {
    window.localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned]));
  } catch {
    /* a preference that cannot be stored must not break the rail */
  }
}

interface TaskRow {
  id: string;
  title: string;
  workspaceId?: string;
  projectId?: string;
  createdAt?: string;
  metadata?: { lastActivityAt?: string };
}

interface WorkspaceRow {
  id: string;
  name: string;
  /**
   * The platform names a managed (per-task) workspace `"<project> / <title>"`.
   * Such a workspace is one task's scratch copy, not a place the user works
   * from, so its task belongs under the workspace the work actually came from.
   */
  ownership?: "managed" | "external";
  projectId?: string;
  path?: string;
}

interface Group {
  /** Workspace id, or "" for tasks that were never given one. */
  key: string;
  label: string;
  tasks: TaskRow[];
  /** Newest activity in the group, for ordering the groups themselves. */
  latest: number;
}

/**
 * The workspace (folder) a Task is listed under.
 *
 * A managed workspace belongs to exactly one task — the platform named it
 * `"<project> / <title>"` and only that task runs in it — so listing it as its
 * own folder would repeat the task's title as a heading and bury the real
 * workspaces. Such a task is filed under:
 *
 * 1. the external workspace of its Project, when the Project has one (that is
 *    where the user works from), else
 * 2. its Project, else
 * 3. the same managed copy only if neither exists — nothing better to say.
 */
function folderFor(task: TaskRow, byId: Map<string, WorkspaceRow>): string {
  const own = task.workspaceId ? byId.get(task.workspaceId) : undefined;
  // A dangling reference (the workspace record is gone) is not a folder of its
  // own: showing the bare id as a heading tells the user nothing. Such tasks
  // join the catch-all until they are given a workspace again.
  if (task.workspaceId && !own) return "";
  if (!own || own.ownership !== "managed") return task.workspaceId ?? "";

  // The Project a managed copy belongs to: its own `projectId`, or the one the
  // task carries (older copies may lack either).
  const projectId = task.projectId ?? own.projectId;

  // Preferred: the directory the user works in for that Project. An external
  // workspace references its Project two ways — by `projectId` on newer records,
  // and only by name on older ones, where the folder is named after the
  // repository (`bruce-go` for `.../bruce-go.git`). Matching only on
  // `projectId` is what used to split one project across two headings.
  const external = [...byId.values()].filter(
    (w) => w.ownership !== "managed" && w.id !== task.workspaceId
  );
  const byProject = projectId ? external.find((w) => w.projectId === projectId) : undefined;
  if (byProject) return byProject.id;

  const copyName = own.name ?? "";
  const projectName = copyName.includes(" / ") ? copyName.slice(0, copyName.indexOf(" / ")).trim() : "";
  const byName = projectName
    ? external.find((w) => (w.name ?? "").trim() === projectName)
    : undefined;
  if (byName) return byName.id;

  if (projectId) return `project:${projectId}`;
  return own.id;
}

/** The heading for a folder key produced by `folderFor`. */
function folderLabel(
  key: string,
  byId: Map<string, WorkspaceRow>,
  projects: Array<{ id: string; name: string }>,
  unfiled: string
): string {
  if (!key) return unfiled;
  if (key.startsWith("project:")) {
    const id = key.slice("project:".length);
    return projects.find((p) => p.id === id)?.name ?? id;
  }
  const workspace = byId.get(key);
  if (!workspace) return key;
  // Older external workspaces were created with the directory path as their
  // name. A heading is a label, not a location: show the last path segment, and
  // keep the full path in the tooltip.
  const name = workspace.name ?? "";
  if (name.includes("/") && workspace.path === name) {
    const segment = name.replace(/\/+$/, "").split("/").pop();
    if (segment) return segment;
  }
  return name || key;
}

/** A folder that comes from a Project (a repository or directory source). */
function isProjectFolder(key: string, byId: Map<string, WorkspaceRow>): boolean {
  if (key.startsWith("project:")) return true;
  return Boolean(byId.get(key)?.projectId);
}

/** The hover text for a folder heading: the full name or path behind it. */
function tooltipFor(key: string, byId: Map<string, WorkspaceRow>, projects: Array<{ id: string; name: string }>): string {
  // A Project folder has no directory of its own: its hover text is the project.
  if (key.startsWith("project:")) {
    return `Project · ${folderLabel(key, byId, projects, "")}`;
  }
  const workspace = byId.get(key);
  const full = workspace?.path ?? workspace?.name ?? key;
  return workspace?.name && workspace.path && workspace.name !== workspace.path
    ? `${workspace.name} — ${workspace.path}`
    : full;
}

/** Sorts by the newest sign of life a Task has: last activity, else creation. */
function taskTime(task: TaskRow): number {
  for (const raw of [task.metadata?.lastActivityAt, task.createdAt]) {
    if (!raw) continue;
    const time = Date.parse(raw);
    if (!Number.isNaN(time)) return time;
  }
  return 0;
}

/** The timestamp shown next to a row, in the same order as `taskTime`. */
function taskStamp(task: TaskRow): string | undefined {
  return task.metadata?.lastActivityAt ?? task.createdAt;
}

export function WorkspaceTaskList({
  activeTaskId,
  pinnedOnly = false,
  projectsOnly = false,
}: {
  activeTaskId?: string;
  /** Show only sessions this browser has pinned. */
  pinnedOnly?: boolean;
  /** Show only workspaces that are a Project (a git/directory source). */
  projectsOnly?: boolean;
} = {}) {
  const t = useT();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  // How many sessions each workspace is currently showing (absent = collapsed).
  const [shown, setShown] = useState<Record<string, number>>({});
  // Which groups are collapsed outright, hiding even the first few.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // The workspace whose ··· menu is open.
  const [groupMenuKey, setGroupMenuKey] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<Group | null>(null);
  const [groupRenameDraft, setGroupRenameDraft] = useState("");
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<Group | null>(null);
  const groupMenuRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(readPinned);
  // The row whose ··· menu is open, and the row being renamed.
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<TaskRow | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [rowError, setRowError] = useState<string | null>(null);
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  // A click anywhere outside the open menu closes it; Escape does too. The
  // menu is inside a scrolling rail, so a scrim would clip it.
  useEffect(() => {
    if (!menuTaskId && !groupMenuKey) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuTaskId && !menuRootRef.current?.contains(target)) setMenuTaskId(null);
      if (groupMenuKey && !groupMenuRef.current?.contains(target)) setGroupMenuKey(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuTaskId(null);
      setGroupMenuKey(null);
      setConfirmDeleteGroup(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuTaskId, groupMenuKey]);

  /**
   * Reloads everything the tree is built from, bypassing the GET cache.
   *
   * Tasks alone is not enough: renaming or deleting a workspace changes the
   * labels and the grouping, which come from `/api/workspaces` (and a Project's
   * name from `/api/projects`). Refreshing only the tasks left the old label on
   * screen after a rename.
   */
  const reload = async () => {
    const [taskRows, workspaceRows, projectRows] = await Promise.all([
      get<TaskRow[]>("/api/tasks", undefined, true).catch(() => null),
      get<WorkspaceRow[]>("/api/workspaces", undefined, true).catch(() => null),
      get<Array<{ id: string; name: string }>>("/api/projects", undefined, true).catch(() => null),
    ]);
    if (taskRows) setTasks(taskRows);
    if (workspaceRows) setWorkspaces(workspaceRows);
    if (projectRows) setProjects(projectRows);
  };

  const togglePinned = (id: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writePinned(next);
      return next;
    });
    setMenuTaskId(null);
  };

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setRowError(null);
    } catch {
      // Clipboard access can be denied; saying so beats a silent no-op.
      setRowError(t("sidebar.copyFailed"));
    }
    setMenuTaskId(null);
  };

  const removeTask = async (id: string) => {
    setMenuTaskId(null);
    try {
      await del(`/api/tasks/${id}`);
      await reload();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Renames the workspace record; its directory on disk is not touched. */
  const submitGroupRename = async () => {
    if (!renamingGroup) return;
    const name = groupRenameDraft.trim();
    if (!name) return;
    try {
      await put(`/api/workspaces/${renamingGroup.key}`, { name });
      setRenamingGroup(null);
      await reload();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * Deletes the workspace record only. Its sessions are kept — they lose their
   * `workspaceId`, so they gather under "Unfiled" instead of disappearing, which
   * is what the confirmation says. The directory on disk is left alone: deleting
   * a record must never delete someone's files.
   */
  const removeGroup = async (group: Group) => {
    setConfirmDeleteGroup(null);
    try {
      // Detach first: a task must never end up pointing at a workspace that no
      // longer exists, which would show up as a folder named after a raw id.
      for (const task of group.tasks) {
        if (task.workspaceId !== group.key) continue;
        await patch(`/api/tasks/${task.id}`, { workspaceId: "" });
      }
      await del(`/api/workspaces/${group.key}`);
      await reload();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
      await reload();
    }
  };

  const submitRename = async () => {
    if (!renaming) return;
    const title = renameDraft.trim();
    if (!title) return;
    try {
      await patch(`/api/tasks/${renaming.id}`, { title });
      setRenaming(null);
      await reload();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    // Both lists come from the cached GET layer, so remounting this component
    // (every navigation) does not cost a round trip.
    Promise.all([
      get<TaskRow[]>("/api/tasks"),
      get<WorkspaceRow[]>("/api/workspaces"),
      get<Array<{ id: string; name: string }>>("/api/projects"),
    ])
      .then(([taskRows, workspaceRows, projectRows]) => {
        if (cancelled) return;
        setTasks(taskRows ?? []);
        setWorkspaces(workspaceRows ?? []);
        setProjects(projectRows ?? []);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activeTaskId]);

  const workspacesById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);

  const groups = useMemo<Group[]>(() => {
    const byId = workspacesById;
    const buckets = new Map<string, TaskRow[]>();
    const shown = tasks.filter((task) => (pinnedOnly ? pinned.has(task.id) : true));
    for (const task of shown) {
      const key = folderFor(task, byId);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(task);
      else buckets.set(key, [task]);
    }
    const built: Group[] = [];
    for (const [key, bucket] of buckets) {
      // Pinned sessions float to the top of their workspace, then recency.
      bucket.sort((a, b) => {
        const pinA = pinned.has(a.id) ? 1 : 0;
        const pinB = pinned.has(b.id) ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;
        return taskTime(b) - taskTime(a);
      });
      built.push({
        key,
        label: folderLabel(key, byId, projects, t("sidebar.noWorkspace")),
        tasks: bucket,
        latest: bucket.length > 0 ? taskTime(bucket[0]) : 0,
      });
    }
    // Most recently active workspace first; the workspace-less bucket always
    // sits last because it is a catch-all rather than a place work happens.
    built.sort((a, b) => {
      if (a.key === "") return 1;
      if (b.key === "") return -1;
      return b.latest - a.latest;
    });
    // "Projects only" keeps the folders that are a Project source: either a
    // workspace a Project references, or a Project that has no directory yet.
    const filtered = projectsOnly ? built.filter((group) => isProjectFolder(group.key, byId)) : built;
    return filtered;
  }, [tasks, workspacesById, projects, pinned, pinnedOnly, projectsOnly, t]);

  if (error) {
    return (
      <div className="ws-tree-error" role="alert" title={error}>
        {t("sidebar.loadFailed")}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="ws-tree-empty">
        {tasks.length === 0 ? t("sidebar.noTasks") : t("sidebar.noMatches")}
      </div>
    );
  }

  return (
    <div className="ws-tree">
      {rowError && (
        <div className="ws-tree-error" role="alert" onClick={() => setRowError(null)} title={t("sidebar.dismiss")}>
          {rowError}
        </div>
      )}
      {groups.map((group) => {
        const isCollapsed = collapsed[group.key] ?? false;
        // A workspace opens with its first few sessions; each "show more" adds
        // another page of ten. A workspace smaller than one page shows all of it.
        const limit = shown[group.key] ?? INITIAL_VISIBLE;
        const visible = group.tasks.slice(0, limit);
        const hidden = group.tasks.length - visible.length;
        const groupMenuOpen = groupMenuKey === group.key;
        // Only a real workspace can be renamed or deleted: the catch-all bucket
        // is a view over unassigned tasks, and a Project-only folder has no
        // workspace record behind it.
        const editable = group.key !== "" && !group.key.startsWith("project:");
        return (
          <section className="ws-group" key={group.key || "(none)"}>
            <div
              ref={groupMenuOpen ? groupMenuRef : undefined}
              className={`ws-group-head ${isCollapsed ? "collapsed" : ""} ${groupMenuOpen ? "menu-open" : ""}`}
            >
              {/* A workspace heading is a *folder*, not a session: it carries a
                  folder icon (as the reference UI does) and the chevron that
                  says whether it is open, so the eye can tell the two levels
                  apart at a glance. Sessions below stay icon-less and indented. */}
              <button
                className="ws-group-toggle"
                onClick={() => {
                  setCollapsed((prev) => ({ ...prev, [group.key]: !isCollapsed }));
                  setGroupMenuKey(null);
                }}
                aria-expanded={!isCollapsed}
                title={isCollapsed ? t("sidebar.expandGroup") : t("sidebar.collapseGroup")}
              >
                {/* The folder icon is the disclosure affordance: open folder
                    when the group is expanded, closed when collapsed. A
                    separate chevron beside it was a second arrow saying the
                    same thing. */}
                <Icon name={isCollapsed ? "folder" : "folderOpen"} size={14} className="ws-group-folder" />
                <span className="ws-group-name">{group.label}</span>
                <span className="ws-group-count">{group.tasks.length}</span>
              </button>
              <button
                className="ws-group-more"
                aria-label={t("sidebar.groupActions")}
                title={t("sidebar.groupActions")}
                onClick={() => setGroupMenuKey((open) => (open === group.key ? null : group.key))}
              >
                <Icon name="more" size={14} />
              </button>
              {groupMenuOpen && (
                <div className="ws-task-menu ws-group-menu" role="menu">
                  <button role="menuitem" onClick={() => {
                    setGroupMenuKey(null);
                    setCollapsed((prev) => ({ ...prev, [group.key]: !isCollapsed }));
                  }}>
                    <Icon name={isCollapsed ? "folderOpen" : "folder"} size={13} />
                    {isCollapsed ? t("sidebar.expandGroup") : t("sidebar.collapseGroup")}
                  </button>
                  {editable && (
                    <button role="menuitem" onClick={() => {
                      setGroupMenuKey(null);
                      setRenamingGroup(group);
                      setGroupRenameDraft(group.label);
                    }}>
                      <Icon name="edit" size={13} />
                      {t("sidebar.renameWorkspace")}
                    </button>
                  )}
                  {editable && (
                    <button role="menuitem" className="danger" onClick={() => {
                      setGroupMenuKey(null);
                      setConfirmDeleteGroup(group);
                    }}>
                      <Icon name="trash" size={13} />
                      {t("sidebar.deleteWorkspace")}
                    </button>
                  )}
                </div>
              )}
            </div>
            {!isCollapsed && visible.map((task) => {
              const isPinned = pinned.has(task.id);
              const menuOpen = menuTaskId === task.id;
              return (
                <div
                  key={task.id}
                  ref={menuOpen ? menuRootRef : undefined}
                  className={`ws-task-row ${task.id === activeTaskId ? "active" : ""} ${menuOpen ? "menu-open" : ""}`}
                >
                  <button
                    className="ws-task"
                    onClick={() => navigate(`/tasks/${task.id}`)}
                    title={task.title}
                  >
                    <span className="ws-task-title">{task.title}</span>
                  </button>
                  {isPinned && (
                    <span className="ws-pin" title={t("sidebar.pinned")}>
                      <Icon name="star" size={12} />
                    </span>
                  )}
                  <span className="ws-task-time">{fmtRelative(t, taskStamp(task))}</span>
                  <button
                    className="ws-task-more"
                    aria-label={t("sidebar.rowActions")}
                    title={t("sidebar.rowActions")}
                    onClick={() => setMenuTaskId((open) => (open === task.id ? null : task.id))}
                  >
                    <Icon name="more" size={14} />
                  </button>
                  {menuOpen && (
                    <div className="ws-task-menu" role="menu">
                      <button role="menuitem" onClick={() => { setMenuTaskId(null); togglePinned(task.id); }}>
                        <Icon name="star" size={13} />
                        {isPinned ? t("sidebar.unpin") : t("sidebar.pin")}
                      </button>
                      <button role="menuitem" onClick={() => { setMenuTaskId(null); setRenaming(task); setRenameDraft(task.title); }}>
                        <Icon name="edit" size={13} />
                        {t("sidebar.rename")}
                      </button>
                      <button role="menuitem" onClick={() => void copyId(task.id)}>
                        <Icon name="close" size={13} />
                        {t("sidebar.copyId")}
                      </button>
                      <button role="menuitem" className="danger" onClick={() => void removeTask(task.id)}>
                        <Icon name="trash" size={13} />
                        {t("sidebar.delete")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {!isCollapsed && hidden > 0 && (
              <button
                className="ws-more"
                onClick={() => setShown((prev) => ({ ...prev, [group.key]: limit + EXPAND_STEP }))}
              >
                {t("sidebar.expandRest").replace("{n}", String(Math.min(hidden, EXPAND_STEP)))}
                {hidden > EXPAND_STEP ? ` (${hidden})` : ""}
              </button>
            )}
            {!isCollapsed && hidden === 0 && group.tasks.length > INITIAL_VISIBLE && (
              <button className="ws-more" onClick={() => setShown((prev) => ({ ...prev, [group.key]: INITIAL_VISIBLE }))}>
                {t("sidebar.collapseRest")}
              </button>
            )}
          </section>
        );
      })}

      {renamingGroup && (
        <div className="ws-rename" role="dialog" aria-modal="true" aria-label={t("sidebar.renameWorkspace")}>
          <label className="ws-rename-label">{t("sidebar.renameWorkspaceTitle")}</label>
          <input
            autoFocus
            value={groupRenameDraft}
            onChange={(e) => setGroupRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitGroupRename();
              if (e.key === "Escape") setRenamingGroup(null);
            }}
          />
          <div className="ws-rename-actions">
            <button onClick={() => setRenamingGroup(null)}>{t("sidebar.cancel")}</button>
            <button className="primary" disabled={!groupRenameDraft.trim()} onClick={() => void submitGroupRename()}>
              {t("sidebar.save")}
            </button>
          </div>
        </div>
      )}

      {confirmDeleteGroup && (
        <div className="ws-rename" role="dialog" aria-modal="true" aria-label={t("sidebar.deleteWorkspace")}>
          <p className="ws-rename-label">
            {t("sidebar.deleteWorkspaceConfirm")
              .replace("{name}", confirmDeleteGroup.label)
              .replace("{n}", String(confirmDeleteGroup.tasks.filter((x) => x.workspaceId === confirmDeleteGroup.key).length))}
          </p>
          <div className="ws-rename-actions">
            <button onClick={() => setConfirmDeleteGroup(null)}>{t("sidebar.cancel")}</button>
            <button className="danger" onClick={() => void removeGroup(confirmDeleteGroup)}>
              {t("sidebar.deleteWorkspace")}
            </button>
          </div>
        </div>
      )}

      {renaming && (
        <div className="ws-rename" role="dialog" aria-modal="true" aria-label={t("sidebar.rename")}>
          <label className="ws-rename-label">{t("sidebar.renameTitle")}</label>
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
          <div className="ws-rename-actions">
            <button onClick={() => setRenaming(null)}>{t("sidebar.cancel")}</button>
            <button className="primary" disabled={!renameDraft.trim()} onClick={() => void submitRename()}>
              {t("sidebar.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
