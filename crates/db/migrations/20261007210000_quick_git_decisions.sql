-- Operator-supervised Quick executions run in the target checkout.  Keep the
-- checkpoint and every decision durable so a later revert is a new Git commit,
-- never a destructive reset of the operator's tree.
CREATE TABLE quick_git_decisions (
    id              BLOB PRIMARY KEY,
    workspace_id    BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id        BLOB REFERENCES issues(id) ON DELETE SET NULL,
    repo_id         BLOB NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    target_branch   TEXT NOT NULL,
    checkpoint_sha  TEXT NOT NULL,
    head_sha        TEXT,
    action          TEXT NOT NULL CHECK (action IN ('awaiting_operator', 'keep', 'revert', 'delegate')),
    status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'blocked', 'delegated')),
    result_sha      TEXT,
    detail          TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    decided_at      TEXT
);

CREATE INDEX idx_quick_git_decisions_workspace_created
    ON quick_git_decisions(workspace_id, created_at DESC);
CREATE INDEX idx_quick_git_decisions_pending
    ON quick_git_decisions(status, created_at DESC);
