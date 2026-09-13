// HTTP routes. Step 1: the request path is wired end-to-end (validate →
// resolve provider → registry lookup → pool pick) but no provider is
// registered yet, so every real call bottoms out at 501.
//
// Landed:
// - POST /v1/chat/completions  (OpenAI-compatible)
// - POST /v1/messages          (Anthropic-compatible)
// - GET  /v1/models
// Later: /api/* management endpoints for the dashboard.

import { Hono } from "hono";
import { registry } from "../providers/registry";
import { pool } from "../pool";
import { resolveModel } from "../lib/model";
import { errorResponse } from "../lib/http";
import type { Account, Provider } from "../providers/types";

export const api = new Hono();

interface ClientBody {
  model: string;
  messages: unknown[];
  stream?: boolean;
}

interface Resolved {
  provider: Provider;
  providerName: string;
  model: string;
  account: Account;
  body: ClientBody;
}

// Everything both formats need before they diverge into translation.
// Returns a Response on failure, a Resolved context on success.
async function resolve(raw: unknown): Promise<Response | Resolved> {
  if (typeof raw !== "object" || raw === null) {
    return errorResponse(400, "invalid_request_error", "body must be a JSON object");
  }
  const body = raw as Partial<ClientBody>;

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

  const account = pool.pick(route.provider);
  if (!account) {
    return errorResponse(
      503,
      "no_available_account_error",
      `no active account for provider "${route.provider}"`
    );
  }

  return {
    provider,
    providerName: route.provider,
    model: route.model,
    account,
    body: body as ClientBody,
  };
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Response | Resolved> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "invalid JSON body");
  }
  return resolve(raw);
}

api.post("/v1/chat/completions", async (c) => {
  const r = await readBody(c);
  if (r instanceof Response) return r;
  return errorResponse(
    501,
    "not_implemented_error",
    `resolved ${r.providerName}/${r.model} on account ${r.account.label}, but the OpenAI request path is not wired to the provider yet`
  );
});

api.post("/v1/messages", async (c) => {
  const r = await readBody(c);
  if (r instanceof Response) return r;
  return errorResponse(
    501,
    "not_implemented_error",
    `resolved ${r.providerName}/${r.model} on account ${r.account.label}, but the Anthropic request path is not wired to the provider yet`
  );
});

// Dummy for now: the Provider interface has no model catalogue, so there is
// nothing truthful to list until providers register one.
api.get("/v1/models", (c) =>
  c.json({
    object: "list",
    data: [] as { id: string; object: "model"; owned_by: string }[],
    providers: registry.names(),
  })
);
