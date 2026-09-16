#!/usr/bin/env bash
# Build a release tarball for `gh release create`.
#
# Usage:
#   bash scripts/release.sh v0.2.0
#
# Produces gacor-router-vX.Y.Z.tar.gz in the repo root. Whitelist-only so no
# stray secrets (gacor.db, .env, videos/) leak into a public release. The
# script prints the `gh release create` line at the end — run it yourself
# after a manual sanity check.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: bash scripts/release.sh vX.Y.Z" >&2
  exit 2
fi

# Basic semver-ish shape check — refuse anything that doesn't start with v.
case "$VERSION" in
  v[0-9]*) ;;
  *) echo "version must start with v (e.g. v0.1.0), got: $VERSION" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Version in package.json must match — safer than parsing tags after the fact.
PKG_VER="v$(grep -oE '"version":\s*"[^"]+"' package.json | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
if [ "$PKG_VER" != "$VERSION" ]; then
  echo "package.json version ($PKG_VER) doesn't match requested tag ($VERSION)" >&2
  echo "bump package.json first, or pass $PKG_VER" >&2
  exit 2
fi

echo "[i] building dashboard…"
(cd dashboard && bun install --frozen-lockfile && bun run build)

echo "[i] verifying backend deps + typecheck…"
bun install --frozen-lockfile
bun run typecheck

# Stage into a temp directory — tar the temp dir instead of the live repo so
# .git/, node_modules/, and any dev-only files can't slip in.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "[i] staging release files to $STAGE…"
# Files/dirs to include (whitelist).
copy() {
  local src="$1"
  [ -e "$src" ] || { echo "  ! missing: $src" >&2; return 1; }
  mkdir -p "$STAGE/$(dirname "$src")"
  cp -a "$src" "$STAGE/$src"
}

# Source + built assets.
copy src
copy dashboard/dist
copy drizzle
copy drizzle.config.ts
copy systemd
copy package.json
copy bun.lock
copy tsconfig.json
copy README.md
copy LICENSE
copy .env.example
# Dashboard package.json + lockfile are needed because our db:migrate lives in
# the backend; but the dashboard build artifact is already baked, so the
# dashboard sources / node_modules are NOT shipped.

# Sanity: bail if anything sensitive slipped in.
echo "[i] scanning for accidentally-staged secrets…"
if grep -rlE 'eyJ[a-zA-Z0-9]{20,}|ck_[a-zA-Z0-9]{10,}|gcr-[0-9a-f]{40,}' "$STAGE" 2>/dev/null; then
  echo "[x] found what looks like a credential in the staging dir — aborting" >&2
  exit 3
fi
# Also refuse to package a real DB or env file even if the whitelist missed it.
find "$STAGE" \( -name 'gacor.db*' -o -name '.env' \) | while read -r f; do
  echo "[x] refusing to ship $f — remove it and re-run" >&2
  exit 3
done

TARBALL="gacor-router-${VERSION}.tar.gz"
echo "[i] writing $TARBALL…"
tar czf "$TARBALL" -C "$STAGE" .

SIZE="$(du -h "$TARBALL" | cut -f1)"
echo
echo "  ✓ built $TARBALL ($SIZE)"
echo
echo "  next: verify the tarball extracts cleanly, then publish:"
echo
echo "    tar tzf $TARBALL | head -20            # peek at contents"
echo "    gh release create $VERSION --generate-notes $TARBALL"
echo
