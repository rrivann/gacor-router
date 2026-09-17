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

// enable/disable both go through the current listener port so orphan pkill
// can scope by :port. Read once via env — the router doesn't hot-swap ports.
const LOCAL_PORT = env.port;

const SETTING_ENABLED = "tunnel_enabled";
const SETTING_URL = "tunnel_url";

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
  enabling: boolean;
  download: { downloading: boolean; progress: number; error: string | null };
}

export interface TunnelResult {
  success: boolean;
  url?: string;
  error?: string;
}

export function getTunnelStatus(): TunnelStatus {
  const settingsEnabled = getSetting(SETTING_ENABLED) === "true";
  const running = isCloudflaredRunning();
  const storedUrl = getSetting(SETTING_URL);
  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    running,
    // Hide the URL when the process is dead — otherwise the dashboard would
    // display a stale https://... that returns Cloudflare Error 1033.
    url: running && storedUrl ? storedUrl : null,
    enabling: enabling !== null,
    download: getDownloadStatus(),
  };
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
      return { success: true, url };
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
