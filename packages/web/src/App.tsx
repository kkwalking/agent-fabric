import { Suspense, lazy, useEffect, useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { ResourceView } from "./views/ResourceView";
import { LlmView } from "./views/Llm";
import { RunsView, RunDetailView } from "./views/Runs";
import { TasksView } from "./views/Tasks";
import { TrashView } from "./views/Trash";
import { NewTaskView } from "./views/NewTask";
import { SessionsView } from "./views/Sessions";
import { TaskThreadView } from "./views/TaskThread";
import { HandoffsView, HandoffDetailView } from "./views/Handoffs";
import { UsageView } from "./views/Usage";
import { ProxyView } from "./views/Proxy";
import { SettingsView } from "./views/Settings";
import { NewProjectTaskView, ProjectDetailView, ProjectsView } from "./views/Projects";
import { SourceCredentialsView } from "./views/SourceCredentials";
import { TaskLifecycleView } from "./views/TaskLifecycle";
import { Icon, IconName } from "./components";
import { navigate, parsePath, usePath, type Route } from "./router";

// The Board pulls in xterm; keep it in its own chunk so every other page stays
// small (v13 §七 asks for a dedicated terminal chunk).
const KanbanView = lazy(() =>
  import("./views/Board").then((module) => ({ default: module.BoardView }))
);

/**
 * Navigation (v5 §15/§33): users operate Tasks; Runs are execution
 * details. Primary nav = New task / Tasks / Dashboard; Runs stay
 * reachable as the operations/run-history view under System.
 */

/** Remembers whether the user collapsed the rail to icons only. */
const SIDEBAR_COLLAPSED_KEY = "agentfabric.sidebarCollapsed";

interface NavEntry {
  path: string;
  label: string;
  icon: IconName;
  /** Prefix used for active-state highlighting. */
  match: string;
}

const primaryNav: NavEntry[] = [
  { path: "/tasks", label: "Tasks", icon: "history", match: "/tasks" },
  { path: "/", label: "Dashboard", icon: "grid", match: "/" },
];

const resourceNav: NavEntry[] = [
  { path: "/kanban", label: "Kanban", icon: "grid", match: "/kanban" },
  { path: "/llm", label: "LLM", icon: "cloud", match: "/llm" },
  { path: "/projects", label: "Projects", icon: "folder", match: "/projects" },
  { path: "/runtimes", label: "Runtimes", icon: "box", match: "/runtimes" },
  { path: "/sessions", label: "Native sessions", icon: "terminal", match: "/sessions" },
  { path: "/handoffs", label: "Handoffs", icon: "archive", match: "/handoffs" },
  // AGENT_UI_HIDDEN: Agents 页暂不开放（后端 / API 未动）。恢复前端入口时，
  // 取消注释所有带 AGENT_UI_HIDDEN 标记的位置：本文件上下两处、router.ts 的
  // PATH_VIEWS、NewTask.tsx 与 TaskThread.tsx 里的 Agent 选择器。
  // { path: "/agents", label: "Agents", icon: "bot", match: "/agents" },
  { path: "/workspaces", label: "Workspaces", icon: "folder", match: "/workspaces" },
  { path: "/source-credentials", label: "Source credentials", icon: "key", match: "/source-credentials" },
];

const systemNav: NavEntry[] = [
  { path: "/runs", label: "Runs", icon: "play", match: "/runs" },
  { path: "/usage", label: "Usage", icon: "chart", match: "/usage" },
  { path: "/proxy", label: "Proxy", icon: "cloud", match: "/proxy" },
  { path: "/settings", label: "Settings", icon: "gear", match: "/settings" },
];

export function App() {
  const path = usePath();
  const route: Route = parsePath(path);
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
        title={label}
      >
        <Icon name={icon} />
        <span>{label}</span>
      </button>
    ));

  // The Task Thread is a full-height, composer-anchored layout (v5 §3); the
  // Kanban owns its own full-height scroll regions (v13 §七).
  const fullBleed = route.view === "task" || route.view === "kanban";

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="brand">
          <button className="brand-btn" onClick={() => navigate("/")} title="Dashboard">
            {sidebarCollapsed && <span className="brand-mark">AF</span>}
            {!sidebarCollapsed && <span className="brand-name">AgentFabric</span>}
          </button>
          <span className="brand-actions">
            {!sidebarCollapsed && (
              <>
                <button className="icon-btn" title="Search">
                  <Icon name="search" />
                </button>
                <button className="icon-btn" title="Notifications">
                  <Icon name="bell" />
                </button>
              </>
            )}
            <button
              className={`icon-btn sidebar-toggle ${sidebarCollapsed ? "" : "expanded"}`}
              title={sidebarCollapsed ? "Expand menu" : "Collapse menu"}
              aria-label={sidebarCollapsed ? "Expand menu" : "Collapse menu"}
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
          title="New task"
        >
          <Icon name="compose" size={15} />
          <span>New task</span>
        </button>

        <nav className="nav">
          {renderNav(primaryNav)}
          <div className="nav-section">Resources</div>
          {renderNav(resourceNav)}
          <div className="nav-section">System</div>
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
        {route.view === "llm" && <LlmView />}
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
        {route.view === "proxy" && <ProxyView />}
        {route.view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}

function isActive(currentPath: string, route: Route, match: string): boolean {
  if (match === "/") return route.view === "dashboard";
  return currentPath === match || currentPath.startsWith(`${match}/`);
}
