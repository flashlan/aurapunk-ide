# ADR-044: Structured merge blocks with agent delegation

- **Status:** Accepted
- **Date:** 2026-09-17
- **Context:** Moving a card with merge failed twice with raw git stderr
  wrapped as generic `InvalidRepository` (first an unchecked dirty tree,
  then real textual conflicts). The UI showed an OK-only dialog and the
  card silently stayed put, with nothing reaching the agent system —
  even though the Integration Guard design promises explicit,
  actionable refusals.
- **Decision:**
  1. The cleanliness gate runs in `merge_workspace` validation, before
     the lease: tracked modifications block, untracked files are
     reported but never block.
  2. All merge blocks return structured data: `DirtyWorktree`
     (branch, modified, untracked) and `MergeConflicts` (files parsed
     from `CONFLICT ... in <path>` stderr, op, target branch).
  3. The kanban UI offers Stash & retry (explicit `POST .../git/stash`;
     hidden in conflict mode), Delegate to agent (`POST
     .../git/delegate-block`, which queues a cleanup instruction to the
     workspace executor and asks the user only when ambiguous), Move
     without merging, and Cancel.
  4. The backend never stashes, commits, or pushes on its own; agents
     must keep generated junk (`db.v2.sqlite`, `installer-output/`,
     `*.log`) out of commits and ask before anything destructive.
- **Consequences:** merge failures become visible, actionable, and
  delegable instead of silent reverts. The `Completion and Integration
  Guard Protocol` in `AGENTS.md` was updated to match (agents clean up
  on delegation instead of just reporting the blocker).
- **Files:** `crates/git/src/lib.rs` (`worktree_cleanliness`,
  conflict parsing), `crates/server/src/routes/workspaces/git.rs`
  (gate, `DirtyWorktree`, `/stash`, `/delegate-block`),
  `crates/git/src/cli.rs` (`stash_push`),
  `packages/web-core/src/features/kanban/ui/MergeBlockedDialog.tsx`,
  `KanbanContainer.tsx` (catch hook), `shared/lib/api.ts`.
