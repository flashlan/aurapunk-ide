#!/usr/bin/env bash
# Build the prebuilt binaries the npx wrapper serves in local dev mode.
#
# When `npx-cli/dist/` exists, `npx-cli/src/download.ts` flips into
# LOCAL_DEV_MODE and serves `<platform>/<base>.zip` from there instead of
# downloading the GitHub Release — so after the Vibe Kanban → AuraPunk
# rename this script is what (re)provisions `aurapunk-mcp` and friends with
# the new names. It mirrors `.github/workflows/release-alternative.yml`'s
# "Package" step: each zip contains the bare binary at its root.
#
# Usage: scripts/local-build.sh [all|mcp|server|review|tui]...
#   default: all
# Env: PROFILE (default: release), CARGO_TARGET_DIR (default: <repo>/target)
#
# Never run this before `npm publish` — PUBLISHING.md requires the published
# tarball to contain NO dist/ folder.

set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${PROFILE:-release}"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/target}"

if [ "${1:-all}" = "--desktop" ]; then
  echo "error: desktop bundles are not built here; see crates/tauri-app" >&2
  echo "npx-cli/src/download.ts expects them under npx-cli/dist/tauri/<platform>/" >&2
  exit 1
fi

# cargo bin name -> dist base name (must match CI's Package step).
if [ "$#" -eq 0 ]; then set -- all; fi
BINS=()
for arg in "$@"; do
  case "$arg" in
    all) BINS=(server:aurapunk aurapunk-mcp:aurapunk-mcp review:aurapunk-review aurapunk-tui:aurapunk-tui) ;;
    mcp) BINS+=("aurapunk-mcp:aurapunk-mcp") ;;
    server) BINS+=("server:aurapunk") ;;
    review) BINS+=("review:aurapunk-review") ;;
    tui) BINS+=("aurapunk-tui:aurapunk-tui") ;;
    *) echo "error: unknown target '$arg' (want all|mcp|server|review|tui)" >&2; exit 1 ;;
  esac
done

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="macos-arm64"; EXE="" ;;
  Darwin-x86_64) PLATFORM="macos-x64"; EXE="" ;;
  Linux-x86_64) PLATFORM="linux-x64"; EXE="" ;;
  Linux-aarch64) PLATFORM="linux-arm64"; EXE="" ;;
  MINGW*|MSYS*|CYGWIN*-x86_64) PLATFORM="windows-x64"; EXE=".exe" ;;
  MINGW*|MSYS*|CYGWIN*-aarch64) PLATFORM="windows-arm64"; EXE=".exe" ;;
  *) echo "error: unsupported platform '$(uname -s)-$(uname -m)'" >&2; exit 1 ;;
esac

OUT_DIR="$REPO/npx-cli/dist/$PLATFORM"
mkdir -p "$OUT_DIR"

# Drop pre-rename leftovers so a stale vibe-kanban*.zip can never shadow the
# new names again (dist/ is gitignored; these are never committed).
rm -f "$OUT_DIR"/vibe-kanban*.zip

PROFILE_DIR="$TARGET_DIR/$PROFILE"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for pair in "${BINS[@]}"; do
  cargo_bin="${pair%%:*}"
  dist_base="${pair##*:}"
  if [ "$cargo_bin" = "server" ] && [ ! -f "$REPO/packages/local-web/dist/index.html" ]; then
    echo "warning: packages/local-web/dist is missing — the backend will embed"
    echo "warning: a dummy frontend page. Build the web app first if you need the UI:"
    echo "warning:   cd packages/local-web && npm run build"
  fi
  echo "==> cargo build --profile $PROFILE --bin $cargo_bin"
  (cd "$REPO" && cargo build --profile "$PROFILE" --bin "$cargo_bin")
  cp "$PROFILE_DIR/$cargo_bin$EXE" "$STAGE/$dist_base$EXE"
  (cd "$STAGE" && rm -f "$OUT_DIR/$dist_base.zip" && zip -q "$OUT_DIR/$dist_base.zip" "$dist_base$EXE" && rm "$STAGE/$dist_base$EXE")
  echo "==> packaged $OUT_DIR/$dist_base.zip"
done

echo
echo "Local dev binaries ready in $OUT_DIR."
echo "Restart agent sessions so their MCP servers respawn against the new zips."
