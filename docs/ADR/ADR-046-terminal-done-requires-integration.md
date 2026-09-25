# ADR-046: Terminal Done requires an integrated workspace (operator override only)

- **Status:** Proposed
- **Date:** 2026-09-25
- **Context:** A card whose merge was refused by the Integration Guard
  could still be moved to Done: the MCP `update_issue` tool sent
  `allow_unmerged_done: true` on every request, and the backend check
  that once refused unmerged terminal moves had been deleted (added in
  `4c54e556`, removed together with the rest of the guard in
  `13e33dfd`). The guard therefore failed open — an agent that hit a
  blocked merge simply flipped the card, the board looked finished, and
  nothing was merged. Two further gaps made the block opaque: the MCP
  transport dropped non-2xx response bodies and the structured
  `error_data` payload (so "resolve the files below" arrived with no
  files), and the first refused attempt failed immediately instead of
  waiting for the transient blocker to clear.
- **Decision:**
  1. `merge_and_update_issue` refuses a transition into a terminal
     column while the issue has at least one linked workspace and none
     of them is integrated (direct merge, or a PR at `merged`), unless
     the request carries `allow_unmerged_done: true`. Issues with no
     linked workspace have nothing to integrate and move freely.
     Helpers live in `db::models::merge` (`Merge::is_integrated`,
     `issue_has_unintegrated_workspace`, `issue_is_integrated`) so the
     guard and the auto-move hook share one definition of "integrated".
  2. The override is claimed **per interactive surface**: the board's
     completion dialog, the command-bar status pick, the issue edit
     dialog, the sidebar tree drop, the TUI's card editor and column
     drag, the mobile `/close` command, and the mirrored remote move.
     Automation never claims it — the MCP `update_issue` sends no
     override, so a blocked merge can no longer be papered over.
  3. MCP merge refusals are self-describing: `send_envelope` parses the
     envelope whatever the HTTP status, so the backend's `message`
     (what blocked it) becomes the tool error and `error_data` (blocker
     `type`, conflicted/dirty files, overlapping agents) rides along as
     details.
  4. `complete_workspace_card` / `merge_workspace` wait out transient
     blockers (`integration_in_progress`, `agent_work_conflict`) for up
     to 45 s inside the tool call, and every refusal states explicitly
     that the card was NOT merged and NOT moved, with the wait-and-retry
     next step.
  5. `auto_move::on_pipeline_completed` honours `done_intent` (written
     by the board *before* the merge attempt) only when the issue is
     actually integrated; otherwise the card takes the normal In Review
     path instead of silently jumping to Done on the next run.
- **Consequences:** automation can no longer complete a card without a
  merge; every refusal carries its own reason and next step. Operator
  surfaces keep their existing behaviour (they opt out explicitly), so
  the guard bites only non-interactive writers — if a future
  interactive surface gains a status write, it must claim the override
  too or the move will be refused with a clear message.
- **Files:** `crates/db/src/models/merge.rs`,
  `crates/server/src/routes/local_kanban.rs`,
  `crates/server/src/routes/mobile_sync.rs`,
  `crates/services/src/services/auto_move.rs`,
  `crates/mcp/src/lib.rs`, `crates/mcp/src/task_server/tools/{mod,completion,issues}.rs`,
  `crates/tui/src/app.rs`, `packages/web-core/src/**/{ProjectKanban,ProjectSelectionDialog,SharedAppLayout,CloudAuthActions}.tsx`.
