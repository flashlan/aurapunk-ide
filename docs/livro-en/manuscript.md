# Modern Vibe Coding Manual

### Practical use of Aurapunk IDE — from `npx` to a production SaaS

**Subtitle:** *A practical interface guide for Aurapunk IDE, with the guided SaaS project AssinaFacil.*

> Manuscript generated from `docs/livro-en/*.md` (branch `vk/1f98-livre-vibo-kanba`).
> External KDP rules verified Aug/2026 — revalidate before publishing.

---

# Modern Vibe Coding Manual — Table of Contents

**Subtitle:** *A practical guide to the Aurapunk IDE interface — from `npx` to a production SaaS, with a guided project.*

This book was written inside the very repository it teaches you to use. Every file path cited exists in the code; when an external rule changes (e.g., KDP prices), the chapter marks the verification date.

## How to use this book

- **Part I (ch. 1–9):** the usage manual — start with the vibe coding vocabulary (ch. 2), then install, navigate, work with cards, pipelines and git, and close with the practical project **Building a SaaS with Vibe Kanban** and the Amazon KDP publication.
- **Part II (ch. 10–15):** behind the scenes for those who want to customize — architecture, generated types, the engineering loop, orchestration and image anchoring.
- **Appendix:** quick command reference.
- The Amazon publication checklist lives in `../livro-vibe-kanban-amazon-checklist.md`.

## Part I — Usage Manual + Practical Project

| # | Chapter | File | Status |
| --- | --- | --- | --- |
| 1 | Introduction: what this manual solves | `01-introducao.md` | Written |
| 2 | Vibe coding notions: Engineering Loop, Spec Development, multi-agent and jargon | `02-nocoes-vibe-coding.md` | Written |
| 3 | Installation and configuration | `03-instalacao-configuracao.md` | Written |
| 4 | Interface tour | `04-tour-interface.md` | Written |
| 5 | Cards and Kanban — the lifecycle in practice | `05-cards-kanban.md` | Written |
| 6 | Pipelines in practice | `06-pipelines.md` | Written |
| 7 | Git, workspaces and worktrees | `07-git-workspaces.md` | Written |
| 8 | Practical project: Building a SaaS with Vibe Kanban | `08-projeto-saas.md` | Written |
| 9 | From writing to Amazon KDP | `09-publicacao-kdp.md` | Written |
| 17 | Agents: installation, authentication, and models | `17-agentes.md` | Written |
| 18 | Settings: tab reference | `18-configuracoes.md` | Written |
| 19 | Troubleshooting: error index | `19-resolucao-problemas.md` | Written |

## Part II — Behind the Scenes (for those who customize the app)

| # | Chapter | File | Status |
| --- | --- | --- | --- |
| 10 | The Vibe Coding Setup (context files) | `10-vibe-coding-setup.md` | Written |
| 11 | Spec-driven architecture: Node × Rust boundaries | `11-arquitetura-spec-driven.md` | Written |
| 12 | The type contract: ts-rs in practice | `12-contrato-de-tipos.md` | Written |
| 13 | The Engineering Loop: CLI and self-correction | `13-engineering-loop.md` | Written |
| 14 | Agent orchestration: MCP, pipelines and the alarm | `14-orquestracao.md` | Written |
| 15 | Image anchoring | `15-ancoragem-imagens.md` | Written |
| A | Appendix: command reference | `apendice-comandos.md` | Written |

## Annexes

| # | Section | File | Status |
| --- | --- | --- | --- |
| — | Acknowledgments (lineage: BloopAI → dexloom → Alternative) | `16-agradecimentos.md` | Written |

## Anchor screenshots (ch. 3–8)

| Image | File | Used in |
| --- | --- | --- |
| Main board (Next steps / In progress / In review / Done) | `ancora-board-principal.png` | ch. 4 |
| Open workspace (3 panels) | `ancora-workspace-aberta.png` | ch. 4 |
| Settings | `ancora-settings.png` | ch. 3 |
| Create card — top (Title, Status, Priority, Tags) | `ancora-criar-card-topo.png` | ch. 5 §1 |
| Create card — bottom (Description + Save) | `ancora-criar-card-base.png` | ch. 5 §1 |
| Create card — Workspaces / Create section | `ancora-criar-card-workspace.png` | ch. 5 §2 |
| Workspace chat bar (Tasks, template, presets, permissions, attachments) | `ancora-workspace-chat-bar.png` | ch. 5 §4 |
| AssinaFácil — Landing (hero + MRR + features) | `saas-landing.png` | ch. 8 |
| AssinaFácil — Plans (3 columns, Pro highlighted) | `saas-planos.png` | ch. 8 |
| AssinaFácil — Checkout (form + summary) | `saas-checkout.png` | ch. 8 |
| AssinaFácil — My subscriptions (logged table) | `saas-minhas-assinaturas.png` | ch. 8 |
| AssinaFácil — Landing mobile (390×780) | `saas-landing-mobile.png` | ch. 8 |

> The first 7 are real app screenshots; the 5 AssinaFácil ones are **PIL previews** (ch. 15) — replace with real Preview screenshots when the ch. 8 cards reach Done.

## Conventions

- Paths like `crates/server/src/routes/kanban.rs` are real in this branch's repository (`vk/1f98-livre-vibo-kanba`).
- Suggested screenshots live in `docs/images/livro/` and are described in ch. 15.

---

# Chapter 1 — Introduction: what this manual solves

## Who this book is for

For a developer who just installed Aurapunk IDE and wants to **use the interface to actually build software** — not to study the app's architecture. By the end of Part I you will know how to:

- install and configure the app in your `projects.toml`;
- navigate the interface (board, workspaces, panels);
- create and move **cards** across the kanban columns;
- understand what **pipelines** are and how they move your card on their own;
- use **git without fear** inside Vibe Kanban (workspaces, worktrees, branches, PRs);
- build a project from scratch — **a complete SaaS** — using only the interface.

**Part II** is for when you want to customize Vibe Kanban itself. The focus now is **using the application to develop**.

> **Read Chapter 02 before installing.** It introduces the current vibe coding vocabulary — *Engineering Loop*, *Spec Development*, *multi-agent*, *YOLO mode*, *context engineering* — with examples from this repository. The practical chapters (03 onward) assume you already recognize these terms.

## What Aurapunk IDE is, in one page

Aurapunk IDE is a **self-hosted kanban for a solo developer to drive AI coding agents**. Each board card is a task ("fix login", "create the SaaS plans page"). Each task becomes a **workspace** — an isolated folder with its own git branch — where an agent (Claude Code, OpenCode, Codex, Gemini, Cursor, Copilot, etc.) writes code for you. You watch progress on the board, review diffs and merge.

The concepts you will use every day:

| Concept | What it is, in one sentence |
| --- | --- |
| **Issue / Card** | Unit of work. Title + description + status + priority + tags. The description becomes the agent's prompt. |
| **Board / Columns** | The per-project kanban board. Each column is a `project_status` (e.g., Todo → In Progress → Done). You drag cards between columns. |
| **Workspace** | Isolated environment of a task: a git worktree + `vk/xxxx-name` branch + agent session. |
| **Pipeline** | A recipe in TOML (`assets/pipelines/*.toml`) that tells the agent what to do and in what order — and how to report progress (`VK-PIPELINE-STAGE: N`). |
| **Session** | A conversation with an agent inside a workspace. A workspace can have several sessions. |
| **Setup/Cleanup/Dev scripts** | Per-repository/per-project commands Vibe Kanban runs automatically when creating/opening/closing a workspace. |

## The guided project of this book

Starting in Chapter 08 you will build a real SaaS — **AssinaFácil**, a fictional subscription-management SaaS — entirely through the Vibe Kanban interface. Each Part I chapter leaves a card ready for the next, so by the end you have a board with the product's complete history.

## How to read

- Follow Part I in order on the first read; each chapter ends with a **checklist** you can tick off on your own board.
- Paths like `docs/getting-started.mdx` or `crates/server/src/main.rs` really exist in this branch (`vk/1f98-livre-vibo-kanba`) — open them and check.
- Screenshots cited live in `/images/` (site docs) and `docs/images/livro/` (book anchors, ch. 15).

---

# Chapter 2 — Vibe coding notions: Engineering Loop, Spec Development and multi-agent

> **Goal:** learn the current vibe coding jargon — with real examples from the AssinaFácil SaaS — so the practical chapters (03 onward) don't have to stop at every new word.

## 1. Vibe coding, in one sentence — and why it is not "ask and pray"

Vibe coding is **coding by intent**: you describe the outcome you want in natural language and an agent writes, runs and fixes the code. The term was popularized by Andrej Karpathy in Feb/2025 and stuck because it captures the feeling — you "vibe" the idea, the machine materializes it.

### What vibe coding is **not**

To use the tool well, debunk three wrong expectations:

- **It is not "no-code."** You remain the owner of architecture, review and the merge. The agent is a junior developer working at token speed — fast, but needing a senior (you) to approve and steer.
- **It is not "ask and pray."** A loose prompt in chat with no context produces code that *looks* right and breaks at runtime. Real vibe coding is a flow with **artifacts** that make intent auditable.
- **It is not cost-free magic.** The agent has finite memory (the *context window*) and selective attention. If you don't manage what it sees and what it remembers, it hallucinates, forgets or repeats work. Hence the practices in this chapter (and §6: context, memory, autocompact).

### What vibe coding **is**, in Vibe Kanban

In Vibe Kanban, vibe coding is not a loose prompt in chat. It is a flow with artifacts — **cards (spec), pipelines (recipe), workspaces (isolated worktrees)** — that make intent auditable, repeatable and parallelizable. Without artifacts, the agent hallucinates; with artifacts, it delivers.

```
intent (you) → spec (card) → pipeline (recipe) → workspace (worktree) → loop (agent) → review (you)
```

### Vibe coding maturity levels

| Level | How you work | Where this book lives |
| --- | --- | --- |
| 1 — Loose chat | You ask and copy the result | — (starting point, fragile) |
| 2 — Spec-driven | Each task becomes a card with strong spec + done criteria (ch. 2–5) | Part I |
| 3 — Orchestrated | Several agents in parallel, pipelines, memory and autocompact managing state (ch. 6, 10–14) | Part II |

This book takes you from level 1 to 3. Chapter 2 is the vocabulary; §6 (below) is what separates someone who "asks" from someone who "drives."

This chapter presents the three pillars that sustain this flow and, next, the operational best practices.

## 2. Spec Development — the spec comes before the code

**Spec = what the software should do, before how it does it.** If the spec is weak, the code is born crooked and every later fix is a patch.

### Where the spec lives in this repository

- **The card is the spec.** In `docs/issue-management.mdx:57`, the card description becomes the prompt the agent receives when creating the workspace. The difference between a weak and a strong card is the difference between a lost and a precise agent.
- **Pipelines formalize the spec.** `speckit` and `basic` (`assets/pipelines/*.toml`) generate `SPEC.md` / `IMPLEMENTATION_PLAN.md` before touching code — the agent only codes after the spec is reviewed.
- **ADRs guard the architectural spec.** The root `AGENTS.md` tells agents to consult `docs/ADR/` before proposing alternatives.

### Concrete example: AssinaFácil "Plans page"

**Weak spec** (the agent will guess — and fail):

> Make a plans page.

**Strong spec** (the agent nails it first try):

> **Title:** Create `/plans` page with 3 plans (Free, Pro R$49, Enterprise) and CTA to checkout
>
> **Description:**
> - Comparison table with 3 columns, "Most popular" badge on Pro, "Subscribe" CTA in each column.
> - Files: `packages/web-core/src/pages/plans.tsx` (new), `packages/web-core/src/features/billing/plans.ts` (plan data).
> - Validation: Preview at 1440px and 375px shows the table without breaking; `pnpm run check` passes; anchored screenshot at `docs/images/livro/saas-planos.png` matches.
> - Constraints: use configured Tailwind (`packages/local-web/AGENTS.md`); no new dependency; follow `packages/web-core/src/features/` pattern.

Notice the structure: **what** (3-plan table), **where** (files), **how to validate** (check + screenshot), **constraints** (no new lib). The agent receives this as a prompt and already knows when it's done — when Preview matches the anchor.

### Spec jargon you will see

| Term | Meaning here |
| --- | --- |
| **Spec-Driven Architecture** | The spec dictates who does what: TypeScript on Node handles UI; Rust handles state/processes/git. The `crates/` vs `packages/` vs `shared/` boundary is drawn in the spec, not improvised (ch. 11). |
| **Spec Intake** | Turning a vague brief ("I want a subscription SaaS") into a dev-ready task (`docs/cockpit/spec-intake.mdx`). In the book, the AssinaFácil intake becomes the epic + 5 sub-issues of ch. 8. |
| **Generated contract** | The boundary spec lives in Rust structs with `#[derive(TS)]` and is generated to TypeScript (`shared/types.ts` via `crates/server/src/bin/generate_types.rs` — ch. 12). The code **is** the spec. |
| **Done criteria** | A sentence stating when the card is Done — always with observable validation ("Preview shows X; `pnpm run check` passes"). |

> Practical rule: if you can't write the spec in 5 sentences + 1 done criterion, the agent won't be able to implement it either.

## 3. Engineering Loop — the loop that lets the agent self-correct

The **Engineering Loop** is the cycle that lets the agent **self-correct without you**:

```
write → run checks → read the error in the log → fix → repeat
```

When the loop is short and legible, 90% of errors resolve themselves. When it's long or opaque, the agent stops and escalates — and you are interrupted.

### The three ingredients of the loop

**a) CLI as the agent's interface.** Canonical commands in `package.json` that the agent reads from `AGENTS.md`:

```bash
pnpm run check        # tsc (local-web, web-core, ui) + cargo check + guards
pnpm run lint         # ESLint + cargo clippy -- -D warnings (with --features qa-mode)
pnpm run format       # cargo fmt + Prettier
cargo test --workspace
pnpm run generate-types  # regenerates shared/types.ts (ch. 12)
```

The agent doesn't guess commands; it runs the same ones you would.

**b) Errors that teach.** Guards fail with a message pointing at the fix:

- `scripts/check-migration-frozen.sh` — blocks editing a published migration and says why.
- `scripts/check-legacy-frontend-paths.sh` — blocks importing from an old path and points to the new one.
- `cargo clippy -- -D warnings` — turns a warning into an error; nothing passes as "just a warning."

**c) Logs as protocol.** The agent reports progress by writing to the log; the backend watches the `MsgStore`:

- `VK-PIPELINE-STAGE: N` → persists `workspaces.current_pipeline_stage` (`crates/services/src/services/pipeline_stage.rs`, regex `(?i)VK-PIPELINE-STAGE:\s*(\d+)`).
- `VK-REVIEW-REQUEST: ...` → triggers sound + notification (`crates/services/src/services/review_request.rs`, regex `(?i)VK-REVIEW-REQUEST:\s*(.+)`).

The log is simultaneously human output and machine API — and it works the same for Claude, Codex, OpenCode, Gemini… because they all write to the same `MsgStore` (`crates/executors/src/stdout_dup.rs`).

### Real loop walkthrough (with a real error)

Imagine the "Plans page" card above. The agent writes `plans.tsx` and runs:

```bash
pnpm run check
# → error TS2322: Type 'string' is not assignable to type 'PlanTier' in plans.ts:14
```

The agent reads the error, opens `plans.ts:14`, sees it used `"pro"` instead of `"Pro"` (the `PlanTier` type comes from `shared/types.ts`, generated from Rust — ch. 12), fixes it, and runs again:

```bash
pnpm run check   # → passes
pnpm run lint    # → passes (clippy -D warnings shows no mercy)
```

Only then does it write `VK-PIPELINE-STAGE: 2` and move on. You did nothing — the loop closed on its own because the error was legible and the command was canonical.

If the error were opaque ("failed"), the agent would stop at `Needs Attention` and you'd have to guess. That's why the book insists: **invest in the loop before you invest in the prompt**.

## 4. Multi-agent — several agents in parallel without stepping on each other

One agent alone already helps. Several in parallel change the scale — but only if the repository isolates each one's work.

### Isolation: workspaces = worktrees

Each workspace is a folder in `.vibe-kanban-workspaces/` with its own branch `vk/xxxx-name` created from the `target branch` (`docs/workspaces/creating-workspaces.mdx:12`). Your original repo is untouched.

```
original repo (main)
  ├─ .vibe-kanban-workspaces/
  │   ├─ vk-a1b2-landing-page/   (workspace A, branch vk/a1b2-...)
  │   └─ vk-c3d4-auth/           (workspace B, branch vk/c3d4-...)
  └─ (untouched)
```

- **One card, one workspace — or several.** You can link multiple workspaces to the same card and run Claude, Codex and OpenCode in parallel, each in its own worktree.
- **Multi-agent pipelines.** `swarm-multi-agent.toml` orchestrates subagents on different fronts of the same epic. The **Orchestrator** is the singleton agent directing the whole board (`docs/cockpit/orchestrator.mdx`, `crates/services/src/services/orchestrator_compactor.rs` — with 400k-token / 1h / 10m-cooldown watchdog).

### Practical example: AssinaFácil in parallel

Epic **AssinaFácil — MVP** with sub-issues:

1. Landing page
2. Auth (login/signup)

You dispatch both at once:

- Workspace A (`vk-a1b2-landing`) — agent 1 writes `landing.tsx`.
- Workspace B (`vk-c3d4-auth`) — agent 2 writes `auth.tsx`.

Each runs its own `pnpm run check` in its worktree, no conflict. When both raise `VK-REVIEW-REQUEST`, you review the diffs in **Changes** and the app in each workspace's **Preview**, move the cards to Done, and the pipeline squash-merges into `main` — one at a time, no merge hell.

### Multi-agent jargon

| Term | Meaning here |
| --- | --- |
| **Swarm / crew** | A set of agents in different workspaces of the same project. |
| **Orchestration** | Deciding who does what and in what order — via `get_pipeline` / `report_pipeline_stage` (MCP). |
| **YOLO mode** | Running without asking permission on every tool call (`docs/vibe-guide.mdx:52` — "Use YOLO mode" for async to work; without it you reinvented pair programming, just slower). |
| **Needs Attention** | Workspace state in the sidebar when there's a pending approval — the agent raised its hand (`docs/workspaces/interface.mdx:70`). |

## 5. Quick glossary — the jargon you see everywhere

| Jargon | Practical translation |
| --- | --- |
| **Context engineering** | Choosing what the agent sees (files, logs, rules). The job of `AGENTS.md` and `get_rules`/`memory_search`. |
| **Prompt engineering** | Writing the card description so the agent gets it right (ch. 05: title with verb + done criterion). |
| **Spec intake** | Turning a vague request into a well-specified card before coding. |
| **Approval** | A pause asking permission — tool permission ("can I run `rm`?") or a question ("which priority?") — answered via TUI, Telegram or `respond_to_approval` (MCP). |
| **Setup / Cleanup / Dev scripts** | Per-project/repo commands Vibe Kanban runs when creating/opening/closing a workspace (Settings → Projects & Repositories). |
| **Worktree** | A lightweight repo copy with its own branch — the isolation that enables conflict-free multi-agent. |
| **Target vs Working branch** | Target = where it will merge (e.g., `main`, you define it); Working = where the agent works (`vk/xxxx`, auto-created). |
| **Preview proxy** | The Rust server that embeds the Node dev server inside the Preview panel (ch. 07). |
| **TUI / Telegram bridge** | Control surfaces for a solo dev: `vibe-tui` (`crates/tui`) in the terminal and `vibe-telegram-bridge` (`crates/telegram-bridge`) in Telegram — both talk to the same approvals API (`automation/README.md`). |
| **Squash-merge** | The `quick` pipeline joins the workspace commits into a single commit on the target branch. |
| **ADR** | Architecture Decision Record in `docs/ADR/` — the versioned architectural spec. |

## 6. Best practices — context, memory and autocompact

Level-3 vibe coding is not writing better prompts; it's **managing the agent's cognitive state**. Three levers: what it *sees* (context), what it *remembers* between sessions (memory) and how it *survives* long runs (autocompact). Mastering the three is what separates "asking" from "driving."

### 6.1 Context engineering — context is the AI's source code

**Context engineering** is the discipline of choosing what the agent sees each turn. The agent is only as good as what's in its window; everything outside it, for it, does not exist.

In Vibe Kanban, context is layered (ch. 10):

- `AGENTS.md` root (identity, map, commands) + `docs/AGENTS.md` (docs) + `packages/local-web/AGENTS.md` (UI) — each layer loads only when the agent touches that folder, saving tokens.
- `get_rules` (MCP) brings general rules at the start of each card; `get_pipeline` brings **only the current stage**, not the whole pipeline.
- Cards carry only a pipeline **pointer** (`<!-- vk:pipeline:start -->`), not the heavy prompt — the content enters the window only when the card runs.

**Context manipulation** (what you, human, do):

- **Inject context intentionally.** Attach a screenshot or a log snippet to the chat (`POST /api/attachments/upload`, ch. 05 §4) instead of describing "the error" at length — the image is worth a thousand words of context.
- **Reduce noise.** Use subagents (multi-agent, §4) so side work doesn't pollute the main window; don't cram the whole board into the prompt.
- **Prune dead context.** When the transcript grows large, advance `VK-PIPELINE-STAGE` and let the **OrchestratorCompactor** (§6.3) cut what doesn't matter.

> Golden rule: treat the *context window* as a finite budget. Every line you put in the card is one less line for the agent to reason with.

### 6.2 Autocompact — how the agent doesn't "forget" on long runs

**Autocompact** is the automatic compaction of the transcript when the context window is about to overflow. Without it, on multi-hour runs the agent "loses the beginning" — forgets the spec and starts contradicting what it did.

In Vibe Kanban, the watchdog is the **OrchestratorCompactor** (`crates/services/src/services/orchestrator_compactor.rs`):

- Measures transcript tokens **every 60s**.
- If it passes **400k tokens** (or 1h without compacting, with at least 50k), it types `/compact` in the tmux session.
- Types it **via keystrokes** (`tmux send-keys`), not as pasted text — because slash commands don't work as pasted text in an interactive session.
- **10min cooldown** between sends; **3 consecutive failures** escalate to Telegram (`crates/telegram-bridge`).

For you: you don't need to watch the context size — the watchdog handles it. For your SaaS (ch. 08): apply the same principle — cut dead context before overflowing, not after.

> **Manual compact vs autocompact:** `/compact` is the command the agent (or watchdog) fires; "autocompact" is that firing happening on its own. In agents without a watchdog, you send `/compact` yourself when the transcript grows.

### 6.3 Agent memory — mem0 (semantic + graph)

**Agent memory** is what lets the agent *remember between sessions* verified facts, instead of relearning everything each card. In Vibe Kanban this is **mem0**, exposed as MCP tools (`crates/mcp/src/task_server/tools/mem0.rs`):

| Tool | What it does | When to use |
| --- | --- | --- |
| `memory_search` | Search by **semantic similarity** (not keyword) | "How does the pipeline stage flow work?" before touching code |
| `memory_save` | Persists a **verified, durable** fact | After confirming an architectural decision |
| `memory_graph_traverse` | Traverses dependency edges from an entity | "What consumes the `VK-PIPELINE-STAGE` marker?" |
| `memory_check_staleness` | Checks whether a saved entity still exists in code (diff `commit_sha` → HEAD) | Before trusting an old memory |

**Semantic memory** (`memory_search`): answers by *meaning proximity*. You ask "what's the card-to-production flow?" and it ranks the most relevant passages — even if none contain the word "flow". `AGENTS.md` tip: if results don't cover what you need, **re-search with a sharper query** rather than asking for more hits — iterating beats broad searching.

**Graph memory** (`memory_graph_traverse`): follows the *actual structure* of the code. From a start node (`start`, e.g., `pipeline_stage.rs`), you go `out` (what depends on it), `in` (what it depends on) or `both`, up to `hops` steps (max 3). It's a "who uses this?" map — useful when semantics don't match but the dependency is clear.

**What to save (and what not to):**

- ✅ Save **verified** and durable facts (ADR decisions, contracts, where each crate lives). `memory_save` is *best-effort*: returns `stored=false` if mem0 is unavailable — not an error, just persist later.
- ❌ Don't save speculation, secrets, or ephemeral facts (today's target branch may change tomorrow).
- ❌ Don't save what's in `AGENTS.md` — duplicating context is wasted space.

**Staleness:** `memory_check_staleness` looks at the `commit_sha` captured when the memory was saved and diffs the repo to HEAD. If the entity's text vanishes from removed code, it's **stale**. `checked=false` means "couldn't verify" — treat as *unknown*, never as "confirmed fresh".

### 6.4 Other terms you will see

| Term | Practical translation |
| --- | --- |
| **Context window** | Max size (in tokens) of what the agent sees at once. Your budget (§6.1). |
| **Context engineering** | Choosing what enters that window — the job of `AGENTS.md`, `get_rules` and pruning. |
| **Autocompact** | Automatic transcript compaction when the window overflows (§6.2). |
| **Compact (manual)** | The `/compact` command that cuts the transcript keeping the essentials. |
| **Semantic memory** | Memory by meaning similarity (`memory_search`). |
| **Graph memory** | Memory by dependency edges (`memory_graph_traverse`). |
| **Embeddings** | How mem0 turns text into vectors to compare meaning (internal detail; you just use the search). |
| **Retrieval / RAG** | Recovering memory or docs to inject into context. |
| **Staleness** | Whether a memory still matches current code (`memory_check_staleness`). |
| **Scratch / Notes** | Per-workspace ephemeral draft (Notes panel, ch. 04) — not to be confused with persistent memory. |

### 6.5 Golden rules of best practices

- Treat the *context window* as a budget: inject the essential, cut the noise.
- Compact early — autocompact or `/compact` — on long runs, before overflowing.
- Save in memory **only verified and durable facts**; keep speculation and secrets out.
- Use **graph** to discover neighbors (who uses what) and **semantic** to recall *how* something works.
- **Check staleness** before trusting old memory — `checked=false` is not "fresh."
- Memory and context don't replace `AGENTS.md`: the canonical source lives in the file, not in volatile memory.

## 7. How it all comes together in 2 minutes

A typical flow, with the right vocabulary:

1. You do **spec intake**: write a "Plans page" card with the strong spec from §2 and a done criterion.
2. Create a **workspace** (worktree + working branch `vk/xxxx-plans`) linked to the card, choose the `quick` **pipeline** and dispatch the agent.
3. The agent enters the **Engineering Loop**: writes `plans.tsx` → `pnpm run check` → reads `TS2322` → fixes → `VK-PIPELINE-STAGE: 2`.
4. If it needs you, it raises `VK-REVIEW-REQUEST` or `Needs Attention` — you answer in the interface, the **TUI** (`cargo run -p tui`, key `a`) or **Telegram**.
5. When the done criterion hits (Preview 1440px + 375px ok, check passes, screenshot `saas-planos.png` matches), the card goes to **Done** and the pipeline **squash-merges** into `main`. Meanwhile another agent already runs in parallel on the "Auth" card — **multi-agent**.

In the next chapters you will live this flow in practice, starting with installation (ch. 03).

## Chapter checklist

- [ ] I can explain vibe coding, spec and engineering loop in one sentence each.
- [ ] I can turn "Make a plans page" into a strong spec with where/validate/constraints.
- [ ] I can describe the loop `write → check → read error → fix` with a real example (`TS2322`).
- [ ] I know why worktrees enable conflict-free multi-agent (and what target vs working branch means).
- [ ] I recognize the glossary terms (spec, multi-agent, glossary and best practices) when they appear in ch. 03–08.
- [ ] I know what context engineering is and how Vibe Kanban injects/prunes context (AGENTS.md layers, pipeline pointer, attachments).
- [ ] I know what autocompact is and which watchdog handles it (OrchestratorCompactor, 400k tokens, /compact via keys).
- [ ] I know the difference between semantic memory (memory_search) and graph memory (memory_graph_traverse), and what to save vs not.
- [ ] I can use memory_check_staleness before trusting old memory.
- [ ] I can narrate the 2-minute flow (spec → workspace → loop → review → merge) without opening the book.

---

# Chapter 3 — Installation and configuration

> **Principle:** the app runs locally and reads everything from a `projects.toml`. Install it once, point it at your repos, and the agents have a ready-to-use workspace.

## Official links

- **Website:** [aurapunk.dev](https://aurapunk.dev)
- **GitHub repository:** [github.com/flashlan/aurapunk-ide](https://github.com/flashlan/aurapunk-ide)

## Two ways to run

| Option | Command | When to use |
| --- | --- | --- |
| **npx (zero-install)** | `npx aurapunk-ide` | Quickest try; downloads and runs the latest release |
| **Clone + dev** | `git clone https://github.com/flashlan/aurapunk-ide.git && pnpm install && pnpm run dev` | When you want to customize Aurapunk IDE (Part II) |

Both open the same UI at `http://localhost:3001` (backend `:3002`, preview proxy `:3003`). If a port is taken, see the `AddrInUse` troubleshooting in ch. 02 §5 / ch. 13.

## projects.toml — the single source of project config

Aurapunk IDE does not store project settings in a database you edit by hand; it reads a `projects.toml` at the repo (or workspace) root. A minimal but complete example:

```toml
# projects.toml
version = 1

[project]
key = "AF"                       # issue prefix -> cards become AF-1, AF-2...
name = "AssinaFácil"
sort_order = 1
color = "#3b82f6"

[project.statuses]
# project_status — these ARE the kanban columns
todo = { name = "Próximos passos", color = "#64748b" }
in_progress = { name = "Em andamento", color = "#3b82f6" }
in_review = { name = "Em revisão", color = "#f59e0b" }
done = { name = "Concluído", color = "#10b981" }

[project.agent]
default_working_dir = "packages/web-core"
default_target_branch = "main"

[repo]
path = "."
setup_script = "pnpm install"
dev_server_script = "pnpm run dev"
```

What each field drives:

- `key` — issue prefix (`AF`) used in Simple IDs and card titles.
- `statuses` — the board columns (ch. 04). Rename them freely; the UI reflects them instantly.
- `agent.default_target_branch` — where workspaces merge (the **Target** branch).
- `repo.setup_script` / `dev_server_script` — run automatically when a workspace is created/opened (the **Setup / Dev scripts** from ch. 02 §5).

> The `AGENTS.md` of this repo documents the same fields — keep `projects.toml` as the source; `AGENTS.md` explains the *why*.

## Setup, Dev and Cleanup scripts

Three per-repo hooks the app runs for you:

| Script | Runs when | Example |
| --- | --- | --- |
| **Setup** | Workspace created | `pnpm install` |
| **Dev server** | Workspace opened | `pnpm run dev` (embeds Preview) |
| **Cleanup** | Workspace closed/deleted | free ports, stop processes |

You edit them in **Settings → Projects & Repositories** (or directly in `projects.toml`). They are what makes a fresh workspace "just work" — the agent never has to figure out how to boot your app.

## First run checklist

- [ ] `npx aurapunk-ide` (or clone + `pnpm run dev`) opens at `:3001`.
- [ ] `projects.toml` exists with at least `key`, `statuses` and `dev_server_script`.
- [ ] Creating a workspace runs `setup_script` without errors (check the **Logs** panel).
- [ ] The **Preview** panel shows your app (or "set up dev server" prompt if the script is missing).
- [ ] `AGENTS.md` is present at the repo root so agents read context on first turn.

## Troubleshooting

- **`AddrInUse` on :3001/:3002/:3003** — another instance holds the port. Find it: `lsof -nP -i :3002 -sTCP:LISTEN` and check the process `cwd`; don't kill the wrong one (ch. 02 §5).
- **Agent can't find commands** — your `setup_script` didn't run or `packageManager` mismatches; pin `pnpm` in `package.json` (`engines` + `packageManager: pnpm@10.13.1`, as this repo does).
- **Preview blank** — `dev_server_script` didn't start or points at the wrong command; open **Logs** and read the error (ch. 13).

---

# Chapter 4 — Interface tour

> **Goal:** know where everything lives before creating your first card.

## The app as a map

Everything in Vibe Kanban happens in two places:

1. **Project board** — where you plan (cards and columns).
2. **Workspace view** — where you execute (conversation with the agent + diffs + preview).

The **global sidebar** (left bar, present on every screen) connects the two. It is described in `docs/workspaces/interface.mdx:54`.

## The global sidebar — read in 10 seconds

```
Projetos
 └─ My SaaS (root project)
    ├─ Tasks          ← the cards of this project
    └─ Workspaces     ← all workspaces of this project (Active / Running / Idle / Archived)
```

- **Projects** at the top, with **+** to create a project.
- Each project has **Tasks** (the cards) and, if root, **Workspaces** aggregated.
- Workspaces appear as leaves grouped into **Active / Running / Idle / Needs Attention / Archived**. A blue dot means the dev server is running; a badge means a linked PR; a raised-hand icon means `Needs Attention` (pending approval).
- For a flat list with search/filters, open the **Workspaces dashboard** (`/workspaces`).

Shortcut that saves time: `Cmd/Ctrl + K` → type the project or workspace name — the command bar (`docs/workspaces/command-bar.mdx`) takes you there without scrolling.

## The board (kanban) — where you plan

Open a project to land on the board (`docs/getting-started.mdx:44`). The board has 4 zones:

1. **App bar** (top) — navigate between projects, Workspaces and **Settings** (gear). It's where you import `projects.toml` and switch agent/IDE.
2. **Columns** — each column is a `project_status` (e.g., Todo → Next steps / In Progress → In progress / In Review → In review / Done → Done). Configurable per project via `projects.toml → statuses` (`docs/cockpit/local-projects.mdx`).
3. **Cards** — issues as cards. Each card shows title, priority, tags and Simple ID (`AF-1`). Each column header has a **+** that creates a card already in that column — and the **New Issue** button does the same.
4. **Right panel** — details of the selected card (or the draft being created). It hosts **Workspaces**, **Sub-Issues** and **Comments** (ch. 05).

**Book anchor — main board:**

![Main board — project "Novo aplicativo SaaS" with columns Next steps / In progress / In review / Done](../images/livro/ancora-board-principal.png)

*The book's board (project "Novo aplicativo SaaS"): 4 PT-BR columns — Próximos passos, Em andamento, Em revisão, Concluído (configurable `project_status` via `projects.toml` → `statuses`, `docs/cockpit/local-projects.mdx`). Each column shows its count; the right panel opens the selected card. Site reference screenshots: `/images/onboarding-projects.png`.*

> **30-second exercise:** count the columns in the anchor above. There are 4 — the same ones you declared in `projects.toml` in ch. 03. Change `statuses` to 3 or 5 and reload — the board reflects it instantly. That's how you feel that the board is just a view of `project_status` in SQLite (`crates/db/src/models/project_status.rs`).

**Book anchor — open workspace:**

![Open workspace — Conversation left, Context (Changes/Logs/Preview) center, Details (Git/Terminal) right](../images/livro/ancora-workspace-aberta.png)

*AssinaFácil workspace open: Conversation with the agent on the left; Context alternating Changes/Logs/Preview in the center; Details with Git/Terminal/Notes on the right — exactly the three panels of `docs/workspaces/interface.mdx:10`.*

## The workspace view — the three panels (where you execute)

Opening a workspace (`docs/workspaces/interface.mdx:10`), the screen splits into:

| Panel | Position | What it's for | When you use it |
| --- | --- | --- | --- |
| **Conversation** | Left (main) | Chat with the agent, switch sessions, send follow-ups | 80% of the time — where you ask and correct |
| **Context** | Right (main, switchable) | **Changes** (diffs) / **Logs** (stdout) / **Preview** (embedded browser) | To review what the agent did and see the app running |
| **Details Sidebar** | Right edge | Git (repo/branch, ahead/behind), Terminal (xterm.js), Notes | For git, commands and quick notes |

You don't need to memorize — the **workspace navbar** (`docs/workspaces/interface.mdx:20`) has buttons to toggle each panel:

- Left: **Archive Workspace**.
- Center-right (panel controls): Toggle Left Sidebar / Chat / Changes / Logs / Preview / Right Sidebar.
- Right (utilities): **Spawn Orchestrator**, **Command Bar** (`Cmd/Ctrl + K`), **Projects Guide**, **Settings**.

One time-saving tip: the **Context Bar** — a draggable floating bar with shortcuts to open in IDE, copy workspace path, start dev server and switch Preview/Changes — described in `docs/workspaces/interface.mdx:239`.

### Conversation panel — your channel to the agent

- Full history with the agent, rich text and plan approval.
- **Session dropdown** in the chat toolbar: switch between sessions, create **New Session** when context grows large (the agent warns; see ch. 14 watchdog at 400k tokens).
- Shortcuts: `Cmd/Ctrl + Enter` sends; `Shift + Cmd/Ctrl + Enter` sends in alternate mode; `Cmd/Ctrl + B/I/U` formats.
- **Attachments:** drag-and-drop an image straight into the chat — the app uploads to `POST /api/attachments/upload` (`crates/server/src/routes/attachments.rs:83`, 20 MB, `image/png|jpeg|gif|webp`) and the agent receives it as visual context. Best way to send a mock or error screenshot (ch. 05 §4 detail).

### Context panel — Changes / Logs / Preview (switch with one click)

- **Changes** (`/images/workspaces-changes-panel.png`): modified-files tree + diffs with syntax highlight + **inline comments** to give the agent feedback ("this diff should touch `plans.ts`, not `landing.tsx`").
- **Logs** (`/images/workspaces-logs-panel.png`): tabs per process, in-log search, real-time stdout/stderr. This is where you see `VK-PIPELINE-STAGE: N` reported live as the agent advances the pipeline (ch. 06) — and `VK-REVIEW-REQUEST` when it needs you.
- **Preview** (`/images/workspaces-preview-panel.png`): embedded browser brought up via **Preview proxy** (Rust) + your **Dev server script** (Node, `projects.toml` or Settings). Supports multiple tabs, desktop/mobile modes and auto URL detection from logs (`docs/browser-testing.mdx:34`). For the SaaS of ch. 08, this is where you see `http://localhost:5173` running.

> **When to use each:** Changes to review code, Logs to understand why `check` broke, Preview to validate visually. The agent writes to all three — you read all three.

### Details sidebar — Git / Terminal / Notes (always at hand)

- **Git** (`/images/workspaces-git-panel.png`): current repo and branch (`vk/xxxx-*`), target branch, uncommitted count, ahead/behind — and a shortcut for **Create PR / Merge / Rebase** (`docs/workspaces/git-operactions.mdx`, ch. 07).
- **Terminal** (`/images/workspaces-terminal.png`): xterm.js right in the workspace environment — run `git status`, `pnpm run check`, `cargo test` there. Persists across panel switches.
- **Notes** (`/images/workspaces-notes.png`): rich-text editor per workspace (auto-save). Use it to note card decisions — the next agent opening the workspace reads them.

## Command bar and shortcuts that matter

`Cmd/Ctrl + K` opens the command bar (`docs/workspaces/command-bar.mdx`) — create workspace, archive, duplicate, switch panels, issue actions, all without the mouse. The 3 shortcuts you'll use daily:

| Shortcut | Where | Does |
| --- | --- | --- |
| `Cmd/Ctrl + K` | Global | Command bar |
| `Cmd/Ctrl + Enter` | Chat | Send message |
| Drag image → chat | Chat | Attach as visual context |

## Chapter checklist

- [ ] I can point on the board: app bar, columns, cards, right panel — and create a card via the column **+** or New Issue.
- [ ] I can point in the workspace: Conversation, Context (Changes/Logs/Preview) and Details (Git/Terminal/Notes).
- [ ] I can use the global sidebar to navigate projects and workspaces by state (Active/Running/Needs Attention).
- [ ] I can switch Context between Changes/Logs/Preview and open the embedded terminal.
- [ ] I can open the command bar (`Cmd/Ctrl + K`) and send a message in chat.

---

# Chapter 5 — Cards and Kanban: the lifecycle in practice

> **Principle:** a card is a contract. The better you write it, the less you correct.

## The create-card dialog, in two parts

The dialog has two zones:

1. **Top** — Title, Status, Priority, Tags (and the agent/model picker).
2. **Bottom** — Description (the spec that becomes the agent's prompt) + Save.

**Book anchor — create card (top):**

![Create card — top: Title, Status, Priority, Tags](../images/livro/ancora-criar-card-topo.png)

*The top of the dialog: a verb-led Title ("Create plans page"), Status (drops into the column), Priority (urgent/high/medium/low) and Tags. These four fields are what the board shows on the card without opening it.*

**Book anchor — create card (bottom):**

![Create card — bottom: Description + Save](../images/livro/ancora-criar-card-base.png)

*The bottom: the Description is where the spec lives (ch. 02 §2). A strong description has what/where/validate/constraints. Save creates the card and its first workspace-ready draft.*

> Exercise: open **New Issue** and write a card titled "Add retry to webhook handler" with priority `high` and tag `reliability`. Notice the card immediately shows those on the board — no agent needed yet.

## Creating a card from a Workspace

You don't have to start from the board. Inside a workspace:

1. Open the **Workspaces** section of the right panel.
2. Click **Create** — a card is born linked to that workspace, pre-filled with the workspace's repo/branch.

**Book anchor — create card / Workspaces section:**

![Create card — Workspaces / Create section](../images/livro/ancora-criar-card-workspace.png)

*The right panel's Workspaces area with a Create button — the card inherits the workspace context, so the agent already knows the branch and repo.*

## The lifecycle: Todo → In Progress → In Review → Done

| Stage | What happens | Who moves it |
| --- | --- | --- |
| **Todo** | Card written, not started | You |
| **In Progress** | Agent dispatched in a workspace; pipeline running | Agent (via pipeline) |
| **In Review** | Agent raised `VK-REVIEW-REQUEST` or finished; awaiting you | You (after review) |
| **Done** | Validated (Preview + check) and merged | You |

A card can have **Sub-Issues** (the epic → sub-issues pattern of ch. 08) and **Comments** for threaded feedback.

## The chat bar, dissected

The workspace chat bar is where you drive the agent daily:

**Book anchor — workspace chat bar:**

![Workspace chat bar: Tasks, template, presets, permissions, attachments](../images/livro/ancora-workspace-chat-bar.png)

| Control | What it does |
| --- | --- |
| **Tasks** | Quick link to the linked card and its sub-issues |
| **Template** | Reuse a prompt template for similar cards |
| **Presets** | Saved agent/model/permission presets (e.g., YOLO mode on) |
| **Permissions** | Approve/deny tool permissions for this session |
| **Attachments** | Drag an image in — becomes agent context (ch. 04) |

## Chapter checklist

- [ ] I can create a card from the board (+) and from a workspace (Workspaces → Create).
- [ ] I know the two parts of the dialog (top fields / bottom description) and why the description is the spec.
- [ ] I can move a card through Todo → In Progress → In Review → Done and say who moves it each time.
- [ ] I can attach an image to chat and know it becomes agent context.
- [ ] I recognize the chat bar controls (Tasks, template, presets, permissions, attachments).

---

# Chapter 6 — Pipelines in practice

> **Principle:** a pipeline is a recipe the agent follows without you repeating yourself. The card moves; you watch.

## What a pipeline is

A pipeline is a TOML file in `assets/pipelines/*.toml` that lists **stages** with prompts. When a card uses a pipeline, the agent executes stage by stage and reports progress via `VK-PIPELINE-STAGE: N`. The pipeline is the "how" between your spec (the card) and the done state.

## The 9 recipes available

| Pipeline | Shape | Use |
| --- | --- | --- |
| `quick` | implement → verify → manual review (alarm) | Trivial cards; the default |
| `basic` | spec → implement → verify → review | Small features |
| `speckit` | generate SPEC.md → plan → implement | When spec must be written first |
| `swarm-multi-agent` | orchestrate subagents | Parallel fronts of one epic |
| `wikillm` | doc-heavy loop | Writing/explaining tasks |
| `async-*` (variants) | headless, no per-step prompts | Background runs |

## Anatomy of `quick.toml`

```toml
[[stage]]
id = "implement"
label = "Implement directly"
default_enabled = true
prompt = "Implement the card. Run pnpm run check. Report VK-PIPELINE-STAGE: 1."

[[stage]]
id = "review-manual"
label = "Manual review (alarm)"
default_enabled = false
prompt = "MANUAL REVIEW: stop here and hand the work to the operator..."
```

Each stage is a **prompt fragment** with `id`, `label` and `default_enabled`. The card carries only a **pointer** to the pipeline (`<!-- vk:pipeline:start -->`); `get_pipeline` resolves the heavy content at run time — so the prompt enters the agent's window only when the card runs, not on every board listing.

A **tripwire** example: `quick.toml` escalates trivial → light when a condition hits, via the `VK-ESCALATE` marker — letting a cheap card ask for a human only when it truly needs one.

## How progress shows up

As the agent advances, it writes `VK-PIPELINE-STAGE: N` to the log. The service `crates/services/src/services/pipeline_stage.rs` parses it (regex with boundary guard) and persists `workspaces.current_pipeline_stage`. The card's progress checklist updates live in the UI — and you see the number in **Logs** (ch. 04).

> **5-minute exercise:** open a card, assign the `quick` pipeline, dispatch the agent, and watch `VK-PIPELINE-STAGE: 1` then `2` appear in the Logs panel. That single line is the whole orchestration contract.

## Chapter checklist

- [ ] I know a pipeline is a TOML recipe with stages and prompts.
- [ ] I can name at least 4 of the 9 recipes and when to use them.
- [ ] I understand the card carries only a pipeline pointer, not the prompt.
- [ ] I can read `VK-PIPELINE-STAGE: N` in the Logs panel and know what it means.
- [ ] I know the `review-manual` stage raises `VK-REVIEW-REQUEST` (the alarm).

---

# Chapter 7 — Git, workspaces and worktrees

> **Principle:** every card gets an isolated git worktree. You never touch `main` directly, and parallel agents never collide.

## The worktree-manager cycle

Each workspace maps to a git worktree created by `crates/worktree-manager` and tracked by `crates/workspace-manager` / `crates/git`. The cycle:

```
create workspace → git worktree (branch vk/xxxx-name) → agent works → you review → squash-merge to target
```

The original repo stays untouched until the merge. This is why multi-agent (ch. 02 §4) is conflict-free.

## The three panels, for git

The **Details sidebar → Git** (`docs/workspaces/interface.mdx:10`) shows:

- Current repo and branch (`vk/xxxx-name`).
- Target branch (where it will merge).
- Uncommitted count, ahead/behind.

Shortcuts there: **Create PR**, **Merge**, **Rebase**.

## Changes → Preview → Terminal: the review loop

1. **Changes** — review the diffs; leave inline comments for the agent ("this belongs in `plans.ts`").
2. **Preview** — open the dev server in the embedded browser; validate visually.
3. **Terminal** — run `git`, `pnpm`, `cargo` in the workspace environment (xterm.js).

Feedback is inline: the agent reads your comment and adjusts in the same workspace.

## Duplicate / Archive / Pin

- **Duplicate** a workspace to fork an experiment from a known-good state.
- **Archive** when done (stops the dev server, keeps the branch).
- **Pin** to keep a workspace at the top of the sidebar.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `AddrInUse` on dev port | Another instance holds it; `lsof -nP -i :3002` + check `cwd`; don't kill the wrong one (ch. 02 §5) |
| `VK-REVIEW-REQUEST` stuck | Agent finished but you didn't answer; open the approval in TUI/Telegram/`respond_to_approval` |
| Worktree won't create | Target branch missing locally; fetch it first |
| Merge conflict | Branches diverged; rebase the workspace onto target, re-run `check` |

## Chapter checklist

- [ ] I know each workspace is a git worktree with its own `vk/xxxx` branch.
- [ ] I can review via Changes → Preview → Terminal without leaving the UI.
- [ ] I can Create PR / Merge / Rebase from the Git panel.
- [ ] I know Duplicate / Archive / Pin and when to use them.
- [ ] I can diagnose `AddrInUse` and a stuck `VK-REVIEW-REQUEST`.

---

# Chapter 8 — Practical project: Building a SaaS with Vibe Kanban

> **Principle:** the best way to learn the interface is to ship something real. We build **AssinaFácil**, a fictional subscription-management SaaS, entirely through cards and workspaces.

## The setup spec (reuse from ch. 02)

A monorepo with three packages: `app-web` (Vite), `web-core` (shared), `ui` (design system). The agent runs `pnpm run dev`; Preview shows "Hello AssinaFácil".

## The SaaS walkthrough

| # | Card | What it delivers | Anchor |
| --- | --- | --- | --- |
| 1 | Setup monorepo | `pnpm run dev` boots; Preview shows "Hello AssinaFácil" | — |
| 2 | Landing page | Hero + CTA working | `saas-landing.png` (desktop 1440×900) + `saas-landing-mobile.png` (390×780) |
| 3 | Auth — login/signup | Forms with validation; mocked state | (future anchor `saas-auth.png`) |
| 4 | Plans & checkout | 3-plan table; Subscribe → /checkout mock | `saas-planos.png` + `saas-checkout.png` |
| 5 | Logged area | Mocked list; Cancel changes state | `saas-minhas-assinaturas.png` |
| 6 | Webhooks | `POST /webhooks` changes entitlement; test via workspace Terminal | — |

Each anchor is captured when the card reaches Done (drag the image into the workspace chat — `crates/server/src/routes/attachments.rs:83` — or save directly; ch. 15).

**Anchors of AssinaFácil (previews generated):**

![Landing — AssinaFácil (hero + MRR + features)](../images/livro/saas-landing.png)

![Plans — 3 columns, Pro highlighted](../images/livro/saas-planos.png)

![Checkout — form + summary](../images/livro/saas-checkout.png)

![My subscriptions — logged table with actions](../images/livro/saas-minhas-assinaturas.png)

*Previews generated in PIL for the book — replace with real Preview screenshots when the cards reach Done; keep 1440×900 for stable comparison.*

## The 6-card epic

Write the epic **AssinaFácil — MVP** with the 6 sub-issues above. Dispatch 1 and 2 in parallel workspaces (ch. 02 §4). Each card: Todo → In Progress → In Review → Done with Preview validated. Merge/PR of each workspace when Done.

## When something goes wrong (shortcuts)

- **Preview blank** — dev server script missing; check Logs.
- **`VK-REVIEW-REQUEST`** — agent needs you; answer in UI/TUI/Telegram.
- **Port conflict** — `AddrInUse`; see ch. 02 §5.
- **Needs Attention** — an approval is pending; the hand is raised in the sidebar.

## Chapter checklist

- [ ] Epic + 5 sub-issues created; at least 2 workspaces ran in parallel.
- [ ] Each card did Todo → In Progress → In Review → Done with Preview validated.
- [ ] Screenshots `docs/images/livro/saas-*.png` captured.
- [ ] Merge/PR of each workspace completed; final board in Done.

---

# Chapter 9 — From writing to Amazon KDP

> **Principle:** publishing is a pipeline like any other — with stages, a checklist and a done criterion. The only difference is that the "deploy" is a store.

## Write here, publish there

This book was born as `docs/livro/*.md` inside the very repository it describes. That is no accident — it is the loop of ch. 05 taken to the extreme: the manuscript is versioned, reviewed in a PR, checked by `pnpm run check` and anchored by images, exactly like code. When the content is ready, it crosses the boundary out of the repo and becomes a product on Amazon. The checklist governing that crossing lives in `docs/livro-vibe-kanban-amazon-checklist.md`.

This chapter does not repeat the checklist line by line — it explains **how to decide** at each point where KDP gives you choices.

## Five decisions that matter

### 1. eBook, paperback or both?

Start with Kindle eBook. Zero marginal cost (Kindle Create is free), hours to publish, up to 70% royalties and global distribution without logistics. Paperback is stage two: it requires a PDF body with trim-size margins, a full-cover PDF (front+spine+back, KDP cover calculator template, bleed 0.125", 300 DPI, CMYK) and a physical proof. The checklist separates the two tracks — Phase 5 (eBook) and Phase 6 (paperback) — so you can launch the eBook first and iterate.

### 2. Price and royalty

KDP gives two options per eBook (rules verified Aug/2026; revalidate before publishing):

- **70%** between US$ 2.99 and **US$ 12.99** (ceiling raised from US$ 9.99 in Jul/2026), with a US$ 0.15/MB delivery fee. Sales to Brazil/Japan/Mexico/India pay 70% only if the book is in KDP Select.
- **35%** between US$ 0.99 and US$ 200 (minimum rises with file size), no delivery fee.

For a technical manual with images, file size matters: a heavy-screenshot eBook may pay a real delivery fee in the 70% band. Simulate both before deciding. Paperback pays 50% or 60% minus print cost, with a US$ 9.99 cut.

### 3. KDP Select: yes or no?

KDP Select gives 90 days of digital exclusivity in exchange for: Kindle Unlimited (paid per page read), extra promos and — the point here — **70% in Brazil**. If your main audience is in Brazil, Select pays for itself. If you must also sell on Apple Books/Kobo, don't enroll. The decision reverses every 90 days.

### 4. Categories and keywords

You get **up to 3 categories** per format (chosen in the KDP selector; the old "email for 10 more" scheme is gone) and **7 fields of 50 characters** for keywords. The lesson from ch. 04 holds: the "spec" of discoverability is textual. Categories say where the book appears; keywords say for whom. Pick categories where a new book can rank; use keywords to cover searches the title misses. Each eBook, paperback and hardcover has its own 3+7 slots.

### 5. When to order the physical proof

Always, before releasing the paperback. The proof costs print + shipping and is the only way to validate margins, spine, colors (CMYK) and legibility at real size — the digital previewer lies about those details.

## The done criterion

The checklist ends with four boxes:

- eBook live on Amazon.
- Paperback live (if chosen).
- Author page created in Author Central.
- Metadata reviewed on the product page.

Translated to pipeline language: `VK-PIPELINE-STAGE: done` only when a reader can buy, open and recommend it. Until then it's a draft — however much the `git log` says "done".

## Chapter checklist

- [ ] Manuscript in `docs/livro/` reviewed with anchored images (ch. 15).
- [ ] eBook cover at 1600×2560, readable as thumbnail.
- [ ] Metadata (title, 4000-char description, 3 categories, 7×50 keywords) filled.
- [ ] Price simulated in both royalties; KDP Select decision taken.
- [ ] Paperback physical proof approved (if any).
- [ ] Author Central created and internal `VK-REVIEW-REQUEST` answered: the book is ready for a paying reader.

---

# Chapter 10 — The Vibe Coding Setup

> **Principle:** context is the AI's source code. Before writing a line of code, write the files that tell a machine how the project works.

## The problem this chapter solves

A coding agent arrives at your repo like a new dev on day one: it doesn't know where anything lives, which commands run, or what must never be touched. A human would ask; the agent **assumes** — and assuming wrong is expensive. The Vibe Coding Setup is the documentation that turns assumption into reading.

## The context files — one canonical, the rest point

The ecosystem converged on context files at the repo root, read automatically by tools:

| File | Who reads |
| --- | --- |
| `AGENTS.md` | Open standard (agents.md): OpenCode, Codex, Cursor and any compatible tool |
| `CLAUDE.md` | Claude Code |
| `.clinerules` | Cline |
| `.cursorrules` / `.cursor/rules/` | Cursor (legacy; now `.cursor/rules/`) |

You don't need all. You need **one canonical and pointers**. Here: `AGENTS.md` at the root is canonical (written for "every agent that works here — Claude Code, OpenCode, Codex, Cursor"), and `docs/CLAUDE.md` exists as a bridge. Maintaining two files with the same content invites drift; keep one and reference.

## Anatomy of a working AGENTS.md (with real lines)

The root `AGENTS.md` is a good specimen. Section by section, and why each:

### 1. Identity in one sentence

> "Aurapunk IDE — the independent, self-hosted fork of vibe-kanban (BloopAI), built for a single-developer process (no team, no cloud, no auth). It is based on the Vibe Kanban Indie fork (dexloom)…"

That line alone stops an agent from "helping" by reintroducing cloud code — and there's an explicit section listing deleted crates (`crates/remote`, `crates/relay-*`) with "do not reintroduce".

### 2. Live work state — the Board Status

```
## Board Status (agent-maintained checklist)
- [x] Done — Add image attachment to create issue dialog (`vk/5f5b-...`)
- [ ] In Review — Livro Vibe Kanban na Amazon (`vk/1f98-livre-vibo-kanba`)
```

One line per card, with the branch (`vk/xxxx-slug`) so another agent can `git switch` directly. Context isn't only static — it's the current state of in-flight work.

### 3. Interaction protocols — the file becomes a behavior contract

This repo goes beyond documenting: it defines **MCP protocols** the agent must run — fetch the card's pipeline (`get_pipeline`), report stage (`report_pipeline_stage` + `VK-PIPELINE-STAGE: N` line), fetch general rules (`get_rules`). The context file becomes a behavior contract.

### 4. Territory map

"Project Structure & Module Organization": a paragraph per top-level directory (`crates/`, `packages/`, `shared/`, `assets/`…), including the warning "shared/types.ts is generated — don't edit by hand". The agent that reads this doesn't waste time searching or edits the wrong file.

### 5. Canonical commands

Exactly how to run: `pnpm i`, `pnpm run dev`, `pnpm run check`, `cargo test --workspace`, `pnpm run generate-types`, `pnpm run format`. Ch. 13 is all about this.

### 6. Conventions and traps

Style (rustfmt, Prettier 2-space/single-quote/80-col), fixed dev ports (3001/3002/3003), "never commit secrets", "run `pnpm run format` before completing".

### 7. Architectural decisions

It points to `docs/ADR/` as where decisions live — and tells the agent to consult before proposing alternatives.

## Context in layers: one AGENTS.md per scope

- `AGENTS.md` (root) — whole repo.
- `docs/AGENTS.md` — Mintlify writing rules, only for doc editors.
- `packages/local-web/AGENTS.md` — web design system and styling.

An agent editing a React component doesn't need the doc-writing rules; an agent editing docs doesn't need Tailwind conventions. Context per directory avoids diluting what matters — and saves tokens each session.

> **Exercise:** create `AGENTS.md` in your SaaS with 4 sections — identity (1 sentence), map (1 line per folder), commands (`dev`/`check`/`format`) and "what is generated / what never to do". When an agent creates `shared/types.ts` by hand and breaks CI, you'll know the "don't edit by hand" line was missing.

## Reproducible environment

- **Runtime versions:** `package.json` declares `engines: node >= 20, pnpm >= 8` and `packageManager: pnpm@10.13.1`; the Cargo workspace declares `edition = "2024"` and a shared version.
- **Fixed dev ports:** frontend 3001, backend 3002, preview proxy 3003 — documented in `AGENTS.md` and exported by `pnpm run dev`. No agent guesses a port.
- **Secrets out of repo:** `.env` for local overrides; Telegram config in `~/.vibe-kanban/telegram.toml` with a committed example (`automation/telegram.toml.example`).

## Chapter checklist

- [ ] A canonical context file exists at the root (and pointers, not copies, for specific tools).
- [ ] It opens with what the project **is and is not** (includes what was removed and must not return).
- [ ] It lists the exact install/dev/check/test/format commands.
- [ ] It lists what is generated and cannot be hand-edited.
- [ ] Scope-specific context lives in the subfolder's `AGENTS.md`.
- [ ] Runtime versions, package manager and ports are declared.
- [ ] Secret files have a committed example and an ignored real file.
- [ ] A new agent can make its first commit without asking anything — test with `vk/quick`.

---

# Chapter 11 — Spec-driven architecture: Node × Rust boundaries

> **Principle:** the spec defines who does what. If the boundary between languages isn't drawn, the agent draws it wrong.

## Why separate — the one-sentence rule

A vibe-coded project that mixes everything in one runtime confuses any agent: it doesn't know whether to use `fetch` or `reqwest`, `fs` or `std::fs`, `npm` or `cargo`. Separate by responsibility — and make the separation **visible in the directory structure** — is what lets an AI (and a human) pick the right tool without guessing.

The rule used here:

- **Rust does state, processes and trust.** HTTP/WebSocket, database, git, filesystem, agent spawning, orchestration. Whatever must be durable, concurrent or type-safe.
- **TypeScript does presentation and interaction.** React components, routing, UI state, theme, i18n.

The boundary isn't taste — it's a contract. And generated contracts (ch. 12) beat conventions.

## The territory (real case — read with `ls`)

The Cargo workspace (`Cargo.toml` root, `edition = "2024"`, `version = "0.2.41"` shared) declares **19 crates**. Read them in groups:

| Group | Crates | Responsibility in one sentence |
| --- | --- | --- |
| **Core** | `server` | Main binary (axum 0.8, rustls aws-lc-rs): mounts the `Router`, serves the API and frontend assets; exposes `generate_types` |
|  | `db` | SQLx models + **93 migrations**: `projects`, `issues`, `workspaces`, `sessions`, `execution_processes`, `tags`, `merges`… |
|  | `api-types` | Shared API types consumed by `server` and `db` (source of the TS contract) |
|  | `services` | Domain logic: `local_kanban`, `review_request` (alarm), `pipeline_stage`, `pr_monitor`, `orchestrator_compactor`… |
| **Git & workspaces** | `git` / `git-host` / `worktree-manager` / `workspace-manager` | Git ops, worktrees and workspace lifecycle (ch. 07) |
| **Execution** | `executors` | One module per supported agent (`claude`, `codex`, `gemini`, `opencode`, `cursor`, `amp`, `copilot`, `droid`, `qwen`, `antigravity`, `acp`) + `qa_mock.rs` for tests without tokens |
| **Integration** | `mcp` | The `vibe-kanban-mcp` server and its tools (`get_pipeline`, `get_rules`, `report_pipeline_stage`…) |
| **Supervision** | `tui` (`vibe-tui`) / `telegram-bridge` (`vibe-telegram-bridge`) | Terminal cockpit + send-only daemon escalating approvals to Telegram |
| **Infra** | `utils`, `client-info`, `server-info`, `local-deployment`, `deployment`, `preview-proxy`, `review`, `tauri-app` | Utilities, `MsgStore`, client detection, preview proxy, PR review, Tauri app |

The frontend lives in `packages/`:

| Package | Role | Where to look |
| --- | --- | --- |
| `local-web` | Local web entrypoint (Vite, `app/` + `routes/`, `routeTree.gen.ts` from TanStack Router) | `packages/local-web/src/` |
| `web-core` | Shared library (`app/`, `features/`, `pages/`, `integrations/`, `i18n/`, `shared/`) | `packages/web-core/src/` |
| `ui` | Design system (consumed by `web-core` and `local-web`) | `packages/ui/` |

The contract between the two worlds lives in `shared/` — subject of the next chapter.

> **How to use this map in your SaaS:** if your AssinaFácil is Node-only, the equivalent is separating `apps/web` (Next), `packages/api` (routes + DB) and `packages/shared` (types). The lesson isn't "use Rust" — it's "each folder has a one-sentence owner, and the owner is written in `AGENTS.md`".

## How the boundary materializes — 3 concrete cuts

### 1. API REST + WebSocket (who talks to whom)

`server` exposes routes in `crates/server/src/routes/` — `kanban.rs`, `local_kanban.rs`, `execution_processes.rs`, `workspaces/`, `sessions/`, `approvals.rs`, `events.rs` (log stream), `terminal.rs`, `attachments.rs`… The frontend in `web-core` consumes via `fetch` and `WebSocket` — **never touches SQLite directly**. If an agent tries `import { db } from "db"` in the frontend, `check` breaks — and it should.

### 2. Preview of the dev server (who hosts whom)

The `preview-proxy` crate (Rust) is the **proxy** that `server` uses to embed the user's dev server (Vite/Next in Node) inside the workspace Preview panel (ch. 04). The user's app runs in Node; the proxy hosting it runs in Rust. That's the boundary incarnate: two runtimes, one `iframe`.

### 3. Type generation (who is the source)

Rust structs in `db` and `api-types` with `#[derive(TS)]` become `shared/types.ts` (ch. 12). The type is born in Rust, crosses the boundary **generated**, and TypeScript consumes it without redeclaration.

### Flow of a card to production code

```
UI (React, :3001) ──REST/WS──► server (axum, :3002) ──► services ─┬─► db (SQLite/SQLx, 93 migrations)
                                                                 ├─► worktree-manager (git worktree in /tmp/vibe-kanban/…)
                                                                 ├─► executors (spawn Claude/Codex/… in tmux)
                                                                 └─► MsgStore (log back via WS to UI + trackers)
```

The log the agents write in `MsgStore` is read back by the frontend **and** by the pipeline trackers (`pipeline_stage.rs`, `review_request.rs`) — the log is both human interface and machine interface (ch. 13).

## Where to keep decisions — ADR and what must not return

Boundaries generate architectural decisions that must outlive the moment. The repo has `docs/ADR/` and the root `AGENTS.md` is explicit:

> "when a non-trivial decision is made (new subsystem, refactor, removed feature), record it as an ADR before or right after, with Status/Date/Context/Decision/Consequences."

This book is, in part, a narrated ADR. There's also the **"Legacy cloud/remote code"** section in `AGENTS.md`: crates `remote`, `relay-*` were deleted, and the file lists what must not return — but preserves `shared/remote-types.ts` as a **frozen contract** (ch. 12). A well-documented boundary explains not just what exists, but **what was removed and why**.

## Chapter checklist

- [ ] Every top-level directory has a one-sentence responsibility (readable by an agent in 10s).
- [ ] The runtime separation is visible in the folder structure (`crates/` vs `packages/` vs `shared/`).
- [ ] No side touches the other's state by shortcut (frontend doesn't touch SQLite; backend doesn't render JSX).
- [ ] The proxy/preview makes clear who hosts whom.
- [ ] Boundary decisions are recorded in ADR, not just in memory or a commit message.
- [ ] What was removed has a record of why **and** what to preserve (frozen contracts).
- [ ] A new agent, reading `AGENTS.md` + `Cargo.toml` + `packages/`, knows where to create each file without asking.

---

# Chapter 12 — The type contract: ts-rs in practice

> **Principle:** if two languages must agree on a shape, generate the shape from a single source. Convention drifts; a generated contract doesn't.

## The problem

In a Node + Rust project both sides keep agreeing on the same thing: what is a `Project`, `Workspace`, `Issue`, `ExecutionProcess`. If each side declares the type by hand, one changed field breaks the other at runtime — and an AI agent, which reads one side and writes the other, is the first to introduce the drift. Treat the boundary as a contract: one side is source of truth, the other is generated.

## How it works here

### Source: Rust structs with `ts-rs`

In `crates/db/src/models/` and `crates/api-types/`, every cross-boundary type is annotated `#[derive(TS)]`. The generator `crates/server/src/bin/generate_types.rs` collects `TS::decl()` of dozens of types and writes `shared/types.ts`.

The generated file opens with the warning every agent must respect:

```ts
// This file was generated by `crates/server/src/bin/generate_types.rs`.
// Do not edit this file manually.
// If you are an AI, and you absolutely have to edit this file, please confirm with the user first.
```

Note: the banner text still says `crates/core/...` (a stale path) — the real binary is at `crates/server/src/bin/generate_types.rs`. The **source of truth** is the server binary.

### Canonical commands

```bash
pnpm run generate-types          # regenerates shared/types.ts
pnpm run generate-types:check    # CI only — fails if stale
```

Add a field to a Rust struct, run `generate-types`, and TypeScript learns it with no redeclaration. `cargo check` and `tsc` break **together** on divergence — error early, in compilation, not in production.

> Exercise: open `shared/types.ts`, find `export interface Workspace`; compare with `crates/db/src/models/workspace.rs`. Identical — one generated the other. Change a field in Rust, run `pnpm run generate-types:check` without regenerating, and CI complains.

## The conscious exception: a frozen contract

When this fork removed `remote` and `relay-*` crates, the generator of `shared/remote-types.ts` went with them. But the file **remained** — it is the contract of the local kanban data layer (`providers/remote/*`, `integrations/electric/*`) consumed by the frontend in fallback-REST mode. `AGENTS.md` calls it: "a frozen, hand-maintained contract since its generator has been removed."

Lesson: generated contract is the default; a frozen contract is the documented exception, with a reason. Without the record, someone would delete the file thinking it's junk.

## Agent tool schemas

The same spirit appears in `shared/schemas/`: the schemas of the tools agents use are shared between Rust and TypeScript. Changing a tool's shape without updating the schema breaks both sides — so the schema lives in the middle, versioned.

## What this teaches about spec-driven

"Spec-Driven Architecture" (ch. 11) isn't only writing a doc before coding. It's choosing where the spec lives. Here the boundary spec lives in Rust structs with `#[derive(TS)]` — the code **is** the spec, and the generator guarantees no one disobeys silently. The pipeline spec lives in `assets/pipelines/*.toml`; the progress spec lives in the `VK-PIPELINE-STAGE` / `VK-REVIEW-REQUEST` markers (ch. 13/14). In each case: one source, one generation, zero divergence by forgetfulness.

## Chapter checklist

- [ ] Every cross-boundary type has a single source (Rust with `#[derive(TS)]`).
- [ ] One command regenerates the TypeScript side (`generate-types`); CI verifies.
- [ ] The generated file has a "Do not edit manually" banner and `AGENTS.md` points to the real source.
- [ ] Exceptions (frozen contracts) are documented with the reason they exist.
- [ ] Agent tool schemas are shared, not duplicated per side.

---

# Chapter 13 — The Engineering Loop: CLI and self-correction

> **Principle:** an agent only self-corrects if it can run, fail, read the error and repeat — without asking permission each step. Your job is to make that loop short, legible and surprise-free.

## The loop in one sentence

```
write → run tests/checks → read the error in the log → fix → repeat
```

When the loop is fast, the agent solves 90% alone. When it's slow or illegible, it stops and asks — exactly what the approval system and review alarm try to avoid (ch. 06). This chapter is about making the loop so good that escalation becomes the exception.

> In the AssinaFácil SaaS (ch. 08): each card ends with `pnpm run check` green + Preview validated. If `check` explains the error, the agent fixes alone; if it only says "failed", you intervene. The difference is entirely this chapter.

## The canonical commands (real case)

In `package.json`, the scripts are the spec of the loop. Any agent that reads `AGENTS.md` learns the same sequence:

```bash
pnpm i                                    # install
pnpm run dev                              # web (3001) + backend (3002) with fixed ports
pnpm run check                            # tsc ×3 + cargo check + guards
pnpm run lint                             # ESLint + cargo clippy -- -D warnings (qa-mode)
pnpm run format                           # cargo fmt + Prettier — mandatory before completing
cargo test --workspace                    # Rust tests
pnpm run generate-types                   # regenerates shared/types.ts (ch. 12)
pnpm run prepare-db                       # SQLx offline
```

`pnpm run check` is the guardian: `local-web:legacy-path-guard`, `check:db` (frozen migrations), `local-web:check`, `web-core:check`, `ui:check`, `backend:check`. Each guard has a message teaching the fix — not just "failed".

Rule from `AGENTS.md`: before completing any task, `pnpm run format`. Not politeness — it guarantees `cargo fmt --all` and Prettier won't produce phantom diffs on the next commit.

## Three patterns that make the loop teach

### 1. Guards with actionable messages

`check-migration-frozen.sh` blocks editing a published migration and says why; `check-legacy-frontend-paths.sh` blocks old imports and points to the new path. The agent reading the error knows exactly what to fix.

### 2. Warnings as errors

`backend:lint` runs `cargo clippy --workspace --all-targets --features qa-mode -- -D warnings`. In `qa-mode` nothing passes as a warning — every Clippy complaint breaks CI. The agent leaves no "fix later" debt.

### 3. Logs filterable by crate

In `crates/server/src/main.rs:33`, `EnvFilter` is built per crate from `RUST_LOG`. With `DISABLE_WORKTREE_CLEANUP=1 RUST_LOG=debug cargo watch -w crates -x 'run --bin server'`, the agent reads a filtered log and knows if the error came from db, executor or routing.

## The logs as machine interface (bridge to ch. 14)

The detail that matters most for automation: the same logs a human reads are the interface the pipeline trackers read. In `crates/services/src/services/pipeline_stage.rs` and `review_request.rs`, a `Regex` scans the `MsgStore` (unified stdout of headless and headed runs) for textual markers:

- `VK-PIPELINE-STAGE: N` — which pipeline stage the card is at (`parse_pipeline_stage_marker`, with `has_valid_boundary` for escaped `\n`).
- `VK-REVIEW-REQUEST: <msg>` — the agent asks for human review and fires the sound alarm via `NotificationService`.

The agent doesn't call an API to say "I changed stage"; it **writes a line in the log**. The backend observes the log. This keeps all executors (Claude, OpenCode, Codex…) identical to the orchestrator — none needs special integration. The log is the protocol.

## Fixed dev ports and the predictable error

Frontend `3001`, backend `3002`, preview proxy `3003` — fixed, documented, exported by `pnpm run dev`. When an agent tries to start the dev server inside a workspace and the port is already held by another instance, the error is `AddrInUse` in `crates/server/src/main.rs` — predictable, searchable, fixable by checking `lsof -nP -i :3002 -sTCP:LISTEN` and the `cwd` of the process holding it (ch. 02 §5).

## Chapter checklist

- [ ] Each loop command is in `package.json` with a canonical name (`check`, `lint`, `format`, `dev`).
- [ ] `check` includes guards that explain the error and point at the fix.
- [ ] Lint treats warnings as errors (at least in CI/qa-mode).
- [ ] `format` is mandatory before completing — and documented.
- [ ] Logs are filterable per crate via env variable.
- [ ] Progress/review messages are log lines with stable regex — not per-executor API calls.
- [ ] Dev ports are fixed and the `AddrInUse` error has documented diagnosis.

---

# Chapter 14 — Agent orchestration: MCP, pipelines and the alarm

> **Principle:** when the agent itself drives the workflow (create cards, report progress, ask review), the tool stops being passive and joins the loop. Three pieces: an MCP server, TOML pipelines, text markers.

## The executors: a dozen agents, one interface

`crates/executors/src/executors/` has one module per agent — `claude`, `codex`, `gemini`, `opencode`, `cursor`, `amp`, `copilot`, `droid`, `qwen`, `antigravity`, `acp` — plus `qa_mock.rs`, a **fake executor** for tests without tokens. Around them: `approvals.rs` (tool-permission flow), `command.rs`/`env.rs` (process setup), `stdout_dup.rs` (log + UI), `mcp_config.rs` (inject the MCP server).

## The MCP server: the board spoken by agents

The `vibe-kanban-mcp` binary (`crates/mcp/`) exposes the board as MCP tools — the protocol Claude Code, OpenCode etc. already speak. One file per domain in `crates/mcp/src/task_server/tools/`: `issues.rs` (cards), `workspaces.rs`/`sessions.rs` (`run_session_prompt`), `pipeline.rs`/`rules.rs` (`get_pipeline`, `report_pipeline_stage`, `get_rules`), `approvals.rs` (`respond_to_approval`), `mem0.rs` (memory). The card you're reading was run by an agent that called `get_pipeline`, reported `VK-PIPELINE-STAGE` and committed — all via these tools. The management tool and the executor are the same system.

## Pipelines in TOML: process as versioned config

The workflow lives in `assets/pipelines/*.toml` (`quick`, `basic`, `speckit`, `swarm-multi-agent`, `wikillm`, `async-*`). A stage from `quick.toml`:

```toml
[[stage]]
id = "review-manual"
label = "Manual review (alarm)"
default_enabled = false
prompt = "MANUAL REVIEW: stop here and hand the work to the operator..."
```

Each stage is a prompt fragment with `id`, `label`, `default_enabled`. The card loads only a pointer; the content comes from `get_pipeline` when the agent runs — so it enters the agent's window only then, not on every board listing.

## Text markers: the invisible orchestration

Two markers sustain the human↔agent loop, parsed from the `MsgStore`:

- **`VK-PIPELINE-STAGE: N`** → `pipeline_stage.rs`: regex `(?i)VK-PIPELINE-STAGE:\s*(\d+)` with `has_valid_boundary` guard. The last valid marker wins; it persists in `workspaces.current_pipeline_stage` — the card's checklist updates live.
- **`VK-REVIEW-REQUEST: <msg>`** → `review_request.rs`: triggers `NotificationService.notify(...)` — the sound alarm. Idempotent per execution; best-effort (notification failure never blocks work).

The channel is **text in the log with formal grammar**, parsed the same in headless (child stdout) and headed (transcript tail). No executor needs to know the marker — only the service reading the stream does. The log is the protocol.

## Supervision: TUI, Telegram and the orchestrator watchdog

| Piece | Command | Does |
| --- | --- | --- |
| **TUI** | `cargo run -p tui` | Terminal cockpit — workspaces/sessions, live transcripts, approvals inbox (`a`) |
| **Telegram bridge** | `cargo run -p telegram-bridge` | Send-only daemon — approvals to Telegram per worktree (`~/.vibe-kanban/telegram.toml`) |
| **OrchestratorCompactor** | `crates/services/src/services/orchestrator_compactor.rs` | Watchdog: every 60s, if transcript > 400k tokens (or 1h with ≥50k), types `/compact` via tmux keys; 10min cooldown; 3 failures → Telegram |

The TUI and Telegram give a human (or another agent) supervision without watching; the Compactor is the context garbage-collector for long runs.

## Chapter checklist

- [ ] Agents have a tool API for the system that manages them (MCP), and a fake executor for tests.
- [ ] The workflow (pipeline) is versioned config, not scattered code.
- [ ] Progress and human requests are text markers with grammar, parser and tests.
- [ ] The log is the protocol — same in headless and headed.
- [ ] Supervision has a human path (TUI/UI) and a remote path (Telegram), with escalation.

---

# Chapter 15 — Image anchoring

> **Principle:** a well-chosen screenshot is an assertion. It tells a human "looks right" and an AI "compare current state with this" — and in KDP, it *is* the product.

## Why anchored images — text describes, image proves

In a rich-UI app most regressions are visual — a button that vanished, a kanban column that broke, a dialog that won't open. An agent that only reads text may think everything is fine when the screen is empty. Anchored images close that gap: they are the **snapshot test a human grasps in a glance** and an AI can compare pixel-wise.

## How the docs already do it — the Mintlify pattern

Mintlify files in `docs/` wrap every image in `<Frame>` with descriptive `alt`:

```mdx
<Frame>
  <img src="/images/workspaces-preview-no-script.png"
       alt="Preview panel showing prompt to set up a dev server script" />
</Frame>
```

The fullest case is `docs/browser-testing.mdx`: a 3-step walkthrough illustrated by four screenshots — no-script prompt, script dialog, Start button, log panel, browser annotated with 7 numbered controls. Text and image anchor each other; each number in the image is explained in the list. `docs/mobile-testing.md` does the same for device testing.

Rules that emerge:

- Every image has `alt` describing **what should be seen**.
- UI images have a name identifying state (`preview-no-script` vs `preview-dev-server-running`).
- Path is `/images/...` — relative to the docs site, versioned. In the book, `docs/images/livro/`.
- Consistent resolution (1440x900 in the book) for stable comparison.

## What is already anchored — 12 images

The book has 12 versioned anchors in `docs/images/livro/`:

| Group | Files | Ch. |
| --- | --- | --- |
| **Real app** | `ancora-board-principal.png` (989 KB) | 04 |
|  | `ancora-workspace-aberta.png` (775 KB) | 04 |
|  | `ancora-settings.png` (254 KB) | 03 |
|  | `ancora-criar-card-*.png` (3 files) | 05 |
|  | `ancora-workspace-chat-bar.png` (353 KB) | 05 |
| **AssinaFacil previews** | `saas-landing.png` (53 KB) | 08 |
|  | `saas-planos.png` (44 KB) | 08 |
|  | `saas-checkout.png` (41 KB) | 08 |
|  | `saas-minhas-assinaturas.png` (37 KB) | 08 |
|  | `saas-landing-mobile.png` (23 KB) | 08 |

The first 7 are real screenshots; the 5 AssinaFacil ones are PIL-generated previews (commit `5371b672`, reproducible) — placeholders until the ch. 08 cards reach Done and are replaced by real Preview screenshots.

## The full anchoring plan — what remains

- **Board:** `livro/board-empty.png` (empty board + create button).
- **Workspace:** `livro/workspace-diff.png` (Changes), `livro/workspace-terminal.png` (xterm), `livro/workspace-preview.png` (browser toolbar 1-7).
- **Approvals:** `livro/approvals-inbox.png` (TUI + 1 tool permission), `livro/review-request.png` (VK-REVIEW-REQUEST banner).

Capture at 1440x900 with the same seed data (same project/branch) for stable comparison. For KDP print, export at 300 DPI (ch. 09).

## How to capture — 3 paths

### 1. Real Preview screenshot (most faithful)

Run `pnpm run dev`, open the AssinaFacil workspace, **Preview** tab. On macOS: Cmd+Shift+4 → drag → move to `docs/images/livro/saas-landing.png`.

### 2. Via workspace chat (becomes Attachment, visible to agent)

Drag the image into the workspace chat — the app POSTs to `POST /api/attachments/upload` (`crates/server/src/routes/attachments.rs:83`, 20 MB). The agent receives it as visual context (ch. 05).

### 3. PIL generation (fastest — for previews before code exists)

```python
from PIL import Image
im = Image.new("RGB", (1440, 900), "#f8fafc")
# ... draw hero, cards, table (see commit 5371b672)
im.save("docs/images/livro/saas-landing.png")
```

No browser, reproducible, ideal for writing the chapter before coding.

## How the AI uses the anchor

1. **Post-change visual validation.** After touching `packages/web-core/src/`, the agent boots the dev server, screenshots the route and diffs against the anchor. Unexpected delta → fix before committing.
2. **Spec by image.** The card attaches the desired anchor (e.g., plan dialog mock). The agent has, besides the text spec, the visual target — and knows it's done when the screen matches.

## Chapter checklist

- [ ] Every new visual feature has an anchor in `docs/images/livro/` with a predictable name.
- [ ] Every image has descriptive `alt` and, in Mintlify docs, is inside `<Frame>`.
- [ ] The plan covers: board, workspace (5 tabs), approvals, dialogs — versioned.
- [ ] Screenshots at consistent resolution/seed for stable comparison.
- [ ] PIL previews replaced by real screenshots when the card reaches Done (ch. 08).
- [ ] For KDP print, images exported at 300 DPI, CMYK, 0.125 inch bleed (ch. 09).

---

# 17 — Agents: installation, authentication, and models

**Goal:** have at least one coding agent installed, authenticated, and
selectable inside AuraPunk IDE before the first real workspace. Without it,
the workspace opens but no executor takes the task.

> Golden rule of this chapter: the agent lives **outside** AuraPunk IDE (it
> is a CLI installed on your machine). The IDE only detects and drives it. If
> the agent is missing from the workspace dropdown, the problem is the
> installation or the `PATH`, never the board.

## 17.1 The agent lifecycle in the IDE

1. **Install** the agent CLI (§17.2).
2. **Authenticate** (interactive login or an API-key environment variable).
3. Open AuraPunk IDE (`npx aurapunk-ide`) and create a workspace.
4. Pick the agent in the chat dropdown. The IDE remembers your last choice.

## 17.2 Installation and authentication table

| Agent | Install | Authenticate |
| --- | --- | --- |
| Claude Code | `npx -y @anthropic-ai/claude-code` | Guided interactive login |
| OpenAI Codex | `npx -y @openai/codex` | ChatGPT plan **or** `OPENAI_API_KEY` |
| GitHub Copilot | `npx -y @github/copilot` | `/login` command in the CLI |
| Gemini CLI | `npx -y @google/gemini-cli` | Guided interactive login |
| Amp | `npx -y @sourcegraph/amp` | Guided login (see the Amp manual) |
| Cursor Agent | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` or `CURSOR_API_KEY` |
| OpenCode | `npx -y opencode-ai` | Guided interactive login |
| Factory Droid | `curl -fsSL https://app.factory.ai/cli \| sh` | `/login` in the CLI or `FACTORY_API_KEY=fk-...` |
| Qwen Code | `npx -y @qwen-code/qwen-code` | Guided interactive login |
| CCR (router) | `npx -y @musistudio/claude-code-router ui` | Configure providers in the CCR UI |

Details that avoid the most common traps:

- **Codex with a custom directory:** if you use `CODEX_HOME` to separate
  profiles (personal vs work), the IDE detects and respects it automatically.
  ```bash
  export CODEX_HOME=/path/to/project/codex
  npx aurapunk-ide
  ```
- **Cursor:** verify with `cursor-agent --version` before opening the IDE.
- **Droid on Windows:** `irm https://app.factory.ai/cli/windows | iex`; the
  fallback key comes from `app.factory.ai/settings/api-keys`.
- **CCR is not affiliated with Anthropic:** it is a third-party router that
  spreads prompts across providers and models (long context, background
  work, images). Useful for parallelizing workspaces without queues.

## 17.3 Agent profiles: planning, permissions, and models

Under **Settings → Agents** you create reusable per-agent variants (model,
planning mode, permissions, sandbox, environment variables). The default
configuration comes pre-selected in the chat dropdown. Recipes:

| Case | Configuration |
| --- | --- |
| Fast iteration | Planning mode off, lighter model |
| Complex task | Planning mode on, stronger model |
| Autonomous work | Skip permission prompts (with caution) |
| Code review | Approvals on for every change |
| Parallelism | CCR spreading instances |

Concepts worth one minute of reading:

- **Planning mode:** the agent drafts the plan before coding; you approve the
  strategy. Great for complex tasks, overhead for simple ones.
- **Permission prompts:** the agent asks before destructive actions (deleting
  files, shell, system configs). Skipping them
  (`dangerously_skip_permissions`) removes the guardrails — use with caution.
- **Sandbox (Codex):** `read-only` (reads only), `workspace-write` (project
  only), `danger-full-access` (no restrictions).
- **Approval levels:** when the agent pauses for your confirmation.

## 17.4 Verification and common issues

1. Run the CLI in a terminal (`claude --version`, `codex --version`, …).
2. If the command is missing, reinstall and **restart the terminal** (a stale
   `PATH` causes 9 out of 10 cases).
3. Open the IDE and check the workspace dropdown.
4. Test with a trivial prompt before the real task.

If an agent disappears from the dropdown after working: check that the key
environment variable (`OPENAI_API_KEY`, `CURSOR_API_KEY`,
`FACTORY_API_KEY`, …) is still exported in the session that launched the IDE.

---

# 18 — Settings: tab reference

**Goal:** know where every toggle lives without hunting menus. The
**Settings** dialog has General, Projects & Repos, Agents, and MCP tabs
(plus account sections where applicable).

## 18.1 General

- **Theme** (light/dark/system).
- **Default agent and variant:** pre-selected in every new workspace and in
  follow-ups.
- **Editor:** which editor opens files.
- **Workspace dir:** root where worktrees are born (default:
  `~/.vibe-kanban/worktrees`).
- **Git prefix / notifications / sound:** small day-to-day behaviors.

## 18.2 Projects & Repos

Per project: display name, path, **dev**, **setup**, and **cleanup** scripts,
with examples and best practices:

- `dev`: how to serve the project for Preview (e.g. `pnpm dev --port 3000`).
- `setup`: prepares a freshly created worktree (e.g. `pnpm install`).
- `cleanup`: runs on archive/delete (e.g. stopping temporary containers).

Without a dev script configured, Preview has nothing to show — the number
one cause of an empty Preview panel (see ch. 19).

## 18.3 Agents

Shortcut to chapter 17: create, clone, and set as default the per-agent
variants (model, planning, permissions, sandbox, env vars).

## 18.4 Tags (@-snippets)

Create reusable `snake_case` snippets (e.g. `review_tests`) and insert them
with `@` in the workspace prompt. Tags are global across all projects — use
them for instructions you always repeat (test conventions, commit format,
review checklist).

## 18.5 MCP servers

MCP servers give agents extra tools, configured **per agent** via JSON in
Settings (with 1-click shortcuts for the popular ones). If the agent ignores
a tool, check: valid JSON, reachable server, and the right agent selected in
the workspace.

---

# 19 — Troubleshooting: error index

**Goal:** get unstuck in minutes instead of reinstalling everything. Find
the symptom, apply the fix in order.

## 19.1 Git and merge

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| PR behind target, merge blocked | Stale branch | Rebase before merge/push |
| Conflict on rebase/merge | Concurrent edits | Resolve in the Changes panel (side-by-side diff), mark resolved, continue |
| "Dirty" worktree, commands refused | Uncommitted changes | Commit/stash in the worktree before switching branches |
| Branch missing for worktree | Branch only local/aborted | Check `git branch -a`; create from the remote |

Rule of thumb: rebase **before** opening a PR, when the target moved, and
whenever the IDE asks for being behind target.

## 19.2 Preview and checks

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Empty Preview | No dev script on the project | Set `dev` in Projects & Repos (ch. 18) |
| Failing checks | Repo lint/tests | Run `pnpm check` locally, fix, resend |
| Port in use (`AddrInUse`) | Old process alive | Find it with `lsof -i :PORT` and stop it |

## 19.3 Local database and logs

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Strange/blocking state | Corrupt local DB | **Last resort:** delete the app SQLite and reopen (see below) |
| Unexplained behavior | Missing evidence | `RUST_LOG=debug npx aurapunk-ide` and read the log |
| Empty codebase in workspace | Aggressive sparse-checkout | Disable the repo's sparse checkout |

> **Deleting the local database** removes that machine's projects, issues,
> and history (synced content can come back via sync). Locate `db.v2.sqlite`
> in the app data dir (`~/.local/share/vibe-kanban/` on Linux) and remove it
> with the IDE **closed**. Never do this with uncommitted work in worktrees.

## 19.4 When asking for help

Always note: version (`npx aurapunk-ide --version`), OS, agent and model,
the literal error, and the last 30 log lines with `RUST_LOG=debug`. Half the
cases solve themselves on reading.

---

# Appendix — Command reference

Canonical commands for this repository (`package.json` root, `AGENTS.md`). Copy-paste; if one fails, the error teaches the fix (ch. 05).

## Setup

```bash
pnpm i
cp .env.example .env  # if it exists; never commit .env
```

## Development

```bash
pnpm run dev
# Frontend :3001 + Backend :3002 + Preview proxy :3003
# Ports are fixed and exported as FRONTEND_PORT/BACKEND_PORT/PREVIEW_PROXY_PORT

pnpm run backend:dev:watch
# Backend only, with cargo watch (RUST_LOG=debug by default)

pnpm run local-web:dev
# Frontend only (Vite)
```

## Verification (the loop)

```bash
pnpm run check
# local-web:legacy-path-guard + check:db + tsc (local-web, web-core, ui) + cargo check

pnpm run lint
# ESLint (local-web, ui) + cargo clippy -- -D warnings (with --features qa-mode)

pnpm run format
# cargo fmt --all + Prettier (web-core, local-web)
# AGENTS.md mandates it before completing any task.

cargo test --workspace
# Rust tests of all crates
```

## Types and database

```bash
pnpm run generate-types
# Regenerates shared/types.ts from Rust structs (ts-rs)

pnpm run generate-types:check
# Verify only that shared/types.ts is up to date (CI)

pnpm run prepare-db
# Generate .sqlx offline for builds without a database
```

## Automation (ch. 06)

```bash
cargo run -p tui                    # terminal cockpit
cargo run -p telegram-bridge        # Telegram daemon (reads ~/.vibe-kanban/telegram.toml)
cargo run -p mcp -- --mode global   # global MCP server (for the PM agent)
```

## Pipelines and memory (MCP tools)

The MCP tools relevant to a card's flow: `get_rules`, `get_pipeline`, `report_pipeline_stage`, `get_issue`, `update_issue`, `memory_search`, `memory_save`, `respond_to_approval`, `get_orchestrator_prompt`.

Pipelines TOML live in `assets/pipelines/`; `quick.toml` is the trivial-card one.

## Publishing the book

The KDP checklist lives in `docs/livro-vibe-kanban-amazon-checklist.md`. KDP rules: revalidate at `kdp.amazon.com` before publishing — prices and category limits change.

---

# Acknowledgments

This book documents **Aurapunk IDE** — a self-hosted kanban for a solo developer to drive AI coding agents. It does not start from scratch: it stands on two prior projects, and this section credits them clearly.

## The software lineage

```
Vibe Kanban (BloopAI)
   └─ Vibe Kanban Indie (dexloom)        ← base fork of this repo
        └─ Aurapunk IDE       ← the project documented here
```

- **Vibe Kanban — BloopAI** ([github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)): the **original** project. The core idea — a kanban board where each card spins up an isolated agent workspace — and much of the agent-execution model and UI/UX originated here.
- **Vibe Kanban Indie — dexloom** ([github.com/dexloom/vibe-kanban-indie](https://github.com/dexloom/vibe-kanban-indie)): the **independent fork** this repository is based on. It reshaped the original for a solo-dev, self-hosted, no-cloud, no-auth workflow — the `vk/xxxx` branch model, the local cockpit (TUI), the agent orchestration — the exact substrate this book describes.
- **Aurapunk IDE** (this repo): the present fork. It adds the interface manual, the AssinaFacil SaaS walkthrough and the publishing pipeline, keeping the solo-dev, self-hosted spirit.

## Further credits

- The agent-ecosystem tooling that makes vibe coding practical: Claude Code, OpenCode, Codex, Gemini, Cursor, Copilot and the MCP protocol.
- The KDP / technical-author community that keeps documenting tools in Portuguese alive.
- You, reader, for learning to *drive* agents instead of just prompting them.

---

