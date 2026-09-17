// Centered login card. Handles the two entry paths in one screen:
//   - Fresh install (needsPassword=true) → login form prefilled with "123456"
//     and a hint that this is the default that must be changed after signing in.
//   - Existing password → plain password prompt.
// After successful login, refreshes auth status and navigates back to /.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Loader2 } from "lucide-react";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Alert } from "../components/ui/Alert";
import { login } from "../lib/api";
import { useAuth } from "../hooks/useAuth";

export default function Login() {
  const { status, refresh } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If somehow we land here already authenticated, bounce back to the shell.
  useEffect(() => {
    if (status?.authenticated) navigate("/", { replace: true });
  }, [status?.authenticated, navigate]);

  // Prefill the default on a fresh install so the "just log in and change it"
  // flow doesn't require the user to hunt through docs for "123456".
  useEffect(() => {
    if (status?.needsPassword && !password) setPassword("123456");
  }, [status?.needsPassword, password]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(password);
      await refresh();
      // On first login the backend flags mustChangePassword — send the user
      // straight to Settings so they can change it before touching anything else.
      if (result.mustChangePassword) {
        navigate("/settings?changePassword=1", { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm p-6 shadow-[var(--shadow-overlay)] animate-zoom-in">
        <div className="flex flex-col items-center text-center">
          {/* Prominent icon halo — etteum Login pattern. Centered, larger
              than a header icon so the sign-in screen has a clear focal point. */}
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRound className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-lg font-bold">Gacor Router</h1>
          <p className="text-xs text-muted-foreground">Sign in to the dashboard</p>
        </div>

        {status?.needsPassword && (
          <Alert variant="warning" className="mt-5 text-xs">
            First login — the default password is <code className="font-mono">123456</code>.
            You'll be asked to change it right after.
          </Alert>
        )}

        <form onSubmit={submit} className="mt-5 space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Password</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
              disabled={busy}
            />
          </label>

          {error && (
            <Alert variant="error" className="text-xs">
              {error}
            </Alert>
          )}

          <Button type="submit" className="w-full" disabled={busy || !password}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Sign in
          </Button>
        </form>

        <p className="mt-4 text-center text-[10px] text-muted-foreground">
          Forgot password? SSH to the VPS and run{" "}
          <code className="rounded bg-secondary px-1 py-0.5 font-mono">bun run scripts/reset-password.ts &lt;new&gt;</code>
        </p>
      </Card>
    </div>
  );
}
