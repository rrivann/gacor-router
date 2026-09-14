import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";

export default function Layout() {
  const { pathname } = useLocation();
  // Chat owns its own full-height layout (history sidebar + composer pinned
  // to the bottom); the other pages share the padded content container.
  const fullBleed = pathname === "/chat";
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="ml-[220px] min-h-screen">
        {fullBleed ? (
          <Outlet />
        ) : (
          <div className="mx-auto max-w-6xl p-6">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  );
}
