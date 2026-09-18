// CodeBuddy — OpenAI on the wire, with its own endpoint, CLI-identifying
// headers, and a gzipped body. The request body is OpenAI-shaped, so only the
// envelope and a few upstream quirks are provider-specific.

import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import type {
  Account,
  Caps,
  ChatRequest,
  CreditUsage,
  ImageRequest,
  ImageResponse,
  ModelInfo,
  Outcome,
  Provider,
  StreamEvent,
  UsagePackage,
  VideoPollResult,
  VideoRequest,
  VideoSubmitResult,
} from "./types";
import { parseResponse } from "./oaistream";
import { codebuddyModels } from "./codebuddy.models";
import { applyCL4udeOverlayToHeaders } from "../lib/claudeHeaderCache";
import { getSetting } from "../db/accounts";

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

// Guarded overlay call. The pure logic (union of remove-beta, replace of
// everything else) lives in src/lib/claudeHeaderCache; here we only decide
// whether to fire it. Guarded twice — the capture site in the API layer
// only writes the cache when the setting is on, and this second check means
// toggling OFF stops forwarding on the very next request even if a stale
// cache is still populated from an earlier session.
function applyCL4udeOverlay(headers: Headers): void {
  if (getSetting("claude_header_overlay") !== "true") return;
  applyCL4udeOverlayToHeaders(headers);
}

// Per-request CLI identifiers. The upstream correlates these; reusing one
// across requests is what a real client never does.
function buildHeaders(token: string): Headers {
  const conversationId = randomUUID();
  const requestId = randomUUID().replace(/-/g, "");
  const headers = new Headers({
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
  applyCL4udeOverlay(headers);
  return headers;
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
  // Overridable fetch for the refresh call in tests.
  constructor(private fetchImpl?: typeof globalThis.fetch) {}

  name(): string {
    return "codebuddy";
  }

  caps(): Caps {
    return { chat: true, images: true, imageGen: true, videoGen: true };
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
    // 401/403 mean an unauthenticated request. With a refresh_token account
    // the pre-flight refresh keeps credentials current, so reaching this means
    // a transient upstream rejection — rotating won't fix it, and banning
    // would retire a credential that a retry serves fine. True bans surface
    // via DEAD_MARKERS above.
    if (status === 401 || status === 403) return "transient";
    if (status === 429 && hasAny(body, PER_MODEL_RATE_LIMIT_MARKERS)) return "transient";
    if (status === 429 || hasAny(body, QUOTA_MARKERS)) return "exhausted";
    if (status >= 500) return "transient";
    return "ok";
  }

  // Exchange the offline refresh token for a fresh access token when the
  // current one expires within REFRESH_WINDOW. The upstream rotates the
  // refresh token on every exchange, so the new pair must be kept together.
  async refresh(acc: Account): Promise<Account | null> {
    const rt = acc.creds.refresh_token?.trim();
    if (!rt) return acc; // single-token account: nothing to refresh with

    // An RT-only account has no bearer yet; skip the freshness check and
    // exchange straight away. Otherwise a fresh access token skips the trip.
    const bearer = bearerFor(acc);
    if (bearer && !jwtExpiringSoon(bearer)) return acc;

    const doFetch = this.fetchImpl ?? globalThis.fetch;
    let resp: Response;
    try {
      resp = await doFetch("https://www.codebuddy.ai/v2/plugin/auth/token/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": "www.codebuddy.ai",
          "X-Refresh-Token": rt,
          "X-Auth-Refresh-Source": "plugin",
          "X-Product": "SaaS",
        },
        body: "{}",
      });
    } catch {
      return acc; // network blip — try the old token, let the upstream decide
    }
    if (!resp.ok) return null; // refresh token rejected → re-login needed

    let data: { code?: number; data?: { accessToken?: string; refreshToken?: string } };
    try {
      data = (await resp.json()) as typeof data;
    } catch {
      return null;
    }
    const access = data.data?.accessToken?.trim();
    if (data.code !== 0 || !access) return null;

    return {
      ...acc,
      creds: {
        ...acc.creds,
        access_token: access,
        refresh_token: data.data?.refreshToken?.trim() || rt,
      },
    };
  }

  // Generate an image via CodeBuddy's /v2/images/generations (0penAI-shaped
  // request, Tencent-wrapped response). Returns the raw response for the
  // proxy loop to classify + rotate on, plus a parser that unwraps the
  // envelope into 0penAI's standard shape ({ created, data: [...] }).
  async image(req: ImageRequest, acc: Account): Promise<{ resp: Response; parse: () => Promise<ImageResponse> }> {
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
    };
    if (typeof req.n === "number") body.n = req.n;
    if (req.size) body.size = req.size;
    if (req.quality) body.quality = req.quality;
    if (req.responseFormat) body.response_format = req.responseFormat;
    // Passthrough anything else the client sent that the upstream might use.
    const raw = (typeof req.raw === "object" && req.raw !== null ? req.raw : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (!(k in body) && k !== "model" && k !== "prompt") body[k] = v;
    }

    const token = bearerFor(acc);
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const resp = await doFetch("https://www.codebuddy.ai/v2/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-Product": "SaaS",
        "X-Ide-Type": "CLI",
        "X-Ide-Name": "CLI",
        "X-Ide-Version": CLIENT_VERSION,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    // Response body is the SAME single stream — we can only read it once, so
    // the parse() closure buffers the text and reuses it. classify() in the
    // proxy loop will peek first for non-2xx; the ok path calls parse().
    let cached: string | null = null;
    const readText = async () => (cached ??= await resp.clone().text());

    return {
      resp,
      parse: async () => {
        const text = await readText();
        let outer: {
          code?: number;
          msg?: string;
          data?: { created?: number; data?: unknown[] };
        };
        try {
          outer = JSON.parse(text) as typeof outer;
        } catch {
          throw new Error(`image response not JSON: ${text.slice(0, 200)}`);
        }
        if (outer.code !== 0) {
          throw new Error(`image error code=${outer.code} msg=${outer.msg}`);
        }
        const created = outer.data?.created ?? Math.floor(Date.now() / 1000);
        const data = Array.isArray(outer.data?.data) ? outer.data.data : [];
        return {
          created,
          data: data.map((d) => {
            const item = (d ?? {}) as Record<string, unknown>;
            const out: { url?: string; b64_json?: string; revised_prompt?: string } = {};
            if (typeof item.url === "string") out.url = item.url;
            if (typeof item.b64_json === "string") out.b64_json = item.b64_json;
            if (typeof item.revised_prompt === "string") out.revised_prompt = item.revised_prompt;
            return out;
          }),
        };
      },
    };
  }

  // Submit a video generation job via CodeBuddy's /v2/videos/generations.
  // Async upstream: response is `{code:0, data:{id, status:"queued"}}` — the
  // actual render finishes minutes later, and the poller drives progress.
  //
  // Wire shape verified live 2026-09-16 (see scripts/video-smoke.ts) and the
  // mitm capture at re/captures_video/mitm_videogen_20260916.jsonl. The header
  // envelope is a distinct set from chat: video routes want the CLI headers
  // with `X-Agent-Type: main` and no gzip.
  async video(
    req: VideoRequest,
    acc: Account
  ): Promise<{ resp: Response; parse: () => Promise<VideoSubmitResult> }> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model,
      seconds: req.seconds,
      negative_prompt: req.negativePrompt ?? "",
      watermark: req.watermark ?? true,
      extra_parameters: {
        resolution: req.resolution ?? "720P",
        enable_audio: req.audio ?? false,
        aspect_ratio: req.aspectRatio ?? "16:9",
      },
    };

    const token = bearerFor(acc);
    const uid = jwtSub(token);
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const resp = await doFetch("https://www.codebuddy.ai/v2/videos/generations", {
      method: "POST",
      headers: buildVideoHeaders(token, uid),
      body: JSON.stringify(body),
    });

    // Buffer the body so the proxy loop can peek it for the failure path
    // (classify) or delegate to parse() on the ok path — same trick as image().
    let cached: string | null = null;
    const readText = async () => (cached ??= await resp.clone().text());

    return {
      resp,
      parse: async (): Promise<VideoSubmitResult> => {
        const text = await readText();
        let outer: { code?: number; msg?: string; data?: { id?: string; status?: string } };
        try {
          outer = JSON.parse(text) as typeof outer;
        } catch {
          throw new Error(`video submit response not JSON: ${text.slice(0, 200)}`);
        }
        if (outer.code !== 0 || !outer.data?.id) {
          throw new Error(`video submit failed code=${outer.code} msg=${outer.msg}`);
        }
        return { taskId: outer.data.id, status: outer.data.status ?? "queued" };
      },
    };
  }

  // Poll a submitted job via /v2/videos/tasks. Returns a normalized lifecycle
  // status. Only `completed` carries the signed COS URL (valid ~12h).
  async pollVideo(taskId: string, acc: Account): Promise<VideoPollResult> {
    const token = bearerFor(acc);
    const uid = jwtSub(token);
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const resp = await doFetch("https://www.codebuddy.ai/v2/videos/tasks", {
      method: "POST",
      headers: buildVideoHeaders(token, uid),
      body: JSON.stringify({ task_id: taskId }),
    });
    const text = await resp.text();
    let outer: {
      code?: number;
      msg?: string;
      data?: {
        status?: string;
        data?: { url?: string; resolution?: string }[];
        usage?: { credit?: number; output_tokens?: number };
      };
    };
    try {
      outer = JSON.parse(text) as typeof outer;
    } catch {
      return { status: "failed", errorMessage: `poll response not JSON: ${text.slice(0, 200)}` };
    }
    if (outer.code !== 0) {
      return { status: "failed", errorMessage: `poll code=${outer.code} msg=${outer.msg}` };
    }
    const raw = outer.data?.status ?? "queued";
    const status: VideoPollResult["status"] =
      raw === "completed" || raw === "failed" || raw === "in_progress" ? raw : "queued";
    const out: VideoPollResult = { status };
    if (status === "completed") {
      const first = outer.data?.data?.[0];
      if (first?.url) out.url = first.url;
      if (first?.resolution) out.resolution = first.resolution;
      if (typeof outer.data?.usage?.credit === "number") out.credit = outer.data.usage.credit;
      if (typeof outer.data?.usage?.output_tokens === "number") out.outputTokens = outer.data.usage.output_tokens;
    }
    return out;
  }

  // Fetch the account's credit snapshot from Tencent's billing meter. The
  // response ships a bundle of packages: a monthly-refilling plan (cycle
  // capacity) plus lifetime bonus packs (plain capacity). Total = sum of
  // all active packages; per-package detail feeds the UI breakdown.
  async usage(acc: Account): Promise<CreditUsage> {
    const token = bearerFor(acc);
    if (!token) throw new Error("no token");

    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const resp = await doFetch("https://www.codebuddy.ai/v2/billing/meter/get-user-resource", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-Domain": "www.codebuddy.ai",
        "User-Agent": USER_AGENT,
        "X-Product": "SaaS",
        "X-IDE-Type": "CLI",
      },
      body: "{}",
    });

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`credential invalid or expired (${resp.status})`);
    }
    if (resp.status !== 200) throw new Error(`credits HTTP ${resp.status}`);

    const out = (await resp.json()) as BillingResponse;
    if (out.code !== 0) throw new Error(`credits error (code=${out.code} msg=${out.msg})`);

    let limit = 0;
    let used = 0;
    let remaining = 0;
    let plan = "";
    let resetAtUnix = 0; // soonest cycle end across active packages
    const packages: UsagePackage[] = [];

    for (const a of out.data?.Response?.Data?.Accounts ?? []) {
      if (a.Status !== 0) continue;
      if (!plan) plan = a.PackageName || a.SubProductName;

      const pkgReset = parseCycleEnd(a.CycleEndTime);
      if (pkgReset > 0 && (resetAtUnix === 0 || pkgReset < resetAtUnix)) resetAtUnix = pkgReset;

      // A package is "monthly" when it carries a CycleCapacity budget that
      // refills at CycleEndTime; otherwise it's a lifetime pack that just
      // decreases per request.
      const cSize = num(a.CycleCapacitySizePrecise, a.CycleCapacitySize);
      const monthly = cSize > 0;
      const pLimit = monthly ? cSize : num(a.CapacitySizePrecise, a.CapacitySize);
      const pUsed = monthly
        ? num(a.CycleCapacityUsedPrecise, a.CycleCapacityUsed)
        : num(a.CapacityUsedPrecise, a.CapacityUsed);
      const pRemain = monthly
        ? num(a.CycleCapacityRemainPrecise, a.CycleCapacityRemain)
        : num(a.CapacityRemainPrecise, a.CapacityRemain);

      limit += pLimit;
      used += pUsed;
      remaining += pRemain;

      packages.push({
        name: a.PackageName || a.SubProductName,
        subProduct: a.SubProductCode,
        kind: monthly ? "monthly" : "lifetime",
        limit: pLimit,
        used: pUsed,
        remaining: pRemain,
        resetAtUnix: pkgReset || undefined,
      });
    }

    return { limit, used, remaining, plan, resetAtUnix: resetAtUnix || undefined, packages };
  }
}

interface BillingAccount {
  PackageName: string;
  SubProductName: string;
  SubProductCode: string;
  Status: number;
  CapacitySize: number;
  CapacityUsed: number;
  CapacityRemain: number;
  CycleCapacitySize: number;
  CycleCapacityUsed?: number;
  CycleCapacityRemain?: number;
  CapacitySizePrecise: string;
  CapacityUsedPrecise: string;
  CapacityRemainPrecise: string;
  CycleCapacitySizePrecise: string;
  CycleCapacityUsedPrecise?: string;
  CycleCapacityRemainPrecise?: string;
  CycleEndTime: string;
}

interface BillingResponse {
  code: number;
  msg: string;
  data?: {
    Response?: {
      Data?: {
        Accounts?: BillingAccount[];
      };
    };
  };
}

// Tencent sends precise values as strings to dodge float drift; the plain
// numeric fields are the fallback.
function num(precise: string | undefined, fallback: number | undefined): number {
  if (precise) {
    const v = Number(precise);
    if (Number.isFinite(v)) return v;
  }
  return fallback ?? 0;
}

// CycleEndTime arrives as "2026-09-30 23:59:59" in Asia/Shanghai local time.
function parseCycleEnd(s: string | undefined): number {
  if (!s) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, sec] = m;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0));
  return Math.floor((utc - 8 * 3600 * 1000) / 1000); // Asia/Shanghai is UTC+8, no DST
}

// Video routes want a distinct header envelope from chat: no gzip, standard
// JSON accept, an X-Agent-Type/X-User-Id pair matching the CLI's videoGen tool
// (captured 2026-09-16). Reusing buildHeaders() would mislabel the traffic.
function buildVideoHeaders(bearer: string, uid: string): Headers {
  const conversationId = randomUUID();
  const requestId = randomUUID().replace(/-/g, "");
  return new Headers({
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${bearer}`,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": requestId,
    "X-Conversation-Message-ID": requestId,
    "X-Request-ID": requestId,
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    "X-Agent-Purpose": "conversation",
    "X-Root-Request-ID": requestId,
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "",
    "X-IDE-Version": "0.0.0",
    "X-User-Id": uid,
    "X-Domain": "www.codebuddy.ai",
    "X-Product": "SaaS",
    "User-Agent": "CLI/2.151.0 CodeBuddy/2.151.0",
  });
}

// Decode a JWT payload for the `sub` claim (goes into X-User-Id). Never
// verifies — the bearer already served its own auth on the round trip.
function jwtSub(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    ) as { sub?: string };
    return payload.sub ?? "";
  } catch {
    return "";
  }
}

// Refresh this long before the JWT actually expires — the upstream clock and
// ours can disagree, and a request already in flight still needs the token.
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

function jwtExpiringSoon(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false; // opaque token: can't tell, let it ride
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    ) as { exp?: number };
    if (typeof payload.exp !== "number") return false;
    return payload.exp * 1000 - Date.now() < REFRESH_WINDOW_MS;
  } catch {
    return false;
  }
}
