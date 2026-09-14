#!/usr/bin/env bash
# Launch the AuraPunk IDE MCP server without selecting an arbitrary stale cache
# entry. The versioned npx wrapper owns binary download and cache invalidation.

set -e

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
if [ -n "${VIBE_KANBAN_MCP_BIN:-}" ] && [ -x "$VIBE_KANBAN_MCP_BIN" ]; then
  exec_mcp_binary "$VIBE_KANBAN_MCP_BIN" "$@"
fi

REPO="${AURAPUNK_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
DEV_CLI="$REPO/npx-cli/bin/cli.js"
if [ -f "$DEV_CLI" ]; then
  exec node "$DEV_CLI" "$@"
fi

# The npx wrapper resolves the package version and uses its matching release
# cache. Do not bypass it with a raw binary from ~/.aurapunk-ide/bin: that was
# the source of MCP sessions staying on v0.2.37 after the app had advanced.
exec npx -y aurapunk-ide@latest "$@"
