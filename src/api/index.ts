// HTTP routes.
// - POST /v1/chat/completions  (OpenAI-compatible)
// - POST /v1/messages          (Anthropic-compatible)
// - GET  /v1/models
// Management endpoints for the dashboard live in ./manage.

import { Hono } from "hono";
import { registry } from "../providers";
import { pool } from "../pool";
import { proxyChat, proxyImage, NoAccountError, UpstreamError } from "../proxy";
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
import type { ChatRequest, ImageRequest, Provider } from "../providers/types";

export const api = new Hono();

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
function run(r: Resolved, req: ChatRequest, signal: AbortSignal, saver: boolean) {
  // Filters run first so RTK (and the provider builder) see the rewritten text.
  // Mutates req.messages in place, same contract as compressMessages.
  const filterStats = applyFilters(req.messages, r.providerName);
  if (filterStats.rewrites > 0) console.log(`filters: rewrote ${filterStats.rewrites} message part(s)`);

  const stats = compressMessages(req.messages, saver);
  const line = formatRtkLog(stats);
  if (line) console.log(line);

  return proxyChat(r.provider, pool, req, {
    signal,
    tap: loggingTap({ providerName: r.providerName, model: r.model, req, raw: r.body }),
  });
}

api.post("/v1/chat/completions", async (c) => {
  const r = await readBody(c);
  if (r instanceof Response) return r;

  const req = toCanonical(r.body as unknown as OpenAIBody, r.model);
  try {
    const { stream } = await run(r, req, c.req.raw.signal, tokenSaverEnabled(c));
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

  const req = toCanonicalFromAnthropic(r.body as unknown as AnthropicBody, r.model);
  try {
    const { stream } = await run(r, req, c.req.raw.signal, tokenSaverEnabled(c));
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
