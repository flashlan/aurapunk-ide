# Makefile for aurapunk-ide
#
# Builds and installs the MCP server binary so it can be registered with
# Claude Code as an MCP server.
#
# Binary names (see local-build.sh):
#   aurapunk-mcp  -> the MCP server Claude talks to over stdio   (crate: mcp)
#   aurapunk      -> the main backend/web server it connects to  (crate: server)
#
# `aurapunk-mcp` is a thin stdio front-end: it needs a running `aurapunk`
# backend, located via AURAPUNK_BACKEND_URL, MCP_HOST/MCP_PORT, or the port file
# written by the running server.

CARGO            ?= cargo
PREFIX           ?= $(HOME)/.local
BINDIR           ?= $(PREFIX)/bin
CARGO_TARGET_DIR ?= target
RELEASE_DIR      := $(CARGO_TARGET_DIR)/release

MCP_BIN          := aurapunk-mcp
SERVER_BIN       := server            # cargo binary name; installed as `aurapunk`
INSTALLED_SERVER := aurapunk

# Name to register the MCP server under in Claude.
MCP_NAME         ?= aurapunk
# MCP launch mode: global | orchestrator
MCP_MODE         ?= global

.DEFAULT_GOAL := help

.PHONY: help install install-server install-all build build-mcp build-server \
        mcp-register mcp-unregister uninstall clean \
        release-check check-backend check-schema check-test check-frontend \
        check-tauri

# cargo-nextest is what CI uses; fall back to plain `cargo test` if it's absent.
NEXTEST := $(shell command -v cargo-nextest 2>/dev/null)

help: ## Show this help
	@echo "aurapunk-ide Makefile"
	@echo
	@echo "Targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| sed -E 's/^([a-zA-Z0-9_-]+):.*## /  \1\t/' \
		| expand -t20
	@echo
	@echo "Variables (override on the command line):"
	@echo "  PREFIX=$(PREFIX)            install root (binaries go to PREFIX/bin)"
	@echo "  BINDIR=$(BINDIR)"
	@echo "  MCP_NAME=$(MCP_NAME)        name used by 'make mcp-register'"
	@echo "  MCP_MODE=$(MCP_MODE)        global | orchestrator"

build-mcp: ## Build the MCP server binary (release)
	$(CARGO) build --release --bin $(MCP_BIN)

build-server: ## Build the main aurapunk backend (release)
	$(CARGO) build --release --bin $(SERVER_BIN)

build: build-mcp build-server ## Build both MCP and backend binaries

install: build-mcp ## Build + install aurapunk-mcp into BINDIR
	@mkdir -p "$(BINDIR)"
	install -m 0755 "$(RELEASE_DIR)/$(MCP_BIN)" "$(BINDIR)/$(MCP_BIN)"
	@echo
	@echo "Installed $(BINDIR)/$(MCP_BIN)"
	@echo "Register it with Claude:"
	@echo "  claude mcp add $(MCP_NAME) -- $(BINDIR)/$(MCP_BIN) --mode $(MCP_MODE)"
	@echo "(or run: make mcp-register)"
	@case ":$$PATH:" in *":$(BINDIR):"*) ;; \
		*) echo; echo "NOTE: $(BINDIR) is not on your PATH." ;; esac

install-server: build-server ## Build + install the backend as 'aurapunk'
	@mkdir -p "$(BINDIR)"
	install -m 0755 "$(RELEASE_DIR)/$(SERVER_BIN)" "$(BINDIR)/$(INSTALLED_SERVER)"
	@echo "Installed $(BINDIR)/$(INSTALLED_SERVER)"

install-all: install install-server ## Install both the MCP server and the backend

mcp-register: install ## Install, then register the MCP server with Claude Code
	claude mcp add $(MCP_NAME) -- "$(BINDIR)/$(MCP_BIN)" --mode $(MCP_MODE)

mcp-unregister: ## Remove the MCP server registration from Claude Code
	-claude mcp remove $(MCP_NAME)

uninstall: ## Remove installed binaries from BINDIR
	rm -f "$(BINDIR)/$(MCP_BIN)" "$(BINDIR)/$(INSTALLED_SERVER)"

clean: ## cargo clean
	$(CARGO) clean

# ---------------------------------------------------------------------------
# Release verification — mirror of .github/workflows/test.yml
#
# Run `make release-check` BEFORE pushing a `v*` tag. The release workflow
# (release-indie.yml) triggers on the tag and publishes binaries + npm WITHOUT
# running tests, so a broken `main` ships unless you catch it here first.
# (v0.2.4 carried a clippy error + missing i18n keys that only CI caught.)
#
#   make release-check                # full gate (backend + frontend + tauri)
#   make release-check SKIP_TAURI=1   # skip the heavy tauri leg
#
# Frontend gates assume `pnpm install` has already been run.
# ---------------------------------------------------------------------------

release-check: check-backend check-schema check-test check-frontend $(if $(SKIP_TAURI),,check-tauri) ## Run all CI gates locally before tagging a release
	@echo
	@echo "✅ release-check passed — safe to tag and push."

check-backend: ## fmt + clippy (mirrors the backend-clippy CI job)
	$(CARGO) fmt --all -- --check
	$(CARGO) clippy --workspace --all-targets --exclude aurapunk-tauri -- -D warnings

check-schema: ## generated types + sqlx offline data (mirrors backend-schema-checks)
	pnpm run generate-types:check
	pnpm run prepare-db:check

check-test: ## workspace tests (mirrors backend-test)
ifeq ($(NEXTEST),)
	$(CARGO) test --workspace --exclude aurapunk-tauri
else
	$(CARGO) nextest run --workspace --exclude aurapunk-tauri
endif

check-frontend: ## lint / format / build / i18n (mirrors frontend-checks)
	cd packages/local-web && npm run lint && npm run format:check && npm run build
	cd packages/ui && npm run check && npm run lint && npm run format:check
	cd packages/web-core && npm run check && npm run format:check
	GITHUB_BASE_REF=main ./scripts/check-i18n.sh
	node scripts/check-unused-i18n-keys.mjs
	./scripts/check-legacy-frontend-paths.sh

check-tauri: ## tauri fmt / clippy / check (mirrors tauri-checks)
	$(CARGO) fmt --all --manifest-path crates/tauri-app/Cargo.toml -- --check
	$(CARGO) clippy --all-targets --manifest-path crates/tauri-app/Cargo.toml -- -D warnings
	$(CARGO) check -p aurapunk-tauri
