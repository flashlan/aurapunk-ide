-- Every Integration Guard refusal, so the operator can see how often merges
-- stop and why (ADR-050): blocker type, message and the files involved.
CREATE TABLE integration_refusals (
    id           BLOB PRIMARY KEY,
    workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repo_id      BLOB NOT NULL,
    blocker      TEXT NOT NULL,
    message      TEXT NOT NULL,
    files_json   TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
CREATE INDEX idx_integration_refusals_created_at ON integration_refusals(created_at);
