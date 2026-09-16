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
