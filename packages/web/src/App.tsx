import { Suspense, lazy, useEffect, useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { ResourceView } from "./views/ResourceView";
import { RunsView, RunDetailView } from "./views/Runs";
import { TasksView } from "./views/Tasks";
import { TrashView } from "./views/Trash";
import { NewTaskView } from "./views/NewTask";
import { SessionsView } from "./views/Sessions";
import { TaskThreadView } from "./views/TaskThread";
import { HandoffsView, HandoffDetailView } from "./views/Handoffs";
import { UsageView } from "./views/Usage";
import { SettingsView as SettingsPanel } from "./views/Settings";
import { NewProjectTaskView, ProjectDetailView, ProjectsView } from "./views/Projects";
import { SourceCredentialsView } from "./views/SourceCredentials";
import { TaskLifecycleView } from "./views/TaskLifecycle";
import { Icon, IconName } from "./components";
import { LanguageContext, useI18n, useLanguageState } from "./i18n-react";
import type { Language, MessageKey } from "./i18n";
import { navigate, parsePath, usePath, type Route, type SettingsSection } from "./router";

// The Board pulls in xterm; keep it in its own chunk so every other page stays
// small (v13 §七 asks for a dedicated terminal chunk).
const KanbanView = lazy(() =>
  import("./views/Board").then((module) => ({ default: module.BoardView }))
);

/**
 * The open settings panel survives a reload of the page.
 *
 * A dev-server rebuild (or a manual refresh) would otherwise drop the user back
 * on the dashboard: the URL carries the panel only while it is open
 * (`/settings/<section>`), so a save made from the panel loses the "apply the
 * configuration file" step that follows. Closing the panel clears the flag.
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

/** The sidebar's language switch: one click between the two dictionaries. */
function LanguageToggle() {
  const { language, setLanguage } = useI18n();
  const next: Language = language === "zh" ? "en" : "zh";
  const label = next === "zh" ? "切换到中文" : "Switch to English";
  return (
    <button className="icon-btn" title={label} aria-label={label} onClick={() => setLanguage(next)}>
      <Icon name="compass" size={15} />
    </button>
  );
}

/**
 * Navigation (v5 §15/§33): users operate Tasks; Runs are execution
 * details. Primary nav = New task / Tasks / Dashboard; Runs stay
 * reachable as the operations/run-history view under System.
 */

/** Remembers whether the user collapsed the rail to icons only. */
const SIDEBAR_COLLAPSED_KEY = "agentfabric.sidebarCollapsed";

interface NavEntry {
  path: string;
  /** Dictionary key, resolved at render: the nav follows the current language. */
  label: MessageKey;
  icon: IconName;
  /** Prefix used for active-state highlighting. */
  match: string;
}

const primaryNav: NavEntry[] = [
  { path: "/tasks", label: "nav.tasks", icon: "history", match: "/tasks" },
  { path: "/", label: "nav.dashboard", icon: "grid", match: "/" },
];

const resourceNav: NavEntry[] = [
  { path: "/kanban", label: "nav.kanban", icon: "grid", match: "/kanban" },
  { path: "/projects", label: "nav.projects", icon: "folder", match: "/projects" },
  { path: "/runtimes", label: "nav.runtimes", icon: "box", match: "/runtimes" },
  { path: "/sessions", label: "nav.sessions", icon: "terminal", match: "/sessions" },
  { path: "/handoffs", label: "nav.handoffs", icon: "archive", match: "/handoffs" },
  // AGENT_UI_HIDDEN: Agents 页暂不开放（后端 / API 未动）。恢复前端入口时，
  // 取消注释所有带 AGENT_UI_HIDDEN 标记的位置：本文件上下两处、router.ts 的
  // PATH_VIEWS、NewTask.tsx 与 TaskThread.tsx 里的 Agent 选择器。
  // { path: "/agents", label: "Agents", icon: "bot", match: "/agents" },
  { path: "/workspaces", label: "nav.workspaces", icon: "folder", match: "/workspaces" },
  { path: "/source-credentials", label: "nav.sourceCredentials", icon: "key", match: "/source-credentials" },
];

const systemNav: NavEntry[] = [
  { path: "/runs", label: "nav.runs", icon: "play", match: "/runs" },
  { path: "/usage", label: "nav.usage", icon: "chart", match: "/usage" },
  { path: "/settings", label: "nav.settings", icon: "gear", match: "/settings" },
];

/** Where closing the settings panel returns to (its opener, else the dashboard). */
function closeSettings(): void {
  navigate("/");
}

export function App() {
  const language = useLanguageState();
  const t = language.t;
  const path = usePath();
  const parsed: Route = parsePath(path);
  // Reopened after a reload: the route says where to go, the session flag says
  // the settings panel is still open over it.
  const [settingsOpen, setSettingsOpen] = useState(readSettingsOpen);
  const route: Route = settingsOpen && parsed.view !== "settings" ? { view: "settings", section: "general" } : parsed;

  // Keep the session flag in step with where the user actually is.
  useEffect(() => {
    const open = parsed.view === "settings";
    setSettingsOpen(open);
    writeSettingsOpen(open);
  }, [parsed.view]);
  const [health, setHealth] = useState<string>("connecting…");
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

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setHealth(d.status))
      .catch(() => setHealth("offline"));
  }, []);

  const renderNav = (items: NavEntry[]) =>
    items.map(({ path: p, label, icon, match }) => (
      <button
        key={p}
        className={`nav-item ${isActive(path, route, match) ? "active" : ""}`}
        onClick={() => navigate(p)}
        title={t(label)}
      >
        <Icon name={icon} />
        <span>{t(label)}</span>
      </button>
    ));

  // The Task Thread is a full-height, composer-anchored layout (v5 §3); the
  // Kanban owns its own full-height scroll regions (v13 §七).
  const fullBleed = route.view === "task" || route.view === "kanban";

  return (
    <LanguageContext.Provider value={language}>
    <div className="app">
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="brand">
          <button className="brand-btn" onClick={() => navigate("/")} title={t("nav.dashboard")}>
            {sidebarCollapsed && <span className="brand-mark">AF</span>}
            {!sidebarCollapsed && <span className="brand-name">AgentFabric</span>}
          </button>
          <span className="brand-actions">
            {!sidebarCollapsed && (
              <>
                <button className="icon-btn" title={t("nav.search")}>
                  <Icon name="search" />
                </button>
                <button className="icon-btn" title={t("nav.notifications")}>
                  <Icon name="bell" />
                </button>
                <LanguageToggle />
              </>
            )}
            <button
              className={`icon-btn sidebar-toggle ${sidebarCollapsed ? "" : "expanded"}`}
              title={sidebarCollapsed ? t("nav.expand") : t("nav.collapse")}
              aria-label={sidebarCollapsed ? t("nav.expand") : t("nav.collapse")}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              <Icon name="chevron" size={15} />
            </button>
          </span>
        </div>

        <button
          className={`nav-item ${route.view === "new-task" ? "active" : ""}`}
          onClick={() => navigate("/new")}
          title={t("nav.newTask")}
        >
          <Icon name="compose" size={15} />
          <span>{t("nav.newTask")}</span>
        </button>

        <nav className="nav">
          {renderNav(primaryNav)}
          <div className="nav-section">{t("nav.resources")}</div>
          {renderNav(resourceNav)}
          <div className="nav-section">{t("nav.system")}</div>
          {renderNav(systemNav)}
        </nav>

        <div className="foot" title={`local server — api: ${health}`}>
          <span className="avatar">AF</span>
          <span className="foot-text">
            <span className="foot-title">local server</span>
            <span className="foot-sub">
              <span className={`dot ${health === "ok" ? "on" : ""}`} />
              api: {health}
            </span>
          </span>
        </div>
      </aside>
      <main className={`main ${fullBleed ? "fullbleed" : ""}`}>
        {route.view === "dashboard" && <Dashboard />}
        {route.view === "new-task" && <NewTaskView />}
        {route.view === "tasks" && <TasksView />}
        {route.view === "trash" && <TrashView />}
        {route.view === "task" && route.id && <TaskThreadView taskId={route.id} />}
        {route.view === "task-lifecycle" && route.id && <TaskLifecycleView taskId={route.id} />}
        {route.view === "runs" && <RunsView />}
        {route.view === "run" && route.id && <RunDetailView runId={route.id} />}
        {route.view === "runtimes" && <ResourceView kind="runtimes" />}
        {route.view === "sessions" && <SessionsView />}
        {/* AGENT_UI_HIDDEN: 与上面侧边栏的 Agents 导航一起恢复。 */}
        {/* {route.view === "agents" && <ResourceView kind="agents" />} */}
        {route.view === "workspaces" && <ResourceView kind="workspaces" />}
        {route.view === "projects" && <ProjectsView />}
        {route.view === "kanban" && (
          <Suspense fallback={<div className="board-loading muted">Loading Kanban…</div>}>
            <KanbanView />
          </Suspense>
        )}
        {route.view === "project" && route.id && <ProjectDetailView projectId={route.id} />}
        {route.view === "project-new-task" && route.id && <NewProjectTaskView projectId={route.id} />}
        {route.view === "source-credentials" && <SourceCredentialsView />}
        {route.view === "handoffs" && <HandoffsView />}
        {route.view === "handoff" && route.id && <HandoffDetailView handoffId={route.id} />}
        {route.view === "usage" && <UsageView />}
        {/* The settings panel is a modal over whatever view is behind it, so
            closing it returns to where the user was instead of a blank page. */}
        {route.view === "settings" && (
          <SettingsPanel
            section={route.section ?? "general"}
            onSection={(section: SettingsSection) => navigate(`/settings/${section}`)}
            onClose={closeSettings}
          />
        )}
      </main>
    </div>
    </LanguageContext.Provider>
  );
}

function isActive(currentPath: string, route: Route, match: string): boolean {
  if (match === "/") return route.view === "dashboard";
  return currentPath === match || currentPath.startsWith(`${match}/`);
}
