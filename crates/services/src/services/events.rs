use std::{str::FromStr, sync::Arc};

use db::{
    DBService,
    models::{
        execution_process::ExecutionProcess, scratch::Scratch, session::Session,
        workspace::Workspace,
    },
};
use serde_json::json;
use sqlx::{Error as SqlxError, Sqlite, SqlitePool, decode::Decode, sqlite::SqliteOperation};
use tokio::sync::RwLock;
use utils::msg_store::MsgStore;
use uuid::Uuid;

#[path = "events/kanban.rs"]
pub mod kanban;
#[path = "events/patches.rs"]
pub mod patches;
#[path = "events/streams.rs"]
mod streams;
#[path = "events/types.rs"]
pub mod types;

pub use kanban::{KanbanEvent, KanbanEventBus, KanbanOp};
pub use patches::{execution_process_patch, scratch_patch, workspace_patch};
pub use types::{EventError, EventPatch, EventPatchInner, HookTables, RecordTypes};

#[derive(Clone)]
pub struct EventService {
    msg_store: Arc<MsgStore>,
    db: DBService,
    kanban: KanbanEventBus,
    #[allow(dead_code)]
    entry_count: Arc<RwLock<usize>>,
}

impl EventService {
    /// Creates a new EventService that will work with a DBService configured with hooks
    pub fn new(
        db: DBService,
        msg_store: Arc<MsgStore>,
        entry_count: Arc<RwLock<usize>>,
        kanban: KanbanEventBus,
    ) -> Self {
        Self {
            msg_store,
            db,
            kanban,
            entry_count,
        }
    }

    /// Board-change bus feeding `/api/kanban/stream/ws`.
    pub fn kanban(&self) -> &KanbanEventBus {
        &self.kanban
    }

    async fn push_workspace_update_for_session(
        pool: &SqlitePool,
        msg_store: Arc<MsgStore>,
        session_id: Uuid,
    ) -> Result<(), SqlxError> {
        if let Some(session) = Session::find_by_id(pool, session_id).await?
            && let Some(workspace_with_status) =
                Workspace::find_by_id_with_status(pool, session.workspace_id).await?
            // Ephemeral workspaces (e.g. spec-intake) never surface in the live UI.
            && !workspace_with_status.ephemeral
        {
            msg_store.push_patch(workspace_patch::replace(&workspace_with_status));
        }
        Ok(())
    }

    /// Creates the hook function that should be used with DBService::new_with_after_connect
    pub fn create_hook(
        msg_store: Arc<MsgStore>,
        entry_count: Arc<RwLock<usize>>,
        db_service: DBService,
        kanban: KanbanEventBus,
    ) -> impl for<'a> Fn(
        &'a mut sqlx::sqlite::SqliteConnection,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>,
    > + Send
    + Sync
    + 'static {
        move |conn: &mut sqlx::sqlite::SqliteConnection| {
            let msg_store_for_hook = msg_store.clone();
            let entry_count_for_hook = entry_count.clone();
            let db_for_hook = db_service.clone();
            let kanban_for_hook = kanban.clone();
            Box::pin(async move {
                let mut handle = conn.lock_handle().await?;
                let runtime_handle = tokio::runtime::Handle::current();
                handle.set_preupdate_hook({
                    let msg_store_for_preupdate = msg_store_for_hook.clone();
                    let kanban_for_preupdate = kanban_for_hook.clone();
                    move |preupdate: sqlx::sqlite::PreupdateHookResult<'_>| {
                        if preupdate.operation != SqliteOperation::Delete {
                            return;
                        }

                        match preupdate.table {
                            // --- Kanban board tables -------------------------------
                            // The preupdate hook is the ONLY place a deleted row's
                            // values are visible. Column 0 is always `id`; column 1
                            // is `project_id` on the three direct tables and
                            // `issue_id` on the two junction tables (whose project
                            // can no longer be resolved — they fan out instead).
                            "issues"
                            | "project_statuses"
                            | "kanban_tags"
                            | "issue_tags"
                            | "issue_relationships" => {
                                if let Ok(id_value) = preupdate.get_old_column_value(0)
                                    && let Ok(id) = <Uuid as Decode<Sqlite>>::decode(id_value)
                                    && let Ok(table) = HookTables::from_str(preupdate.table)
                                    && let Some(wire_table) = table.kanban_table()
                                {
                                    let project_id = if table.project_id_on_row() {
                                        preupdate.get_old_column_value(1).ok().and_then(|value| {
                                            <Uuid as Decode<Sqlite>>::decode(value).ok()
                                        })
                                    } else {
                                        None
                                    };
                                    kanban_for_preupdate.publish(
                                        wire_table,
                                        project_id,
                                        KanbanOp::Delete,
                                        id,
                                    );
                                }
                            }
                            "workspaces" => {
                                if let Ok(value) = preupdate.get_old_column_value(0)
                                    && let Ok(workspace_id) =
                                        <Uuid as Decode<Sqlite>>::decode(value)
                                {
                                    let patch = workspace_patch::remove(workspace_id);
                                    msg_store_for_preupdate.push_patch(patch);
                                }
                            }
                            "execution_processes" => {
                                if let Ok(value) = preupdate.get_old_column_value(0)
                                    && let Ok(process_id) = <Uuid as Decode<Sqlite>>::decode(value)
                                {
                                    let patch = execution_process_patch::remove(process_id);
                                    msg_store_for_preupdate.push_patch(patch);
                                }
                            }
                            "scratch" => {
                                // Composite key: need both id (column 0) and scratch_type (column 1)
                                if let Ok(id_val) = preupdate.get_old_column_value(0)
                                    && let Ok(scratch_id) = <Uuid as Decode<Sqlite>>::decode(id_val)
                                    && let Ok(type_val) = preupdate.get_old_column_value(1)
                                    && let Ok(type_str) =
                                        <String as Decode<Sqlite>>::decode(type_val)
                                {
                                    let patch = scratch_patch::remove(scratch_id, &type_str);
                                    msg_store_for_preupdate.push_patch(patch);
                                }
                            }
                            _ => {}
                        }
                    }
                });

                handle.set_update_hook(move |hook: sqlx::sqlite::UpdateHookResult<'_>| {
                    let runtime_handle = runtime_handle.clone();
                    let entry_count_for_hook = entry_count_for_hook.clone();
                    let msg_store_for_hook = msg_store_for_hook.clone();
                    let db = db_for_hook.clone();
                    let kanban = kanban_for_hook.clone();

                    if let Ok(table) = HookTables::from_str(hook.table) {
                        // Board tables never enter the legacy `/entries/{n}`
                        // envelope — they are published on the delta bus as
                        // bare (table, id) changes and the WebSocket resolves
                        // the row from its typed queries.
                        if let Some(wire_table) = table.kanban_table() {
                            if hook.operation == SqliteOperation::Delete {
                                // The preupdate hook already published the
                                // tombstone (it is the only place the old row
                                // values are still visible).
                                return;
                            }
                            let pool = db.pool.clone();
                            let rowid = hook.rowid;
                            runtime_handle.spawn(async move {
                                let Some(id) =
                                    kanban_row_id(&pool, wire_table, rowid).await
                                else {
                                    return;
                                };
                                let project_id =
                                    kanban_project_id(&pool, table, id).await;
                                kanban.publish(
                                    wire_table,
                                    project_id,
                                    KanbanOp::Upsert,
                                    id,
                                );
                            });
                            return;
                        }

                        let rowid = hook.rowid;
                        runtime_handle.spawn(async move {
                            let record_type: RecordTypes = match (table, hook.operation.clone()) {
                                (HookTables::Workspaces, SqliteOperation::Delete)
                                | (HookTables::ExecutionProcesses, SqliteOperation::Delete)
                                | (HookTables::Scratch, SqliteOperation::Delete) => {
                                    return;
                                }
                                (HookTables::Workspaces, _) => {
                                    match Workspace::find_by_rowid(&db.pool, rowid).await {
                                        Ok(Some(workspace)) => RecordTypes::Workspace(workspace),
                                        Ok(None) => RecordTypes::DeletedWorkspace {
                                            rowid,
                                        },
                                        Err(e) => {
                                            tracing::error!(
                                                "Failed to fetch workspace: {:?}",
                                                e
                                            );
                                            return;
                                        }
                                    }
                                }
                                (HookTables::ExecutionProcesses, _) => {
                                    match ExecutionProcess::find_by_rowid(&db.pool, rowid).await {
                                        Ok(Some(process)) => RecordTypes::ExecutionProcess(process),
                                        Ok(None) => RecordTypes::DeletedExecutionProcess {
                                            rowid,
                                            session_id: None,
                                            process_id: None,
                                        },
                                        Err(e) => {
                                            tracing::error!(
                                                "Failed to fetch execution_process: {:?}",
                                                e
                                            );
                                            return;
                                        }
                                    }
                                }
                                (HookTables::Scratch, _) => {
                                    match Scratch::find_by_rowid(&db.pool, rowid).await {
                                        Ok(Some(scratch)) => RecordTypes::Scratch(scratch),
                                        Ok(None) => RecordTypes::DeletedScratch {
                                            rowid,
                                            scratch_id: None,
                                            scratch_type: None,
                                        },
                                        Err(e) => {
                                            tracing::error!("Failed to fetch scratch: {:?}", e);
                                            return;
                                        }
                                    }
                                }
                                // Kanban tables return above on the delta bus;
                                // this arm keeps the match exhaustive.
                                _ => return,
                            };

                            let db_op: &str = match hook.operation {
                                SqliteOperation::Insert => "insert",
                                SqliteOperation::Delete => "delete",
                                SqliteOperation::Update => "update",
                                SqliteOperation::Unknown(_) => "unknown",
                            };

                            // Handle operations with direct patches
                            match &record_type {
                                RecordTypes::Scratch(scratch) => {
                                    let patch = match hook.operation {
                                        SqliteOperation::Insert => scratch_patch::add(scratch),
                                        SqliteOperation::Update => scratch_patch::replace(scratch),
                                        _ => scratch_patch::replace(scratch),
                                    };
                                    msg_store_for_hook.push_patch(patch);
                                    return;
                                }
                                RecordTypes::DeletedScratch {
                                    scratch_id: Some(scratch_id),
                                    scratch_type: Some(scratch_type_str),
                                    ..
                                } => {
                                    let patch = scratch_patch::remove(*scratch_id, scratch_type_str);
                                    msg_store_for_hook.push_patch(patch);
                                    return;
                                }
                                RecordTypes::Workspace(workspace) => {
                                    // Ephemeral workspaces (e.g. spec-intake) are
                                    // throwaway and must never surface in the live UI.
                                    if workspace.ephemeral {
                                        return;
                                    }
                                    // Emit workspace patch with status
                                    if let Ok(Some(workspace_with_status)) =
                                        Workspace::find_by_id_with_status(&db.pool, workspace.id)
                                            .await
                                    {
                                        let patch = match hook.operation {
                                            SqliteOperation::Insert => {
                                                workspace_patch::add(&workspace_with_status)
                                            }
                                            _ => workspace_patch::replace(&workspace_with_status),
                                        };
                                        msg_store_for_hook.push_patch(patch);
                                    }
                                    return;
                                }
                                RecordTypes::DeletedWorkspace { .. } => {
                                    return;
                                }
                                RecordTypes::ExecutionProcess(process) => {
                                    let patch = match hook.operation {
                                        SqliteOperation::Insert => {
                                            execution_process_patch::add(process)
                                        }
                                        SqliteOperation::Update => {
                                            execution_process_patch::replace(process)
                                        }
                                        _ => execution_process_patch::replace(process), // fallback
                                    };
                                    msg_store_for_hook.push_patch(patch);

                                    if let Err(err) = EventService::push_workspace_update_for_session(
                                        &db.pool,
                                        msg_store_for_hook.clone(),
                                        process.session_id,
                                    )
                                    .await
                                    {
                                        tracing::error!(
                                            "Failed to push workspace update after execution process change: {:?}",
                                            err
                                        );
                                    }

                                    return;
                                }
                                RecordTypes::DeletedExecutionProcess {
                                    process_id: Some(process_id),
                                    session_id,
                                    ..
                                } => {
                                    let patch = execution_process_patch::remove(*process_id);
                                    msg_store_for_hook.push_patch(patch);

                                    if let Some(session_id) = session_id
                                        && let Err(err) =
                                            EventService::push_workspace_update_for_session(
                                                &db.pool,
                                                msg_store_for_hook.clone(),
                                                *session_id,
                                            )
                                            .await
                                        {
                                            tracing::error!(
                                                "Failed to push workspace update after execution process removal: {:?}",
                                                err
                                            );
                                    }

                                    return;
                                }
                                _ => {}
                            }

                            // Fallback: use the old entries format for other record types
                            let next_entry_count = {
                                let mut entry_count = entry_count_for_hook.write().await;
                                *entry_count += 1;
                                *entry_count
                            };

                            let event_patch: EventPatch = EventPatch {
                                op: "add".to_string(),
                                path: format!("/entries/{next_entry_count}"),
                                value: EventPatchInner {
                                    db_op: db_op.to_string(),
                                    record: record_type,
                                },
                            };

                            let patch =
                                serde_json::from_value(json!([
                                    serde_json::to_value(event_patch).unwrap()
                                ]))
                                .unwrap();

                            msg_store_for_hook.push_patch(patch);
                        });
                    }
                });

                Ok(())
            })
        }
    }

    pub fn msg_store(&self) -> &Arc<MsgStore> {
        &self.msg_store
    }
}

/// Primary key of a board row from its SQLite rowid. Deliberately non-macro
/// sqlx: a fresh `query_as!` would need `cargo sqlx prepare` against a live
/// database, and one column doesn't justify that. Tables without a BLOB id
/// (the PR join tables) are not hooked, so they never reach here.
async fn kanban_row_id(pool: &SqlitePool, table: &str, rowid: i64) -> Option<Uuid> {
    let sql = match table {
        "issues" => "SELECT id FROM issues WHERE rowid = ?",
        "project_statuses" => "SELECT id FROM project_statuses WHERE rowid = ?",
        "tags" => "SELECT id FROM kanban_tags WHERE rowid = ?",
        "issue_tags" => "SELECT id FROM issue_tags WHERE rowid = ?",
        "issue_relationships" => "SELECT id FROM issue_relationships WHERE rowid = ?",
        _ => return None,
    };
    sqlx::query_scalar(sql)
        .bind(rowid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// Owning project of a board row. The three direct tables carry
/// `project_id` themselves; junction tables resolve it through their issue so
/// the WebSocket can scope the delta to the subscriber's project.
async fn kanban_project_id(pool: &SqlitePool, table: HookTables, id: Uuid) -> Option<Uuid> {
    let sql = match (table, table.project_id_on_row()) {
        (HookTables::Issues, _) => "SELECT project_id FROM issues WHERE id = ?",
        (HookTables::ProjectStatuses, _) => "SELECT project_id FROM project_statuses WHERE id = ?",
        (HookTables::KanbanTags, _) => "SELECT project_id FROM kanban_tags WHERE id = ?",
        (HookTables::IssueTags, _) => {
            "SELECT i.project_id FROM issues i \
             JOIN issue_tags t ON t.issue_id = i.id WHERE t.id = ?"
        }
        (HookTables::IssueRelationships, _) => {
            "SELECT i.project_id FROM issues i \
             JOIN issue_relationships r ON r.issue_id = i.id WHERE r.id = ?"
        }
        _ => return None,
    };
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}
