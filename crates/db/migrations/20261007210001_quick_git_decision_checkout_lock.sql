-- Follow-up to the initial Quick decision ledger.  Kept separate because the
-- first migration may already be applied in a developer's local database.
-- A source checkout is exclusive: two Quick runs on the same branch would
-- make a later, audited reversal ambiguous.
CREATE UNIQUE INDEX idx_quick_git_decisions_active_checkout
    ON quick_git_decisions(repo_id, target_branch)
    WHERE status IN ('pending', 'delegated');
