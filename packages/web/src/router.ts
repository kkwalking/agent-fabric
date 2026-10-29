import { useEffect, useState } from "react";

/**
 * Minimal history-based routing (v5 §33). The Express server already
 * falls back to index.html for non-/api paths, and Vite's SPA mode does
 * the same in dev, so plain pushState navigation works everywhere.
 */

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export interface Route {
  view:
    | "new-task"
    | "tasks"
    | "task"
    | "task-lifecycle"
    | "trash"
    | "runs"
    | "run"
    | "runtimes"
    | "sessions"
    | "agents"
    | "kanban"
    | "handoffs"
    | "handoff"
    | "usage"
    | "settings";
  id?: string;
  /** Which page of the settings panel; only for `settings`. */
  section?: SettingsSection;
}

/**
 * Sections of the settings panel. The list lives here (not in the view) so the
 * URL can be parsed without loading the settings chunk.
 */
export type SettingsSection =
  | "general"
  | "llm"
  | "proxy"
  | "notifications"
  | "harness"
  | "docker"
  | "retry"
  | "trash"
  | "about";

const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  "general",
  "llm",
  "proxy",
  "notifications",
  "harness",
  "docker",
  "retry",
  "trash",
  "about",
];

const PATH_VIEWS: Record<string, Route["view"]> = {
  // The dashboard was removed: the task list is the home page, since it is the
  // one surface every session starts from. `/` stays a valid URL so old
  // bookmarks, the brand button and "close settings" all land somewhere real.
  "/": "tasks",
  "/new": "new-task",
  "/tasks": "tasks",
  "/trash": "trash",
  "/runs": "runs",
  "/runtimes": "runtimes",
  "/sessions": "sessions",
  // AGENT_UI_HIDDEN: Agents 页隐藏期间，直接访问 /agents 回落到任务列表；
  // 与 App.tsx 的两处标记一起恢复。
  // "/agents": "agents",
  "/kanban": "kanban",
  // `/board` was the pre-rename URL; keep it landing on the same page instead of
  // dropping an open tab on the task list after the rename.
  "/board": "kanban",
  "/handoffs": "handoffs",
  "/usage": "usage",
  "/settings": "settings",
};

export function parsePath(path: string): Route {
  const base = PATH_VIEWS[path];
  if (base === "settings") return { view: "settings", section: "general" };
  if (base) return { view: base };
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "tasks" && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    if (parts[2] === "lifecycle") return { view: "task-lifecycle", id };
    return { view: "task", id };
  }
  if (parts[0] === "runs" && parts[1]) return { view: "run", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "handoffs" && parts[1]) return { view: "handoff", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "settings") {
    const section = SETTINGS_SECTIONS.find((id) => id === parts[1]);
    return { view: "settings", section: section ?? "general" };
  }
  // `/proxy` and `/llm` used to be pages of their own; their bookmarks now
  // open the matching settings section instead of dropping the user on the
  // task list.
  if (parts[0] === "proxy") return { view: "settings", section: "proxy" };
  if (parts[0] === "llm") return { view: "settings", section: "llm" };
  return { view: "tasks" };
}
