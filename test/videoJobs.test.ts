// Video job tests. Same DB_PATH-before-import discipline as apiKeys.test.ts —
// touching src/db in any way before setting DB_PATH would bind the singleton
// to whichever file loaded first (default ./gacor.db == the dev's real DB).
// See reference_test_db_binding for the full story.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const dbPath = join(tmpdir(), `gacor-videos-test-${Bun.randomUUIDv7()}.db`);
process.env.DB_PATH = dbPath;

// Only the tables the code touches — mirrors the shape drizzle generates.
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
  INSERT INTO accounts (provider,label,secret,status,created_at)
    VALUES ('codebuddy','vid-acc','token-1','active',0);
`);

// AFTER DB_PATH — same rule as apiKeys.test.ts.
const { api } = await import("../src/api");
const { manage } = await import("../src/api/manage");
const { sqlite } = await import("../src/db/index");
const { registry } = await import("../src/providers");
const { addApiKeyUsage } = await import("../src/db/apiKeys");
const { getVideoJob, updateVideoJob, markCompleted } = await import("../src/db/videoJobs");
const { _tickVideoPoller: tickPoller, VIDEOS_DIR } = await import("../src/lib/videoPoller");

const realFetch = globalThis.fetch;
type StubFn = (input: Request) => Promise<Response> | Response;
let submitStub: StubFn = () => new Response("unstubbed submit", { status: 500 });
let pollStub: StubFn = () => new Response("unstubbed poll", { status: 500 });
let downloadStub: StubFn = () => new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 });

const createdJobIds: number[] = [];
const createdKeyIds: number[] = [];
const createdFiles: string[] = [];

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/v2/videos/generations")) return submitStub(input as Request);
    if (url.includes("/v2/videos/tasks")) return pollStub(input as Request);
    if (url.includes("aigc-output-video")) return downloadStub(input as Request);
    // Any other upstream (e.g. token refresh) — pretend the credential is fresh
    // so the provider skips the refresh round-trip.
    if (url.includes("/v2/plugin/auth/token/refresh")) {
      return new Response(JSON.stringify({ code: 0, data: { accessToken: "token-1", refreshToken: "token-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  // Force non-loopback so the API key middleware actually gates (matches the
  // apiKeys test's pattern).
  process.env.HOST = "0.0.0.0";
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.HOST;
  for (const id of createdJobIds) sqlite.exec(`DELETE FROM video_jobs WHERE id = ${id}`);
  for (const id of createdKeyIds) sqlite.exec(`DELETE FROM api_keys WHERE id = ${id}`);
  for (const p of createdFiles) {
    if (existsSync(p)) {
      try { unlinkSync(p); } catch {}
    }
  }
});

// Router uses this content-type default so no need to re-specify.
function submit(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return api.request("/v1/videos/generations", {
    method: "POST",
    headers: { "content-type": "application/json", host: "example.com", ...headers },
    body: JSON.stringify(body),
  });
}

// A canonical submit body — 4s (min), matches the upstream constraint.
const VIDEO_BODY = {
  model: "codebuddy/seedance-2.5",
  prompt: "test video prompt",
  seconds: 4,
};

// A canned upstream submit response — mirrors what CodeBuddy actually returned
// on 2026-09-16. taskId is randomized so each test's row is unique.
function fakeSubmit(taskId: string): Response {
  return new Response(
    JSON.stringify({ code: 0, msg: "OK", data: { id: taskId, status: "queued", created_at: 0 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function fakePollInProgress(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "OK", data: { status: "in_progress" } }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

function fakePollCompleted(url: string, credit = 42, tokens = 40000): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      msg: "OK",
      data: {
        status: "completed",
        data: [{ url, resolution: "1280x720" }],
        usage: { credit, output_tokens: tokens },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function fakePollFailed(errCode = 14410, errMsg = "video task not found"): Response {
  return new Response(JSON.stringify({ code: errCode, msg: errMsg }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

test("submit returns 400 when model is missing", async () => {
  const r = await submit({ prompt: "hi", seconds: 4 });
  expect(r.status).toBe(400);
});

test("submit returns 400 when prompt is missing", async () => {
  const r = await submit({ model: "codebuddy/seedance-2.5", seconds: 4 });
  expect(r.status).toBe(400);
});

test("submit returns 400 for seconds outside [4, 30]", async () => {
  const r1 = await submit({ ...VIDEO_BODY, seconds: 1 });
  expect(r1.status).toBe(400);
  const r2 = await submit({ ...VIDEO_BODY, seconds: 60 });
  expect(r2.status).toBe(400);
});

test("submit returns 501 for an unknown provider", async () => {
  // resolveModel accepts any "provider/model" as syntactically valid; the
  // provider lookup is what surfaces the 501.
  const r = await submit({ ...VIDEO_BODY, model: "nonexistent/whatever" });
  expect(r.status).toBe(501);
});

test("submit works end-to-end with a stubbed upstream", async () => {
  const taskId = `v-test-${Date.now()}`;
  submitStub = () => fakeSubmit(taskId);
  const r = await submit(VIDEO_BODY);
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.task_id).toBe(taskId);
  expect(body.status).toBe("queued");
  expect(body.provider).toBe("codebuddy");
  expect(body.model).toBe("seedance-2.5");
  expect(body.params.seconds).toBe(4);
  expect(body.params.resolution).toBe("720P");
  expect(body.params.aspectRatio).toBe("16:9");
  expect(body.file_url).toBeNull();
  createdJobIds.push(body.id);
});

test("GET /v1/videos/:id returns the job row", async () => {
  const jobId = createdJobIds[createdJobIds.length - 1]!;
  const r = await api.request(`/v1/videos/${jobId}`, {
    headers: { host: "example.com" },
  });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.id).toBe(jobId);
  expect(body.status).toBe("queued");
});

test("GET /v1/videos/:id returns 404 for a missing job", async () => {
  const r = await api.request("/v1/videos/999999", { headers: { host: "example.com" } });
  expect(r.status).toBe(404);
});

test("GET /v1/videos/:id/download returns 409 while pending", async () => {
  const jobId = createdJobIds[createdJobIds.length - 1]!;
  const r = await api.request(`/v1/videos/${jobId}/download`, {
    headers: { host: "example.com" },
  });
  expect(r.status).toBe(409);
});

test("poller drives queued → completed and downloads the mp4", async () => {
  // Clear any leftover pending jobs from earlier tests so this test's stub
  // only fires for the row we submit here — pollStub increments a counter
  // shared across the tick, and stray jobs would bump it out of sync.
  sqlite.exec("UPDATE video_jobs SET status = 'completed' WHERE status IN ('queued', 'in_progress')");

  const taskId = `v-poll-${Date.now()}`;
  submitStub = () => fakeSubmit(taskId);
  const submitResp = await submit(VIDEO_BODY);
  const { id: jobId } = await submitResp.json();
  createdJobIds.push(jobId);

  // First tick: poll returns in_progress. Second tick: completed → download.
  const fakeUrl = "https://aigc-output-video-test.example.com/fake.mp4";
  const fakeBytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // MP4 header magic
  let pollCount = 0;
  pollStub = () => {
    pollCount++;
    if (pollCount === 1) return fakePollInProgress();
    return fakePollCompleted(fakeUrl, 40.5, 30_000);
  };
  downloadStub = () => new Response(fakeBytes, { status: 200 });

  // Ensure videos dir exists (usually created at boot, but tests skip that).
  if (!existsSync(VIDEOS_DIR)) mkdirSync(VIDEOS_DIR, { recursive: true });

  await tickPoller(); // in_progress
  let row = getVideoJob(jobId);
  expect(row?.status).toBe("in_progress");

  await tickPoller(); // completed → download
  row = getVideoJob(jobId);
  expect(row?.status).toBe("completed");
  expect(row?.filePath).toContain(`${jobId}.mp4`);
  expect(row?.fileSize).toBe(fakeBytes.length);
  expect(row?.creditUsed).toBe(40.5);
  expect(row?.videoUrl).toBe(fakeUrl);

  createdFiles.push(row!.filePath!);
});

test("GET /v1/videos/:id/download streams the mp4 after completion", async () => {
  // Reuse the row from the previous test — it's the most recent createdJobIds.
  const jobId = createdJobIds[createdJobIds.length - 1]!;
  const r = await api.request(`/v1/videos/${jobId}/download`, {
    headers: { host: "example.com" },
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("video/mp4");
  const buf = new Uint8Array(await r.arrayBuffer());
  expect(buf.length).toBeGreaterThan(0);
});

test("upstream failure marks the job failed", async () => {
  sqlite.exec("UPDATE video_jobs SET status = 'completed' WHERE status IN ('queued', 'in_progress')");

  const taskId = `v-fail-${Date.now()}`;
  submitStub = () => fakeSubmit(taskId);
  const submitResp = await submit(VIDEO_BODY);
  const { id: jobId } = await submitResp.json();
  createdJobIds.push(jobId);

  pollStub = () => fakePollFailed();
  await tickPoller();
  const row = getVideoJob(jobId);
  expect(row?.status).toBe("failed");
  expect(row?.errorMessage).toContain("14410");
});

test("DELETE /api/videos/:id removes the row and file", async () => {
  // Build a row with a real (fake) mp4 on disk.
  if (!existsSync(VIDEOS_DIR)) mkdirSync(VIDEOS_DIR, { recursive: true });
  const taskId = `v-del-${Date.now()}`;
  submitStub = () => fakeSubmit(taskId);
  const submitResp = await submit(VIDEO_BODY);
  const { id: jobId } = await submitResp.json();
  createdJobIds.push(jobId);

  const filePath = join(VIDEOS_DIR, `${jobId}.mp4`);
  writeFileSync(filePath, new Uint8Array([1, 2, 3, 4]));
  createdFiles.push(filePath);
  markCompleted(jobId, {
    filePath,
    fileSize: 4,
    videoUrl: "https://fake.example.com/foo.mp4",
    creditUsed: 10,
    dollarCost: null,
  });
  expect(existsSync(filePath)).toBe(true);

  const del = await manage.request(`/videos/${jobId}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  expect(getVideoJob(jobId)).toBeUndefined();
  expect(existsSync(filePath)).toBe(false);
});

test("scope: apiKey allowedModels blocks unlisted video model", async () => {
  // Create a key scoped only to a chat model — submit for the video model
  // should be refused by enforceKeyScope. Clean up immediately so the key
  // doesn't outlive this test (a leftover key would flip open-gateway off
  // for any other test file that shares the sqlite singleton).
  const { invalidateApiKeyCache } = await import("../src/lib/apiKeyAuth");
  const created = await manage.request("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "vid-scope", allowedModels: ["claude-opus-5"] }),
  });
  const { id: keyId, secret } = await created.json();
  createdKeyIds.push(keyId);
  invalidateApiKeyCache();

  submitStub = () => fakeSubmit("v-scope-ignored");
  const r = await submit(VIDEO_BODY, { authorization: `Bearer ${secret}` });
  expect(r.status).toBe(403);

  // Immediate cleanup so open-gateway reopens for any file that runs next.
  await manage.request(`/keys/${keyId}`, { method: "DELETE" });
  invalidateApiKeyCache();
});
