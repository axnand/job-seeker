"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Plus,
  FileText,
  Settings,
  PanelLeftClose,
  PanelLeft,
  Target,
  BarChart3,
  Archive,
  Sun,
  Moon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

type NavItem = { href: string; label: string; icon: LucideIcon };

// The pipeline runs itself; these screens are the whole operator surface.
const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/add", label: "Add job", icon: Plus },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/history", label: "History", icon: Archive },
  { href: "/resume", label: "Resume", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];

const STORAGE_KEY = "js.sidebar.collapsed";
const THEME_KEY = "js.theme";

export function AppSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Persist the rail state so it survives navigation and reloads. The theme is
  // already applied to <html> by the no-flash script in the layout head; here we
  // just mirror the current state into React so the toggle renders correctly.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* ignore */
    }
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    setReady(true);
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const toggleTheme = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "group/sidebar flex h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar",
        // Avoid a first-paint width flash before localStorage is read.
        ready ? "transition-[width] duration-200 ease-out" : "",
        collapsed ? "w-14" : "w-56"
      )}
    >
      {/* Wordmark */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border",
          collapsed ? "justify-center px-0" : "px-4"
        )}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <Target className="size-4" />
        </span>
        {!collapsed && (
          <span className="truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
            Job Seeker
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {!collapsed && (
          <p className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Workspace
          </p>
        )}
        {NAV.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          const link = (
            <a
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group/navitem relative flex items-center rounded-lg text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                collapsed ? "h-9 w-9 justify-center self-center" : "h-9 gap-2.5 px-2.5",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              )}
            >
              {/* Indigo active accent bar */}
              {active && !collapsed && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
              )}
              <Icon
                className={cn("size-4 shrink-0", active && "text-primary")}
              />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </a>
          );

          return collapsed ? (
            <Tooltip key={item.href}>
              <TooltipTrigger render={link} />
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          ) : (
            link
          );
        })}
      </nav>

      {/* Footer: theme toggle + collapse */}
      <div className="flex flex-col gap-0.5 border-t border-sidebar-border p-2">
        {(() => {
          const isDark = theme === "dark";
          const ThemeIcon = isDark ? Sun : Moon;
          const themeLabel = isDark ? "Light mode" : "Dark mode";
          const themeBtn = (
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${themeLabel.toLowerCase()}`}
              className={cn(
                "flex h-9 items-center rounded-lg text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                collapsed ? "w-9 justify-center self-center" : "w-full gap-2.5 px-2.5"
              )}
            >
              <ThemeIcon className="size-4 shrink-0" />
              {!collapsed && <span>{themeLabel}</span>}
            </button>
          );
          return collapsed ? (
            <Tooltip>
              <TooltipTrigger render={themeBtn} />
              <TooltipContent side="right">{themeLabel}</TooltipContent>
            </Tooltip>
          ) : (
            themeBtn
          );
        })()}

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex h-9 items-center rounded-lg text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
            collapsed ? "w-9 justify-center self-center" : "w-full gap-2.5 px-2.5"
          )}
        >
          {collapsed ? (
            <PanelLeft className="size-4 shrink-0" />
          ) : (
            <>
              <PanelLeftClose className="size-4 shrink-0" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
