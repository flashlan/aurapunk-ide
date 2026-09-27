//! Board puller (ADR-049 Desktop rollout).
//!
//! The publisher (`routes::cloud_sync`) sends local changes to AuraPunk Cloud;
//! this loop brings the board edits made elsewhere (another Desktop, a Cloud
//! instance, the phone) back into the local database. It follows the Cloud
//! log from `cloud_sync_state.pull_revision` (bootstrapping from a paged
//! snapshot the first time or after a `reset`) and applies project, status,
//! issue and issue↔workspace records with change capture suppressed, so they
//! are not published straight back.
//!
//! Rules:
//! - an entity with unpublished local changes is left alone: its pending
//!   write carries a base revision and resolves the conflict when it is sent;
//! - a remote record equal to the local row only updates the known revision
//!   (this instance's own writes come back as events);
//! - issues keep the newer of the local and remote row (`updated_at`);
//! - links to workspaces that live on another instance are not materialized;
//! - remote deletions of issues, statuses and links are applied; a project
//!   deletion is only logged, since it would cascade over the whole board.

use std::time::Duration;

use db::models::{
    cloud_sync::{CloudSyncOutbox, OutboxEntry},
    issue::Issue,
    project::Project,
    workspace::Workspace,
};
use deployment::Deployment;
use serde::Deserialize;
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    cloud_sync::{
        BOARD_ENTITY_TYPES, CloudSyncAccount, RemoteConflict, account_changed, build_operation,
        linked_account,
    },
    mobile_sync::{CloudImportRecord, import_cloud_records},
};
use crate::DeploymentImpl;

const PULL_WAIT_MS: u64 = 25_000;
const EVENT_LIMIT: usize = 200;
const SNAPSHOT_PAGE: usize = 500;
const MAX_BACKOFF: Duration = Duration::from_secs(120);

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullResponse {
    #[serde(default)]
    events: Vec<RemoteEvent>,
    #[serde(default)]
    revision: i64,
    #[serde(default)]
    reset: bool,
    #[serde(default)]
    next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEvent {
    entity_type: String,
    entity_id: String,
    operation: String,
    #[serde(default)]
    payload: Value,
    #[serde(default)]
    revision: i64,
}

pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_millis(PULL_WAIT_MS + 15_000))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                tracing::error!(%error, "board puller disabled: no HTTP client");
                return;
            }
        };
        let mut backoff = Duration::from_secs(2);
        loop {
            let Some(account) = linked_account() else {
                tokio::select! {
                    _ = account_changed().notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                }
                continue;
            };
            let pool = deployment.db().pool.clone();
            match pull_once(&pool, &client, &account).await {
                Ok(()) => backoff = Duration::from_secs(2),
                Err(error) => {
                    tracing::warn!(error = %error, "board pull failed; retrying");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    });
}

fn endpoint(account: &CloudSyncAccount, path_and_query: &str) -> String {
    format!(
        "{}{path_and_query}",
        account.cloud_url.trim_end_matches('/')
    )
}

async fn get(
    client: &reqwest::Client,
    account: &CloudSyncAccount,
    path_and_query: &str,
) -> anyhow::Result<PullResponse> {
    let response = client
        .get(endpoint(account, path_and_query))
        .bearer_auth(&account.access_token)
        .send()
        .await?;
    let code = response.status();
    if !code.is_success() {
        let body: String = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        anyhow::bail!("Cloud pull returned HTTP {code}: {body}");
    }
    Ok(response.json().await?)
}

async fn pull_once(
    pool: &SqlitePool,
    client: &reqwest::Client,
    account: &CloudSyncAccount,
) -> anyhow::Result<()> {
    // Publishing is enabled (and bootstrapped) by the publisher; wait for it
    // so the first snapshot is compared against a captured local board.
    if !CloudSyncOutbox::is_enabled(pool).await? {
        tokio::time::sleep(Duration::from_secs(2)).await;
        return Ok(());
    }
    let revision = CloudSyncOutbox::pull_revision(pool).await?;
    if revision == 0 {
        return bootstrap(pool, client, account).await;
    }
    let pull = get(
        client,
        account,
        &format!("/api/sync?after_revision={revision}&limit={EVENT_LIMIT}&wait_ms={PULL_WAIT_MS}"),
    )
    .await?;
    if pull.reset {
        tracing::info!("cloud log pruned past the board cursor; re-snapshotting");
        CloudSyncOutbox::set_pull_revision(pool, 0).await?;
        return Ok(());
    }
    let next = pull
        .events
        .iter()
        .map(|event| event.revision)
        .max()
        .unwrap_or(revision)
        .max(revision);
    apply_remote(pool, pull.events).await?;
    CloudSyncOutbox::set_pull_revision(pool, next).await?;
    Ok(())
}

/// Page through the Cloud snapshot, apply the board records, then follow the
/// log from the revision observed before the first page.
async fn bootstrap(
    pool: &SqlitePool,
    client: &reqwest::Client,
    account: &CloudSyncAccount,
) -> anyhow::Result<()> {
    let mut cursor: Option<String> = None;
    let mut head: Option<i64> = None;
    loop {
        let mut path = format!("/api/sync?view=snapshot&page_size={SNAPSHOT_PAGE}");
        if let Some(cursor) = &cursor {
            path.push_str(&format!("&cursor={cursor}"));
        }
        let page = get(client, account, &path).await?;
        head.get_or_insert(page.revision);
        apply_remote(pool, page.events).await?;
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    let head = head.unwrap_or(0);
    if head == 0 {
        // Empty account: nothing to follow yet.
        tokio::time::sleep(Duration::from_secs(30)).await;
        return Ok(());
    }
    CloudSyncOutbox::set_pull_revision(pool, head).await?;
    tracing::info!(
        revision = head,
        "board puller bootstrapped from the Cloud snapshot"
    );
    Ok(())
}

/// `issue_workspace` ids are `<issue>:<workspace>`; others are plain UUIDs.
fn parse_ids(entity_type: &str, entity_id: &str) -> Option<(Uuid, Option<Uuid>)> {
    if entity_type == "issue_workspace" {
        let (issue, workspace) = entity_id.split_once(':')?;
        Some((issue.parse().ok()?, Some(workspace.parse().ok()?)))
    } else {
        Some((entity_id.parse().ok()?, None))
    }
}

/// Local payload of a board entity in the same shape the publisher sends,
/// or `None` when the row does not exist here.
async fn local_payload(
    pool: &SqlitePool,
    entity_type: &str,
    id: Uuid,
    aux: Option<Uuid>,
) -> anyhow::Result<Option<Value>> {
    let entry = OutboxEntry {
        seq: 0,
        entity_type: entity_type.to_string(),
        entity_id: id,
        aux_id: aux,
        operation: "upsert".to_string(),
    };
    Ok(build_operation(pool, &entry)
        .await?
        .map(|operation| operation.payload)
        .filter(|payload| !payload.is_null()))
}

/// Whether a remote link can be materialized: both ends must exist here.
async fn link_is_local(
    pool: &SqlitePool,
    issue_id: Uuid,
    workspace_id: Uuid,
) -> anyhow::Result<bool> {
    Ok(Issue::find_by_id(pool, issue_id).await?.is_some()
        && Workspace::find_by_id(pool, workspace_id).await?.is_some())
}

async fn apply_remote(pool: &SqlitePool, events: Vec<RemoteEvent>) -> anyhow::Result<()> {
    // Only the last change per entity matters.
    let mut latest: Vec<RemoteEvent> = Vec::new();
    for event in events {
        if !BOARD_ENTITY_TYPES.contains(&event.entity_type.as_str()) {
            continue;
        }
        latest.retain(|kept| {
            !(kept.entity_type == event.entity_type && kept.entity_id == event.entity_id)
        });
        latest.push(event);
    }

    let mut imports = Vec::new();
    let mut revisions = Vec::new();
    for event in latest {
        let Some((id, aux)) = parse_ids(&event.entity_type, &event.entity_id) else {
            continue;
        };
        if CloudSyncOutbox::has_pending(pool, &event.entity_type, id, aux).await? {
            continue;
        }
        if event.operation == "delete" {
            apply_delete(pool, &event.entity_type, id, aux).await?;
            CloudSyncOutbox::forget_remote(pool, &event.entity_type, &event.entity_id).await?;
            continue;
        }
        if local_payload(pool, &event.entity_type, id, aux)
            .await?
            .is_some_and(|local| same_json(&local, &event.payload))
        {
            revisions.push((event.entity_type, event.entity_id, event.revision));
            continue;
        }
        if let Some(workspace_id) = aux
            && !link_is_local(pool, id, workspace_id).await?
        {
            continue;
        }
        revisions.push((
            event.entity_type.clone(),
            event.entity_id.clone(),
            event.revision,
        ));
        imports.push(CloudImportRecord {
            entity_type: event.entity_type,
            entity_id: event.entity_id,
            operation: "upsert".to_string(),
            payload: event.payload,
        });
    }

    if !imports.is_empty() {
        let count = imports.len();
        import_cloud_records(pool, imports)
            .await
            .map_err(|error| anyhow::anyhow!("applying Cloud board records: {error:?}"))?;
        tracing::info!(count, "applied board changes from the Cloud");
    }
    for (entity_type, entity_id, revision) in revisions {
        if revision > 0 {
            CloudSyncOutbox::record_remote_revision(pool, &entity_type, &entity_id, revision)
                .await?;
        }
    }
    Ok(())
}

async fn apply_delete(
    pool: &SqlitePool,
    entity_type: &str,
    id: Uuid,
    aux: Option<Uuid>,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    let capture = CloudSyncOutbox::suppress_capture(&mut tx).await?;
    match (entity_type, aux) {
        ("issue", _) => {
            sqlx::query("DELETE FROM issues WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        // A column still holding cards here is kept; the cards' own events
        // move or delete them first.
        ("status", _) => {
            sqlx::query(
                "DELETE FROM project_statuses WHERE id = $1
                 AND NOT EXISTS (SELECT 1 FROM issues WHERE status_id = $1)",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        ("issue_workspace", Some(workspace_id)) => {
            sqlx::query("DELETE FROM issue_workspaces WHERE issue_id = $1 AND workspace_id = $2")
                .bind(id)
                .bind(workspace_id)
                .execute(&mut *tx)
                .await?;
        }
        ("project", _) => {
            tracing::warn!(project_id = %id, "project deleted remotely; not applied locally");
        }
        _ => {}
    }
    CloudSyncOutbox::restore_capture(&mut tx, capture).await?;
    tx.commit().await?;
    Ok(())
}

/// JSON equality where numbers compare by value: the Cloud is JavaScript and
/// re-serializes `1.0` as `1`, which would otherwise make every issue (its
/// `sort_order` is a float) look changed and be rewritten on every event.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same_json(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.get(key).is_some_and(|other| same_json(value, other)))
        }
        _ => a == b,
    }
}

fn remote_timestamp(payload: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    payload
        .get("updated_at")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Utc))
}

/// Whether the remote record of a conflict is newer than the local row.
/// Issues and projects compare `updated_at`; statuses and links carry no edit
/// time, so the Cloud's copy wins.
async fn remote_is_newer(
    pool: &SqlitePool,
    conflict: &RemoteConflict,
    id: Uuid,
) -> anyhow::Result<bool> {
    let remote = remote_timestamp(&conflict.payload);
    let local = match conflict.entity_type.as_str() {
        "issue" => Issue::find_by_id(pool, id)
            .await?
            .map(|issue| issue.updated_at),
        "project" => Project::find_by_id(pool, id)
            .await?
            .map(|project| project.updated_at),
        _ => return Ok(true),
    };
    Ok(match (local, remote) {
        (Some(local), Some(remote)) => remote > local,
        (None, _) => true,
        (Some(_), None) => false,
    })
}

/// Settle writes the Cloud refused because the record changed since this
/// instance last saw it.
///
/// - Deleted remotely: forget the revision and requeue the local row, which
///   recreates it (a local edit is never silently lost).
/// - Remote newer: apply it here.
/// - Local newer: requeue the local row on top of the remote revision.
pub(crate) async fn resolve_conflicts(
    pool: &SqlitePool,
    conflicts: Vec<RemoteConflict>,
) -> anyhow::Result<()> {
    for conflict in conflicts {
        if !BOARD_ENTITY_TYPES.contains(&conflict.entity_type.as_str()) {
            continue;
        }
        let Some((id, aux)) = parse_ids(&conflict.entity_type, &conflict.entity_id) else {
            continue;
        };
        let Some(revision) = conflict.revision else {
            CloudSyncOutbox::forget_remote(pool, &conflict.entity_type, &conflict.entity_id)
                .await?;
            CloudSyncOutbox::enqueue(pool, &conflict.entity_type, id, aux).await?;
            continue;
        };
        CloudSyncOutbox::record_remote_revision(
            pool,
            &conflict.entity_type,
            &conflict.entity_id,
            revision,
        )
        .await?;
        if remote_is_newer(pool, &conflict, id).await? {
            if let Some(workspace_id) = aux
                && !link_is_local(pool, id, workspace_id).await?
            {
                continue;
            }
            tracing::info!(
                entity_type = %conflict.entity_type,
                entity_id = %conflict.entity_id,
                "board conflict: newer remote record applied"
            );
            import_cloud_records(
                pool,
                vec![CloudImportRecord {
                    entity_type: conflict.entity_type,
                    entity_id: conflict.entity_id,
                    operation: "upsert".to_string(),
                    payload: conflict.payload,
                }],
            )
            .await
            .map_err(|error| anyhow::anyhow!("applying conflict record: {error:?}"))?;
        } else {
            tracing::info!(
                entity_type = %conflict.entity_type,
                entity_id = %conflict.entity_id,
                "board conflict: newer local record republished"
            );
            CloudSyncOutbox::enqueue(pool, &conflict.entity_type, id, aux).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_link_ids() {
        let issue = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        assert_eq!(parse_ids("issue", &issue.to_string()), Some((issue, None)));
        assert_eq!(
            parse_ids("issue_workspace", &format!("{issue}:{workspace}")),
            Some((issue, Some(workspace)))
        );
        assert_eq!(parse_ids("issue", "not-a-uuid"), None);
        assert_eq!(parse_ids("issue_workspace", &issue.to_string()), None);
    }

    #[test]
    fn json_numbers_compare_by_value() {
        let local = serde_json::json!({ "sort_order": 1.0, "tags": [2.0], "title": "a" });
        let remote: Value =
            serde_json::from_str(r#"{"title":"a","tags":[2],"sort_order":1}"#).unwrap();
        assert!(same_json(&local, &remote));
        assert!(!same_json(
            &local,
            &serde_json::json!({ "sort_order": 2, "tags": [2], "title": "a" })
        ));
        assert!(!same_json(
            &local,
            &serde_json::json!({ "sort_order": 1, "tags": [2] })
        ));
    }

    #[test]
    fn reads_remote_timestamps() {
        let payload = serde_json::json!({ "updated_at": "2026-09-27T10:00:00.123Z" });
        assert!(remote_timestamp(&payload).is_some());
        assert!(remote_timestamp(&serde_json::json!({})).is_none());
    }
}
