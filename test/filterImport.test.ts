// Pure normalization tests for the dashboard's filter import helper. Runs
// under bun test even though the source lives under dashboard/ — the
// helper has no DOM dependency, just JSON parsing.

import { test, expect } from "bun:test";
import { normalizeFilterBundle } from "../dashboard/src/lib/filterImport";

test("native gacor bundle round-trips every field", () => {
  const input = {
    filters: [
      {
        pattern: "secret",
        replacement: "[REDACTED]",
        isRegex: true,
        isActive: false,
        sort: 5,
        providerScope: ["codebuddy"],
      },
    ],
  };
  const out = normalizeFilterBundle(input);
  expect(out).toEqual([
    {
      pattern: "secret",
      replacement: "[REDACTED]",
      isRegex: true,
      isActive: false,
      sort: 5,
      providerScope: ["codebuddy"],
    },
  ]);
});

test("9router legacy: enabled maps to isActive, top-level scope propagates", () => {
  const input = {
    filters: [
      { pattern: "test1", replacement: "T1", enabled: false },
      { pattern: "test2", replacement: "T2", enabled: true },
    ],
    providerScope: ["codebuddy"],
  };
  const out = normalizeFilterBundle(input);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ pattern: "test1", isActive: false, providerScope: ["codebuddy"] });
  expect(out[1]).toMatchObject({ pattern: "test2", isActive: true, providerScope: ["codebuddy"] });
});

test("per-row providerScope wins over top-level bundle scope", () => {
  const input = {
    filters: [
      { pattern: "a", providerScope: ["codebuddy-cn"] },
      { pattern: "b" },
    ],
    providerScope: ["codebuddy"],
  };
  const out = normalizeFilterBundle(input);
  expect(out[0].providerScope).toEqual(["codebuddy-cn"]);
  expect(out[1].providerScope).toEqual(["codebuddy"]);
});

test("bare array is accepted; rows without pattern are dropped", () => {
  const input = [
    { pattern: "ok" },
    { replacement: "no pattern" }, // dropped — missing pattern
    { pattern: "" }, // dropped — empty pattern
    "not-an-object", // dropped
    { pattern: "also-ok", replacement: "" },
  ];
  const out = normalizeFilterBundle(input);
  expect(out.map((r) => r.pattern)).toEqual(["ok", "also-ok"]);
});

test("unknown shape or empty input returns []", () => {
  expect(normalizeFilterBundle(null)).toEqual([]);
  expect(normalizeFilterBundle("string")).toEqual([]);
  expect(normalizeFilterBundle({})).toEqual([]);
  expect(normalizeFilterBundle({ filters: "not-array" })).toEqual([]);
});
