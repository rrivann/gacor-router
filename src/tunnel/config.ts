// abc-tunnel.us integration config. The stable public URL feature registers
// this router's current cloudflared URL with a small worker under a persistent
// shortId, so users can hit `https://r<shortId>.abc-tunnel.us` even though
// cloudflared's quick tunnel URL rotates on every restart.
//
// The worker is NOT our infra — it's the same one 9router uses. It has no
// auth on /api/tunnel/register, so we generate a random shortId to make
// silent hijack unlikely. Users can toggle the feature off in the dashboard
// if they want to avoid the third-party hop entirely.

import { randomInt } from "node:crypto";

export const WORKER_URL = process.env.TUNNEL_WORKER_URL || "https://abc-tunnel.us";

const SHORT_ID_LEN = 6;
// Excludes visually confusing chars (o, l, 0, 1) — same set 9router picked
// so an old shortId from that project would also be valid here.
const SHORT_ID_ALPHABET = "abcdefghijklmnpqrstuvwxyz23456789";

export function generateShortId(): string {
  let out = "";
  for (let i = 0; i < SHORT_ID_LEN; i++) {
    out += SHORT_ID_ALPHABET[randomInt(0, SHORT_ID_ALPHABET.length)];
  }
  return out;
}

// Compose the stable URL clients can bookmark. The shape mirrors 9router
// so an existing bookmark keeps working when a user migrates.
export function publicUrlFor(shortId: string): string {
  return `https://r${shortId}.abc-tunnel.us`;
}
