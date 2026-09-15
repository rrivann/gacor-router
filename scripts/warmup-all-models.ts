// Probe every CodeBuddy model with a minimal request through the local
// gateway. Reports alive/dead/exhausted per model and the wall-clock latency.
//
// Uses /v1/chat/completions (non-stream) with prompt "hi" and max_tokens=16,
// which is the cheapest shape upstream accepts. Sequential — pool sticks to
// one account so quota drain is predictable, and rate limits don't bunch up.
//
// Usage:
//   bun run scripts/warmup-all-models.ts                        # dry-run: prints plan
//   bun run scripts/warmup-all-models.ts --live                 # actually probe
//   bun run scripts/warmup-all-models.ts --live --host 127.0.0.1:7788
//   bun run scripts/warmup-all-models.ts --live --only claude   # substring filter

import { codebuddyModels } from "../src/providers/codebuddy.models";

interface Args {
  live: boolean;
  host: string;
  only: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { live: false, host: "127.0.0.1:7788", only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--host" && argv[i + 1]) out.host = argv[++i]!;
    else if (a === "--only" && argv[i + 1]) out.only = argv[++i]!;
  }
  return out;
}

interface Row {
  model: string;
  http: number | "err";
  ok: boolean;
  detail: string;
  ms: number;
  credit?: number;
}

async function probe(host: string, modelId: string): Promise<Row> {
  const url = `http://${host}/v1/chat/completions`;
  const body = JSON.stringify({
    model: `codebuddy/${modelId}`,
    stream: false,
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });
  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (e) {
    return { model: modelId, http: "err", ok: false, detail: (e as Error).message, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const text = await resp.text();
  if (!resp.ok) {
    // Try to pull the upstream code/msg out of the envelope for readability.
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: unknown } };
      if (j.error?.message) detail = String(j.error.message).slice(0, 200);
    } catch {
      /* leave raw */
    }
    return { model: modelId, http: resp.status, ok: false, detail, ms };
  }
  let credit: number | undefined;
  try {
    const j = JSON.parse(text) as { usage?: { credit?: unknown } };
    if (typeof j.usage?.credit === "number") credit = j.usage.credit;
  } catch {
    /* fine */
  }
  return { model: modelId, http: resp.status, ok: true, detail: "ok", ms, credit };
}

function fmtRow(r: Row, idx: number, total: number): string {
  const num = `[${String(idx + 1).padStart(2)}/${total}]`;
  const status = r.ok ? "✓ OK  " : `✗ ${String(r.http).padEnd(4)}`;
  const model = r.model.padEnd(24);
  const ms = `${r.ms.toString().padStart(5)}ms`;
  const cost = r.credit !== undefined ? ` credit=${r.credit.toFixed(4)}` : "";
  const detail = r.ok ? "" : ` — ${r.detail}`;
  return `${num} ${status} ${model} ${ms}${cost}${detail}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let models = codebuddyModels.map((m) => m.id);
  if (args.only) {
    const q = args.only.toLowerCase();
    models = models.filter((id) => id.toLowerCase().includes(q));
  }

  console.log("=== CodeBuddy model warmup probe ===");
  console.log(`Host:   ${args.host}`);
  console.log(`Mode:   ${args.live ? "LIVE (will burn credits)" : "dry-run"}`);
  console.log(`Filter: ${args.only ?? "(all)"}`);
  console.log(`Models: ${models.length}`);
  console.log("");

  if (!args.live) {
    console.log("Plan (dry-run):");
    for (let i = 0; i < models.length; i++) {
      console.log(`  ${String(i + 1).padStart(2)}. POST /v1/chat/completions  model=codebuddy/${models[i]}`);
    }
    console.log("\nRun again with --live to actually probe.");
    return;
  }

  // Quick reachability check.
  try {
    const health = await fetch(`http://${args.host}/health`);
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch (e) {
    console.error(`Gateway not reachable at ${args.host}: ${(e as Error).message}`);
    process.exit(1);
  }

  const rows: Row[] = [];
  for (let i = 0; i < models.length; i++) {
    const r = await probe(args.host, models[i]!);
    rows.push(r);
    console.log(fmtRow(r, i, models.length));
  }

  // Summary
  const ok = rows.filter((r) => r.ok).length;
  const spent = rows.reduce((s, r) => s + (r.credit ?? 0), 0);
  const byCode = new Map<string, number>();
  for (const r of rows.filter((r) => !r.ok)) {
    const key = String(r.http);
    byCode.set(key, (byCode.get(key) ?? 0) + 1);
  }
  console.log("");
  console.log("─".repeat(60));
  console.log(`Total:    ${rows.length}`);
  console.log(`OK:       ${ok}`);
  console.log(`Failed:   ${rows.length - ok}${byCode.size ? "  " + [...byCode.entries()].map(([k, v]) => `${k}×${v}`).join(" ") : ""}`);
  console.log(`Credits:  ~${spent.toFixed(2)} (from usage events; excludes non-metered failures)`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
