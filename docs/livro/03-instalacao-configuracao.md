# Capítulo 3 — Instalação e configuração

> **Objetivo:** sair do zero para um board com seu primeiro projeto — `AssinaFácil` — sem conta na nuvem, com `projects.toml` versionável.

## Links oficiais

- **Site:** [aurapunk.dev](https://aurapunk.dev)
- **Repositório no GitHub:** [github.com/flashlan/aurapunk-ide](https://github.com/flashlan/aurapunk-ide)

## 1. Requisitos

| Requisito | Versão | Onde está declarado |
| --- | --- | --- |
| Node | ≥ 20 | `package.json` → `engines` |
| pnpm | ≥ 8 (recomendado 10.13.1) | `package.json` → `packageManager` |
| Rust / Cargo | edição 2024 | `Cargo.toml` → `[workspace.package] edition` |
| Git | recente (≥ 2.30 para worktrees) | — |

No macOS/Linux:

```bash
# Node + pnpm
curl -fsSL https://get.pnpm.io/install.sh | sh
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

No Windows, use `winget` para Node/pnpm e `rustup-init.exe` para Rust.

## 2. Duas formas de rodar

A Aurapunk IDE é **100% local** — sem login, sem cloud. Escolha uma:

### Opção A — npx (para usar, sem clonar)

```bash
npx aurapunk-ide
# → Frontend :3001  Backend :3002  Preview proxy :3003
```

Ideal para quem só quer usar a interface. O binário baixa, cria `db.v2.sqlite` em `asset_dir()` (`crates/server/src/main.rs:44` — na primeira execução copia `db.sqlite` → `db.v2.sqlite` se precisar) e abre em `http://localhost:3001`.

### Opção B — clone (para desenvolver/customizar a Aurapunk IDE)

```bash
git clone https://github.com/flashlan/aurapunk-ide.git
cd aurapunk-ide
pnpm i
pnpm run dev
# Mesmo :3001/:3002/:3003, mas com hot-reload (Vite + cargo watch)
```

As três portas são **fixas** (`AGENTS.md`, `package.json` scripts exportam `FRONTEND_PORT`/`BACKEND_PORT`/`PREVIEW_PROXY_PORT`). Se uma já estiver ocupada:

```bash
lsof -nP -i :3002 -sTCP:LISTEN
# confira o cwd do PID — pode ser outra instância da Aurapunk IDE em outro diretório
# (ver cap. 02, §3 — Engineering Loop e conflito de portas)
```

## 3. Primeiras preferências

Na primeira vez o app pede (`docs/getting-started.mdx:19`):

- agente de coding preferido (Claude Code, OpenCode, Codex, Gemini, Cursor…),
- IDE (VS Code, Cursor, etc.),
- notificações — ative o **som do alarme** de `VK-REVIEW-REQUEST` (`crates/services/src/services/review_request.rs`).

O onboarding mostra screenshots em `/images/onboarding-*.png`. Altere depois em **Settings** (engrenagem no topo direito):

![Settings — onde ficam agente preferido, IDE, notificações e projetos/repositórios](/images/livro/ancora-settings.png)

*Settings do livro: preferências de agente/IDE, som do alarme `VK-REVIEW-REQUEST` e a lista de projetos/repositórios com seus scripts (`setup_script`, `dev_server_script`). Em `~/.vibe-kanban/` ficam configs como `telegram.toml` (`automation/telegram.toml.example`) e `orchestrator.toml` — mas para este capítulo, só o básico importa.*

## 4. Declarar seu primeiro projeto: `projects.toml`

A Aurapunk IDE não tem "criar conta" — ela lê um arquivo **`projects.toml`** portável (`docs/cockpit/local-projects.mdx`). O SQLite é a fonte da verdade; o TOML é o export/import que você pode versionar e compartilhar.

### Formato mínimo (para o SaaS do livro)

Crie `~/.vibe-kanban/projects.toml` (ou onde `VIBE_KANBAN_PROJECTS_CONFIG` apontar):

```toml
# --- Repos ---
[[repo]]
path = "~/code/assina-facil"
display_name = "AssinaFácil"
default_target_branch = "main"
setup_script = "pnpm install"
dev_server_script = "pnpm --filter app-web dev"
# copy_files = [".env"]  # copie .env para cada worktree, se precisar

# --- Projeto ---
[[project]]
name = "AssinaFácil"
key = "AF"                       # cards viram AF-1, AF-2...
color = "#3b82f6"
repos = ["~/code/assina-facil"]
statuses = ["Todo", "In Progress", "In Review", "Done"]
```

Campos-chave (`docs/cockpit/local-projects.mdx`):

| Campo | O que faz |
| --- | --- |
| `repo.path` | Âncora única — caminho absoluto ou `~`. Usado para casar na importação. |
| `repo.setup_script` | Roda ao criar workspace (ex.: instalar deps). |
| `repo.dev_server_script` | O que o botão Play / painel Preview vai rodar. |
| `repo.copy_files` | Arquivos copiados para cada worktree (ex.: `.env`). |
| `project.key` | Prefixo dos Simple IDs (`AF-1`). Derivado do nome se omitido. |
| `project.statuses` | Colunas criadas **só na primeira importação**; depois gerencie no app. |

Importe/exporte quando quiser:

```bash
vibe-kanban import ~/.vibe-kanban/projects.toml   # não-destrutivo: atualiza por id/nome/path, nunca apaga
vibe-kanban export /tmp/backup.toml
# ou via HTTP: POST /api/config/import, GET /api/config/export
```

### Criar via UI (alternativa)

Você também pode criar projeto/repo direto na UI de criação de workspace (`docs/workspaces/creating-workspaces.mdx:62`): clique em repos recentes, **Browse repos on disk** ou **Create new repo on disk** (inicializa um git novo). Para o SaaS, crie um repo vazio com `git init ~/code/assina-facil` e aponte o projeto para ele.

## 5. Scripts que fazem o agente trabalhar sozinho

Em **Settings → Projects & Repositories** ajuste por repo:

- **Setup script** (`pnpm install`) — roda em cada worktree novo; sem ele o agente perde tempo instalando à mão.
- **Dev server script** (`pnpm --filter app-web dev`) — o que o **Preview** e o botão Play usam (`docs/browser-testing.mdx:8`).
- **Cleanup script** — roda ao arquivar workspace.

Esses três scripts são o que permitem o **Engineering Loop** do cap. 02 fechar sozinho: o agente cria o worktree, o setup roda, o dev sobe, e o loop `check → ler erro → corrigir` não depende de você.

Para o AssinaFácil, deixe o dev server subindo `app-web` na `5173` — o Preview proxy do Vibe Kanban (`:3003`) vai embuti-lo no painel **Preview** da workspace (ver cap. 04 e `docs/browser-testing.mdx:34`).

## 6. Conferir que está tudo ok

1. Abra `http://localhost:3001` — o board deve listar **AssinaFácil** com colunas Todo / In Progress / In Review / Done e botão **New Issue**.
2. Entre no projeto — board vazio é normal (cap. 05 cria os cards).
3. Crie um card de teste "Hello AssinaFácil" e uma workspace vinculada — o agente deve iniciar e o painel **Logs** deve mostrar `VK-PIPELINE-STAGE: 1`.
4. Se o board não abrir, confira `RUST_LOG=debug` (`crates/server/src/main.rs:33` filtra por `server`, `services`, `db`, `executors`) e `lsof -nP -i :3001 -sTCP:LISTEN`.

## Checklist do capítulo

- [ ] `npx aurapunk-ide` (ou `pnpm run dev` no clone) abre em `http://localhost:3001` sem `AddrInUse`.
- [ ] Preferências de agente/IDE/som definidas em Settings.
- [ ] `projects.toml` com projeto `AssinaFácil` (`AF`) e repo `~/code/assina-facil` importado — board aparece com 4 colunas.
- [ ] Scripts `setup_script` e `dev_server_script` configurados; `copy_files` com `.env` se o SaaS precisar.
- [ ] Card de teste criado e workspace vinculada sobe com `VK-PIPELINE-STAGE: 1` no Logs.
