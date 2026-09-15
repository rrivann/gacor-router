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
- `POST /v1/messages` — Anthropic-compatible (not converted yet, returns 501)

Models are addressed as `provider/model` (e.g. `codebuddy/claude-opus-5`).
An unprefixed name falls back to the `default_provider` setting.

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
       → convert/openai        toCanonical
       → proxy/proxyChat       pool.pick → refresh → build → fetch
                               → peekError → classify → react → rotate
       → provider.parseStream  → toSSE / toCompletion → client
       └→ logging tap          → request_logs + WS event
```

The proxy retries on account-level failures (dead credential, spent quota) by
rotating to the next account, up to 5 attempts. Transient failures (5xx, a
rate limit scoped to one model) return to the caller instead — rotating
wouldn't help and the account is still good.

## Layout

```
src/
├── api/         /v1 routes + /api management
├── providers/   Provider interface, registry, CodeBuddy, SSE parser
├── proxy/       the request loop
├── pool/        account selection (sticky / round-robin)
├── convert/     OpenAI wire format ⇄ canonical
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

Working: the proxy loop, account pool, CodeBuddy provider, request logging,
management API, live events, warmup, credit tracking, tunnel, and the full
dashboard (Dashboard, Accounts, Requests, Models, Chat, Tunnel, Settings).

Not built yet: the Anthropic converter, providers beyond CodeBuddy, and the
RTK token saver.

See `NOTES.md` for working notes, gotchas, and the catalogue's provenance.
