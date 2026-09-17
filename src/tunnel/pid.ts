// PID persistence for cloudflared. Lets isCloudflaredRunning() survive a
// backend restart (systemd reload, dev watch) — without it the process check
// only sees the in-memory `child` reference, which is null on every fresh
// boot even if a cloudflared process is still alive under init/systemd.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TUNNEL_DIR = join(homedir(), ".gacor-router", "tunnel");
const PID_FILE = join(TUNNEL_DIR, "cloudflared.pid");

function ensureDir(): void {
  if (!existsSync(TUNNEL_DIR)) mkdirSync(TUNNEL_DIR, { recursive: true });
}

export function savePid(pid: number): void {
  ensureDir();
  writeFileSync(PID_FILE, String(pid));
}

export function loadPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function clearPid(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // Racing with another writer or transient FS error — the next call
    // sorts it out.
  }
}

// Signal-0 probe: doesn't actually deliver a signal, just checks whether
// the pid exists and we have permission to signal it. Cheapest liveness
// check available on POSIX. Windows: process.kill also supports signal 0.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
