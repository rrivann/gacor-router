// gacor-router entrypoint — Hono on Bun.

import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { env } from "./lib/env";
import { api } from "./api";
import { manage } from "./api/manage";
import { onEvent } from "./lib/events";
import { startAutoWarmScheduler } from "./lib/autowarm";
import { startVideoPoller } from "./lib/videoPoller";
import { reconcileTunnel } from "./tunnel/manager";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, name: "Gacor-Router" }));

// Live event feed for the dashboard — every bus event goes to every client.
app.get(
  "/ws",
  upgradeWebSocket(() => {
    let off: (() => void) | null = null;
    return {
      onOpen(_evt, ws) {
        off = onEvent((event) => {
          try {
            ws.send(JSON.stringify(event));
          } catch {
            // A wedged client is cleaned up by its own close event.
          }
        });
      },
      onClose() {
        off?.();
      },
    };
  })
);

app.route("/", api);
app.route("/api", manage);

// ── Dashboard static files ───────────────────────────────────────
// Built SPA lives in dashboard/dist. Unknown non-API paths fall back to
// index.html so client-side routing works on refresh. In dev the Vite
// server owns the UI instead (its proxy forwards /api + /ws here).
const DASHBOARD_DIR = join(import.meta.dir, "..", "dashboard", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function serveFile(path: string): Response | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return new Response(Bun.file(path), {
    headers: { "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream" },
  });
}

app.get("*", (c) => {
  const path = normalize(c.req.path).replace(/^(\.\.[/\\])+/, "");
  const file = serveFile(join(DASHBOARD_DIR, path));
  if (file) return file;
  // SPA fallback — /accounts, /requests, etc. resolve to the shell.
  const shell = serveFile(join(DASHBOARD_DIR, "index.html"));
  if (shell) return shell;
  return c.json({ ok: false, error: "dashboard not built — run: cd dashboard && bun run build" }, 404);
});

const server = Bun.serve({
  port: env.port,
  hostname: env.host,
  fetch: app.fetch,
  websocket,
});

console.log(`gacor-router listening on http://${env.host}:${server.port}`);

// Background auto-warmup: warms accounts whose provider enables it (config in
// settings, re-read every minute). Unref'd — never blocks shutdown.
startAutoWarmScheduler();

// Background video poller: drives every queued/in_progress video_jobs row to
// a terminal state (downloads the mp4 to ./videos on completion). Unref'd.
startVideoPoller();

// Coherence sweep: if the previous process left "tunnel enabled" in settings
// but cloudflared is not actually alive, wipe the stale URL so the dashboard
// doesn't render a dead https://…trycloudflare.com as ONLINE.
reconcileTunnel();
