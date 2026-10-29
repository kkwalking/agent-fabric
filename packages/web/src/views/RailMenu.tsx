import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../components";
import { useT } from "../i18n-react";
import type { MessageKey } from "../i18n";
import { navigate } from "../router";

/**
 * The rail's overflow menu.
 *
 * With the task tree occupying the rail, the pages that are not Tasks have no
 * room of their own: Runtimes, Native sessions, Handoffs and the System pages
 * live here instead of in the main area. Kanban is not in this list — it has
 * its own row directly under 新会话. They are still real routes — the panel
 * navigates like any other entry, it just does not hold a permanent row in the
 * rail.
 */

interface Entry {
  path: string;
  label: MessageKey;
  icon: IconName;
}

const RESOURCE_ENTRIES: Entry[] = [
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
  // Where the popover may go. The trigger sits at the bottom of the expanded
  // rail but at the top of the collapsed one, so the side with room is measured
  // when it opens: a fixed side (and a fixed `max-height` in the stylesheet) left
  // the collapsed menu squeezed into the little space above the icon and cut its
  // last rows off.
  const [placement, setPlacement] = useState<{ maxHeight: number; down: boolean } | undefined>(undefined);

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

  useEffect(() => {
    if (!open) {
      setPlacement(undefined);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.top - 16;
    const below = window.innerHeight - rect.bottom - 16;
    const down = below > above;
    setPlacement({ maxHeight: Math.max(120, Math.round(down ? below : above)), down });
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
        {/* Three dots, not the board's 2×2 grid: the board has its own row
            directly above and two grid icons in one rail read as the same
            control. */}
        <Icon name="more" size={15} />
        <span>{t("sidebar.more")}</span>
      </button>
      {open && (
        <div
          className={`rail-menu ${placement?.down ? "rail-menu-down" : ""}`}
          role="menu"
          style={placement ? { maxHeight: placement.maxHeight } : undefined}
        >
          <div className="rail-menu-section">{t("nav.resources")}</div>
          {RESOURCE_ENTRIES.map(render)}
          <div className="rail-menu-section">{t("nav.system")}</div>
          {SYSTEM_ENTRIES.map(render)}
        </div>
      )}
    </div>
  );
}
