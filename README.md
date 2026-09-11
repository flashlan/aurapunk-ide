<p align="center">
  <img src="aurapunk-logo.png" alt="Aurapunk IDE logo" width="380" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vibe-kanban-alternative"><img alt="npm" src="https://img.shields.io/npm/v/vibe-kanban-alternative?style=flat-square" /></a>
  <a href="https://github.com/flashlan/aurapunk-ide/actions"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/flashlan/aurapunk-ide/main.yml" /></a>
  <a href="https://deepwiki.com/BloopAI/vibe-kanban"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square" /></a>
  <a href="https://github.com/flashlan/aurapunk-ide/issues"><img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" /></a>
</p>

<h1 align="center">AURAPUNK IDE</h1>

<p align="center">
  Multi-agent development on a Kanban board, with semantic and vector memory (Qdrant memory Graph) shared across agent stages.
</p>

<p align="center">
  A self-hosted cockpit for single-developer AI orchestration — persistent graph memory (mem0), 10+ coding agents, Gitea/Forgejo PRs, a terminal cockpit, a Telegram bridge, and usage observability.
</p>

## Table of Contents

- [Background and Credits](#background-and-credits)
- [What This Fork Adds](#what-this-fork-adds)
- [Overview](#overview)
- [Download Aurapunk IDE](#download-aurapunk-ide)
- [Getting Started](#getting-started)
- [Project Memory (mem0)](#project-memory-mem0)
- [Supported Coding Agents](#supported-coding-agents)
- [Chat and Terminal Interaction](#chat-and-terminal-interaction)
- [Usage and Observability](#usage-and-observability)
- [Terminal UI (TUI)](#terminal-ui-tui)
- [Telegram Orchestration](#telegram-orchestration)
- [Gitea and Forgejo Support](#gitea-and-forgejo-support)
- [Credits and Acknowledgments](#credits-and-acknowledgments)
- [License](#license)

## Background and Credits

Following the [shutdown of Bloop's hosted servers](https://vibekanban.com/blog/shutdown), developers were left with orphaned workspaces and broken dependencies.

**Aurapunk IDE** (formerly `vibe-kanban-alternative`) is an actively maintained, independent evolution built upon the foundations of [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) and [dexloom/vibe-kanban-indie](https://github.com/dexloom/vibe-kanban-indie). It is built for a single-developer workflow: no cloud accounts, no team auth, no remote telemetry. Everything runs on your own machine, and you orchestrate a fleet of coding agents from the browser, a terminal (TUI), or a phone (Telegram).

![Kanban board overview in vibe-kanban-alternative, showing columns of cards with agent status](packages/public/vibe-kanban-alternative-screenshot-overview.png)

## What This Fork Adds

- **Server infrastructure** — upstream sunsetting, Indie runs locally → **fully offline, self-hosted runtime**
- **Cross-session memory** — ephemeral, or none → **native `mem0` with Qdrant and a NetworkX graph**
- **Prompt cache-hit architecture** — not present → **deterministic memory-prefix injection preserves cache hits**
- **Telemetry and observability** — none, or minimal → **`Settings → Usage` dashboard: tokens, activity heatmaps, per-agent breakdown**
- **Coding agent support** — legacy CLI subset → **10+ agents, including Claude Code, Antigravity, Codex, Gemini CLI**
- **Antigravity (AGY) agent** — not supported, or basic text mode → **full `stream-json` parsing, tool-use cards, reasoning-effort control**
- **Chat input and history** — basic textarea → **terminal-style prompt history, configurable send shortcuts**
- **Self-hosted git remotes** — GitHub only, or basic Gitea → **auto-routes between Gitea/Forgejo REST API and the GitHub CLI**
- **Remote control** — web UI only → **terminal TUI and a send-only Telegram bridge**
- **Backup and recovery** — none, or basic → **full export/import of the database, settings, and mem0 state**
- **Chat and UI streaming** — latency issues on long diffs → **optimized canvas/chat rendering and worktree panel fixes**

## Overview

Software engineering increasingly means directing coding agents — planning work, spawning a model to implement it, reviewing its diff, and shipping. The bottleneck is no longer typing code; it's orchestrating, reviewing, and keeping many agent sessions coherent. `vibe-kanban-alternative` is built to make that process fast, local, and personal: a single developer, entirely on their own machine, with no team, cloud, or account required.

At its core it's a kanban board that plans and tracks agent work, plus a workspace runtime that turns each card into a real branch, terminal, and dev server where any of 10+ coding agents (Claude Code, OpenCode, Qwen Code, Codex, Gemini CLI, Antigravity, Copilot, Amp, Cursor, Droid, CCR) executes the plan:

- **Kanban planning** — boards, columns, priorities, tags, sub-issues, and pipelines; cards are the source of truth for a piece of work.
- **Agent workspaces** — each card launches a workspace: a branch, a terminal, a dev server, and an agent following a configurable pipeline (Quick, Basic, or async variants).
- **Diff review** — inline comments, diffs, a preview browser, and a manual-review stage that pauses the agent and raises an alert so you approve the result before any merge or PR.
- **Cross-session project memory (mem0)** — agents recall and persist verified facts about the repositories they work in, keyed per repository and shared across CLIs, with a graph memory that survives restarts.
- **Usage and observability** — a `Settings → Usage` dashboard with per-day activity, per-agent execution bars, extraction-token monitoring, and project progress.
- **Workspaces, PRs, and merge** — dispatch work to existing sessions, open PRs (GitHub or Gitea/Forgejo) with AI-generated descriptions, and complete changes through the Integration Guard.
- **Terminal and phone control** — a [TUI cockpit](#terminal-ui-tui) and [Telegram escalation](#telegram-orchestration) keep you in control without the browser.

![Workspace view showing an agent session, terminal, and diff review panel](packages/public/vibe-kanban-screenshot-workspace.png)

## Download Aurapunk IDE

> **Recommended for end users:** download a native installer from the latest
> GitHub release. The desktop application runs locally and does not require an
> AuraPunk Cloud account.

The current installers are published in [release `v0.2.45`](https://github.com/flashlan/aurapunk-ide/releases/tag/v0.2.45).
The release also includes [`SHA256SUMS`](https://github.com/flashlan/aurapunk-ide/releases/download/v0.2.45/SHA256SUMS)
for integrity verification.

### macOS

- [Apple Silicon — DMG](https://github.com/flashlan/aurapunk-ide/releases/download/v0.2.45/Aurapunk-IDE-macos-apple-silicon.dmg)
- [Intel — DMG](https://github.com/flashlan/aurapunk-ide/releases/download/v0.2.45/Aurapunk-IDE-macos-intel.dmg)

Open the DMG and drag **Aurapunk IDE** to **Applications**. If macOS shows
“Apple cannot verify the developer”, open **System Settings → Privacy &
Security → Open Anyway**. Alternatively, run:

```bash
xattr -cr "/Applications/Aurapunk IDE.app"
```

For Homebrew users:

```bash
brew tap flashlan/tap
brew install --cask aurapunk-ide
```

### Linux

- [AppImage — x86_64](https://github.com/flashlan/aurapunk-ide/releases/download/v0.2.45/Aurapunk-IDE-linux-x64.AppImage)
- [Debian/Ubuntu — `.deb`](https://github.com/flashlan/aurapunk-ide/releases/download/v0.2.45/Aurapunk-IDE-linux-x64.deb)
- [Fedora — `.rpm`](https://github.com/flashlan/aurapunk-ide/releases/download/v0.2.45/Aurapunk-IDE-linux-x64.rpm)

Make the AppImage executable before launching it:

```bash
chmod +x Aurapunk-IDE-linux-x64.AppImage
./Aurapunk-IDE-linux-x64.AppImage
```

Install the Debian package with `sudo apt install ./Aurapunk-IDE-linux-x64.deb`
or the RPM package with `sudo dnf install ./Aurapunk-IDE-linux-x64.rpm`.

### Windows

- [Windows x64 — NSIS installer](https://github.com/flashlan/aurapunk-ide/releases/download/v0.2.45/Aurapunk-IDE-windows-x64.exe)

Run the installer and follow the setup wizard. The current published Windows
installer targets x64 systems.

The [website download page](https://aurapunk.dev/#download) provides the same
platform selector and first-launch instructions.

## Getting Started

### Quick Start

Launch the full cockpit with a single command — no install, no account, no cloud setup:

```bash
npx vibe-kanban-alternative
```

This downloads prebuilt binaries and starts the local web cockpit at `http://localhost:3001` (backend on `:3002`).

## Project Memory (mem0)

`vibe-kanban-alternative` ships with a first-class mem0 integration, giving every coding agent driving a workspace a durable, semantic memory of the repositories it works in.

### Capabilities

- **Agentic recall, not auto-injection** — nothing is prepended to the prompt automatically. The pipeline's "Project memory" stage instructs the agent to call `memory_search` with a query scoped to the card's files, modules, or area before starting — a targeted lookup, not a full dump.
- **Shared repository knowledge** — memory is keyed per repository, so you can start a task on Claude Code and switch to OpenCode or Antigravity mid-project without losing context.
- **Verified fact save-back** — the memory pipeline stage instructs the agent to persist only self-contained, verified facts (architectural decisions, patterns, root causes) via `memory_save`; ephemeral chatter is filtered out.
- **MCP tool integration** — agents access `memory_search` and `memory_save` as first-class Model Context Protocol (MCP) tools.
- **Graph-based memory (GraphML)** — entity and relation extraction builds an interconnected graph (mem0 + Qdrant + NetworkX), persisted on disk (`/data/graphs/*.graphml`) so knowledge structures survive container reboots.
- **Project-scoped namespaces** — each repository uses its own `user_id`, so agents share knowledge inside a project without mixing it with another codebase.
- **Code-aware freshness** — saved facts can carry the current Git commit; the staleness check compares that provenance with removed lines in the current worktree.
- **Memory reconstruction** — if graph extraction was unavailable when facts were saved, `mem0_vk` can re-extract existing facts and rebuild their entities and relations after the extraction configuration is fixed.
- **Safe adapter migration** — Settings → Memory offers preview-first migration between `mem0_vk` and Mem0 Platform, with duplicate detection, source preservation, and explicit confirmation.

### How project memory works

Memory is scoped to the repository being worked on. The repository slug is used
as the Mem0 `user_id`, so a fact saved for `aurapunk-ide` is not returned for a
different repository. Multiple agents and sessions can share that project
namespace, but namespaces are never merged implicitly.

The memory loop is deliberate:

1. **Recall** — before analysing code, the agent calls `memory_search` with a
   focused question about the files or module it is about to touch.
2. **Save** — after verification, the agent calls `memory_save` with a durable,
   self-contained fact such as an architectural decision, convention, or root
   cause. Chatter, guesses, and secrets do not belong in project memory.
3. **Connect** — with graph extraction enabled, entities and relations connect
   facts such as modules, files, services, and dependencies. `mem0_vk` exposes
   `memory_graph_traverse` for multi-hop neighbourhood queries.

### Reconstructing memory after code changes

`mem0_vk` records the current Git commit when a memory is saved. The
`memory_check_staleness` tool compares that provenance with the current
worktree and searches removed diff lines for evidence that a referenced entity
may no longer exist. A negative result is not proof of freshness; an
unavailable check is reported as unknown.

If facts were saved before an extraction model or graph service was configured,
the `POST /api/re-extract/:user_id` operation reprocesses existing facts,
rebuilds their entities and relations, and updates the project graph. It
reconstructs memory structure; it does not restore deleted code or certify that
the underlying fact is still true.

### Choosing and migrating memory adapters

`mem0_vk` is the full-control, self-hosted adapter: extraction providers,
embeddings, Qdrant, graph storage, Git provenance, traversal, and re-extraction
remain under the project's control. Mem0 Platform is the managed alternative:
it handles extraction, embeddings, storage, asynchronous processing, and its
own Graph Memory, but does not expose the AuraPunk-specific Git staleness and
bulk re-extraction contract.

Switching adapters does not move data. To migrate, open **Settings → Memory**,
enter the source and destination endpoints/keys, run **Preview migration**, and
review the counts. Only then confirm **Execute migration**. The operation is
scoped to one repository, skips duplicate normalized facts, never deletes the
source, and does not persist migration credentials. Imported facts are
re-extracted by the destination, so vectors, provider-specific graph IDs, and
exact extraction results are not portable. Keep the source active until the
destination has finished processing and representative searches have been
verified.

### Prompt Cache-Hit Design

To minimize token costs on providers with prompt caching (Anthropic, OpenRouter, DeepSeek):

1. **No automatic prefix injection** — there is no memory block prepended to the prompt. The injected block used to change on every new memory, invalidating the cached prefix on every workspace start. See [ADR-028](docs/ADR/ADR-028-mem0-agentic-recall.md).
2. **Tool calls, not prompt mutations** — `memory_search` and `memory_save` execute as MCP tool calls scoped to the current card, keeping the static system/task prefix identical (and cache-hit) across workspace starts.

```mermaid
flowchart TB
    Mem0["Mem0 Context<br/>Vector and semantic memory"]

    Worktree["Worktree<br/>Input"]
    A1["Agent 1<br/>Gemini<br/>Research"]
    A2["Agent 2<br/>Opus<br/>Planner"]
    A3["Agent 3<br/>Qwen3.8 Local<br/>Coding"]
    A4["Agent 4<br/>Opencode<br/>Review"]
    Merge["Merge<br/>Output"]

    Worktree --> A1
    A1 --> A2
    A2 --> A3
    A3 --> A4
    A4 --> Merge

    A1 -.->|write| Mem0
    Mem0 -.->|fetch| A1

    A2 -.->|write| Mem0
    Mem0 -.->|fetch| A2

    A3 -.->|write| Mem0
    Mem0 -.->|fetch| A3

    A4 -.->|write| Mem0
    Mem0 -.->|fetch| A4

    style Mem0 fill:#7d6608,stroke:#f9e79f,stroke-width:2px,color:#ffffff
    style Worktree fill:#424949,stroke:#d5dbdb,stroke-width:2px,color:#ffffff
    style A1 fill:#154360,stroke:#d6eaf8,stroke-width:2px,color:#ffffff
    style A2 fill:#154360,stroke:#d6eaf8,stroke-width:2px,color:#ffffff
    style A3 fill:#154360,stroke:#d6eaf8,stroke-width:2px,color:#ffffff
    style A4 fill:#154360,stroke:#d6eaf8,stroke-width:2px,color:#ffffff
    style Merge fill:#1b4f3d,stroke:#a9dfbf,stroke-width:2px,color:#ffffff
```

### Setup

The project memory layer runs on a local Docker stack (`mem0-vk`): a mem0 API server on `:8000`, a Qdrant vector store, and a Python embeddings + NetworkX graph service.

For the simplest installation, run the all-in-one Docker Hub image (API, Qdrant, Redis, local embeddings, and graph in one container):

```bash
docker run -d \
  --name vk-mem0 \
  --restart unless-stopped \
  -p 8000:8000 \
  -e GROQ_API_KEY='your-key' \
  -v vk_mem0_data:/data \
  datyapoint/vk-mem0:latest
```

The local embeddings model requires no API key. Settings changed through **Settings → Memory** persist in the same `/data` volume.

#### Updating the all-in-one image

Updating the image does not delete data as long as you reuse the same `/data` volume. Stop and remove only the container, then start the new image with the same volume:

```bash
docker pull datyapoint/vk-mem0:latest
docker rm -f vk-mem0
docker run -d \
  --name vk-mem0 \
  --restart unless-stopped \
  -p 8000:8000 \
  -v vk_mem0_data:/data \
  datyapoint/vk-mem0:latest
```

`docker rm -f` removes the container only. It does not remove `vk_mem0_data`. Never use `docker volume rm`, `docker volume prune`, or `docker compose down -v` when you want to keep memories.

#### Migrating from the multi-container stack

The original Compose deployment stores data in three volumes. Before migrating, make a backup and stop the old stack without removing its volumes:

```bash
cd mem0-vk
mkdir -p backups
docker run --rm -v mem0-vk_graph_data:/source -v "$PWD/backups":/backup alpine \
  tar czf /backup/mem0-graph-data.tgz -C /source .
docker run --rm -v mem0-vk_qdrant_data:/source -v "$PWD/backups":/backup alpine \
  tar czf /backup/mem0-qdrant-data.tgz -C /source .
docker run --rm -v mem0-vk_redis_data:/source -v "$PWD/backups":/backup alpine \
  tar czf /backup/mem0-redis-data.tgz -C /source .
docker compose down
```

Start the all-in-one image with the existing volumes mounted at the paths it expects:

```bash
docker run -d \
  --name vk-mem0 \
  --restart unless-stopped \
  -p 8000:8000 \
  -v mem0-vk_graph_data:/data \
  -v mem0-vk_qdrant_data:/data/qdrant \
  -v mem0-vk_redis_data:/data/redis \
  datyapoint/vk-mem0:latest
```

Wait for `healthy` before using the UI:

```bash
docker ps --filter name=vk-mem0
curl http://localhost:8000/health
```

This migration reuses the existing graph, Qdrant, Redis, and `/data/config.json` contents. To roll back, remove only the new container and start the original Compose stack again; do not delete the three volumes.

For development or independently managed services, use the multi-container stack:

```bash
cd mem0-vk
cp .env.example .env      # then set an extraction LLM key (see below)
docker compose up -d --build
```

It can also be configured from the app: open **Settings → Memory** to manage the graph at runtime, configure extraction providers (Groq, OpenRouter, local llama), and view token usage.

## Supported Coding Agents

`vibe-kanban-alternative` integrates natively with 10+ coding agents:

1. **Google Antigravity (`agy`)** (new)
   - Full stream-JSON protocol support.
   - Native visual cards for file inspection (`view_file`), search (`grep_search`, `find_by_name`), bash commands (`run_command`), and file edits (`write_to_file`, `replace_file_content`).
   - Reasoning-effort controls (`Low`, `Medium`, `High`) with automatic fallback for `gemini-3.7-flash`.
   - YOLO mode auto-permission bypass (`--dangerously-skip-permissions`).
2. **Anthropic Claude Code** — headed and headless modes, full MCP tool approvals, and turn navigation.
3. **OpenCode and OpenCode Headed** — multi-model agent runner with local and remote inference.
4. **OpenAI Codex** — deep reasoning and plan generation.
5. **Qwen Code** — high-performance local and cloud agent workflows.
6. **Google Gemini CLI** — native Gemini execution.
7. **GitHub Copilot CLI, Cursor Agent, Droid, and Amp**.

## Chat and Terminal Interaction

- **Prompt history navigation (`ArrowUp` / `ArrowDown`)**
  - Press `ArrowUp` at the start of the chat box to cycle backward through previously sent commands and prompts.
  - Press `ArrowDown` to cycle forward and restore your uncommitted draft text.
  - History persists locally across browser sessions.
- **Configurable send shortcuts**
  - `Enter` mode — press `Enter` to send instantly; use `Ctrl + Enter`, `Cmd + Enter`, or `Shift + Enter` to insert a newline.
  - `ModifierEnter` mode — press `Cmd/Ctrl + Enter` to send; `Enter` for a newline.
  - Configurable under **Settings → General**.

## Usage and Observability

A per-machine activity dashboard in **Settings → Usage** shows how your agent time is spent, straight from the local database — no cloud telemetry:

- **Totals** — executions, agent time, and open issues over the last 30 days.
- **Activity heatmap** — a GitHub-style, day-by-day view of agent executions.
- **Executions per day by agent** — stacked bar rows for each configured agent.
- **Extraction token usage** — tokens spent on mem0 graph extractions.
- **Provider limits** — live Codex and Claude quota windows when their CLIs
  expose structured account data, including usage, remaining percentage, and
  reset time. Providers without a safe machine-readable response are shown as
  unavailable rather than estimated from local token counts.
- **Token usage by issue** — durable normalized observations grouped by issue,
  agent, provider, and model for local benchmarking.
- **Project and issue progress** — open/done counts and completion bars per project.

![Usage and observability dashboard with an activity heatmap and per-agent execution bars](packages/public/vibe-kanban-usage-dashboard.png)

## Terminal UI (TUI)

`vibe-tui` is a terminal cockpit for the backend — list workspaces and sessions, watch live agent transcripts, manage a kanban board for local projects, and approve, deny, or answer the things agents block on, all without leaving the terminal:

```bash
cargo run -p tui
```

- **Global** — `a` approvals inbox · `?` help · `q` quit
- **List** — `↑↓`/`jk` move · `⇥` switch pane · `⏎` open · `n` new task · `b` board · `r` refresh
- **Detail** — `⇥`/`←→` move focus · `↑↓`/`jk` navigate · `f` follow · `i` message agent · `s` stop · `esc` back
- **Git pane** — `⇥` focus · `↑↓` select repo · `m` merge · `R` rebase · `P` create PR · `u` push
- **Approvals inbox** — `↑↓` move · `y` approve · `d` deny · `⏎` answer · `esc` back
- **Board** — `←→` column · `↑↓` card · `[ ]` move card · `n` new · `e` edit · `d` delete · `w` workspace

## Telegram Orchestration

`vibe-telegram-bridge` is a send-only daemon that streams coding-agent escalations to a Telegram supergroup with topics, so a blocked agent can be unblocked remotely from your phone:

```toml
# ~/.vibe-kanban/telegram.toml
enabled = true
bot_token = "123456:ABC..."
chat_id = "-1001234567890"
per_worktree_topics = true
```

```bash
cargo run -p telegram-bridge
```

## Gitea and Forgejo Support

Full REST API integration alongside GitHub:

- Automatic routing: `github.com` remotes use the `gh` CLI; custom hosts use the Gitea REST API.
- Secure token storage in `~/.vibe-kanban/gitea.toml` or `GITEA_TOKEN`.
- Unified comments and PR lifecycle management.

## Development Setup

For development, custom ports, a local mem0 vector store, or custom agent configuration, run the project from source.

**Prerequisites**
- [Node.js](https://nodejs.org/) (>=20) and [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/) (stable toolchain)
- [Docker](https://www.docker.com/), for the mem0 graph memory stack (optional)

**1. Clone and install**

```bash
git clone https://github.com/flashlan/vibe-kanban-alternative.git
cd vibe-kanban-alternative
pnpm i
```

**2. Configure environment variables**

```bash
cp .env.example .env
```

Then open `.env` and set the values relevant to your setup:

```env
# ==========================================
# CORE SERVER CONFIGURATION
# ==========================================
PORT=3000
HOST=localhost
NODE_ENV=development

# ==========================================
# MEM0 LONG-TERM MEMORY SETTINGS
# ==========================================
MEM0_ENABLED=true
MEM0_API_KEY=your_mem0_api_key_here
# If running local embeddings/vector store:
# MEM0_VECTOR_STORE=qdrant
# MEM0_HOST=http://localhost:6333

# ==========================================
# AGENT API KEYS & RUNTIMES
# ==========================================
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...

# Antigravity (AGY) Specific Settings
AGY_CLI_PATH=/usr/local/bin/agy
AGY_DEFAULT_TEMPERATURE=0.2

# ==========================================
# METRICS & TELEMETRY
# ==========================================
ENABLE_METRICS_DASHBOARD=true
METRICS_STORAGE_PATH=./data/metrics.sqlite

# ==========================================
# BACKUP CONFIGURATION
# ==========================================
BACKUP_ENABLED=true
BACKUP_INTERVAL_MINUTES=30
BACKUP_STORAGE_PATH=./backups
```

**3. Start the project memory stack (optional, recommended)**

```bash
cd mem0-vk && cp .env.example .env && docker compose up -d --build && cd ..
```

**4. Start the development cockpit**

```bash
~/Desktop/Kiky/scripts/restart.sh
```

Frontend runs on `:3001`, backend on `:3002`.

The local build helpers are kept together in `~/Desktop/Kiky/scripts/`:

```bash
~/Desktop/Kiky/scripts/local-build.sh                  # release packages
~/Desktop/Kiky/scripts/generate-ide-mac.sh              # macOS .app + .dmg
~/Desktop/Kiky/scripts/restart.sh [--window|--cloud]   # restart local cockpit
```

The Android/llama control menu also exposes these actions and includes a
separate `Install APK on emulator` command that reuses the existing APK
without rebuilding it.

## Credits and Acknowledgments
Aurapunk IDE is built upon the foundational work of the open-source community. We express our gratitude to:
- **[BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)** — The original multi-agent Kanban workspace architecture created by the Bloop team.
- **[dexloom/vibe-kanban-indie](https://github.com/dexloom/vibe-kanban-indie)** — The single-developer, local-first evolution and independent maintainer foundation.

All respective copyrights, licenses, and design credits remain fully honored and attributed.

## License

Apache 2.0. See [LICENSE](LICENSE) for details.
