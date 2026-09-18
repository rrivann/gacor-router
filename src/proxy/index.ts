// The request loop: build → fetch → sniff → classify → react → rotate.
//
// An account-level failure (dead credential, spent quota) retries on the next
// account; a transient one (5xx, per-model rate limit) is returned to the
// caller, since rotating wouldn't help and the account is still good.

import type {
  Account,
  ChatRequest,
  ImageRequest,
  ImageResponse,
  Outcome,
  Provider,
  StreamEvent,
  VideoRequest,
  VideoSubmitResult,
} from "../providers/types";
import { peekError } from "../providers/peek";
import type { Pool } from "../pool/pool";
import { logAutoDisable, logFallback, logRequestError, logRequestStart } from "../lib/proxyLog";

export interface Attempt {
  account: Account;
  status: number;
  outcome: Outcome;
  body: string;
}

export interface ProxyResult {
  stream: AsyncGenerator<StreamEvent>;
  account: Account;
  attempts: Attempt[];
}

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly outcome: Outcome,
    readonly attempts: Attempt[]
  ) {
    super(`upstream ${status}: ${body.slice(0, 300)}`);
    this.name = "UpstreamError";
  }
}

export class NoAccountError extends Error {
  constructor(
    readonly provider: string,
    readonly attempts: Attempt[]
  ) {
    super(
      attempts.length === 0
        ? `no active account for provider "${provider}"`
        : `all ${attempts.length} account(s) for provider "${provider}" failed`
    );
    this.name = "NoAccountError";
  }
}

export interface ProxyOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  maxAttempts?: number;
  // Observability tap — invoked exactly once per proxied request with the
  // final stream (or null when the request never produced one) plus the
  // attempt log. The tap owns draining the generator; used for request
  // logging and live events.
  tap?: (result: TapResult) => AsyncGenerator<StreamEvent>;
}

export interface TapResult {
  stream: AsyncGenerator<StreamEvent> | null;
  account: Account | null;
  attempts: Attempt[];
  error: UpstreamError | NoAccountError | null;
}

export async function proxyChat(
  provider: Provider,
  pool: Pool,
  req: ChatRequest,
  opts: ProxyOptions = {}
): Promise<ProxyResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const name = provider.name();
  const tried = new Set<number>();
  const attempts: Attempt[] = [];
  const maxAttempts = opts.maxAttempts ?? 5;

  // Route the terminal outcome through the tap without duplicating it at
  // every exit. The tap's returned generator is what the caller sees.
  function finish(
    stream: AsyncGenerator<StreamEvent> | null,
    account: Account | null,
    error: UpstreamError | NoAccountError | null
  ): ProxyResult {
    if (opts.tap) {
      const tapped = opts.tap({ stream, account, attempts, error });
      if (error) throw error;
      return { stream: tapped, account: account!, attempts };
    }
    if (error) throw error;
    return { stream: stream!, account: account!, attempts };
  }

  while (attempts.length < maxAttempts) {
    let account = pool.pick(name, tried);
    if (!account) break;
    tried.add(account.id);

    // Renew expiring credentials before they're used; an unrecoverable one is
    // treated as dead so rotation moves on without burning a fetch.
    if (provider.refresh) {
      const before = account.creds;
      const refreshed = await provider.refresh(account);
      if (!refreshed) {
        attempts.push({ account, status: 0, outcome: "dead", body: "credential refresh failed" });
        pool.react(account.id, "dead");
        logAutoDisable(account.label, "banned");
        logFallback(account.label, 0);
        continue;
      }
      if (refreshed.creds !== before) pool.persistCreds(account.id, refreshed.creds);
      account = refreshed;
    }

    logRequestStart({
      providerName: name,
      model: req.model,
      accountLabel: account.label,
      stream: req.stream === true,
      messages: req.messages.length,
      tools: req.tools?.length ?? 0,
    });
    const startedAt = Date.now();

    const upstream = await provider.buildRequest(req, account);
    const resp = await doFetch(upstream, opts.signal ? { signal: opts.signal } : undefined);

    // A 200 can still carry a JSON error envelope instead of a stream, so sniff
    // before handing anything to the parser.
    const peeked = await peekError(resp);

    if (peeked.response) {
      const outcome = provider.classify(resp.status, "");
      if (outcome === "ok") {
        return finish(provider.parseStream(peeked.response, req), account, null);
      }
      // A streamable body on a failing status: read it so the reason is visible.
      const body = await peeked.response.text();
      const reclassified = provider.classify(resp.status, body);
      attempts.push({ account, status: resp.status, outcome: reclassified, body });
      pool.react(account.id, reclassified);
      logRequestError({
        status: resp.status,
        providerName: name,
        model: req.model,
        durationMs: Date.now() - startedAt,
        body,
      });
      if (reclassified === "dead" || reclassified === "exhausted") {
        logAutoDisable(account.label, reclassified === "dead" ? "banned" : "exhausted");
        logFallback(account.label, resp.status);
        continue;
      }
      return finish(null, null, new UpstreamError(resp.status, body, reclassified, attempts));
    }

    const body = peeked.errorBody ?? "";
    const outcome = provider.classify(resp.status, body);
    attempts.push({ account, status: resp.status, outcome, body });
    pool.react(account.id, outcome);
    logRequestError({
      status: resp.status,
      providerName: name,
      model: req.model,
      durationMs: Date.now() - startedAt,
      body,
    });

    // classify() says the account is fine, yet the body wasn't a usable
    // stream — a malformed response, not a rotation-worthy failure.
    if (outcome === "dead" || outcome === "exhausted") {
      logAutoDisable(account.label, outcome === "dead" ? "banned" : "exhausted");
      logFallback(account.label, resp.status);
      continue;
    }
    return finish(null, null, new UpstreamError(resp.status, body, outcome, attempts));
  }

  return finish(null, null, new NoAccountError(name, attempts));
}

export interface ImageProxyResult {
  image: ImageResponse;
  account: Account;
  attempts: Attempt[];
}

// Image variant of the request loop. Same rotation rules, non-stream: the
// upstream ships one JSON envelope so classify() can read the body directly.
export async function proxyImage(
  provider: Provider,
  pool: Pool,
  req: ImageRequest,
  opts: { signal?: AbortSignal; maxAttempts?: number } = {}
): Promise<ImageProxyResult> {
  if (!provider.image) {
    throw new UpstreamError(501, `provider "${provider.name()}" does not support image generation`, "dead", []);
  }
  const name = provider.name();
  const tried = new Set<number>();
  const attempts: Attempt[] = [];
  const maxAttempts = opts.maxAttempts ?? 5;

  while (attempts.length < maxAttempts) {
    let account = pool.pick(name, tried);
    if (!account) break;
    tried.add(account.id);

    if (provider.refresh) {
      const before = account.creds;
      const refreshed = await provider.refresh(account);
      if (!refreshed) {
        attempts.push({ account, status: 0, outcome: "dead", body: "credential refresh failed" });
        pool.react(account.id, "dead");
        logAutoDisable(account.label, "banned");
        logFallback(account.label, 0);
        continue;
      }
      if (refreshed.creds !== before) pool.persistCreds(account.id, refreshed.creds);
      account = refreshed;
    }

    logRequestStart({
      providerName: name,
      model: req.model,
      accountLabel: account.label,
      stream: false,
      messages: 1,
      tools: 0,
    });
    const startedAt = Date.now();

    const { resp, parse } = await provider.image(req, account);
    // Image endpoint returns one JSON body — no stream sniff needed.
    if (resp.ok) {
      try {
        const image = await parse();
        return { image, account, attempts };
      } catch (err) {
        // parse() only throws on structural failures (non-zero code, malformed
        // JSON). Treat as transient: retry might land on a different upstream
        // instance, but banning would over-react.
        const msg = err instanceof Error ? err.message : String(err);
        attempts.push({ account, status: resp.status, outcome: "transient", body: msg });
        throw new UpstreamError(resp.status, msg, "transient", attempts);
      }
    }

    const body = await resp.text();
    const outcome = provider.classify(resp.status, body);
    attempts.push({ account, status: resp.status, outcome, body });
    pool.react(account.id, outcome);
    logRequestError({
      status: resp.status,
      providerName: name,
      model: req.model,
      durationMs: Date.now() - startedAt,
      body,
    });
    if (outcome === "dead" || outcome === "exhausted") {
      logAutoDisable(account.label, outcome === "dead" ? "banned" : "exhausted");
      logFallback(account.label, resp.status);
      continue;
    }
    throw new UpstreamError(resp.status, body, outcome, attempts);
  }

  throw new NoAccountError(name, attempts);
}

export interface VideoProxyResult {
  submit: VideoSubmitResult;
  account: Account;
  attempts: Attempt[];
}

// Video-submit variant. Same rotation rules as image, but the return value is
// a task id — the render itself finishes later, driven by the background
// poller (src/lib/videoPoller.ts) that owns the /v2/videos/tasks polling and
// mp4 download. Nothing in this loop waits on the render.
export async function proxyVideo(
  provider: Provider,
  pool: Pool,
  req: VideoRequest,
  opts: { signal?: AbortSignal; maxAttempts?: number } = {}
): Promise<VideoProxyResult> {
  if (!provider.video) {
    throw new UpstreamError(501, `provider "${provider.name()}" does not support video generation`, "dead", []);
  }
  const name = provider.name();
  const tried = new Set<number>();
  const attempts: Attempt[] = [];
  const maxAttempts = opts.maxAttempts ?? 5;

  while (attempts.length < maxAttempts) {
    let account = pool.pick(name, tried);
    if (!account) break;
    tried.add(account.id);

    if (provider.refresh) {
      const before = account.creds;
      const refreshed = await provider.refresh(account);
      if (!refreshed) {
        attempts.push({ account, status: 0, outcome: "dead", body: "credential refresh failed" });
        pool.react(account.id, "dead");
        logAutoDisable(account.label, "banned");
        logFallback(account.label, 0);
        continue;
      }
      if (refreshed.creds !== before) pool.persistCreds(account.id, refreshed.creds);
      account = refreshed;
    }

    logRequestStart({
      providerName: name,
      model: req.model,
      accountLabel: account.label,
      stream: false,
      messages: 1,
      tools: 0,
    });
    const startedAt = Date.now();

    const { resp, parse } = await provider.video(req, account);
    if (resp.ok) {
      try {
        const submit = await parse();
        return { submit, account, attempts };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        attempts.push({ account, status: resp.status, outcome: "transient", body: msg });
        throw new UpstreamError(resp.status, msg, "transient", attempts);
      }
    }

    const body = await resp.text();
    const outcome = provider.classify(resp.status, body);
    attempts.push({ account, status: resp.status, outcome, body });
    pool.react(account.id, outcome);
    logRequestError({
      status: resp.status,
      providerName: name,
      model: req.model,
      durationMs: Date.now() - startedAt,
      body,
    });
    if (outcome === "dead" || outcome === "exhausted") {
      logAutoDisable(account.label, outcome === "dead" ? "banned" : "exhausted");
      logFallback(account.label, resp.status);
      continue;
    }
    throw new UpstreamError(resp.status, body, outcome, attempts);
  }

  throw new NoAccountError(name, attempts);
}
