// Request logging: a proxyChat tap that persists one request_logs row per
// proxied request and fans it out to the WS bus. The tap wraps the provider
// stream in a passthrough generator that accumulates text, reasoning, and
// usage while the consumer drains it; persistence happens when the stream
// ends, errors, or is abandoned (client disconnect → the consumer stops
// pulling and the generator's finally runs).

import type { ChatRequest, StreamEvent } from "../providers/types";
import type { Attempt, NoAccountError, TapResult, UpstreamError } from "../proxy";
import { insertRequestLog } from "../db/logs";
import { emit, EV_REQUEST_LOG } from "./events";

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
      creditUsed?: number | null;
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
        ...outcome,
      });
      emit(EV_REQUEST_LOG, {
        id,
        provider: ctx.providerName,
        model: ctx.model,
        accountId: account?.id ?? null,
        accountLabel: account?.label ?? null,
        status: outcome.status,
        httpStatus: outcome.httpStatus ?? null,
        durationMs: Date.now() - startedAt,
        promptTokens: outcome.promptTokens ?? null,
        completionTokens: outcome.completionTokens ?? null,
        creditUsed: outcome.creditUsed ?? null,
        errorMessage: outcome.errorMessage ?? null,
        attempts: attempts.map(attemptSummary),
      });
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

    return persistOnDone(result.stream, persist);
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
    creditUsed?: number | null;
    errorMessage?: string | null;
    responseBody?: string | null;
  }) => void
): AsyncGenerator<StreamEvent> {
  let text = "";
  let reasoning = "";
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let creditUsed: number | null = null;
  let persisted = false;

  const done = (outcome: Parameters<typeof persist>[0]) => {
    if (persisted) return;
    persisted = true;
    persist(outcome);
  };

  try {
    for await (const ev of stream) {
      if (ev.text) text += ev.text;
      if (ev.reasoning) reasoning += ev.reasoning;
      if (ev.usage) {
        promptTokens = ev.usage.inputTokens;
        completionTokens = ev.usage.outputTokens;
        if (ev.usage.credit) creditUsed = ev.usage.credit;
      }
      yield ev;
    }
    done({
      status: "success",
      promptTokens,
      completionTokens,
      creditUsed,
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
