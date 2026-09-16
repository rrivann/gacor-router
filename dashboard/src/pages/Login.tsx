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
      <Card className="w-full max-w-sm p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/15 p-2.5 text-primary">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Gacor Router</h1>
            <p className="text-xs text-muted-foreground">Sign in to the dashboard</p>
          </div>
        </div>

        {status?.needsPassword && (
          <div className="mt-5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            First login — the default password is <code className="font-mono">123456</code>.
            You'll be asked to change it right after.
          </div>
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
            <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={busy || !password}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Sign in
          </Button>
        </form>

        <p className="mt-4 text-[10px] text-muted-foreground">
          Forgot password? SSH to the VPS and run{" "}
          <code className="rounded bg-secondary px-1 py-0.5 font-mono">bun run scripts/reset-password.ts &lt;new&gt;</code>
        </p>
      </Card>
    </div>
  );
}
