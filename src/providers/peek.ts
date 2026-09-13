// Some upstreams (CodeBuddy notably) answer HTTP 200 with a JSON *error*
// envelope instead of an SSE stream: {"code":11101,"msg":"..."}. Left alone,
// the SSE parser sees no `data:` lines and silently yields an empty reply, so
// the account never gets classified and the caller gets a blank answer.
//
// peekError sniffs the first non-whitespace byte without consuming a real
// stream: `{` means buffer it all and treat the response as an error, anything
// else (`data:` / `event:`) means hand back an equivalent Response with the
// bytes we peeked pushed back in front.

export interface PeekResult {
  // Set when the response is NOT a usable stream — the raw body to classify.
  errorBody?: string;
  // Set when the response IS a stream — use this in place of the original.
  response?: Response;
}

// A 200 with a JSON body is only an error if it looks like an error envelope:
// an `error` field, or a non-zero numeric `code`. A non-streaming completion is
// also JSON, and must pass through to the JSON parser untouched.
export function isAppError(body: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as { error?: unknown; code?: unknown };
  if (o.error !== undefined && o.error !== null) return true;
  return typeof o.code === "number" && o.code !== 0;
}

function rebuild(resp: Response, head: Uint8Array[], rest: ReadableStream<Uint8Array> | null): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of head) controller.enqueue(c);
      if (!rest) {
        controller.close();
        return;
      }
      const reader = rest.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        reader.releaseLock();
      }
    },
  });
  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]); // space, tab, LF, CR

export async function peekError(resp: Response): Promise<PeekResult> {
  if (!resp.body) {
    // No body at all on a 2xx is itself malformed; on an error status the
    // caller already has the status to classify.
    return { errorBody: "" };
  }

  const reader = resp.body.getReader();
  const head: Uint8Array[] = [];
  let firstByte: number | undefined;

  // Pull chunks until we see a non-whitespace byte (or the body ends).
  while (firstByte === undefined) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length === 0) continue;
    head.push(value);
    for (const b of value) {
      if (!WS.has(b)) {
        firstByte = b;
        break;
      }
    }
  }

  // Empty (or whitespace-only) body — malformed regardless of status.
  if (firstByte === undefined) {
    reader.releaseLock();
    return { errorBody: "" };
  }

  if (firstByte !== 0x7b /* { */) {
    // Looks like SSE. Push the peeked bytes back and let the parser run.
    reader.releaseLock();
    return { response: rebuild(resp, head, resp.body) };
  }

  // JSON body: read it all and decide.
  const decoder = new TextDecoder();
  let text = head.map((c) => decoder.decode(c, { stream: true })).join("");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    text += decoder.decode();
    reader.releaseLock();
  }

  const trimmed = text.trim();
  if (isAppError(trimmed)) return { errorBody: trimmed };

  // Valid JSON that isn't an error (a non-streaming completion) — hand it back
  // whole for the JSON parser. The stream is spent, so rebuild from the text.
  return { response: new Response(text, { status: resp.status, statusText: resp.statusText, headers: resp.headers }) };
}
