// Tunnel state machine: enable → download (if needed) → spawn → URL persisted
// to settings (survives restarts); disable → kill + clear. Status is read
// from live process state, with the settings URL as the last-known value.

import {
  getDownloadStatus,
  isCloudflaredRunning,
  killCloudflared,
  spawnQuickTunnel,
} from "./cloudflared";
import { getSetting, setSetting } from "../db/accounts";
import { env } from "../lib/env";
import { WORKER_URL, generateShortId, publicUrlFor } from "./config";

// enable/disable both go through the current listener port so orphan pkill
// can scope by :port. Read once via env — the router doesn't hot-swap ports.
const LOCAL_PORT = env.port;

const SETTING_ENABLED = "tunnel_enabled";
const SETTING_URL = "tunnel_url";
// Persistent identity for the abc-tunnel.us stable URL — generated once on
// first enable, reused across every restart so users' bookmarked URL stays
// valid even though cloudflared's raw URL rotates.
const SETTING_SHORT_ID = "tunnel_short_id";
// Opt-out toggle. Defaults on (populated on first enable) — a user who
// doesn't want traffic to route through the third-party worker can flip it
// off and continue using the raw trycloudflare URL.
const SETTING_PUBLIC_URL_ENABLED = "tunnel_public_url_enabled";

let enabling: Promise<TunnelResult> | null = null;

// Test seam: the real spawner downloads a binary and spawns a process.
let spawner: (localPort: number) => Promise<{ url: string }> = spawnQuickTunnel;

export function setSpawnerForTests(fn: typeof spawner): void {
  spawner = fn;
}

export interface TunnelStatus {
  // Coherent liveness: user asked for it AND the process is up. Dashboards
  // and health checks should read this, not the raw settings flag.
  enabled: boolean;
  // User's intent — flipped only by explicit enable/disable clicks. Lets the
  // UI distinguish "user turned it off" (silent) from "was on but crashed"
  // (needs a nudge).
  settingsEnabled: boolean;
  running: boolean;
  url: string | null;
  // Stable public URL via abc-tunnel.us — https://r<shortId>.abc-tunnel.us.
  // Null when the feature is off, the tunnel is dead, or the shortId hasn't
  // been minted yet. Persistent across restarts once minted.
  publicUrl: string | null;
  publicUrlEnabled: boolean;
  shortId: string | null;
  enabling: boolean;
  download: { downloading: boolean; progress: number; error: string | null };
}

export interface TunnelResult {
  success: boolean;
  url?: string;
  publicUrl?: string | null;
  shortId?: string | null;
  error?: string;
}

// Public URL toggle defaults on. Reading through this helper keeps the
// default logic in one place: an unset setting means "not yet touched by
// the user" → treat as enabled.
function isPublicUrlEnabled(): boolean {
  const raw = getSetting(SETTING_PUBLIC_URL_ENABLED);
  if (raw === "false") return false;
  return true;
}

export function getTunnelStatus(): TunnelStatus {
  const settingsEnabled = getSetting(SETTING_ENABLED) === "true";
  const running = isCloudflaredRunning();
  const storedUrl = getSetting(SETTING_URL);
  const storedShortId = getSetting(SETTING_SHORT_ID) || null;
  const publicUrlEnabled = isPublicUrlEnabled();
  // Stable URL is only useful when: user opted in, we minted an id, and the
  // tunnel is actually up (worker would proxy to nothing otherwise).
  const publicUrl =
    publicUrlEnabled && storedShortId && running ? publicUrlFor(storedShortId) : null;
  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    running,
    // Hide the URL when the process is dead — otherwise the dashboard would
    // display a stale https://... that returns Cloudflare Error 1033.
    url: running && storedUrl ? storedUrl : null,
    publicUrl,
    publicUrlEnabled,
    shortId: storedShortId,
    enabling: enabling !== null,
    download: getDownloadStatus(),
  };
}

// Best-effort registration with abc-tunnel.us so `https://r<id>.abc-tunnel.us`
// proxies to the current quick-tunnel URL. Never throws — a dead worker,
// captive portal, or network error must not break tunnel enable, since the
// raw trycloudflare URL is still usable.
async function registerTunnelUrl(shortId: string, tunnelUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${WORKER_URL}/api/tunnel/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shortId, tunnelUrl }),
      // 15s covers cold connections to abc-tunnel.us on slow networks —
      // shorter timeouts made the first enable after boot fall back to
      // "worker down" when the network was actually fine, just slow.
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Explicit reset: the user picks a new random shortId (invalidating the
// previous stable URL). Useful if someone else hijacked the id via the
// unauthenticated worker endpoint. Does not touch the running tunnel — the
// caller re-registers on the next enable.
export function regenerateShortId(): string {
  const next = generateShortId();
  setSetting(SETTING_SHORT_ID, next);
  return next;
}

export function setPublicUrlEnabled(enabled: boolean): void {
  setSetting(SETTING_PUBLIC_URL_ENABLED, enabled ? "true" : "false");
}

// Called at boot: if user's intent is "enabled" but no cloudflared is
// alive (crashed while we were down, or systemd restarted us cleanly),
// wipe the stored URL so the dashboard reflects reality on first render.
// We deliberately don't auto-respawn — a real config failure would loop
// silently. The user clicks Enable to intentionally reconnect.
export function reconcileTunnel(): void {
  const settingsEnabled = getSetting(SETTING_ENABLED) === "true";
  if (settingsEnabled && !isCloudflaredRunning()) {
    setSetting(SETTING_URL, "");
  }
}

export async function enableTunnel(localPort: number): Promise<TunnelResult> {
  // A second click while one enable is in flight joins it instead of
  // spawning two cloudflared processes.
  if (enabling) return enabling;

  enabling = (async (): Promise<TunnelResult> => {
    try {
      killCloudflared(localPort); // clear any stale process before re-spawning
      const { url } = await spawner(localPort);
      setSetting(SETTING_ENABLED, "true");
      setSetting(SETTING_URL, url);

      // Public URL side: reuse an existing shortId (persistent identity)
      // or mint one now on first enable. Register best-effort — a failing
      // worker call still lets the raw URL work.
      let shortId = getSetting(SETTING_SHORT_ID);
      if (!shortId) {
        shortId = generateShortId();
        setSetting(SETTING_SHORT_ID, shortId);
      }
      let publicUrl: string | null = null;
      if (isPublicUrlEnabled()) {
        const ok = await registerTunnelUrl(shortId, url);
        publicUrl = ok ? publicUrlFor(shortId) : null;
        if (!ok) {
          // eslint-disable-next-line no-console
          console.warn(`[tunnel] abc-tunnel register failed — stable URL disabled for this session`);
        }
      }
      return { success: true, url, publicUrl, shortId };
    } catch (err) {
      setSetting(SETTING_ENABLED, "false");
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      enabling = null;
    }
  })();

  return enabling;
}

export function disableTunnel(): TunnelResult {
  killCloudflared(LOCAL_PORT);
  setSetting(SETTING_ENABLED, "false");
  setSetting(SETTING_URL, "");
  return { success: true };
}
