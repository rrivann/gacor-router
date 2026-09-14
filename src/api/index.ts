// HTTP routes.
// - POST /v1/chat/completions  (OpenAI-compatible, wired end-to-end)
// - POST /v1/messages          (Anthropic-compatible, awaiting its converter)
// - GET  /v1/models
// Later: /api/* management endpoints for the dashboard.

import { Hono } from "hono";
import { registry } from "../providers";
import { pool } from "../pool";
import { proxyChat, NoAccountError, UpstreamError } from "../proxy";
import { toCanonical, toSSE, toCompletion, type OpenAIBody } from "../convert/openai";
import { resolveModel } from "../lib/model";
import { errorResponse } from "../lib/http";
import { loggingTap } from "../lib/logging";
import type { Provider } from "../providers/types";

export const api = new Hono();

interface Resolved {
  provider: Provider;
  providerName: string;
  model: string;
  body: OpenAIBody;
}

// Validate and route. Returns a Response on failure, a Resolved on success.
// Account selection happens inside the proxy, which needs to rotate on failure.
function resolve(raw: unknown): Response | Resolved {
  if (typeof raw !== "object" || raw === null) {
    return errorResponse(400, "invalid_request_error", "body must be a JSON object");
  }
  const body = raw as Partial<OpenAIBody>;

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

  return { provider, providerName: route.provider, model: route.model, body: body as OpenAIBody };
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

api.post("/v1/chat/completions", async (c) => {
  const r = await readBody(c);
  if (r instanceof Response) return r;

  const req = toCanonical(r.body, r.model);
  try {
    const { stream } = await proxyChat(r.provider, pool, req, {
      signal: c.req.raw.signal,
      tap: loggingTap({ providerName: r.providerName, model: r.model, req, raw: r.body }),
    });
    return req.stream ? toSSE(stream, r.model) : await toCompletion(stream, r.model);
  } catch (e) {
    return upstreamFailure(e);
  }
});

api.post("/v1/messages", async (c) => {
  const r = await readBody(c);
  if (r instanceof Response) return r;
  return errorResponse(
    501,
    "not_implemented_error",
    `resolved ${r.providerName}/${r.model}, but the Anthropic request format is not converted yet — use /v1/chat/completions`
  );
});

// Model ids are namespaced `provider/model`, matching what clients must send.
api.get("/v1/models", (c) => {
  const data = registry.names().flatMap((name) => {
    const provider = registry.get(name);
    return (provider?.models?.() ?? []).map((m) => ({
      id: `${name}/${m.id}`,
      object: "model" as const,
      created: 0,
      owned_by: m.ownedBy ?? name,
    }));
  });
  return c.json({ object: "list", data });
});
