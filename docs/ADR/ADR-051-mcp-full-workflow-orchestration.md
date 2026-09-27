# ADR-051: MCP as a full-workflow orchestrator, with RLCD routing

## Status

Accepted — steps 1, 2 and 3 implemented (2026-09-27)

## Date

2026-09-27

## Context

The MCP server already lets an agent create cards (including subtasks via
`parent_issue_id`), manage columns, start workspaces with a chosen executor,
send prompts to sessions, answer approvals, merge and complete cards. What an
agent driving the whole workflow from a terminal still lacked:

- a way to **wait** for sub-agents and collect their results (only
  `get_execution` polling existed);
- the **agent catalog** (executors, models, presets) to choose from;
- **pipeline** authoring (only the card-scoped `get_pipeline` read exists);
- **roles** (explore, plan, build, review, decide) and a way to choose them.

The pipeline model predates agents that can carry long tasks end to end;
today an orchestrating agent can split the work, run sub-agents in parallel
and integrate the results.

## Decision

1. **Wait and discover (done).**
   - `wait_for_executions(execution_ids[1..32], timeout_seconds ≤ 1800)`
     returns each execution's status, exit code and final agent message. It
     returns early when any execution waits on an approval or question (with
     the pending items), so the orchestrator answers instead of timing out.
   - `list_agents` returns the executor catalog (`GET /api/agents/catalog`,
     the same records Mobile receives): models, providers, agent modes,
     permissions, default model, presets.
   Both are in the global and orchestrator routers.
2. **Pipelines over MCP (done).** `list_pipelines` (stage prompts omitted),
   `get_pipeline_definition` (full TOML), `save_pipeline` (validated before
   writing; errors with line/column), `delete_pipeline`, and
   `set_issue_pipeline`, backed by `PUT /api/issues/{id}/pipeline`, which
   writes the same `vk:pipeline` pointer block + metadata as the create-card
   dialogs (shared `pipeline_pointer`), replaces an existing block instead of
   duplicating it, refuses unknown pipelines, defaults enabled stages to each
   stage's `default_enabled`, and clears with an empty list (metadata set to
   `null`, since issue updates merge metadata).
3. **`route_task` (done), calibrated against Laya.** A first version asked
   five task questions plus one fit question per pipeline; measured on
   2026-09-27 against Laya Cloud with four reference tasks (rename, version
   bump, team sync scopes, OAuth across three apps) it was wrong in both
   directions (a rename scored "needs a plan" 0.90; the cross-cutting task
   scored low on everything; pipeline fit picked the heaviest pipeline for
   the rename and `quick` for the cross-cutting task). Of eight phrasings only
   "Does this task touch several components or systems?" separated the sets
   (0.26 / 0.16 vs 0.89 / 0.94). The shipped router asks only that question
   and combines it with text features (word count, clauses, mechanical
   wording):
   - cross-cutting (several parts ≥ 0.6, ≥ 40 words or ≥ 4 clauses) →
     explore → plan → build → review, split when very large;
   - small (< 0.35, ≤ 25 words) → build → review; with mechanical wording →
     build only and the `quick` pipeline when it exists;
   - otherwise plan → build → review.
   No pipeline is inferred otherwise (the agent picks with `list_pipelines`).
   Without a classifier the heuristics decide alone (`source: heuristic`).
   `POST /api/rlcd/route-task` backs the MCP tool.

## Consequences

- An agent in a terminal can run the complete loop: create parent card and
  subtasks → pick agents → start them in parallel → wait → integrate →
  complete.
- Routing stays advisory; a wrong score costs a suboptimal plan, never an
  action taken without the agent's decision.
- Verified over the real MCP protocol (stdio JSON-RPC against a backend):
  `list_agents` listed 6 executors with models and presets;
  `wait_for_executions` returned two finished executions' final messages at
  once and rejected an empty list.
- With the `adaptive` engine and Jev unreachable, each `route_task` waits for
  the Jev timeout (~8.7 s) before Laya answers; the `laya` engine avoids it.
