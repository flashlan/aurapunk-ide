//! Cloud sync publisher (ADR-047 phase 2).
//!
//! Replaces the webview publisher that exported the whole local database on
//! every workspace event. SQLite triggers record which entity changed in
//! `cloud_sync_outbox`; this service drains the queue, builds each payload
//! from the current row (so repeated edits coalesce and deleted rows become
//! tombstones) and pushes only those records to AuraPunk Cloud `/api/sync`.
//! It runs in the backend, so it keeps publishing with no window open, and a
//! newly linked account is bootstrapped once with every entity.

use std::{
    sync::{Mutex, OnceLock},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    response::Json as ResponseJson,
    routing::{get, put},
};
use db::models::{
    cloud_sync::{CloudSyncOutbox, OutboxEntry, coalesce},
    issue::Issue,
    issue_workspace::IssueWorkspace,
    project::Project,
    project_status::ProjectStatus,
    workspace::Workspace,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::Notify;
use utils::{assets::asset_dir, response::ApiResponse};
use uuid::Uuid;

use super::mobile_sync::{
    CHAT_RECORD_SELECT, chat_record_payload, get_kanban_context, issue_record_payload,
    workspace_context_payload,
};
use crate::{DeploymentImpl, error::ApiError};

const ACCOUNT_FILE: &str = "cloud-sync.json";
/// Cloud accepts at most 100 operations per push.
const PUSH_CHUNK: usize = 100;
const DRAIN_BATCH: i64 = 500;
/// Cloud rejects an operation whose payload exceeds 500 KB; a rejected record
/// must never wedge the queue, so larger ones are skipped with a warning.
const MAX_PAYLOAD_BYTES: usize = 450_000;
const IDLE_POLL: Duration = Duration::from_secs(2);
const CATALOG_INTERVAL: Duration = Duration::from_secs(15 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(300);

/// Account the Desktop publishes as, handed over by the UI after sign-in and
/// persisted so publishing resumes after a restart without a window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CloudSyncAccount {
    pub cloud_url: String,
    pub access_token: String,
    pub user_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedState {
    account: Option<CloudSyncAccount>,
    /// Account whose bootstrap (full enqueue) has completed.
    bootstrapped_user_id: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct CloudSyncStatus {
    pub connected: bool,
    pub user_id: Option<String>,
    pub pending: i64,
    pub published_total: u64,
    pub last_success_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_error: Option<String>,
}

fn status() -> &'static Mutex<CloudSyncStatus> {
    static STATUS: OnceLock<Mutex<CloudSyncStatus>> = OnceLock::new();
    STATUS.get_or_init(|| Mutex::new(CloudSyncStatus::default()))
}

/// Notified when the linked account changes, so the command consumer does
/// not wait out its idle sleep after a sign-in.
pub(crate) fn account_changed() -> &'static Notify {
    static CHANGED: OnceLock<Notify> = OnceLock::new();
    CHANGED.get_or_init(Notify::new)
}

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Stable id of this instance; records are published as
/// `desktop:<instance_id>` so the Cloud routes commands back to their owner.
static INSTANCE_ID: OnceLock<String> = OnceLock::new();

fn instance_id() -> &'static str {
    INSTANCE_ID.get().map(String::as_str).unwrap_or("unknown")
}

pub(crate) fn current_instance_id() -> &'static str {
    instance_id()
}

fn state_path() -> std::path::PathBuf {
    asset_dir().join(ACCOUNT_FILE)
}

pub(crate) fn linked_account() -> Option<CloudSyncAccount> {
    load_state().account
}

fn load_state() -> PersistedState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_state(state: &PersistedState) -> std::io::Result<()> {
    let path = state_path();
    let raw = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    std::fs::write(&path, raw)?;
    // The file holds a Cloud device token.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Start the publisher. Safe to call once per process.
pub fn spawn(deployment: DeploymentImpl) {
    let _ = INSTANCE_ID.set(super::instance::describe(&deployment).instance_id);
    super::cloud_commands::spawn(deployment.clone());
    super::cloud_pull::spawn(deployment.clone());
    tokio::spawn(async move {
        let mut backoff = IDLE_POLL;
        let mut last_catalog: Option<std::time::Instant> = None;
        loop {
            match run_once(&deployment, &mut last_catalog).await {
                Ok(()) => backoff = IDLE_POLL,
                Err(error) => {
                    tracing::warn!(error = %error, "cloud sync publish failed; retrying");
                    status().lock().unwrap().last_error = Some(error.to_string());
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
            tokio::select! {
                _ = wake().notified() => {}
                _ = tokio::time::sleep(backoff) => {}
            }
        }
    });
}

async fn run_once(
    deployment: &DeploymentImpl,
    last_catalog: &mut Option<std::time::Instant>,
) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    let mut state = load_state();
    let Some(account) = state.account.clone() else {
        if CloudSyncOutbox::is_enabled(pool).await? {
            CloudSyncOutbox::set_enabled(pool, false).await?;
        }
        return Ok(());
    };

    if state.bootstrapped_user_id.as_deref() != Some(account.user_id.as_str()) {
        // Enable capture before the full enqueue so no write in between is
        // missed; a duplicate entry only coalesces.
        CloudSyncOutbox::set_enabled(pool, true).await?;
        CloudSyncOutbox::enqueue_all(pool).await?;
        state.bootstrapped_user_id = Some(account.user_id.clone());
        save_state(&state)?;
        *last_catalog = None;
        tracing::info!(user_id = %account.user_id, "cloud sync bootstrap enqueued");
    } else if !CloudSyncOutbox::is_enabled(pool).await? {
        CloudSyncOutbox::set_enabled(pool, true).await?;
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    if last_catalog.is_none_or(|at| at.elapsed() >= CATALOG_INTERVAL) {
        let catalog = catalog_operations(deployment).await?;
        push(&client, &account, catalog).await?;
        *last_catalog = Some(std::time::Instant::now());
    }

    loop {
        let entries = CloudSyncOutbox::fetch_batch(pool, DRAIN_BATCH).await?;
        let Some(max_seq) = entries.last().map(|entry| entry.seq) else {
            break;
        };
        let mut operations = Vec::new();
        for entry in coalesce(&entries) {
            if let Some(operation) = build_operation(pool, &entry).await? {
                operations.push(operation);
            }
        }
        with_base_revisions(pool, &mut operations).await?;
        let report = push(&client, &account, operations).await?;
        for applied in &report.applied {
            CloudSyncOutbox::record_remote_revision(
                pool,
                &applied.entity_type,
                &applied.entity_id,
                applied.revision,
            )
            .await?;
        }
        CloudSyncOutbox::acknowledge(pool, max_seq).await?;
        // A conflict either applies the newer remote record here or requeues
        // the local one on top of it; requeued entries drain on the next pass.
        super::cloud_pull::resolve_conflicts(pool, report.conflicts).await?;
    }

    let mut current = status().lock().unwrap();
    current.connected = true;
    current.user_id = Some(account.user_id.clone());
    current.last_error = None;
    Ok(())
}

/// Board entities several instances may edit (ADR-049). Their writes carry
/// the last seen Cloud revision, and the board puller applies remote changes
/// to them; every other entity is single-writer (owned by one instance).
pub(crate) const BOARD_ENTITY_TYPES: [&str; 4] = ["project", "status", "issue", "issue_workspace"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudOperation {
    pub(crate) entity_type: String,
    pub(crate) entity_id: String,
    operation: &'static str,
    pub(crate) payload: Value,
    /// Cloud revision this instance last saw for the record (ADR-049).
    #[serde(skip_serializing_if = "Option::is_none")]
    base_revision: Option<i64>,
}

impl CloudOperation {
    pub(crate) fn upsert(entity_type: &str, entity_id: String, payload: Value) -> Self {
        Self {
            entity_type: entity_type.to_string(),
            entity_id,
            operation: "upsert",
            payload,
            base_revision: None,
        }
    }

    fn delete(entity_type: &str, entity_id: String) -> Self {
        Self {
            entity_type: entity_type.to_string(),
            entity_id,
            operation: "delete",
            payload: Value::Null,
            base_revision: None,
        }
    }
}

/// What the Cloud reported for a push: the revision each changed record now
/// holds, and the operations refused because the record moved on.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct PushReport {
    #[serde(default)]
    pub(crate) applied: Vec<AppliedRevision>,
    #[serde(default)]
    pub(crate) conflicts: Vec<RemoteConflict>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppliedRevision {
    pub(crate) entity_type: String,
    pub(crate) entity_id: String,
    pub(crate) revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteConflict {
    pub(crate) entity_type: String,
    pub(crate) entity_id: String,
    /// Current revision; `None` when the record was deleted remotely.
    pub(crate) revision: Option<i64>,
    pub(crate) payload: Value,
}

fn to_json(value: impl Serialize) -> anyhow::Result<Value> {
    Ok(serde_json::to_value(value)?)
}

fn api(error: ApiError) -> anyhow::Error {
    anyhow::anyhow!("{error:?}")
}

/// Build the Cloud operation for one outbox entry from the current row. A row
/// that no longer exists is published as a delete.
pub(crate) async fn build_operation(
    pool: &SqlitePool,
    entry: &OutboxEntry,
) -> anyhow::Result<Option<CloudOperation>> {
    let id = entry.entity_id;
    let entity_id = match (entry.entity_type.as_str(), entry.aux_id) {
        ("issue_workspace", Some(workspace_id)) => format!("{id}:{workspace_id}"),
        _ => id.to_string(),
    };
    if entry.operation == "delete" {
        return Ok(Some(CloudOperation::delete(&entry.entity_type, entity_id)));
    }

    let payload: Option<Value> = match entry.entity_type.as_str() {
        "project" => match Project::find_by_id(pool, id).await? {
            Some(project) => Some(to_json(project)?),
            None => None,
        },
        "status" => status_payload(pool, id).await?,
        "issue" => match Issue::find_by_id(pool, id).await? {
            Some(issue) => {
                let linked = IssueWorkspace::find_latest_by_issue(pool, id).await?;
                Some(issue_record_payload(&issue, linked).map_err(api)?)
            }
            None => None,
        },
        "workspace" => match Workspace::find_by_id_with_status(pool, id).await? {
            Some(workspace) => Some(to_json(workspace)?),
            None => None,
        },
        "workspace_context" => match Workspace::find_by_id(pool, id).await? {
            Some(workspace) => Some(
                workspace_context_payload(pool, workspace.id, &workspace.branch)
                    .await
                    .map_err(api)?,
            ),
            None => None,
        },
        "issue_workspace" => match (entry.aux_id, Issue::find_by_id(pool, id).await?) {
            (Some(workspace_id), Some(issue)) => Some(serde_json::json!({
                "issue_id": id,
                "workspace_id": workspace_id,
                "project_id": issue.project_id,
            })),
            _ => None,
        },
        "chat" => {
            let row = sqlx::query(&format!("{CHAT_RECORD_SELECT} AND cat.id = ?"))
                .bind(id)
                .fetch_optional(pool)
                .await?;
            match row {
                Some(row) => Some(chat_record_payload(&row).map_err(api)?),
                None => None,
            }
        }
        other => {
            tracing::warn!(
                entity_type = other,
                "unknown cloud sync outbox entity; skipped"
            );
            return Ok(None);
        }
    };

    Ok(Some(match payload {
        Some(payload) => CloudOperation::upsert(&entry.entity_type, entity_id, payload),
        None => CloudOperation::delete(&entry.entity_type, entity_id),
    }))
}

async fn status_payload(pool: &SqlitePool, id: Uuid) -> anyhow::Result<Option<Value>> {
    let project_id: Option<Uuid> =
        sqlx::query_scalar("SELECT project_id FROM project_statuses WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let status = ProjectStatus::list_by_project(pool, project_id)
        .await?
        .into_iter()
        .find(|status| status.id == id);
    status.map(to_json).transpose()
}

/// Instance descriptor, pipelines and executor/model options: the execution
/// catalog Mobile needs to start a workspace (ADR-042). File-backed, so it is
/// republished periodically; the Cloud drops unchanged records.
async fn catalog_operations(deployment: &DeploymentImpl) -> anyhow::Result<Vec<CloudOperation>> {
    let ResponseJson(response) = get_kanban_context(deployment).await.map_err(api)?;
    let records = response
        .into_data()
        .map(|data| data.records)
        .unwrap_or_default();
    Ok(records
        .into_iter()
        .filter(|record| {
            matches!(
                record.entity_type,
                "instance" | "pipeline" | "executor_options"
            )
        })
        .map(|record| CloudOperation::upsert(record.entity_type, record.entity_id, record.payload))
        .collect())
}

/// Attach the last seen Cloud revision to board writes, so a write based on a
/// stale view becomes a conflict instead of overwriting another instance.
async fn with_base_revisions(
    pool: &SqlitePool,
    operations: &mut [CloudOperation],
) -> anyhow::Result<()> {
    let keys: Vec<(String, String)> = operations
        .iter()
        .filter(|operation| BOARD_ENTITY_TYPES.contains(&operation.entity_type.as_str()))
        .map(|operation| (operation.entity_type.clone(), operation.entity_id.clone()))
        .collect();
    let known = CloudSyncOutbox::remote_revisions(pool, &keys).await?;
    for operation in operations.iter_mut() {
        operation.base_revision = known
            .get(&(operation.entity_type.clone(), operation.entity_id.clone()))
            .copied();
    }
    Ok(())
}

pub(crate) async fn push(
    client: &reqwest::Client,
    account: &CloudSyncAccount,
    operations: Vec<CloudOperation>,
) -> anyhow::Result<PushReport> {
    let mut report = PushReport::default();
    let operations: Vec<CloudOperation> = operations
        .into_iter()
        .filter(|operation| {
            let size = operation.payload.to_string().len();
            if size > MAX_PAYLOAD_BYTES {
                tracing::warn!(
                    entity_type = %operation.entity_type,
                    entity_id = %operation.entity_id,
                    size,
                    "cloud sync record too large; skipped"
                );
                return false;
            }
            true
        })
        .collect();
    for chunk in operations.chunks(PUSH_CHUNK) {
        match push_chunk(client, account, chunk).await? {
            PushOutcome::Accepted(chunk_report) => report.merge(chunk_report),
            // One malformed record must not block everything behind it:
            // retry individually and drop only what the Cloud refuses.
            PushOutcome::Rejected(reason) if chunk.len() > 1 => {
                tracing::warn!(%reason, "cloud sync batch rejected; retrying record by record");
                for operation in chunk {
                    match push_chunk(client, account, std::slice::from_ref(operation)).await? {
                        PushOutcome::Accepted(single) => report.merge(single),
                        PushOutcome::Rejected(reason) => tracing::warn!(
                            entity_type = %operation.entity_type,
                            entity_id = %operation.entity_id,
                            %reason,
                            "cloud sync record rejected; dropped"
                        ),
                    }
                }
            }
            PushOutcome::Rejected(reason) => {
                tracing::warn!(%reason, "cloud sync record rejected; dropped");
            }
        }
        let mut current = status().lock().unwrap();
        current.published_total += chunk.len() as u64;
        current.last_success_at = Some(chrono::Utc::now());
    }
    Ok(report)
}

impl PushReport {
    fn merge(&mut self, other: PushReport) {
        self.applied.extend(other.applied);
        self.conflicts.extend(other.conflicts);
    }
}

enum PushOutcome {
    Accepted(PushReport),
    /// The Cloud refused the content (HTTP 400/413); retrying is pointless.
    Rejected(String),
}

async fn push_chunk(
    client: &reqwest::Client,
    account: &CloudSyncAccount,
    chunk: &[CloudOperation],
) -> anyhow::Result<PushOutcome> {
    if chunk.is_empty() {
        return Ok(PushOutcome::Accepted(PushReport::default()));
    }
    let response = client
        .post(format!(
            "{}/api/sync",
            account.cloud_url.trim_end_matches('/')
        ))
        .bearer_auth(&account.access_token)
        .json(&serde_json::json!({
            "source": format!("desktop:{}", instance_id()),
            "operations": chunk,
        }))
        .send()
        .await?;
    let code = response.status();
    if code.is_success() {
        // Older Cloud deployments answer without `applied`/`conflicts`.
        let report = response.json::<PushReport>().await.unwrap_or_default();
        return Ok(PushOutcome::Accepted(report));
    }
    let body: String = response
        .text()
        .await
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect();
    if code == reqwest::StatusCode::BAD_REQUEST || code == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return Ok(PushOutcome::Rejected(format!("HTTP {code}: {body}")));
    }
    // Auth, rate limit and server errors keep the queue for a later retry.
    anyhow::bail!("Cloud sync returned HTTP {code}: {body}")
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AccountRequest {
    account: Option<CloudSyncAccount>,
}

/// Link (or unlink with `account: null`) the Cloud account this Desktop
/// publishes as. Linking a different account triggers a fresh bootstrap.
async fn put_account(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<AccountRequest>,
) -> Result<ResponseJson<ApiResponse<CloudSyncStatus>>, ApiError> {
    let mut state = load_state();
    if state.account != request.account {
        if request.account.is_none() {
            CloudSyncOutbox::set_enabled(&deployment.db().pool, false).await?;
            state.bootstrapped_user_id = None;
            *status().lock().unwrap() = CloudSyncStatus::default();
        }
        state.account = request.account;
        save_state(&state).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    }
    wake().notify_one();
    account_changed().notify_one();
    get_status(State(deployment)).await
}

async fn get_status(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<CloudSyncStatus>>, ApiError> {
    let pending = CloudSyncOutbox::pending(&deployment.db().pool).await?;
    let linked = load_state().account;
    let mut current = status().lock().unwrap().clone();
    current.pending = pending;
    current.connected = current.connected && linked.is_some();
    current.user_id = linked.map(|account| account.user_id);
    Ok(ResponseJson(ApiResponse::success(current)))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/cloud-sync/account", put(put_account))
        .route("/cloud-sync/status", get(get_status))
}
