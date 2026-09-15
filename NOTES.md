# gacor-router — Catatan Lanjutan Proyek

> Dokumen ini untuk lanjut session baru. Baca ini dulu sebelum ngapa-ngapain.
> Terakhir update: 2026-09-16 (sesi besar — Bug 1 fix, image gen, filters, cache/pricing observability)

## TL;DR buat session baru

- **Kode terakhir**: sesi 2026-09-16 landing 33 model catalog, image endpoint
  live, filters engine + provider scoping, request logs punya TTFT/Cache
  Read+Write/Reasoning/USD dolar. **242 test pass, typecheck clean.**
- **Sesi ini beresin banyak:**
  - Bug 1 (RT-only refresh) — **FIXED** + test khusus
  - Usage refresh sync status active↔exhausted (fix 429-loop dashboard)
  - JWT-derived label auto-fill (deriveLabel)
  - Bulk add account (paste multi-line RT) + dedup (RT string + JWT sub)
  - `/v1/images/generations` full stack (gpt-image-2 + gemini flash-image ×2)
  - Chat playground render image inline
  - Content filters (enowx-inspired): CRUD + hot-reload + regex + provider scoping + inline edit
  - Request logs cache/reasoning/TTFT/USD dollar (ranking tied 1st vs 9router)
  - Added `kimi-k2.8-preview` ke katalog (verified live)
- **⚠️ BLOCKER masih valid**: credit `cb-global-1` **habis (0/100)**. Reset
  ~30 Sep 2026. Tapi ada 2 akun tambahan (id 10 & 11 Bonus Pack, ~466 credit
  each) buat testing. Warmup skenario butuh saldo di salah satu akun.
- **Skipped intentional:**
  - Video gen seedance-2.5 — POST works, polling belum ketemu. Butuh trace
    network dashboard CodeBuddy. Detail di [reference_video_endpoint.md](/Users/rivanalbaniray/.claude/projects/-Users-rivanalbaniray-Documents-github-gacor-router/memory/reference_video_endpoint.md)
  - Cache marker injection (etteum) — dead code untuk CodeBuddy (marker
    `remove: {type:"ephemeral"}` di-strip). Detail di [reference_cache_markers.md](/Users/rivanalbaniray/.claude/projects/-Users-rivanalbaniray-Documents-github-gacor-router/memory/reference_cache_markers.md)
  - Bug 2 warmup persist creds — belum diperbaiki, tapi impact rendah karena
    Bug 1 fix + usage.ts refresh persist sudah nutup skenario worst-case.

## Ringkasan sesi 2026-09-16 (major)

### Auth & account
- **Bug 1 fixed** — `refresh()` di [providers/codebuddy.ts:302](src/providers/codebuddy.ts:302) skip freshness check kalau bearer kosong (RT-only account) → langsung exchange
- **Usage refresh sync status** — [src/lib/usage.ts:48-52](src/lib/usage.ts:48) reconcile status vs credit remaining. `refresh()` juga sekarang jalan sebelum `usage()` (RT-only Load button jalan)
- **JWT-derived label** — `deriveLabel(creds)` [src/lib/label.ts](src/lib/label.ts) auto-fill dari `preferred_username`/`email`/`sub`. Warmup backfill label existing kalau null.
- **Bulk add account** — textarea multi-line di AddAccountDialog + progress panel (ok/skipped/failed per-RT)
- **Dedup 409** — POST /accounts tolak RT string duplicate atau JWT sub duplicate (`deriveIdentity`). Same provider only.

### Image generation (full stack)
- Endpoint `/v2/images/generations` di CodeBuddy reverse-engineered
- Provider interface: `Provider.image?()` + `ImageRequest`/`ImageResponse`
- Route baru `POST /v1/images/generations` (0penAI-compat, non-stream)
- Proxy loop `proxyImage()` (rotation + refresh, tanpa stream)
- Katalog: 3 model image (`gpt-image-2`, `gemini-2.5-flash-image`, `gemini-3.1-flash-image`)
- Field `kind: "chat" | "image"` di ModelInfo, badge + filter di dashboard Models
- Chat playground: kalau model `kind:"image"`, POST ke images endpoint, render `<img>` inline

### Filters (enowx-inspired + 9router provider scoping)
- Table `content_filters` migration + Drizzle
- Engine [src/lib/filters.ts](src/lib/filters.ts) — compile once cached, apply ke canonical messages, hot-reload via `invalidateFilters()`
- Regex atau literal (auto-escape), sort order, is_active toggle
- Provider scoping `providerScope: string[] | null` — null=global, `[]` auto-normalize ke null
- Management API `/api/filters` (GET/POST/PATCH/DELETE) dengan regex validation
- Dashboard page `/filters` dengan inline scope edit popover (klik badge → checkbox list)
- Hook di api/index.ts sebelum RTK compression

### Request logs observability (etteum-style + 9router-style)
- Kolom layout: Time · User · Model · Status · In · Cached · Out · TTFT · Latency · Credit
- Model tanpa prefix `provider/`, User dari `accountLabel`
- Cache: `cachedTokens` (aggregate) + `cacheWriteTokens` (breakdown Read/Write)
  - Fix 1: convention discriminator (`readUsage` di oaistream) — fold remove-style ke 0penAI-style biar `inputTokens` konsisten inklusif cache
- TTFT: capture wall-clock dari fetch resolve → first content/reasoning delta
- Reasoning tokens: split dari completion (`reasoning_tokens` di raw usage)
- USD dollar cost: [src/lib/pricing.ts](src/lib/pricing.ts) retail pricing table (25+ model), pattern fallback (`claude-*`, `gpt-*`, dst). Compute cost sesuai tier (input/cached/cache_creation/reasoning/output)
- Drawer: 8-kotak stat grid (In · Cache Read · Cache Write · Out · Reasoning · TTFT · Latency · Credit · USD)

### Provider cards (Accounts page)
- Tombol Retry per-card (refresh credit semua akun 1 provider)
- Tombol Warmup per-card (`warmAll` scope provider itu)
- Kolom `#` diganti row number 1-N (bukan DB id) — biar nggak lompat setelah delete. DB id tetap di tooltip.
- Delete pakai `<Dialog>` (bukan `confirm()` native yang di-block di preview browser)

### Migration files added
- 0006 content_filters
- 0007 content_filters.provider_scope
- 0008 request_logs.cached_tokens + ttft_ms
- 0009 request_logs.cache_write_tokens
- 0010 request_logs.reasoning_tokens
- 0011 request_logs.dollar_cost

## Apa ini

AI gateway personal — proxy OpenAI/Anthropic-compatible dengan account pool,
format translation, dan token saver. **Single-user, local-first, dipakai sendiri.**

- **Nama**: Gacor-Router
- **Arah**: B — Bun + TypeScript + Hono + Drizzle + SQLite (bukan Go)
- **Dashboard**: React 19 + Vite + Tailwind v4 di `dashboard/`, diserve backend
  di port yang sama (7788). Tema: sky blue, brand "Gacor-Router", favicon petir.

## Status saat ini — kode semua jalan (credit yang habis)

- [x] Backend: Hono + Bun, port 7788, `/health`, `tsc --noEmit` clean
- [x] **242 test pass, 0 fail** (12 test files)
- [x] Provider: **CodeBuddy** lengkap (gzip body, CLI headers, JWT refresh,
  classify markers, peekError JSON-envelope sniff)
- [x] Pool: sticky/round-robin, skip tried, react → banned/exhausted
- [x] Proxy: build→fetch→sniff→classify→react→rotate, max 5 attempts
- [x] Routes: `/v1/chat/completions` (stream+non-stream), `/v1/models`,
  **`/v1/messages` (Anthropic, stream+non-stream) — VERIFIED LIVE**
- [x] Request logging: `request_logs` table, proxy tap, `credit_used` dari usage event
- [x] Management API `/api/*` + `/ws` live events (account_status, request_log)
- [x] Tunnel: `/api/tunnel/*` — Cloudflare quick tunnel, auto-download cloudflared
- [x] Credit tracking: `usage()` via Tencent billing meter, cached, refresh endpoint
- [x] Warmup: manual + auto-warmup scheduler + warm-on-add (enowx pattern)
- [x] **RTK token saver** — 12 filter, hook di canonical messages
  (lihat bagian khusus di bawah)
- [x] Debug: `/api/debug/process` (CPU self-sample, memory, event loop, build)
- [x] Chat playground: `chat_sessions` + `/api/chat/sessions` CRUD
- [x] Dashboard pages: Dashboard (TokenUsage card ala etteum), Accounts
  (provider cards → drill-down ala etteum/enowx, warmup, settings modal),
  Requests (live feed + drawer + credit), Models (full table ala etteum),
  Chat (SSE streaming, markdown, reasoning block), Tunnel, Settings

## Katalog CodeBuddy — 33 model, VERIFIED LIVE (29 chat + 3 image + 1 preview)

Sumber: tabel resmi workbuddy.ai + **probe live per model** (effort spectrum Y/N,
multi-run). Jangan ubah tanpa konfirmasi LO.

- **Spektrum effort verified** (label ada di `codebuddy.models.ts`):
  - `low→max (5 level)` — 15 model (fast/balanced, claude semua, deepseek-flash,
    hy3/hy4/hy4-f, gpt-6-astra, gpt-5.6-terra/luna, glm-5.3/5.2, kimi k3/k2.6/k2.5)
  - `low→xhigh` — primary-model, gpt-5.5, gpt-5.4, gpt-5.3-codex
    (max **konsisten** ditolak 11133, 2 runs)
  - `low→max (flaky 11134)` — gpt-5.6-sol (unstable di semua level)
- **Bukan thinking** (flag dihapus setelah probe): deepseek-v3-0324,
  gemini-3.5-flash, gemini-3.1-pro — nggak emit reasoning sama sekali
- **Metadata per model**: name, creditMultiplier (🆓 0x untuk hy3/hy4-f/deepseek-flash),
  thinking, thinkingToggle, effort, images, toolCalls, owner
- **Owner**: anthropic/openai/google/deepseek/zhipu/moonshot/minimax/tencent
- Model promo gratis (0x): hy3 (sd 30 Sep), hy4-preview-f (sd 10 Okt),
  deepseek-v4.1-flash (sd 25 Sep 2026)

## Arsitektur

```
client → api/index.ts (validate + resolveModel "provider/model")
       → convert/openai.toCanonical        (/v1/chat/completions)
         convert/anthropic.toCanonicalFromAnthropic  (/v1/messages)
       → rtk.compressMessages (kompres tool output, in-place)
       → proxy/proxyChat (loop: pool.pick → refresh? → buildRequest → fetch
                          → peekError → classify → react/rotate)
       → provider.parseStream
       → toSSE/toCompletion                (OpenAI out)
         toAnthropicSSE/toAnthropicMessage (Anthropic out)
       └→ logging tap → request_logs + WS event
```

- `src/convert/anthropic.ts` — converter Anthropic dua arah
- `src/rtk/` — token saver (constants, filters, detect, index)
- `src/lib/warmup.ts` — probe glm-5.2 "hi" → classify → status + credit refresh
- `src/lib/autowarm.ts` — scheduler (tick 1m, unref'd), config di settings,
  concurrency batching, last-warm persist
- `src/tunnel/` — cloudflared binary manager + quick tunnel state machine
- `dashboard/` — React SPA, lazy chunk untuk Chat (syntax highlighter 278KB)

## Converter Anthropic (`/v1/messages`) — spec-complete

Sengaja **bukan** port 1:1 dari 9router; 10 gap spec di sana sudah diperbaiki.
Riset asal ada di `9router/open-sse/translator/`.

**Invariant paling penting — aritmetika cache:**
Anthropic `input_tokens` **EKSKLUSIF** cache, OpenAI `prompt_tokens` **INKLUSIF**.
Jadi `input_tokens = prompt_tokens - cacheRead - cacheWrite`. Terbukti live:
prompt 182 → `input_tokens 54 + cache_read 128`. Jangan "sederhanakan" ini.

**Beda dari 9router (sengaja):**
- `input_json_delta` **di-stream per fragmen**, bukan dibuffer sampai finish
  (verified live: `{` / `"city": "Jakarta` / `"}`) — tool-arg UI progresif jalan
- `message_delta` sertakan `stop_sequence: null`
- `ping` diemit setelah `message_start`
- `tool_choice {type:"none"}` → `"none"` (di 9router salah jadi `"auto"`)
- `content_filter` → `refusal` (9router gepengkan jadi `end_turn`)
- non-stream pakai pengurangan cache yang sama dengan stream (9router inkonsisten)

**Keputusan desain:**
- Terminal event (`message_delta`/`message_stop`) nunggu stream **habis**, bukan
  pas `finish_reason` — usage sering datang di chunk setelah finish. Ada test-nya.
- Blok `thinking` di request **dibuang**: signature-nya Anthropic-specific,
  nggak valid dikirim ke CodeBuddy.
- `raw` dibangun ulang dalam bentuk **OpenAI**, bukan Anthropic — provider baca
  `raw` buat passthrough field, kalau dikasih body Anthropic `tool_choice` salah.
- `message_start.usage` nol: input count belum diketahui saat itu. Klien baca
  total dari `message_delta`.
- `top_k`/`metadata`/`thinking.budget_tokens` didrop (nggak ada padanan OpenAI).

## Cara jalanin

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun WAJIB (nggak di PATH non-login)
cd /Users/rivanalbaniray/Documents/github/gacor-router
bun run dev          # watch mode, :7788
bun run typecheck    # tsc --noEmit
bun test             # 193 tests
bun run db:generate  # setelah edit src/db/schema.ts
bun run db:migrate

# Dashboard
cd dashboard && bun install   # sekali
bun run build                 # → dist (diserve :7788)
bun run dev                   # :5173 proxy → :7788
```

- Port: **7788** (env `PORT`), host `127.0.0.1`
- DB: `./gacor.db` (bun:sqlite, WAL) — env `DB_PATH`
- Migrations: 0000 (accounts+settings) s/d 0005 (request_logs.source)

## Gotchas (penting!)

1. **bun di PATH**: `export PATH="$HOME/.bun/bin:$PATH"` dulu selalu.
2. **drizzle `mode: "timestamp"` simpan unix DETIK bukan ms** — query range
   request_logs pakai detik (`created_at >= nowSec - N*3600`).
3. **bun test TIDAK isolasi module cache per file** — semua test yang sentuh
   `src/db` HARUS dalam SATU file (`test/api.test.ts`). Fetch stub di-share.
4. **better-sqlite3** cuma buat drizzle-kit CLI; runtime pakai `bun:sqlite`.
5. **9router jalan di 20127/20128** — jangan bentrok. gacor 7788 aman.
6. CodeBuddy upstream: system prompt WAJIB (11128), nggak boleh kosong (11133),
   body gzip, `default-model-lite` dkk retired (11102) — katalog sudah dipruning.
7. **KATALOG: jangan hapus/ubah tanpa konfirmasi LO.** Data effort = hasil
   probe live multi-run, bukan asumsi tabel.
8. **RTK mutasi `req.messages` IN-PLACE.** Jalan sebelum proxy, jadi
   `request_logs.requestBody` (dari `r.body`, body klien asli) nyimpen versi
   NGGAK terkompres — sengaja, biar drawer UI nampilin yang user kirim.
9. **Payload gede (~45KB+) bisa kena 502 HTML dari upstream**, bukan JSON
   envelope. Kalau lagi debug 502 dengan body gede, curigai batas ukuran dulu.

## RTK token saver (`src/rtk/`)

Port dari `9router/open-sse/rtk/`. Kompres output tool sebelum dikirim ke
upstream — `git diff`, `grep`, `ls`, build log itu bagian paling gemuk dan
paling redundan di percakapan agentic.

**Hook di canonical messages, bukan wire body.** Ini beda arsitektur yang
penting: 9router jalan SETELAH translasi format, jadi butuh 6 cabang bentuk
pesan (OpenAI tool, OpenAI array, Claude tool_result, Responses, Kiro, dst).
Kita cuma butuh 1 — `role === "tool"` — dan `/v1/messages` dapat gratis.

**12 filter** (README 9router cuma sebut 10; `git-log` + `build-output`
nggak terdokumentasi di sana tapi hidup):
git-diff, git-status, git-log, build-output, grep, find, ls, tree,
search-list, dedup-log, smart-truncate, read-numbered.

**4 lapis pengaman** — ini yang bikin filter agresif aman:
1. filter yang throw / return non-string diabaikan
2. hasil kosong ATAU nggak lebih kecil → buang, pakai teks asli (`>=`, bukan `>`)
3. tool call gagal nggak disentuh (error trace harus utuh)
4. di bawah 500 char / di atas 10MB dilewati

**Bug 9router yang diperbaiki:**
- Gate ukuran di 9router pakai line count dari HEAD 1KB → butuh baris rata-rata
  <4 char, jadi `read-numbered` + `smart-truncate` praktis **dead code**.
  Di sini gate pakai line count teks penuh; dua-duanya beneran jalan.
- `tree` di 9router pakai substring `director`+`file` → path `directory/file.ts`
  ikut kemakan. Di sini regex di-anchor.
- `git-status` 9router buang path tanpa marker di bawah `Untracked files:`
  → repo fresh undercount. Di sini section header dilacak.
- `*.egg-info` di 9router masuk array exact-match (`.includes`) jadi glob-nya
  nggak pernah match. Di sini pisah jadi suffix test.

**Kontrol:** setting `rtk_enabled` (default ON, set `"false"` buat matikan)
+ header `X-Token-Saver: off` buat bypass per-request.

**Hasil verified (wire level, body yang beneran dikirim):**
- build log sintetis: 24.998 → 605 char (**97,6%**)
- git diff nyata dari repo ini: 47.840 → 16.610 char (**65,3%**),
  semua baris +/- utuh, cuma preamble `index`/`---`/`+++` yang dibuang

## Konvensi kerja (kesepakatan sama LO)

- **Pelan-pelan**, satu langkah per konfirmasi
- **Konfirmasi dulu sebelum implementasi apa pun** — termasuk hapus/ubah
  katalog, model, data. Jangan pernah hapus sendiri.
- Bahasa: Indonesian santai
- Testing live: akun real `cb-global-1` di DB

## ⚠️ CREDIT HABIS (2026-09-15)

`cb-global-1` sekarang **0/100** (Free Plan Subscription, monthly).
Upstream balas `429` + `{"code":14018,"msg":"Credits exhausted"}` → pool
menandai akun `exhausted`, request berikutnya 503 tanpa fetch.

- Model 0x (hy3/hy4-f/deepseek-flash) **tetap butuh saldo non-nol** —
  multiplier 0 bukan berarti bypass meter. Jangan asumsikan bisa test gratis.
- Recover: `POST /api/accounts/1/status {"status":"active"}` cuma reset flag,
  bukan saldo. Perlu credit beneran / nunggu cycle reset.
- Efeknya: verifikasi live end-to-end nggak bisa sampai credit ada lagi.
  RTK diverifikasi di **wire level** (stub fetch + inspeksi body gzip)
  sebagai gantinya — lihat bagian RTK.

## Findings sesi audit auth (2026-09-15)

Sesi audit jalur auth CodeBuddy dipicu pertanyaan LO: "kalau add akun cuma
kasih refresh_token doang, jalan nggak?" — kode diverifikasi via test terisolasi,
bukan asumsi baca. Semua ini **belum diperbaiki**, tunggu konfirmasi LO.

### Bug 1: RT-only account nggak pernah exchange

Kalau lo add akun cuma isi `creds.refresh_token` (tanpa `access_token`,
`api_key`, `secret`), `refresh()` di `providers/codebuddy.ts:298-302` **tidak
pernah** manggil upstream. Test bukti:

```
refresh dipanggil ke upstream?  TIDAK
creds sesudah refresh:          {"refresh_token":"rt-GW"}
Authorization yang dikirim:     "Bearer "     ← kosong
```

Alurnya:
1. Gate pertama `if (!rt) return acc` — lolos, RT ada
2. `bearerFor(acc)` (line 178) baca `access_token || api_key || secret` → string kosong
3. Gate kedua `if (!jwtExpiringSoon(""))` → `jwtExpiringSoon("")` split "" → 1 part
   (bukan 3) → di line 480 langsung `return false` ("opaque token, let it ride")
4. `refresh()` return `acc` tanpa exchange
5. Request dikirim dengan `Authorization: Bearer ` kosong → 401

Yang bikin makin nyebelin: `classify()` (line 288) klasifikasi 401 sebagai
`transient`, jadi akun **nggak** ditandai dead dan pool nggak rotate. User
cuma dapat error berulang tanpa petunjuk.

**Fix rencana**: satu baris di `refresh()`, sebelum gate `jwtExpiringSoon`:
```ts
const bearer = bearerFor(acc);
if (bearer && !jwtExpiringSoon(bearer)) return acc;
// kalau bearer kosong tapi RT ada → langsung exchange
```
Plus test `RT-only account` di `test/refresh.test.ts`. Pertimbangkan juga:
kalau 401 datang padahal bearer kosong sejak awal, mungkin sebaiknya `dead`
bukan `transient` — tapi ini nyentuh `classify()` yang lolos 239 test.

### Bug 2: `warmup.ts` refresh tapi nggak persist creds

`src/lib/warmup.ts:63-66`:
```ts
if (provider.refresh) {
  const refreshed = await provider.refresh(acc);
  if (refreshed) acc = refreshed;   // acc variabel lokal, langsung dibuang
}
```

Bandingkan `src/proxy/index.ts:104-113` yang bener — pakai `pool.persistCreds`.
Import di `warmup.ts` cuma `getAccount, setAccountStatus, listAccounts` —
`updateCreds` nggak ada.

Konsekuensi tergantung open-question di bawah:
- Kalau RT lama tetap valid setelah rotasi → cuma boros satu RT per warmup
- Kalau RT sekali pakai (revoke-on-use di Keycloak realm) → akun bisa mati:
  warmup exchange sukses, tapi `RT_baru` dibuang; request berikutnya coba
  `RT_lama` yang udah kebakar → `refresh()` return `null` → akun **banned**

`warmup.ts` belum punya test file sendiri, cuma kesentuh via `api.test.ts`.

### Open question: apakah RT bisa dipakai berulang?

Tipe token lo `typ: "Offline"` dari Keycloak (`iss` = `workbuddy.ai/auth/realms/copilot`),
exp = 1 tahun. Offline token secara desain memang reusable — tapi realm bisa
di-config "Revoke Refresh Token" untuk paksa sekali pakai. Config realm nggak
kelihatan dari sini.

Bukti circumstantial pro-reusable:
- `9router/daily_reward.py` — "1 conversation CLI **per refresh token**",
  baca daftar RT dari file, jalan paralel 5 worker, auto-retry manggil refresh
  **pakai RT yang sama**. Kalau sekali pakai, logika retry itu rusak by design.
- Dua codebase (kita + 9router) fallback ke RT lama kalau upstream nggak
  ngasih baru: `refresh_token: data.data?.refreshToken?.trim() || rt`
- Kredensial `cb-global-1` sekarang **belum pernah** kena jalur refresh
  (access token masih 351 hari lagi, iat = kemarin), jadi RT-nya utuh virgin

Bukti kontra:
- Komentar kode kita sendiri: *"The upstream rotates the refresh token on
  every exchange"* (line 296). Konsisten dengan bukti pro (upstream memang
  ngasih baru), tapi nggak menjawab apakah lama dimatikan.

**Cara nge-tes aman** (belum dijalanin, tunggu konfirmasi LO):
Script standalone yang **selalu tulis balik pasangan terbaru ke DB** sebelum
apa-apa lagi. Panggil refresh pakai RT lama → simpan → panggil lagi pakai RT
lama yang sama → cek response. Kalau kedua diterima = reusable. Kalau ditolak
= sekali pakai. Dua-duanya menjawab tanpa risiko rusakin akun. Endpoint
`/v2/plugin/auth/token/refresh` adalah auth, **bukan** inference → nggak
lewat meter Tencent, jadi credit-exhausted nggak menghalangi test ini.

### Catatan tambahan

- **Kredensial `cb-global-1` sehat, cuma credit habis**: access_token dan
  refresh_token exp = 2027-09-02 (351 hari), iat = 2026-09-14. `sub` &
  `sid` di dua-duanya identik → jangan taruh RT yang sama sebagai akun
  kedua di pool — di mata upstream itu satu identitas, kuota tetap 100/bulan,
  dan kalau ternyata RT sekali pakai dua akun bisa saling makan.
- **Status DB sekarang `active`** (bukan `exhausted` seperti dicatat sesi
  sebelumnya) — kemungkinan sempat di-reset manual via API. Tapi saldo 0,
  jadi request pertama ke inference tetap bakal kena 429 → balik `exhausted`.

## Belum ada / next (tanyakan dulu sebelum gas)

**Urgent (hasil audit sesi ini):**
- [ ] **Tes aman RT-reusable** — script yang selalu persist ke DB sebelum
      call ulang; nggak butuh credit, nggak butuh ubah kode. Hasilnya nentuin
      prioritas dua item di bawah.
- [ ] **Fix Bug 1** — gate di `refresh()` biar RT-only account beneran exchange
- [ ] **Fix Bug 2** — `warmup.ts` persist creds hasil refresh + test khusus

**Non-urgent (dari sesi sebelumnya):**
- [ ] Provider tambahan selain CodeBuddy
- [ ] Dashboard: toggle RTK + statistik penghematan
- [ ] Dashboard belum punya indikator traffic Anthropic vs OpenAI
- [ ] RTK: `is_error` nggak ada di CanonicalMessage, jadi tool call gagal
      belum bisa di-skip (lapis 3 pengaman kurang presisi vs 9router)

## Referensi material (path lokal)

- **9router**: `/Users/rivanalbaniray/Documents/github/9router/`
  (executor codebuddy, RTK, translator, accountFallback)
- **enowx zip**: `9router/enowx-main.zip`, extract di `/tmp/enowx-study/`
  (provider.go interface, pool.go, proxy.go peekJSONError, warmup)
- **etteum-pool**: clone di `/tmp/etteum-study/` (dashboard React+Vite+Tailwind
  ala referensi UI: provider cards, drill-down, TokenUsage, Models table)
- **MCP** (dua-duanya sinkron di commit `bc7dd5b` per akhir sesi ini):
  - `codebase-memory` → project `gacor-router`, ~1168 nodes / ~2528 edges.
    Re-index: `index_repository(repo_path, name="gacor-router", mode="moderate")`
    — **WAJIB kasih `name`**, kalau nggak dia bikin project baru dari path
    (`Users-rivanalbaniray-Documents-...`) dan jadi duplikat.
  - `enowx-rag` → project `gacor-router`, ~423 chunk. Re-index incremental:
    `rag_index_project(project_id="gacor-router", directory=<repo>)`.
- **/tmp itu fana**: `/tmp/enowx-study/` + `/tmp/etteum-study/` bisa kehapus
  pas reboot. Extract ulang dari zip kalau perlu.

