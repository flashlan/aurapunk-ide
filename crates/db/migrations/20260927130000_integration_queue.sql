-- Integration queue (ADR-050).
--
-- A merge refused by a transient Integration Guard blocker (another
-- integration running, overlapping agent work) used to hold the agent inside
-- the tool call for 45 s and then fail, and nothing retried once the blocker
-- cleared. The request is now queued with the verified commit; a backend
-- worker integrates it when possible and tells the agent's session.
CREATE TABLE IF NOT EXISTS integration_requests (
    id           BLOB PRIMARY KEY,
    workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repo_id      BLOB NOT NULL,
    commit_sha   TEXT NOT NULL,
    -- Branch head after a successful merge (the squash moves the branch to
    -- the merge commit), so the same head is recognized as integrated.
    result_sha   TEXT,
    -- 'merge' keeps the workspace open; 'complete' is followed by the
    -- agent's own completion (Mem0 summary + Done).
    mode         TEXT NOT NULL CHECK (mode IN ('merge', 'complete')),
    status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'merged', 'failed', 'superseded')),
    blocker      TEXT,
    message      TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
CREATE INDEX IF NOT EXISTS idx_integration_requests_status
    ON integration_requests (status, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_requests_workspace
    ON integration_requests (workspace_id, repo_id, created_at);
