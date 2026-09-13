// The request loop: build → fetch → sniff → classify → react → rotate.
//
// An account-level failure (dead credential, spent quota) retries on the next
// account; a transient one (5xx, per-model rate limit) is returned to the
// caller, since rotating wouldn't help and the account is still good.

import type { Account, ChatRequest, Outcome, Provider, StreamEvent } from "../providers/types";
import { peekError } from "../providers/peek";
import type { Pool } from "../pool/pool";

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

  while (attempts.length < maxAttempts) {
    const account = pool.pick(name, tried);
    if (!account) break;
    tried.add(account.id);

    const upstream = await provider.buildRequest(req, account);
    const resp = await doFetch(upstream, opts.signal ? { signal: opts.signal } : undefined);

    // A 200 can still carry a JSON error envelope instead of a stream, so sniff
    // before handing anything to the parser.
    const peeked = await peekError(resp);

    if (peeked.response) {
      const outcome = provider.classify(resp.status, "");
      if (outcome === "ok") {
        return { stream: provider.parseStream(peeked.response, req), account, attempts };
      }
      // A streamable body on a failing status: read it so the reason is visible.
      const body = await peeked.response.text();
      const reclassified = provider.classify(resp.status, body);
      attempts.push({ account, status: resp.status, outcome: reclassified, body });
      pool.react(account.id, reclassified);
      if (reclassified === "dead" || reclassified === "exhausted") continue;
      throw new UpstreamError(resp.status, body, reclassified, attempts);
    }

    const body = peeked.errorBody ?? "";
    const outcome = provider.classify(resp.status, body);
    attempts.push({ account, status: resp.status, outcome, body });
    pool.react(account.id, outcome);

    // classify() says the account is fine, yet the body wasn't a usable
    // stream — a malformed response, not a rotation-worthy failure.
    if (outcome === "dead" || outcome === "exhausted") continue;
    throw new UpstreamError(resp.status, body, outcome, attempts);
  }

  throw new NoAccountError(name, attempts);
}
