#!/usr/bin/env bash
# Gacor Router uninstaller. One-liner counterpart to install.sh.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/rrivann/gacor-router/main/uninstall.sh | bash
#
# Flags (pass with `-s --`):
#   --prefix DIR    install location to remove (default: ~/.gacor-router)
#   --remove-bun    also remove the Bun runtime at ~/.bun
#   --yes           skip the confirmation prompt (non-interactive)
#
# Removes: the systemd unit, the install dir (gacor.db, .env, videos/),
# the cached cloudflared binary + tunnel state under ~/.gacor-router, and
# any stray gacor-router / cloudflared processes. Bun is kept by default
# since other projects may share it.
#
# DANGER: gacor.db holds every upstream account credential and API key.
# Deletion is permanent.

set -euo pipefail

REPO="rrivann/gacor-router"
DEFAULT_PREFIX="${HOME}/.gacor-router"
PREFIX="${DEFAULT_PREFIX}"
REMOVE_BUN=0
ASSUME_YES=0

# ── Parse flags ────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)     PREFIX="$2"; shift 2 ;;
    --remove-bun) REMOVE_BUN=1; shift ;;
    --yes)        ASSUME_YES=1; shift ;;
    -h|--help)
      # Print only the leading header block (the usage docs above), not
      # every # comment in the file — unlike install.sh's grep approach.
      awk 'NR==1 {next} /^set -/ {exit} /^#/ {sub(/^# ?/, ""); print}' "$0"
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

# rm -rf that escalates to sudo when file ownership demands it — installs
# done via `sudo bash install.sh --prefix /opt/…` leave root-owned files.
rm_rf() {
  rm -rf "$1" 2>/dev/null || sudo rm -rf "$1"
}

# Normalize to an absolute path without requiring the dir to exist.
# Lexically resolves "." / ".." segments and trailing slashes — `rm -rf`
# refuses paths like "/opt/gacor/." so leaving them unnormalized would
# fail silently mid-uninstall (POSIX rm protects "." and "..").
abs() {
  local p="$1" head rest
  case "$p" in
    /*) ;;
    *)  p="$PWD/$p" ;;
  esac
  while :; do
    case "$p" in
      /)     break ;;
      */)    p="${p%/}" ;;
      */.)   p="${p%/.}" ;;
      */..)  p="${p%/..}"
             head="$(dirname "$p")"
             [ -n "$head" ] && p="$head" || p="/"
             ;;
      *//*)  head="${p%%//*}"
             rest="${p#*//}"
             p="${head:+$head}/$rest"
             ;;
      *)     break ;;
    esac
  done
  printf '%s\n' "$p"
}

PREFIX="$(abs "$PREFIX")"
HOME_GACOR="$(abs "${HOME}/.gacor-router")"

# Refuse to nuke anything that is obviously not an install dir.
case "$PREFIX" in
  /|/home|/home/|/root|/usr|/etc|/opt|/var|"${HOME}"|"${HOME}/")
    die "refusing to operate on $PREFIX"
    ;;
esac

# ── Confirm ────────────────────────────────────────────────────────
# gacor.db holds account credentials and API keys; make the operator say
# "yes" on a terminal before anything is deleted.
if [ "$ASSUME_YES" != 1 ]; then
  # `curl | bash` consumes stdin, so read the answer from the controlling
  # terminal; when there is none (cron, CI) demand --yes instead of hanging.
  if [ ! -r /dev/tty ]; then
    die "no terminal available for confirmation — re-run with --yes"
  fi
  printf 'This will permanently delete:\n'
  if [ -d "$PREFIX" ]; then
    printf '  - %s  (gacor.db, .env, videos/)\n' "$PREFIX"
  fi
  printf '  - /etc/systemd/system/gacor-router.service\n'
  printf '  - running gacor-router + cloudflared processes\n'
  if [ "$REMOVE_BUN" = 1 ]; then
    printf '  - %s  (Bun runtime)\n' "${HOME}/.bun"
  fi
  printf 'Type "yes" to continue: '
  reply=""
  read -r -t 60 reply </dev/tty || die "no answer within 60s — aborted"
  [ "$reply" = "yes" ] || die "aborted"
fi

# ── Stop systemd service ───────────────────────────────────────────
UNIT="/etc/systemd/system/gacor-router.service"
if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT" ]; then
  info "stopping + disabling gacor-router service…"
  sudo systemctl disable --now gacor-router 2>/dev/null || true
  sudo rm -f "$UNIT"
  sudo systemctl daemon-reload
  sudo systemctl reset-failed gacor-router 2>/dev/null || true
  ok "systemd unit removed"
else
  info "no systemd unit found — skipping"
fi

# ── Kill stray processes ───────────────────────────────────────────
# Non-systemd runs (`bun run start`, `bun run dev`) have no unit to stop.
# Match on the entrypoint path, then verify the process's working dir IS
# the install dir so another project's `src/index.ts` survives.
for pid in $(pgrep -f 'src/index\.ts' 2>/dev/null || true); do
  if [ "$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)" = "$PREFIX" ]; then
    kill "$pid" 2>/dev/null || true
  fi
done

# A cloudflared quick tunnel spawned by the app outlives it. Same
# port-boundary regex the app itself uses to reap orphans, so :7788
# doesn't also kill :77880 or :17788.
PORT="7788"
if [ -f "$PREFIX/.env" ]; then
  PORT="$(grep -oE '^PORT=[0-9]+' "$PREFIX/.env" 2>/dev/null | cut -d= -f2 || true)"
  PORT="${PORT:-7788}"
fi
# Exclude our own pid: the uninstaller's own cmdline can contain the port
# string when flags were passed through it (pgrep -f would match us).
pids="$(pgrep -f "cloudflared.*:${PORT}([^0-9]|$)" 2>/dev/null || true)"
for pid in $pids; do
  [ "$pid" = "$$" ] && continue
  kill "$pid" 2>/dev/null || true
done

# ── Remove files ───────────────────────────────────────────────────
if [ -d "$PREFIX" ]; then
  info "removing ${PREFIX}…"
  rm_rf "$PREFIX"
  ok "install dir removed"
else
  info "$PREFIX not present — skipping"
fi

# cloudflared binary + tunnel pid live under ~/.gacor-router regardless
# of --prefix (hardcoded in src/tunnel/cloudflared.ts and pid.ts), so a
# custom-prefix install still leaves state there.
if [ "$PREFIX" != "$HOME_GACOR" ] && [ -d "$HOME_GACOR" ]; then
  rm_rf "${HOME_GACOR}/bin"
  rm_rf "${HOME_GACOR}/tunnel"
  rmdir "$HOME_GACOR" 2>/dev/null || true   # only if now empty
  ok "removed cloudflared + tunnel state from $HOME_GACOR"
fi

# ── Bun (opt-in) ───────────────────────────────────────────────────
if [ "$REMOVE_BUN" = 1 ]; then
  if [ -d "${HOME}/.bun" ]; then
    rm_rf "${HOME}/.bun"
    ok "Bun runtime removed from ~/.bun"
  else
    info "~/.bun not present — nothing to remove"
  fi
else
  info "Bun kept at ~/.bun (pass --remove-bun to remove it too)"
fi

# ── Done ───────────────────────────────────────────────────────────
printf '\n%s\n\n' "$(printf '\033[32m✓ Gacor Router uninstalled\033[0m')"
printf '  Reinstall anytime:\n'
printf '    curl -fsSL https://raw.githubusercontent.com/%s/main/install.sh | bash\n\n' "$REPO"
