# ADR-051: MCP as a full-workflow orchestrator, with RLCD routing

## Status

Proposed — steps 1 and 2 implemented (2026-09-27)

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
3. **`route_task` with RLCD scores.** Given a task description, the
   configured classifier scores short, single-concept questions — needs
   exploration? needs a plan? mechanical change? needs review? fits one
   session? — and each available pipeline's fit. The tool returns a
   recommended role sequence (explore → plan → build → review), pipeline and
   whether to split into subtasks, **with the scores**; the calling agent
   decides. An unavailable classifier returns the default pipeline and no
   split (conservative, as the memory gate and guardrails do).

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
