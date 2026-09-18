import { test, expect, beforeEach } from "bun:test";
import {
  cacheCL4udeHeaders,
  getCachedCL4udeHeaders,
  clearCL4udeHeaderCache,
  applyCL4udeOverlayToHeaders,
} from "../src/lib/claudeHeaderCache";

beforeEach(() => {
  clearCL4udeHeaderCache();
});

test("skips non-CL4ude clients", () => {
  const h = new Headers({ "user-agent": "curl/8.0", "accept": "*/*" });
  cacheCL4udeHeaders(h);
  expect(getCachedCL4udeHeaders()).toBeNull();
});

test("captures via claude-cli user agent", () => {
  const h = new Headers({
    "user-agent": "claude-cli/2.1.276",
    "anthr0pic-beta": "code-assistant-20250219",
    "x-stainless-runtime": "node",
  });
  cacheCL4udeHeaders(h);
  const cached = getCachedCL4udeHeaders();
  expect(cached).not.toBeNull();
  expect(cached!["user-agent"]).toBe("claude-cli/2.1.276");
  expect(cached!["anthr0pic-beta"]).toBe("code-assistant-20250219");
  expect(cached!["x-stainless-runtime"]).toBe("node");
});

test("captures via x-app: cli", () => {
  const h = new Headers({
    "x-app": "cli",
    "user-agent": "custom-agent/1.0",
    "x-stainless-lang": "js",
  });
  cacheCL4udeHeaders(h);
  const cached = getCachedCL4udeHeaders();
  expect(cached).not.toBeNull();
  expect(cached!["x-app"]).toBe("cli");
  expect(cached!["x-stainless-lang"]).toBe("js");
});

test("skips when detection passes but no identity headers present", () => {
  // UA matches — client is CL4ude Code — but ONLY the UA is present, so the
  // captured record would carry just that one entry. Actually that's still
  // 1 key, so it caches. Test the true-empty case: x-app match but no other
  // identity fields.
  const h = new Headers({ "x-app": "cli" });
  cacheCL4udeHeaders(h);
  // x-app IS in CLAUDE_IDENTITY_HEADERS, so this captures {x-app: cli}
  expect(getCachedCL4udeHeaders()).not.toBeNull();
  expect(getCachedCL4udeHeaders()!["x-app"]).toBe("cli");
});

test("most recent capture replaces previous", () => {
  cacheCL4udeHeaders(new Headers({ "user-agent": "claude-cli/2.1.100" }));
  expect(getCachedCL4udeHeaders()!["user-agent"]).toBe("claude-cli/2.1.100");
  cacheCL4udeHeaders(new Headers({ "user-agent": "claude-cli/2.1.276" }));
  expect(getCachedCL4udeHeaders()!["user-agent"]).toBe("claude-cli/2.1.276");
});

test("clearCL4udeHeaderCache resets to null", () => {
  cacheCL4udeHeaders(new Headers({ "user-agent": "claude-cli/2.1.276" }));
  expect(getCachedCL4udeHeaders()).not.toBeNull();
  clearCL4udeHeaderCache();
  expect(getCachedCL4udeHeaders()).toBeNull();
});

test("applyCL4udeOverlayToHeaders is a no-op when cache is empty", () => {
  const h = new Headers({ "user-agent": "CLI/2.108.1 CodeBuddy/2.108.1" });
  applyCL4udeOverlayToHeaders(h);
  expect(h.get("user-agent")).toBe("CLI/2.108.1 CodeBuddy/2.108.1");
});

test("applyCL4udeOverlayToHeaders replaces UA + stainless fields when cached", () => {
  cacheCL4udeHeaders(
    new Headers({
      "user-agent": "claude-cli/2.1.276",
      "x-stainless-runtime-version": "v22.0.0",
    })
  );
  const h = new Headers({
    "user-agent": "CLI/2.108.1 CodeBuddy/2.108.1",
    "x-stainless-runtime-version": "v20.0.0",
    "x-codebuddy-request": "1",
  });
  applyCL4udeOverlayToHeaders(h);
  expect(h.get("user-agent")).toBe("claude-cli/2.1.276");
  expect(h.get("x-stainless-runtime-version")).toBe("v22.0.0");
  // Non-identity fields untouched.
  expect(h.get("x-codebuddy-request")).toBe("1");
});

test("applyCL4udeOverlayToHeaders merges remove-beta flags rather than replacing", () => {
  cacheCL4udeHeaders(
    new Headers({
      "user-agent": "claude-cli/2.1.276",
      "anthr0pic-beta": "code-assistant-20250219,oauth-2025-04-20",
    })
  );
  const h = new Headers({
    "anthr0pic-beta": "existing-flag,shared-flag",
  });
  applyCL4udeOverlayToHeaders(h);
  const beta = h.get("anthr0pic-beta") ?? "";
  expect(beta).toContain("existing-flag");
  expect(beta).toContain("shared-flag");
  expect(beta).toContain("code-assistant-20250219");
  expect(beta).toContain("oauth-2025-04-20");
});
