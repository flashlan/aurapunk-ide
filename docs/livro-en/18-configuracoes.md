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
