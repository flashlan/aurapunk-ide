-- Allow OpenCodeReview executions to be recorded independently from coding agents.
-- SQLite requires rebuilding the CHECK-constrained column to add a value.
ALTER TABLE execution_processes
  ADD COLUMN run_reason_new TEXT NOT NULL DEFAULT 'setupscript'
    CHECK (run_reason_new IN ('setupscript',
                               'cleanupscript',
                               'archivescript',
                               'codingagent',
                               'devserver',
                               'opencodereview'));

UPDATE execution_processes
  SET run_reason_new = run_reason;

DROP INDEX IF EXISTS idx_execution_processes_run_reason;
DROP INDEX IF EXISTS idx_execution_processes_session_status_run_reason;
DROP INDEX IF EXISTS idx_execution_processes_session_run_reason_created;
DROP INDEX IF EXISTS execution_processes_one_running_codingagent_per_session;

ALTER TABLE execution_processes DROP COLUMN run_reason;

ALTER TABLE execution_processes
  RENAME COLUMN run_reason_new TO run_reason;

CREATE INDEX idx_execution_processes_run_reason
        ON execution_processes(run_reason);

CREATE INDEX idx_execution_processes_session_status_run_reason
        ON execution_processes (session_id, status, run_reason);

CREATE INDEX idx_execution_processes_session_run_reason_created
        ON execution_processes (session_id, run_reason, created_at DESC);

CREATE UNIQUE INDEX execution_processes_one_running_codingagent_per_session
    ON execution_processes (session_id)
    WHERE status = 'running'
      AND run_reason = 'codingagent'
      AND dropped = FALSE;
