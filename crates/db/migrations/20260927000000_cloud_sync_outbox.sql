-- Cloud sync outbox (ADR-047 phase 2).
--
-- Every write to a synced table records WHICH entity changed; the backend
-- publisher builds the payload from the current row when it drains the queue,
-- so repeated edits coalesce and a row deleted before publishing becomes a
-- tombstone. Triggers catch all writers (UI, MCP, TUI, agents) without wiring
-- each Rust call site. Nothing is recorded while no Cloud account is linked.

CREATE TABLE IF NOT EXISTS cloud_sync_state (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO cloud_sync_state (id, enabled) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id   BLOB NOT NULL,
    -- Second key of composite entities (issue_workspace: workspace id).
    aux_id      BLOB,
    operation   TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

-- projects -------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS cloud_sync_projects_ins AFTER INSERT ON projects
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('project', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_projects_upd AFTER UPDATE ON projects
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('project', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_projects_del AFTER DELETE ON projects
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('project', OLD.id, 'delete');
END;

-- project_statuses -------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS cloud_sync_statuses_ins AFTER INSERT ON project_statuses
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('status', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_statuses_upd AFTER UPDATE ON project_statuses
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('status', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_statuses_del AFTER DELETE ON project_statuses
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('status', OLD.id, 'delete');
END;

-- issues -----------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS cloud_sync_issues_ins AFTER INSERT ON issues
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('issue', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_issues_upd AFTER UPDATE ON issues
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('issue', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_issues_del AFTER DELETE ON issues
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('issue', OLD.id, 'delete');
END;

-- workspaces (record + per-workspace context) -----------------------------------
CREATE TRIGGER IF NOT EXISTS cloud_sync_workspaces_ins AFTER INSERT ON workspaces
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('workspace', NEW.id, 'upsert');
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('workspace_context', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_workspaces_upd AFTER UPDATE ON workspaces
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('workspace', NEW.id, 'upsert');
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('workspace_context', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_workspaces_del AFTER DELETE ON workspaces
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('workspace', OLD.id, 'delete');
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('workspace_context', OLD.id, 'delete');
END;

-- issue_workspaces (link record; the issue payload also carries workspace_id) ---
CREATE TRIGGER IF NOT EXISTS cloud_sync_issue_workspaces_ins AFTER INSERT ON issue_workspaces
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, aux_id, operation) VALUES ('issue_workspace', NEW.issue_id, NEW.workspace_id, 'upsert');
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('issue', NEW.issue_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_issue_workspaces_del AFTER DELETE ON issue_workspaces
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, aux_id, operation) VALUES ('issue_workspace', OLD.issue_id, OLD.workspace_id, 'delete');
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('issue', OLD.issue_id, 'upsert');
END;

-- sessions / execution processes refresh the workspace context -----------------
CREATE TRIGGER IF NOT EXISTS cloud_sync_sessions_ins AFTER INSERT ON sessions
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('workspace_context', NEW.workspace_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_sessions_upd AFTER UPDATE ON sessions
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('workspace_context', NEW.workspace_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_processes_ins AFTER INSERT ON execution_processes
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation)
    SELECT 'workspace_context', workspace_id, 'upsert' FROM sessions WHERE id = NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_processes_upd AFTER UPDATE OF status, exit_code, completed_at, dropped ON execution_processes
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation)
    SELECT 'workspace_context', workspace_id, 'upsert' FROM sessions WHERE id = NEW.session_id;
END;

-- coding agent turns are the chat records ----------------------------------------
CREATE TRIGGER IF NOT EXISTS cloud_sync_turns_ins AFTER INSERT ON coding_agent_turns
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('chat', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_turns_upd AFTER UPDATE ON coding_agent_turns
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('chat', NEW.id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS cloud_sync_turns_del AFTER DELETE ON coding_agent_turns
WHEN (SELECT enabled FROM cloud_sync_state WHERE id = 1) = 1
BEGIN
    INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation) VALUES ('chat', OLD.id, 'delete');
END;
