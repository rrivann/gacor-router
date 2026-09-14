// Management API for the dashboard. All routes live under /api and are
// unauthenticated by design — the router binds to 127.0.0.1 and is
// single-user. If that ever changes, gate these first.

import { Hono } from "hono";
import {
  createAccount,
  deleteAccount,
  deleteSetting,
  getAccount,
  listAllAccounts,
  listSettings,
  setAccountStatus,
  setSetting,
} from "../db/accounts";
import {
  dashboardStats,
  getRequestLog,
  listRequestLogs,
  modelUsage,
} from "../db/logs";
import { errorResponse } from "../lib/http";
import { disableTunnel, enableTunnel, getTunnelStatus } from "../tunnel/manager";
import { fetchAndCacheUsage, UsageError } from "../lib/usage";
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  updateChatSession,
} from "../db/chats";
import { env } from "../lib/env";

export const manage = new Hono();

// ── Accounts ─────────────────────────────────────────────────────

manage.get("/accounts", (c) => {
  const provider = c.req.query("provider") || undefined;
  return c.json({ data: listAllAccounts(provider) });
});

manage.post("/accounts", async (c) => {
  let body: { provider?: unknown; label?: unknown; secret?: unknown; creds?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (typeof body.provider !== "string" || body.provider.length === 0) {
    return errorResponse(400, "invalid_request_error", "`provider` must be a non-empty string", "provider");
  }
  const secret = typeof body.secret === "string" ? body.secret : "";
  const creds =
    typeof body.creds === "object" && body.creds !== null
      ? (body.creds as Record<string, string>)
      : undefined;
  if (secret.length === 0 && Object.keys(creds ?? {}).length === 0) {
    return errorResponse(400, "invalid_request_error", "either `secret` or `creds` is required");
  }
  const id = createAccount({
    provider: body.provider,
    label: typeof body.label === "string" ? body.label : undefined,
    secret,
    creds,
  });
  return c.json({ success: true, id }, 201);
});

// Verbatim credentials — the UI reveal button calls this.
manage.get("/accounts/:id/reveal", (c) => {
  const id = Number(c.req.param("id"));
  const row = getAccount(id);
  if (!row) return errorResponse(404, "invalid_request_error", `account #${id} not found`);
  return c.json({ id: row.id, secret: row.secret, creds: row.creds ?? {} });
});

manage.post("/accounts/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  let body: { status?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (body.status !== "active" && body.status !== "exhausted" && body.status !== "banned") {
    return errorResponse(400, "invalid_request_error", "`status` must be active | exhausted | banned", "status");
  }
  if (!getAccount(id)) return errorResponse(404, "invalid_request_error", `account #${id} not found`);
  setAccountStatus(id, body.status);
  return c.json({ success: true, id, status: body.status });
});

manage.delete("/accounts/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!deleteAccount(id)) {
    return errorResponse(404, "invalid_request_error", `account #${id} not found`);
  }
  return c.json({ success: true, id });
});

// ── Request logs ─────────────────────────────────────────────────

manage.get("/stats/requests", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const provider = c.req.query("provider") || undefined;
  return c.json({ data: listRequestLogs({ limit, offset, provider }) });
});

manage.get("/stats/requests/:id", (c) => {
  const id = Number(c.req.param("id"));
  const row = getRequestLog(id);
  if (!row) return errorResponse(404, "invalid_request_error", `request log #${id} not found`);
  return c.json({ data: row });
});

manage.get("/stats/dashboard", (c) => c.json(dashboardStats()));

manage.get("/stats/models", (c) => c.json({ data: modelUsage() }));

// ── Settings ─────────────────────────────────────────────────────

manage.get("/settings", (c) => c.json({ data: listSettings() }));

manage.put("/settings", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_request_error", "body must be a JSON object of key → value");
  }
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      return errorResponse(400, "invalid_request_error", `setting "${key}" must be a string`, key);
    }
  }
  for (const [key, value] of Object.entries(body)) setSetting(key, value as string);
  return c.json({ success: true, data: listSettings() });
});

manage.delete("/settings/:key", (c) => {
  const key = c.req.param("key");
  if (!deleteSetting(key)) {
    return errorResponse(404, "invalid_request_error", `setting "${key}" not found`);
  }
  return c.json({ success: true, key });
});

// ── Tunnel (Cloudflare quick tunnel) ─────────────────────────────
// Exposes the local router on a public https://*.trycloudflare.com URL.
// Enable/disable are idempotent; status is safe to poll.

manage.get("/tunnel/status", (c) => c.json(getTunnelStatus()));

manage.post("/tunnel/enable", async (c) => {
  const result = await enableTunnel(env.port);
  if (!result.success) {
    return errorResponse(502, "internal_error", result.error ?? "tunnel enable failed");
  }
  return c.json(result);
});

manage.post("/tunnel/disable", (c) => c.json(disableTunnel()));

// ── Account usage (credit snapshots) ─────────────────────────────

manage.get("/accounts/:id/usage", (c) => {
  const id = Number(c.req.param("id"));
  const row = getAccount(id);
  if (!row) return errorResponse(404, "invalid_request_error", `account #${id} not found`);
  return c.json({ data: row.usageJson ?? null, fetchedAt: row.usageAt ?? null });
});

manage.post("/accounts/:id/usage/refresh", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const usage = await fetchAndCacheUsage(id);
    return c.json({ data: usage });
  } catch (err) {
    if (err instanceof UsageError) {
      return errorResponse(err.status, "internal_error", err.message);
    }
    return errorResponse(502, "internal_error", err instanceof Error ? err.message : String(err));
  }
});

// ── AI Chat sessions ─────────────────────────────────────────────
// Persistence for the dashboard's chat playground. `messages` is an opaque
// JSON blob owned by the frontend.

manage.get("/chat/sessions", (c) => c.json({ sessions: listChatSessions() }));

manage.get("/chat/sessions/:id", (c) => {
  const id = Number(c.req.param("id"));
  const row = getChatSession(id);
  if (!row) return errorResponse(404, "invalid_request_error", `session #${id} not found`);
  return c.json(row);
});

manage.post("/chat/sessions", async (c) => {
  let body: { title?: unknown; model?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  const id = createChatSession({
    title: typeof body.title === "string" ? body.title : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
  });
  return c.json({ id }, 201);
});

manage.put("/chat/sessions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  let body: { title?: unknown; model?: unknown; messages?: unknown; msgCount?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  const ok = updateChatSession(id, {
    title: typeof body.title === "string" ? body.title : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    messages: typeof body.messages === "string" ? body.messages : undefined,
    msgCount: typeof body.msgCount === "number" ? body.msgCount : undefined,
  });
  if (!ok) return errorResponse(404, "invalid_request_error", `session #${id} not found`);
  return c.json({ ok: true });
});

manage.delete("/chat/sessions/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!deleteChatSession(id)) {
    return errorResponse(404, "invalid_request_error", `session #${id} not found`);
  }
  return c.json({ ok: true });
});
