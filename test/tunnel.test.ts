// Pure-function tests for cloudflared log parsing — no binary, no process.
// Also covers the PID helper used to make isCloudflaredRunning() survive a
// backend restart.

import { test, expect, afterAll } from "bun:test";
import { parseQuickTunnelUrl } from "../src/tunnel/cloudflared";
import { clearPid, isPidAlive, loadPid, savePid } from "../src/tunnel/pid";

const SAMPLE_LOG = `
2026-09-14T10:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick tunnel.
2026-09-14T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-09-14T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-14T10:00:01Z INF |  https://seasonal-wichita-funky-obj.trycloudflare.com                                     |
2026-09-14T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-09-14T10:00:01Z INF Cannot determine default configuration path. No file [config.yml config.yaml] in [~/.cloudflared]
2026-09-14T10:00:02Z INF Registered tunnel connection connIndex=0 connection=api.trycloudflare.com
`;

test("parses the tunnel URL from real-shaped cloudflared output", () => {
  expect(parseQuickTunnelUrl(SAMPLE_LOG)).toBe("https://seasonal-wichita-funky-obj.trycloudflare.com");
});

test("ignores api.trycloudflare.com (control plane, not the tunnel)", () => {
  const log = "connection=api.trycloudflare.com registered";
  expect(parseQuickTunnelUrl(log)).toBeNull();
});

test("returns null when no URL is present", () => {
  expect(parseQuickTunnelUrl("just some logs\nnothing here")).toBeNull();
});

test("prefers the last URL when the log carries several", () => {
  const log = "https://first-one-x.trycloudflare.com then https://second-one-y.trycloudflare.com";
  expect(parseQuickTunnelUrl(log)).toBe("https://second-one-y.trycloudflare.com");
});

test("handles uppercase host characters case-insensitively", () => {
  expect(parseQuickTunnelUrl("HTTPS://ABC-DEF.trycloudflare.com")).toBe("https://abc-def.trycloudflare.com");
});

// ── PID helper ────────────────────────────────────────────────────
// These write to ~/.gacor-router/tunnel/cloudflared.pid — the same file the
// real spawner uses — so run cleanup after the block. A dev machine that
// happens to have a live tunnel would see its PID file recreated on next
// enable, so this is safe.

afterAll(() => clearPid());

test("savePid → loadPid round-trip", () => {
  savePid(12345);
  expect(loadPid()).toBe(12345);
});

test("clearPid removes the file and is idempotent when absent", () => {
  savePid(42);
  clearPid();
  expect(loadPid()).toBeNull();
  // A second clear on an already-absent file must not throw.
  clearPid();
  expect(loadPid()).toBeNull();
});

test("isPidAlive reports true for the current process", () => {
  expect(isPidAlive(process.pid)).toBe(true);
});

test("isPidAlive reports false for a very high fictional pid", () => {
  // 2^31 - 1: high enough that no real process should own it on any OS.
  expect(isPidAlive(2147483646)).toBe(false);
});
