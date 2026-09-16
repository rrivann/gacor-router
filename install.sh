#!/usr/bin/env bash
# Gacor Router installer. One-liner for VPS deploy.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/rrivann/gacor-router/main/install.sh | bash
#
# Flags (pass with `-s --`):
#   --prefix DIR         install location (default: ~/.gacor-router)
#   --version vX.Y.Z     pin a specific release (default: latest)
#   --no-systemd         skip systemd unit setup (print manual instructions)
#   --port PORT          override PORT (default: 7788)
#
# Example: install v0.2.0 into /opt without systemd:
#   curl -fsSL .../install.sh | bash -s -- --prefix /opt/gacor --version v0.2.0 --no-systemd
#
# The installer is idempotent — re-running it upgrades in place while
# preserving ~/.gacor-router/gacor.db and ~/.gacor-router/.env.

set -euo pipefail

REPO="rrivann/gacor-router"
DEFAULT_PREFIX="${HOME}/.gacor-router"
PREFIX="${DEFAULT_PREFIX}"
VERSION=""
USE_SYSTEMD=1
PORT_OVERRIDE=""

# ── Parse flags ────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)     PREFIX="$2"; shift 2 ;;
    --version)    VERSION="$2"; shift 2 ;;
    --no-systemd) USE_SYSTEMD=0; shift ;;
    --port)       PORT_OVERRIDE="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────
info()  { printf "\033[36m[i]\033[0m %s\n" "$*"; }
ok()    { printf "\033[32m[✓]\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m[!]\033[0m %s\n" "$*" >&2; }
die()   { printf "\033[31m[x]\033[0m %s\n" "$*" >&2; exit 1; }
need()  { command -v "$1" >/dev/null 2>&1 || die "missing prerequisite: $1"; }

# ── Prereqs ────────────────────────────────────────────────────────
info "checking prerequisites…"
need curl
need tar
# Detect OS + arch
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "$UNAME_S" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)      die "unsupported OS: $UNAME_S (Linux/Darwin only)" ;;
esac
case "$UNAME_M" in
  x86_64|amd64)  ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)             die "unsupported arch: $UNAME_M (amd64/arm64 only)" ;;
esac
ok "detected $OS/$ARCH"

# ── Install Bun if missing ─────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  ok "bun already installed ($(bun --version))"
else
  info "installing Bun runtime (from bun.sh/install)…"
  curl -fsSL https://bun.sh/install | bash
  # bun.sh script drops the binary at ~/.bun/bin/bun; add to PATH for the
  # remainder of this script.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "bun install failed — check ~/.bun/bin"
  ok "installed bun $(bun --version)"
fi
BUN_PATH="$(command -v bun)"

# ── Resolve version ────────────────────────────────────────────────
if [ -z "$VERSION" ]; then
  info "fetching latest release tag…"
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | \
    grep -oE '"tag_name":\s*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  [ -n "$VERSION" ] || die "could not resolve latest release — pass --version vX.Y.Z"
  ok "latest release: $VERSION"
fi

TARBALL="gacor-router-${VERSION}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"

# ── Backup existing data ───────────────────────────────────────────
if [ -d "$PREFIX" ]; then
  info "existing install found at $PREFIX — upgrading in place"
  BACKUP_DIR="$(mktemp -d)"
  # Preserve DB + env before we extract the new tarball over them.
  [ -f "$PREFIX/gacor.db" ] && cp -a "$PREFIX/gacor.db"* "$BACKUP_DIR/" 2>/dev/null || true
  [ -f "$PREFIX/.env" ]     && cp -a "$PREFIX/.env" "$BACKUP_DIR/.env"
  [ -d "$PREFIX/videos" ]   && cp -a "$PREFIX/videos" "$BACKUP_DIR/" 2>/dev/null || true
  ok "backed up gacor.db + .env + videos/ to $BACKUP_DIR"
else
  mkdir -p "$PREFIX"
  BACKUP_DIR=""
fi

# ── Download + extract ─────────────────────────────────────────────
info "downloading $TARBALL…"
TMP_TAR="$(mktemp)"
if ! curl -fSL --progress-bar -o "$TMP_TAR" "$URL"; then
  die "download failed — check $URL exists"
fi

info "extracting into $PREFIX…"
tar xzf "$TMP_TAR" -C "$PREFIX"
rm -f "$TMP_TAR"
ok "extracted"

# ── Restore backed-up data ─────────────────────────────────────────
if [ -n "$BACKUP_DIR" ]; then
  cp -a "$BACKUP_DIR/gacor.db"* "$PREFIX/" 2>/dev/null || true
  [ -f "$BACKUP_DIR/.env" ]   && cp -a "$BACKUP_DIR/.env" "$PREFIX/.env"
  [ -d "$BACKUP_DIR/videos" ] && cp -a "$BACKUP_DIR/videos" "$PREFIX/" 2>/dev/null || true
  ok "restored gacor.db + .env + videos/"
  rm -rf "$BACKUP_DIR"
fi

# ── Seed .env if missing ───────────────────────────────────────────
if [ ! -f "$PREFIX/.env" ] && [ -f "$PREFIX/.env.example" ]; then
  cp "$PREFIX/.env.example" "$PREFIX/.env"
  ok "seeded $PREFIX/.env from .env.example"
fi
if [ -n "$PORT_OVERRIDE" ]; then
  # Rewrite the PORT= line (or append if missing) — sed portable across GNU/BSD.
  if grep -q "^PORT=" "$PREFIX/.env"; then
    sed -i.bak "s|^PORT=.*|PORT=${PORT_OVERRIDE}|" "$PREFIX/.env" && rm -f "$PREFIX/.env.bak"
  else
    echo "PORT=${PORT_OVERRIDE}" >>"$PREFIX/.env"
  fi
  ok "set PORT=${PORT_OVERRIDE}"
fi

# ── Install deps + apply migrations ────────────────────────────────
# Some VPS providers (notably Tencent Cloud) preconfigure a private npm
# mirror (mirrors.tencentyun.com) via /etc/npmrc or a global bunfig that
# returns 404 for packages like drizzle-kit. Try the default registry first;
# on failure, retry once against the npmmirror.com public China mirror
# which serves the full npm catalogue.
run_bun_install() {
  local registry_flag="$1"
  if [ -n "$registry_flag" ]; then
    (cd "$PREFIX" && BUN_CONFIG_REGISTRY="$registry_flag" bun install --production)
  else
    (cd "$PREFIX" && bun install --production)
  fi
}

info "installing dependencies (this can take a minute)…"
if ! run_bun_install ""; then
  warn "default registry failed — retrying with https://registry.npmmirror.com"
  # Nuke any partial install so bun re-resolves cleanly against the new registry.
  rm -rf "$PREFIX/node_modules" "$PREFIX/bun.lock" 2>/dev/null || true
  if ! run_bun_install "https://registry.npmmirror.com"; then
    die "dependency install failed against both registries — check network + npm proxy config"
  fi
  ok "dependencies installed (via npmmirror.com fallback)"
else
  ok "dependencies installed"
fi

info "applying database migrations…"
(cd "$PREFIX" && bun run db:migrate)
ok "database ready at $PREFIX/gacor.db"

# ── Systemd setup ──────────────────────────────────────────────────
setup_systemd() {
  local unit_src="$PREFIX/systemd/gacor-router.service"
  local unit_dest="/etc/systemd/system/gacor-router.service"
  local install_user="${SUDO_USER:-$(whoami)}"

  [ -f "$unit_src" ] || { warn "systemd template missing at $unit_src — skipping"; return; }

  # Substitute placeholders. Use awk instead of sed to sidestep escaping in
  # paths that contain slashes.
  awk -v user="$install_user" -v dir="$PREFIX" -v bun="$BUN_PATH" '
    { gsub(/%INSTALL_USER%/, user); gsub(/%INSTALL_DIR%/, dir); gsub(/%BUN_PATH%/, bun); print }
  ' "$unit_src" | sudo tee "$unit_dest" >/dev/null

  sudo systemctl daemon-reload
  sudo systemctl enable --now gacor-router
  ok "systemd unit installed and started"
}

if [ "$USE_SYSTEMD" = 1 ] && command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  info "setting up systemd unit (requires sudo)…"
  if ! setup_systemd; then
    warn "systemd setup failed — the app is installed but not running as a service"
    warn "start it manually: cd $PREFIX && bun run start"
  fi
else
  if [ "$USE_SYSTEMD" = 1 ]; then
    warn "systemctl not available — skipping service setup"
  fi
  info "start manually:"
  info "  cd $PREFIX && bun run start"
fi

# ── Done ───────────────────────────────────────────────────────────
PORT_FROM_ENV="$(grep -oE '^PORT=[0-9]+' "$PREFIX/.env" 2>/dev/null | cut -d= -f2)"
PORT_FROM_ENV="${PORT_FROM_ENV:-7788}"
cat <<EOF

$(printf '\033[32m✓ Gacor Router %s installed\033[0m' "$VERSION")

  Install dir: $PREFIX
  Data (DB):   $PREFIX/gacor.db
  Config:      $PREFIX/.env
  Dashboard:   http://127.0.0.1:${PORT_FROM_ENV}

$(if [ "$USE_SYSTEMD" = 1 ] && command -v systemctl >/dev/null 2>&1; then
cat <<'INNER'
  Systemd commands:
    systemctl status gacor-router      # check status
    journalctl -u gacor-router -f      # follow logs
    systemctl restart gacor-router     # after config change
INNER
fi)

  Expose publicly (do this AFTER creating an API key at /api-keys):
    sed -i 's/^HOST=.*/HOST=0.0.0.0/' $PREFIX/.env
    systemctl restart gacor-router     # or restart manually

  Upgrade:
    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash

EOF
