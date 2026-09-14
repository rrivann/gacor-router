// CodeBuddy credit snapshot parsing: the Tencent billing response is pinned
// here against a realistic fixture — monthly plan package + lifetime bonus
// packs, precise-string numbers, Asia/Shanghai cycle end times.

import { test, expect } from "bun:test";
import { CodeBuddyProvider } from "../src/providers/codebuddy";
import type { Account } from "../src/providers/types";

const acc: Account = {
  id: 1,
  label: "test",
  secret: "",
  creds: { access_token: "tok-abc" },
};

// Shape mirrors /v2/billing/meter/get-user-resource: one monthly plan
// (cycle capacity, refills at CycleEndTime) and two lifetime bonus packs.
const BILLING_FIXTURE = {
  code: 0,
  msg: "",
  data: {
    Response: {
      Data: {
        Accounts: [
          {
            PackageName: "Free Plan Subscription",
            SubProductName: "Free Plan Subscription",
            SubProductCode: "sp_free",
            Status: 0,
            CapacitySize: 100,
            CapacityUsed: 0,
            CapacityRemain: 100,
            CycleCapacitySize: 100,
            CycleCapacityUsed: 0,
            CycleCapacityRemain: 100,
            CapacitySizePrecise: "100",
            CapacityUsedPrecise: "0",
            CapacityRemainPrecise: "100",
            CycleCapacitySizePrecise: "100",
            CycleCapacityUsedPrecise: "0",
            CycleCapacityRemainPrecise: "100",
            CycleEndTime: "2026-09-30 23:59:59",
          },
          {
            PackageName: "Bonus Pack",
            SubProductName: "Bonus Pack",
            SubProductCode: "sp_bonus_1",
            Status: 0,
            CapacitySize: 30,
            CapacityUsed: 6,
            CapacityRemain: 24,
            CycleCapacitySize: 0,
            CapacitySizePrecise: "30",
            CapacityUsedPrecise: "6",
            CapacityRemainPrecise: "24",
            CycleCapacitySizePrecise: "0",
            CycleEndTime: "2026-09-28 23:59:59",
          },
          {
            PackageName: "Bonus Pack",
            SubProductName: "Bonus Pack",
            SubProductCode: "sp_bonus_2",
            Status: 0,
            CapacitySize: 30,
            CapacityUsed: 0,
            CapacityRemain: 30,
            CycleCapacitySize: 0,
            CapacitySizePrecise: "30",
            CapacityUsedPrecise: "0",
            CapacityRemainPrecise: "30",
            CycleCapacitySizePrecise: "0",
            CycleEndTime: "2026-10-15 23:59:59",
          },
          {
            PackageName: "Expired Pack",
            SubProductName: "Expired Pack",
            SubProductCode: "sp_old",
            Status: 1, // inactive — must be skipped entirely
            CapacitySize: 999,
            CapacityUsed: 0,
            CapacityRemain: 999,
            CycleCapacitySize: 0,
            CapacitySizePrecise: "999",
            CapacityUsedPrecise: "0",
            CapacityRemainPrecise: "999",
            CycleCapacitySizePrecise: "0",
            CycleEndTime: "",
          },
        ],
      },
    },
  },
};

function providerReturning(body: unknown, status = 200): CodeBuddyProvider {
  // Test seam: a bare async fn satisfies the call shape; fetch's statics
  // (preconnect etc.) are never touched by the provider.
  return new CodeBuddyProvider(
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  );
}

test("monthly + lifetime packages are summed and broken down", async () => {
  const p = providerReturning(BILLING_FIXTURE);
  const u = await p.usage(acc);

  // 100 monthly + (30 + 30) lifetime; the 999 expired pack is excluded.
  expect(u.limit).toBe(160);
  expect(u.used).toBe(6);
  expect(u.remaining).toBe(154);
  expect(u.plan).toBe("Free Plan Subscription");

  expect(u.packages).toHaveLength(3);
  const [plan, bonus1, bonus2] = u.packages!;
  expect(plan).toMatchObject({ kind: "monthly", limit: 100, remaining: 100 });
  expect(bonus1).toMatchObject({ kind: "lifetime", limit: 30, used: 6, remaining: 24 });
  expect(bonus2).toMatchObject({ kind: "lifetime", limit: 30, remaining: 30 });
});

test("resetAtUnix is the soonest cycle end, parsed as Asia/Shanghai", async () => {
  const p = providerReturning(BILLING_FIXTURE);
  const u = await p.usage(acc);

  // "2026-09-28 23:59:59" Asia/Shanghai (UTC+8) = 2026-09-28 15:59:59 UTC.
  const expected = Date.UTC(2026, 8, 28, 15, 59, 59) / 1000;
  expect(u.resetAtUnix).toBe(expected);
  expect(u.packages![0]!.resetAtUnix).toBe(Date.UTC(2026, 8, 30, 15, 59, 59) / 1000);
});

test("the billing request carries CLI headers and the bearer token", async () => {
  let seenUrl: string | null = null;
  let seenInit: RequestInit | undefined;
  const p = new CodeBuddyProvider((async (input: Request | string | URL, init?: RequestInit) => {
    seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seenInit = init;
    return new Response(JSON.stringify(BILLING_FIXTURE), { status: 200 });
  }) as unknown as typeof fetch);
  await p.usage(acc);

  expect(seenUrl).toBe("https://www.codebuddy.ai/v2/billing/meter/get-user-resource");
  const headers = new Headers(seenInit?.headers);
  expect(headers.get("authorization")).toBe("Bearer tok-abc");
  expect(headers.get("x-domain")).toBe("www.codebuddy.ai");
  expect(headers.get("x-product")).toBe("SaaS");
  expect(headers.get("user-agent")).toContain("CodeBuddy/");
  expect(seenInit?.method).toBe("POST");
});

test("a 401 surfaces as an invalid-credential error", async () => {
  const p = providerReturning({}, 401);
  await expect(p.usage(acc)).rejects.toThrow("invalid or expired");
});

test("a non-zero business code surfaces as a credits error", async () => {
  const p = providerReturning({ code: 11140, msg: "request illegal" });
  await expect(p.usage(acc)).rejects.toThrow("11140");
});

test("an account with no token fails fast", async () => {
  const p = providerReturning(BILLING_FIXTURE);
  await expect(p.usage({ id: 2, label: "x", secret: "", creds: {} })).rejects.toThrow("no token");
});
