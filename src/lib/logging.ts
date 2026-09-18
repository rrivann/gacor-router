// Request logging: a proxyChat tap that persists one request_logs row per
// proxied request and fans it out to the WS bus. The tap wraps the provider
// stream in a passthrough generator that accumulates text, reasoning, and
// usage while the consumer drains it; persistence happens when the stream
// ends, errors, or is abandoned (client disconnect → the consumer stops
// pulling and the generator's finally runs).

import type { ChatRequest, StreamEvent } from "../providers/types";
import type { Attempt, NoAccountError, TapResult, UpstreamError } from "../proxy";
import { getRequestLogRow, insertRequestLog } from "../db/logs";
import { computeDollarCost } from "./pricing";
import { addApiKeyUsage, type ApiKeyRow } from "../db/apiKeys";
import { emit, EV_REQUEST_LOG } from "./events";
import { logRequestDone } from "./proxyLog";

// Emit the full RequestLogRow (same shape as /api/stats/requests returns)
// so WS subscribers can render immediately without a follow-up fetch. Reads
// back from DB once — one indexed lookup — and guarantees emit payload
// never drifts from list-endpoint shape.
export function emitRequestLogRow(id: number, extras?: Record<string, unknown>): void {
  const row = getRequestLogRow(id);
  if (!row) return;
  // Dates serialize as ISO strings in JSON, but be explicit so subscribers
  // that don't JSON.stringify get a consistent shape.
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  emit(EV_REQUEST_LOG, { ...row, createdAt, ...extras });
}

// Bodies are stored for the detail drawer, but a runaway upstream shouldn't
// be able to grow the DB without bound.
const BODY_CAP = 64 * 1024;
const RESPONSE_CAP = 256 * 1024;

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + `…[truncated ${text.length - limit} chars]`;
}

export interface LogContext {
  providerName: string;
  model: string;
  req: ChatRequest;
  raw: unknown;
  // Set when the request was authorized by an API key. On success, its
  // tokens_used counter is incremented by total_tokens.
  apiKey?: ApiKeyRow;
  // Per-rule breakdown of content filters that fired on this request.
  // Persisted in request_logs.filters_applied so /requests detail drawer
  // can show which patterns rewrote text. Empty/undefined when no filters
  // matched — column stays NULL in that case, not [].
  filtersApplied?: { id: number; pattern: string; hits: number }[];
}

export function loggingTap(ctx: LogContext) {
  const startedAt = Date.now();

  return (result: TapResult): AsyncGenerator<StreamEvent> => {
    const { account, attempts, error } = result;

    function persist(outcome: {
      status: "success" | "error";
      httpStatus?: number | null;
      outcome?: string | null;
      promptTokens?: number | null;
      completionTokens?: number | null;
      cachedTokens?: number | null;
      cacheWriteTokens?: number | null;
      reasoningTokens?: number | null;
      ttftMs?: number | null;
      creditUsed?: number | null;
      dollarCost?: number | null;
      errorMessage?: string | null;
      responseBody?: string | null;
    }) {
      const id = insertRequestLog({
        provider: ctx.providerName,
        model: ctx.model,
        accountId: account?.id ?? null,
        accountLabel: account?.label ?? null,
        stream: ctx.req.stream,
        durationMs: Date.now() - startedAt,
        requestBody: cap(safeStringify(ctx.raw), BODY_CAP),
        // Keep the column NULL when no filters fired (vs an empty array) so
        // downstream renders can trivially skip the "Filters applied"
        // section without checking length.
        filtersApplied: ctx.filtersApplied && ctx.filtersApplied.length > 0 ? ctx.filtersApplied : null,
        ...outcome,
      });
      // Charge the API key's token quota only on a successful upstream turn;
      // partial writes / rotations shouldn't drain user credit for failures
      // that the router papered over. total_tokens is
      // (prompt + completion) — cache reads/writes are the upstream's book.
      if (ctx.apiKey && outcome.status === "success") {
        const prompt = outcome.promptTokens ?? 0;
        const completion = outcome.completionTokens ?? 0;
        addApiKeyUsage(ctx.apiKey.id, prompt + completion);
      }
      // Emit the full row shape — RequestLogRow-compatible — so /requests
      // renders live without a placeholder-then-refill flash. `attempts` is
      // a rich internal field that only the detail drawer consumes; carry
      // it as extras so the row stays lean for the list view.
      emitRequestLogRow(id, { attempts: attempts.map(attemptSummary) });
      // 9router-style DONE log for the /console-log page. Only fires on
      // success — errors already logged their own ✗ line inside the proxy
      // loop with the raw status + body.
      if (outcome.status === "success") {
        logRequestDone({
          providerName: ctx.providerName,
          model: ctx.model,
          durationMs: Date.now() - startedAt,
          ttftMs: outcome.ttftMs ?? null,
          promptTokens: outcome.promptTokens ?? null,
          completionTokens: outcome.completionTokens ?? null,
          cachedTokens: outcome.cachedTokens ?? null,
          cacheWriteTokens: outcome.cacheWriteTokens ?? null,
        });
      }
    }

    // The request never produced a stream — every account failed, or the
    // upstream itself errored. attempts already carries the why.
    if (!result.stream) {
      const e = error as UpstreamError | NoAccountError | null;
      persist({
        status: "error",
        httpStatus: e instanceof Error && "status" in e ? (e.status as number) : null,
        outcome: e instanceof Error && "outcome" in e ? (e.outcome as string) : null,
        errorMessage: e ? e.message : "unknown error",
        responseBody: lastBody(attempts),
      });
      return emptyStream();
    }

    return persistOnDone(result.stream, persist, startedAt, ctx.model);
  };
}

// Passthrough wrapper: yields every event unchanged while accumulating text
// and the latest usage, then persists exactly once — on normal completion,
// on a thrown error, or on early abandonment (return()/finally).
async function* persistOnDone(
  stream: AsyncGenerator<StreamEvent>,
  persist: (outcome: {
    status: "success" | "error";
    promptTokens?: number | null;
    completionTokens?: number | null;
    cachedTokens?: number | null;
    cacheWriteTokens?: number | null;
    reasoningTokens?: number | null;
    ttftMs?: number | null;
    creditUsed?: number | null;
    dollarCost?: number | null;
    errorMessage?: string | null;
    responseBody?: string | null;
  }) => void,
  startedAt: number,
  ctxModel: string
): AsyncGenerator<StreamEvent> {
  let text = "";
  let reasoning = "";
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let cachedTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let creditUsed: number | null = null;
  let ttftMs: number | null = null;
  let persisted = false;

  const done = (outcome: Parameters<typeof persist>[0]) => {
    if (persisted) return;
    persisted = true;
    persist(outcome);
  };

  try {
    for await (const ev of stream) {
      if (ev.text) {
        // First non-empty content delta — measures time-to-first-token from
        // the pool.pick that started the request. Reasoning chunks count too
        // (they arrive before final content on thinking models).
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        text += ev.text;
      }
      if (ev.reasoning) {
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        reasoning += ev.reasoning;
      }
      if (ev.usage) {
        promptTokens = ev.usage.inputTokens;
        completionTokens = ev.usage.outputTokens;
        // Aggregate cache in cachedTokens (list view); keep write separate so
        // the drawer can split (cache_read = cachedTokens - cacheWriteTokens).
        const cr = ev.usage.cacheRead ?? 0;
        const cw = ev.usage.cacheWrite ?? 0;
        if (cr || cw) cachedTokens = cr + cw;
        if (cw) cacheWriteTokens = cw;
        if (ev.usage.reasoning) reasoningTokens = ev.usage.reasoning;
        if (ev.usage.credit) creditUsed = ev.usage.credit;
      }
      yield ev;
    }
    const dollarCost = promptTokens != null && completionTokens != null
      ? computeDollarCost(ctxModel, {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheRead: cachedTokens != null && cacheWriteTokens != null ? cachedTokens - cacheWriteTokens : cachedTokens,
          cacheWrite: cacheWriteTokens,
          reasoning: reasoningTokens,
        })
      : null;
    done({
      status: "success",
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
      reasoningTokens,
      ttftMs,
      creditUsed,
      dollarCost,
      responseBody: cap(
        safeStringify({ content: text, reasoning: reasoning || undefined }),
        RESPONSE_CAP
      ),
    });
  } catch (err) {
    done({
      status: "error",
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
      reasoningTokens,
      ttftMs,
      creditUsed,
      errorMessage: err instanceof Error ? err.message : String(err),
      responseBody: cap(safeStringify({ partial: text }), RESPONSE_CAP),
    });
    throw err;
  } finally {
    // Consumer abandoned the stream (client disconnect). Persist what we saw
    // rather than losing the request entirely.
    done({
      status: text ? "success" : "error",
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
      reasoningTokens,
      ttftMs,
      creditUsed,
      errorMessage: text ? null : "stream abandoned before any content",
      responseBody: cap(safeStringify({ partial: text }), RESPONSE_CAP),
    });
  }
}

function attemptSummary(a: Attempt) {
  return {
    account: a.account.label,
    accountId: a.account.id,
    status: a.status,
    outcome: a.outcome,
  };
}

function lastBody(attempts: Attempt[]): string | null {
  const last = attempts[attempts.length - 1];
  return last?.body ? cap(last.body, BODY_CAP) : null;
}

async function* emptyStream(): AsyncGenerator<StreamEvent> {
  // The tap must return a generator even when the request failed; proxyChat
  // rethrows the captured error before the caller can consume it.
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
