// Standalone smoke test for CodeBuddy /v2/videos/generations + /v2/videos/tasks.
// Reads an account row from the local DB, refreshes its bearer via the provider,
// submits a video job, polls the task endpoint, and saves the mp4 to disk.
//
// Non-invasive: nothing about the proxy, pool, filters, or logging touches this
// script — it just proves the raw HTTP flow works on the current credential
// before any Provider/route work lands.
//
// Cost: seedance-2.5 5s/720P ≈ 104 credits. Dry-run by default; --live spends.
//
// Usage:
//   bun run scripts/video-smoke.ts                                    # dry-run
//   bun run scripts/video-smoke.ts --live --account-id 9              # spend on acc #9
//   bun run scripts/video-smoke.ts --live --account-id 9 --seconds 5
//     --resolution 720P --aspect 16:9 --prompt "..." --out out.mp4

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CodeBuddyProvider } from "../src/providers/codebuddy";
import { getAccount } from "../src/db/accounts";
import type { Account } from "../src/providers/types";

interface Args {
  live: boolean;
  accountId: number | null;
  model: string;
  seconds: number;
  resolution: "720P" | "1080P";
  aspect: "16:9" | "9:16" | "1:1";
  audio: boolean;
  prompt: string;
  negative: string;
  watermark: boolean;
  outPath: string | null;
  timeoutSec: number;
  pollSec: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    live: false,
    accountId: null,
    model: "seedance-2.5",
    seconds: 5,
    resolution: "720P",
    aspect: "16:9",
    audio: false,
    prompt: "A cat walking gracefully across a sunny room",
    negative: "",
    watermark: true,
    outPath: null,
    timeoutSec: 600,
    pollSec: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--account-id" && argv[i + 1]) out.accountId = Number(argv[++i]);
    else if (a === "--model" && argv[i + 1]) out.model = argv[++i]!;
    else if (a === "--seconds" && argv[i + 1]) out.seconds = Number(argv[++i]);
    else if (a === "--resolution" && argv[i + 1]) out.resolution = argv[++i] as "720P" | "1080P";
    else if (a === "--aspect" && argv[i + 1]) out.aspect = argv[++i] as "16:9" | "9:16" | "1:1";
    else if (a === "--audio") out.audio = true;
    else if (a === "--prompt" && argv[i + 1]) out.prompt = argv[++i]!;
    else if (a === "--negative" && argv[i + 1]) out.negative = argv[++i]!;
    else if (a === "--no-watermark") out.watermark = false;
    else if (a === "--out" && argv[i + 1]) out.outPath = argv[++i]!;
    else if (a === "--timeout" && argv[i + 1]) out.timeoutSec = Number(argv[++i]);
    else if (a === "--poll" && argv[i + 1]) out.pollSec = Number(argv[++i]);
  }
  return out;
}

// The same CLI-identifying envelope the mitm capture recorded on 2026-09-16.
// Kept in one function so the smoke test and any future Provider port stay
// byte-identical on the wire.
function buildVideoHeaders(bearer: string, uid: string): Headers {
  const conversationId = randomUUID();
  const requestId = randomUUID().replace(/-/g, "");
  return new Headers({
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${bearer}`,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": requestId,
    "X-Conversation-Message-ID": requestId,
    "X-Request-ID": requestId,
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    "X-Agent-Purpose": "conversation",
    "X-Root-Request-ID": requestId,
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "",
    "X-IDE-Version": "0.0.0",
    "X-User-Id": uid,
    "X-Domain": "www.codebuddy.ai",
    "X-Product": "SaaS",
    "User-Agent": "CLI/2.151.0 CodeBuddy/2.151.0",
  });
}

// Decode a JWT payload without verifying — just to pull `sub` for X-User-Id.
function jwtSub(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    ) as { sub?: string };
    return payload.sub ?? "";
  } catch {
    return "";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.accountId === null) {
    console.log("usage: bun run scripts/video-smoke.ts --account-id <id> [--live] [...]");
    console.log("       --account-id  required — a codebuddy account row id");
    console.log("       --live        actually submit the job (default: dry-run)");
    console.log("       --seconds     video length in seconds (default 5)");
    console.log("       --resolution  720P | 1080P (default 720P)");
    console.log("       --aspect      16:9 | 9:16 | 1:1 (default 16:9)");
    console.log("       --audio       include audio track");
    console.log("       --prompt      video prompt text");
    console.log("       --model       upstream model (default seedance-2.5)");
    console.log("       --out         output mp4 path (default video_<ts>.mp4 in cwd)");
    console.log("       --timeout     max seconds to poll (default 600)");
    console.log("       --poll        seconds between polls (default 10)");
    process.exit(1);
  }

  const row = getAccount(args.accountId);
  if (!row) {
    console.error(`account #${args.accountId} not found`);
    process.exit(2);
  }
  if (row.provider !== "codebuddy") {
    console.error(`account #${row.id} is provider "${row.provider}", not codebuddy`);
    process.exit(2);
  }
  console.log(`[+] account #${row.id} label=${row.label ?? "<none>"} status=${row.status}`);

  const provider = new CodeBuddyProvider();
  const initial: Account = { id: row.id, label: row.label ?? `#${row.id}`, secret: row.secret, creds: row.creds ?? {} };

  console.log("[*] refreshing bearer…");
  const refreshed = await provider.refresh(initial);
  if (!refreshed) {
    console.error("refresh returned null — refresh_token rejected (re-login needed)");
    process.exit(3);
  }
  const bearer = refreshed.creds.access_token || refreshed.creds.api_key || refreshed.secret;
  if (!bearer) {
    console.error("no bearer after refresh");
    process.exit(3);
  }
  const uid = jwtSub(bearer);
  console.log(`[+] bearer ok (uid ${uid.slice(0, 8)}…, ${bearer.length} chars)`);

  const submitBody = {
    prompt: args.prompt,
    model: args.model,
    seconds: args.seconds,
    negative_prompt: args.negative,
    watermark: args.watermark,
    extra_parameters: {
      resolution: args.resolution,
      enable_audio: args.audio,
      aspect_ratio: args.aspect,
    },
  };

  console.log("[*] plan:");
  console.log(`    model=${args.model} seconds=${args.seconds} ${args.resolution} ${args.aspect}` +
    (args.audio ? " +audio" : "") + (args.watermark ? " +watermark" : ""));
  console.log(`    prompt: ${args.prompt.slice(0, 80)}${args.prompt.length > 80 ? "…" : ""}`);
  console.log(`    est. cost: ~${args.seconds * 21} credits (${args.seconds}s × 21 credit/s @ 720P)`);

  if (!args.live) {
    console.log("[dry-run] pass --live to actually submit. Exiting.");
    return;
  }

  console.log("[*] submit → POST /v2/videos/generations");
  const submitResp = await fetch("https://www.codebuddy.ai/v2/videos/generations", {
    method: "POST",
    headers: buildVideoHeaders(bearer, uid),
    body: JSON.stringify(submitBody),
  });
  const submitText = await submitResp.text();
  console.log(`    ← ${submitResp.status} ${submitText.slice(0, 200)}`);
  if (submitResp.status !== 200) process.exit(4);

  let submitJson: { code?: number; msg?: string; data?: { id?: string; status?: string } };
  try {
    submitJson = JSON.parse(submitText);
  } catch {
    console.error("submit response not JSON");
    process.exit(4);
  }
  if (submitJson.code !== 0 || !submitJson.data?.id) {
    console.error(`submit failed: code=${submitJson.code} msg=${submitJson.msg}`);
    process.exit(4);
  }
  const taskId = submitJson.data.id;
  console.log(`[+] task ${taskId} status=${submitJson.data.status}`);

  const deadline = Date.now() + args.timeoutSec * 1000;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount++;
    await new Promise((r) => setTimeout(r, args.pollSec * 1000));

    const pollResp = await fetch("https://www.codebuddy.ai/v2/videos/tasks", {
      method: "POST",
      headers: buildVideoHeaders(bearer, uid),
      body: JSON.stringify({ task_id: taskId }),
    });
    const pollText = await pollResp.text();
    let pollJson: {
      code?: number;
      data?: {
        status?: string;
        data?: { url?: string; resolution?: string }[];
        usage?: { credit?: number; output_tokens?: number };
      };
    };
    try {
      pollJson = JSON.parse(pollText);
    } catch {
      console.log(`[poll ${pollCount}] non-JSON response: ${pollText.slice(0, 200)}`);
      continue;
    }
    const status = pollJson.data?.status ?? "?";
    console.log(`[poll ${pollCount}] status=${status}`);

    if (status === "failed") {
      console.error("task failed:");
      console.error(JSON.stringify(pollJson, null, 2).slice(0, 800));
      process.exit(5);
    }
    if (status === "completed") {
      const videos = pollJson.data?.data ?? [];
      const usage = pollJson.data?.usage ?? {};
      console.log(`[+] completed — credit=${usage.credit} output_tokens=${usage.output_tokens}`);
      if (videos.length === 0) {
        console.error("completed but no videos in data.data[]");
        process.exit(5);
      }
      for (const v of videos) {
        if (!v.url) continue;
        const outPath = args.outPath ?? join(process.cwd(), `video_${taskId.slice(0, 12)}.mp4`);
        mkdirSync(join(outPath, ".."), { recursive: true });
        console.log(`    ${v.resolution ?? "?"}: ${v.url.slice(0, 100)}…`);
        console.log(`[*] download → ${outPath}`);
        const dlResp = await fetch(v.url);
        if (!dlResp.ok) {
          console.error(`download failed: HTTP ${dlResp.status}`);
          process.exit(6);
        }
        const buf = new Uint8Array(await dlResp.arrayBuffer());
        writeFileSync(outPath, buf);
        console.log(`[+] saved ${buf.length} bytes → ${outPath}`);
      }
      return;
    }
  }
  console.error(`timeout after ${args.timeoutSec}s polling task ${taskId}`);
  process.exit(7);
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
