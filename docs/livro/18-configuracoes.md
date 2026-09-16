# 18 — Configurações: referência das abas

**Objetivo:** saber onde fica cada ajuste sem caçar menus. O diálogo
**Settings** tem as abas General, Projects & Repos, Agents e MCP (além das
seções de conta quando aplicável).

## 18.1 General

- **Tema** (claro/escuro/sistema).
- **Agente e variante padrão:** o que já vem selecionado em todo workspace
  novo e nos follow-ups.
- **Editor:** qual editor abre os arquivos.
- **Workspace dir:** raiz onde os worktrees nascem (padrão: `~/.vibe-kanban/worktrees`).
- **Prefixo git / notificações / som:** pequenos comportamentos do dia a dia.

## 18.2 Projects & Repos

Por projeto: nome de exibição, caminho, scripts de **dev**, **setup** e
**cleanup**, com exemplos e boas práticas:

- `dev`: como servir o projeto para o Preview (ex.: `pnpm dev --port 3000`).
- `setup`: prepara o worktree recém-criado (ex.: `pnpm install`).
- `cleanup`: roda ao arquivar/remover (ex.: derrubar containers temporários).

Sem script de dev configurado, o Preview não tem o que exibir — é a causa
número um do painel de Preview vazio (ver cap. 19).

## 18.3 Agents

Atalho para o conteúdo do cap. 17: criar, clonar e definir como padrão as
variantes por agente (modelo, planning, permissões, sandbox, env vars).

## 18.4 Tags (@-snippets)

Crie trechos reutilizáveis em `snake_case` (ex.: `revisar_testes`) e insira
com `@` no prompt do workspace. Tags valem globalmente, em todos os
projetos — use para instruções que você repete sempre (padrão de testes,
formato de commit, checklist de review).

## 18.5 MCP servers

Servidores MCP dão ferramentas extras aos agentes, configurados **por
agente** via JSON nas Settings (há atalhos de 1 clique para os populares).
Se o agente ignora a ferramenta, confira: JSON válido, servidor alcançável e
o agente certo selecionado no workspace.
