//! Integration queue (ADR-050): "merge when available".
//!
//! When the Integration Guard refuses a merge for a transient reason —
//! another integration running for the repository, or another workspace's
//! active agent work overlapping the branch — the agent's request is queued
//! with the commit it verified, instead of holding the agent inside the tool
//! call and then failing with nothing retrying later. A backend worker
//! integrates queued requests as soon as the blocker clears and posts the
//! outcome into the workspace's agent session, so the agent can finish the
//! card (`complete` mode) or keep going.
//!
//! A request is integrated only while the branch still points at the queued
//! commit: new commits after the request were not part of what the agent
//! verified, so the request is superseded and the agent is asked to re-run.

use std::{str::FromStr, sync::OnceLock, time::Duration};

use axum::{
    Extension, Json,
    extract::{Query, State},
    response::Json as ResponseJson,
};
use db::models::{
    agent_work::AgentWorkDeclaration,
    execution_process::ExecutionProcess,
    integration_queue::IntegrationRequest,
    repo::Repo,
    scratch::{DraftFollowUpData, Scratch, ScratchPayload, ScratchType},
    session::Session,
    workspace::Workspace,
};
use deployment::Deployment;
use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use utils::response::ApiResponse;
use uuid::Uuid;

use super::git::{GitOperationError, MergeWorkspaceRequest, merge_workspace};
use crate::{DeploymentImpl, error::ApiError};

/// Blockers that clear by themselves when the other actor finishes.
const TRANSIENT_BLOCKERS: [&str; 2] = ["integration_in_progress", "agent_work_conflict"];
/// Fallback retry cadence; enqueues and finished merges wake the worker.
const RETRY_INTERVAL: Duration = Duration::from_secs(10);

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

#[derive(Debug, Deserialize)]
pub struct EnqueueMergeRequest {
    pub repo_id: Uuid,
    /// `merge` (keep the workspace open) or `complete` (the agent finishes
    /// the card afterwards).
    pub mode: String,
    /// The blocker that made the caller queue, for the status view.
    #[serde(default)]
    pub blocker: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MergeQueueStatus {
    pub request: Option<IntegrationRequest>,
    /// 1-based position among queued requests for the repository.
    pub position: Option<i64>,
    /// Current commit of the workspace branch.
    pub current_head: String,
    /// The latest request merged exactly the current branch head, so the
    /// branch is already integrated and must not be merged again.
    pub integrated_head: bool,
}

async fn status_for(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    repo_id: Uuid,
) -> Result<MergeQueueStatus, ApiError> {
    let pool = &deployment.db().pool;
    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("repository not found".into()))?;
    let current_head = deployment
        .git()
        .get_branch_oid(&repo.path, &workspace.branch)?;
    let request = IntegrationRequest::latest(pool, workspace.id, repo_id).await?;
    let position = match &request {
        Some(request) if request.status == "queued" => {
            Some(IntegrationRequest::position(pool, request).await?)
        }
        _ => None,
    };
    let integrated_head = request
        .as_ref()
        .is_some_and(|request| request.integrated(&current_head));
    Ok(MergeQueueStatus {
        request,
        position,
        current_head,
        integrated_head,
    })
}

/// `POST /api/workspaces/{id}/git/merge-queue`: queue the branch's current
/// commit for integration.
pub async fn enqueue(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<EnqueueMergeRequest>,
) -> Result<ResponseJson<ApiResponse<MergeQueueStatus>>, ApiError> {
    if !matches!(request.mode.as_str(), "merge" | "complete") {
        return Err(ApiError::BadRequest(
            "mode must be `merge` or `complete`".into(),
        ));
    }
    let pool = &deployment.db().pool;
    let repo = Repo::find_by_id(pool, request.repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("repository not found".into()))?;
    let head = deployment
        .git()
        .get_branch_oid(&repo.path, &workspace.branch)?;
    IntegrationRequest::enqueue(
        pool,
        workspace.id,
        request.repo_id,
        &head,
        &request.mode,
        request.blocker.as_deref(),
    )
    .await?;
    wake().notify_one();
    Ok(ResponseJson(ApiResponse::success(
        status_for(&deployment, &workspace, request.repo_id).await?,
    )))
}

#[derive(Debug, Deserialize)]
pub struct MergeQueueQuery {
    pub repo_id: Uuid,
}

/// `GET /api/workspaces/{id}/git/merge-queue?repo_id=`.
pub async fn status(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<MergeQueueQuery>,
) -> Result<ResponseJson<ApiResponse<MergeQueueStatus>>, ApiError> {
    Ok(ResponseJson(ApiResponse::success(
        status_for(&deployment, &workspace, query.repo_id).await?,
    )))
}

/// Start the worker. Safe to call once per process.
pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = drain(&deployment).await {
                tracing::warn!(error = %error, "integration queue pass failed");
            }
            tokio::select! {
                _ = wake().notified() => {}
                _ = tokio::time::sleep(RETRY_INTERVAL) => {}
            }
        }
    });
}

async fn drain(deployment: &DeploymentImpl) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    // Renew reservations whose agent is still resolving, release archived
    // ones, before deciding which queued merges they hold back.
    AgentWorkDeclaration::maintain_conflict_reservations(pool).await?;
    for request in IntegrationRequest::queued(pool).await? {
        if let Err(error) = attempt(deployment, &request).await {
            tracing::warn!(request_id = %request.id, error = %error, "queued integration attempt failed");
        }
    }
    Ok(())
}

fn short(sha: &str) -> &str {
    sha.get(..8).unwrap_or(sha)
}

fn blocker_type(error: &GitOperationError) -> &'static str {
    match error {
        GitOperationError::MergeConflicts { .. } => "merge_conflicts",
        GitOperationError::RebaseInProgress => "rebase_in_progress",
        GitOperationError::AgentWorkConflict { .. } => "agent_work_conflict",
        GitOperationError::DirtyWorktree { .. } => "dirty_worktree",
        GitOperationError::IntegrationInProgress { .. } => "integration_in_progress",
        GitOperationError::BranchMoved { .. } => "branch_moved",
    }
}

async fn attempt(deployment: &DeploymentImpl, request: &IntegrationRequest) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    let Some(workspace) = Workspace::find_by_id(pool, request.workspace_id).await? else {
        IntegrationRequest::finish(pool, request.id, "failed", None, Some("workspace deleted"))
            .await?;
        return Ok(());
    };
    let Some(repo) = Repo::find_by_id(pool, request.repo_id).await? else {
        IntegrationRequest::finish(pool, request.id, "failed", None, Some("repository removed"))
            .await?;
        return Ok(());
    };

    let head = deployment
        .git()
        .get_branch_oid(&repo.path, &workspace.branch)?;
    if head != request.commit_sha {
        IntegrationRequest::finish(pool, request.id, "superseded", Some("branch_moved"), None)
            .await?;
        let reason = format!("the branch moved to {}", short(&head));
        notify_agent(
            deployment,
            &workspace,
            superseded_message(&workspace, request, &reason),
        )
        .await;
        return Ok(());
    }

    let response = match merge_workspace(
        Extension(workspace.clone()),
        State(deployment.clone()),
        Json(MergeWorkspaceRequest {
            repo_id: request.repo_id,
            // Completion moves the card itself after the Mem0 summary.
            suppress_auto_move: Some(true),
            keep_workspace_open: Some(request.mode == "merge"),
            // Re-checked under the lease: the merge may wait for it.
            expected_head: Some(request.commit_sha.clone()),
        }),
    )
    .await
    {
        Ok(ResponseJson(response)) => response,
        Err(error) => {
            let message = api_error_message(&error);
            IntegrationRequest::finish(pool, request.id, "failed", None, Some(&message)).await?;
            notify_agent(
                deployment,
                &workspace,
                format!(
                    "Integration Guard: the queued merge of `{}` failed: {message}. The card was NOT merged and \
NOT moved. Resolve the problem, then call `{}` again.",
                    workspace.branch,
                    tool_for(&request.mode),
                ),
            )
            .await;
            return Ok(());
        }
    };

    if response.is_success() {
        // The squash leaves the branch at the merge commit; remember it so the
        // agent's follow-up completion sees the branch as integrated.
        let result_sha = deployment
            .git()
            .get_branch_oid(&repo.path, &workspace.branch)
            .unwrap_or_else(|_| request.commit_sha.clone());
        IntegrationRequest::merged(pool, request.id, &result_sha).await?;
        tracing::info!(workspace_id = %workspace.id, commit = %short(&request.commit_sha), "queued integration merged");
        let message = if request.mode == "complete" {
            format!(
                "Integration Guard: your queued merge of `{}` ({}) into its target branch SUCCEEDED. The card is \
NOT closed yet. Call `complete_workspace_card` again now with the same memory_summary to save the Mem0 summary \
and move the card to Done — the merge is already done and will not run twice.",
                workspace.branch,
                short(&request.commit_sha),
            )
        } else {
            format!(
                "Integration Guard: your queued merge of `{}` ({}) into its target branch SUCCEEDED. The workspace \
stays open; continue with the next step.",
                workspace.branch,
                short(&request.commit_sha),
            )
        };
        notify_agent(deployment, &workspace, message).await;
        // A finished integration releases the repository lease: let the next
        // queued request try right away.
        wake().notify_one();
        return Ok(());
    }

    let message = response.message().unwrap_or("merge refused").to_string();
    let blocker = serde_json::to_value(&response)
        .ok()
        .and_then(|value| value.get("error_data").cloned())
        .and_then(|data| serde_json::from_value::<GitOperationError>(data).ok());
    let blocker_name = blocker.as_ref().map(blocker_type).unwrap_or("unknown");
    if blocker_name == "branch_moved" {
        IntegrationRequest::finish(
            pool,
            request.id,
            "superseded",
            Some(blocker_name),
            Some(&message),
        )
        .await?;
        notify_agent(
            deployment,
            &workspace,
            superseded_message(&workspace, request, &message),
        )
        .await;
        return Ok(());
    }
    if TRANSIENT_BLOCKERS.contains(&blocker_name) {
        IntegrationRequest::still_blocked(pool, request.id, blocker_name, Some(&message)).await?;
        tracing::info!(
            request_id = %request.id,
            blocker = blocker_name,
            "queued integration still blocked"
        );
        return Ok(());
    }

    IntegrationRequest::finish(
        pool,
        request.id,
        "failed",
        Some(blocker_name),
        Some(&message),
    )
    .await?;
    let detail = blocker
        .as_ref()
        .and_then(|blocker| serde_json::to_string_pretty(blocker).ok())
        .unwrap_or_default();
    notify_agent(
        deployment,
        &workspace,
        format!(
            "Integration Guard: the queued merge of `{branch}` could not be integrated ({blocker_name}): {message}\n\
The card was NOT merged and NOT moved. Resolve it in this workspace (for conflicts: rebase or merge the \
target, fix the conflict markers, commit), verify, then call `{tool}` again.\nDetail: {detail}",
            branch = workspace.branch,
            tool = tool_for(&request.mode),
        ),
    )
    .await;
    Ok(())
}

fn superseded_message(workspace: &Workspace, request: &IntegrationRequest, reason: &str) -> String {
    format!(
        "Integration Guard: the queued merge of `{branch}` at {queued} was cancelled: {reason}. New commits \
after the request were not part of what you verified, so they were not integrated. The card was NOT merged and \
NOT moved. When the branch is ready, commit, verify and call `{tool}` again.",
        branch = workspace.branch,
        queued = short(&request.commit_sha),
        tool = tool_for(&request.mode),
    )
}

fn tool_for(mode: &str) -> &'static str {
    if mode == "complete" {
        "complete_workspace_card"
    } else {
        "merge_workspace"
    }
}

fn api_error_message(error: &ApiError) -> String {
    format!("{error:?}").chars().take(500).collect()
}

/// Executor for a follow-up in this workspace: its saved chat configuration,
/// else the latest session's executor.
async fn follow_up_executor(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    session: &Session,
) -> Option<ExecutorConfig> {
    let pool = &deployment.db().pool;
    let chat_config = Scratch::find_by_id(pool, workspace.id, &ScratchType::WorkspaceChatConfig)
        .await
        .ok()
        .flatten()
        .and_then(|scratch| match scratch.payload {
            ScratchPayload::WorkspaceChatConfig(config) => Some(config),
            _ => None,
        })
        .unwrap_or_default();
    let raw = chat_config.executor.clone().or(session.executor.clone())?;
    let executor = BaseCodingAgent::from_str(&raw.replace('-', "_").to_ascii_uppercase()).ok()?;
    Some(ExecutorConfig {
        executor,
        variant: chat_config.preset.clone(),
        model_id: chat_config.model_id.clone(),
        agent_id: chat_config.agent_id.clone(),
        reasoning_id: chat_config.reasoning_id.clone(),
        permission_policy: None,
    })
}

/// Deliver `message` to the workspace's agent: queued behind a running turn,
/// or started as a follow-up when the session is idle.
async fn notify_agent(deployment: &DeploymentImpl, workspace: &Workspace, message: String) {
    let pool = &deployment.db().pool;
    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await {
        Ok(Some(session)) => session,
        _ => {
            tracing::warn!(workspace_id = %workspace.id, "no session to notify about the queued integration");
            return;
        }
    };
    let Some(executor_config) = follow_up_executor(deployment, workspace, &session).await else {
        tracing::warn!(workspace_id = %workspace.id, "no executor to notify about the queued integration");
        return;
    };
    let running = ExecutionProcess::find_latest_running_coding_agent_for_session(pool, session.id)
        .await
        .ok()
        .flatten()
        .is_some();
    if running {
        deployment.queued_message_service().queue_message(
            session.id,
            DraftFollowUpData {
                message,
                executor_config,
            },
        );
        return;
    }
    if let Err(error) = crate::routes::sessions::run_follow_up(
        deployment,
        session,
        workspace.clone(),
        message,
        executor_config,
        None,
        None,
        None,
    )
    .await
    {
        tracing::warn!(workspace_id = %workspace.id, error = ?error, "could not start the integration follow-up");
    }
}
