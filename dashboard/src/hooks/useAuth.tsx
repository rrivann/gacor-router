// Dashboard auth context. Wraps /api/auth/status so the router can gate on
// authenticated state and any component can read/refetch it. The status is
// cheap (a single DB read + cookie verify) so we refetch on demand rather
// than paying for a subscription.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchAuthStatus, type AuthStatus } from "../lib/api";

interface AuthContextShape {
  status: AuthStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextShape | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await fetchAuthStatus();
      setStatus(s);
    } catch {
      // Network error or 5xx — treat as "not authenticated" so the SPA
      // redirects to /login instead of rendering a broken shell.
      setStatus({ needsPassword: false, authenticated: false, loopback: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ status, loading, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextShape {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
