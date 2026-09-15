import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Activity,
  Cpu,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Globe,
  MessagesSquare,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { useTheme } from "../../hooks/useTheme";
import { useWsStatus } from "../../hooks/useWebSocket";
import { DebugStats } from "./DebugStats";

interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
}

const sections: { title: string; items: NavItem[] }[] = [
  {
    title: "POOL",
    items: [
      { label: "Dashboard", path: "/", icon: LayoutDashboard },
      { label: "Chat", path: "/chat", icon: MessagesSquare },
      { label: "Accounts", path: "/accounts", icon: Users },
      { label: "Models", path: "/models", icon: Cpu },
    ],
  },
  {
    title: "OBSERVE",
    items: [{ label: "Requests", path: "/requests", icon: Activity }],
  },
  {
    title: "CONFIG",
    items: [
      { label: "Tunnel", path: "/tunnel", icon: Globe },
      { label: "Settings", path: "/settings", icon: SettingsIcon },
    ],
  },
];

export default function Sidebar() {
  const { theme, toggleTheme } = useTheme();
  const wsStatus = useWsStatus();

  const wsMeta =
    wsStatus === "open"
      ? { color: "var(--success)", label: "Live" }
      : wsStatus === "connecting"
        ? { color: "var(--warning)", label: "Connecting" }
        : { color: "var(--error)", label: "Offline" };

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-[220px] flex-col border-r border-sidebar-border bg-sidebar-bg">
      {/* Brand */}
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-4">
        <img src="/favicon.svg" alt="Gacor-Router" className="h-8 w-8 rounded-lg" />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">Gacor-Router</div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: wsMeta.color }}
            />
            {wsMeta.label}
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        {sections.map((section) => (
          <div key={section.title}>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === "/"}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-primary/15 font-medium text-primary"
                        : "text-secondary-foreground hover:bg-secondary hover:text-foreground"
                    )
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="space-y-1 border-t border-sidebar-border p-2">
        <DebugStats />
        <button
          onClick={toggleTheme}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-secondary-foreground hover:bg-secondary hover:text-foreground"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </aside>
  );
}
