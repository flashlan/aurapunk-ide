#!/usr/bin/env bash
# Launch the AuraPunk IDE MCP server without selecting an arbitrary stale cache
# entry. Prefer a binary already built in this checkout, then the versioned npx
# wrapper, which owns binary download and cache invalidation.

set -e

# AuraPunk is the rename of Vibe Kanban: accept both env names for a transition.
REPO="${AURAPUNK_REPO:-${VIBE_KANBAN_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}}"
MCP_BIN="${AURAPUNK_MCP_BIN:-${VIBE_KANBAN_MCP_BIN:-}}"

export MCP_HOST="${MCP_HOST:-localhost}"

exec_mcp_binary() {
  local bin="$1"
  shift
  if [ "${1:-}" = "--mcp" ]; then
    shift
    if [ "$#" -eq 0 ]; then
      exec "$bin" --mode global
    else
      exec "$bin" "$@"
    fi
  else
    exec "$bin" "$@"
  fi
}

# An explicit binary is useful for local Rust builds and CI diagnostics.
if [ -n "$MCP_BIN" ] && [ -x "$MCP_BIN" ]; then
  exec_mcp_binary "$MCP_BIN" "$@"
fi

# Prefer a binary already built in this checkout. The npm wrapper's
# LOCAL_DEV_MODE requires a packaged `<binary>-<platform>.zip` under
# `npx-cli/dist` and hard-fails when it is missing or stale — that is exactly
# how the MCP server used to die before OpenCode could register its tools.
for candidate in \
  "$REPO/target/release/aurapunk-mcp" \
  "$REPO/target/release/vibe-kanban-mcp" \
  "$REPO/target/debug/aurapunk-mcp" \
  "$REPO/target/debug/vibe-kanban-mcp"; do
  if [ -x "$candidate" ]; then
    exec_mcp_binary "$candidate" "$@"
  fi
done

DEV_CLI="$REPO/npx-cli/bin/cli.js"
if [ -f "$DEV_CLI" ]; then
  exec node "$DEV_CLI" "$@"
fi

# The npx wrapper resolves the package version and uses its matching release
# cache. Do not bypass it with a raw binary from ~/.aurapunk-ide/bin: that was
# the source of MCP sessions staying on v0.2.37 after the app had advanced.
exec npx -y aurapunk-ide@latest "$@"
