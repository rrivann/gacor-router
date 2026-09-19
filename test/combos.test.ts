// Combo CRUD + REST endpoint tests. Isolated DB via DB_PATH-before-import.

import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `gacor-combos-test-${Bun.randomUUIDv7()}.db`);
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
  CREATE TABLE combos (
    id integer primary key autoincrement,
    name text not null unique,
    models text not null,
    created_at integer not null,
    updated_at integer not null
  );
`);

const {
  createCombo,
  deleteCombo,
  getComboById,
  getComboByName,
  listCombos,
  updateCombo,
} = await import("../src/db/combos");
const { manage } = await import("../src/api/manage");
const { sqlite } = await import("../src/db");

beforeEach(() => {
  sqlite.exec("DELETE FROM combos");
});

test("createCombo persists name + models", () => {
  const row = createCombo("smart", ["codebuddy/claude-opus-5", "codebuddy/glm-5.2"]);
  expect(row.id).toBeGreaterThan(0);
  expect(row.name).toBe("smart");
  expect(row.models).toEqual(["codebuddy/claude-opus-5", "codebuddy/glm-5.2"]);
});

test("getComboByName round-trips models array", () => {
  createCombo("smart", ["codebuddy/a", "codebuddy/b"]);
  const row = getComboByName("smart");
  expect(row?.models).toEqual(["codebuddy/a", "codebuddy/b"]);
});

test("createCombo throws on duplicate name", () => {
  createCombo("dupe", ["codebuddy/a", "codebuddy/b"]);
  expect(() => createCombo("dupe", ["codebuddy/c", "codebuddy/d"])).toThrow();
});

test("updateCombo preserves models when only name is patched", () => {
  const row = createCombo("orig", ["codebuddy/a", "codebuddy/b"]);
  const updated = updateCombo(row.id, { name: "renamed" });
  expect(updated?.name).toBe("renamed");
  expect(updated?.models).toEqual(["codebuddy/a", "codebuddy/b"]);
});

test("deleteCombo removes row", () => {
  const row = createCombo("gone", ["codebuddy/a", "codebuddy/b"]);
  expect(deleteCombo(row.id)).toBe(true);
  expect(getComboById(row.id)).toBeUndefined();
});

test("listCombos returns newest first", () => {
  createCombo("first", ["codebuddy/a", "codebuddy/b"]);
  createCombo("second", ["codebuddy/c", "codebuddy/d"]);
  const rows = listCombos();
  expect(rows.map((r) => r.name)).toEqual(["second", "first"]);
});

test("POST /api/combos creates with minimum 2 models", async () => {
  const r = await manage.request("/combos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "api-created", models: ["codebuddy/x", "codebuddy/y"] }),
  });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.name).toBe("api-created");
  expect(body.models).toEqual(["codebuddy/x", "codebuddy/y"]);
});

test("POST /api/combos rejects 1-model combo", async () => {
  const r = await manage.request("/combos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "tiny", models: ["codebuddy/x"] }),
  });
  expect(r.status).toBe(400);
  const body = await r.json();
  expect(body.error.message).toContain("at least 2");
});

test("POST /api/combos rejects duplicate name with 409", async () => {
  createCombo("clash", ["codebuddy/a", "codebuddy/b"]);
  const r = await manage.request("/combos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "clash", models: ["codebuddy/c", "codebuddy/d"] }),
  });
  expect(r.status).toBe(409);
});

test("POST /api/combos rejects slash in name (would clash with provider/model)", async () => {
  const r = await manage.request("/combos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bad/name", models: ["codebuddy/a", "codebuddy/b"] }),
  });
  expect(r.status).toBe(400);
});

test("POST /api/combos rejects model without provider/ prefix", async () => {
  const r = await manage.request("/combos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bare", models: ["claude-opus-5", "codebuddy/x"] }),
  });
  expect(r.status).toBe(400);
});
