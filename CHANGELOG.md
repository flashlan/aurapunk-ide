# Changelog

All notable changes to **AuraPunk IDE** are documented here. This fork is
local-only and single-developer focused; releases are cut by pushing a `v<version>`
tag that matches `npx-cli/package.json` (see `.github/workflows/release-alternative.yml`).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-09-14

Maintenance release for the AuraPunk IDE distribution pipeline. The npm CLI,
desktop installers, and Rust workspace now share the `0.3.1` release version;
the runtime behavior is unchanged from `0.3.0`.

## [0.3.0] - 2026-09-14

This is a breaking release. The `0.3.x` line is not compatible with the `0.2.x`
runtime and cloud contracts. It introduces the AuraPunk IDE branding, the hosted
cloud authentication/memory path, mobile synchronization surfaces, and the
release pipeline that publishes the npm CLI and native IDE installers from the
same `v0.3.0` tag.

## [0.2.45] - 2026-09-03

### Fixed

- Accepted Codex CLI `0.152.0` and future versions through the existing
  `NamedPermissions` compatibility path while continuing to reject versions
  below `0.124.0`.

## [0.2.44] - 2026-08-26

### Added

- **Agent Work Coordinator and Integration Guard**: added automatic agent-work declarations, active-agent visibility, soft reservations, semantic dependency warnings, ten-minute leases, and a database-backed integration lease for parallel worktrees.
- **HEAD-aware integration**: direct completion now compares the task and target changes from their original branch point and performs a Git three-way integration, allowing independent changes to land without an unnecessary rebase.
- **Conflict-safe completion**: semantic overlap, real Git conflicts, dirty target worktrees, and concurrent integrations leave the card open instead of marking it as Done incorrectly.
- Added an all-in-one Mem0 Docker Hub image bundling Mem0, Qdrant, Redis, health checks, and supervised services.
- Limited the MCP pipeline surface to the Quick pipeline for the current local workflow.
- Added protected card completion: `complete_workspace_card` integrates through
  the Integration Guard and requires a Mem0 acknowledgement before moving a
  card to a terminal status.

### Changed

- Pipeline completion stages now delegate to `complete_workspace_card` and the Integration Guard; agents no longer perform manual rebases, ref updates, or temporary merge locking.
- Kanban drops into Done now require an explicit choice to merge, move without
  merging, or cancel; silent agent-side terminal transitions are rejected.
- Reworked the workspace chat scrolling behavior so manual wheel input keeps automatic scrolling paused.

### Fixed

- Updated Codex app-server requests to use named permission profiles and removed conflicting legacy permission fields.
- Documented and guarded safe Mem0 volume migration and local backup handling.

### Documentation

- Added ADR-036 and a two-agent validation runbook covering observability, semantic conflicts, and serialized integration.
- Updated the README and pipeline documentation with the Integration Guard terminology and workflow.

## [0.2.43] - 2026-08-25

### Added

- Added a unified MCP search across operation history and semantic memory, with repository-wide search as the default and optional card/workspace scoping.
- Added a GitHub star banner to the navigation bar.

### Fixed

- Paused automatic chat scrolling when the user scrolls manually with the mouse wheel.
- Decoded unified mem0 search responses correctly and exposed workspace search through the MCP tool surface.

### Documentation

- Fixed broken Mintlify links between the multi-agent ADRs and the repository-level `AGENTS.md`.

## [0.2.42] - 2026-08-25

### Added

- Added Atelier light and night themes.
- Added an IDE launcher helper for macOS development builds.

### Fixed

- **Codex app-server compatibility**: detect the installed Codex version before startup, accept the tested 0.124.x–0.149.x range, and adapt `thread/start`, `thread/fork`, and `turn/start` requests for the named-permissions protocol introduced in Codex 0.149. Unsupported versions now fail early with an actionable message.
- **Codex workspace command execution**: disable Code Mode for this client because it does not implement dynamic tool execution, keeping self-hosted sessions on Codex's built-in shell path when `codex-code-mode-host` is unavailable.
- **Codex MCP configuration**: expose the local Vibe Kanban MCP tools and migrate the legacy bundled MCP preset safely.
- **Workspace attachments**: copy issue attachments into agent workspaces and include their local paths in the initial prompt.
- **Queued follow-ups**: dispatch queued messages after successful no-op turns instead of finalizing the session early.
- Restored the missing SQLx offline metadata for issue attachments and fixed the create-workspace prompt initialization order.

### Documentation

- Documented the Codex app-server compatibility policy in ADR-034.
- Updated the Vibe Kanban book manuscript, acknowledgements, and KDP publication checklist.

## [0.2.41] - 2026-08-24

### Fixed

- **Codex model discovery & RPC handler resilience**:
  - Added `ClientRequest::ModelList` to JSON-RPC `request_id()` handler to resolve `"request_id called for unsupported request variant"` panic during model discovery.
  - Implemented resilient `CodexModelListResponse` deserialization supporting new reasoning effort levels (`max`, `ultra`, `minimal`, `none`) introduced in Codex CLI v0.148.0+.
  - Fully enabled support for frontier models including `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and `gpt-5.2` with custom reasoning efforts.

## [0.2.40] - 2026-08-24

### Fixed

- **Codex executor spawn and model listing**: automatically detect and prioritize locally-installed `codex` CLI binaries on `PATH` (e.g. `/opt/homebrew/bin/codex`) over pinned npx downloads. This resolves `I/O error: server was shutdown while waiting for initialize response` errors and ensures models like `gpt-5.5` and `gpt-5.4` load seamlessly.

## [0.2.39] - 2026-08-24

### Fixed

- **MCP backend host & port resolution**: `vibe-kanban-mcp`, `telegram-bridge`, and the TUI now resolve the backend host as `"localhost"` by default (matching the server's bind to `localhost:0`), resolving IPv6 `::1` connection failures on modern macOS. In addition, `start_with_bind()` now writes the runtime port file immediately on launch, enabling `vibe-kanban-mcp` and other tools to dynamically discover the active port when running embedded under Tauri.

### Added

- **TUI CLI command**: added `npx vibe-kanban-alternative tui` to launch the terminal cockpit directly via the CLI package.

## [0.2.38] - 2026-08-24

### Added

- **Live Android screen mirroring**: embedded live screen mirror in the workspace panel with detachable floating window support (Document Picture-in-Picture) for mobile app testing and debugging.
- **Asynchronous background memory queue (mem0-vk)**: added BullMQ and Redis worker queue to offload heavy LLM entity extraction and embeddings in the background, making memory store operations non-blocking and instantaneous.
- **Vibe Kanban Book Manuscript ("Manual Moderno & Publicação na Amazon KDP")**: complete 15-chapter publication-ready manuscript (`docs/livro/manuscript.md`), 12 visual anchors, automated consolidated build script (`scripts/build-manuscript.py`), and 1600x2560 eBook cover image.
- **Default project orchestrator prompts & rule persistence**: baked default pre/post orchestrator prompt rules directly into the server binary via `assets/default_orchestrator_prompt.txt` and persisted per-project rules in `projects.toml`.
- **Kanban column card count badge**: added real-time card counters directly to column headers on the Kanban board.
- **Global left sidebar width persistence**: resizing the left sidebar now persists immediately across browser reloads via `localStorage`.

### Fixed

- **Chat footer layout & model/agent selector ergonomics**: separated footer controls into two dedicated rows. The top row groups Preset, Model Selector, and Permissions in a non-wrapping container with smooth text truncation (`...`), while the bottom row places the Agent/Mode selector alongside attachment/skill icons and the Send/Queue action buttons, preventing button stacking and layout breaks when resizing.
- **Kanban board reload and flickering on panel toggle**: stabilized the panel group hierarchy by removing keyed remounts on `<Group>`, keeping the `<ProjectKanbanBoard />` permanently mounted and allowing fluid horizontal resizing when toggling the right sidebar or project terminal.
- **Side panel minimum width enforcement**: enforced a 380px minimum width (`minSize="380px"`, `min-w-[380px]`) on the Kanban right sidebar and workspace layout, ensuring action buttons (such as "Open Workspace" and model pickers) are never clipped or squished into truncated labels.
- **Startup banner overlay lockup**: resolved an issue where the dark startup banner persisted with pointer events, blocking UI interaction. The banner now dismisses smoothly and immediately upon React hydration.
- **Kanban terminal layout & navigation**: ensured project terminal toggle divides space side-by-side with the board without collapsing into the workspace or erroneously toggling the main sidebar.
- **Terminal tab management**: fixed tab close handlers to reliably trigger on pointer down and close the drawer panel when the last tab is deleted.
- **Antigravity token telemetry & log suppression**: normalized Antigravity session context gauges and suppressed internal cortex validation errors from surfacing in the chat UI.

## [0.2.37] - 2026-08-23

### Fixed

- **Create-workspace "select a branch" error stuck even after fixing the repo's default branch**: an abandoned create-mode draft (closed before picking a branch) could persist `target_branch: ""` in its `DRAFT_WORKSPACE` scratch. Restoring that draft used `??`, which only treats `null`/`undefined` as "absent" — the empty string survived as the literal branch value. Because a repo was already present in the restored draft, the auto-apply-repo-defaults logic (which only fills in *repo-less* drafts) never re-derived a branch from the repo's configured default, so the stuck empty string was immune to re-saving "main" in Settings → Repositories no matter how many times it was reselected there. `resolveBootstrapRepos` now normalizes `""` to `null` the same way `workspaceDefaults.ts` already does, so a restored draft's branch field shows as genuinely unselected and can actually be set.

### Added

- **Per-workspace sidebar color**: a color picker (`WorkspaceColorDialog`) lets each workspace get its own tint in the sidebar's outliner tree, so visually similar cards/branches are easier to tell apart at a glance.

## [0.2.36] - 2026-08-22

### Added

- **Card Pipeline & Project Rules protocol via MCP**: new `get_pipeline` MCP tool resolves a card's selected pipeline stages server-side (`GET /api/workspaces/{id}/pipeline/resolve`, reading `extension_metadata`) instead of embedding the full ordered stage list in the card description text — the description now carries only a compact pointer, keeping the heavy instruction text out of every model call. New `get_rules` MCP tool resolves global pre/post project guidance (`GET /api/general-rules/resolve`, configurable in Settings → General), replacing the old inline "PROJECT MEMORY" prompt blob duplicated across all 9 bundled pipeline TOMLs. `AGENTS.md` documents both protocols so any agent working the board knows to call them.
- **Card lifecycle metrics**: new `issue_status_history` table + trigger records every status change (drag/drop, auto-move, API, or MCP); a new `GET /v1/issues/{id}/metrics` endpoint and `CardInfoDialog` surface per-card total time, review cycles, rework count, and status-change count, with aggregate `issues_lifecycle` counters added to Settings → Usage.
- **Issue archive/restore/purge**: 3-dot card menu with Archive, an Archived Issues recovery dialog (Restore / Delete permanently), and a new `archived`/`archived_at` column pair excluding archived issues from the active board.
- **Auto-move cards**: cards move Todo → In Progress (on workspace create) → In Review (on pipeline completion) → Done (on merge), gated by a Settings toggle (`auto_move_cards_enabled`, default on); forward-only and never overrides a manual drag.
- **Create-issue dialog parity with cards**: image attachments (drag-drop/paste/browse, via the same WYSIWYG editor and attachment model chat uses) and urgency/tags buttons matching the on-card `PropertyDropdown`/tag row.
- **mem0 sidebar health indicator**: new `GET /api/usage/mem0-status` checks mem0/embeddings/Qdrant in parallel and shows a 4-level colored dot in the sidebar (polled every 30s), linking to Settings → Memory.
- **Selectable backup export/import**: choose which parts to include (database, workspace conversation transcripts, settings, home config) instead of an all-or-nothing backup.
- **TUI cockpit launcher** button in project/workspace terminal tabs, and the underlying `vibe-tui` tmux session is now killed when its tab closes (previously kept running detached in the background).
- **Prompt cache / KV-cache telemetry**: new counters and a mini-dashboard in Settings → Usage.
- **AntigravityHeaded executor mode** with a tmux session runner and schemas; Antigravity's log normalizer gained unified diffs, relative paths, category detection, and more robust stderr/token-usage handling.
- **OpenCode headed sessions** now mirror live SSE events into the message store instead of only showing output after the run finishes.
- **Workspace-chat conversation cache**: finished execution processes are cached in the browser (in-memory + localStorage, 60-process LRU, 4 MiB guard), so switching between workspaces reuses cached entries instead of re-streaming every historic process over the websocket.

### Fixed

- **Terminal tab close required two clicks**: the close button was nested inside the tab's own select handler (and, on the floating drawer, closing a tab didn't close the panel). Moved the close button to a sibling element with a real hit area, shown on every tab including the last, and wired it to close the whole panel on the floating drawer — one click now reliably closes.
- Terminal xterm callbacks stabilized to stop DOM unmount on title updates and keep keyboard focus; launch scripts now get `0o700` permissions with a responsive auto-confirm and cleaned-up warnings.
- Pipeline stage now resets on **any** coding-agent run (previously only the initial one), so a follow-up execution doesn't keep showing the previous run's stage; pipeline progress is preserved across a chat reply, and `memory_save` is gated to Done cards.
- Removed the startup MCP auto-injection into every installed agent's config (a source of API drift between the dev server and the published binary) in favor of explicit, user-driven setup; the interim wrapper-script workaround commits are superseded by this removal.
- Create-issue dialog: title no longer resets on every keystroke (unstable default-prop array reference was re-running the form-reset effect), description box no longer shows a stray duplicate border, and Close-button focus timing plus a global Enter-to-save listener were fixed.
- Archive dialog: `ArchivedIssuesDialog` now has a stable modal id (`NiceModal.create`), and `/v1/issues/archived`'s bare `{issues}` response shape is now parsed correctly.
- Workspace-chat input now focuses automatically when a workspace is opened from a card.
- Claude Code auth-failure stderr now surfaces recovery guidance instead of a raw error.
- Fixed a canonical-path resolution logging spam and a Gitea test failure in `utils`.
- Quick pipeline's prompt now explicitly instructs the agent to emit a `TodoWrite` checklist so the Tasks view populates.
- Fixed Issue test fixtures missing the `archived`/`archived_at` fields added by the archive feature.

### Changed

- Removed the "mark card Done via chat" auto-instructions from the memory-stage prompt across all 9 bundled pipelines, keeping only the save-gate and recall/save instructions.
- Terminal tab bar restyled: tabs left-aligned, with the "Painel Terminal" label, TUI launcher button, and close `X` on the right.

## [0.2.35] - 2026-08-21

### Added

- **mem0 real graph navigation**: new `/graph/traverse` endpoint (proper multi-hop BFS, replacing the old substring-match-plus-one-hop `/graph/neighbors`) and a `memory_graph_traverse` MCP tool, so agents can ask "what's connected to X" instead of only "what reads similarly to this text."
- **mem0 fact/graph provenance & staleness checking**: every saved fact and graph node/edge now optionally records the commit SHA it was true at; a new `memory_check_staleness` MCP tool diffs the repo since that commit and flags entities whose referenced code was actually removed since — verified against this repo's own real project memory and commit history, not simulated data.
- **mem0 recall relevance in Settings → Usage**: new "mem0 recall relevance" panel (day-bucketed `top_score`/`avg_score`, weak-call counts). This signal existed before but only in an MCP child process's stderr that nothing captured.
- All 9 bundled pipelines' "memory" stage prompt now instructs the agent to use `memory_graph_traverse` and `memory_check_staleness` instead of judging memory relevance/staleness unaided.
- `report_pipeline_stage` MCP tool for reliable, structured pipeline-progress reporting (ADR-032), backed by a new `current_pipeline_stage` write path; the existing text-marker tracker stays as a redundant fallback.
- Deeper mem0 test coverage (`mem0-vk/test/`): real-embedding recall tests (including an adversarial zero-word-overlap paraphrase case) and live extraction-quality tests against the real configured LLM provider.
- Documented all of the above in [`docs/ADR/ADR-030-mem0-context-drift-measurement.md`](docs/ADR/ADR-030-mem0-context-drift-measurement.md).

### Fixed

- **Reconnected the `containers` MCP-context router**, disconnected for 19 days as collateral damage of the cloud-removal refactor (`e41e2c16`). Every MCP session had been silently running with no workspace context (`get_context` was never a registered tool, `self.context` was always `None`) — affecting any tool relying on the implicit-workspace-context fallback, including the new `report_pipeline_stage` and `memory_check_staleness`.
- Headed coding-agent sessions (Claude Code Headed, OpenCode Headed): Send now works while the agent is mid-turn instead of being disabled, routing through the same live-delivery path the backend already used for idle sessions. Fixed a related stuck-`Stop`-button state when a queued message's target process had already finished by the time it was displayed.
- `mem0-vk`'s extraction failover now retries the next provider when a candidate returns syntactically valid but empty-graph JSON, instead of silently accepting it — fixes a real, observed reliability gap in graph extraction quality.
- `mem0-vk`'s Docker build now actually compiles TypeScript (two-stage build) instead of copying a gitignored `dist/` directory that never existed on a fresh clone.
- Create-mode now recovers a sensible default target branch from the project's last workspace.
- Fixed a test-suite bug where every `mem0-vk` test file called `process.exit()` before its own cleanup `DELETE` request could complete, leaking orphaned Qdrant test collections on every run.

### Changed

- README rewritten in a more sober tone. `mem0-vk/` now ships the real, complete Node/TypeScript implementation in-repo (previously a non-functional Python stub that the README's own setup instructions couldn't actually produce).

## [0.2.34] - 2026-08-20

### Added

- **Multi-Agent Handoff Pipelines & Swarm PM (ADR-025 & ADR-026)**:
  - Added support for per-stage `executor`, `model`, and `reasoning_effort` fields in pipeline configurations (`[[stage]]`).
  - Added bundled `Swarm Multi-Agent` pipeline (`swarm-multi-agent.toml`) with:
    1. Plan (Gemini 2.5 Pro)
    2. Implement (Claude 3.7 Sonnet)
    3. Independent Review (Codex)
    4. **Manual Review & Live Preview Gate** (Dev Server launch & operator verification)
    5. Squash-merge & Done.
  - Enhanced Issue/Card Creation and Pipeline Settings UI to display specialized agent/model badges next to each stage.
  - Documented complete architecture in [`docs/ADR/ADR-025-multi-agent-handoff-pipelines.md`](docs/ADR/ADR-025-multi-agent-handoff-pipelines.md) and [`docs/ADR/ADR-026-swarm-pm-agent-and-manual-review-gate.md`](docs/ADR/ADR-026-swarm-pm-agent-and-manual-review-gate.md).
- **Per-stage mem0 handoff for Swarm Multi-Agent**: each stage now recalls via `memory_search` before starting and saves via `memory_save` before advancing, so a stage picked up by a different CLI or a freshly resumed session isn't starting blind. The plan stage also records an exact file/function map per task so the implementation stage can go straight there instead of re-exploring the codebase.
- **Live CLI model discovery**: new discovery endpoint and WebSocket stream (`useModelSelectorConfig`) that queries each installed coding-agent CLI directly and dynamically populates model pickers, replacing hardcoded model lists across executors (Claude, Antigravity, Cursor, Droid, Copilot, Gemini, Codex).
- **Project-scoped terminals**: terminal panel and selector scoped per project, with drawer UI.
- Dual-mode pipeline editor (Visual Form + Raw TOML) with a custom stage builder.
- `pnpm run tui` shortcut to launch the `vibe-tui` cockpit.
- Comprehensive guide for Swarm Multi-Agent, MCP, and RAG configuration (`docs/SWARM-MULTI-AGENT-AND-RAG-GUIDE.md`).

### Changed

- Interactive live discovered-model pills and dynamic schema dropdown in Settings → Agents.
- Collapsible pipeline progress with persisted expand/collapse state; persisted description-collapse state; grouped pipeline models; compact inline prompt in the sub-issue workspace bar.

### Fixed

- **mem0 is now genuinely optional**: `memory_search`/`memory_save` previously returned a hard tool error on any failure, contradicting their own "best-effort" contract. Every failure path now degrades gracefully (empty results / `stored: false`) instead of failing the calling agent's tool call. An unreachable mem0 logs a warning once per process, then drops to debug for the rest of that session — no per-call log spam. All mem0 activity is now logged under `target: "mem0"`.
- Patch parsing in `/api/agents/models`; merged the HTTP discovery endpoint with the WebSocket stream in Settings so both surfaces stay in sync.
- Eliminated remaining hardcoded model constants, labels, and descriptions across pipeline executors in favor of live discovery.
- Editor mode selector badge and loading spinner now render correctly during pipeline load.
- Core and bundled pipeline stage IDs are protected from accidental modification in the pipeline editor.
- `restart.sh` now purges the Vite cache and refreshes bundled pipeline seeds.
- Sanitized the PM-agent `mcp.json` endpoint and port for local dev.

## [0.2.33] - 2026-08-19

### Fixed

- **Lightweight NPM Wrapper with Robust Redirects**:
  - Configured `npx-cli` `package.json` to publish only the 14KB Node runner (`bin/cli.js`).
  - Added HTTP redirect (301, 302, 303, 307, 308) and `User-Agent` support to `download.ts`.
  - Ensures clean automatic GitHub Release binary retrieval across macOS, Linux, and Windows.

## [0.2.32] - 2026-08-19

### Fixed

- **Remote-Only NPM Packaging**:
  - Removed stale local `dist/` directory from `npx-cli` package to ensure clean runtime binary download from GitHub Releases matching latest DB migrations.

## [0.2.31] - 2026-08-19

### Fixed

- **NPX Launcher GitHub Release Origin**:
  - Corrected `GITHUB_REPO` in `npx-cli/src/download.ts` to `flashlan/vibe-kanban-alternative` so `npx` downloads the `vibe-kanban-alternative` binaries instead of upstream.
  - Added binary alias `vibe-kanban` to `bin` mappings in `package.json` and `npx-cli/package.json`.

## [0.2.30] - 2026-08-19

### Added

- **Google Antigravity (`agy`) First-Class Integration**:
  - Full stream-JSON protocol support with real-time parsing of `step_update`, `agent_response`, and `result` events.
  - Native visual cards (`ToolUse`) in chat for file inspection (`view_file`), search (`grep_search`, `find_by_name`), bash commands (`run_command`), and file edits (`write_to_file`, `replace_file_content`).
  - Streaming text responses via `text_delta` with complete suppression of raw JSON lines in the timeline.
  - Multi-level **Reasoning Effort** selection (`Low`, `Medium`, `High`) in the model selector popover, with automatic safe fallback to `--effort high` for `gemini-3.7-flash`.
  - Auto-permission bypass support (`--dangerously-skip-permissions`).
- **Chat Input Prompt History Navigation**:
  - Terminal-style `ArrowUp` / `ArrowDown` command history navigation in the chat editor.
  - Automatic draft preservation when browsing history and returning to the bottom.
  - Persistent prompt history across browser sessions.
- **Customizable Send Shortcuts**:
  - `Enter` mode enabled by default (send with `Enter`, insert newline with `Ctrl+Enter`, `Cmd+Enter`, or `Shift+Enter`).

### Fixed

- **Proxy Port & Lifecycle Resiliency**:
  - Corrected Vite dev proxy fallback port to `3002` to prevent WebSocket reconnect loops.
  - Added clean process shutdown in `restart.sh` to prevent `cargo-watch` deadlocks on `target/debug/.cargo-lock`.
- **mem0 Memory Refinements**:
  - Shifted from eager startup dumps to on-demand agent MCP retrieval (`memory_search`, `memory_save`) for optimal prompt-cache efficiency.

## [0.2.28] - 2026-08-18

### Added

- **Settings → Memory** — configure the mem0 graph memory at runtime, no
  container restart needed:
  - Enable/disable the memory graph (off = vector-only storage/search).
  - Pick the extraction provider (Groq / OpenRouter / local llama /
    OpenAI-compatible like DeepSeek) and set per-provider base URL, model, and
    API key.
  - **Masked API keys**: the mem0 container returns only a `has_key` flag —
    keys are stored in the container and never round-trip to the frontend.
    Leaving a key field empty keeps the existing key.
  - Config persists in the mem0 volume (`/data/config.json`) across restarts.
- **mem0 runtime config API** (`GET/POST /api/config`): live provider/graph
  updates persisted without rebuilding the container.
- **Extraction provider failover chain**: primary provider first, then any other
  configured provider — falls over on 429 (after backoff), HTTP errors, or
  responses without a parseable JSON object (thinking models like qwen3/gpt-oss
  are handled).
- **Extraction token ledger** (`GET /api/usage/tokens`) — Usage dashboard shows
  tokens per day segmented by provider.
- **Graph persistence as GraphML** on a mounted volume (`/data/graphs`),
  lazy-loaded on first access so graphs survive container restarts.
- **Manual re-extract** in Settings → Usage for memories stored before an
  extraction LLM was configured.

## [0.2.27] - 2026-08-18

### Added

- **Project Memory (mem0)** — first-class cross-session memory for every coding
  agent. Workspaces recall repository memories at launch and save verified facts
  back on completion, keyed by repository slug so OpenCode, Claude Code, Qwen
  Code, and any other CLI share the same memory:
  - `memory_search`, `memory_recall`, and `memory_save` MCP tools exposed to agents.
  - Backend recall in `start_workspace` (deterministic memory ordering) and a
    `VK-MEMORY:` save-back tracker that persists only self-contained, verified facts.
  - `memory` pipeline stage added to all eight pipelines.
  - **Prompt cache-hit design**: the memory block is injected into the static
    prefix (never after the user question), sorted deterministically so it is
    byte-identical across sessions, injected once, and never mutated mid-session —
    so cloud providers (Anthropic, OpenRouter, DeepSeek, NVIDIA) reuse the prefix
    cache across terminals.
  - Graph memory via mem0 + Qdrant + NetworkX; requires an extraction LLM key
    (Groq / OpenRouter / llama-server) to populate entities and relations.
- **Manual Review stage** — optional `review-manual` stage in every pipeline: the
  agent commits, emits `VK-REVIEW-REQUEST`, and stops; the backend plays the
  notification alarm so the operator reviews the result before any merge/PR.
- **Usage Dashboard** — Settings → Usage with 30-day activity totals, a
  GitHub-style day heatmap, executions-per-day-by-agent bars, and per-project
  issue progress, served by a new `/api/usage/summary` endpoint.
- **Project Archive** — archive a board from the sidebar (`+` → Archive) instead
  of deleting it: it leaves the tree, becomes read-only, and keeps its history in
  an Archived section with Restore and a destructive, cascade-confirmed Delete.
  Backed by a new `projects.archived` column and `PATCH /v1/projects/{id}`.
- **Unique project keys on collision** — when two project names derive the same
  key ("teste" vs "teste2" → both `TEST`), the second now gets a numeric suffix
  (`TEST2`) instead of failing with 400.
- **Default pipeline is now Quick** — with the previously-added memory stage;
  pipeline and stage selections persist in localStorage (`vk-pipeline-selection`).

### Fixed

- **Fallback REST routes** for `issue_relationships`, `pull_requests`, and
  `pull_request_issues` in the local kanban router — resolves the Electric-sync
  "string did not match the expected pattern" network errors at startup.
- **Vite proxy port** — running the frontend dev server separately now requires
  `BACKEND_PORT=3002` so `/api` and `/v1` requests reach the backend instead of
  looping back to the frontend (project creation previously failed with 500).

### Changed

- Kanban cards show the issue **title** instead of the auto-generated ID;
  priority and tags share one row; workspace cards are compact; the description
  is collapsible; the create-workspace heading is smaller.

## [0.2.26] - 2026-08-17

### Added

- **First-class Gitea / Forgejo support** — create pull requests, check their
  status, and read review comments on self-hosted Gitea/Forgejo instances via
  the REST API, alongside GitHub. The provider is auto-detected from each
  project's `git remote` URL, so a board can mix GitHub and Gitea projects and
  each routes independently:

  - `github.com` / `github.*` (Enterprise) → GitHub provider (`gh` CLI)
  - host matching the configured `gitea_base_url` → Gitea provider (reqwest + retries)
  - anything else → a clear "unsupported provider" error

  - `crates/git-host`: `GitHostService` now wraps GitHub + Gitea and dispatches
    by URL; `detection.rs` adds `ProviderKind` and the `is_gitea_remote` helper;
    `GiteaProvider` implements the five PR trait methods.
  - `crates/utils`: `GiteaSecretConfig` loads the token from
    `~/.vibe-kanban/gitea.toml` or the `GITEA_TOKEN` env var — **never** from
    the app config or the repo, so it can't leak into a commit.
  - Config: `GiteaConfig { base_url, default_branch }` added to the app config
    (v9); Settings gains a **Gitea / Forgejo** card.
  - Server: repo and PR routes pass the Gitea base URL and route the PR
    monitor through the unified `GitHostService`.
  - Docs: `docs/TUTORIAL-GITEA.md` (a screen-by-screen "zero to pull request"
    walkthrough) and `gitea.toml.example`.

- **Qwen Code model selector** — the workspace model picker now surfaces the
  providers and models declared in `~/.qwen/settings.json` (grouped by
  provider, with the configured default model highlighted) instead of a blank
  list. Clicking a model selects it (checkmark) and the clean model id is
  sent to the Qwen ACP `session/set_model`.
  - `crates/executors`: `QwenCode::load_settings_models()` parses
    `modelProviders` + `model` from the settings file and feeds the
    `ModelSelectorConfig`; the executor now launches the `qwen` binary from
    PATH rather than pinning an `npx -y @qwen-code/...@0.9.1` invocation.

- **Clear-message action in the chat editor** — a trash button appears in the
  chat box footer (only when there's a draft, the session is idle, and the box
  is not in edit mode) to wipe the composer and its persisted draft.

- **npm release: `vibe-kanban-alternative@0.2.26`** — this fork is now
  installable from the public npm registry under the name
  `vibe-kanban-alternative` (published as account `datapoint`):

  ```bash
  npx vibe-kanban-alternative
  ```

  The package ships the web app plus prebuilt `vibe-kanban`, `vibe-kanban-mcp`
  and `vibe-kanban-review` binaries and the `npx-cli` launcher.

### Changed

- `package.json`: package renamed from `vibe-kanban` → `vibe-kanban-alternative`
  and `private` removed so the project can be published to npm.
- `local-build.sh`: the Rust build step now falls back to the prebuilt release
  binaries when `cargo` is not on `PATH`, so `npm pack` / `npm publish` (which
  trigger `prepack`) succeed without a full toolchain.

### Fixed

- **Blocking a repo removal with a clear message** — removing a repository
  still linked to an active workspace no longer silently "succeeds". The
  backend now returns a `409` with a structured `DeleteRepoConflict { message,
  workspaces }` payload, and the Settings → Repositories panel shows a message
  naming the blocking workspaces ("This repository is still linked to active
  workspace(s): … Remove or archive those workspaces first, then retry.").
  - `shared/lib/api.ts` now surfaces the structured `error_data` on
    `ApiError`; `machineClient.deleteRepo` is typed against the new payload;
    `ReposSettingsSection` reads the conflict and renders the localized message.
- **Qwen model id corruption** — `sanitize_model_id` normalises the model id
  before it reaches the Qwen ACP session, stripping stray UI quotes and any
  `provider/model` prefix so the *bare* id (as written in `~/.qwen/settings.json`)
  is what `session/set_model` receives.

## [Unreleased]

### Added

- **Four new terminal theme variants** — Violet Synth (magenta-on-violet
  synthwave with cyan status accents), Ghost White (P4 white-phosphor
  monochrome VDU), Redline (alert-red console, amber warnings) and Paper TTY
  (light hardcopy teletype, ribbon-red ink), bringing the skin set to eight.
  Paper TTY is the first *light* variant and pins its own surface aliases so it
  looks the same whether the app is in Light or Dark mode. Drop-in as ever: CSS
  file plus `themes/index.json` entry, no rebuild.
- **Project-scoped relationship reads** (VIBE-3). `GET /api/issue-relationships`
  now also accepts `?project_id=<id>`, returning the project's whole edge set —
  every row with either endpoint in the project — in one call. The lane
  dependency gate previously had to ask "what does X block" per card, one HTTP
  request per non-terminal card every sweep, which is what forced it to cap the
  gate and hold candidates it could not verify. The existing `?issue_id=` scope
  is unchanged (that issue's outgoing rows only); exactly one scope is required.

### Fixed

- **Restored the MCP issue + project tools** — `list_issues`, `get_issue`,
  `create_issue`, `update_issue`, `delete_issue`, `list_issue_priorities` and
  `list_projects`. They were deleted as collateral of the cloud-stack removal
  (`e41e2c16`), which took `remote_issues.rs` / `remote_projects.rs` with it even
  though both talked to the *local* REST routes — only the module names said
  "remote". The result was silent and total: every board-driving agent
  (orchestrator, intake, product) lost its entire card surface on
  `0.2.24-beta.*`, with a dead orchestrator for anyone on the `beta` dist-tag.
  Recovered from the deleting commit's parent rather than rewritten, so the
  response shapes stay byte-compatible with `0.2.23` — in particular
  `list_issues`' thin rows, `update_issue`'s minimal ack, and the
  `updated_at` stamp the orchestrator's card cache compares by exact string
  equality. Modules are now `issues.rs` / `projects.rs`; nothing "remote"
  remains. `list_issues`' filter set is unchanged except `assignee_user_id`,
  whose backing field no longer exists after the user-entity excision.
  The global-mode tool-name set is now pinned by an exact-set test, so this
  class of regression fails `cargo test` instead of shipping. See
  `docs/ADR/ADR-023-mcp-card-tool-surface.md`.

## [0.2.24-beta.1] - 2026-08-05

### Added

- **Two pipeline families, never mixed.** Bundled pipelines now split by
  execution family: `async-claude-{opus,sonnet,fable}` bind Claude Code models
  (Sonnet / Opus / Fable), the new `async-opencode-glm` binds OpenCode models
  (GLM / MiniMax / Kimi), and no pipeline mixes the two. Codex remains the
  shared *reviewer* for both families and is never a build model.
- **`quick.toml`** — the trivial-tier pipeline (implement + merge; no spec, no
  plan, no subagent fan-out), with an inline escalation tripwire for work that
  turns out not to be trivial.
- **Late-binding gates in the Async pipelines.** The plan stage reports a
  `PLAN-FACTS:` line (size / steps / files / open decisions); the Codex plan
  review now runs only when the plan is ≥ 40 KB, carries open decisions, or the
  card's routing forces it (a `PLAN-GATE:` line either way), capped at two
  passes; the coder stage binds its model **within the pipeline's family**
  before delegating (`CODER-MODEL:` line). Measured on real boards, a Codex
  plan review routinely costs more than the plan it reviews, and plan size is
  the strongest predictor of a card blowing up.

### Changed

- **`async-{opus,sonnet,fable}.toml` renamed to `async-claude-*.toml`.**
  Display names are unchanged. A pristine copy of an old file is swept from
  `~/.vibe-kanban/pipelines/` on the next backend start (two shipped versions
  are recognised) so the same pipeline is never listed twice; an edited copy is
  treated as user content and kept.
- The Settings pipeline list now offers **Reset** for every bundled pipeline —
  the `async-*` and `quick` ids were missing from the frontend's bundled set
  even though the server accepted them.
- The bundled OpenCode subagents learned the new board conventions:
  `vk-intake` routes a card to a family + tier and can file dependent/parallel
  **lanes** (`blocking` edges); `vk-sweeper` gates dispatch on those edges,
  takes lighter tiers first, and treats a `VK-ESCALATE:` final message as a
  park.

## [0.2.23] - 2026-07-17

### Fixed

- **Headed sessions no longer 500 on large task prompts.** A headed
  `start_workspace` (Claude Code Headed / OpenCode Headed) packed the entire agent
  invocation — env prefix + flags + the full seed prompt — into `tmux new-session`'s
  single command argument, which tmux ships to its server over a unix socket capped at
  `MAX_IMSGSIZE` (16 KiB). A spec-sized prompt (>16 KiB) tripped tmux's "command too
  long" and surfaced as an HTTP 500. `tmux_new_session` now writes the invocation to a
  self-deleting launch script and hands tmux only the short `sh <path>`; the prompt
  still reaches the agent as its positional seed argument. The non-headed path was
  unaffected (it `execve`s the argv directly).

## [0.2.22] - 2026-07-17

### Added

- **OpenCode Headed agent type — an alternative to Claude Code Headed.** A new
  `OPENCODE_HEADED` executor runs the opencode TUI inside a detached tmux session
  (mirroring the `ClaudeCodeHeaded` pattern), so a solo dev can drive the board with
  opencode instead of Claude Code. Includes the full agent-type plumbing (enum
  variant, profile, generated TS types/schema, UI icon), a dedicated
  `start_detached_tmux_opencode` launch path (free embedded-server port, `--prompt`/
  `-c` resume, `autoupdate:false` to suppress the update modal, permission/compaction
  env), generalized `BaseCodingAgent::is_headed()` detection across all sites, and
  lifecycle-only tracking. The orchestrator executor is now parameterized
  (`SpawnOrchestratorRequest.executor`) so it can later run on OpenCode; the Claude
  backend stays the default. Bundled in-repo opencode subagents
  (`vk-sweeper`/`vk-decider`/`vk-intake`) are seeded into the opencode config when
  opencode is already installed. Full output mirroring via the TUI's embedded server
  is the remaining follow-up for an OpenCode orchestrator.

## [0.2.21] - 2026-07-16

## [0.2.20] - 2026-07-16

### Fixed

- **Starting the Orchestrator no longer errors trying to spawn the retired
  `sweeper` agent.** The `vibe-kanban-indie` plugin replaced the orchestrator/sweeper
  split with a single-loop orchestrator and removed the `sweeper` agent, but the app
  still composed a default-agent loop-manager brief whose first tick step was to
  spawn `vibe-kanban-indie:sweeper` — failing with `Agent type 'sweeper' not found`.
  The app now launches the orchestrator as the plugin's own session agent
  (`--agent vibe-kanban-indie:orchestrator`) with the plugin's short per-tick
  pointer as the `/loop` body; every remaining `sweeper` reference in source, docs,
  and comments is gone. The opt-in directives block is unchanged.

## [0.2.19] - 2026-07-16

## [0.2.18] - 2026-07-15

### Fixed

- **The orchestrator can now spawn its sweeper when started from the app.** It is
  launched as the default Claude session instead of
  `--agent vibe-kanban-indie:orchestrator`. Selecting a plugin agent as the
  top-level session agent left the plugin's sibling agents
  (`sweeper` / `decider` / `intake`) unregistered as spawnable subagent types, so
  every tick failed at the sweep step with `Agent type 'sweeper' not found` (and
  `--plugin-dir` did not fix it). The default agent registers every enabled
  plugin's agents, so those siblings resolve; the loop-manager behaviour now
  travels in the self-contained `/loop` brief the app composes rather than in the
  plugin's `orchestrator` agent definition.

## [0.2.17] - 2026-07-14

### Added

- **Async Opus bundled pipeline.** A third Async pipeline: Opus subagents write
  the spec and the plan, a Sonnet subagent writes the code, and Codex reviews
  both the plan and the diff. It seeds automatically into existing installs and
  lists between SpecKit and Async Sonnet.

### Changed

- **The three Async pipelines now default to Merge to base on and Review via
  Codex off.** Their merge stage tells the agent to squash-merge the card's
  branch into its base itself — the stage being listed is the authorisation, so
  it does not wait for a go-ahead. Add a **Wait for approval** stage when you
  want the pipeline to pause for you.
- **`get_execution` MCP response slimmed.** Prompt strings in the execution
  payload (including nested `next_action` chains and legacy untagged JSON) are
  now head-truncated, so status polls stop re-sending the full coding-agent
  prompt (measured 73% smaller on a real execution). `run_session_prompt` is
  unaffected and still returns the full payload.
- **`update_issue` MCP response minimised.** The tool now returns a flat ack
  (id, simple_id, status, status_id, updated_at, changed fields) instead of
  echoing the full card back — a changed description reports only its
  character count. Callers needing the body call `get_issue`. Also drops the
  post-PATCH detail fan-out, cutting a status-only update from ~8 HTTP
  requests to 3.
- **Bundled pipeline seeds synced with the live pipelines.** The Basic,
  SpecKit, WikiLLM, and Async trio seeds in `assets/pipelines/` now carry the
  same spec/plan-prompt and squash-merge-stage fixes as the operator-local
  copies, so a Settings Reset or fresh install no longer hands out stale
  prompts.
- **Basic pipeline's merge stage is now a CAS-safe squash auto-merge**,
  enabled by default. It squash-merges the card's branch into its base with a
  compare-and-swap `update-ref`, verifies with monotonic ancestry
  (`git merge-base --is-ancestor`) rather than tip equality, and resolves
  rebase conflicts via `git add` + `git rebase --continue`.

### Removed

- **Retired-`async.toml` auto-removal.** The preserved copies of the old bundled
  `async.toml` (retired in 0.2.14 in favour of Async Sonnet and Async Fable) have
  been dropped, so a pristine `async.toml` left in `~/.vibe-kanban/pipelines/` is
  no longer removed for you on start-up — delete it from the Settings pipeline
  list if you still have one. The retirement mechanism itself is unchanged and
  stays available for future bundled-pipeline retirements.

### Fixed

- **MCP `update_issue` with `parent_issue_id: null` now un-nests the issue.**
  A JSON `null` previously collapsed to the same "not provided" state as an
  omitted field, so sending it silently no-op'd instead of clearing the
  parent. Clients that were sending `null` as a lazy "leave it alone" should
  now omit the field instead.

## [0.2.16] - 2026-07-11

## [0.2.15] - 2026-07-10

## [0.2.15-beta.2] - 2026-07-10

### Fixed

- **CI: pin npm to the 11.x line for publishing.** npm@12.0.0 crashes during
  `npm publish` (`MODULE_NOT_FOUND: sigstore` in its bundled `libnpmpublish`
  when OIDC trusted publishing attaches provenance), which killed the
  v0.2.15-beta.1 npm publish after everything else in the release succeeded.

## [0.2.15-beta.1] - 2026-07-10

### Fixed

- **CI: release npm publish and clippy failures.** The `publish-npm` job now
  runs on Node 24 (`npm@latest` moved to npm 12, which requires Node ≥ 22 — the
  v0.2.14 npm publish failed on this, so v0.2.14 shipped as a GitHub release
  only). Removed redundant struct-field wildcard patterns in
  `crates/executors/src/executors/codex/normalize_logs.rs` that the newer
  stable clippy on CI runners rejects.

## [0.2.14] - 2026-07-10

### Changed

- **Async pipeline split into Async Sonnet and Async Fable.** The bundled
  `async.toml` is retired and replaced by `async-sonnet.toml` (Sonnet subagents
  spec, plan, and code) and `async-fable.toml` (Fable subagents spec and plan —
  marked `heavy` — and an Opus subagent codes). In both pipelines the plan
  review and code review are Codex-only; the separate "Review via Fable
  subagent" stage is removed.
- **Bundled pipelines now reach existing installs.** Seeding tracks bundled
  files in `~/.vibe-kanban/pipelines/.seed-manifest.json`: newly bundled
  pipelines are seeded exactly once into existing installs, user edits and
  deletions stay sticky, and a retired bundled file (e.g. the old `async.toml`)
  is auto-removed only when it byte-matches a previously shipped version.
  Fixes stale local pipelines never receiving updates (e.g. the missing
  `heavy` badge from VIBE-3).

## [0.2.13] - 2026-07-03

## [0.2.12] - 2026-07-03

## [0.2.11] - 2026-07-02

### Added

- **Async pipeline** — a fourth bundled pipeline (`async.toml`) built around
  subagent fan-out: an Opus main loop specs and plans, then spawns the
  `vibe-kanban-indie:coder` subagent (Sonnet) to implement from `SPEC.md` +
  `IMPLEMENTATION_PLAN.md`, and runs a Fable review subagent alongside a Codex
  review before merge/PR.

## [0.2.10] - 2026-07-02

### Changed

- **File-based pipelines.** Pipelines are now first-class, user-editable TOML
  files in `~/.vibe-kanban/pipelines/` (bundled defaults `basic`, `wikillm`,
  `speckit`, `async`, seeded on first run). The New Issue "Pipeline" control lets you pick
  a pipeline and tick which of its stages to run; vibe-kanban composes an
  **ordered, numbered** `## Pipeline` block that the execution agent runs
  top-to-bottom (no more agent-side stage selection). Settings → Pipeline now
  edits the pipeline files (raw TOML) with per-file and global reset. Managed via
  a new `/api/pipelines` API. The old in-config `pipeline_steps` catalog is
  deprecated and ignored (retained for config back-compat). The separate SpecKit
  workbench engine is unchanged.

## [0.2.9] - 2026-07-01

### Added

- **SpecKit (Spec-Driven Development) workbench** — a per-feature workbench with
  constitution, specify, clarify, plan, tasks, analyze, and implement stages,
  plus matching SpecKit pipeline steps in the New Issue Pipeline catalog.
- **Recall / Enrich knowledge-base pipeline steps** — "Recall prior knowledge"
  (distill relevant project knowledge into `PRIOR_KNOWLEDGE.md` before planning)
  and "Enrich knowledge base" (record reusable knowledge from what shipped).
- **Native SwiftUI macOS app** (`apps/macos`) — a native VibeKanban desktop
  shell that embeds the backend.

## [0.2.8] - 2026-06-19

First stable release on the `0.2.8` line — promotes the `0.2.8-beta` series to
`@latest`.

### Added

- Two built-in pipeline steps in the New Issue Pipeline control and the Pipeline-steps
  settings catalog: **Wait for approval** (pause and wait for the operator's decision
  before continuing) and **Update documentation** (update the docs the change affects).

### Changed

- `default_pipeline_steps()` reordered so **Orchestrate (auto-drive)** is the first item
  (its prompt no longer says "the stages above"); `Wait for approval` sits after `Review
  plan` and `Update documentation` after `Review code`. Regenerated `shared/types.ts`.

### Documentation

- New leading **Vibe Kanban Indie** docs chapter (`docs/indie/`) reviewing every fork
  divergence from upstream: `whats-different`, `architecture` (local-first, fallback
  transport, MCP modes), and `agents-and-pipelines`.
- New **Claude Code Plugins & Skills** integration page documenting how the
  `vibe-kanban-indie`, `sombrax-telegram`, and `sombrax-codex` plugins from the
  `sombrax_plugins` marketplace link to Indie.

## [0.2.8-beta.6] - 2026-06-17

### Changed

- Version bump.

## [0.2.8-beta.5] - 2026-06-16

### Added

- New "noir-neon" theme.

### Changed

- Logo component updates.

## [0.2.8-beta.4] - 2026-06-15

### Added

- Claude Code Headed support for local workspaces.
- Right-side "New issue" pane.

### Changed

- `scripts/kill-dev-servers.sh` now clears the cached `.dev-ports.json` by
  default so the next `pnpm run dev` re-scans from port 3000 (`--keep-ports`
  preserves the cache).

## [0.2.8-beta.3] - 2026-06-15

i18n maintenance release.

### Fixed

- **Missing `cardPipeline` translations** — added the `agentLabel`,
  `agentDefault`, and `agentHelper` keys to the `es`, `fr`, `ja`, `ko`,
  `zh-Hans`, and `zh-Hant` `common` locales, restoring translation-key
  consistency with `en` and unblocking the `frontend-checks` i18n CI gate.

## [0.2.8-beta.2] - 2026-06-14

Workspace + release-pipeline housekeeping (no runtime changes).

### Changed

- **Cargo workspace version/deps inheritance** — every member now inherits its
  version and edition from `[workspace.package]` (releases are a one-line bump),
  and all dependencies are centralized in `[workspace.dependencies]` with crates
  referencing them via `dep.workspace = true`. Dependency features are merged at
  the workspace level for consistent, cache-friendly incremental builds.
- **Lean prerelease builds** — `release-indie.yml` now picks its build matrix from
  the tag: beta/rc tags build **macOS arm64 only**; stable tags build all 6
  targets.

## [0.2.8-beta.1] - 2026-06-14

First prerelease on the new **beta channel**. Install with
`npx vibe-kanban-indie@beta`.

### Added

- **npm beta/prerelease channel** — `release-indie.yml` now derives the npm
  dist-tag from the version string (`X.Y.Z-<id>.N` → `@<id>`; stable → `@latest`),
  so prereleases publish to `@beta`/`@rc`/`@alpha` without ever clobbering
  `@latest`. Prerelease tags also create GitHub *pre-releases*, keeping the CLI's
  `releases/latest` manifest pointer on the last stable build. See `PUBLISHING.md`.

## [0.2.7] - 2026-06-13

Orchestration release.

### Added

- **Per-card pipelines** — a config-driven stage catalog with New Issue
  checkboxes appended to the card description and an Orchestrate-card hand-off.
- **Orchestrator agent** — a repo-independent singleton headed session that
  drives a card through its pipeline, with an auto-answer `decider` subagent
  that resolves stale agent questionnaires after a two-tick grace.
- **Worktree default folder** and **iTerm tab naming** for headed sessions.

## [0.2.6] - 2026-06-06

A CI hygiene release.

### Removed

- **Upstream BloopAI deploy/release workflows** — the relay/remote
  deploy + release workflows (which dispatched to BloopAI's private deployment
  repo or used BloopAI custom actions), the old `pre-release.yml`/`publish.yml`
  binary+npm pipelines, and the now-orphaned `setup-jsign` action. Two of them
  ran on every push to `main` and failed. This fork's CI is `test.yml` and it
  ships via `release-indie.yml` — neither touches upstream infrastructure.

## [0.2.5] - 2026-06-06

A maintenance release tightening the release process and polishing interactive
sessions.

### Added

- **Interactive terminal tab titles** — headed terminal tabs are now titled with
  the card id + branch so multiple live sessions are easy to tell apart.
- **`make release-check`** — a local mirror of the CI test workflow to run before
  pushing a `v*` tag, since the release workflow publishes without running tests.
- **`agentWorking` status string** — added across all locale bundles.

### Fixed

- Cleaned up the v9 config round-trip test to use struct-update syntax.

## [0.2.4] - 2026-06-05

A follow-up to the Claude Code Headed release: deeper orchestration hooks for
headed sessions, a spec-intake flow, configurable terminal-window grouping, new
CRT theme skins, and in-app Git commit actions.

### Added

- **Generate spec from a brief** — the New Issue flow can expand a short brief
  into a full technical task by running an agent in an ephemeral throwaway
  workspace.
- **Headed questionnaire bridge** — headed agents in plan mode now surface
  `AskUserQuestion` / `ExitPlanMode` prompts to the UI and MCP.
- **CRT / terminal theme variants** — three drop-in "skins" (Navy HUD, Phosphor,
  Amber) applied as a client-side theme axis orthogonal to Light/Dark/System
  (local web only). New skins can be added by dropping a CSS file plus manifest
  entry, no rebuild required.
- Expose Claude Code Headed agent progress and identifiers to the orchestrator
  via MCP, and route MCP headed follow-ups into the live tmux session instead of
  spawning a new agent.
- Accept MCP launcher options (`headed-local-control`, `mode`) as env vars for a
  declarative `.mcp.json`.
- Headed sessions can report to their branch's Telegram channel (VIBE-8).
- Show Claude Code Headed session IDs in the workspace right pane, with a button
  to copy the full `tmux attach` command.
- Group headed iTerm2 sessions as tabs of a single VK-owned window, controlled by
  a new `iterm_tabs` config option (default on, Settings → General → Interactive
  Terminal); turning it off restores one-window-per-session behavior.
- **Commit** action for uncommitted worktree changes, available both in the Git
  toolbar and the per-repo RepoCard git-actions dropdown (shown only when the
  repo has uncommitted changes).
- A product-manager agent.

### Changed

- Updated branding: new logo, restored wordmark/lockup sizing, and the
  feather+wordmark lockup moved beside the left rail in the navbar.
- Reduced the app-wide text scale (root font-size to 87.5%) so rem-based text and
  spacing shrink across the app.

### Fixed

- Suppress noisy "Unrecognized JSON message" log entries for `queue-operation`
  transcript records emitted by headed interactive sessions.

## [0.2.3] - 2026-06-02

The headline is **Claude Code Headed**: a new executor that runs Claude Code in a
real interactive terminal (detached tmux) instead of the headless `-p` stream,
mirrors the live transcript read-only into the timeline, and gives the operator a
full control surface from the web UI.

### Added

- **Claude Code Headed agent** — a new executor type, a thin wrapper over Claude
  Code that the container launches via a detached tmux session with an attached
  terminal viewer.
- Run Claude Code in a spawned terminal via detached tmux (interactive mode).
- Operator control surface for the headed agent: `open-terminal` + `send-input`
  REST endpoints, tmux `send-keys`, and a frontend `InteractiveControlBar`; tmux
  and Claude session IDs are surfaced in the panel header.
- Chat box sends straight to the live agent when it is idle, instead of queueing.
- Tool approvals from a headed session are bridged to the web UI via a `PreToolUse`
  hook, so headed and headless gate the same set of tools.
- Optional Sombrax Telegram channel for headed sessions, with auto-confirmed
  startup (waits 5s before auto-confirming the folder-trust / dev-channel prompts).
- Turn duration shown in seconds for headed turns.
- New **"Default (latest)"** model option that omits `--model` so Claude uses its
  own current default model.
- `vibe-kanban-mcp` is now fully local — the project/issue/org tools no longer call
  the disabled cloud API.
- `Makefile` with an `install` target for `vibe-kanban-mcp`.
- PM intake agent that turns channel requests into vibe-kanban issues.

### Changed

- Pinned Claude Code bumped to 2.1.159 (defaults to Opus 4.8).
- Config: DB restored as the source of truth; TOML is now export/import-only.

### Fixed

- Headed `send-keys` now targets the bare tmux session, not the `=name` form
  (which swallowed input).
- Stop the headed "working" spinner when Claude finishes a turn.
- Canonicalize the transcript cwd; keep the iTerm2 window open.
- Attach the interactive config in both the `start_workspace` and queued-start
  paths.

## [0.2.2] - 2026-05-28

- Migrate to the stable Rust toolchain.
- i18n parity fix for the new Telegram keys.
- Skip backend-remote-checks in CI for the indie fork.

## [0.2.1] - 2026-05-28

- Fix CI toolchain mismatches: pin `sqlx-cli` to 0.8.6, install the pinned
  toolchain explicitly in `release-indie`, and pin `mlugg/setup-zig` to 0.13.0 so
  transient mirror 404s don't break the linux-musl matrix legs.

## [0.2.0] - 2026-05-26

- Local-first **vibe-kanban-indie**: TUI cockpit, Telegram orchestration, and the
  npm release pipeline. First independent, self-hosted (no team, no cloud, no auth)
  release of the fork.

[0.2.26]: https://github.com/flashlan/vibe-kanban-alternative/compare/v0.2.8...HEAD
[Unreleased]: https://github.com/flashlan/vibe-kanban-alternative/compare/v0.2.8...HEAD
[0.2.8]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.8
[0.2.8-beta.6]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.8-beta.6
[0.2.8-beta.5]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.8-beta.5
[0.2.8-beta.4]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.8-beta.4
[0.2.8-beta.3]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.8-beta.3
[0.2.8-beta.2]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.8-beta.2
[0.2.8-beta.1]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.8-beta.1
[0.2.7]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.7
[0.2.6]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.6
[0.2.5]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.5
[0.2.4]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.4
[0.2.3]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.3
[0.2.2]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.2
[0.2.1]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.1
[0.2.0]: https://github.com/flashlan/vibe-kanban-alternative/releases/tag/v0.2.0
