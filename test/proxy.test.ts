// The rotation loop: which failures move to the next account, which stop, and
// what gets written back to account status.

import { test, expect } from "bun:test";
import { proxyChat, NoAccountError, UpstreamError } from "../src/proxy";
import { Pool, type AccountRow } from "../src/pool/pool";
import { CodeBuddyProvider } from "../src/providers/codebuddy";
import type { ChatRequest, StreamEvent } from "../src/providers/types";

const provider = new CodeBuddyProvider();

const req: ChatRequest = {
  model: "claude-opus-5",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  stream: true,
};

// Builds a pool over in-memory rows and records every status write.
function makePool(rows: AccountRow[]) {
  const writes: { id: number; status: string }[] = [];
  const pool = new Pool(
    (p) => rows.filter((r) => r.provider === p),
    () => "sticky",
    (id, status) => {
      writes.push({ id, status });
      const row = rows.find((r) => r.id === id);
      if (row) row.status = status;
    }
  );
  return { pool, writes, rows };
}

function row(id: number, over: Partial<AccountRow> = {}): AccountRow {
  return { id, provider: "codebuddy", label: `acc-${id}`, secret: `t${id}`, creds: null, status: "active", ...over };
}

const OK_SSE = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n`;

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test("a healthy account streams and nothing is written back", async () => {
  const { pool, writes } = makePool([row(1)]);
  const res = await proxyChat(provider, pool, req, {
    fetch: async () => new Response(OK_SSE, { status: 200 }),
  });
  expect(res.account.id).toBe(1);
  expect(res.attempts).toEqual([]);
  expect(await drain(res.stream)).toEqual([{ text: "hi" }]);
  expect(writes).toEqual([]);
});

test("a dead credential is banned and the next account serves the request", async () => {
  const { pool, writes } = makePool([row(1), row(2)]);
  let call = 0;
  const res = await proxyChat(provider, pool, req, {
    fetch: async () => {
      call++;
      return call === 1
        ? new Response(`{"code":11140,"msg":"request illegal"}`, { status: 200 })
        : new Response(OK_SSE, { status: 200 });
    },
  });
  expect(call).toBe(2);
  expect(res.account.id).toBe(2);
  expect(writes).toEqual([{ id: 1, status: "banned" }]);
  expect(res.attempts).toHaveLength(1);
  expect(res.attempts[0]!.outcome).toBe("dead");
});

test("an exhausted account is marked and rotation continues", async () => {
  const { pool, writes } = makePool([row(1), row(2)]);
  let call = 0;
  const res = await proxyChat(provider, pool, req, {
    fetch: async () => {
      call++;
      return call === 1
        ? new Response(`{"error":"insufficient_quota"}`, { status: 429 })
        : new Response(OK_SSE, { status: 200 });
    },
  });
  expect(res.account.id).toBe(2);
  expect(writes).toEqual([{ id: 1, status: "exhausted" }]);
});

// A per-model rate limit says "this model is busy, try another" — rotating to a
// second account wouldn't help, and retiring this one loses a working account.
test("a per-model rate limit stops immediately without touching account status", async () => {
  const { pool, writes } = makePool([row(1), row(2)]);
  let call = 0;
  const body = `{"code":6004,"msg":"usage exceeds frequency limit, switch to the other models"}`;
  await expect(
    proxyChat(provider, pool, req, {
      fetch: async () => {
        call++;
        return new Response(body, { status: 429 });
      },
    })
  ).rejects.toThrow(UpstreamError);
  expect(call).toBe(1); // no rotation
  expect(writes).toEqual([]); // account stays usable
});

test("a 5xx is transient: it surfaces to the caller, account untouched", async () => {
  const { pool, writes } = makePool([row(1), row(2)]);
  let call = 0;
  const err = await proxyChat(provider, pool, req, {
    fetch: async () => {
      call++;
      return new Response(`{"error":"upstream busy"}`, { status: 503 });
    },
  }).catch((e) => e);
  expect(err).toBeInstanceOf(UpstreamError);
  expect((err as UpstreamError).outcome).toBe("transient");
  expect(call).toBe(1);
  expect(writes).toEqual([]);
});

test("when every account is dead the error names each attempt", async () => {
  const { pool, writes } = makePool([row(1), row(2)]);
  const err = await proxyChat(provider, pool, req, {
    fetch: async () => new Response(`{"code":11140,"msg":"request illegal"}`, { status: 200 }),
  }).catch((e) => e);
  expect(err).toBeInstanceOf(NoAccountError);
  expect((err as NoAccountError).attempts).toHaveLength(2);
  expect(writes).toEqual([
    { id: 1, status: "banned" },
    { id: 2, status: "banned" },
  ]);
});

test("no active account fails without any fetch", async () => {
  const { pool } = makePool([row(1, { status: "banned" })]);
  let called = false;
  const err = await proxyChat(provider, pool, req, {
    fetch: async () => {
      called = true;
      return new Response(OK_SSE);
    },
  }).catch((e) => e);
  expect(err).toBeInstanceOf(NoAccountError);
  expect((err as NoAccountError).attempts).toEqual([]);
  expect(called).toBe(false);
});

test("an account is never retried within one request", async () => {
  const { pool } = makePool([row(1), row(2), row(3)]);
  const seen: string[] = [];
  await proxyChat(provider, pool, req, {
    fetch: async (input) => {
      seen.push((input as Request).headers.get("Authorization")!);
      return new Response(`{"code":11140,"msg":"request illegal"}`, { status: 200 });
    },
  }).catch(() => {});
  expect(seen).toEqual(["Bearer t1", "Bearer t2", "Bearer t3"]);
  expect(new Set(seen).size).toBe(3);
});

test("maxAttempts caps the rotation", async () => {
  const { pool } = makePool([row(1), row(2), row(3), row(4)]);
  let call = 0;
  await proxyChat(provider, pool, req, {
    maxAttempts: 2,
    fetch: async () => {
      call++;
      return new Response(`{"code":11140,"msg":"request illegal"}`, { status: 200 });
    },
  }).catch(() => {});
  expect(call).toBe(2);
});

// A 200 that is neither an error envelope nor a stream: classify says "ok", so
// rotating would be wrong — the response itself is broken.
test("an empty 200 body surfaces as an upstream error, not a rotation", async () => {
  const { pool, writes } = makePool([row(1), row(2)]);
  let call = 0;
  const err = await proxyChat(provider, pool, req, {
    fetch: async () => {
      call++;
      return new Response("", { status: 200 });
    },
  }).catch((e) => e);
  expect(err).toBeInstanceOf(UpstreamError);
  expect(call).toBe(1);
  expect(writes).toEqual([]);
});

// The peek only sees the status when a body streams, so a failing status with a
// streamable body has to be re-read before classifying.
test("a failing status with a non-JSON body is still classified from the body", async () => {
  const { pool, writes } = makePool([row(1), row(2)]);
  let call = 0;
  const res = await proxyChat(provider, pool, req, {
    fetch: async () => {
      call++;
      return call === 1
        ? new Response("Forbidden", { status: 403 })
        : new Response(OK_SSE, { status: 200 });
    },
  });
  expect(res.account.id).toBe(2);
  expect(writes).toEqual([{ id: 1, status: "banned" }]);
});
