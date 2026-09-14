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
  maxInputTokens?: number;
  maxOutputTokens?: number;
  ownedBy?: string;
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
}
