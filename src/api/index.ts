// HTTP routes.
// - POST /v1/chat/completions  (OpenAI-compatible)
// - POST /v1/messages          (Anthropic-compatible)
// - GET  /v1/models
// Management endpoints for the dashboard live in ./manage.

import { Hono } from "hono";
import { registry } from "../providers";
import { pool } from "../pool";
import { existsSync, statSync } from "node:fs";
import { proxyChat, proxyImage, proxyVideo, NoAccountError, UpstreamError } from "../proxy";
import { toCanonical, toSSE, toCompletion, type OpenAIBody } from "../convert/openai";
import {
  toAnthropicMessage,
  toAnthropicSSE,
  toCanonicalFromAnthropic,
  type AnthropicBody,
} from "../convert/anthropic";
import { resolveModel } from "../lib/model";
import { errorResponse } from "../lib/http";
import { loggingTap } from "../lib/logging";
import { compressMessages, formatRtkLog } from "../rtk";
import { applyFilters } from "../lib/filters";
import { getSetting } from "../db/accounts";
import { apiKeyAuth, enforceKeyScope } from "../lib/apiKeyAuth";
import { insertRequestLog } from "../db/logs";
import { createVideoJob, getVideoJob } from "../db/videoJobs";
import { emit, EV_VIDEO_STATUS } from "../lib/events";
import type { ApiKeyRow } from "../db/apiKeys";
import type { ChatRequest, ImageRequest, Provider, VideoRequest } from "../providers/types";

// `apiKey` is set by the middleware when a request presents a valid key; it's
// consumed by the handlers below for scope enforcement and by the logging tap
// to charge the key's token quota.
type ApiVars = { apiKey?: ApiKeyRow };
export const api = new Hono<{ Variables: ApiVars }>();

// Gate every /v1/* route with the API-key middleware. It's a no-op in the
// two safe-by-default cases (no keys configured, or loopback request); the
// moment either changes, clients need a real key.
api.use("/v1/*", apiKeyAuth);

interface Resolved {
  provider: Provider;
  providerName: string;
  model: string;
  body: Record<string, unknown>;
}

// Validate and route. Returns a Response on failure, a Resolved on success.
// Both wire formats agree on `model` and a non-empty `messages` array, which
// is all that has to be checked before a provider is chosen; account selection
// happens inside the proxy, which needs to rotate on failure.
function resolve(raw: unknown): Response | Resolved {
  if (typeof raw !== "object" || raw === null) {
    return errorResponse(400, "invalid_request_error", "body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.model !== "string" || body.model.length === 0) {
    return errorResponse(400, "invalid_request_error", "`model` must be a non-empty string", "model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, "invalid_request_error", "`messages` must be a non-empty array", "messages");
  }

  const route = resolveModel(body.model);
  if (!route) {
    return errorResponse(
      400,
      "invalid_request_error",
      `cannot route model "${body.model}": use "provider/model" or set the default_provider setting`,
      "model"
    );
  }

  const provider = registry.get(route.provider);
  if (!provider) {
    const known = registry.names();
    return errorResponse(
      501,
      "not_implemented_error",
      `provider "${route.provider}" is not implemented yet` +
        (known.length > 0 ? ` (available: ${known.join(", ")})` : " (no providers registered)")
    );
  }

  return { provider, providerName: route.provider, model: route.model, body };
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Response | Resolved> {
  try {
    return resolve(await c.req.json());
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
}

// Every account failed, or the upstream itself failed. Both carry the attempt
// log, which is the only way to see *why* rotation ran out.
function upstreamFailure(e: unknown): Response {
  if (e instanceof NoAccountError) {
    const detail = e.attempts
      .map((a) => `${a.account.label}: ${a.status} ${a.outcome}`)
      .join("; ");
    return errorResponse(
      503,
      "no_available_account_error",
      e.message + (detail ? ` — ${detail}` : "")
    );
  }
  if (e instanceof UpstreamError) {
    return errorResponse(502, "internal_error", e.message, e.outcome);
  }
  return errorResponse(502, "internal_error", e instanceof Error ? e.message : String(e));
}

// RTK is on by default. `X-Token-Saver: off` bypasses it for one request, and
// the `rtk_enabled` setting turns it off globally.
function tokenSaverEnabled(c: { req: { header: (n: string) => string | undefined } }): boolean {
  if (c.req.header("x-token-saver")?.toLowerCase() === "off") return false;
  return getSetting("rtk_enabled") !== "false";
}

// Runs the proxy loop for an already-converted request. The caller decides how
// the resulting stream is rendered, which is the only thing the two wire
// formats disagree on by this point.
function run(
  r: Resolved,
  req: ChatRequest,
  signal: AbortSignal,
  saver: boolean,
  apiKey: ApiKeyRow | undefined
) {
  // Filters run first so RTK (and the provider builder) see the rewritten text.
  // Mutates req.messages in place, same contract as compressMessages.
  const filterStats = applyFilters(req.messages, r.providerName);
  if (filterStats.rewrites > 0) console.log(`filters: rewrote ${filterStats.rewrites} message part(s)`);

  const stats = compressMessages(req.messages, saver);
  const line = formatRtkLog(stats);
  if (line) console.log(line);

  return proxyChat(r.provider, pool, req, {
    signal,
    tap: loggingTap({ providerName: r.providerName, model: r.model, req, raw: r.body, apiKey }),
  });
}

api.post("/v1/chat/completions", async (c) => {
  const r = await readBody(c);
  if (r instanceof Response) return r;

  const key = c.get("apiKey") as ApiKeyRow | undefined;
  const scoped = enforceKeyScope(key, r.providerName, r.model);
  if (scoped) return scoped;

  const req = toCanonical(r.body as unknown as OpenAIBody, r.model);
  try {
    const { stream } = await run(r, req, c.req.raw.signal, tokenSaverEnabled(c), key);
    return req.stream ? toSSE(stream, r.model) : await toCompletion(stream, r.model);
  } catch (e) {
    return upstreamFailure(e);
  }
});

// Anthropic clients get the same pool, proxy, and logging — only the request
// conversion and the response rendering differ.
api.post("/v1/messages", async (c) => {
  const r = await readBody(c);
  if (r instanceof Response) return r;

  const key = c.get("apiKey") as ApiKeyRow | undefined;
  const scoped = enforceKeyScope(key, r.providerName, r.model);
  if (scoped) return scoped;

  const req = toCanonicalFromAnthropic(r.body as unknown as AnthropicBody, r.model);
  try {
    const { stream } = await run(r, req, c.req.raw.signal, tokenSaverEnabled(c), key);
    return req.stream ? toAnthropicSSE(stream, r.model) : await toAnthropicMessage(stream, r.model);
  } catch (e) {
    return upstreamFailure(e);
  }
});

// Image generation, 0penAI-compatible. The body is validated inline (only
// `model` and `prompt` are required); the provider does the real work.
api.post("/v1/images/generations", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (typeof raw !== "object" || raw === null) {
    return errorResponse(400, "invalid_request_error", "body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.model !== "string" || body.model.length === 0) {
    return errorResponse(400, "invalid_request_error", "`model` must be a non-empty string", "model");
  }
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return errorResponse(400, "invalid_request_error", "`prompt` must be a non-empty string", "prompt");
  }
  const route = resolveModel(body.model);
  if (!route) {
    return errorResponse(400, "invalid_request_error", `cannot route model "${body.model}"`, "model");
  }
  const provider = registry.get(route.provider);
  if (!provider) {
    return errorResponse(501, "not_implemented_error", `provider "${route.provider}" is not implemented`);
  }
  if (!provider.image) {
    return errorResponse(
      501,
      "not_implemented_error",
      `provider "${route.provider}" does not support image generation`
    );
  }

  const key = c.get("apiKey") as ApiKeyRow | undefined;
  const scoped = enforceKeyScope(key, route.provider, route.model);
  if (scoped) return scoped;

  const req: ImageRequest = {
    model: route.model,
    prompt: body.prompt,
    n: typeof body.n === "number" ? body.n : undefined,
    size: typeof body.size === "string" ? body.size : undefined,
    quality: typeof body.quality === "string" ? body.quality : undefined,
    responseFormat: body.response_format === "b64_json" ? "b64_json" : body.response_format === "url" ? "url" : undefined,
    raw: body,
  };

  try {
    const { image } = await proxyImage(provider, pool, req, { signal: c.req.raw.signal });
    return c.json(image);
  } catch (e) {
    return upstreamFailure(e);
  }
});

// Model ids are namespaced `provider/model`, matching what clients must send.
// Token limits + feature flags ride along so the dashboard can render the
// full catalogue table without a second source.
api.get("/v1/models", (c) => {
  const data = registry.names().flatMap((name) => {
    const provider = registry.get(name);
    return (provider?.models?.() ?? []).map((m) => ({
      id: `${name}/${m.id}`,
      object: "model" as const,
      created: 0,
      owned_by: m.ownedBy ?? "",
      name: m.name ?? m.id,
      max_input_tokens: m.maxInputTokens ?? null,
      max_output_tokens: m.maxOutputTokens ?? null,
      thinking: m.thinking === true,
      credit_multiplier: m.creditMultiplier ?? null,
      thinking_toggle: m.thinkingToggle ?? null,
      effort: m.effort ?? null,
      images: m.images === true,
      tool_calls: m.toolCalls === true,
      kind: m.kind ?? "chat",
    }));
  });
  return c.json({ object: "list", data });
});

// ── Video generation (async) ─────────────────────────────────────
// POST submits a job (returns instantly), the background poller drives it to
// completion, GET polls status, GET /download streams the mp4 from disk.

const VIDEO_ALLOWED_RESOLUTIONS = new Set(["720P", "1080P"]);
const VIDEO_ALLOWED_ASPECTS = new Set(["16:9", "9:16", "1:1"]);
const VIDEO_MIN_SECONDS = 4;
const VIDEO_MAX_SECONDS = 30;

// POST /v1/videos/generations — submit a job. Returns the job row shape,
// same object the GET /:id endpoint returns (minus the download convenience).
api.post("/v1/videos/generations", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (typeof raw !== "object" || raw === null) {
    return errorResponse(400, "invalid_request_error", "body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.model !== "string" || body.model.length === 0) {
    return errorResponse(400, "invalid_request_error", "`model` must be a non-empty string", "model");
  }
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return errorResponse(400, "invalid_request_error", "`prompt` must be a non-empty string", "prompt");
  }
  // Default to the minimum billable duration when unspecified. Upstream rejects
  // anything outside [4, 30] as "unsupported video duration".
  const seconds = typeof body.seconds === "number" ? Math.floor(body.seconds) : VIDEO_MIN_SECONDS;
  if (seconds < VIDEO_MIN_SECONDS || seconds > VIDEO_MAX_SECONDS) {
    return errorResponse(
      400,
      "invalid_request_error",
      `\`seconds\` must be between ${VIDEO_MIN_SECONDS} and ${VIDEO_MAX_SECONDS} (upstream constraint)`,
      "seconds"
    );
  }

  const resolution = typeof body.resolution === "string" && VIDEO_ALLOWED_RESOLUTIONS.has(body.resolution)
    ? (body.resolution as "720P" | "1080P")
    : "720P";
  const aspectRatio = typeof body.aspect_ratio === "string" && VIDEO_ALLOWED_ASPECTS.has(body.aspect_ratio)
    ? (body.aspect_ratio as "16:9" | "9:16" | "1:1")
    : "16:9";
  const audio = body.audio === true;
  const watermark = body.watermark === false ? false : true;
  const negativePrompt = typeof body.negative_prompt === "string" ? body.negative_prompt : "";

  const route = resolveModel(body.model);
  if (!route) {
    return errorResponse(400, "invalid_request_error", `cannot route model "${body.model}"`, "model");
  }
  const provider = registry.get(route.provider);
  if (!provider) {
    return errorResponse(501, "not_implemented_error", `provider "${route.provider}" is not implemented`);
  }
  if (!provider.video) {
    return errorResponse(
      501,
      "not_implemented_error",
      `provider "${route.provider}" does not support video generation`
    );
  }

  const key = c.get("apiKey") as ApiKeyRow | undefined;
  const scoped = enforceKeyScope(key, route.provider, route.model);
  if (scoped) return scoped;

  const req: VideoRequest = {
    model: route.model,
    prompt: body.prompt,
    seconds,
    resolution,
    aspectRatio,
    audio,
    negativePrompt,
    watermark,
    raw: body,
  };

  const startedAt = Date.now();
  try {
    const { submit, account, attempts } = await proxyVideo(provider, pool, req, { signal: c.req.raw.signal });

    // Persist a request_logs row for the submit half so it shows up in the
    // usual Requests view. The poller writes another when the job completes.
    const requestLogId = insertRequestLog({
      provider: route.provider,
      model: route.model,
      accountId: account.id,
      accountLabel: account.label,
      stream: false,
      source: "video-submit",
      status: "success",
      httpStatus: 200,
      outcome: "ok",
      durationMs: Date.now() - startedAt,
      requestBody: JSON.stringify(body),
      responseBody: JSON.stringify({ taskId: submit.taskId, status: submit.status }),
    });

    const jobId = createVideoJob({
      provider: route.provider,
      model: route.model,
      accountId: account.id,
      accountLabel: account.label,
      apiKeyId: key?.id ?? null,
      taskId: submit.taskId,
      status: submit.status === "queued" || submit.status === "in_progress" ? submit.status : "queued",
      params: {
        prompt: body.prompt,
        seconds,
        resolution,
        aspectRatio,
        audio,
        negativePrompt,
        watermark,
      },
      requestLogId,
    });

    const row = getVideoJob(jobId)!;
    emit(EV_VIDEO_STATUS, videoRowPayload(row));
    return c.json(videoRowJson(row, c.req.url));
  } catch (e) {
    return upstreamFailure(e);
  }
});

// GET /v1/videos/:id — poll status. Client-side polling companion to the
// server-side background poller: the row is always the source of truth, this
// just serves it.
api.get("/v1/videos/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return errorResponse(400, "invalid_request_error", "invalid job id");
  }
  const row = getVideoJob(id);
  if (!row) return errorResponse(404, "invalid_request_error", `video job #${id} not found`);
  const key = c.get("apiKey") as ApiKeyRow | undefined;
  const scoped = enforceKeyScope(key, row.provider, row.model);
  if (scoped) return scoped;
  return c.json(videoRowJson(row, c.req.url));
});

// GET /v1/videos/:id/download — stream the mp4 from disk. 409 while the job
// hasn't finished, 404 if the file is missing (deleted / never fetched).
api.get("/v1/videos/:id/download", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return errorResponse(400, "invalid_request_error", "invalid job id");
  }
  const row = getVideoJob(id);
  if (!row) return errorResponse(404, "invalid_request_error", `video job #${id} not found`);
  const key = c.get("apiKey") as ApiKeyRow | undefined;
  const scoped = enforceKeyScope(key, row.provider, row.model);
  if (scoped) return scoped;

  if (row.status !== "completed") {
    return errorResponse(409, "invalid_request_error", `video job #${id} is ${row.status}, not completed`);
  }
  if (!row.filePath || !existsSync(row.filePath) || !statSync(row.filePath).isFile()) {
    return errorResponse(404, "invalid_request_error", `video file for job #${id} is missing from disk`);
  }

  return new Response(Bun.file(row.filePath), {
    headers: {
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="video-${row.id}.mp4"`,
      ...(row.fileSize ? { "content-length": String(row.fileSize) } : {}),
    },
  });
});

// JSON serializer for a video job row — accepts a request URL so the
// download URL is same-origin (loopback for dashboard, tunnel host for
// remote clients). The event payload is a subset of this shape.
function videoRowJson(row: NonNullable<ReturnType<typeof getVideoJob>>, requestUrl: string): Record<string, unknown> {
  const origin = (() => {
    try {
      return new URL(requestUrl).origin;
    } catch {
      return "";
    }
  })();
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    task_id: row.taskId,
    status: row.status,
    params: row.params,
    file_url: row.status === "completed" && row.filePath ? `${origin}/v1/videos/${row.id}/download` : null,
    file_size: row.fileSize,
    video_url: row.videoUrl,
    credit_used: row.creditUsed,
    dollar_cost: row.dollarCost,
    error_message: row.errorMessage,
    account_id: row.accountId,
    account_label: row.accountLabel,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    completed_at: row.completedAt,
  };
}

// Compact WS payload — the dashboard already has the row context from the
// initial list load, this just carries the mutable fields.
function videoRowPayload(row: NonNullable<ReturnType<typeof getVideoJob>>): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    taskId: row.taskId,
    provider: row.provider,
    model: row.model,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    filePath: row.filePath,
    fileSize: row.fileSize,
    creditUsed: row.creditUsed,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    params: row.params,
  };
}
