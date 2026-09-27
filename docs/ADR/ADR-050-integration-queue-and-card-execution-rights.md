# ADR-050: Integration queue, card execution rights, and the classifier's role in merges

## Status

Accepted — the integration queue, conflict classification and branch-side
conflict resolution are implemented (2026-09-27); execution rights are
Proposed.

## Date

2026-09-27

## Context

Three problems surfaced once several agents (and, with ADR-048, several people)
work on one board:

1. **A blocked merge stopped the agent.** `complete_workspace_card` /
   `merge_workspace` held the agent inside the tool call for up to 45 s while
   the Integration Guard refused for a transient reason (another integration
   running for the repository, another workspace's overlapping
   `declare_agent_work`), then failed. Nothing retried when the blocker
   cleared, so the card stayed open until someone intervened.
2. **Who may run agents on a card.** Every run creates a branch and a
   worktree on the runner's machine. Two people running agents on the same
   card produce divergent branches that only Git (a PR with manual
   resolution) can reconcile.
3. **The classifiers (Jev / Laya) are not part of merging.** They power
   compaction, the Mem0 memory gate and the tool-call guardrail. Whether they
   should choose a merge strategy came up.

## Decision

### 1. Integration queue — "merge when available" (implemented)

- On a transient refusal the MCP tool queues the request
  (`POST /api/workspaces/{id}/git/merge-queue`, table `integration_requests`)
  with the branch commit the agent verified and returns at once with
  `queued: true`, the blocker and the queue position. The agent is told the
  merge is NOT done, not to move the card or run git merge/rebase/push, not to
  commit to the branch while it waits, and to continue other work.
- A backend worker (`routes::workspaces::merge_queue`) retries queued
  requests when woken (enqueue, finished merge) and every 10 s. It merges
  through the normal route with `expected_head` = the queued commit, checked
  **while holding the Integration Guard lease**: a commit that lands while the
  merge waits for the lease is never integrated unverified (`BranchMoved` →
  request `superseded`).
- The outcome is posted into the workspace's agent session (queued behind a
  running turn, or started as a follow-up when idle): merged, superseded, or
  failed with the blocker detail (conflicts, dirty target) and what to do.
- `complete` mode leaves Mem0 + Done to the agent: after the merge the agent
  calls `complete_workspace_card` again; the tool sees through
  `GET …/merge-queue` that the current head was integrated (the squash moves
  the branch to the merge commit, stored as `result_sha`) and does not merge
  twice.

### 2. One writer per card: the assignee (proposed, ships with ADR-048 T1)

- Only the card's assignee (the holder of its claim) starts coding-agent
  workspaces on it; the backend refuses others, including through MCP.
- Others read, comment and review; they may run a **read-only** review/QA
  agent on the branch (a pipeline stage role), **take over** by reassignment
  (the claim moves and work continues on the existing branch), or open a
  **sub-card** with its own branch for parallel work.

### 3. Classifiers classify conflicts; Git chooses the strategy (implemented)

- The merge strategy stays deterministic and reproducible (squash, three-way
  when possible). A model never picks it.
- When a merge hits textual conflicts, Jev/Laya may classify them as
  **trivial** (imports, formatting, lockfiles, generated files) — delegated to
  the agent to resolve — or **semantic** (logic changed on both sides) —
  delegated with a request for human review. This extends the merge-block
  delegation of ADR-044.
- Implemented as `rlcd::classify_merge_conflict`: lockfiles, generated files
  (`shared/types.ts`, schemas, `.sqlx`, snapshots) and `CHANGELOG.md` are
  trivial by path; other files are sent to the configured classifier with
  what each side changed since the merge base, asked two single-concept
  questions (`same_logic`, `cosmetic`). Anything short of clearly cosmetic or
  independent — including an unreachable classifier — is semantic. The result
  rides on `GitOperationError::MergeConflicts.classification` with guidance,
  so the MCP tool, the integration queue message and the UI all receive it.

### 4. Conflicts are resolved on the task branch; the target is never left conflicted (implemented)

- Previously a conflicting squash ran in the target checkout and left the
  unmerged files there (`UU` + `SQUASH_MSG`); until someone resolved them on
  the target, every merge into that repository was blocked as
  `dirty_worktree`, and the delegate flow asked an agent to resolve on the
  target, outside its worktree and its tests.
- `merge_changes` now simulates the merge in memory first
  (`git merge-tree --write-tree --name-only`, Git ≥ 2.38) and returns
  `MergeConflicts` without touching any checkout, index or ref. As a safety
  net, a squash that still conflicts (older Git) is undone with
  `git reset --merge` (unrelated local changes kept) and the pending
  `SQUASH_MSG` removed.
- Resolution happens where the context and tests are: the agent runs
  `git merge <target>` in its own workspace, resolves (regenerating lockfiles
  and generated files), runs the checks, commits on its branch and retries —
  the retry integrates cleanly. The MCP next step, the integration-queue
  message, the delegate prompt (which recomputes the conflicts in memory
  instead of reading a dirty target) and the merge dialog all say so; the
  classification decides whether the operator reviews the resolution.
- Verified: `conflicting_merge_leaves_the_target_checkout_clean` and
  `merge_tree_check_reports_clean_merges` (git crate, all 31 safety tests
  green); end to end on a real repository — the conflict left `main` with 0
  changes, the branch-side resolution then merged cleanly with the resolved
  content on `main`.

## Consequences

- Agents no longer stall or give up on a busy Integration Guard; queued merges
  land without operator action and the agent is called back.
- The worker is sequential: one request waiting up to 15 s for a lease delays
  the next pass. Acceptable at current volumes.
- Tested with a real repository and a held lease: blocked → merged on release;
  a commit during the lease wait → superseded with the target untouched;
  re-queue at the new head → merged, `integrated_head` true. The session
  notification reuses the follow-up/queued-message paths (not exercised end to
  end, which would start a real agent).
