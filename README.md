# Gacor-Router

Personal AI gateway — an OpenAI/Anthropic-compatible proxy with an account
pool, format translation, and a token saver. Single-user, local-first.

Bun + TypeScript + Hono + Drizzle + SQLite, with a React dashboard served from
the same port.

## Quick start

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun is not on a non-login shell's PATH

bun install
bun run db:migrate
bun run dev                          # http://127.0.0.1:7788

cd dashboard && bun install && bun run build   # UI, served at the same port
```

| Command | What it does |
| --- | --- |
| `bun run dev` | Watch mode on `:7788` |
| `bun run start` | Run without watch |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Test suite |
| `bun run db:generate` | Regenerate migrations after editing `src/db/schema.ts` |
| `bun run db:migrate` | Apply migrations |
| `bun run db:studio` | Drizzle GUI |

Config via env: `PORT` (7788), `HOST` (127.0.0.1), `DB_PATH` (`./gacor.db`).

## Endpoints

**Inference**

- `POST /v1/chat/completions` — OpenAI-compatible, streaming and non-streaming
- `GET /v1/models` — catalogue with token limits and feature flags
- `POST /v1/messages` — Anthropic-compatible, streaming and non-streaming

Models are addressed as `provider/model` (e.g. `codebuddy/claude-opus-5`).
An unprefixed name falls back to the `default_provider` setting.

Send `X-Token-Saver: off` to bypass the token saver for one request.

**Management** (`/api/*`, consumed by the dashboard)

- Accounts CRUD, credential reveal, status override
- Warmup — manual, warm-on-add, and a background scheduler
- Credit/quota snapshots from the provider's billing API
- Request logs, dashboard stats, per-model usage
- Settings KV, Cloudflare quick tunnel, chat-playground sessions
- `GET /ws` — live event feed (account status, request logs)

## How a request flows

```
client → api/index.ts          validate + resolve "provider/model"
       → convert/               to canonical (OpenAI or Anthropic in)
       → rtk/                   compress tool output
       → proxy/proxyChat        pool.pick → refresh → build → fetch
                                → peekError → classify → react → rotate
       → provider.parseStream   → render (OpenAI or Anthropic out) → client
       └→ logging tap           → request_logs + WS event
```

The proxy retries on account-level failures (dead credential, spent quota) by
rotating to the next account, up to 5 attempts. Transient failures (5xx, a
rate limit scoped to one model) return to the caller instead — rotating
wouldn't help and the account is still good.

Both wire formats converge on one canonical request shape, so the pool, proxy,
token saver, and request logging are written once and serve both.

## Token saver

Tool output — `git diff`, `grep`, `ls`, build logs — is the bulkiest and most
redundant part of an agentic conversation. RTK detects the shape and rewrites
it densely before the request leaves: a real diff from this repo went from
47,840 to 16,610 characters on the wire, with every changed line intact.

Twelve filters (`git-diff`, `git-status`, `git-log`, `build-output`, `grep`,
`find`, `ls`, `tree`, `search-list`, `dedup-log`, `smart-truncate`,
`read-numbered`) are chosen by sniffing the first 1KB. Compression is discarded
unless the result is both non-empty and smaller than the input, so a filter
that misreads its input costs CPU and nothing else.

On by default. Set the `rtk_enabled` setting to `false` to disable it globally,
or send `X-Token-Saver: off` per request.

## Layout

```
src/
├── api/         /v1 routes + /api management
├── providers/   Provider interface, registry, CodeBuddy, SSE parser
├── proxy/       the request loop
├── pool/        account selection (sticky / round-robin)
├── convert/     OpenAI and Anthropic wire formats ⇄ canonical
├── rtk/         token saver (filters, detection)
├── db/          Drizzle schema + queries
├── lib/         warmup, autowarm, logging, usage, events, debug
└── tunnel/      cloudflared binary manager + quick tunnel
dashboard/       React 19 + Vite + Tailwind v4
drizzle/         migrations
```

## Providers

**CodeBuddy** — 29 models. OpenAI on the wire, with a gzipped body,
CLI-identifying headers, JWT refresh, and credit metering via Tencent's
billing API. The catalogue in `src/providers/codebuddy.models.ts` is verified
against live probes; don't edit it from the published table alone.

## Status

Working: the proxy loop, account pool, CodeBuddy provider, both wire formats,
the token saver, request logging, management API, live events, warmup, credit
tracking, tunnel, and the full dashboard.

Not built yet: providers beyond CodeBuddy, and a dashboard surface for the
token saver.

See `NOTES.md` for working notes, gotchas, and the catalogue's provenance.
