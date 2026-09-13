# gacor-router — Catatan Lanjutan Proyek

> Dokumen ini untuk lanjut session baru. Baca ini dulu sebelum ngapa-ngapain.
> Terakhir update: 2026-09-13

## Apa ini

AI gateway personal — proxy OpenAI/Anthropic-compatible dengan account pool,
format translation, dan token saver. **Single-user, local-first, dipakai sendiri.**

- **Nama**: gacor-router
- **Arah**: B — Bun + TypeScript + Hono + Drizzle + SQLite (bukan Go)
- **Referensi desain**: 9Router (punya sendiri), enowX, etteum-pool
  (ketiganya sudah dipelajari mendalam; pola terbaik di-adopsi, detail di bawah)

## Status saat ini

Commit: `a3d72ce` — scaffold selesai & verified.

- [x] Folder + git init
- [x] package.json + deps (hono, drizzle-orm, drizzle-kit, typescript, @types/bun, better-sqlite3)
- [x] tsconfig strict + ESM
- [x] Skema DB awal: tabel `accounts` + `settings` (migration 0000, sudah applied)
- [x] Provider interface + registry (port dari enowX ke TS)
- [x] Pool (sticky/round-robin, skip tried accounts)
- [x] Entry Hono + `/health` — **verified jalan**: boot OK, `GET /health` → `{"ok":true,"name":"gacor-router"}`
- [x] `tsc --noEmit` PASS

Belum ada:
- [ ] Route `/v1/chat/completions`, `/v1/messages`, `/v1/models`
- [ ] Provider implementasi (CodeBuddy dulu)
- [ ] Converter format (OpenAI ↔ Anthropic ↔ canonical)
- [ ] Dashboard / management API
- [ ] RTK token saver (port dari 9Router)
- [ ] Streaming SSE

## Cara jalanin

```bash
# bun TIDAK di PATH shell non-login — pakai full path atau export dulu:
export PATH="$HOME/.bun/bin:$PATH"

cd /Users/rivanalbaniray/Documents/github/gacor-router
bun run dev          # watch mode, port 7788
bun run start        # tanpa watch
bun run typecheck    # tsc --noEmit
bun run db:generate  # drizzle-kit generate (setelah edit src/db/schema.ts)
bun run db:migrate   # apply migrations (butuh better-sqlite3 — sudah terpasang)
bun run db:studio    # GUI drizzle
```

- Port default: **7788** (env `PORT`), host `127.0.0.1`
- DB: `./gacor.db` (bun:sqlite, WAL) — env `DB_PATH`
- Env helper: `src/lib/env.ts`

## Gotchas (penting!)

1. **Bun di PATH**: `bun` cuma ada di `~/.bun/bin/bun` (versi 1.3.11). Shell
   non-login nggak punya di PATH → selalu `export PATH="$HOME/.bun/bin:$PATH"`
   dulu, atau pakai full path.
2. **better-sqlite3 build script** butuh `bun` di PATH saat install →
   export PATH dulu baru `bun add`. (devDep, khusus untuk drizzle-kit CLI
   yang nggak support `bun:sqlite`. Runtime app tetap pakai `bun:sqlite`.)
3. **bun:sqlite vs drizzle-kit**: drizzle-kit migrate/generate butuh
   better-sqlite3. Kalau error "Please install either 'better-sqlite3'..." →
   pastikan devDep terpasang.
4. **9router jalan di port 20127/20128** — jangan bentrok. gacor-router 7788 aman.

## Arsitektur (keputusan yang sudah diambil)

### Pattern dari enowX (yang di-adopsi)
- **Provider interface minimal**: `name() / caps() / buildRequest() / parseStream() / classify(status, body) → Outcome`.
  Outcome = `"ok" | "transient" | "exhausted" | "dead"` — drives pool reaction:
  dead → banned, exhausted → nunggu reset, transient → retry/rotate.
- **Pool `pick(provider, tried)`** — sticky by default, round-robin opsional
  (setting `pool_rotation:<provider>`), skip account yang sudah dicoba di
  request yang sama.
- **peekJSONError pattern** (belum diimplement, catat buat nanti): upstream
  kayak CodeBuddy kadang balikin HTTP 200 dengan body JSON error
  `{"code":11101,...}` alih-alih SSE. Peek byte pertama: kalau `{` → buffer &
  parse error; kalau `data:`/`event:` → biarin stream.
- **Account credentials**: `secret` single-token ATAU `creds` JSON multi-field
  (`{access_token, refresh_token, region, ...}`).

### Pattern dari 9Router (yang mau di-port)
- **RTK Token Saver** — 8 strategi (dedup-log, ls, git-status, grep, headroom,
  caveman, ponytail, pxpipe). Source: `9router/open-sse/rtk/`
- **Executor CodeBuddy** — gzip body, headers X-Stainless-*, X-Request-ID dll.
  Source: `9router/open-sse/executors/codebuddy.js`
  dan `9router/open-sse/providers/registry/codebuddy.js`
  (base URL `https://www.codebuddy.ai/v2/chat/completions`,
  CN variant `https://copilot.tencent.com`, X-Domain header per variant)
- **Translator registry** — source: `9router/open-sse/translator/`

### Yang SENGJAJA nggak diadopsi (personal use, keep it simple)
- Auto-signup ecosystem (SMS/captcha/mailer ala enowX) — over-engineered
- Cloud sync, community layer, marketplace
- MITM credential capture
- Plugin runtime

## Struktur folder saat ini

```
src/
├── index.ts            # entry — Hono + Bun.serve + /health
├── api/index.ts        # stub (nanti /v1/* routes)
├── providers/
│   ├── types.ts        # Provider, Account, Outcome, ChatRequest, StreamEvent
│   └── registry.ts     # registry sync-safe
├── pool/pool.ts        # Pool class
├── convert/index.ts    # stub (nanti format translation)
├── db/
│   ├── schema.ts       # accounts + settings (drizzle)
│   └── index.ts        # bun:sqlite client + WAL
└── lib/env.ts          # PORT/HOST/DB_PATH
drizzle/                # migrations (0000 applied)
```

## Next steps (urutan rencana, konfirmasi dulu sebelum gas)

1. **Route `/v1/*` + wire pool** — `POST /v1/chat/completions` yang baca
   account dari DB, lewat pool, return 501 (belum ada provider). Plus
   `GET /v1/models` dummy.
2. **Provider pertama: CodeBuddy** — port dari executor 9Router
   (gzip, headers, classify via peekJSONError).
3. **Converter** — OpenAI request → canonical ChatRequest; stream events →
   OpenAI SSE response. (Anthropic belakangan.)

## Referensi material (path lokal)

- **9router** (kode sumber utama untuk port): `/Users/rivanalbaniray/Documents/github/9router/`
  - Executor CodeBuddy: `open-sse/executors/codebuddy.js`
  - Registry CodeBuddy: `open-sse/providers/registry/codebuddy.js`
  - RTK: `open-sse/rtk/` (index, headroom, caveman, ponytail, pxpipe, systemInject)
  - Translator: `open-sse/translator/` (formats/openai.js, formats/claude.js, request/, response/)
  - Pool/fallback: `open-sse/services/accountFallback.js`
  - Catatan riset lengkap: `/Users/rivanalbaniray/Documents/github/9router/.workbuddy-ai/memory/2026-09-13.md`
- **enowx zip** (kalau mau baca ulang): `~/Downloads/enowx-main.zip`
  atau `9router/enowx-main.zip`. Extract sementara ada di `/tmp/enowx-study/`
  (TEMP — bisa kehapus pas reboot, extract ulang dari zip kalau perlu).
  - Yang worth baca: `core/provider/provider.go` (interface),
    `core/pool/pool.go`, `core/proxy/proxy.go` (peekJSONError di sini),
    `core/provider/codebuddy/provider.go`
- **etteum-pool**: repo publik `github.com/priyo000/etteum-pool` (Bun+Hono+Drizzle —
  referensi stack sama, tapi private build). Fitur khas: auto-warmup queue,
  BYOK multi-key, Playwright login bot.

## Konvensi kerja (kesepakatan sama user)

- **Pelan-pelan**, satu langkah per konfirmasi
- Konfirmasi dulu sebelum implementasi apa pun
- Bahasa: Indonesian santai
