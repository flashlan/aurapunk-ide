use anyhow::Error as AnyhowError;
use db::models::{execution_process::ExecutionProcess, scratch::Scratch, workspace::Workspace};
use serde::{Deserialize, Serialize};
use sqlx::Error as SqlxError;
use strum_macros::{Display, EnumString};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum EventError {
    #[error(transparent)]
    Sqlx(#[from] SqlxError),
    #[error(transparent)]
    Parse(#[from] serde_json::Error),
    #[error(transparent)]
    Other(#[from] AnyhowError), // Catches any unclassified errors
}

#[derive(EnumString, Display, Clone, Copy, PartialEq, Eq)]
pub enum HookTables {
    #[strum(to_string = "workspaces")]
    Workspaces,
    #[strum(to_string = "execution_processes")]
    ExecutionProcesses,
    #[strum(to_string = "scratch")]
    Scratch,
    // --- Kanban board tables (delta sync) ---------------------------------
    // Only tables with a BLOB (Uuid) primary key and a resolvable owning
    // project are hooked; `pull_requests` / `pull_request_issues`
    // (TEXT ids, project reachable only through a multi-hop join) and
    // `issue_comments` (scoped per issue, not per project) keep the plain
    // fallback poll.
    #[strum(to_string = "issues")]
    Issues,
    #[strum(to_string = "project_statuses")]
    ProjectStatuses,
    #[strum(to_string = "kanban_tags")]
    KanbanTags,
    #[strum(to_string = "issue_tags")]
    IssueTags,
    #[strum(to_string = "issue_relationships")]
    IssueRelationships,
}

impl HookTables {
    /// Wire table name (`/v1/fallback/<name>`) for board tables that ride the
    /// kanban delta bus; `None` for the legacy event-store tables.
    ///
    /// NOTE `kanban_tags` is served to the frontend as `tags` — a pre-existing
    /// `tags` table occupies that name in SQLite (see the kanban migration).
    pub fn kanban_table(&self) -> Option<&'static str> {
        match self {
            HookTables::Issues => Some("issues"),
            HookTables::ProjectStatuses => Some("project_statuses"),
            HookTables::KanbanTags => Some("tags"),
            HookTables::IssueTags => Some("issue_tags"),
            HookTables::IssueRelationships => Some("issue_relationships"),
            _ => None,
        }
    }

    /// Whether column 1 of the row is the owning `project_id`. Junction
    /// tables (`issue_tags`, `issue_relationships`) carry an `issue_id` there
    /// instead and must resolve their project through the issue.
    pub fn project_id_on_row(&self) -> bool {
        matches!(
            self,
            HookTables::Issues | HookTables::ProjectStatuses | HookTables::KanbanTags
        )
    }
}

#[derive(Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "data", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecordTypes {
    Workspace(Workspace),
    ExecutionProcess(ExecutionProcess),
    Scratch(Scratch),
    DeletedWorkspace {
        rowid: i64,
    },
    DeletedExecutionProcess {
        rowid: i64,
        session_id: Option<Uuid>,
        process_id: Option<Uuid>,
    },
    DeletedScratch {
        rowid: i64,
        scratch_id: Option<Uuid>,
        scratch_type: Option<String>,
    },
}

#[derive(Serialize, Deserialize, TS)]
pub struct EventPatchInner {
    pub(crate) db_op: String,
    pub(crate) record: RecordTypes,
}

#[derive(Serialize, Deserialize, TS)]
pub struct EventPatch {
    pub(crate) op: String,
    pub(crate) path: String,
    pub(crate) value: EventPatchInner,
}
