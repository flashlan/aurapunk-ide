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
