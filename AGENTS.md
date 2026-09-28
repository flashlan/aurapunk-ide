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
- [x] **Done** — aurapunk get_pipeline/get_rules MCP tools red: shared port-file misroutes MCP to the wrong backend; fixed via env-pinned backend URL + mem0 account-id fallback + memory settings correspondence; merged to main (`vk/be93-toosl-aurapunk-g`)
- [x] **Done** — Indicador de status do Laya (cloud × Docker) no canto inferior esquerdo da sidebar (`vk/e67c-status-do-laya-n`)
- [~] **In Progress** — Tooltips da barra flutuante (ContextBar) + botão show/hide thinking (`vk/1633-renderizar-toolt`)
- [~] **In Progress** — Merge account+logout and login+signup into single sidebar entries with auth modal (`vk/e59a-mesclar-account`)
- [~] **In Progress** — AskUserQuestion opções não renderizam: harden resolveApprovalQuestions (kind ausente/placeholder) (`vk/d6af-quesiojn-da-llm`)
- [x] **Done** — Claude Code erro: surfaced 401 revoked-login recovery guidance for headed (transcript) sessions + ignore `<synthetic>` model (`vk/5cb6-claiude-code-err`)
- [x] **Done** — Send now no chat mantendo Queue e Stop (`vk/340d-send-now`)
- [x] **Done** — Fast Jev Compaction plugin com fallback Laya como classificador e POC (`vk/cae6-jev-plugin`)
- [x] **Done** — Chat travado ao subir mensagens anteriores: race do cache que estrangula isLoadingHistory e aborta o walk de histórico (`vk/3a4e-caht-da-uam-tr`)
- [x] **Done** — Chat volta pro final ao rolar para cima durante streaming: bottom-lock libera em todo scroll do usuário e follow pausa até descer ao fim; seleção de sessão sticky (refresh/reorder/não-dados não remontam o chat) (`vk/3a4e-caht-da-uam-tr`)
- [~] **In Progress** — Guardião do merge: explica o bloqueio, espera e recusa Done sem merge (`vk/2b51-agent-activity-n`)
- [x] **Done** — Carregamento sob demanda + sync por diff: projeção `?minimal=1`, gate da sidebar, cache de transcript normalizado, janela de histórico, thinking sob demanda, WS kanban com deltas (`vk/4a2c-corrigir-ram`)
- [x] **Done** — Erros de integração (Mem0/Laya/Jev) em balões na sidebar + transcript normalizado gravado no fim do processo + descrição dos cards (delta WS por projeção) (`vk/integration-errors`)
- [x] **Done** — RAM da interface: lazy-load (configurações, terminal, diffs), gaveta mobile só no mobile, logo reduzido, sem Noto Emoji, inspetor opcional (`vk/webview-memory`)
- [x] **Done** — RLCD no backend: guardrails reais (toggles + semântico em comandos), portão de memória do Mem0, auto-compactação compactando o agente (`vk/rlcd-backend`)
- [x] **Done** — RLCD afinado para Laya e Jev + localidade determinística + CI verde (`vk/rlcd-tuning`)
- [x] **Done** — Perf RAM/CPU: chat cache/localStorage, normalização serializada, chats travados no `Ready`, índice git racy após worktree add, cota UTF-16 (Laya Cloud não salvava) (`vk/perf-ram-cpu`)

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
- `automation/`: Automated-supervision layer (TUI + Telegram bridge + PM agent) — see [`automation/README.md`](automation/README.md). Telegram config lives in `~/.aurapunk/telegram.toml` (legacy `~/.vibe-kanban`, migrated at startup) (example: `automation/telegram.toml.example`).
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

## Git Worktree & Stash Hygiene
- This repo has many linked worktrees sharing one object database and one
  **repo-global stash list**. Only pass root-relative paths to git when the
  command's working directory IS the worktree root: run
  `git stash push -- packages/web-core/src/...` from inside
  `packages/web-core` and git rewrites the pathspec to `:(prefix:N)...`,
  which matches nothing and the push fails (observed 2026-09-25).
- Never chain stash operations with `;` — after a *failed* `stash push`, a
  `git stash pop` in the same line silently drops an UNRELATED stash (that
  mistake applied another card's WIP into the wrong worktree). Use `&&`,
  and after any failed push run `git stash list` before touching the stack
  again.

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

### 2026-09-17 — Red `get_pipeline` / `get_rules` MCP tools: wrong backend
- **Symptom:** inside a session the `aurapunk_get_pipeline` and
  `aurapunk_get_rules` tool entries show a red status dot and behave as
  "not available".
- **Root cause:** every AuraPunk server writes one shared temp port file
  (`$TMPDIR/aurapunk/aurapunk.port`); last writer wins. A packaged-app
  workspace (`~/Library/Application Support/ai.bloop.vibe-kanban/db.v2.sqlite`)
  whose MCP read a port file clobbered by a dev server (`:3002`, different DB)
  resolves no workspace context → `get_pipeline` fails with
  `workspace_id is required`; workspace-scoped tools (e.g.
  `declare_agent_work`) 404 entirely. The MCP itself connects fine, so only
  context-dependent tools go red.
- **Fix:** `utils::port_file` now remembers this process' own bound port
  (`active_backend_url()`); `start_execution_inner` (and the headed-resume
  path) inject it as `AURAPUNK_BACKEND_URL` / legacy `VIBE_BACKEND_URL` into
  `ExecutionEnv`, which the executor passes to its MCP child. The MCP client
  prefers those env vars over the port file, so each instance's sessions
  target their own backend regardless of which server wrote the file last.
- **Note:** existing sessions must be restarted to pick up the new env var;
  the global port file is otherwise unchanged (still the fallback).
- **Follow-up (Mem0 gate):** card completion then failed with
  `Integration succeeded, but Mem0 did not acknowledge` — hosted Mem0
  returned HTTP 401 `{"error":"Memory login is required"}` because the MCP
  only sends `X-AuraPunk-Account-Id` when it inherited `MEM0_ACCOUNT_ID`,
  which a session spawned *before* login never has. Fixed in
  `crates/mcp/src/task_server/tools/mem0.rs`: `authorize_mem0` is now async
  and falls back to `GET /api/usage/mem0-account` on its own backend, so
  pre-login sessions authenticate too. `memory_save` confirmed working
  (`stored: true`) afterwards.
- **Activation caveat:** the source fixes only take effect once the *running*
  binary contains them. The packaged `Aurapunk IDE.app` was still the older
  build (`af4d0b84`) and kept its sessions misrouted, while a rebuilt dev
  server (`53427091`) injected the env var correctly. Rebuild/restart the
  packaged app before re-running `complete_workspace_card`.
- **Memory settings ↔ config correspondence:** the self-hosted "Memory source"
  selector's `cloud` option was overloaded with the hosted AuraPunk Cloud:
  clicking "Self-managed Mem0 server" required a signed-in account and
  silently rewrote the URL to the Cloud gateway, so a self-managed endpoint
  could never be selected. `MemorySettingsSection.tsx` now derives the hosting
  mode from the persisted URL itself (`/api/memory/v1` ⇒ AuraPunk Cloud),
  switches self-hosted local/remote sources through a dedicated handler that
  never touches the account, and exposes an editable self-managed URL. The
  AuraPunk Cloud button keeps using the signed-in account (access token as the
  mem0 bearer + account id header).

### 2026-09-17 — Headed AskUserQuestion renders answers in the full workspace
- **Owner feedback:** in the full workspace view (not the kanban chat
  sidebar) a headed agent's question shows only as a transcript entry; the
  chat box falls into the plan "Provide feedback to request changes…" bar
  and never lists the options.
- **Root cause:** `SessionChatBoxContainer.pendingApproval` recovered the
  questions only by scanning normalized `tool_use` entries for a
  `pending_approval` status whose `approval_id` matched the store. Headless
  executors inject that id via their client log; **headed (tmux)** sessions
  go through the `PreToolUse` bridge instead, so the transcript never sees
  the backend id — the scan failed, `questions` was undefined, and the
  `!questions` branch rendered the deny/feedback bar.
- **Changes:** headed approvals already carry `ApprovalInfo.questions`
  inline; the resolver now prefers it and only falls back to the transcript
  scan for headless approvals. Mode selection is driven by the resolved
  `isQuestion` flag (`kind === 'question'` with at least one question), so a
  question approval with options never renders the feedback bar; a question
  with no resolvable options still falls back to approve/deny rather than a
  dead banner. Extracted the pure logic to
  `model/pendingApprovalQuestions.ts` (`resolveApprovalQuestions`,
  `toAskUserQuestionItems`, `findQuestionsInEntries`) and covered it with
  `pendingApprovalQuestions.test.ts`.
- **Verification:** `pendingApprovalQuestions.test.ts` 10/10 passing,
  `tsc --noEmit` clean, Prettier clean (after `pnpm install --offline` in
  this worktree).
- **Note (resolved):** an earlier run in this session saw `get_pipeline` /
  `declare_agent_work` return 404 and `complete_workspace_card` /
  `link_workspace_issue` return 400 for this workspace. Root cause was the
  shared temp port file (`$TMPDIR/aurapunk/aurapunk.port`, last writer
  wins) resolving the MCP against a different backend than this workspace's;
  fixed by `utils::port_file::active_backend_url()` plus injecting
  `AURAPUNK_BACKEND_URL` / `VIBE_BACKEND_URL` into the execution env. After
  installing the new app the MCP resolved the correct workspace context and
  the card was completed.

### 2026-09-18 — MCP control of card statuses + SDLC preset
- **Added `/api` envelope CRUD for project statuses** in
  `crates/server/src/routes/kanban.rs`: `POST /api/project-statuses`,
  `PATCH|DELETE /api/project-statuses/{id}`, plus
  `POST /api/project-statuses/inject-sdlc`. The `/api` router is the only
  one the MCP `send_json` can parse (it expects the `ApiResponse<MutationResponse<T>>`
  envelope); the `/v1/*` status routes return bare `MutationResponse`.
- **Single source for the SDLC preset:** `SDLC_STATUS_PRESET` +
  idempotent `inject_sdlc_statuses(pool, project_id)` now live in
  `crates/services/src/services/project_config/mod.rs` (case-insensitive name
  dedupe, append after max `sort_order`, `deployment` terminal only when the
  project has no terminal column yet). Settings → Card Statuses now calls the
  backend endpoint instead of duplicating the preset and injection loop in TS.
- **New MCP module** `crates/mcp/src/task_server/tools/project_statuses.rs`:
  `list_project_statuses`, `create_project_status` (sort_order defaults to
  append), `update_project_status`, `delete_project_status`,
  `inject_sdlc_statuses`. Registered in `global_mode_router` and pinned in the
  exact-set test `global_mode_exposes_the_full_card_surface`; NOT added to the
  orchestrator router (execution/board agents manage columns).
- **api-types:** `CreateProjectStatusRequest` / `UpdateProjectStatusRequest`
  gained `Serialize` (the MCP client serializes them into request bodies) and
  `InjectSdlcStatusesResponse { added, project_statuses }` was added.
- **Verified:** `cargo check --workspace` clean; `cargo test -p mcp` green
  (46 lib + 12 bin, incl. the router exact-set gate); web-core `tsc --noEmit`
  clean; Prettier clean.

### 2026-09-18 — AskUserQuestion voltou a virar barra Approve/Deny (regressão pós-fix)
- **Sintoma:** na v0.3.7 o `AskUserQuestion` do OpenCode (headless) parou de
  mostrar as opções; o chat caía na barra "Provide feedback to request
  changes..." (Approve/Deny).
- **Causa raiz (frontend, não backend):** o backend entregava certo — entrada
  `tool_use`/`ask_user_question` com `status: pending_approval` e `approval_id`
  batendo com o store. Mas `deriveConversationEntries.ts::finalizeStaleToolStatuses`
  só considerava vivo o turno `agent_running`; um turno parado numa aprovação é
  classificado como `agent_pending_approval`, então o `pending_approval` era
  reescrito para `failed` e `findQuestionsInEntries` (que exige `pending_approval`)
  não achava mais a pergunta → `isQuestion=false` → barra Approve/Deny.
- **Fix:** `isLiveAgentTurn(kind)` trata `agent_pending_approval` como vivo
  (commit `2bc6d928`, main). Coberto por `deriveConversationEntries.test.ts`.
- **Also:** `pendingApprovalQuestions.ts` foi endurecido para (a) aceitar
  `kind` ausente (perguntas resolvidas são a fonte de verdade, excluindo
  `plan_approval`) e (b) ignorar entradas placeholder vazias; `pickPendingApproval`
  prioriza uma pergunta sobre uma permissão de ferramenta concorrente
  (`36ff0528`).
- **Diagnóstico:** o DOM foi inspecionado com Chrome headless via CDP contra o
  app real (`--remote-debugging-port`), capturando `document.querySelectorAll('button')`
  e o fim do `document.body.innerText` enquanto a pergunta estava pendente.

### 2026-09-25 — Guardião do merge falhava aberto (VKAL-57)
- **Sintoma:** merge recusado (outra atividade de agente / integração em
  andamento) → o agente desistia e movia o card para Done. O MCP `update_issue`
  enviava `allow_unmerged_done: true` em TODA chamada e o backend não checava
  nada: a checagem de terminal sem integração tinha sido removida junto com o
  resto do guard em `13e33dfd` (2026-09-17). Resultado: board "tudo ok" sem
  merge nenhum — pior do que não ter guardião. Somado a isso, o motivo do
  bloqueio não chegava ao agente: o transporte MCP descartava corpos não-2xx e o
  payload `error_data` (arquivos conflitantes, agentes sobrepostos).
- **Correção:** guard restaurado em `merge_and_update_issue` (recusa transição
  para coluna terminal quando há workspace vinculado sem merge, salvo
  `allow_unmerged_done`), com a definição de "integrado" centralizada em
  `db::models::merge`; override explícito declarado por cada superfície
  interativa (diálogo do board, command bar, edit dialog, tree, TUI, `/close`,
  mirror remoto) — automação nunca o declara. Envelope MCP (`send_envelope`)
  repassa `message` + `error_data` em qualquer status HTTP;
  `complete_workspace_card`/`merge_workspace` esperam até 45s por
  `integration_in_progress`/`agent_work_conflict` e toda recusa declara "card
  NÃO mesclado, NÃO movido" + próximo passo; `auto_move` só honra `done_intent`
  se o card estiver integrado. Detalhe: ADR-046 (Proposed).
- **Verificação:** `cargo check`/`clippy` limpos (db, server, services, mcp,
  tui); `cargo test -p server local_kanban` 27, `-p services auto_move` 8,
  `-p mcp` 58; web-core `tsc` + vitest 236, local-web `tsc`.

### 2026-09-25 — RAM: chat sob demanda + delta do kanban (vk/4a2c-corrigir-ram)
- **Medição que motivou o card:** `~/.vibe-kanban/.../sessions/` tem **1,0 GB
  em 419 `.jsonl`**; a maior sessão tem 171 MB em 77 processos. Quebrando os 5
  maiores arquivos: **27,15 MB / 87.612 eventos são `message.part.delta`**
  contra 1,59 MB de `part.updated` + 0,68 MB de `message.updated` — ~90% do log
  bruto é ruído de streaming, e o que sobrevive à normalização é ~2,3 MB onde o
  bruto tem ~30 MB.
- **O que rodava a cada abertura de chat (por processo):** JSONL inteiro como
  `String` → `Vec<LogMsg>` → `MsgStore` temporário (cada `push` clona para o
  ring de 100k do broadcast = 2ª cópia) → `ensure_container_exists` (recriava
  o worktree) → normalizador do executor (3ª cópia) → `get_history()` clona de
  novo por conexão. No cliente: objetos JS por entrada (inflação ~3-5x),
  `filteredEntries`/`rows` recriados a cada rAF, `scriptOutputCache` com o
  stdout íntegro, e a transcript inteira em `localStorage`.
- **Cache do transcript normalizado** (`services/normalized_transcript.rs`):
  sidecar `<processo>.normalized.json` ao lado do bruto, chaveado por
  (size, mtime) do JSONL, escrito só quando a coleta completa. `ContainerService::normalized_transcript`
  consulta loja em memória → cache → normalização; `stream_normalized_logs` só
  faz replay. Corta re-parse, `MsgStore` temporário, worktree e re-normalizar.
- **Janela em vez de transcript inteira:** novo
  `GET /api/execution-processes/{id}/entries?from_index=&limit=&include_thinking=`
  serve um recorte do materializado; `useConversationHistory` passou a buscar
  janelas (`HISTORIC_WINDOW_ENTRIES = 200`) por HTTP, com page-up no scroll
  (`loadOlderWindow`) em vez do walk em background. O WS por processo continua
  só no reload after-finish (processo ainda com store em memória).
- **Thinking sob demanda:** o servidor devolve `content` de `thinking` vazio e
  marca `thinking_omitted`; `DisplayConversationEntry` busca com
  `include_thinking=true` no expand e o hook reaplica via `onThinkingHydrated`.
- **Kanban por delta:** `HookTables` ganhou `issues`/`project_statuses`/
  `kanban_tags`/`issue_tags`/`issue_relationships`; eles publicam em um bus
  próprio (`events/kanban.rs`, `KanbanEvent.seq`) em vez do `MsgStore` global
  de ~100 MB. Novo `GET /api/kanban/stream/ws?project_id=` manda snapshot +
  deltas com reset-on-gap em `Lagged`; `createFallbackSync` assina e aplica
  `write({type:'insert'|'update'|'delete'})`, desligando o poll de 30 s enquanto
  o socket está vivo. `pull_requests`/`pull_request_issues`/`issue_comments`/
  `projects` ficam no poll (sem `project_id` direto).
- **Sidebar/colunas:** `?minimal=1` em `/v1/fallback/issues` devolve só as
  colunas escalares (sem `description`/`extension_metadata`) para a árvore; o
  loader de Tasks passou a habilitar só por seção expandida/projeto ativo
  (antes: todos os projetos no boot); coleções `-mut` unificadas por tabela em
  `collections.ts`, cortando pela metade os polls duplicados.
- **Boot:** `RootRedirectPage` volta para o kanban (projeto salvo) em vez do
  último workspace — abrir workspace montava o chat e dispara WS de transcript.
- **Lint pré-existente vermelho (não tocados neste card):**
  `sessions/queue.rs:125` (unused `axum::Json`), `services/queued_message.rs:126`
  (`items_after_test_module`), `routes/config.rs:633` (match não exaustivo sob
  `--features qa-mode`), e 4 arquivos fora do Prettier
  (`sessionCompactor.test.ts`, `CloudAuthActions.tsx`, `CloudAuthDialog.tsx`,
  `promptMessage.ts`). Todos são idênticos ao HEAD.

### 2026-09-26 — Mac travando: picos de RAM, cache de chat na cota (vk/perf-ram-cpu)
- **Medição (app v0.3.23, Mac de 8 GB já com 2,6 GB de swap):** backend
  `aurapunk-tauri` com pico de **926 MB / 114% CPU** ao abrir chats históricos,
  WebContent até 391 MB; média ociosa baixa (~16% / ~11%). O travamento é pressão
  de memória, não CPU contínua. Logs de processo opencode chegam a 77 MB de JSONL.
- **localStorage na cota:** vários origins em ~5,1 MB, 98% `vibe-conversation-entry:*`;
  127 origins distintos, todos anteriores a 19/09 (hoje a porta da UI é estável
  — nenhum origin novo foi criado em 4 relançamentos). Com a cota cheia
  toda gravação falhava após serializar megabytes e o cache nunca acertava, então
  cada troca de workspace re-normalizava o histórico no backend.
- **Correções:** integrada a branch `vk/4a2c-corrigir-ram` (sidecar normalizado,
  janela de histórico, orçamentos do cache). Por cima:
  `useExecutionProcesses` memoiza as listas derivadas (antes eram novas a cada
  render e re-disparavam efeitos, incluindo uma gravação síncrona do manifesto);
  o manifesto só é gravado quando ids/status mudam; `getCachedEntries` /
  `getCachedExecutionProcesses` não regravam o que acabaram de ler; o cache abre
  espaço ANTES de gravar (uma loja já na cota agora se recupera). No backend,
  `NORMALIZE_PERMITS` serializa normalizações a frio (com re-checagem do sidecar
  após o permit) e o caminho de histórico não chama mais `ensure_container_exists`
  (normalizadores só usam o caminho como texto).
- **Verificação:** `cargo check` (services/server/local-deployment) limpo,
  `cargo test -p services` 182; web-core `tsc` limpo, vitest workspace-chat 63
  (2 testes novos do cache falham sem a correção), lint do local-web limpo.
- **Regressão encontrada no teste real (e corrigida):** com o merge da `4a2c`,
  NENHUM chat carregava ("só carregando"). O `unfold` de dedup em
  `normalized_transcript` fazia flush no sentinel `Ready` e devolvia a fonte —
  um `history_plus_stream`, cuja metade ao vivo nunca termina — então a coleta
  esperava para sempre sempre que sobrava um patch no buffer. No v0.3.23 o mesmo
  código só alimentava o WS e o bug ficava oculto; a coleta da `4a2c` o expôs.
  Extraído para `dedup_until_ready` (termina no `Done`) com testes que travam
  sem a correção. Diagnóstico: logs de etapa temporários no binário release.
- **Medido após a correção (dados reais):** 3 históricos de 77/64/59 MB em
  paralelo a frio → 5,6 s, pico 897 MB; reabertura com sidecar → 84 ms, CPU 9%.
  Em aberto: RSS não volta após o pico (~900 MB) e já parte de ~627 MB.
- **CPU ociosa com workspace aberto:** cada `git status` do poll de branch
  (5 s) custava ~0,25 s de CPU num repo de 2,3 mil arquivos — o checkout novo
  deixa o índice "racily clean" e o `--no-optional-locks` nunca grava o índice
  atualizado, então o re-hash se repetia para sempre. `GitCli::worktree_add`
  agora roda `update-index -q --refresh` (0,25 s → 0,01 s). Backend ocioso
  ~0,7%, com workspace aberto ~3%.
- **"Laya Cloud volta para Local ao reiniciar":** não era o Laya — o
  localStorage do origin da UI estava na cota e todo `setItem` falhava calado
  (`catch {}`), perdendo QUALQUER preferência. O cache media em unidades de
  código, mas o WebKit guarda UTF-16 e cobra a cota em bytes (2×): o orçamento
  achava estar na metade enquanto o disco estava cheio. `byteLength` agora conta
  2 bytes por unidade e `Bootstrap.tsx` poda o cache antes do render. Medido no
  disco: 5.118 KB → 3.125 KB. Para inspecionar o localStorage do app, feche-o
  antes: com ele aberto o SQLite do WebKit não reflete o WAL para leitores externos.
- **Pendente:** gravar o sidecar no fim do processo (cuidado: normalizadores
  ainda drenam linhas após `push_finished`), fixar a porta da UI, polling de
  fundo (diff stream a 1s, branch-status/agent-activity a 3–5s) e medir o pico
  no app empacotado.

### 2026-09-26 — Erros de integração visíveis + transcript normalizado na saída (vk/integration-errors)
- **"Mem0 verde mas não grava":** o ponto do Mem0 refletia só o `/health`, que
  valida o token mas não prova que gravações entram; o `memory_save` do MCP
  devolvia `stored: false` por 5 motivos distintos (desligado, HTTP não-2xx,
  rede, resposta ilegível, `queued=false`) sem dizer qual, com o motivo só num
  `tracing::warn` invisível. As falhas observadas nesta sessão foram
  intermitentes (reproduções diretas no gateway e no binário MCP gravaram).
  Cuidado ao testar com curl no zsh: `${h:+-H "$h"}` vira UM argumento e gera
  401 falso.
- **Implementado:** log de erros de integração em memória no backend
  (`services::integration_errors`, `GET/POST /api/integration-errors`),
  alimentado pelo backend (proxy Jev, grafo de memória), pelo MCP (toda falha de
  `memory_save`/`search`/`graph_traverse`/`check_staleness`; `memory_save`
  ganhou o campo `error`) e pelo frontend (compactação Laya/Jev e o fallback
  para o Cloud, antes engolido). Os indicadores Mem0 e RLCD (Laya · Jev) ficam
  vermelhos e abrem um balão (`IntegrationErrorBalloon`) até o operador dispensar.
- **Transcript na saída:** handles dos normalizadores de processos iniciados do
  zero são registrados; na saída (3 caminhos em `local-deployment`), em
  background, o sidecar é gravado do `MsgStore` vivo após os normalizadores
  drenarem. Não grava para processo retomado (store sem as primeiras linhas),
  normalizador que não drena em 60 s, ou `MsgStore` que descartou histórico
  (novo `history_is_complete`).
- **Regressão da 4a2c — descrição dos cards em branco:** um socket do kanban
  por projeto carrega as assinaturas `issues` completa (board) e minimal
  (sidebar), mas os frames `snapshot`/`event`/`ready` só diziam a tabela; o
  cliente aplicava as linhas minimal (sem `description`) na coleção do board.
  Frames agora levam `minimal` e o cliente casa (tabela, minimal)
  (`frameTargetsSubscription`). Verificado no app instalado: completa 19/19 com
  descrição, minimal 0/19.
- **MCP local sem publicar:** o `npx aurapunk-ide --mcp` re-extrai o binário do
  `aurapunk.zip` em `~/.aurapunk-ide/bin/<versão>/macos-arm64/` a cada
  execução (checksum só no download). Para testar um MCP novo, troque a
  entrada `aurapunk-mcp` dentro desse zip (original salvo como
  `aurapunk.zip.orig-v0.3.23`); vale até a próxima versão publicada.
  **Nunca sobrescreva no lugar** (`cp` por cima) um executável que já rodou:
  o kernel do macOS mantém a assinatura em cache e a próxima execução daquele
  arquivo morre com `SIGKILL (Code Signature Invalid)` — aconteceu nesta
  sessão (relatórios `aurapunk-mcp-*.ips` em `~/Library/Logs/DiagnosticReports`).
  Apague e copie (`rm` + `cp`, novo inode). O mesmo vale para o `.app`: use
  `rm -rf` + `ditto`.

### 2026-09-26 — RAM da interface (WebContent) (vk/webview-memory)
- **Onde estava:** ~300 MB estável e picos de ~475–514 MB na abertura. Heap JS
  só ~55–60 MB (medido no Chrome contra o backend instalado); o resto é heap
  nativo do WebKit (~220 MB) e camadas gráficas (~56 MB). Sem vazamento ao
  trocar entre os maiores chats. O maior bloco do heap JS era o próprio bundle
  (5,3 MB carregado inteiro: fonte em UTF-16 + código compilado ≈ 25 MB).
- **Feito:** seções de Settings, terminal xterm (+WebGL), painel Changes e o
  diff expandido do chat viram chunks sob demanda (bundle principal 5,33 →
  3,81 MB); entradas de edição recolhidas não parseiam mais o diff só para
  validar; `MobileDrawer` montado só no mobile (no desktop renderizava uma
  segunda sidebar escondida + overlay de tela cheia); logo do topo 2372→880 px;
  Noto Emoji removida (8 subconjuntos, ~1,1 MB do Google Fonts por abertura →
  emoji nativo, agora colorido).
- **Medido (footprint do WebContent, 2 aberturas):** pico 475–514 → 429–452 MB;
  estável ~300 → ~250 MB.
- **Diagnóstico:** `AURAPUNK_DEVTOOLS=1` habilita o Web Inspector do Safari no
  build de release (app normal continua sem). Para medir a UI, prefira
  `vmmap --summary <pid> | grep "Physical footprint"` ao RSS, que oscila com a
  compressão de memória do macOS.

### 2026-09-26 — Teste de runtime com agente real (vk/runtime-fixes)
- **Como medir de novo:** crie um card de teste (sem merge/commit/build),
  rode-o com `start_workspace` / `run_issue_in_workspace` e amostre
  `vmmap --summary <pid>` (Physical footprint) do `aurapunk-tauri` e do
  `WebKit.WebContent` a cada 1–2 s. Para a lógica do frontend, abra o mesmo
  workspace no Chrome contra o backend (`http://localhost:<porta>/workspaces/<id>`)
  com um `initScript` que embrulha `WebSocket` (bytes por endpoint) e amostra
  `performance.memory`.
- **Resultados:** Claude Code (92 s) backend pico 177 MB / CPU média 1,5%;
  OpenCode (68 s) backend pico 221 MB / 2,2%. Sidecar normalizado gravado no fim
  em todos os casos, inclusive execução que falhou (limite de sessão 429).
  Frontend com o chat na tela, 71 s de streaming: heap JS 113→140→112 MB, sem
  saltos ≥15 MB/s, ~1,3 MB de WS no total. Os picos transitórios de 450–560 MB
  do WebContent no app não vêm da lógica do app (não aparecem no V8); são
  internos do WebKit/JSC — atribuir exige o Web Inspector do Safari
  (`AURAPUNK_DEVTOOLS=1`). Menor: `agents/discovered-options/ws` reenvia
  mensagens de ~100–126 KB (632 KB em 26 msgs).
- **Bug corrigido:** apagar o workspace aberto deixava a tela nele (chat vazio,
  404 em loop, "Failed to send: Not Found"). `WorkspaceProvider` agora sai para
  a raiz quando o workspace some da lista viva ou `GET /api/workspaces/:id`
  dá 404 (URL antiga). Verificado nos dois caminhos.

### 2026-09-26 — RLCD (Laya / Jev) no backend (vk/rlcd-backend)
- **Levantamento:** Jev/Laya só tinham uso real na compactação do chat. Os
  toggles de guardrail de Settings eram lidos só pela tela de Settings; o
  "Abide via Laya" do backend eram regras fixas em Rust, sempre ligadas e sem
  `Write`/`MultiEdit`; a auto-compactação só gerava um marcador local (o
  agente não compactava); o plugin `fast-jev-compaction` nunca rodava (caminho
  `Resources/plugins` vs `Resources/resources/plugins`, variável sem leitor,
  hook inexistente); o indicador Cloud gastava cota com `/predict`.
- **Feito:** Settings espelha motor, endpoints, token Cloud, chave Jev e
  toggles em `~/.vibe-kanban/rlcd.toml` (`PUT /api/rlcd/config`,
  `useRlcdConfigSync`). `services::rlcd` chama Laya (`POST {url}/predict`) /
  Jev (`POST {url}` com `{model,state,questions}`), timeout curto, fail-open,
  falhas no balão. Guardrails obedecem aos toggles e à ação block/warn e
  ganharam checagem semântica de comandos de shell; `memory_save` do MCP passa
  por `POST /api/rlcd/classify-memory` (a conclusão de card nunca é
  bloqueada); auto-compactação envia `/compact` ao agente antes do Fast Jev.
- **Medido com a API real (Jev, ~0,4 s por chamada):** portão de memória —
  fato durável gravado (0,76 durável); log de build (0,96 volátil), segredo
  (0,98) e estado em andamento (0,95 volátil) recusados. Guardrail —
  `rm -rf ~/` (0,89 destrutivo) e envio de `~/.ssh/id_rsa` (0,96 exfiltração)
  bloqueados; `cargo test` e `rm -rf target/` permitidos.
- **Rede:** uma das conexões do operador não alcança `api.typesafe.ai`; nesse
  caso o portão grava mesmo assim e a falha aparece no balão do RLCD. Com o
  motor `jev` não há fallback para o Laya — use `adaptive` para ter.

### 2026-09-26 — RLCD afinado para Laya e Jev; CI verde (vk/rlcd-tuning)
- **Confrontando os mesmos casos nos dois motores** (`docs/rlcd-bench-cases.json`
  tem casos, perguntas e respostas medidas): com os prompts da v0.3.24 o Laya
  errava três — log de compilação com volatile=0.02 (gravado), `rm -rf target/`
  destrutivo=0.97 (bloqueado) e `rm -rf ~/` "local ao projeto"=0.62. O Jev
  acertava tudo. Perguntas longas com vários conceitos confundem o Laya; use
  perguntas curtas de um conceito só.
- **Regras:** memória recusa se secret≥0.5, raw_output≥0.6, ou in_progress≥0.7
  com durable<0.5. Comando bloqueia se exfiltration≥0.8, ou destructive≥0.8 E
  `reaches_outside_project` (determinístico: `~`, `$HOME`, `..`, caminho
  absoluto exceto /tmp e /dev/null, SQL drop/truncate). `rm` recursivo/forçado
  fora do projeto é bloqueado mesmo com o classificador fora do ar (única
  exceção ao fail-open). Medido pelo backend: Laya 11/11; sem TypeSafe,
  `rm -rf ~/` e `../other-repo` bloqueados, `target/` e `cargo test` liberados.
- **Diagnóstico:** `POST /api/rlcd/classify-tool-call {command}` devolve o
  veredito exato do hook headed.
- **CI:** o workflow Build falhava em todo commit desde ≥21/09 (Json não usado
  em `queue.rs`, `impl` depois do módulo de testes em `queued_message.rs`, 4
  arquivos fora do Prettier). Corrigido; reproduza localmente com
  `cargo clippy --workspace --all-targets --exclude aurapunk-tauri -- -D warnings`
  e `npm run format:check` em cada pacote.
- **Disco:** `target/debug` chegou a 50 GB nesta sessão e encheu o disco duas
  vezes; apague-o quando só o app (release) importar.

### 2026-09-26 — Sync Cloud ⇄ Desktop ⇄ APK: integridade do log (ADR-047, fase 1)
- **Revisão dos três lados** (`mobile_sync.rs`/`CloudAuthActions.tsx`,
  `aurapunk-cloud` `app/api/sync`, `aurapunk-mobile`): revisão do Cloud
  alocada com `max+1` fora de transação (eventos perdidos), sem índice em
  `sync_events`, snapshot mantinha os 5000 registros MAIS ANTIGOS (instância
  Cloud nascia sem os cards novos), deleções nunca propagadas, comandos sem
  idempotência (cursor no `localStorage` perdido ou duas janelas reenviavam
  prompts), APK ignorava eventos no modo Cloud e recomeçava o cursor do 0, e o
  pedido de workspace do APK via Cloud usava `operation: "insert"` — rejeitado
  com 400, nunca funcionou.
- **Feito:** Cloud — `sync_cursors` (migração 0011) como alocador dentro da
  transação do push, escrita em lote, índices, long-poll lendo só a linha do
  cursor, snapshot paginado (`page_size`/`cursor`), snapshot legado com os mais
  novos + `truncated`, `after_revision=latest`; teste de integração com PGlite
  (`npm run test:sync`, 6/6). Desktop — tabela `relayed_commands` +
  `run_relayed_once`: cada `command_id` (id do evento) roda uma vez; falha
  libera o claim. APK — stream começa em `latest`, evento de board dispara
  refresh com debounce, pedido de workspace com `upsert` e id único.
- **Pendente (ADR-047):** publisher em Rust com outbox/tombstones (fase 2), fila
  de comandos própria (3), push via NOTIFY + retenção (4), `scope_id` e
  `base_revision` para equipes (5).
- **Cuidado ao validar o Cloud:** `timeout` não existe no macOS — um
  `timeout 300 tsc | grep -c` "passa" com 0 erros sem ter rodado. O `HEAD` do
  `aurapunk-cloud` já tinha 39 erros de `tsc` pré-existentes.

### 2026-09-27 — Publisher do Cloud no backend (ADR-047 fase 2) + ADR-048 (times)
- **Antes:** a webview exportava o banco inteiro (`/api/mobile/context`, com
  todos os turnos de chat) a cada mensagem do stream de workspaces e reenviava
  tudo ao Cloud; sem janela aberta não havia sync. Produção tinha 91.500
  eventos para 1.081 registros.
- **Agora:** triggers SQLite gravam em `cloud_sync_outbox` qual entidade mudou
  (só com conta vinculada — `cloud_sync_state.enabled`); `routes::cloud_sync`
  drena em lotes, coalesce por entidade, monta o payload da linha atual (linha
  sumida → delete), empurra em blocos de 100 e reconhece por `seq`. Bootstrap
  único por conta; catálogo (instância/pipelines/executores) a cada 15 min. A
  UI só chama `PUT /api/cloud-sync/account` (login/boot) e `account: null` no
  logout. Payloads de `workspace_context`/chat/issue agora vêm de funções
  compartilhadas com `/api/mobile/context` (mesmo formato).
- **Testado de ponta a ponta** com servidor de debug + Cloud falso: bootstrap
  bateu com as contagens do banco (221 registros, 4 requests ≤100); duas
  escritas no mesmo card → 1 push; insert+delete de coluna → 1 tombstone;
  Cloud fora do ar → fila retida e drenada em 1 s ao voltar; desvincular →
  captura desligada e fila limpa; `cloud-sync.json` com 0600.
- **Cuidado:** subir o servidor de debug roda a limpeza periódica e apagou 2
  workspaces expirados de `dev_assets` — comportamento normal do `pnpm run dev`.
- **ADR-048 (Proposed):** núcleo open source continua individual; times no
  Cloud; integração por PR; papéis como etapas da pipeline; roadmap T0–T5.

### 2026-09-27 — Fila de comandos do Cloud (ADR-047 fase 3)
- **Bugs encontrados no caminho:** (1) mover card pelo APK via Cloud nunca
  tinha efeito — o APK reenvia o payload com o MESMO `updated_at` e a guarda
  `X-Client-Updated-At` descarta `existing >= client`; (2) comandos rodavam a
  partir do log de eventos com cursor no `localStorage`.
- **Cloud (`aurapunk-cloud` 85a1fc6):** `sync_commands` com lease, claim
  `FOR UPDATE SKIP LOCKED`, `released` volta à fila e falha após 5 tentativas;
  rotas em `/api/sync/commands*` (o gateway já repassa `/api/sync/*`). Pushes
  do APK viram comandos automaticamente e vão para a instância dona
  (`source = desktop:<instance_id>`, que uma escrita do APK não sobrescreve —
  o teste pegou isso). 10/10 testes PGlite.
- **Desktop:** `routes::cloud_commands` reivindica (long-poll 25 s), executa
  pelos mesmos handlers do caminho LAN (com `command_id`), devolve o que não é
  desta instância e conclui com resultado; publica o `<id>:result` legado para
  APKs antigos. Mover card = concorrência otimista sobre `updated_at`.
- **Testado** com servidor de debug + Cloud falso: chat/pedido para
  workspace/card inexistente → `released`; mover com base velha → conflito;
  mover com base atual → aplicado no banco. O teste revelou loop apertado
  quando o claim volta vazio na hora (373 claims) → piso de 1 s; e espera de
  10 s após vincular a conta → consumidor acorda no vínculo.

### 2026-09-27 — Retenção e long-poll por sinal (ADR-047 fase 4)
- **Cloud (`c532fc0`):** eventos guardados 7 dias por conta (poda no máximo
  1×/hora, em background no push); `sync_cursors.min_revision` = mais antigo
  retido; pull com cursor anterior recebe `reset: true` → re-snapshot.
  Comandos concluídos além da retenção também saem. `pg_notify` dentro da
  transação do push/enqueue + sinal em processo: long-polls acordam na hora e
  só re-checam a cada 1–2 s (antes: query a cada 250/500 ms por cliente).
  15/15 testes PGlite (incl. "acorda em <2 s com fallback de 5 s").
- **Clientes:** APK recarrega o board no `reset`; o espelho de movimentos da
  webview pula para a revisão atual.
- **Pego no caminho:** o teste da fase 3 introduziu 1 erro de `tsc`
  (`JSON.parse` de campo nullable) que meu filtro não viu por olhar só
  `db/` e `app/` — filtre também `tests/`.

### 2026-09-27 — `~/.vibe-kanban` → `~/.aurapunk` com migração
- **Antes:** `utils::path` só *preferia* `~/.aurapunk` se já existisse e caía
  no legado; nada criava a pasta nova, então tudo seguia em `~/.vibe-kanban`
  (e `<workspace_dir>/.vibe-kanban-workspaces`, onde de fato vivem os
  worktrees do operador — 62 `container_ref`).
- **Armadilha evitada:** a limpeza de órfãos compara `container_ref` por texto
  exato; renomear a pasta sem reescrever o banco faria TODO worktree parecer
  órfão e ser apagado.
- **Migração (início do `LocalDeployment::new`):** `migrate_legacy_dir`
  renomeia (atômico) ou mescla, e deixa symlink no nome antigo (caminhos
  absolutos no banco, no `.git/worktrees/*/gitdir` e em scripts externos como
  `vk-mcp.sh` seguem válidos); `~/.vibe-kanban[-dev]` e
  `.vibe-kanban-workspaces`. Conflito de nomes → legado mantido + aviso.
  Windows não migra. Depois do banco abrir e ANTES da limpeza,
  `Workspace::rewrite_container_ref_prefix` reescreve os caminhos; e a limpeza
  ainda checa o caminho equivalente antigo (`legacy_aliases`) antes de apagar.
- **Testado:** unidade (mover/mesclar/idempotência, reescrita só em
  componentes inteiros, limpeza mantém worktree registrado com nome antigo e
  apaga órfão real) + servidor de debug com `HOME` e pasta de workspaces
  falsos (migrou, reescreveu 1 linha, 2ª inicialização sem ação).
- **Cuidado:** comentário SQL dentro de `query!` faz parte do hash do cache
  offline do sqlx — trocar texto ali quebra o build (`.sqlx`); ficou o nome
  antigo nesse comentário.
- **Fora do escopo:** `~/Library/Application Support/ai.bloop.vibe-kanban`
  (identificador do Tauri) e o `$TMPDIR/vibe-kanban` do app Swift legado.

### 2026-09-27 — Escopos no Cloud (ADR-049 etapa 1, ADR-047 fase 5)
- **0014 (`760a42c`):** `scope_id` nulo + backfill `user:<id>` + escrita dupla;
  `baseRevision` → `conflicts` com o registro atual. Verificado em produção
  via SSH (somente leitura, `DATABASE_URL` tirada do `/proc/<pid>/environ` do
  processo do site — o `.env` lido como root não a tinha): 0 faltando/
  divergentes; retenção já tinha levado o log de 91.500 → 5.483 eventos.
- **0015 (`aa91574`):** `scope_id` vira a partição (PKs, cursores, fila,
  retenção, NOTIFY); `X-AuraPunk-Scope` escolhe o escopo (membro de tenant ou
  403); sem cabeçalho = pessoal, clientes atuais inalterados. A rota de
  `scratch` fazia upsert com o alvo da PK antiga — teria quebrado.
- **Próximo:** Desktop bidirecional (ADR-049 rollout 2): revisão base por
  entidade, puller de board, merge de conflitos, fim do espelho da webview.

### 2026-09-27 — Desktop bidirecional (ADR-049 rollout 2)
- **Peças:** `cloud_sync_remote` (revisão do Cloud por entidade de board →
  `baseRevision`), resposta do push com `applied` (Cloud `4542d77`),
  `routes::cloud_pull` (snapshot paginado → long-poll → aplica com captura
  suspensa via `import_cloud_records`), `resolve_conflicts` (vence o
  `updated_at` mais novo; apagado remoto é recriado do local). Espelho da
  webview removido (`CloudAuthActions.tsx` 995 → 539 linhas).
- **Pego no teste:** o Cloud (JS) reserializa `1.0` como `1`; comparar
  `serde_json::Value` direto fazia todo card parecer mudado → `same_json`
  compara números por valor.
- **⚠️ Servidor de debug agora MIGRA pastas:** com o `HOME` real e o
  `dev_assets/config.json` (que aponta `workspace_dir` para a pasta REAL de
  workspaces), um `pnpm run dev` renomearia `~/.vibe-kanban-dev` e a
  `.vibe-kanban-workspaces` real. Para testes: `HOME` falso, `workspace_dir`
  falso, backup/restauração de `dev_assets` e `DISABLE_WORKTREE_CLEANUP=1`.
- **Mock com estado** (revisões, registros, eventos, snapshot, `baseRevision`,
  `hidden` para simular evento ainda não puxado) validou S1–S4.

### 2026-09-27 — Fila de integração (ADR-050)
- **Bug confirmado:** `complete_workspace_card`/`merge_workspace` seguravam o
  agente até 45 s num bloqueio transitório e falhavam; nada tentava de novo.
- **Agora:** bloqueio transitório → `POST …/git/merge-queue` (tabela
  `integration_requests`, commit verificado) e resposta imediata `queued`;
  worker `routes::workspaces::merge_queue` tenta ao ser acordado e a cada
  10 s, e avisa a sessão do agente (fila de mensagens ou follow-up).
  `complete` → o agente chama de novo; `GET …/merge-queue` informa
  `integrated_head` (o squash move a branch para o commit do merge →
  `result_sha`) e o merge não roda duas vezes.
- **Corrida pega no teste:** o worker checava o SHA ANTES de o merge esperar o
  lease (até 15 s); um commit durante a espera era integrado sem verificação.
  `MergeWorkspaceRequest.expected_head` agora é conferido COM o lease →
  `GitOperationError::BranchMoved` → `superseded`.
- **zsh:** `$G` com espaços não vira comando (sem word-split) — roteiros de
  teste com vários argumentos vão em arquivo `bash`.
- **Disco:** `target/debug` chegou a 51 GB de novo (2,2 GB livres); apagado.

### 2026-09-27 — MCP como orquestrador (ADR-051) + classificação de conflitos (ADR-050)
- **MCP novo:** `wait_for_executions` (espera 1–32 execuções, volta cedo se
  alguma pede aprovação), `list_agents` (`GET /api/agents/catalog`, o mesmo
  catálogo do APK), `list_pipelines` / `get_pipeline_definition` /
  `save_pipeline` / `delete_pipeline`, `set_issue_pipeline`
  (`PUT /api/issues/{id}/pipeline`, mesmo bloco `vk:pipeline` dos diálogos),
  `route_task` (`POST /api/rlcd/route-task`). Testados via stdio JSON-RPC
  real contra um backend isolado.
- **Pego no teste:** limpar pipeline deixava o metadata — updates de issue
  MESCLAM `extension_metadata`; `null` remove a chave (há teste disso).
- **Calibração do `route_task` no Laya:** só "Does this task touch several
  components or systems?" separa tarefas mecânicas de transversais; as outras
  perguntas e a adequação por pipeline erravam. Decisão = essa pergunta +
  heurística de texto. Gabarito em `route_decisions_match_the_measured_benchmark`.
- **Conflitos:** `rlcd::classify_merge_conflict` (lockfile/gerado/CHANGELOG
  trivial por caminho; resto pelo classificador; na dúvida, semântico) em
  `MergeConflicts.classification`. Observado: squash com conflito deixa `UU`
  no checkout do alvo e trava merges do repo — decisão aberta (ADR-050).
- **RLCD do operador:** `engine = "jev"` e o Jev não responde desta rede, então
  nada do RLCD tem resposta real; o Laya Cloud responde (200). A Cloudflare
  bloqueia só o UA `Python-urllib` (erro 1010) — nos testes em Python, mande
  um `User-Agent`; o backend (reqwest, sem UA) passa.

### 2026-09-27 — Conflito nunca fica no alvo (ADR-050 §4)
- **Antes:** o squash rodava no checkout do alvo e, com conflito, deixava
  `UU` + `SQUASH_MSG` no `main` → todo merge do repo travava em
  `dirty_worktree`; o "delegar" mandava resolver no alvo.
- **Agora:** `merge_changes` simula antes com `git merge-tree --write-tree
  --name-only` (nada é tocado); rede de segurança `git reset --merge` +
  remove `SQUASH_MSG`. O agente resolve NA BRANCH (`git merge <alvo>` no
  worktree, resolve, testa, commita) e tenta de novo — entra limpo.
  Delegate/MCP/fila/diálogo atualizados. Testado ponta a ponta (alvo com 0
  mudanças; resolução na branch integrou limpo).

### 2026-09-27 — Reserva de arquivos durante a resolução de conflito (ADR-050 §5)
- **Pergunta do operador:** enquanto o agente faz `git merge main` na branch
  e resolve, outro agente pode mudar o `main` de novo — com muitos agentes em
  paralelo o resolvedor pode perder a corrida para sempre.
- **Solução:** no `MergeConflicts` (dentro do lease do Integration Guard) o
  workspace ganha uma declaração `merge-resolution`
  (`CONFLICT_RESOLUTION_OWNER`) com todos os arquivos que a branch mudou.
  Merges de outros workspaces que tocam esses arquivos viram
  `agent_work_conflict` → fila de integração → entram sozinhos quando a
  resolução é integrada. Quem não toca nesses arquivos integra normalmente.
- **Sem impasse:** entre reservas vale a mais antiga (FIFO; renovar mantém o
  `created_at`); quem tem reserva não é bloqueado por declarações comuns
  (`AgentWorkDeclaration::blocks_merge`). Lease de 30 min renovado a cada
  retry conflitante e, no worker da fila, enquanto houver agente rodando no
  workspace; liberado no merge e no arquivamento.
- **Verificado:** `cargo test -p db agent_work` (10), clippy limpo, cenário
  real com 3 workspaces (roteiro `parallel-scenario.sh` no scratchpad da
  sessão): A reserva, B espera na fila, C integra, A resolve e integra, B
  retoma e reserva a própria resolução; `main` sempre limpo.

### 2026-09-27 — Contexto do agente: sem prefixo, compactação real, passagem (ADR-052)
- **Achado:** depois de um marcador de compactação, TODA mensagem ia ao agente
  com o "resumo" + últimos 4 turnos (`prepareCloudPromptWithIsolation`). O
  agente já tem o próprio histórico (`--resume <id>` / terminal vivo), então
  isso só engordava o contexto; e o "resumo" do Fast Jev era estatística —
  Jev/Laya são classificadores, não escrevem texto.
- **Agora:** mensagem vai limpa; `/compact` (manual ou pelo limite) só pede ao
  agente que compacte e registra um marcador honesto. `/summarize` ou
  `/handoff` pede ao agente um resumo de passagem.
- **Passagem** (`routes/sessions/handoff.rs`): primeira mensagem de uma sessão
  NOVA num workspace já trabalhado recebe, uma vez, `<aurapunk-handoff>` com o
  resumo do agente (se pedido), estado da branch (commits/arquivos/não
  commitados), etapa da pipeline e as trocas anteriores (prompt + resposta
  final de `coding_agent_turns`; acima de 8, Jev/Laya escolhem as do meio).
  Nada é gravado: some com o workspace no merge. Mem0 fica só com o durável.
- **Verificado:** `cargo test -p server handoff` 8 (inclui banco real com
  sessões/turnos e repositório git), vitest workspace-chat 67, `tsc` limpo,
  clippy/fmt/prettier limpos. Não validado com os dados reais do operador
  (teste interrompido a pedido).

### 2026-09-27 — Memória do projeto no início da sessão + passagem no Mem0 (ADR-053)
- **Medido:** `memory_search` só aparece nos processos que seguiram
  `get_rules` (5 de 13); chat livre nunca consulta. O Mem0 do `aurapunk-ide`
  tem 49 memórias, quase todas diário de correção; notas do vetor são ruidosas
  (irrelevante 0,64–0,68, relevante ~0,74). Contagem: sidecars
  `*.normalized.json` (`tool_name`); os `.jsonl` brutos têm JSON escapado e
  enganam o grep.
- **Feito:** `services::session_context` (o handoff saiu de `server` para cá):
  `prepare_initial_prompt` nos 3 pontos de sessão nova (início de card em
  `start_workspace`, follow-up inicial, mensagem enfileirada) adiciona
  `<aurapunk-memory>` (busca feita pelo app, Jev/Laya filtram) e o handoff.
  Resposta ao `/summarize` → Mem0 `handoff-<issue_id>` com `raw: true`;
  apagado no merge; só pontos `raw` são lidos de volta.
- **aurapunk-cloud:** `mem0-vk` ganhou `raw` (um ponto literal, sem extração
  nem grafo); o gateway trata `raw` como escrita vetorial (plano Free ok).
  Typecheck ok; o teste HTTP do `mem0-vk` exige Qdrant local (OrbStack estava
  parado) — não rodado. Deploy pendente.
