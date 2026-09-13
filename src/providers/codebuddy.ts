// CodeBuddy — OpenAI on the wire, with its own endpoint, CLI-identifying
// headers, and a gzipped body. The request body is OpenAI-shaped, so only the
// envelope and a few upstream quirks are provider-specific.

import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import type { Account, Caps, ChatRequest, ModelInfo, Outcome, Provider, StreamEvent } from "./types";
import { parseResponse } from "./oaistream";
import { codebuddyModels } from "./codebuddy.models";

const CLIENT_VERSION = "2.108.1";
const USER_AGENT = `CLI/${CLIENT_VERSION} CodeBuddy/${CLIENT_VERSION}`;

// The upstream rejects a request whose first message isn't a system message
// (code 11128). An empty-string system prompt is separately rejected by some
// models (kimi-k3 / kimi-k2.5, code 11133), so the placeholder is real text.
const DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";

// Client fields worth forwarding. Anything else the upstream either ignores or
// chokes on, so the request body is rebuilt rather than passed through.
const PASSTHROUGH_FIELDS = [
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
  "reasoning",
] as const;

// Truncate in the middle, keeping 75% head and the rest as tail, so both the
// opening description and any trailing constraints survive.
function truncateMiddle(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.75);
  const tail = Math.max(0, maxChars - head - label.length - 12);
  return `${text.slice(0, head)}\n\n[${label}]\n\n${text.slice(-tail)}`;
}

// The upstream rejects oversized JSON-schema descriptions, so cap them at every
// depth. `path` holds the current ancestor chain: a node that contains itself is
// replaced with an empty schema, because the body has to survive
// JSON.stringify. Sibling reuse (a DAG) is not a cycle and is kept, just copied.
function sanitizeSchema(schema: unknown, path = new Set<object>()): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (path.has(schema)) return {}; // self-referential — break the loop
  path.add(schema);
  try {
    if (Array.isArray(schema)) return schema.map((s) => sanitizeSchema(s, path));

    const next: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
    if (typeof next.description === "string") {
      next.description = truncateMiddle(next.description, 500, "schema description truncated");
    }
    for (const key of Object.keys(next)) {
      if (key === "description") continue;
      const v = next[key];
      if (v !== null && typeof v === "object") next[key] = sanitizeSchema(v, path);
    }
    return next;
  } finally {
    path.delete(schema);
  }
}

interface OpenAITool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

function normalizeTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (tool === null || typeof tool !== "object") return tool;
    const t = tool as OpenAITool;
    if (!t.function || typeof t.function !== "object") return tool;
    return {
      ...t,
      function: {
        ...t.function,
        description: truncateMiddle(t.function.description ?? "", 1200, "tool description truncated"),
        parameters: sanitizeSchema(t.function.parameters),
      },
    };
  });
}

interface WireMessage {
  role: string;
  content?: unknown;
  [k: string]: unknown;
}

// Flattens canonical messages back to the OpenAI wire shape and guarantees a
// leading system message.
function wireMessages(req: ChatRequest): WireMessage[] {
  const out: WireMessage[] = req.messages.map((m) => {
    const msg: WireMessage = { role: m.role };
    const texts = m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "");
    const images = m.parts.filter((p) => p.type === "image");

    if (images.length > 0) {
      msg.content = [
        ...texts.map((text) => ({ type: "text", text })),
        ...images.map((p) => ({
          type: "image_url",
          image_url: { url: `data:${p.mimeType ?? "image/png"};base64,${p.data ?? ""}` },
        })),
      ];
    } else {
      msg.content = texts.join("");
    }

    if (m.toolCalls?.length) {
      msg.tool_calls = m.toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}) },
      }));
    }
    if (m.toolCallId) msg.tool_call_id = m.toolCallId;
    return msg;
  });

  if (out[0]?.role !== "system") {
    out.unshift({ role: "system", content: DEFAULT_SYSTEM_PROMPT });
  }
  return out;
}

// Per-request CLI identifiers. The upstream correlates these; reusing one
// across requests is what a real client never does.
function buildHeaders(token: string): Headers {
  const conversationId = randomUUID();
  const requestId = randomUUID().replace(/-/g, "");
  return new Headers({
    Accept: "text/event-stream",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Encoding": "gzip",
    "User-Agent": USER_AGENT,
    "X-Requested-With": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": requestId,
    "X-Conversation-Message-ID": requestId,
    "X-Request-ID": requestId,
    "X-Agent-Intent": "craft",
    "X-Ide-Type": "CLI",
    "X-Ide-Name": "CLI",
    "X-Ide-Version": CLIENT_VERSION,
    "X-Product": "SaaS",
    "X-App": "cli",
    "X-Private-Data": "false",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Helper-Method": "stream",
    "X-Stainless-Retry-Count": "0",
    "X-Domain": "www.codebuddy.ai",
    Authorization: `Bearer ${token}`,
  });
}

// Prefer the CLI-plugin access_token; older accounts were stored as api_key,
// and `secret` is the single-token column. All three are used verbatim.
function bearerFor(acc: Account): string {
  return (acc.creds.access_token || acc.creds.api_key || acc.secret || "").trim();
}

// Body-level signals that the credential itself is dead — the account serves no
// model until the user re-authorizes. The status can be anything (Tencent wraps
// some of these in a 200 or 400 envelope), so the body is scanned regardless.
//   11140 / "request illegal"                 — banned server-side
//   14017 / "trial version is not yet activated" — CLI token needs a fresh login
const DEAD_MARKERS = [
  '"code":11140',
  "request illegal",
  '"code":14017',
  "trial version is not yet activated",
];

// A 429 carrying these is scoped to ONE model on this account — the account
// still works elsewhere. Marking it exhausted would retire the whole account
// (for every model) over a single rate-limited one, so it stays transient.
const PER_MODEL_RATE_LIMIT_MARKERS = [
  '"code":6004',
  "usage exceeds frequency limit",
  "switch to the other models",
];

const QUOTA_MARKERS = [
  "insufficient_quota",
  "insufficient quota",
  "insufficient_credits",
  "insufficient credits",
  "insufficient balance",
  "quota_exceeded",
  "quota exceeded",
  "exceeded your current quota",
  "out of credits",
  "credit balance is too low",
  "billing_hard_limit_reached",
  "payment_required",
];

function hasAny(body: string, markers: string[]): boolean {
  return markers.some((m) => body.includes(m));
}

export class CodeBuddyProvider implements Provider {
  name(): string {
    return "codebuddy";
  }

  caps(): Caps {
    return { chat: true, images: true };
  }

  models(): ModelInfo[] {
    return codebuddyModels;
  }

  async buildRequest(req: ChatRequest, acc: Account): Promise<Request> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: wireMessages(req),
      // The upstream only serves SSE; a non-streaming client is satisfied by
      // collapsing the stream on our side.
      stream: true,
    };

    const raw = (typeof req.raw === "object" && req.raw !== null ? req.raw : {}) as Record<string, unknown>;
    for (const field of PASSTHROUGH_FIELDS) {
      if (raw[field] !== undefined) body[field] = raw[field];
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;

    // The backend types tool_choice as a string only — the object form
    // ({type:"function",function:{...}}) 400s, so collapse it.
    if (body.tool_choice !== null && typeof body.tool_choice === "object") {
      body.tool_choice = "required";
    }

    if (Array.isArray(req.tools) && req.tools.length > 0) {
      body.tools = normalizeTools(req.tools);
    }
    if (req.maxTokens !== undefined && Number.isFinite(req.maxTokens) && req.maxTokens > 0) {
      // Below 16 the upstream rejects the request outright.
      body.max_tokens = Math.max(req.maxTokens, 16);
    }

    const token = bearerFor(acc);
    return new Request("https://www.codebuddy.ai/v2/chat/completions", {
      method: "POST",
      headers: buildHeaders(token),
      body: gzipSync(JSON.stringify(body)),
    });
  }

  parseStream(resp: Response, _req: ChatRequest): AsyncGenerator<StreamEvent> {
    // Always SSE upstream, whatever the client asked for.
    return parseResponse(resp, true);
  }

  classify(status: number, body: string): Outcome {
    if (hasAny(body, DEAD_MARKERS)) return "dead";
    if (status < 400) return "ok";
    if (status === 401 || status === 403) return "dead";
    if (status === 429 && hasAny(body, PER_MODEL_RATE_LIMIT_MARKERS)) return "transient";
    if (status === 429 || hasAny(body, QUOTA_MARKERS)) return "exhausted";
    if (status >= 500) return "transient";
    return "ok";
  }
}
