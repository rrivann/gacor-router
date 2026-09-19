// Reasoning-token estimate tests. Exercises loggingTap end-to-end with an
// in-memory stream and inspects the row that lands in the DB. Isolated DB so
// setSetting/insertRequestLog never touch the developer's real gacor.db —
// same DB_PATH-before-import discipline as apiKeys.test.ts.

import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `gacor-reasoning-est-test-${Bun.randomUUIDv7()}.db`);
process.env.DB_PATH = dbPath;

// Full schema, matching apiKeys.test.ts — the src/db singleton binds to
// whichever test file's DB_PATH runs its top-level second, so any table
// unrelated tests read must exist here too.
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

const { loggingTap } = await import("../src/lib/logging");
const { sqlite } = await import("../src/db");
import type { StreamEvent, ChatRequest } from "../src/providers/types";
import type { Attempt } from "../src/proxy";

beforeEach(() => {
  sqlite.exec("DELETE FROM request_logs");
});

const req: ChatRequest = {
  model: "claude-opus-5",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const attempt: Attempt = {
  account: { id: 1, label: "acc-1", secret: "t", creds: {} },
  status: 200,
  outcome: "ok",
};

async function* makeStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const ev of events) yield ev;
}

async function drainThroughTap(events: StreamEvent[]): Promise<void> {
  const tap = loggingTap({
    providerName: "codebuddy",
    model: "claude-opus-5",
    req,
    raw: { model: "claude-opus-5" },
  });
  const wrapped = tap({
    stream: makeStream(events),
    account: attempt.account,
    attempts: [attempt],
    error: null,
  });
  for await (const _ of wrapped) {
    // just drain
  }
}

function lastRow() {
  return sqlite
    .query<
      { reasoning_tokens: number | null; reasoning_estimated: number | null },
      []
    >("SELECT reasoning_tokens, reasoning_estimated FROM request_logs ORDER BY id DESC LIMIT 1")
    .get();
}

test("upstream reports reasoning_tokens → persisted verbatim, estimated flag NULL", async () => {
  await drainThroughTap([
    { text: "hello" },
    { reasoning: "let me think this through" },
    { usage: { inputTokens: 100, outputTokens: 50, reasoning: 30 } },
  ]);
  const row = lastRow();
  expect(row?.reasoning_tokens).toBe(30);
  expect(row?.reasoning_estimated).toBeNull();
});

test("upstream NULL + reasoning content ≥ 20 chars → estimate persisted, flag = 1", async () => {
  const reasoning = "a".repeat(200); // 200 chars → ~50 tokens
  await drainThroughTap([
    { reasoning },
    { text: "response" },
    { usage: { inputTokens: 100, outputTokens: 50 } }, // no reasoning field
  ]);
  const row = lastRow();
  expect(row?.reasoning_tokens).toBe(50);
  expect(row?.reasoning_estimated).toBe(1);
});

test("upstream NULL + no reasoning content → both NULL (non-thinking request stays clean)", async () => {
  await drainThroughTap([
    { text: "just a response, no thinking" },
    { usage: { inputTokens: 100, outputTokens: 50 } },
  ]);
  const row = lastRow();
  expect(row?.reasoning_tokens).toBeNull();
  expect(row?.reasoning_estimated).toBeNull();
});

test("upstream NULL + reasoning < 20 chars → NULL (noise gated out)", async () => {
  await drainThroughTap([
    { reasoning: "hm" }, // 2 chars, below threshold
    { text: "answer" },
    { usage: { inputTokens: 100, outputTokens: 50 } },
  ]);
  const row = lastRow();
  expect(row?.reasoning_tokens).toBeNull();
  expect(row?.reasoning_estimated).toBeNull();
});
