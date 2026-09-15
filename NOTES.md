# gacor-router — Catatan Lanjutan Proyek

> Dokumen ini untuk lanjut session baru. Baca ini dulu sebelum ngapa-ngapain.
> Terakhir update: 2026-09-14 (sesi dashboard UI + warmup + katalog verified)

## Apa ini

AI gateway personal — proxy OpenAI/Anthropic-compatible dengan account pool,
format translation, dan token saver. **Single-user, local-first, dipakai sendiri.**

- **Nama**: Gacor-Router
- **Arah**: B — Bun + TypeScript + Hono + Drizzle + SQLite (bukan Go)
- **Dashboard**: React 19 + Vite + Tailwind v4 di `dashboard/`, diserve backend
  di port yang sama (7788). Tema: sky blue, brand "Gacor-Router", favicon petir.

## Status saat ini — SEMUA JALAN

- [x] Backend: Hono + Bun, port 7788, `/health`, `tsc --noEmit` clean
- [x] **150 test pass, 0 fail** (10 test files)
- [x] Provider: **CodeBuddy** lengkap (gzip body, CLI headers, JWT refresh,
  classify markers, peekError JSON-envelope sniff)
- [x] Pool: sticky/round-robin, skip tried, react → banned/exhausted
- [x] Proxy: build→fetch→sniff→classify→react→rotate, max 5 attempts
- [x] Routes: `/v1/chat/completions` (stream+non-stream), `/v1/models`, `/v1/messages` (501 stub)
- [x] Request logging: `request_logs` table, proxy tap, `credit_used` dari usage event
- [x] Management API `/api/*` + `/ws` live events (account_status, request_log)
- [x] Tunnel: `/api/tunnel/*` — Cloudflare quick tunnel, auto-download cloudflared
- [x] Credit tracking: `usage()` via Tencent billing meter, cached, refresh endpoint
- [x] Warmup: manual + auto-warmup scheduler + warm-on-add (enowx pattern)
- [x] Debug: `/api/debug/process` (CPU self-sample, memory, event loop, build)
- [x] Chat playground: `chat_sessions` + `/api/chat/sessions` CRUD
- [x] Dashboard pages: Dashboard (TokenUsage card ala etteum), Accounts
  (provider cards → drill-down ala etteum/enowx, warmup, settings modal),
  Requests (live feed + drawer + credit), Models (full table ala etteum),
  Chat (SSE streaming, markdown, reasoning block), Tunnel, Settings

## Katalog CodeBuddy — 29 model, VERIFIED LIVE

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
       → convert/openai.toCanonical
       → proxy/proxyChat (loop: pool.pick → refresh? → buildRequest → fetch
                          → peekError → classify → react/rotate)
       → provider.parseStream → toSSE/toCompletion → client
       └→ logging tap → request_logs + WS event
```

- `src/lib/warmup.ts` — probe glm-5.2 "hi" → classify → status + credit refresh
- `src/lib/autowarm.ts` — scheduler (tick 1m, unref'd), config di settings,
  concurrency batching, last-warm persist
- `src/tunnel/` — cloudflared binary manager + quick tunnel state machine
- `dashboard/` — React SPA, lazy chunk untuk Chat (syntax highlighter 278KB)

## Cara jalanin

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun WAJIB (nggak di PATH non-login)
cd /Users/rivanalbaniray/Documents/github/gacor-router
bun run dev          # watch mode, :7788
bun run typecheck    # tsc --noEmit
bun test             # 150 tests
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

## Konvensi kerja (kesepakatan sama LO)

- **Pelan-pelan**, satu langkah per konfirmasi
- **Konfirmasi dulu sebelum implementasi apa pun** — termasuk hapus/ubah
  katalog, model, data. Jangan pernah hapus sendiri.
- Bahasa: Indonesian santai
- Testing live: pakai akun real `cb-global-1` di DB (credit 500+/520)

## Belum ada / next (tanyakan dulu sebelum gas)

- [ ] Converter Anthropic (`/v1/messages` penuh)
- [ ] Provider tambahan selain CodeBuddy
- [ ] RTK token saver (port dari 9Router)

## Referensi material (path lokal)

- **9router**: `/Users/rivanalbaniray/Documents/github/9router/`
  (executor codebuddy, RTK, translator, accountFallback)
- **enowx zip**: `9router/enowx-main.zip`, extract di `/tmp/enowx-study/`
  (provider.go interface, pool.go, proxy.go peekJSONError, warmup)
- **etteum-pool**: clone di `/tmp/etteum-study/` (dashboard React+Vite+Tailwind
  ala referensi UI: provider cards, drill-down, TokenUsage, Models table)
- MCP: `gacor-router` ter-index di codebase-memory (1044 nodes) + enowx-rag
