import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2, Plus, RefreshCw, Settings as SettingsIcon, Trash2, Zap } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Toggle } from "../components/ui/toggle";
import { PageHeader } from "../components/ui/PageHeader";
import { Alert } from "../components/ui/Alert";
import { changePassword, deleteSetting, fetchSettings, saveSettings } from "../lib/api";
import { useTimedMessage } from "../hooks/useTimedMessage";
import { useAuth } from "../hooks/useAuth";

// Settings is a flat KV store. Two keys have structural meaning to the
// router (default_provider, pool_rotation:<provider>); the rest is free-form.
export default function Settings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useTimedMessage<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchSettings();
      setSettings(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function ok(text: string) {
    setMessage(text);
    setError(null);
  }
  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  async function handleSave(key: string, value: string) {
    try {
      const res = await saveSettings({ [key]: value });
      setSettings(res.data);
      ok(`Saved ${key}`);
    } catch (err) {
      fail(err);
    }
  }

  async function handleDelete(key: string) {
    try {
      await deleteSetting(key);
      setSettings((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      ok(`Deleted ${key}`);
    } catch (err) {
      fail(err);
    }
  }

  async function handleAdd() {
    const key = newKey.trim();
    if (!key) return;
    await handleSave(key, newValue);
    setNewKey("");
    setNewValue("");
  }

  const entries = Object.entries(settings).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        subtitle="Router key-value configuration"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />

      {message && <Alert variant="success">{message}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>Routing</CardTitle>
          <CardDescription>
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">default_provider</code> lets clients send
            bare model ids without the provider/ prefix
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow
            settingKey="default_provider"
            value={settings.default_provider ?? ""}
            placeholder="codebuddy"
            onSave={handleSave}
            onDelete={handleDelete}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-400" /> Token Saver (RTK)
          </CardTitle>
          <CardDescription>
            Compresses tool output (git diff, grep, ls, build logs) before it reaches the upstream —
            typical savings 5-15% on agentic conversations. Toggle off to send tool results raw. Per-request
            bypass: <code className="rounded bg-secondary px-1 py-0.5 text-xs">X-Token-Saver: off</code> header.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm">
              <div className="font-medium">
                {settings.rtk_enabled === "false" ? "Disabled" : "Enabled"}
              </div>
              <div className="text-xs text-muted-foreground">
                Live savings show up in{" "}
                <a href="/console-log" className="underline hover:text-foreground">
                  Console
                </a>{" "}
                as <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">[RTK] saved …B / …B</code>.
              </div>
            </div>
            <Toggle
              checked={settings.rtk_enabled !== "false"}
              onChange={(next) => handleSave("rtk_enabled", next ? "true" : "false")}
              label="Token Saver"
            />
          </div>
        </CardContent>
      </Card>

      <DashboardPasswordCard />


      <Card>
        <CardHeader>
          <CardTitle>All Settings</CardTitle>
          <CardDescription>{entries.length} key(s) stored</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {entries.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No settings yet</p>
          )}
          {entries.map(([key, value]) => (
            <SettingRow key={key} settingKey={key} value={value} onSave={handleSave} onDelete={handleDelete} />
          ))}

          <div className="flex items-center gap-2 border-t border-border pt-3">
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="new_key"
              className="font-mono text-xs"
            />
            <Input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value"
              className="font-mono text-xs"
            />
            <Button size="sm" onClick={handleAdd} disabled={!newKey.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SettingRow({
  settingKey,
  value,
  placeholder,
  onSave,
  onDelete,
}: {
  settingKey: string;
  value: string;
  placeholder?: string;
  onSave: (key: string, value: string) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== value;

  useEffect(() => setDraft(value), [value]);

  return (
    <div className="flex items-center gap-2">
      <code className="w-56 shrink-0 truncate rounded bg-secondary px-2 py-1.5 text-xs">{settingKey}</code>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) {
            setBusy(true);
            onSave(settingKey, draft).finally(() => setBusy(false));
          }
        }}
      />
      <Button
        size="sm"
        variant={dirty ? "default" : "secondary"}
        disabled={!dirty || busy}
        onClick={() => {
          setBusy(true);
          onSave(settingKey, draft).finally(() => setBusy(false));
        }}
      >
        Save
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${settingKey}`}
        onClick={() => onDelete(settingKey)}
      >
        <Trash2 className="h-4 w-4 text-error" />
      </Button>
    </div>
  );
}

// Change-password card. Auto-opens the form when the router lands here with
// ?changePassword=1 (Login sends first-time users straight here). Successful
// change rotates the JWT secret server-side, so the current cookie is invalid
// on the very next request — we bounce the user to /login as a clean handoff.
function DashboardPasswordCard() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh: refreshAuth } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [autoFilledDefault, setAutoFilledDefault] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(location.search).get("changePassword") === "1" && !autoFilledDefault) {
      setCurrent("123456");
      setAutoFilledDefault(true);
    }
  }, [location.search, autoFilledDefault]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null); setOk(null);
    if (next.length < 6) { setErr("new password must be at least 6 characters"); return; }
    if (next !== confirm) { setErr("passwords don't match"); return; }
    setBusy(true);
    try {
      await changePassword(current, next);
      setOk("Password changed. Redirecting to sign in…");
      setCurrent(""); setNext(""); setConfirm("");
      await refreshAuth();
      setTimeout(() => navigate("/login", { replace: true }), 700);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Dashboard Password
        </CardTitle>
        <CardDescription>
          Changes the password used to sign in to this dashboard. Any existing sessions (including this one)
          are invalidated — you'll be sent to the login screen after saving.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Current password</span>
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">New password (min 6)</span>
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Confirm new password</span>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
          {ok && <div className="sm:col-span-3 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">{ok}</div>}
          {err && <div className="sm:col-span-3 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">{err}</div>}
          <div className="sm:col-span-3 flex justify-end">
            <Button type="submit" size="sm" disabled={busy || !current || !next}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
