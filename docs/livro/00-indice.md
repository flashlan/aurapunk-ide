# Manual Moderno de Vibe Coding — Índice

**Subtítulo:** *Manual prático da interface do Aurapunk IDE — do `npx` ao SaaS em produção, com um projeto-guia.*

Este livro foi escrito dentro do próprio repositório que ele ensina a usar. Todo caminho de arquivo citado existe no código; quando uma regra externa muda (ex.: preços do KDP), o capítulo marca a data de verificação.

## Como usar este livro

- **Parte I (caps. 1–9):** manual de uso — primeiro o vocabulário do vibe coding (cap. 2), depois instale, navegue, mexa com cards, pipelines e git, e feche com o projeto prático **Criando um SaaS com Vibe Kanban** e a publicação na Amazon.
- **Parte II (caps. 10–15):** bastidores para quem quer customizar — arquitetura, tipos gerados, loop de engenharia, orquestração e ancoragem de imagens.
- **Apêndice:** referência rápida de comandos.
- O checklist de publicação na Amazon vive em `../livro-vibe-kanban-amazon-checklist.md`.

## Parte I — Manual de Uso + Projeto Prático

| # | Capítulo | Arquivo | Estado |
| --- | --- | --- | --- |
| 1 | Introdução: o que este manual resolve | `01-introducao.md` | Escrito |
| 2 | Noções de vibe coding: Engineering Loop, Spec Development, multi-agente e jargões | `02-nocoes-vibe-coding.md` | Escrito |
| 3 | Instalação e configuração | `03-instalacao-configuracao.md` | Escrito |
| 4 | Tour da interface | `04-tour-interface.md` | Escrito |
| 5 | Cards e Kanban — ciclo de vida na prática | `05-cards-kanban.md` | Escrito |
| 6 | Pipelines na prática | `06-pipelines.md` | Escrito |
| 7 | Git, workspaces e worktrees | `07-git-workspaces.md` | Escrito |
| 8 | Projeto prático: Criando um SaaS com Vibe Kanban | `08-projeto-saas.md` | Escrito |
| 9 | Da escrita à Amazon KDP | `09-publicacao-kdp.md` | Escrito |
| 17 | Agentes: instalação, autenticação e modelos | `17-agentes.md` | Escrito |
| 18 | Configurações: referência das abas | `18-configuracoes.md` | Escrito |
| 19 | Resolução de problemas: índice de erros | `19-resolucao-problemas.md` | Escrito |

## Parte II — Bastidores (para quem customiza o app)

| # | Capítulo | Arquivo | Estado |
| --- | --- | --- | --- |
| 10 | The Vibe Coding Setup (arquivos de contexto) | `10-vibe-coding-setup.md` | Escrito |
| 11 | Arquitetura spec-driven: fronteiras Node × Rust | `11-arquitetura-spec-driven.md` | Escrito |
| 12 | O contrato de tipos: ts-rs na prática | `12-contrato-de-tipos.md` | Escrito |
| 13 | The Engineering Loop: CLI e autocorreção | `13-engineering-loop.md` | Escrito |
| 14 | Orquestração de agentes: MCP, pipelines e o alarme | `14-orquestracao.md` | Escrito |
| 15 | Ancoragem de imagens | `15-ancoragem-imagens.md` | Escrito |
| A | Apêndice: referência de comandos | `apendice-comandos.md` | Escrito |

## Anexos

| # | Seção | Arquivo | Estado |
| --- | --- | --- | --- |
| — | Agradecimentos (linhagem: BloopAI → dexloom → Alternative) | `16-agradecimentos.md` | Escrito |

## Screenshots-âncora (caps. 3–8)

| Imagem | Arquivo | Usada em |
| --- | --- | --- |
| Board principal (Próximos passos / Em andamento / Em revisão / Concluído) | `ancora-board-principal.png` | cap. 4 |
| Workspace aberta (3 painéis) | `ancora-workspace-aberta.png` | cap. 4 |
| Settings | `ancora-settings.png` | cap. 3 |
| Criar card — topo (Title, Status, Priority, Tags) | `ancora-criar-card-topo.png` | cap. 5 §1 |
| Criar card — base (Description + Save) | `ancora-criar-card-base.png` | cap. 5 §1 |
| Criar card — seção Workspaces / Create | `ancora-criar-card-workspace.png` | cap. 5 §2 |
| Barra da workspace (Tasks, modelo, presets, permissões, anexos) | `ancora-workspace-chat-bar.png` | cap. 5 §4 |
| AssinaFácil — Landing (hero + MRR + features) | `saas-landing.png` | cap. 8 |
| AssinaFácil — Planos (3 colunas, Pro em destaque) | `saas-planos.png` | cap. 8 |
| AssinaFácil — Checkout (formulário + resumo) | `saas-checkout.png` | cap. 8 |
| AssinaFácil — Minhas assinaturas (tabela logada) | `saas-minhas-assinaturas.png` | cap. 8 |
| AssinaFácil — Landing mobile (390×780) | `saas-landing-mobile.png` | cap. 8 |

> As 7 primeiras são screenshots reais do app; as 5 do AssinaFácil são **prévias geradas em PIL** (cap. 15) — substituir por screenshots reais do Preview quando os cards do cap. 8 forem para Done.

## Convenções

- Caminhos como `crates/server/src/routes/kanban.rs` são reais no repositório desta branch (`vk/1f98-livre-vibo-kanba`).
- Screenshots sugeridas usam `docs/images/livro/` e estão descritas no cap. 15.
