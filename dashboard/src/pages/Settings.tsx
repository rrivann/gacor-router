import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { deleteSetting, fetchSettings, saveSettings } from "../lib/api";
import { useTimedMessage } from "../hooks/useTimedMessage";

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">Router key-value configuration</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {message && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</div>
      )}

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
