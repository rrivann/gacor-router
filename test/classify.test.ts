// Classification drives the pool's reaction, so each outcome is pinned to the
// upstream signal that must produce it.

import { test, expect } from "bun:test";
import { CodeBuddyProvider } from "../src/providers/codebuddy";

const p = new CodeBuddyProvider();

test("per-model 429 stays transient so the account keeps serving other models", () => {
  const body = `{"code":6004,"msg":"usage exceeds frequency limit, but don't worry, your usage will reset at 2026-09-12 05:47:38 UTC+8, alternatively, you can switch to the other models to continue using it.","requestId":"x"}`;
  expect(p.classify(429, body)).toBe("transient");
});

test("generic quota 429 exhausts the account so the pool rotates", () => {
  expect(p.classify(429, `{"error":"insufficient_quota"}`)).toBe("exhausted");
});

test("trial-not-activated 14017 is dead — only a fresh login re-arms it", () => {
  const body = `{"error":{"data":{"code":14017,"msg":"The trial version is not yet activated. Please log out of your current account and log in again to activate it immediately and start your free trial.","requestId":"x"}}}`;
  expect(p.classify(400, body)).toBe("dead");
});

test("11140 request-illegal is dead even wrapped in a 200 envelope", () => {
  expect(p.classify(200, `{"code":11140,"msg":"request illegal","requestId":"x"}`)).toBe("dead");
});

test("401/403 are transient — pre-flight refresh keeps creds current, so a rejection is upstream noise", () => {
  expect(p.classify(401, "")).toBe("transient");
  expect(p.classify(403, "")).toBe("transient");
});

test("5xx is transient", () => {
  expect(p.classify(500, "")).toBe("transient");
  expect(p.classify(503, "upstream busy")).toBe("transient");
});

test("quota markers exhaust regardless of status", () => {
  expect(p.classify(400, `{"error":{"message":"credit balance is too low"}}`)).toBe("exhausted");
});

test("a 200 stream is ok", () => {
  expect(p.classify(200, "")).toBe("ok");
});
