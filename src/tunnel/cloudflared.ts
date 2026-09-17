// cloudflared binary management + quick tunnel spawning (9Router-derived,
// simplified). The binary is downloaded once from Cloudflare's GitHub
// releases and cached under the data dir; quick tunnels need no account and
// yield a https://<random>.trycloudflare.com URL pointing at the local port.

import { spawn, type Subprocess } from "bun";
import { mkdirSync, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, arch, tmpdir } from "node:os";
import { join } from "node:path";
import { clearPid, isPidAlive, loadPid, savePid } from "./pid";

const BIN_DIR = join(homedir(), ".gacor-router", "bin");
const BIN_NAME = platform() === "win32" ? "cloudflared.exe" : "cloudflared";
const BIN_PATH = join(BIN_DIR, BIN_NAME);

const GITHUB_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";

// Only the platforms we can actually test matter; extend as needed.
function downloadUrl(): string {
  const p = platform();
  const a = arch();
  if (p === "darwin" && a === "arm64") return `${GITHUB_BASE}/cloudflared-darwin-arm64.tgz`;
  if (p === "darwin") return `${GITHUB_BASE}/cloudflared-darwin-amd64.tgz`;
  if (p === "linux" && a === "arm64") return `${GITHUB_BASE}/cloudflared-linux-arm64`;
  if (p === "linux") return `${GITHUB_BASE}/cloudflared-linux-amd64`;
  if (p === "win32") return `${GITHUB_BASE}/cloudflared-windows-amd64.exe`;
  throw new Error(`unsupported platform: ${p}/${a}`);
}

const MIN_BINARY_SIZE = 1024 * 1024; // real binary is ~30MB; catches truncated/error pages

// Shared download state so the status endpoint can show progress.
const dl = { downloading: false, progress: 0, error: null as string | null };

export function getDownloadStatus() {
  return { downloading: dl.downloading, progress: dl.progress, error: dl.error };
}

function isValidBinary(path: string): boolean {
  try {
    return statSync(path).size >= MIN_BINARY_SIZE;
  } catch {
    return false;
  }
}

async function downloadAndExtract(dest: string): Promise<void> {
  const url = downloadUrl();
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok || !resp.body) throw new Error(`download failed: HTTP ${resp.status}`);

  const total = Number(resp.headers.get("content-length")) || 0;
  const isTgz = url.endsWith(".tgz");
  const tmpFile = join(tmpdir(), `cloudflared-dl-${Date.now()}${isTgz ? ".tgz" : ""}`);

  // Stream to disk while tracking progress.
  const reader = resp.body.getReader();
  const writer = Bun.file(tmpFile).writer();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    dl.progress = total > 0 ? Math.round((received / total) * 100) : 0;
    writer.write(value);
  }
  await writer.end();

  if (isTgz) {
    // Extract the single binary out of the tarball.
    const proc = Bun.spawn(["tar", "-xzf", tmpFile, "-C", tmpdir(), "cloudflared"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`tar extract failed (code ${code})`);
    const extracted = join(tmpdir(), "cloudflared");
    await Bun.write(dest, Bun.file(extracted));
  } else {
    await Bun.write(dest, Bun.file(tmpFile));
  }
}

let downloadPromise: Promise<string> | null = null;

// Resolve the binary path, downloading once if missing or invalid. Concurrent
// callers share the same download.
export function ensureCloudflared(): Promise<string> {
  if (isValidBinary(BIN_PATH)) return Promise.resolve(BIN_PATH);
  if (downloadPromise) return downloadPromise;

  downloadPromise = (async () => {
    dl.downloading = true;
    dl.progress = 0;
    dl.error = null;
    try {
      mkdirSync(BIN_DIR, { recursive: true });
      await downloadAndExtract(BIN_PATH);
      if (!isValidBinary(BIN_PATH)) throw new Error("downloaded binary failed validation");
      if (platform() !== "win32") chmodSync(BIN_PATH, 0o755);
      return BIN_PATH;
    } catch (err) {
      dl.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      dl.downloading = false;
      downloadPromise = null;
    }
  })();

  return downloadPromise;
}

// ── Process management ───────────────────────────────────────────

let child: Subprocess | null = null;
let intentionalKill = false;
let onUnexpectedExit: (() => void) | null = null;

export function setUnexpectedExitHandler(handler: (() => void) | null): void {
  onUnexpectedExit = handler;
}

// Test seam: the API test uses a stub spawner that never sets `child`,
// so isCloudflaredRunning() would return false and the coherent-status
// gate would collapse `enabled` to false. Setting the override lets a
// test simulate "cloudflared alive" without actually spawning one.
let runningOverride: (() => boolean) | null = null;
export function setRunningOverrideForTests(fn: (() => boolean) | null): void {
  runningOverride = fn;
}

export function isCloudflaredRunning(): boolean {
  if (runningOverride) return runningOverride();
  // Fast path: we spawned it in this process and it's still up.
  if (child !== null && child.exitCode === null) return true;
  // Persisted path: a previous backend instance spawned it (systemd unit
  // stayed up while our own process restarted). Signal-0 probe reveals
  // whether the pid still exists.
  const pid = loadPid();
  if (pid && isPidAlive(pid)) return true;
  // Stale PID file (process crashed while we were down) — clear it so a
  // future call doesn't keep re-probing a dead pid.
  if (pid) clearPid();
  return false;
}

export interface QuickTunnel {
  url: string;
}

const URL_RE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;

// Parse the quick-tunnel URL from cloudflared's log output. Skips
// api.trycloudflare.com, which appears in logs but is not the tunnel.
export function parseQuickTunnelUrl(logChunk: string): string | null {
  let found: string | null = null;
  for (const match of logChunk.matchAll(URL_RE)) {
    const host = match[1]!.toLowerCase();
    if (host === "api") continue;
    found = `https://${host}.trycloudflare.com`;
  }
  return found;
}

// Spawn `cloudflared tunnel --url http://127.0.0.1:<port>` and resolve with
// the trycloudflare URL parsed from its log output. The child keeps running
// after resolution; killCloudflared() stops it.
export function spawnQuickTunnel(localPort: number): Promise<QuickTunnel> {
  return ensureCloudflared().then(
    (bin) =>
      new Promise<QuickTunnel>((resolve, reject) => {
        // Isolated config dir avoids picking up a user's ~/.cloudflared/config.yml
        // (would otherwise turn a quick tunnel into an authenticated one).
        // Cleaned up in the exit handler + on kill.
        const configDir = mkdtempSync(join(tmpdir(), "gacor-cf-"));
        const configPath = join(configDir, "config.yml");
        writeFileSync(configPath, "# gacor quick-tunnel placeholder\n");

        // --retries 99 keeps the tunnel alive across brief edge disconnects
        // (cloudflared handles the re-handshake internally, URL stays valid).
        const proc = spawn({
          cmd: [
            bin,
            "tunnel",
            "--url",
            `http://127.0.0.1:${localPort}`,
            "--config",
            configPath,
            "--no-autoupdate",
            "--retries",
            "99",
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        child = proc;
        if (typeof proc.pid === "number") savePid(proc.pid);

        const cleanupConfig = () => {
          try {
            rmSync(configDir, { recursive: true, force: true });
          } catch {
            // Best-effort — the OS will reap tmp eventually.
          }
        };

        let settled = false;
        let logTail = "";
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          killCloudflared(localPort);
          cleanupConfig();
          reject(new Error(`quick tunnel timed out. Last log: ${logTail.slice(-600) || "(empty)"}`));
        }, 90_000);

        const handleChunk = (chunk: string) => {
          logTail = (logTail + chunk).slice(-4000);
          const url = parseQuickTunnelUrl(chunk);
          if (url && !settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ url });
          }
        };

        const pump = async (stream: ReadableStream<Uint8Array>) => {
          const decoder = new TextDecoder();
          const reader = stream.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              handleChunk(decoder.decode(value, { stream: true }));
            }
          } catch {
            // Stream closed on kill — the exit handler below reports it.
          }
        };
        if (proc.stdout) pump(proc.stdout as ReadableStream<Uint8Array>);
        if (proc.stderr) pump(proc.stderr as ReadableStream<Uint8Array>);

        proc.exited.then((code) => {
          child = null;
          clearPid();
          cleanupConfig();
          const wasSettled = settled;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(
              new Error(
                `cloudflared exited (code ${code}). ` +
                  `Common causes: outbound 7844 blocked, or 127.0.0.1:${localPort} unreachable. ` +
                  `Last log: ${logTail.slice(-400).trim() || "(empty)"}`
              )
            );
            return;
          }
          // Exited after a successful connect: deliberate kills stay silent,
          // anything else is worth surfacing for a future watchdog.
          if (intentionalKill) {
            intentionalKill = false;
            return;
          }
          if (wasSettled && onUnexpectedExit) onUnexpectedExit();
        });
      })
  );
}

// Best-effort orphan reaper: after a backend restart, our in-memory `child`
// is null but a cloudflared spawned by the previous instance may still be
// bound to the same local port. pkill -f targets exactly those, with a
// port-boundary check so :7788 doesn't also nuke :77880 or :17788.
function killOrphansByPort(localPort: number): void {
  if (platform() === "win32") return; // no orphans on our target VPS
  try {
    Bun.spawnSync({
      cmd: ["pkill", "-f", `cloudflared.*:${localPort}([^0-9]|$)`],
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // pkill missing / no match — both are fine, we've done what we can.
  }
}

export function killCloudflared(localPort?: number): void {
  if (child && child.exitCode === null) {
    intentionalKill = true;
    child.kill();
  }
  child = null;
  // PID-file kill: covers "backend restarted, we lost the child ref but the
  // cloudflared process is still up under init".
  const pid = loadPid();
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      // Already dead / permission-denied — either way, drop the stale file.
    }
    clearPid();
  }
  if (typeof localPort === "number") killOrphansByPort(localPort);
}
