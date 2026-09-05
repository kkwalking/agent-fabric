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
    | "dashboard"
    | "new-task"
    | "tasks"
    | "task"
    | "runs"
    | "run"
    | "llm"
    | "runtimes"
    | "agents"
    | "workspaces"
    | "secrets"
    | "handoffs"
    | "artifacts"
    | "usage"
    | "settings";
  id?: string;
}

const PATH_VIEWS: Record<string, Route["view"]> = {
  "/": "dashboard",
  "/new": "new-task",
  "/tasks": "tasks",
  "/runs": "runs",
  "/llm": "llm",
  "/runtimes": "runtimes",
  "/agents": "agents",
  "/workspaces": "workspaces",
  "/secrets": "secrets",
  "/handoffs": "handoffs",
  "/artifacts": "artifacts",
  "/usage": "usage",
  "/settings": "settings",
};

export function parsePath(path: string): Route {
  const base = PATH_VIEWS[path];
  if (base) return { view: base };
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "tasks" && parts[1]) return { view: "task", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "runs" && parts[1]) return { view: "run", id: decodeURIComponent(parts[1]) };
  return { view: "dashboard" };
}
