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

const SETTING_ENABLED = "tunnel_enabled";
const SETTING_URL = "tunnel_url";

let enabling: Promise<TunnelResult> | null = null;

// Test seam: the real spawner downloads a binary and spawns a process.
let spawner: (localPort: number) => Promise<{ url: string }> = spawnQuickTunnel;

export function setSpawnerForTests(fn: typeof spawner): void {
  spawner = fn;
}

export interface TunnelStatus {
  enabled: boolean;
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
  const url = getSetting(SETTING_URL);
  return {
    enabled: getSetting(SETTING_ENABLED) === "true",
    running: isCloudflaredRunning(),
    url: url ? url : null,
    enabling: enabling !== null,
    download: getDownloadStatus(),
  };
}

export async function enableTunnel(localPort: number): Promise<TunnelResult> {
  // A second click while one enable is in flight joins it instead of
  // spawning two cloudflared processes.
  if (enabling) return enabling;

  enabling = (async (): Promise<TunnelResult> => {
    try {
      killCloudflared(); // clear any stale process before re-spawning
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
  killCloudflared();
  setSetting(SETTING_ENABLED, "false");
  setSetting(SETTING_URL, "");
  return { success: true };
}
