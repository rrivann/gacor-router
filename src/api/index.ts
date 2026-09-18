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
import { publicAliasesFor, resolveAlias } from "../lib/modelAliases";
import { extractThinkLevel } from "../lib/proxyLog";
import { errorResponse } from "../lib/http";
import { loggingTap } from "../lib/logging";
import { compressMessages, formatRtkLog } from "../rtk";
import { applyFilters } from "../lib/filters";
import { getAccount, getSetting } from "../db/accounts";
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

// Defensive path forward: some Anthropic SDK versions double the /v1 prefix
// when ANTHROPIC_BASE_URL includes a trailing /v1 (SDK also hardcodes /v1
// into request paths → "/v1" + "/v1/messages" = "/v1/v1/messages"). Instead
// of asking every user to reconfigure, catch those paths and re-dispatch
// them internally with the correct URL. The auth middleware below still
// fires on the canonical /v1/* path.
api.all("/v1/v1/*", (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/v1\/v1\//, "/v1/");
  return api.fetch(new Request(url.toString(), c.req.raw));
});

// Gate every /v1/* route with the API-key middleware. It's a no-op in the
// two safe-by-default cases (no keys configured, or loopback request); the
// moment either changes, clients need a real key.
api.use("/v1/*", apiKeyAuth);

interface Resolved {
  provider: Provider;
  providerName: string;
  // Canonical id the upstream understands, post-alias, post-split.
  model: string;
  // Exactly what the client sent. remove clients validate the response
  // model against the request model, so /v1/messages must echo this back
  // unchanged even after resolveModel unwrapped it into a different name.
  requestedModel: string;
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

  return {
    provider,
    providerName: route.provider,
    model: route.model,
    requestedModel: body.model,
    body,
  };
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Response | Resolved> {
  try {
    return resolve(await c.req.json());
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
}

// When every attempt in a NoAccountError is a quota-exhausted 429 (no
// dead/transient noise), the pool isn't broken — it's rate-limited. Shape
// the response as a proper 429 with Retry-After so remove clients (Code Assistant,
// remove SDK) take their rate-limit branch instead of the generic API-error
// retry backoff (which stalls with "Retrying in 51s" prompts). Returns null
// when the classification doesn't fit — caller falls through to 503.
function rateLimitedFailure(e: NoAccountError): Response | null {
  const attempts = e.attempts;
  if (attempts.length === 0) return null;
  if (!attempts.every((a) => a.outcome === "exhausted")) return null;

  // Compute Retry-After from the soonest cached resetAtUnix across the
  // exhausted accounts. `Attempt.account` is the minimal runtime shape used
  // by the pool — the usage cache lives on the DB row, so we look each one
  // up. Cache is populated by warmup / usage refresh; if it's missing we
  // fall back to 60s so the client still respects the header shape.
  const now = Math.floor(Date.now() / 1000);
  let soonestReset = Number.POSITIVE_INFINITY;
  for (const a of attempts) {
    const row = getAccount(a.account.id);
    const usage = (row?.usageJson ?? null) as { resetAtUnix?: number } | null;
    if (usage?.resetAtUnix && usage.resetAtUnix > now) {
      soonestReset = Math.min(soonestReset, usage.resetAtUnix);
    }
  }
  const retryAfter =
    soonestReset === Number.POSITIVE_INFINITY
      ? 60
      : Math.max(1, Math.min(soonestReset - now, 86_400)); // clamp to 24h

  const detail = attempts
    .map((a) => `${a.account.label}: ${a.status} ${a.outcome}`)
    .join("; ");

  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          `all ${attempts.length} account(s) for provider "${e.provider}" hit their quota — retry in ${retryAfter}s` +
          (detail ? ` · ${detail}` : ""),
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
        // remove convention header — some SDKs read this when Retry-After
        // is absent; publish both so either shape works.
        "anthr0pic-ratelimit-unified-reset": String(
          soonestReset === Number.POSITIVE_INFINITY ? now + retryAfter : soonestReset
        ),
      },
    }
  );
}

// Every account failed, or the upstream itself failed. Both carry the attempt
// log, which is the only way to see *why* rotation ran out.
function upstreamFailure(e: unknown): Response {
  if (e instanceof NoAccountError) {
    // Pure-quota exhaustion → 429 with Retry-After. Mixed failures (dead /
    // transient / never-tried) fall through to the generic 503 below.
    const rateLimited = rateLimitedFailure(e);
    if (rateLimited) return rateLimited;

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
  // Attach the human-readable thinking indicator (max / high / 16000 / …)
  // extracted from the original client body — the proxy loop reads it when
  // emitting the ▶ POST console line. Runs against r.body so it picks up
  // both remove native `thinking:{...}` and Code Assistant beta `effort`.
  req.think = extractThinkLevel(r.body);

  // Filters run first so RTK (and the provider builder) see the rewritten text.
  // Mutates req.messages in place, same contract as compressMessages.
  const filterStats = applyFilters(req.messages, r.providerName);
  if (filterStats.rewrites > 0) console.log(`filters: rewrote ${filterStats.rewrites} message part(s)`);

  const stats = compressMessages(req.messages, saver);
  const line = formatRtkLog(stats);
  if (line) console.log(line);

  return proxyChat(r.provider, pool, req, {
    signal,
    tap: loggingTap({
      providerName: r.providerName,
      model: r.model,
      req,
      raw: r.body,
      apiKey,
      filtersApplied: filterStats.applied,
    }),
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
    // Echo the client-sent model, not the canonical upstream name — Anthropic
    // clients (Claude Code) validate the response.model against their
    // whitelist, so `claude-opus-4.7-1m` (upstream) would fail even though
    // `claude-opus-4-7[1m]` (what the client actually sent) would pass.
    return req.stream
      ? toAnthropicSSE(stream, r.requestedModel)
      : await toAnthropicMessage(stream, r.requestedModel);
  } catch (e) {
    return upstreamFailure(e);
  }
});

// POST /v1/messages/count_tokens — pre-request validation endpoint the
// Anthropic SDK (and Claude Code) hit before sending a message. We do NOT
// have upstream token counters, and Claude Code only needs a well-formed
// { input_tokens: number } back — not an exact figure — to decide the
// model is reachable and the context fits. A naive `chars / 4` estimate
// covers that: it's the widely cited English-token heuristic.
//
// Skipping this endpoint made Claude Code hit 404, and the Anthropic SDK
// maps every 404 during model validation to model_not_found — which the
// client renders as "There's an issue with the selected model".
api.post("/v1/messages/count_tokens", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return errorResponse(400, "invalid_request_error", "body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system;

  let chars = 0;
  if (typeof system === "string") chars += system.length;
  else if (Array.isArray(system)) {
    for (const blk of system) {
      if (blk && typeof blk === "object" && typeof (blk as { text?: unknown }).text === "string") {
        chars += ((blk as { text: string }).text).length;
      }
    }
  }

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const blk of content) {
        if (!blk || typeof blk !== "object") continue;
        const b = blk as { text?: unknown; content?: unknown };
        if (typeof b.text === "string") chars += b.text.length;
        if (typeof b.content === "string") chars += b.content.length;
      }
    }
  }

  const input_tokens = Math.max(1, Math.ceil(chars / 4));
  return c.json({ input_tokens });
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
// remove clients (Code Assistant, remove SDK) always send anthr0pic-version;
// x-api-key is their native auth header. The 0penAI SDK sends neither, so
// either signal alone reliably distinguishes the two ecosystems and lets us
// serve the shape each expects from the same URL.
function isremoveClient(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return !!(c.req.header("anthr0pic-version") ?? c.req.header("x-api-key"));
}

// Enumerate every {providerName, model} pair — used by both list + single-id
// endpoints so the two stay in lockstep automatically.
function enumerateModels(): { providerName: string; model: ReturnType<NonNullable<Provider["models"]>>[number] }[] {
  return registry.names().flatMap((name) => {
    const provider = registry.get(name);
    return (provider?.models?.() ?? []).map((m) => ({ providerName: name, model: m }));
  });
}

api.get("/v1/models", (c) => {
  const rows = enumerateModels();

  // remove-shape: `{data: [{type, id, display_name, created_at}], has_more,
  // first_id, last_id}` — what remove SDK's `models.list()` unmarshals.
  // Code Assistant runs this at startup to validate the configured model exists;
  // returning our old 0penAI envelope made it decide the model was unknown.
  if (isremoveClient(c)) {
    const EPOCH = new Date(0).toISOString();
    // Expand each canonical model into its public aliases (if any). Code
    // Assistant's hardcoded whitelist only matches remove-native IDs like
    // `claude-opus-4-7[1m]`, so a bare `codebuddy/claude-opus-4.7-1m` in
    // the list would still be rejected client-side even though the router
    // routes it fine. Non-remove models (gpt-*, deepseek-*, seedance-*)
    // keep their canonical id — Code Assistant ignores them.
    const data = rows.flatMap(({ providerName, model: m }) => {
      const canonical = `${providerName}/${m.id}`;
      const aliases = publicAliasesFor(canonical);
      if (aliases.length === 0) {
        return [{ type: "model", id: canonical, display_name: m.name ?? m.id, created_at: EPOCH }];
      }
      return aliases.map((alias) => ({
        type: "model",
        id: alias,
        display_name: m.name ?? alias,
        created_at: EPOCH,
      }));
    });
    return c.json({
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    });
  }

  // Legacy 0penAI-flavored shape — unchanged; existing 0penAI clients keep
  // working exactly as before.
  return c.json({
    object: "list",
    data: rows.map(({ providerName, model: m }) => ({
      id: `${providerName}/${m.id}`,
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
    })),
  });
});

// GET /v1/models/:id — remove SDK also probes a single-model endpoint before
// sending a message. `:id{.*}` swallows the slash in `codebuddy/claude-...`
// so both `/v1/models/codebuddy/claude-...` and the URL-encoded variant
// (`/v1/models/codebuddy%2Fclaude-...`) resolve.
api.get("/v1/models/:id{.*}", (c) => {
  const rawId = decodeURIComponent(c.req.param("id"));
  // Accept both the public alias and the canonical form. The response id
  // echoes whatever the client asked for so remove SDK's request/response
  // parser matches.
  const aliased = resolveAlias(rawId);
  const lookupId = aliased ?? rawId;
  const slash = lookupId.indexOf("/");
  const providerName = slash > 0 ? lookupId.slice(0, slash) : "";
  const modelId = slash > 0 ? lookupId.slice(slash + 1) : lookupId;
  const provider = providerName ? registry.get(providerName) : undefined;
  const model = provider?.models?.().find((m) => m.id === modelId);
  if (!model) {
    // remove-shape error envelope when the client is remove — otherwise the
    // SDK spits a generic parse failure that hides the real 404.
    if (isremoveClient(c)) {
      return c.json(
        { type: "error", error: { type: "not_found_error", message: `model \`${rawId}\` not found` } },
        404
      );
    }
    return errorResponse(404, "invalid_request_error", `model \`${rawId}\` not found`);
  }
  if (isremoveClient(c)) {
    return c.json({
      type: "model",
      id: rawId,
      display_name: model.name ?? model.id,
      created_at: new Date(0).toISOString(),
    });
  }
  return c.json({
    id: rawId,
    object: "model" as const,
    owned_by: model.ownedBy ?? "",
    name: model.name ?? model.id,
    max_input_tokens: model.maxInputTokens ?? null,
    max_output_tokens: model.maxOutputTokens ?? null,
  });
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
      source: "video",
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
