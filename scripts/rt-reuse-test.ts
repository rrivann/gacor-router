// Probe whether CodeBuddy's offline refresh_token is reusable or single-use.
//
// Reads the account row from gacor.db, calls /v2/plugin/auth/token/refresh
// TWICE with the ORIGINAL refresh_token, and persists the freshest pair to
// the DB between calls. Safe by construction:
//   - the DB always holds the newest pair the upstream has minted, even if
//     the second call succeeds and mints a third;
//   - the refresh endpoint does not go through Tencent's inference meter, so
//     the current 0/100 credit blocker does not apply.
//
// Interpretation:
//   - both calls succeed → refresh token is REUSABLE within the window
//   - first succeeds, second returns code!=0 or !ok → SINGLE-USE (rotate-on-use)
//   - first fails         → the RT was already dead / config changed
//
// Usage:
//   bun run scripts/rt-reuse-test.ts             # dry-run (prints plan, no fetch)
//   bun run scripts/rt-reuse-test.ts --live      # actually hit upstream
//   bun run scripts/rt-reuse-test.ts --live --account-id 1 --db ./gacor.db

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

interface Creds {
  access_token?: string;
  refresh_token?: string;
  api_key?: string;
  [k: string]: string | undefined;
}

interface AccountRow {
  id: number;
  provider: string;
  label: string | null;
  creds: string | null;
}

interface RefreshResponse {
  code?: number;
  msg?: string;
  data?: { accessToken?: string; refreshToken?: string };
}

const REFRESH_URL = "https://www.codebuddy.ai/v2/plugin/auth/token/refresh";
const CLIENT_VERSION = "2.108.1";
const USER_AGENT = `CLI/${CLIENT_VERSION} CodeBuddy/${CLIENT_VERSION}`;

function parseArgs(argv: string[]): { live: boolean; accountId: number; dbPath: string } {
  const out = { live: false, accountId: 1, dbPath: "./gacor.db" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--account-id" && argv[i + 1]) out.accountId = Number(argv[++i]);
    else if (a === "--db" && argv[i + 1]) out.dbPath = argv[++i]!;
  }
  return out;
}

function jwtTail(token: string | undefined): string {
  if (!token) return "(empty)";
  const parts = token.split(".");
  if (parts.length !== 3) return `opaque:${token.slice(0, 8)}…`;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    ) as { exp?: number; iat?: number; jti?: string };
    const exp = payload.exp ? new Date(payload.exp * 1000).toISOString() : "?";
    const iat = payload.iat ? new Date(payload.iat * 1000).toISOString() : "?";
    return `jti=${(payload.jti ?? "?").slice(0, 8)}… iat=${iat} exp=${exp}`;
  } catch {
    return `unparseable:${token.slice(0, 8)}…`;
  }
}

async function callRefresh(rt: string): Promise<{
  status: number;
  ok: boolean;
  body: RefreshResponse | null;
  raw: string;
}> {
  const resp = await fetch(REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "X-Requested-With": "XMLHttpRequest",
      "X-Domain": "www.codebuddy.ai",
      "X-Refresh-Token": rt,
      "X-Auth-Refresh-Source": "plugin",
      "X-Product": "SaaS",
    },
    body: "{}",
  });
  const raw = await resp.text();
  let body: RefreshResponse | null = null;
  try {
    body = JSON.parse(raw) as RefreshResponse;
  } catch {
    /* leave null */
  }
  return { status: resp.status, ok: resp.ok, body, raw };
}

function persist(db: Database, accountId: number, creds: Creds): void {
  const stmt = db.prepare("UPDATE accounts SET creds = ? WHERE id = ?");
  stmt.run(JSON.stringify(creds), accountId);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.dbPath);

  console.log("=== RT-reusable probe ===");
  console.log(`DB:         ${dbPath}`);
  console.log(`Account ID: ${args.accountId}`);
  console.log(`Mode:       ${args.live ? "LIVE (will hit upstream)" : "dry-run"}`);
  console.log("");

  const db = new Database(dbPath, { readonly: !args.live });
  const row = db
    .prepare("SELECT id, provider, label, creds FROM accounts WHERE id = ?")
    .get(args.accountId) as AccountRow | undefined;

  if (!row) {
    console.error(`Account id=${args.accountId} not found in ${dbPath}`);
    process.exit(1);
  }
  if (row.provider !== "codebuddy") {
    console.error(`Account id=${args.accountId} is provider=${row.provider}, expected 'codebuddy'`);
    process.exit(1);
  }

  const creds = (row.creds ? JSON.parse(row.creds) : {}) as Creds;
  const originalRt = creds.refresh_token?.trim();
  if (!originalRt) {
    console.error(`Account id=${args.accountId} has no refresh_token; nothing to probe.`);
    process.exit(1);
  }

  console.log(`Account:    ${row.label ?? "(no label)"} (${row.provider})`);
  console.log(`Access tok: ${jwtTail(creds.access_token)}`);
  console.log(`Refresh:    ${jwtTail(originalRt)}`);
  console.log("");

  if (!args.live) {
    console.log("Plan (dry-run):");
    console.log("  1. POST /v2/plugin/auth/token/refresh with X-Refresh-Token: <original>");
    console.log("  2. If ok + code=0 → persist new pair to DB");
    console.log("  3. POST /v2/plugin/auth/token/refresh AGAIN with the SAME <original>");
    console.log("  4. If ok + code=0 → persist newer pair to DB, report REUSABLE");
    console.log("     Else → keep pair from step 2, report SINGLE-USE");
    console.log("");
    console.log("Run again with --live to actually probe upstream.");
    db.close();
    return;
  }

  // --- LIVE ---
  console.log("[1/2] First refresh (original RT)…");
  const first = await callRefresh(originalRt);
  console.log(`      HTTP ${first.status}, code=${first.body?.code ?? "?"}, msg=${first.body?.msg ?? "?"}`);
  if (!first.ok || first.body?.code !== 0 || !first.body?.data?.accessToken) {
    console.error("      First refresh FAILED — RT was already dead or config changed.");
    console.error(`      Raw: ${first.raw.slice(0, 400)}`);
    db.close();
    process.exit(2);
  }
  const pair1 = {
    access_token: first.body.data.accessToken.trim(),
    refresh_token: (first.body.data.refreshToken?.trim() || originalRt),
  };
  console.log(`      New access: ${jwtTail(pair1.access_token)}`);
  console.log(`      New refresh: ${jwtTail(pair1.refresh_token)}`);
  console.log(`      RT rotated? ${pair1.refresh_token !== originalRt ? "YES" : "NO"}`);
  persist(db, args.accountId, { ...creds, ...pair1 });
  console.log("      → persisted pair to DB");
  console.log("");

  console.log("[2/2] Second refresh (SAME original RT)…");
  const second = await callRefresh(originalRt);
  console.log(`      HTTP ${second.status}, code=${second.body?.code ?? "?"}, msg=${second.body?.msg ?? "?"}`);

  if (second.ok && second.body?.code === 0 && second.body?.data?.accessToken) {
    const pair2 = {
      access_token: second.body.data.accessToken.trim(),
      refresh_token: (second.body.data.refreshToken?.trim() || originalRt),
    };
    persist(db, args.accountId, { ...creds, ...pair2 });
    console.log("      → persisted newer pair to DB");
    console.log("");
    console.log("VERDICT: REUSABLE — the same RT was accepted twice.");
    console.log(`         (pair1.rt === pair2.rt? ${pair1.refresh_token === pair2.refresh_token})`);
  } else {
    console.log(`      Raw: ${second.raw.slice(0, 400)}`);
    console.log("");
    console.log("VERDICT: SINGLE-USE — the original RT was rejected on second call.");
    console.log("         DB currently holds pair from first refresh (still fresh).");
  }
  db.close();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
