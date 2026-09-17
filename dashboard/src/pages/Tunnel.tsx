import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Globe, Loader2, Power, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/PageHeader";
import { Alert } from "../components/ui/Alert";
import {
  disableTunnel,
  enableTunnel,
  fetchTunnelStatus,
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
  const [copied, setCopied] = useState(false);
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

  async function handleCopy() {
    if (!status?.url) return;
    if (!(await copyToClipboard(status.url))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const active = status?.enabled && status?.url;
  const working = busy || status?.enabling || status?.download.downloading;

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
                  <Badge variant={active ? "success" : "secondary"}>
                    {working ? "working" : active ? "online" : "offline"}
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
          {/* URL display */}
          {status?.url && (
            <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2.5">
              <code className="flex-1 truncate text-sm text-success">{status.url}</code>
              <Button variant="ghost" size="icon" onClick={handleCopy} aria-label="Copy URL">
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
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
            as their OpenAI-compatible base URL. Quick tunnel URLs are random and change on every enable.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
