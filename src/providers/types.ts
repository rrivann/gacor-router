// Provider boundary (enowX-inspired, ported to TS).
// Each upstream implements this small interface; the pool and proxy never
// see provider-specific quirks.

export interface Account {
  id: number;
  label: string;
  secret: string;
  creds: Record<string, string>;
}

export type Outcome = "ok" | "transient" | "exhausted" | "dead";

export interface Caps {
  chat: boolean;
  images: boolean;
  imageGen?: boolean;
  videoGen?: boolean;
}

// Image generation request/response. Shape mirrors 0penAI's
// /v1/images/generations so translation stays trivial for compatible clients.
export interface ImageRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  responseFormat?: "url" | "b64_json";
  raw?: unknown;
}

export interface ImageOut {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageResponse {
  created: number;
  data: ImageOut[];
}

// Video generation request. Async upstream: submit returns a task id, then a
// separate poll returns the signed URL once the render finishes (~3-4 min for
// seedance-2.5). Client shape is intentionally close to CodeBuddy's own body.
export interface VideoRequest {
  model: string;
  prompt: string;
  // Upstream constraint (live-verified 2026-09-16): min 4, max 30.
  seconds: number;
  resolution?: "720P" | "1080P";
  aspectRatio?: "16:9" | "9:16" | "1:1";
  audio?: boolean;
  negativePrompt?: string;
  watermark?: boolean;
  raw?: unknown;
}

// What comes back from the submit call. The task id is what the poller uses
// to check progress against /v2/videos/tasks.
export interface VideoSubmitResult {
  taskId: string;
  status: string; // "queued" from CodeBuddy in practice
}

// Normalized poll response. Only `completed` carries `url` and `credit`;
// intermediate statuses just update lifecycle.
export interface VideoPollResult {
  status: "queued" | "in_progress" | "completed" | "failed";
  url?: string;
  resolution?: string;
  credit?: number;
  outputTokens?: number;
  errorMessage?: string;
}

// Canonical internal request — everything is normalized into this shape
// before a provider builds its wire format.
export interface ChatRequest {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  raw?: unknown; // original client payload, for passthrough providers
}

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: { type: "text" | "image"; text?: string; mimeType?: string; data?: string }[];
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
}

// One streamed tool-call fragment. OpenAI-on-the-wire upstreams send tool
// arguments as partial JSON strings spread across chunks (`{"pa`, `th":"/tmp`,
// ...), keyed by `index`; the fragment is passed through as-is so clients can
// render tool arguments while they stream. Reassembly is the consumer's job.
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argsDelta?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  // Reasoning-model split of output: subset of outputTokens spent on the
  // hidden thinking pass. Priced separately by some upstreams.
  reasoning?: number;
  // Upstream-reported credit cost for the request (CodeBuddy sends this in
  // the stream's final usage event). Zero when the provider doesn't meter.
  credit?: number;
}

// Normalized stream event — providers decode their wire format into these.
export interface StreamEvent {
  text?: string;
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  usage?: Usage;
  model?: string;
  finish?: FinishReason;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

// A model the provider can serve. Upstreams like CodeBuddy expose no live
// catalogue, so providers ship a static list.
export interface ModelInfo {
  id: string;
  // Display name from the upstream's official table (e.g. "Fast", "GPT-6-Astra").
  name?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  ownedBy?: string;
  // Reasoning-capable — the model emits a thinking stream (reasoning_content)
  // alongside the answer. Surfaces as the "Thinking" feature badge in the UI.
  thinking?: boolean;

  // ── Official CodeBuddy catalogue metadata ──────────────────────
  // Cost relative to the default model's 1x base rate; 0 means free (🆓).
  creditMultiplier?: number;
  // Whether the thinking stream can be disabled client-side ("canDisable"),
  // or it always runs ("onlyReasoning").
  thinkingToggle?: "canDisable" | "onlyReasoning" | null;
  // Supported effort levels as freeform text ("low→max", "high", ...).
  effort?: string;
  images?: boolean;
  toolCalls?: boolean;
  // What endpoint serves this model. "chat" (default) → /v1/chat/completions
  // and /v1/messages. "image" → /v1/images/generations. "video" →
  // /v1/videos/generations (async: submit + poll + download).
  kind?: "chat" | "image" | "video";
}

// One billing package inside an account — CodeBuddy ships a bundle: a
// monthly-refilling plan plus lifetime bonus packs that just decrease.
export interface UsagePackage {
  name: string;
  subProduct?: string;
  kind?: "monthly" | "lifetime";
  limit: number;
  used: number;
  remaining: number;
  resetAtUnix?: number;
}

// An account's credit/quota snapshot from the upstream billing API.
// limit==0 means "no quota data". (Distinct from `Usage`, the per-request
// token counts carried on stream events.)
export interface CreditUsage {
  limit: number;
  used: number;
  remaining: number;
  plan?: string;
  message?: string;
  resetAtUnix?: number;
  packages?: UsagePackage[];
}

export interface Provider {
  name(): string;
  caps(): Caps;
  buildRequest(req: ChatRequest, acc: Account): Promise<Request>;
  parseStream(resp: Response, req: ChatRequest): AsyncGenerator<StreamEvent>;
  classify(status: number, body: string): Outcome;
  // Optional: static catalogue for GET /v1/models.
  models?(): ModelInfo[];
  // Optional: renew expiring credentials before the request is built.
  // Returns the account to use (possibly unchanged), or null when the
  // credential is unrecoverable — the proxy then treats it as dead.
  refresh?(acc: Account): Promise<Account | null>;
  // Optional: fetch the account's live credit/quota snapshot from the
  // upstream billing API. Errors are surfaced to the caller as-is.
  usage?(acc: Account): Promise<CreditUsage>;
  // Optional: generate an image. Non-stream by design — image endpoints ship
  // one JSON response with a URL or base64 payload.
  image?(req: ImageRequest, acc: Account): Promise<{ resp: Response; parse: () => Promise<ImageResponse> }>;
  // Optional: submit a video generation job. Returns the raw upstream response
  // (so the proxy loop can classify + rotate) plus a parser that unwraps the
  // envelope into a task id. The job then progresses asynchronously and is
  // driven by pollVideo — the caller decides when to check.
  video?(req: VideoRequest, acc: Account): Promise<{ resp: Response; parse: () => Promise<VideoSubmitResult> }>;
  // Optional: poll a submitted video job. Returns the normalized lifecycle
  // status; on `completed` the signed download URL is populated. Same account
  // that submitted must poll — the bearer scopes the task lookup.
  pollVideo?(taskId: string, acc: Account): Promise<VideoPollResult>;
}
