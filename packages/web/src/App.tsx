import { useEffect, useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { ResourceView } from "./views/ResourceView";
import { LlmView } from "./views/Llm";
import { RunsView, RunDetailView } from "./views/Runs";
import { TasksView } from "./views/Tasks";
import { NewTaskView } from "./views/NewTask";
import { TaskThreadView } from "./views/TaskThread";
import { HandoffsView } from "./views/Handoffs";
import { ArtifactsView } from "./views/Artifacts";
import { UsageView } from "./views/Usage";
import { SettingsView } from "./views/Settings";
import { Icon, IconName } from "./components";
import { navigate, parsePath, usePath, type Route } from "./router";

/**
 * Navigation (v5 §15/§33): users operate Tasks; Runs are execution
 * details. Primary nav = New task / Tasks / Dashboard; Runs stay
 * reachable as the operations/run-history view under System.
 */

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
  { path: "/llm", label: "LLM", icon: "cloud", match: "/llm" },
  { path: "/runtimes", label: "Runtimes", icon: "box", match: "/runtimes" },
  { path: "/agents", label: "Agents", icon: "bot", match: "/agents" },
  { path: "/workspaces", label: "Workspaces", icon: "folder", match: "/workspaces" },
  { path: "/secrets", label: "Secrets", icon: "key", match: "/secrets" },
];

const systemNav: NavEntry[] = [
  { path: "/runs", label: "Runs", icon: "play", match: "/runs" },
  { path: "/handoffs", label: "Handoffs", icon: "archive", match: "/handoffs" },
  { path: "/artifacts", label: "Artifacts", icon: "archive", match: "/artifacts" },
  { path: "/usage", label: "Usage", icon: "chart", match: "/usage" },
  { path: "/settings", label: "Settings", icon: "gear", match: "/settings" },
];

export function App() {
  const path = usePath();
  const route: Route = parsePath(path);
  const [health, setHealth] = useState<string>("connecting…");

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
      >
        <Icon name={icon} />
        <span>{label}</span>
      </button>
    ));

  // The Task Thread is a full-height, composer-anchored layout (v5 §3).
  const fullBleed = route.view === "task";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <button className="brand-btn" onClick={() => navigate("/")} title="Dashboard">
            <span className="brand-name">AgentFabric</span>
          </button>
          <span className="brand-actions">
            <button className="icon-btn" title="Search">
              <Icon name="search" />
            </button>
            <button className="icon-btn" title="Notifications">
              <Icon name="bell" />
            </button>
          </span>
        </div>

        <button
          className={`nav-item ${route.view === "new-task" ? "active" : ""}`}
          onClick={() => navigate("/new")}
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

        <div className="foot">
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
        {route.view === "task" && route.id && <TaskThreadView taskId={route.id} />}
        {route.view === "runs" && <RunsView />}
        {route.view === "run" && route.id && <RunDetailView runId={route.id} />}
        {route.view === "llm" && <LlmView />}
        {route.view === "runtimes" && <ResourceView kind="runtimes" />}
        {route.view === "agents" && <ResourceView kind="agents" />}
        {route.view === "workspaces" && <ResourceView kind="workspaces" />}
        {route.view === "secrets" && <ResourceView kind="secrets" />}
        {route.view === "handoffs" && <HandoffsView />}
        {route.view === "artifacts" && <ArtifactsView />}
        {route.view === "usage" && <UsageView />}
        {route.view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}

function isActive(currentPath: string, route: Route, match: string): boolean {
  if (match === "/") return route.view === "dashboard";
  return currentPath === match || currentPath.startsWith(`${match}/`);
}
