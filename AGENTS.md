> **Aurapunk IDE** — the independent, self-hosted fork of vibe-kanban (BloopAI), built for a **single-developer process** (no team, no cloud, no auth). It is based on the **Vibe Kanban Indie** fork (dexloom) and carries forward its solo-dev, self-hosted spirit. The TUI cockpit (`crates/tui`, `aurapunk-tui`) and Telegram channel orchestration (`crates/telegram-bridge`) are the control surfaces a solo dev uses to drive a crew of agents.

## Board Status (agent-maintained checklist)

This file (`AGENTS.md` at the repo root) is read by **every** agent that works here — Claude Code, OpenCode, Codex, Cursor, and any other `agents.md`-compatible tool. Keep the checklist below as a shared, at-a-glance snapshot of active kanban work so any agent can see what is planned, in flight, in review, and done **without re-querying the board**.

Update it as you move cards through their lifecycle. One line per active card:

- [ ] **TODO** — <short card title> (`<branch>`)
- [~] **In Progress** — <short card title> (`<branch>`)
- [ ] **In Review** — <short card title> (`<branch>`)
- [x] **Done** — <short card title> (`<branch>`)

Rules:
- Move a card `[ ]` → `[~]` → `[x]` as it advances (TODO → In Progress → In Review → Done).
- Add a line when you start a card; archive/remove completed lines periodically so this stays short.
- Use the branch name (e.g. `vk/xxxx-slug`) so another agent can `git switch` straight to the work.
- This is a lightweight manual convention, not an automated sync — accuracy depends on agents keeping it current.

- [x] **Done** — AGENTS.md board-status checklist (`vk/8dfb-o-agent-md-na-ra`)
- [x] **Done** — Add image attachment to create issue dialog description (`vk/5f5b-feature-adicioan`)
- [x] **Done** — Add urgency and tags buttons to create-issue dialog (`vk/160b-feature-definir`)
- [x] **Done** — Browser cache for workspace conversations to skip re-stream on switch (`vk/f804-poss-vel-cache-d`)
- [x] **Done** — Workspace color setting (sidebar tree tint) (`vk/3585-altra-cor-do-wor`)
- [x] **Done** — Novo tema com paleta de referência (`vk/58a0-tema-horr-vel`)
- [x] **Done** — Pausar rolagem automática do chat ao usar a roda do mouse (`vk/d924-melhor-rolagem-n`)
- [ ] **In Review** — Graphify add-on + aba Add-ons em Settings com render do grafo mem0 (`vk/d683-adicioanr-https`)
- [ ] **In Review** — Livro Vibe Kanban na Amazon — checklist + manuscrito completo (15 caps + apêndice + Agradecimentos, ~1.830 linhas, 12 âncoras) (`vk/1f98-livre-vibo-kanba`)
- [x] **Done** — Banner de estrela no GitHub na barra superior (`vk/6d8a-implementar-bann`)
- [x] **Done** — Imagem Docker Hub all-in-one do mem0 (`vk/dockerhub-mem0-all-in-one`)
- [x] **Done** — Protected terminal completion with Integration Guard and Mem0 (`main`)
- [x] **Done** — Settings: Appearance & Typography, custom theme editor, backgrounds, gradients, fonts, and theme export/import (`vk/8381-settings-fonts-s`)
- [~] **In Progress** — Gate hosted Mem0 behind Cloud login and plan quotas (`vk/cloud-mem0-login-gate`)

## Card Pipeline Protocol (MCP)

A card's description now carries only a **compact pointer** to its pipeline, not the full stage list — the heavy content lives behind the `get_pipeline` MCP tool instead, so it doesn't bloat every model call. When a card's description mentions `get_pipeline`:

- Call it (workspace-scoped; `workspace_id` is optional if you're already running inside that workspace) **before any code edits**.
- Execute the stages it returns **in the order given** — do not add, skip, or reorder.
- After completing **each** stage, call `report_pipeline_stage` with that stage's number AND emit the line `VK-PIPELINE-STAGE: N` before moving to the next one — repeat this for every stage, not just the first. (The tool's own response restates this reminder on each stage entry — re-read it as you go, don't rely on having read it once at the start.)
- Empty `stages` in the response means no pipeline is selected on this card — proceed without one.

A card whose description has no such reference has nothing to fetch — proceed normally.

## Completion and Integration Guard Protocol

When the selected pipeline reaches `Integration Guard → Done`, the execution agent must commit its verified work in the workspace and call `complete_workspace_card` itself as the final action. Do not stop after committing, ask the operator to click Merge or Done, wait for the UI, or claim integration without a successful tool response. Do not run `git merge`, `git rebase`, `git update-ref`, or `git push` manually for this stage. If the tool reports a conflict, dirty target, concurrent integration, or Mem0 failure, leave the card open and report the blocker.

> **Merge blocks are delegable, not dead ends.** Since 2026-09-17 the merge
> endpoints return structured refusals (`DirtyWorktree`, `MergeConflicts`)
> and the kanban UI offers *Stash & retry* / *Delegate to agent*. An agent
> that receives a delegated cleanup prompt must: inspect `git status`,
> stash or commit the real changes, keep generated junk (`db.v2.sqlite`,
> `installer-output/`, `*.log`) OUT of commits (gitignore when missing),
> never push, report exactly what was done, and ask the operator before
> anything destructive or ambiguous. See ADR-044.

## Project Rules Protocol (MCP)

Unlike the pipeline pointer above, this one is **unconditional** — general project rules apply to every card, so there's no pointer text to look for in the description.

- Call `get_rules` **once, at the start of every card's execution**, before any code edits.
- Keep its `pre` guidance in mind **throughout** the work — it covers always-on guardrails (e.g. which repo's memory to use, when to recall before starting).
- Right before finishing, run through its `post` field as a **closing checklist** (e.g. what to save, and what never to save).

# Repository Guidelines

## Project Structure & Module Organization
- `crates/`: Rust workspace crates — `server` (API + bins), `db` (SQLx models/migrations), `executors`, `services`, `utils`, `git` (Git operations), `api-types` (shared API types), `review` (PR review tool), `deployment`, `local-deployment`, `tui` (terminal cockpit, `aurapunk-tui` bin), `telegram-bridge` (send-only escalation daemon, `aurapunk-telegram-bridge` bin).
- `automation/`: Automated-supervision layer (TUI + Telegram bridge + PM agent) — see [`automation/README.md`](automation/README.md). Telegram config lives in `~/.vibe-kanban/telegram.toml` (example: `automation/telegram.toml.example`).
- `packages/local-web/`: Local React + TypeScript app entrypoint (Vite, Tailwind). Shell source in `packages/local-web/src`.
- `packages/web-core/`: Shared React + TypeScript frontend library used by local-web (`packages/web-core/src`).
- `shared/`: Generated TypeScript types (`shared/types.ts`) and agent tool schemas (`shared/schemas/`). Do not edit generated files directly.
- `assets/`, `dev_assets_seed/`, `dev_assets/`: Packaged and local dev assets.
- `npx-cli/`: Files published to the npm CLI package.
- `scripts/`: Dev helpers (ports, DB preparation).
- `docs/`: Documentation files.

### Crate-specific guides
- [`docs/AGENTS.md`](docs/AGENTS.md) — Mintlify documentation writing guidelines and component reference.
- [`packages/local-web/AGENTS.md`](packages/local-web/AGENTS.md) — Web app design system styling guidelines.

## Architecture Decision Records

All ADRs live in **`docs/ADR/`** as `.md` files (numbered, e.g. `ADR-001-modal-system.md`, with `Status`/`Date`/`Context`/`Decision`/`Consequences`). **Highly advisable to maintain documentation here**: when a non-trivial architecture decision is made (new subsystem, refactor, pattern choice, removed feature), record it as an ADR before or right after the implementation, and keep `Status` accurate (`Accepted` vs `Proposed`). Agents should check `docs/ADR/` for prior decisions before proposing alternatives.

## Legacy cloud/remote code

The fork is local-only; the cloud stack has been removed. The following crates were deleted from disk: `crates/remote`, `crates/relay-tunnel`, `crates/relay-hosts`, `crates/relay-webrtc`, `crates/remote-info`. The `remote:*` scripts in `package.json` and the `backend-remote-checks` CI job have been removed as well. Do not reintroduce them.

Note: `shared/remote-types.ts` (historically generated from `crates/remote`) is NOT dead — it is the live wire-contract for the kanban data layer (`providers/remote/*`, `integrations/electric/*`, `lib/electric/*`), used by the local UI in fallback-REST mode. Keep it and its consumers; treat it as a frozen, hand-maintained contract since its generator has been removed.

## Managing Shared Types Between Rust and TypeScript

ts-rs allows you to derive TypeScript types from Rust structs/enums. By annotating your Rust types with #[derive(TS)] and related macros, ts-rs will generate .ts declaration files for those types.
When making changes to the types, you can regenerate them using `pnpm run generate-types`
Do not manually edit shared/types.ts, instead edit crates/server/src/bin/generate_types.rs

## Build, Test, and Development Commands
- Install: `pnpm i`
- Run dev (web app + backend with ports auto-assigned): `pnpm run dev`
- Backend (watch): `pnpm run backend:dev:watch`
- Web app (dev): `pnpm run local-web:dev`
- Type checks: `pnpm run check` (frontend + all backend Rust workspaces) and `pnpm run backend:check` (all backend Rust workspaces in the workspace)
- Rust tests: `cargo test --workspace`
- Generate TS types from Rust: `pnpm run generate-types` (or `generate-types:check` in CI)
- Prepare SQLx (offline): `pnpm run prepare-db`
- Local NPX build: `pnpm run build:npx` then `pnpm pack` in `npx-cli/`
- Format code: `pnpm run format` (runs `cargo fmt` for all backend Rust workspaces + web-core/web Prettier)
- Lint: `pnpm run lint` (runs web/ui ESLint + `cargo clippy` for all backend Rust workspaces)

## Before Completing a Task
- Run `pnpm run format` to format all Rust workspaces and web code.

## Coding Style & Naming Conventions
- Rust: `rustfmt` enforced (`rustfmt.toml`); group imports by crate; snake_case modules, PascalCase types.
- TypeScript/React: ESLint + Prettier (2 spaces, single quotes, 80 cols). PascalCase components, camelCase vars/functions, kebab-case file names where practical.
- Keep functions small, add `Debug`/`Serialize`/`Deserialize` where useful.

## Testing Guidelines
- Rust: prefer unit tests alongside code (`#[cfg(test)]`), run `cargo test --workspace`. Add tests for new logic and edge cases.
- Web app: ensure `pnpm run check` and `pnpm run lint` pass. If adding runtime logic, include lightweight tests (e.g., Vitest) in the same directory.

## Security & Config Tips
- Use `.env` for local overrides; never commit secrets. Key envs: `FRONTEND_PORT`, `BACKEND_PORT`, `HOST`
- Dev ports are fixed: frontend `3001`, backend `3002`, preview proxy `3003`. Dev assets live in `dev_assets/` (seeded from `dev_assets_seed/`).

## Session Log

Dated notes on what changed and why, so repeat regressions (especially
merge-related ones) can be traced back to the session that introduced or
fixed them. Newest last.

### 2026-09-17 — Merge-block handling end-to-end (dirty tree + conflicts)
- **Problem (seen twice):** moving a card with merge failed with raw git
  stderr (`Invalid repository: CLI merge failed: ...Changes not staged...`
  and later real `CONFLICT (content)` in `AGENTS.md`/`README.md`); the UI
  showed an OK-only dialog and the card silently stayed put.
- **Root causes found:** (1) the guard validated staged changes only —
  unstaged died inside `merge_squash_commit`; (2) textual conflicts were
  wrapped as generic `InvalidRepository`; (3) the frontend narrowed the
  wrong enum shape (`DirtyWorktree` vs actual `type: "dirty_worktree"` —
  the enum is `#[serde(tag = "type")]`), so the new dialog never opened.
- **Implemented:** cleanliness gate in `merge_workspace` (tracked mods
  block, untracked reported); structured `DirtyWorktree` refusal;
  conflict-file parsing → structured `MergeConflicts`;
  `POST .../git/stash` (explicit only) and `POST .../git/delegate-block`
  (queues cleanup instruction to the workspace executor, asks nothing
  unless ambiguous); `MergeBlockedDialog` with Stash & retry / Delegate /
  Move without merging / Cancel (stash hidden in conflict mode).
- **Also shipped:** build stamp (`/api/build-info` + Settings footer:
  version · build N · commit) to trace bundles; `DirtyWorktree` never
  touches `auto_move` (forward-only by design).
- **Validation:** `cargo check -p git/server` clean, `tsc` clean on
  touched files, kanban vitest suites green (50), narrowing proven with
  throwaway tests against the real serialized shapes (removed after).

### 2026-09-17 — "card reverts after a move" race in shape fallback sync
- **Symptom (reported as the old bug returning):** drag a card, it snaps
  back; moving a second card reverts the first — live, without reopening.
- **Root cause:** `createFallbackSync` in
  `packages/web-core/src/shared/lib/electric/collections.ts` cleared
  `refreshPromise` in a `finally`, i.e. AFTER `applySnapshot`. A bulk
  write's refresh call landing while the snapshot applied saw a non-null
  `refreshPromise`, set `hasPendingRefresh`, and got back the
  already-finished promise — so its post-write refetch was swallowed and
  the pre-write rows (full `truncate()` + rewrite) won. Every move could
  resurrect the previous column.
- **Fix:** clear `refreshPromise` BEFORE `applySnapshot`, then re-run
  `refreshNow()` if `hasPendingRefresh` was set while applying, so the
  caller's own write is what lands.
- **Note:** the coalescing itself was added in this session's uncommitted
  work; this is the regression it introduced.

### 2026-09-17 — Sidebar tree: project row navigates, selection reveals
- **Owner feedback:** clicking a project's root entry should open the
  project (not only expand); the tree should reveal the selected card/
  workspace; expansion state must survive restarts.
- **Changes:** `handleActivate` in `SidebarProjectTree.tsx` now navigates
  on a project row click (the caret still toggles; the Unassigned
  pseudo-project keeps disclosure). New pure helpers
  `findNodeIdByPredicate` / `findAncestorIds` in `outliner/openState.ts`
  power a reveal effect: the externally selected card/workspace opens its
  ancestors, gets selected and scrolled into view, and those opens are
  persisted alongside user toggles.
- **Tests:** new `findNodePath.test.ts` (path/finder predicates) plus the
  updated `SidebarProjectTree.test.tsx` activation test; full `@vibe/ui`
  suite green (272).
