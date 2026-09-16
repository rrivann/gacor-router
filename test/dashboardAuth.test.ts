// Dashboard auth (password + JWT session cookie) tests. Same
// DB_PATH-before-import discipline as apiKeys/videoJobs test files — see
// reference_test_db_binding.

import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `gacor-dashauth-test-${Bun.randomUUIDv7()}.db`);
process.env.DB_PATH = dbPath;

new Database(dbPath).exec(`
  CREATE TABLE accounts (id integer primary key autoincrement, provider text not null,
    label text, secret text default '' not null, creds text,
    status text default 'active' not null, usage_json text, usage_at integer,
    created_at integer not null);
  CREATE TABLE settings (key text primary key, value text not null);
  CREATE TABLE chat_sessions (
    id integer primary key autoincrement,
    title text not null default 'New chat',
    model text not null default '',
    messages text not null default '[]',
    msg_count integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );
  CREATE TABLE request_logs (
    id integer primary key autoincrement,
    created_at integer not null,
    provider text not null,
    model text,
    account_id integer,
    account_label text,
    stream integer default 0 not null,
    source text default 'proxy' not null,
    status text not null,
    http_status integer,
    outcome text,
    duration_ms integer,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    cached_tokens integer,
    cache_write_tokens integer,
    reasoning_tokens integer,
    ttft_ms integer,
    credit_used real,
    dollar_cost real,
    error_message text,
    request_body text,
    response_body text
  );
  CREATE TABLE content_filters (
    id integer primary key autoincrement,
    pattern text not null,
    replacement text not null default '',
    is_regex integer not null default 0,
    is_active integer not null default 1,
    sort integer not null default 0,
    provider_scope text,
    created_at integer not null
  );
  CREATE TABLE api_keys (
    id integer primary key autoincrement,
    label text not null default '',
    secret text not null,
    enabled integer not null default 1,
    token_limit integer not null default 0,
    tokens_used integer not null default 0,
    max_concurrent integer not null default 0,
    expires_at integer,
    last_used_at integer,
    allowed_models text,
    allowed_providers text,
    created_at integer not null
  );
  CREATE UNIQUE INDEX idx_api_keys_secret ON api_keys (secret);
  CREATE TABLE video_jobs (
    id integer primary key autoincrement,
    provider text not null,
    model text not null,
    account_id integer not null,
    account_label text,
    api_key_id integer,
    task_id text not null,
    status text default 'queued' not null,
    params text not null,
    file_path text,
    file_size integer,
    video_url text,
    credit_used real,
    dollar_cost real,
    error_message text,
    request_log_id integer,
    created_at integer not null,
    updated_at integer,
    completed_at integer
  );
  CREATE INDEX idx_video_jobs_status_created ON video_jobs (status, created_at);
  CREATE INDEX idx_video_jobs_task ON video_jobs (task_id);
  CREATE TABLE dashboard_auth (
    id integer primary key autoincrement,
    password_hash text not null,
    jwt_secret text not null,
    created_at integer not null,
    updated_at integer not null
  );
`);

const { manage } = await import("../src/api/manage");
const { sqlite } = await import("../src/db/index");
const { invalidateDashboardAuthCache } = await import("../src/lib/dashboardAuth");
const { _resetLoginLimiter } = await import("../src/lib/loginLimiter");

beforeAll(() => {
  // Force non-loopback so the session gate actually engages — otherwise the
  // bypass would make every assertion trivially true.
  process.env.HOST = "0.0.0.0";
});

afterAll(() => {
  delete process.env.HOST;
  sqlite.exec("DELETE FROM dashboard_auth");
  invalidateDashboardAuthCache();
});

beforeEach(() => {
  // Clean slate per test so state (password row + rate-limit map + cache)
  // never leaks between assertions.
  sqlite.exec("DELETE FROM dashboard_auth");
  invalidateDashboardAuthCache();
  _resetLoginLimiter();
});

const REMOTE_HOST = { host: "myvps.example.com" };

test("no-password bypass: /api/* is open when the row is empty", async () => {
  const r = await manage.request("/accounts", { headers: REMOTE_HOST });
  expect(r.status).toBe(200);
});

test("auth/status reports needsPassword=true and authenticated=true on fresh install", async () => {
  const r = await manage.request("/auth/status", { headers: REMOTE_HOST });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.needsPassword).toBe(true);
  expect(body.authenticated).toBe(true); // bypass = effectively authenticated
});

test("login with default 123456 materialises the row and issues a cookie", async () => {
  const r = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.ok).toBe(true);
  expect(body.mustChangePassword).toBe(true);
  expect(r.headers.get("set-cookie")).toContain("gacor_session=");

  const rows = sqlite.query("SELECT COUNT(*) n FROM dashboard_auth").get() as { n: number };
  expect(rows.n).toBe(1);
});

test("after password is set, /api/accounts without a cookie returns 401", async () => {
  await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  const r = await manage.request("/accounts", { headers: REMOTE_HOST });
  expect(r.status).toBe(401);
});

test("valid cookie unlocks /api/accounts", async () => {
  const login = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const r = await manage.request("/accounts", { headers: { ...REMOTE_HOST, cookie } });
  expect(r.status).toBe(200);
});

test("wrong password returns 401 and increments the limiter", async () => {
  const r = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "nope" }),
  });
  expect(r.status).toBe(401);
  const body = await r.json();
  expect(body.error.message).toContain("attempt");
});

test("6 failed logins triggers a 429 lockout", async () => {
  for (let i = 0; i < 5; i++) {
    await manage.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...REMOTE_HOST },
      body: JSON.stringify({ password: "wrong" }),
    });
  }
  const r = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "wrong" }),
  });
  expect(r.status).toBe(429);
  expect((await r.json()).error.message).toContain("too many");
});

test("change-password rotates the JWT secret so the old cookie stops working", async () => {
  // First login with default.
  const login1 = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  const cookie1 = login1.headers.get("set-cookie")!.split(";")[0]!;

  // Change password using that session's cookie.
  const change = await manage.request("/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST, cookie: cookie1 },
    body: JSON.stringify({ currentPassword: "123456", newPassword: "mynewpass" }),
  });
  expect(change.status).toBe(200);

  // Old cookie should now be rejected.
  const stale = await manage.request("/accounts", { headers: { ...REMOTE_HOST, cookie: cookie1 } });
  expect(stale.status).toBe(401);

  // New password should log in successfully.
  const login2 = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "mynewpass" }),
  });
  expect(login2.status).toBe(200);
  expect((await login2.json()).mustChangePassword).toBe(false);
});

test("change-password rejects the wrong current password", async () => {
  await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  const login = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const r = await manage.request("/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST, cookie },
    body: JSON.stringify({ currentPassword: "wrong", newPassword: "irrelevant123" }),
  });
  expect(r.status).toBe(403);
});

test("change-password rejects a new password shorter than 6 chars", async () => {
  await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  const login = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const r = await manage.request("/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST, cookie },
    body: JSON.stringify({ currentPassword: "123456", newPassword: "short" }),
  });
  expect(r.status).toBe(400);
});

test("logout clears the cookie", async () => {
  const login = await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const r = await manage.request("/auth/logout", { method: "POST", headers: { ...REMOTE_HOST, cookie } });
  expect(r.status).toBe(200);
  // Set-Cookie header from logout should set Max-Age=0 (deleteCookie behavior).
  const set = r.headers.get("set-cookie") ?? "";
  expect(set.toLowerCase()).toContain("gacor_session=");
});

test("loopback bypass still works after a password is set", async () => {
  // Materialise a password.
  await manage.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...REMOTE_HOST },
    body: JSON.stringify({ password: "123456" }),
  });

  // Flip HOST env to loopback so isLoopbackRequest returns true, then hit
  // /accounts with a loopback Host header — no cookie required.
  process.env.HOST = "127.0.0.1";
  try {
    const r = await manage.request("/accounts", { headers: { host: "127.0.0.1:7788" } });
    expect(r.status).toBe(200);
  } finally {
    process.env.HOST = "0.0.0.0";
  }
});
