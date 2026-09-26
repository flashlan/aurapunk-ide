//! `GET /api/kanban/stream/ws?project_id=` — project-scoped board deltas.
//!
//! Replaces the 30 s fallback poll as the *primary* update path for the web
//! kanban. Protocol (JSON text frames both ways):
//!
//! * client → server `{"subscribe":"<table>","minimal":false}` — registers a
//!   table; the server answers with a full snapshot and may re-send one later.
//! * server → client `{"type":"snapshot","table":…,"rows":[…]}` — replaces the
//!   table's contents.
//! * server → client `{"type":"event","seq":N,"table":…,"op":"upsert",
//!   "id":…,"row":{…}}` / `{"op":"delete","id":…}` — one row change. An upsert
//!   whose row vanished before it could be read degrades to a delete, so the
//!   client can never keep a stale row.
//! * server → client `{"type":"ready","table":…}` — snapshot fully sent.
//!
//! Snapshot-then-drain ordering: the subscription is registered, the snapshot
//! is read from the database, and only then is the buffered broadcast drained,
//! so no change can slip between the two. A lagging receiver (buffer overflow)
//! gets a fresh snapshot for every subscribed table instead of a silent gap —
//! the reset-on-gap idiom already used by the approvals stream.

use std::collections::HashSet;

use axum::{
    extract::{Query, State, ws::Message},
    response::IntoResponse,
    routing::get,
};
use db::models::{
    issue::Issue as DbIssue,
    issue_relationship::IssueRelationship as DbIssueRelationship,
    kanban_tag::{IssueTag as DbIssueTag, KanbanTag},
    project_status::ProjectStatus as DbProjectStatus,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::events::{KanbanEvent, KanbanOp};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

/// Board tables served by this stream. Deliberately excludes
/// `pull_requests` / `pull_request_issues` (TEXT ids, project reachable only
/// through a multi-hop join) and `issue_comments` (scoped per issue, not per
/// project) — those keep the plain fallback poll.
const KANBAN_TABLES: [&str; 5] = [
    "issues",
    "project_statuses",
    "tags",
    "issue_tags",
    "issue_relationships",
];

#[derive(Debug, Deserialize)]
pub struct KanbanStreamQuery {
    pub project_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct ClientMsg {
    subscribe: String,
    /// Ask for the lean issue projection (no `description` /
    /// `extension_metadata`) — mirrors `?minimal=1` on the fallback read.
    #[serde(default)]
    minimal: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMsg {
    Snapshot {
        table: String,
        rows: Vec<Value>,
    },
    Event {
        seq: u64,
        table: String,
        op: KanbanOp,
        id: Uuid,
        #[serde(skip_serializing_if = "Option::is_none")]
        row: Option<Value>,
    },
    Ready {
        table: String,
    },
}

pub async fn stream_kanban_ws(
    ws: SignedWsUpgrade,
    Query(query): Query<KanbanStreamQuery>,
    State(deployment): State<DeploymentImpl>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_kanban_ws(socket, deployment, query.project_id).await {
            tracing::warn!("kanban WS closed: {}", e);
        }
    })
}

async fn kanban_snapshot(
    pool: &SqlitePool,
    table: &str,
    project_id: Uuid,
    minimal: bool,
) -> anyhow::Result<Vec<Value>> {
    fn to_values<T: Serialize>(rows: Vec<T>) -> Vec<Value> {
        rows.into_iter()
            .filter_map(|row| serde_json::to_value(row).ok())
            .collect()
    }

    let rows: Vec<Value> = match table {
        "issues" => to_values(DbIssue::list_by_project(pool, project_id).await?),
        "project_statuses" => to_values(DbProjectStatus::list_by_project(pool, project_id).await?),
        "tags" => to_values(KanbanTag::list_by_project(pool, project_id).await?),
        "issue_tags" => to_values(DbIssueTag::list_by_project(pool, project_id).await?),
        "issue_relationships" => {
            to_values(DbIssueRelationship::list_by_project(pool, project_id).await?)
        }
        _ => Vec::new(),
    };

    if minimal {
        Ok(rows.into_iter().map(minimal_issue_row).collect())
    } else {
        Ok(rows)
    }
}

/// Drop the two free-text columns. Only `issues` has them; the shape check
/// keeps a mis-scoped call from stripping some other table's fields.
fn minimal_issue_row(mut row: Value) -> Value {
    if let Some(obj) = row.as_object_mut()
        && obj.contains_key("title")
        && obj.contains_key("status_id")
    {
        obj.remove("description");
        obj.remove("extension_metadata");
    }
    row
}

/// Row for a single id. Reuses the typed `list_by_project` queries rather than
/// adding a fresh `query_as!` (which would require re-preparing offline sqlx
/// data); board edits are human-scale, so one indexed read per change is
/// cheaper than the machinery it would take to avoid it.
async fn kanban_row(
    pool: &SqlitePool,
    table: &str,
    project_id: Option<Uuid>,
    id: Uuid,
    minimal: bool,
) -> Option<Value> {
    let project_id = project_id?;
    let rows = kanban_snapshot(pool, table, project_id, minimal)
        .await
        .ok()?;
    let id_text = id.to_string();
    rows.into_iter()
        .find(|row| row.get("id").and_then(Value::as_str) == Some(id_text.as_str()))
}

async fn send_msg(socket: &mut MaybeSignedWebSocket, msg: &ServerMsg) -> anyhow::Result<()> {
    let text = serde_json::to_string(msg)?;
    socket.send(Message::Text(text.into())).await?;
    Ok(())
}

async fn send_snapshot(
    socket: &mut MaybeSignedWebSocket,
    pool: &SqlitePool,
    table: &str,
    project_id: Uuid,
    minimal: bool,
) -> anyhow::Result<()> {
    let rows = kanban_snapshot(pool, table, project_id, minimal).await?;
    send_msg(
        socket,
        &ServerMsg::Snapshot {
            table: table.to_string(),
            rows,
        },
    )
    .await?;
    send_msg(
        socket,
        &ServerMsg::Ready {
            table: table.to_string(),
        },
    )
    .await?;
    Ok(())
}

/// True when a change belongs to this subscriber's project. `project_id =
/// None` marks fan-out tombstones recorded by the preupdate hook, which could
/// not resolve a project after the row was gone — they go to everyone and a
/// subscriber ignores ids it doesn't hold.
fn in_project(event: &KanbanEvent, project_id: Uuid) -> bool {
    event.project_id.is_none() || event.project_id == Some(project_id)
}

/// Forward one change to every subscription of its table, resolving the row
/// once per distinct projection so a full and a minimal subscriber on the same
/// socket each get the shape they asked for.
async fn forward_event(
    socket: &mut MaybeSignedWebSocket,
    pool: &SqlitePool,
    project_id: Uuid,
    subscriptions: &HashSet<(String, bool)>,
    event: &KanbanEvent,
) -> anyhow::Result<()> {
    if !in_project(event, project_id) {
        return Ok(());
    }

    let mut sent: Vec<bool> = Vec::new();
    for (table, minimal) in subscriptions {
        if table != event.table || sent.contains(minimal) {
            continue;
        }
        sent.push(*minimal);

        let (op, row) = match event.op {
            KanbanOp::Delete => (KanbanOp::Delete, None),
            KanbanOp::Upsert => {
                match kanban_row(pool, event.table, event.project_id, event.id, *minimal).await {
                    Some(row) => (KanbanOp::Upsert, Some(row)),
                    // The row vanished between the write and the read (or its
                    // project resolved to another board): degrade to a delete
                    // rather than leaving a stale row client-side.
                    None => (KanbanOp::Delete, None),
                }
            }
        };

        send_msg(
            socket,
            &ServerMsg::Event {
                seq: event.seq,
                table: event.table.to_string(),
                op,
                id: event.id,
                row,
            },
        )
        .await?;
    }
    Ok(())
}

async fn handle_kanban_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    project_id: Uuid,
) -> anyhow::Result<()> {
    let pool = deployment.db().pool.clone();
    let mut receiver = deployment.events().kanban().subscribe();

    let mut subscriptions: HashSet<(String, bool)> = HashSet::new();

    loop {
        tokio::select! {
            event = receiver.recv() => {
                match event {
                    Ok(event) => {
                        forward_event(&mut socket, &pool, project_id, &subscriptions, &event)
                            .await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        // Reset-on-gap: resend a full snapshot per subscribed
                        // table rather than leaving the client permanently
                        // missing the `n` dropped changes.
                        tracing::debug!("kanban WS lagged by {n}; resending snapshots");
                        let tables: Vec<(String, bool)> =
                            subscriptions.iter().cloned().collect();
                        for (table, minimal) in tables {
                            send_snapshot(&mut socket, &pool, &table, project_id, minimal)
                                .await?;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Text(text))) => {
                        let Ok(msg) = serde_json::from_str::<ClientMsg>(text.as_str()) else {
                            continue;
                        };
                        if !KANBAN_TABLES.contains(&msg.subscribe.as_str()) {
                            continue;
                        }
                        // Register BEFORE reading the snapshot so any change
                        // committed during the read is buffered and drained
                        // right after — never lost between the two.
                        subscriptions.insert((msg.subscribe.clone(), msg.minimal));
                        send_snapshot(
                            &mut socket,
                            &pool,
                            &msg.subscribe,
                            project_id,
                            msg.minimal,
                        ).await?;
                        while let Ok(event) = receiver.try_recv() {
                            forward_event(
                                &mut socket,
                                &pool,
                                project_id,
                                &subscriptions,
                                &event,
                            ).await?;
                        }
                    }
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!("kanban WS receive error: {error}");
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

pub(super) fn router() -> axum::Router<DeploymentImpl> {
    axum::Router::new().route("/kanban/stream/ws", get(stream_kanban_ws))
}
