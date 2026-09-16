// Route wrapper that gates the dashboard behind a valid session. Redirects
// to /login when the backend says the request isn't authenticated (and a
// password does exist). While the status probe is in flight, shows a spinner
// so the page doesn't flash the layout for unauthenticated users.

import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "../hooks/useAuth";

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, loading } = useAuth();

  if (loading || !status) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!status.authenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
