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
  Filter,
  Shuffle,
  KeyRound,
  Film,
  Terminal,
  LogOut,
} from "lucide-react";
import { fetchVersion, logout } from "../../lib/api";
import { useAuth } from "../../hooks/useAuth";
import { useEffect, useState } from "react";
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
      { label: "Videos", path: "/videos", icon: Film },
      { label: "Accounts", path: "/accounts", icon: Users },
      { label: "Models", path: "/models", icon: Cpu },
      { label: "Combos", path: "/combos", icon: Shuffle },
    ],
  },
  {
    title: "OBSERVE",
    items: [
      { label: "Requests", path: "/requests", icon: Activity },
      { label: "Console", path: "/console-log", icon: Terminal },
    ],
  },
  {
    title: "CONFIG",
    items: [
      { label: "API Keys", path: "/api-keys", icon: KeyRound },
      { label: "Filters", path: "/filters", icon: Filter },
      { label: "Tunnel", path: "/tunnel", icon: Globe },
      { label: "Settings", path: "/settings", icon: SettingsIcon },
    ],
  },
];

export default function Sidebar() {
  const { theme, toggleTheme } = useTheme();
  const wsStatus = useWsStatus();
  const { status: authStatus } = useAuth();
  // Fetch once on mount — /api/version is bootstrap-time constant, no reason
  // to poll. Silently ignore failure (sidebar just shows "…" placeholder).
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    fetchVersion().then((r) => setVersion(r.version)).catch(() => {});
  }, []);
  // No logout button on loopback (there's no cookie to clear — the user just
  // reaches the dashboard directly). On a public/tunnel URL the button is
  // meaningful because it clears the session cookie.
  const showLogout = authStatus && !authStatus.loopback;

  async function handleLogout() {
    try { await logout(); } catch {}
    // Hard reload to /login — the cleanest way to nuke every in-memory hook
    // state (WebSocket, auth cache, react-router history) that was populated
    // while the user was signed in. A soft navigate would leave stale data
    // hanging around if any component captured it.
    window.location.href = "/login";
  }

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
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-sm font-bold">Gacor-Router</span>
            {version && (
              <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
                v{version}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: wsMeta.color, boxShadow: `0 0 6px ${wsMeta.color}` }}
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
                      // `relative` anchors the left-rail accent for the
                      // active state so the current page announces itself
                      // beyond just a tint (audit callout: sidebar sameness).
                      "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-primary/15 font-medium text-primary"
                        : "text-secondary-foreground hover:bg-secondary hover:text-foreground"
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                      )}
                      <item.icon className="h-4 w-4 shrink-0" />
                      {item.label}
                    </>
                  )}
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
        {showLogout && (
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-secondary-foreground hover:bg-error/10 hover:text-error"
          >
            <LogOut className="h-4 w-4" /> Logout
          </button>
        )}
      </div>
    </aside>
  );
}
