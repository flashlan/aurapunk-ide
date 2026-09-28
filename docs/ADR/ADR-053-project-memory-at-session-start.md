# ADR-053: Project memory reaches the agent at session start; the handoff lives in Mem0 per card

## Status

Accepted — implemented 2026-09-27. The Mem0 half of the handoff needs the
`mem0-vk` raw mode and the Cloud gateway change deployed (aurapunk-cloud).

## Date

2026-09-27

## Context

Measured on the operator's data:

- **Agents rarely consult Mem0.** In the 13 recent processes with a
  normalized transcript, `memory_search` appears only in the 5 that ran the
  card protocol (`get_rules`); free chat sessions never call it. Tool use is
  dominated by `bash` (548), `read` (204) and `grep` (89). Recall depends on
  the agent remembering a multi-step protocol (`get_rules` → `get_context` →
  `memory_search` with the repo slug), among dozens of MCP tools that some
  agents only load on demand.
- **What is stored is a fix diary, not a project map.** The 49 memories of
  `aurapunk-ide` are mostly "Fix: … commit …" notes. Vector scores are noisy:
  unrelated facts score 0.64–0.68, relevant ones ~0.74.
- **`mem0-vk` rewrites every write** into LLM-extracted facts and pushes them
  to the graph, so a handoff summary could not be stored verbatim.

## Decision

1. **Push, don't wait for pull.** The first message of every new agent
   session (card start, new chat session, queued first message) gets an
   `<aurapunk-memory>` block: the app searches Mem0 itself (query = card title
   + description, or the prompt; up to 2 workspace repos, 8 candidates) and
   the RLCD classifier (Jev / Laya) keeps the ones useful for the task (≤ 5).
   Without a classifier answer, vector score ≥ 0.6 decides. Follow-ups add
   nothing (the agent keeps its own context, ADR-052).
2. **The handoff summary lives in Mem0 per card.** The answer to
   `/summarize` is stored verbatim (`raw: true`: one point, no extraction, no
   graph) under `user_id = handoff-<issue_id>` (`handoff-ws-<workspace_id>`
   for cards without an issue), replacing the previous one. A new session
   uses the local summary when there is one, otherwise the Mem0 one — so a
   session on another machine, or a teammate, starts from it. It is deleted
   when the card merges. Only points marked `raw` are read back, so a server
   without raw support never hands over extracted fragments.
3. **`mem0-vk` gains the raw write** (`POST /api/memories {raw: true}`) and the
   Cloud gateway treats it as a plain vector write (allowed on the Free plan).

## Consequences

- Every new session starts with the few project facts that matter for its
  task, at a cost of a Mem0 search and a classifier call (≤ ~10 s worst case,
  best-effort).
- Recall is only as good as what is stored. The fix-diary content remains the
  limit: a hierarchical project map (modules, where things live, how they
  connect) is the next step for "a quick view of everything" without
  exploration agents.
- Mem0 Platform (official API) is not used for recall/handoff yet.
