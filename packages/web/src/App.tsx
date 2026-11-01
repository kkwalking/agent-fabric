import { Suspense, lazy, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon, IconName } from "./components";
import { LanguageContext, useLanguageState } from "./i18n-react";
import type { MessageKey } from "./i18n";
import { navigate, parsePath, usePath, type Route, type SettingsSection } from "./router";
import { BrandMark } from "./brand";
import { WorkspaceTaskList } from "./views/WorkspaceTaskList";
import { RailMenu } from "./views/RailMenu";

/**
 * Every view is its own chunk: the shell (sidebar, router) is what a page load
 * pays for, and a view costs one small request when it is opened. Keeping them
 * eager put all ~20 views — and whatever they import — into the file the window
 * must parse before it can paint anything.
 *
 * The Board is separate twice over: it pulls in xterm, the largest dependency
 * in the app (v13 §七 asks for a dedicated terminal chunk).
 */
const load = <T extends Record<string, unknown>, K extends keyof T>(
  importer: () => Promise<T>,
  name: K
): React.LazyExoticComponent<React.ComponentType<any>> =>
  lazy(async () => ({ default: (await importer())[name] as React.ComponentType<any> }));

const ResourceView = load(() => import("./views/ResourceView"), "ResourceView");
const RunsView = load(() => import("./views/Runs"), "RunsView");
const RunDetailView = load(() => import("./views/Runs"), "RunDetailView");
const TasksView = load(() => import("./views/Tasks"), "TasksView");
const TrashView = load(() => import("./views/Trash"), "TrashView");
const NewTaskView = load(() => import("./views/NewTask"), "NewTaskView");
const SessionsView = load(() => import("./views/Sessions"), "SessionsView");
const TaskThreadView = load(() => import("./views/TaskThread"), "TaskThreadView");
const HandoffsView = load(() => import("./views/Handoffs"), "HandoffsView");
const HandoffDetailView = load(() => import("./views/Handoffs"), "HandoffDetailView");
const UsageView = load(() => import("./views/Usage"), "UsageView");
// The settings panel is its own chunk: it is opened deliberately, and it is
// the only view that writes the configuration file.
const SettingsPanel = load(() => import("./views/Settings"), "SettingsView");
const TaskLifecycleView = load(() => import("./views/TaskLifecycle"), "TaskLifecycleView");
const KanbanView = load(() => import("./views/Board"), "BoardView");
const NewWorkspaceDialog = load(() => import("./components/board/AddWorkspaceDialog"), "AddWorkspaceDialog");

/**
 * The view importers, by route. Kept so the chunks a user is likely to open
 * next can be fetched while the window is idle: navigation then swaps content
 * instead of first waiting for a request. The Board is left out on purpose —
 * it carries xterm and is only worth loading when it is actually opened.
 */
const VIEW_IMPORTERS: Array<() => Promise<unknown>> = [
  () => import("./views/Tasks"),
  () => import("./views/NewTask"),
  () => import("./views/Runs"),
  () => import("./views/Llm"),
  () => import("./views/ResourceView"),
  () => import("./views/Sessions"),
  () => import("./views/Handoffs"),
  () => import("./views/Usage"),
];

/**
 * Fetches the view chunks one by one, after the first paint.
 *
 * `requestIdleCallback` is only used while the document is visible: a background
 * tab never becomes idle, so relying on it alone left the prefetch never
 * running (measured: only the two chunks the page actually needed were
 * fetched). The timer fallback covers exactly that case.
 */
function prefetchViews(): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  const run = async () => {
    for (const load of VIEW_IMPORTERS) {
      try {
        await load();
      } catch {
        // A failed prefetch is not an error: the view loads on demand instead.
      }
    }
  };
  if (idle && document.visibilityState === "visible") idle(() => void run(), { timeout: 3000 });
  else setTimeout(() => void run(), 1200);
}

/**
 * The open settings panel survives a dev-server reload.
 *
 * `npm run dev` rebuilds the UI on every source save, and Vite then reloads the
 * page. The URL only carries the panel when it is open (`/settings/<section>`),
 * so without this session flag a save made from the panel would drop the user
 * back on the task list — losing the "apply the configuration file" step that
 * follows an edit. Closing the panel clears it.
 */
const SETTINGS_OPEN_KEY = "agentfabric.settingsOpen";

function readSettingsOpen(): boolean {
  try {
    return window.sessionStorage.getItem(SETTINGS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSettingsOpen(open: boolean): void {
  try {
    window.sessionStorage.setItem(SETTINGS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* a session flag that cannot be stored costs only a reload */
  }
}

/**
 * Navigation (v5 §15/§33): users operate Tasks; Runs are execution
 * details. Primary nav = New task / Tasks; Runs stay
 * reachable as the operations/run-history view under System.
 */

/** Remembers whether the user collapsed the rail to icons only. */
const SIDEBAR_COLLAPSED_KEY = "agentfabric.sidebarCollapsed";

/**
 * The rail's width, as a dragged preference.
 *
 * The shell used to be a fixed 260px rail beside a main area capped at
 * 1180px, so a wide window left a dead gutter and a long workspace name was
 * still cut off. The divider between the two panes is now the control: drag it
 * to trade width between the task tree and the page it opens, and the choice is
 * remembered across launches (it is a layout preference of this window, so it
 * lives in `localStorage` next to the collapsed flag — not in the server's
 * configuration).
 *
 * The bounds are what the rail needs to stay legible: below the minimum the
 * workspace rows lose their names, and above the maximum the main area is the
 * one squeezed. The default is the width the rail always had.
 */
const SIDEBAR_WIDTH_KEY = "agentfabric.sidebarWidth";
const SIDEBAR_WIDTH_DEFAULT = 260;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 480;
/**
 * What the main area keeps whatever the rail takes. A drag stops at this
 * rather than at `SIDEBAR_WIDTH_MAX` alone, so the rail cannot eat a small
 * window's page: the maximum is a preference, the window is a fact.
 */
const MAIN_MIN_WIDTH = 420;

/** A rail width inside the allowed range; anything else falls back to default. */
function clampSidebarWidth(width: number, limit = SIDEBAR_WIDTH_MAX): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(Math.min(SIDEBAR_WIDTH_MAX, limit), Math.round(width)));
}

/** The rail width this window last used, or the default. */
function readStoredSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    // `Number(null)` is 0, which is finite: read the string, not the absence.
    if (stored !== null) {
      const width = Number(stored);
      if (Number.isFinite(width)) return clampSidebarWidth(width);
    }
  } catch {
    /* fall through to the default */
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

/**
 * System nav. Proxy is not a page of its own: it is a settings section (see
 * `views/Settings.tsx`), because a proxy is one of the settings the config file
 * holds, not a separate surface with its own save button. `/proxy` still routes
 * there so an old bookmark lands on the section instead of the task list.
 */
/**
 * Where the settings panel goes when it closes: back to where it was opened,
 * not to a fixed page. The comment above the panel has always said it is a
 * modal "over whatever view is behind it" — but closing it always landed on
 * the task list, so opening settings from the board or a thread and closing it
 * moved the user somewhere they had not been.
 *
 * Kept in a ref rather than in the URL: it is local view state, it should not
 * survive a reload (a reload of /settings does open the panel over nothing), and
 * it must not add history entries.
 */
function useSettingsReturn(open: boolean): { close: () => void } {
  const where = useRef<string | null>(null);
  const path = usePath();
  // The last URL that was *not* the panel. Updated while the panel is closed,
  // so when the panel opens the ref still holds where it opened from — the
  // effect runs after the URL has already changed to /settings, and recording
  // the current path would record the panel itself and make "close" reopen it.
  useEffect(() => {
    if (open) return;
    where.current = path;
  }, [open, path]);
  return {
    close: () => {
      const target = where.current;
      // Never navigate back into the panel, and never request the page already
      // showing: `navigate` ignores that, which would leave the panel up.
      const safe = target && !target.startsWith("/settings") ? target : "/tasks";
      navigate(safe);
    },
  };
}

export function App() {
  const language = useLanguageState();
  const t = language.t;
  const path = usePath();
  const parsed: Route = parsePath(path);
  const settingsReturn = useSettingsReturn(parsed.view === "settings");
  // Reopened after a dev-server reload: the route says where to go, the session
  // flag says the settings panel is still open over it.
  // The flag alone never opens the panel: it is consulted only when the URL
  // already says `/settings`, where it decides whether the panel is up at all
  // (a reload) — see the effect below.
  const [settingsOpen, setSettingsOpen] = useState(() => parsed.view === "settings" && readSettingsOpen());
  const route: Route = settingsOpen && parsed.view !== "settings" ? { view: "settings", section: "general" } : parsed;

  // Keep the session flag in step with where the user actually is.
  //
  // The flag exists so a dev-server reload keeps the panel open, but it has to
  // be able to come back *down*. A reload of `/tasks` still had the flag set
  // from an earlier visit, so the panel was drawn over the task list while the
  // URL read `/tasks` — and closing it navigated to `/tasks`, the page already
  // showing, which `navigate` ignores. The panel then could not be closed at
  // all. The rule is now the one in the comment above: the URL carries the
  // panel, the flag only survives a reload that happens *on* it.
  useEffect(() => {
    setSettingsOpen(parsed.view === "settings");
    writeSettingsOpen(parsed.view === "settings");
  }, [parsed.view]);
  // The rail's filter row.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterPinnedOnly, setFilterPinnedOnly] = useState(false);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      /* A layout preference that cannot be stored must not break the app. */
    }
  }, [sidebarCollapsed]);

  // The rail's dragged width. Kept as state while dragging (so the divider
  // follows the pointer) and written once the drag settles — the write is a
  // preference, not a render input.
  const [sidebarWidth, setSidebarWidth] = useState<number>(readStoredSidebarWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    // One write per gesture, not one per pointermove: the drag updates state on
    // every move, and the stored value only has to be right when it settles.
    if (resizing) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      /* A width preference that cannot be stored must not break the app. */
    }
  }, [sidebarWidth, resizing]);

  // The window decides how much of the remembered width is actually usable. It
  // is tracked as state rather than read off the DOM at drag time because the
  // *rendered* width has to react to it: a rail remembered at 480px in a wide
  // window must give way when the window shrinks, without overwriting the
  // preference (growing the window again restores it).
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** The widest the rail may be in this window, so the page keeps room. */
  const railWidthLimit = () => clampSidebarWidth(windowWidth - MAIN_MIN_WIDTH, SIDEBAR_WIDTH_MAX);
  /** What the rail is actually painted at. */
  const railWidth = clampSidebarWidth(sidebarWidth, railWidthLimit());

  /**
   * Drag the divider to trade width between the rail and the page.
   *
   * Listeners are on `window` for the whole gesture: a pointer that leaves the
   * 6px handle (which it will, immediately) must keep resizing, and pointer
   * capture on a div would not survive the pointerup outside the window either.
   * The text cursor and selection are suppressed for the drag so the gesture
   * does not paint a selection across the rail.
   *
   * The global side effects are undone by one `finish` that the listeners and
   * the component's own unmount both call: dragging the divider is the only
   * thing that ever sets `body`'s cursor/selection, and a gesture interrupted by
   * a route change (the shell is not remounted, but the pointerup can land on a
   * page that navigated) must not leave the whole app unable to select text.
   */
  const endRailResize = useRef<() => void>(() => {});

  const beginRailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = railWidth;
    const limit = railWidthLimit();
    setResizing(true);
    const move = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + (moveEvent.clientX - startX), limit));
    };
    const finish = () => {
      endRailResize.current = () => {};
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    endRailResize.current = finish;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  // A gesture that outlives its component cannot happen by itself (the shell is
  // the app's root), but an unmounted drag is still the one way `body` keeps the
  // suppressed selection for good, so it is released here too.
  useEffect(() => () => endRailResize.current(), []);

  /**
   * Keyboard resizing, because the divider is a `role="separator"` with a
   * focusable handle: arrows step it, Home/End take it to the bounds, and
   * Enter resets it to the default width. Without this the control would be
   * pointer-only, which is exactly the accessibility gap a drag handle usually
   * has.
   */
  const onRailResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const limit = railWidthLimit();
    switch (event.key) {
      case "ArrowLeft":
        setSidebarWidth((width) => clampSidebarWidth(width - step, limit));
        break;
      case "ArrowRight":
        setSidebarWidth((width) => clampSidebarWidth(width + step, limit));
        break;
      case "Home":
        setSidebarWidth(clampSidebarWidth(SIDEBAR_WIDTH_MIN, limit));
        break;
      case "End":
        setSidebarWidth(clampSidebarWidth(limit, limit));
        break;
      case "Enter":
        setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // The shell is painted; fetch the other views while nothing else is going on.
  useEffect(() => {
    prefetchViews();
  }, []);

  // The Task Thread is a full-height, composer-anchored layout (v5 §3); the
  // Kanban owns its own full-height scroll regions (v13 §七).
  const fullBleed = route.view === "task" || route.view === "kanban";

  return (
    <LanguageContext.Provider value={language}>
    <div className={`app ${resizing ? "resizing" : ""}`}>
      {/* The two panes are width-controlled here rather than in the stylesheet:
          the rail's width is the user's drag, and the main area takes the rest
          (`.app` is a flex row, so `flex: 1` on the page and a fixed rail width
          are the whole layout). The collapsed rail is still an icon column, and
          its width is the stylesheet's. */}
      <aside
        className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}
        style={sidebarCollapsed ? undefined : { width: railWidth }}
      >
        <div className="brand">
          <button className="brand-btn" onClick={() => navigate("/tasks")} title={t("nav.tasks")}>
            {/* The app icon in both states: the full tile when the rail is an
                icon column, the "A" alone beside the product name otherwise. */}
            <BrandMark variant={sidebarCollapsed ? "tile" : "glyph"} size={sidebarCollapsed ? 26 : 22} />
            {!sidebarCollapsed && <span className="brand-name">AgentFabric</span>}
          </button>
          {/* The collapse control sits at the right edge of this row, above the
              panel it controls. In the collapsed rail it moves into the icon
              column so the rail can be reopened. The language switch lives in
              Settings → General. */}
          {!sidebarCollapsed && (
            <span className="brand-actions">
              <button
                className="icon-btn sidebar-toggle"
                title={t("nav.collapse")}
                aria-label={t("nav.collapse")}
                aria-expanded
                onClick={() => setSidebarCollapsed(true)}
              >
                <Icon name="sidebar" size={16} />
              </button>
            </span>
          )}
        </div>

        {/* The rail is the app's primary navigation: Tasks, grouped by the
            workspace they run in. Everything else is behind `RailMenu`, and the
            main area shows a Task or the new-task form. */}
        {!sidebarCollapsed && (
          <>
            {/* The one action every session starts with, given the weight it has
                in the reference UI: a full-width button, not an icon. */}
            <button
              className={`rail-new ${route.view === "new-task" ? "active" : ""}`}
              onClick={() => navigate("/new")}
            >
              <Icon name="plus" size={15} />
              <span>{t("sidebar.newSession")}</span>
            </button>
            {/* The board is a primary destination of its own: it sits between
                the new-session action and the workspace tree instead of hiding
                in the overflow menu. */}
            <button
              className={`nav-item rail-kanban ${route.view === "kanban" ? "active" : ""}`}
              onClick={() => navigate("/kanban")}
            >
              <Icon name="grid" size={15} />
              <span>{t("nav.kanban")}</span>
            </button>
            <div className="rail-head">
              <span className="rail-head-title">{t("sidebar.workspaces")}</span>
              <span className="rail-head-actions">
                {/* No search button: it navigated to the full task list, which
                    is not search. The task list is reachable from the overflow
                    menu, where the other destinations live. */}
                <button
                  className="icon-btn"
                  title={t("sidebar.filter")}
                  aria-label={t("sidebar.filter")}
                  aria-expanded={filtersOpen}
                  aria-controls="rail-filters"
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  <Icon name="funnel" size={15} />
                </button>
                {/* The one action that creates a workspace, given a `+` like
                    the reference UI. New tasks start from the full-width
                    新会话 button above; this entry point belongs to the
                    Workspaces heading. */}
                <button
                  className="icon-btn"
                  title={t("sidebar.newWorkspace")}
                  aria-label={t("sidebar.newWorkspace")}
                  onClick={() => setNewWorkspaceOpen(true)}
                >
                  <Icon name="plus" size={16} />
                </button>
              </span>
            </div>
            <nav className="rail-scroll" aria-label={t("sidebar.workspaces")}>
              {filtersOpen && (
                <div className="rail-filters" id="rail-filters">
                  <label>
                    <input type="checkbox" checked={filterPinnedOnly} onChange={(e) => setFilterPinnedOnly(e.target.checked)} />
                    {t("sidebar.filterPinned")}
                  </label>
                </div>
              )}
              <WorkspaceTaskList
                activeTaskId={route.view === "task" ? route.id : undefined}
                pinnedOnly={filterPinnedOnly}
              />
            </nav>
          </>
        )}
        {sidebarCollapsed && (
          /* Collapsed rail: expand leads the icon column, followed by the icons
             that start a new session and open the Kanban (what the full-width
             buttons do when expanded). */
          <div className="rail-head rail-head-collapsed">
            <button
              className="icon-btn sidebar-toggle"
              title={t("nav.expand")}
              aria-label={t("nav.expand")}
              aria-expanded={false}
              onClick={() => setSidebarCollapsed(false)}
            >
              <Icon name="sidebar" size={16} />
            </button>
            <button
              className={`icon-btn rail-new-icon ${route.view === "new-task" ? "active" : ""}`}
              title={t("sidebar.newSession")}
              aria-label={t("sidebar.newSession")}
              onClick={() => navigate("/new")}
            >
              <Icon name="newSession" size={16} />
            </button>
            <button
              className={`icon-btn rail-kanban-icon ${route.view === "kanban" ? "active" : ""}`}
              title={t("nav.kanban")}
              aria-label={t("nav.kanban")}
              onClick={() => navigate("/kanban")}
            >
              <Icon name="grid" size={16} />
            </button>
          </div>
        )}

        <RailMenu currentPath={path} />
      </aside>
      {/* The divider between the two panes. It is only meaningful while the rail
          is expanded: the collapsed rail is a fixed icon column, so its width is
          not the user's to trade and the handle goes away with the tree. */}
      {!sidebarCollapsed && (
        <div
          className={`rail-resizer ${resizing ? "active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("rail.resize")}
          aria-valuenow={railWidth}
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={railWidthLimit()}
          tabIndex={0}
          title={t("rail.resizeHint")}
          onPointerDown={beginRailResize}
          onKeyDown={onRailResizeKey}
          // The handle is a drag target, not a text selection: a double click on
          // it would otherwise start one on the page beneath.
          onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
        />
      )}
      <main className={`main ${fullBleed ? "fullbleed" : ""}`}>
        {/* One boundary for whichever view chunk is loading; the fallback is
            deliberately quiet so a fast chunk swap does not flash a message. */}
        <Suspense fallback={<div className="view-loading" role="status" aria-live="polite" />}>
        {/* Every view that is opened *by id* is keyed on that id. Without the
            key React reuses one instance across ids, and every ref and piece of
            state survives the switch: a thread scrolled up in one task opened
            the next at the top, and one task's in-flight action kept another
            task's buttons disabled. Remounting per id is the cheap fix; drafts
            are kept in localStorage, so nothing the user typed is lost. */}
        {route.view === "new-task" && <NewTaskView />}
        {route.view === "tasks" && <TasksView />}
        {route.view === "trash" && <TrashView />}
        {route.view === "task" && route.id && <TaskThreadView key={route.id} taskId={route.id} />}
        {route.view === "task-lifecycle" && route.id && <TaskLifecycleView key={route.id} taskId={route.id} />}
        {route.view === "runs" && <RunsView />}
        {route.view === "run" && route.id && <RunDetailView key={route.id} runId={route.id} />}
        {route.view === "runtimes" && <ResourceView kind="runtimes" />}
        {route.view === "sessions" && <SessionsView />}
        {/* AGENT_UI_HIDDEN: 与上面侧边栏的 Agents 导航一起恢复。 */}
        {/* {route.view === "agents" && <ResourceView kind="agents" />} */}
        {route.view === "kanban" && <KanbanView />}
        {route.view === "handoffs" && <HandoffsView />}
        {route.view === "handoff" && route.id && <HandoffDetailView key={route.id} handoffId={route.id} />}
        {route.view === "usage" && <UsageView />}
        {/* The settings panel is a modal over whatever view is behind it, so
            closing it returns to where the user was instead of a blank page. */}
        {route.view === "settings" && (
          <SettingsPanel
            section={route.section ?? "general"}
            onSection={(section: SettingsSection) => navigate(`/settings/${section}`)}
            onClose={settingsReturn.close}
          />
        )}
        </Suspense>
      </main>
      {newWorkspaceOpen && (
        <Suspense fallback={null}>
          <NewWorkspaceDialog
            mode="workspace"
            onClose={() => setNewWorkspaceOpen(false)}
            onAdded={() => setNewWorkspaceOpen(false)}
          />
        </Suspense>
      )}
    </div>
    </LanguageContext.Provider>
  );
}

function isActive(currentPath: string, route: Route, match: string): boolean {
  // `/` resolves to the task list, so the task entry must light up there too:
  // matching only on the URL would leave the home page with no active entry.
  if (match === "/tasks" && currentPath === "/") return true;
  return currentPath === match || currentPath.startsWith(`${match}/`);
}
