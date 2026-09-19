#!/usr/bin/env bash
# Build the macOS desktop app with ALL bundled command-line tools staged into
# the Tauri resource directory — the same steps CI runs in
# .github/workflows/desktop-installers.yml ("Stage bundled command-line tools").
#
# Why this exists: `cargo tauri build` only builds the desktop binary and its
# Rust deps. It does NOT (re)build `aurapunk-mcp`, so a DMG built straight from
# a checkout can ship a stale MCP — and the launcher (`scripts/vk-mcp.sh`)
# prefers whatever `target/release/aurapunk-mcp` is on disk. Running this
# script guarantees the frontend, the MCP, the reviewer and the TUI are all
# freshly compiled and bundled before the app is packaged.
#
# Usage: scripts/build-desktop-macos.sh [app|dmg|all]   (default: app)
#   app  -> target/release/bundle/macos/Aurapunk IDE.app
#   dmg  -> target/release/bundle/dmg/*.dmg (Tauri's own DMG, with background)
#   all  -> both
# Env: TAURI_CLI (default: @tauri-apps/cli@2.11.4)
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BUNDLES="${1:-app}"
case "$BUNDLES" in
  app|dmg|all) ;;
  *) echo "error: bundles must be app|dmg|all (got '$BUNDLES')" >&2; exit 1 ;;
esac
TAURI_CLI="${TAURI_CLI:-@tauri-apps/cli@2.11.4}"

echo "🔨 [1/4] Building frontend assets (@vibe/local-web)..."
pnpm --filter @vibe/local-web run build

echo "🦀 [2/4] Building release CLI tools (aurapunk-mcp, review, aurapunk-tui, aurapunk-telegram-bridge)..."
cargo build --release --bin aurapunk-mcp --bin review --bin aurapunk-tui --bin aurapunk-telegram-bridge

echo "📦 [3/4] Staging bundled binaries and plugins into crates/tauri-app/resources..."
bin_dir="$REPO/crates/tauri-app/resources/bin"
mkdir -p "$bin_dir"
cp "$REPO/target/release/aurapunk-mcp" "$bin_dir/aurapunk-mcp"
cp "$REPO/target/release/review"       "$bin_dir/aurapunk-review"
cp "$REPO/target/release/aurapunk-tui" "$bin_dir/aurapunk-tui"
cp "$REPO/target/release/aurapunk-telegram-bridge" "$bin_dir/aurapunk-telegram-bridge"

plugins_dir="$REPO/crates/tauri-app/resources/plugins/fast-jev-compaction"
mkdir -p "$plugins_dir"
rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='docker' "$REPO/packages/jev-plugin/" "$plugins_dir/"

echo "💿 [4/4] Building Tauri app bundle..."
cd "$REPO/crates/tauri-app"
npx --yes "$TAURI_CLI" build --config tauri.build.conf.json --bundles app --no-sign

app="$REPO/target/release/bundle/macos/Aurapunk IDE.app"
if [ -d "$app" ]; then
  codesign --force --deep --sign - --timestamp=none "$app" 2>/dev/null || true
fi

if [ "$BUNDLES" = "dmg" ] || [ "$BUNDLES" = "all" ]; then
  echo "💿 Building macOS DMG via hdiutil..."
  staging=$(mktemp -d)
  volume="$staging/Aurapunk IDE"
  mkdir -p "$volume"
  ditto "$app" "$volume/Aurapunk IDE.app"
  ln -s /Applications "$volume/Applications"

  mkdir -p "$REPO/target/release/bundle/dmg" "$REPO/installer-output"
  dmg="$REPO/target/release/bundle/dmg/Aurapunk-IDE-macos-$(uname -m).dmg"
  rm -f "$dmg"
  hdiutil create -volname 'Aurapunk IDE' -srcfolder "$volume" -ov -format UDZO "$dmg"
  cp -f "$dmg" "$REPO/installer-output/Aurapunk-IDE-macos-$(uname -m).dmg"
  rm -rf "$staging"
fi

echo
echo "✅ Build complete:"
ls -1d "$REPO"/target/release/bundle/macos/*.app 2>/dev/null | sed 's/^/   .app: /' || true
ls -1  "$REPO"/target/release/bundle/dmg/*.dmg  2>/dev/null | sed 's/^/   .dmg: /' || true
echo "   Bundled tools: $(ls -1 "$bin_dir" | tr '\n' ' ')"
echo "   Bundled plugins: $(ls -1 "$REPO/crates/tauri-app/resources/plugins" | tr '\n' ' ')"
