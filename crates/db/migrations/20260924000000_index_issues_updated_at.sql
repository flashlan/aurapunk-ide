-- Cursor support for the kanban delta path: `?since=<updated_at>` (and any
-- updated_at-ordered page) needs an index, otherwise every incremental poll
-- degrades into a full table scan of `issues`.
--
-- NOTE: `issues.updated_at` is stamped in application SQL (Issue::update /
-- archive / restore), not by a trigger, and `Issue::delete` is a hard DELETE
-- with no tombstone — a pure updated_at cursor can observe changes but never
-- deletions. Deletions are therefore delivered out of band (hook `remove`
-- patch / full snapshot refresh), never through this index's query path.
CREATE INDEX IF NOT EXISTS idx_issues_updated_at ON issues(updated_at);
