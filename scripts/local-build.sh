#!/usr/bin/env bash
# Build the prebuilt binaries the npx wrapper serves in local dev mode.
#
# When `npx-cli/dist/` exists, `npx-cli/src/download.ts` flips into
# LOCAL_DEV_MODE and serves `<platform>/aurapunk.zip` from there instead of
# downloading the GitHub Release.
#
# That zip is the SAME single bundle the release workflow publishes: every
# binary (server, mcp, review, tui, telegram-bridge) plus the bundled plugin
# (plugins/fast-jev-compaction). The CLI extracts the whole bundle into one
# cache dir and runs whichever binary a subcommand needs, so there is exactly
# one artifact per platform — not one zip per binary.
#
# Usage: scripts/local-build.sh
# Env: PROFILE (default: release), CARGO_TARGET_DIR (default: <repo>/target)
#
# Never run this before `npm publish` — PUBLISHING.md requires the published
# tarball to contain NO dist/ folder.

set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${PROFILE:-release}"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/target}"

# cargo bin name -> name inside the bundle (must match the workflow's bundle).
BINS=(
  "server:aurapunk"
  "aurapunk-mcp:aurapunk-mcp"
  "review:aurapunk-review"
  "aurapunk-tui:aurapunk-tui"
  "aurapunk-telegram-bridge:aurapunk-telegram-bridge"
)

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

# Drop leftovers from the pre-bundle layout (one zip per binary, plus the
# pre-rename vibe-kanban names) so nothing stale can shadow the bundle.
rm -f "$OUT_DIR"/vibe-kanban*.zip
for pair in "${BINS[@]}"; do rm -f "$OUT_DIR/${pair##*:}.zip"; done

PROFILE_DIR="$TARGET_DIR/$PROFILE"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for pair in "${BINS[@]}"; do
  cargo_bin="${pair%%:*}"
  bundle_name="${pair##*:}"
  if [ "$cargo_bin" = "server" ] && [ ! -f "$REPO/packages/local-web/dist/index.html" ]; then
    echo "warning: packages/local-web/dist is missing — the backend will embed"
    echo "warning: a dummy frontend page. Build the web app first if you need the UI:"
    echo "warning:   cd packages/local-web && npm run build"
  fi
  echo "==> cargo build --profile $PROFILE --bin $cargo_bin"
  (cd "$REPO" && cargo build --profile "$PROFILE" --bin "$cargo_bin")
  cp "$PROFILE_DIR/$cargo_bin$EXE" "$STAGE/$bundle_name$EXE"
done

# Bundled plugin, same layout as the release bundle.
mkdir -p "$STAGE/plugins"
rsync -a --exclude='node_modules' --exclude='.git' --exclude='docker' \
  "$REPO/packages/jev-plugin/" "$STAGE/plugins/fast-jev-compaction/"

(cd "$STAGE" && rm -f "$OUT_DIR/aurapunk.zip" && zip -qr "$OUT_DIR/aurapunk.zip" .)

echo
echo "Local dev bundle ready: $OUT_DIR/aurapunk.zip"
echo "Restart agent sessions so their MCP servers respawn against the new bundle."
