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
