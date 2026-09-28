# ADR-052: The agent owns its context; the chat hands it over only to a new session

## Status

Accepted — implemented 2026-09-27.

## Date

2026-09-27

## Context

- Coding agents keep their own conversation. A follow-up carries only the new
  message: a headed agent receives it in its live terminal, a headless one is
  started with `--resume <id>` (the id is stored per turn in
  `coding_agent_turns.agent_session_id`) and reloads its history from its own
  session file. The model API is stateless, so the agent re-sends that history
  on every call; prompt caching makes the repeated prefix cheap, and the
  agent's own `/compact` is what shrinks it.
- The chat's "Fast Jev" compaction ran the Jev/Laya classifiers over the chat
  entries, stored a "summary" marker and, from then on, **prepended that
  marker plus the last four turns to every message** sent to the agent
  (`prepareCloudPromptWithIsolation`). The classifiers score, they do not
  write text, so the "summary" was statistics and claims that did not hold
  ("history isolated", "indexed in Mem0"). The agent kept its full history
  regardless, so each message after a marker *added* a copy of it to the
  agent's context — the opposite of compaction.
- The one moment an agent really lacks context is the first message of a new
  session in a workspace that was already worked on (switching agents opens a
  new session: a session is bound to one executor), or when its session is
  lost.

## Decision

1. **Follow-ups carry only the user's message.** The prompt prefix is gone.
2. **Compaction = the agent's own `/compact`** (manual `/compact` and aliases,
   or automatically at the configured threshold). The chat records a marker
   stating that; no classifier runs for it.
3. **Handoff to a new session, once** (`routes::sessions::handoff`). The first
   message of a new session in a workspace with earlier sessions is prefixed
   with an `<aurapunk-handoff>` block built from:
   - the summary the previous agent wrote on request (`/summarize` or
     `/handoff` sends a prompt tagged `[aurapunk:handoff-summary]`; that
     turn's final answer is used) — it replaces the older exchanges;
   - the branch state from git (commits and changed files vs the target,
     uncommitted count);
   - the last reported pipeline stage;
   - the previous exchanges (prompt + final answer of each turn, truncated);
     beyond eight, the first and last two are kept and the RLCD classifier
     (Jev / Laya) picks the middle ones still needed — recency without a
     classifier answer.
4. **Nothing is stored for the handoff.** It is rebuilt from the database and
   the branch, so its lifecycle is the workspace's: the merge archives it.
   Durable knowledge goes to Mem0 when the card completes
   (`complete_workspace_card`). Mem0 was rejected for the handoff itself: it
   is in-progress state (the RLCD memory gate refuses it), Mem0 recall is
   semantic across cards (stale handoffs would leak into other cards), and it
   would need explicit deletion at merge.

## Consequences

- Messages after a compaction no longer grow the agent's context; the Laya /
  Jev quota is no longer spent on compaction markers.
- A new agent on an existing workspace starts with the task, what was done,
  where the branch stands and what is open, instead of only the card text.
- Not covered: a lost agent session inside the same chat session (the
  `--resume` id no longer exists on disk) still fails instead of falling back
  to a new session with the handoff.
