import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../components";
import { useT } from "../i18n-react";
import type { MessageKey } from "../i18n";
import { navigate } from "../router";

/**
 * The rail's overflow menu.
 *
 * With the task tree occupying the rail, the pages that are not Tasks have no
 * room of their own: Projects, Kanban, Runtimes, Native sessions, Handoffs and
 * the System pages live here instead of in the main area. They are still real
 * routes — the panel navigates like any other entry, it just does not hold a
 * permanent row in the rail.
 */

interface Entry {
  path: string;
  label: MessageKey;
  icon: IconName;
}

const RESOURCE_ENTRIES: Entry[] = [
  { path: "/kanban", label: "nav.kanban", icon: "grid" },
  { path: "/projects", label: "nav.projects", icon: "folder" },
  { path: "/runtimes", label: "nav.runtimes", icon: "box" },
  { path: "/sessions", label: "nav.sessions", icon: "terminal" },
  { path: "/handoffs", label: "nav.handoffs", icon: "archive" },
];

const SYSTEM_ENTRIES: Entry[] = [
  { path: "/runs", label: "nav.runs", icon: "play" },
  { path: "/usage", label: "nav.usage", icon: "chart" },
  { path: "/settings", label: "nav.settings", icon: "gear" },
];

export function RailMenu({ currentPath }: { currentPath: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click outside and Escape both close it: a popover that only closes on its
  // own item leaves the rail feeling stuck.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const render = (entry: Entry) => {
    const active = currentPath === entry.path || currentPath.startsWith(`${entry.path}/`);
    return (
      <button
        key={entry.path}
        className={`rail-menu-item ${active ? "active" : ""}`}
        onClick={() => {
          setOpen(false);
          navigate(entry.path);
        }}
      >
        <Icon name={entry.icon} size={14} />
        <span>{t(entry.label)}</span>
      </button>
    );
  };

  return (
    <div className="rail-menu-root" ref={rootRef}>
      <button
        className={`nav-item rail-menu-trigger ${open ? "active" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("sidebar.more")}
      >
        <Icon name="grid" size={15} />
        <span>{t("sidebar.more")}</span>
      </button>
      {open && (
        <div className="rail-menu" role="menu">
          <div className="rail-menu-section">{t("nav.resources")}</div>
          {RESOURCE_ENTRIES.map(render)}
          <div className="rail-menu-section">{t("nav.system")}</div>
          {SYSTEM_ENTRIES.map(render)}
        </div>
      )}
    </div>
  );
}
