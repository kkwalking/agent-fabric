import { useEffect, useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { ResourceView } from "./views/ResourceView";
import { LlmView } from "./views/Llm";
import { RunsView, RunDetailView } from "./views/Runs";
import { TasksView } from "./views/Tasks";
import { HandoffsView } from "./views/Handoffs";
import { SessionsView } from "./views/Sessions";
import { ArtifactsView } from "./views/Artifacts";
import { UsageView } from "./views/Usage";
import { SettingsView } from "./views/Settings";
import { Icon, IconName } from "./components";

export type ViewKey =
  | "dashboard"
  | "llm"
  | "runtimes"
  | "agents"
  | "workspaces"
  | "secrets"
  | "tasks"
  | "runs"
  | "run"
  | "sessions"
  | "handoffs"
  | "artifacts"
  | "usage"
  | "settings";

interface NavState {
  view: ViewKey;
  runId?: string;
}

interface NavEntry {
  key: ViewKey;
  label: string;
  icon: IconName;
}

const primaryNav: NavEntry[] = [
  { key: "runs", label: "New run", icon: "compose" },
  { key: "tasks", label: "Tasks", icon: "history" },
  { key: "dashboard", label: "Dashboard", icon: "grid" },
];

const resourceNav: NavEntry[] = [
  { key: "llm", label: "LLM", icon: "cloud" },
  { key: "runtimes", label: "Runtimes", icon: "box" },
  { key: "agents", label: "Agents", icon: "bot" },
  { key: "workspaces", label: "Workspaces", icon: "folder" },
  { key: "secrets", label: "Secrets", icon: "key" },
];

const systemNav: NavEntry[] = [
  { key: "handoffs", label: "Handoffs", icon: "archive" },
  { key: "artifacts", label: "Artifacts", icon: "archive" },
  { key: "usage", label: "Usage", icon: "chart" },
  { key: "settings", label: "Settings", icon: "gear" },
];

export function App() {
  const [nav, setNav] = useState<NavState>({ view: "dashboard" });
  const [health, setHealth] = useState<string>("connecting…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setHealth(d.status))
      .catch(() => setHealth("offline"));
  }, []);

  const navigate = (view: ViewKey, runId?: string) => setNav({ view, runId });

  const renderNav = (items: NavEntry[]) =>
    items.map(({ key, label, icon }) => (
      <button
        key={key}
        className={`nav-item ${nav.view === key || (key === "runs" && nav.view === "run") ? "active" : ""}`}
        onClick={() => navigate(key)}
      >
        <Icon name={icon} />
        <span>{label}</span>
      </button>
    ));

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <span className="brand-name">AgentFabric</span>
          <span className="brand-actions">
            <button className="icon-btn" title="Search">
              <Icon name="search" />
            </button>
            <button className="icon-btn" title="Notifications">
              <Icon name="bell" />
            </button>
          </span>
        </div>

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
      <main className="main">
        {nav.view === "dashboard" && <Dashboard onOpenRun={(id) => navigate("run", id)} />}
        {nav.view === "llm" && <LlmView />}
        {nav.view === "runtimes" && <ResourceView kind="runtimes" />}
        {nav.view === "agents" && <ResourceView kind="agents" />}
        {nav.view === "workspaces" && <ResourceView kind="workspaces" />}
        {nav.view === "secrets" && <ResourceView kind="secrets" />}
        {nav.view === "runs" && <RunsView onOpenRun={(id) => navigate("run", id)} />}
        {nav.view === "run" && <RunDetailView runId={nav.runId ?? ""} onBack={() => navigate("runs")} />}
        {nav.view === "tasks" && <TasksView onOpenRun={(id) => navigate("run", id)} />}
        {nav.view === "sessions" && <SessionsView onOpenRun={(id) => navigate("run", id)} />}
        {nav.view === "handoffs" && <HandoffsView />}
        {nav.view === "artifacts" && <ArtifactsView />}
        {nav.view === "usage" && <UsageView />}
        {nav.view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
