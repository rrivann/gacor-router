# Gacor Router

Personal AI gateway. 0penAI + remove-compatible proxy that rotates a pool of
provider accounts (CodeBuddy today; more upstreams welcome) with a local
dashboard for accounts, usage, video jobs, and API keys.

- Chat: `POST /v1/chat/completions`, `POST /v1/messages`
- Images: `POST /v1/images/generations`
- Video (async): `POST /v1/videos/generations` + `GET /v1/videos/:id`
- Model catalogue: `GET /v1/models`
- Dashboard: http://127.0.0.1:7788

Runs on [Bun](https://bun.sh) 1.3+ and SQLite. Single-user, local-first — the
DB lives in one file, the dashboard is served from the same port.

---

## Install (VPS, 1-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/rrivann/gacor-router/main/install.sh | bash
```

The installer installs Bun (if missing), grabs the latest release tarball,
runs migrations, and — if `systemctl` is available — writes a systemd unit
and starts it. Loopback-only by default.

Flags (pass with `-s --`):

```bash
curl -fsSL .../install.sh | bash -s -- --prefix /opt/gacor --version v0.2.0 --no-systemd
```

- `--prefix DIR` — install location (default `~/.gacor-router`)
- `--version vX.Y.Z` — pin a release (default: latest)
- `--no-systemd` — skip service setup
- `--port PORT` — override PORT (default 7788)

Re-run the same command to upgrade — `gacor.db`, `.env`, and downloaded
videos are preserved across upgrades.

## Systemd

```bash
systemctl status gacor-router
journalctl -u gacor-router -f          # follow logs
systemctl restart gacor-router          # after editing .env
```

## Exposing to the internet

The default `HOST=127.0.0.1` binds loopback only — safe out of the box.
**Before** flipping to `0.0.0.0`:

1. SSH-tunnel to the dashboard from your laptop:
   ```bash
   ssh -L 7788:localhost:7788 user@vps
   ```
2. Open http://127.0.0.1:7788/api-keys and create at least one API key
   (format `gcr-<48 hex>`). Copy it — the dashboard will keep showing it,
   but treat it like a password.
3. Edit `~/.gacor-router/.env`:
   ```env
   HOST=0.0.0.0
   PORT=7788
   ```
4. Restart: `systemctl restart gacor-router`.

Once at least one key exists, `/v1/*` requires it. Loopback bypass stays
enabled so the dashboard keeps working locally. See the API Keys page for
per-key token quotas, expiry, concurrency limits, and model/provider scope.

## Local development

```bash
git clone https://github.com/rrivann/gacor-router.git
cd gacor-router
bun install
bun run db:migrate
bun run dev                             # backend on :7788, hot reload
cd dashboard && bun run dev             # dashboard on :5173, proxies /api + /ws
```

Run the tests:

```bash
bun test
```

## Uninstall

```bash
systemctl stop gacor-router
sudo rm /etc/systemd/system/gacor-router.service
sudo systemctl daemon-reload
rm -rf ~/.gacor-router                  # deletes accounts, keys, request logs, videos
```

## License

MIT — see [LICENSE](LICENSE).
