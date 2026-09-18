import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Globe, Loader2, Power, RefreshCw, RotateCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/PageHeader";
import { Alert } from "../components/ui/Alert";
import {
  disableTunnel,
  enableTunnel,
  fetchTunnelStatus,
  regenerateShortId,
  setPublicUrlEnabled,
  type TunnelStatus,
} from "../lib/api";
import { cn, copyToClipboard } from "../lib/utils";

// Cloudflare quick tunnel: exposes the router on a public trycloudflare.com
// URL. Status is polled while an enable is in flight (binary download +
// spawn); steady state needs no polling at all.
export default function Tunnel() {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Track which URL was last copied so the check icon renders on the right
  // row. "direct" and "public" refer to the two URL slots below.
  const [copied, setCopied] = useState<null | "direct" | "public">(null);
  const [togglingPublicUrl, setTogglingPublicUrl] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchTunnelStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll only while something is happening (download or spawn); idle stops.
  useEffect(() => {
    const active =
      status?.enabling || status?.download.downloading;
    if (active && !pollRef.current) {
      pollRef.current = setInterval(load, 1000);
    } else if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      clearInterval(pollRef.current ?? undefined);
      pollRef.current = null;
    };
  }, [status?.enabling, status?.download.downloading, load]);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      await load(); // flip status.enabling so the poll starts immediately
      const result = await enableTunnel();
      if (!result.success) setError("tunnel enable failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function handleDisable() {
    setBusy(true);
    try {
      await disableTunnel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function handleCopy(which: "direct" | "public") {
    const text = which === "direct" ? status?.url : status?.publicUrl;
    if (!text) return;
    if (!(await copyToClipboard(text))) return;
    setCopied(which);
    setTimeout(() => setCopied((cur) => (cur === which ? null : cur)), 1500);
  }

  async function handleTogglePublicUrl(enabled: boolean) {
    setTogglingPublicUrl(true);
    try {
      await setPublicUrlEnabled(enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingPublicUrl(false);
      await load();
    }
  }

  async function handleRegenerateShortId() {
    if (!confirm("Generate a new stable URL? The current one will stop working immediately.")) return;
    setRegenerating(true);
    try {
      await regenerateShortId();
      // Re-enable so the new id gets registered with the worker. Otherwise
      // the stable URL would 502 until the next spawn.
      if (status?.enabled) {
        await enableTunnel();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegenerating(false);
      await load();
    }
  }

  // Backend now guarantees `enabled` is only true when the process is
  // actually up (see getTunnelStatus). Coupling the URL check here is
  // belt-and-suspenders — the backend also nulls a stale URL in that case.
  const active = status?.enabled && status?.url;
  const working = busy || status?.enabling || status?.download.downloading;
  // User intent was "on" but cloudflared isn't alive (crash, backend
  // restart, network-driven exit). Distinct from user-off so we can prompt
  // reconnection instead of silently rendering offline.
  const crashed = !!status && status.settingsEnabled && !status.running && !working;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="Tunnel"
        subtitle="Expose this router publicly via a Cloudflare quick tunnel — no account needed"
      />

      {error && <Alert variant="error">{error}</Alert>}
      {status?.download.error && (
        <Alert variant="error">cloudflared download failed: {status.download.error}</Alert>
      )}
      {crashed && (
        <Alert variant="warning">
          Tunnel disconnected — cloudflared is no longer running. Click <span className="font-medium">Enable Tunnel</span> to reconnect.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-xl",
                  active ? "bg-success/10" : "bg-secondary"
                )}
              >
                <Globe className={cn("h-5 w-5", active ? "text-success" : "text-muted-foreground")} />
              </div>
              <div>
                <CardTitle className="flex items-center gap-2">
                  Public Access
                  <Badge variant={active ? "success" : crashed ? "error" : "secondary"}>
                    {working ? "working" : active ? "online" : crashed ? "disconnected" : "offline"}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {active
                    ? "Router is reachable from the internet"
                    : "Enable to get a public https://*.trycloudflare.com URL"}
                </CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Stable public URL (abc-tunnel.us) — persistent across restarts.
              Recommended for clients that hardcode the URL. */}
          {status?.publicUrl && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  Stable URL
                  <Badge variant="success">recommended</Badge>
                </span>
                <span>persistent across restarts</span>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2.5">
                <code className="flex-1 truncate text-sm text-success">{status.publicUrl}</code>
                <Button variant="ghost" size="icon" onClick={() => handleCopy("public")} aria-label="Copy stable URL">
                  {copied === "public" ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}

          {/* Direct trycloudflare.com URL — rotates on every enable. */}
          {status?.url && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Direct URL</span>
                <span>changes on every enable</span>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2.5">
                <code className="flex-1 truncate text-sm text-secondary-foreground">{status.url}</code>
                <Button variant="ghost" size="icon" onClick={() => handleCopy("direct")} aria-label="Copy direct URL">
                  {copied === "direct" ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}

          {/* Download progress */}
          {status?.download.downloading && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Downloading cloudflared binary (first run only)…</span>
                <span className="tabular-nums">{status.download.progress}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${status.download.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Spawning indicator */}
          {status?.enabling && !status.download.downloading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting tunnel — waiting for the public URL…
            </div>
          )}

          {/* Process state */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-secondary-foreground">cloudflared process</span>
            <Badge variant={status?.running ? "success" : "secondary"}>
              {status?.running ? "running" : "stopped"}
            </Badge>
          </div>

          <div className="flex gap-2 border-t border-border pt-4">
            {active ? (
              <Button variant="destructive" onClick={handleDisable} disabled={busy}>
                <Power className="h-4 w-4" /> Disable Tunnel
              </Button>
            ) : (
              <Button onClick={handleEnable} disabled={working}>
                {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                Enable Tunnel
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Clients can then use{" "}
            <code className="rounded bg-secondary px-1 py-0.5">
              {status?.url ? `${status.url}/v1` : "https://<url>/v1"}
            </code>{" "}
            as their OpenAI-compatible base URL.
          </p>

          {/* Stable URL feature toggle + regenerate — bottom of the card so it
              stays out of the way but remains reachable. */}
          <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-3">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={status?.publicUrlEnabled ?? true}
                onChange={(e) => handleTogglePublicUrl(e.target.checked)}
                disabled={togglingPublicUrl}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border accent-primary"
              />
              <div className="flex-1 text-xs">
                <div className="font-medium text-foreground">Use abc-tunnel.us for stable URL</div>
                <p className="mt-0.5 text-muted-foreground">
                  Registers this router with a third-party worker so{" "}
                  <code className="rounded bg-secondary px-1">r&lt;id&gt;.abc-tunnel.us</code> stays
                  valid across restarts. Traffic proxies through the worker — disable for a
                  direct-only path.
                </p>
              </div>
            </label>
            {status?.publicUrlEnabled && status?.shortId && (
              <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
                <span className="text-muted-foreground">
                  shortId: <code className="rounded bg-secondary px-1">{status.shortId}</code>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRegenerateShortId}
                  disabled={regenerating || working}
                  className="h-7 text-xs"
                >
                  {regenerating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCw className="h-3.5 w-3.5" />
                  )}
                  Regenerate
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
