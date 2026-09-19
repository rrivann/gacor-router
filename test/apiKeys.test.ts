// API-key middleware + management endpoint tests. Sets DB_PATH before any
// import so the db singleton opens this file's temp DB — otherwise Bun's
// cross-file module cache would bind us to whichever test file loaded first
// (in the worst case, the developer's real gacor.db).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `gacor-apikeys-test-${Bun.randomUUIDv7()}.db`);
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
    response_body text,
    filters_applied text,
    reasoning_estimated integer
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
  INSERT INTO accounts (provider,label,secret,status,created_at)
    VALUES ('codebuddy','acc-1','token-1','active',0);

  CREATE TABLE combos (
    id integer primary key autoincrement,
    name text not null unique,
    models text not null,
    created_at integer not null,
    updated_at integer not null
  );
`);

const { api } = await import("../src/api");
const { manage } = await import("../src/api/manage");
const { sqlite } = await import("../src/db/index");
const { invalidateApiKeyCache } = await import("../src/lib/apiKeyAuth");


const realFetch = globalThis.fetch;
let stub: (input: Request) => Response = () => new Response("unstubbed", { status: 500 });

// Key ids created by this file's tests — afterAll removes exactly these, so a
// developer's real keys in a shared DB are never collateral damage.
const createdKeyIds: number[] = [];

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("codebuddy.ai")) return stub(input as Request);
    return realFetch(input, init);
  }) as typeof fetch;
  // Fake a non-loopback bind so the middleware's loopback bypass doesn't skip
  // the gate we're trying to test. Restored in afterAll so it doesn't bleed
  // into other test files that expect the default local behavior.
  process.env.HOST = "0.0.0.0";
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.HOST;
  for (const id of createdKeyIds) {
    sqlite.exec(`DELETE FROM api_keys WHERE id = ${id}`);
  }
  invalidateApiKeyCache();
});

const OK_SSE = `data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n`;

function chat(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return api.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", host: "example.com", ...headers },
    body: JSON.stringify(body),
  });
}

const msgs = [{ role: "user", content: "hi" }];
const model = "codebuddy/claude-opus-5";

test("open-gateway: /v1 passes when no keys exist", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model, messages: msgs });
  expect(r.status).toBe(200);
});

let secret1 = "";
let id1 = 0;

test("POST /api/keys creates a key and returns its secret", async () => {
  const r = await manage.request("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "test" }),
  });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.id).toBeGreaterThan(0);
  expect(body.secret).toMatch(/^gcr-[0-9a-f]{48}$/);
  secret1 = body.secret;
  id1 = body.id;
  createdKeyIds.push(id1);
});

test("once a key exists, /v1 without Authorization is 401", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model, messages: msgs });
  expect(r.status).toBe(401);
});

test("/v1 with a valid Bearer token passes", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model, messages: msgs }, { authorization: `Bearer ${secret1}` });
  expect(r.status).toBe(200);
});

test("/v1 with x-api-key header passes", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model, messages: msgs }, { "x-api-key": secret1 });
  expect(r.status).toBe(200);
});

test("/v1 with wrong token is 401", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model, messages: msgs }, { authorization: "Bearer gcr-nope" });
  expect(r.status).toBe(401);
});

test("disabled key is 403", async () => {
  await manage.request(`/keys/${id1}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  stub = () => new Response(OK_SSE, { status: 200 });
  const r = await chat({ model, messages: msgs }, { authorization: `Bearer ${secret1}` });
  expect(r.status).toBe(403);
  // Re-enable for later tests.
  await manage.request(`/keys/${id1}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
});

test("scope: allowedProviders excludes non-listed providers", async () => {
  await manage.request(`/keys/${id1}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowedProviders: ["other"] }),
  });
  const r = await chat({ model, messages: msgs }, { authorization: `Bearer ${secret1}` });
  expect(r.status).toBe(403);
  // Clear scope.
  await manage.request(`/keys/${id1}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowedProviders: null }),
  });
});

test("scope: allowedModels accepts both bare and qualified ids", async () => {
  stub = () => new Response(OK_SSE, { status: 200 });
  await manage.request(`/keys/${id1}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowedModels: ["claude-opus-5"] }),
  });
  let r = await chat({ model, messages: msgs }, { authorization: `Bearer ${secret1}` });
  expect(r.status).toBe(200);
  await manage.request(`/keys/${id1}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowedModels: ["codebuddy/claude-opus-5"] }),
  });
  r = await chat({ model, messages: msgs }, { authorization: `Bearer ${secret1}` });
  expect(r.status).toBe(200);
  await manage.request(`/keys/${id1}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowedModels: null }),
  });
});

test("token quota: request past the cap is 403", async () => {
  const r2 = await manage.request("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "quota", tokenLimit: 1 }),
  });
  const { id: id2, secret: sec2 } = await r2.json();
  createdKeyIds.push(id2);
  sqlite.exec(`UPDATE api_keys SET tokens_used = 5 WHERE id = ${id2}`);
  invalidateApiKeyCache();
  const r = await chat({ model, messages: msgs }, { authorization: `Bearer ${sec2}` });
  expect(r.status).toBe(403);
});

test("DELETE /api/keys/:id removes the key", async () => {
  const create = await manage.request("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "tmp" }),
  });
  const { id: tmpId } = await create.json();
  const del = await manage.request(`/keys/${tmpId}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  const list = await manage.request("/keys");
  const { data } = await list.json();
  expect((data as { id: number }[]).some((k) => k.id === tmpId)).toBe(false);
});
