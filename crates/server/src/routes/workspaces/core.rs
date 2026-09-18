use std::collections::HashSet;

use api_types::pipeline::{ResolvedPipelineResponse, ResolvedPipelineStage};
use axum::{
    Extension, Json,
    extract::{Query, State},
    http::StatusCode,
    response::Json as ResponseJson,
};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    issue::Issue,
    issue_workspace::IssueWorkspace,
    session::Session,
    workspace::{Workspace, WorkspaceError},
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::{
    container::ContainerService,
    pipelines::{self as pl, Pipeline},
};
use sqlx::Error as SqlxError;
use utils::{path::pipelines_dir, response::ApiResponse};
use workspace_manager::WorkspaceManager;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize)]
pub struct DeleteWorkspaceQuery {
    #[serde(default)]
    pub delete_branches: bool,
}

pub async fn get_workspaces(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<Workspace>>>, ApiError> {
    let pool = &deployment.db().pool;
    let workspaces = Workspace::fetch_all(pool).await?;
    Ok(ResponseJson(ApiResponse::success(workspaces)))
}

pub async fn get_workspace(
    Extension(workspace): Extension<Workspace>,
) -> Result<ResponseJson<ApiResponse<Workspace>>, ApiError> {
    Ok(ResponseJson(ApiResponse::success(workspace)))
}

/// Default chat config do workspace (salva pelo app/Mobile): o frontend usa
/// como padrão do seletor quando o usuário não escolheu nada.
pub async fn get_chat_config(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<db::models::scratch::WorkspaceChatConfigData>>, ApiError> {
    let config =
        crate::routes::mobile_sync::read_chat_config(&deployment.db().pool, workspace.id).await?;
    Ok(ResponseJson(ApiResponse::success(config)))
}

/// Open (creating if needed) a persistent workspace-level tmux session in the
/// user's configured terminal emulator, so the workspace's working directory
/// pops up in a real terminal window.
pub async fn open_terminal(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    deployment
        .container()
        .open_workspace_terminal(&workspace)
        .await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

pub async fn update_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<db::models::requests::UpdateWorkspace>,
) -> Result<ResponseJson<ApiResponse<Workspace>>, ApiError> {
    let pool = &deployment.db().pool;
    let is_archiving = request.archived == Some(true) && !workspace.archived;

    Workspace::update(
        pool,
        workspace.id,
        request.archived,
        request.pinned,
        request.name.as_deref(),
    )
    .await?;
    let updated = Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or(WorkspaceError::WorkspaceNotFound)?;

    if is_archiving && let Err(e) = deployment.container().archive_workspace(workspace.id).await {
        tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
    }

    Ok(ResponseJson(ApiResponse::success(updated)))
}

pub async fn get_first_user_message(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Option<String>>>, ApiError> {
    let pool = &deployment.db().pool;
    let message = Workspace::get_first_user_message(pool, workspace.id).await?;
    Ok(ResponseJson(ApiResponse::success(message)))
}

pub async fn delete_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<DeleteWorkspaceQuery>,
) -> Result<(StatusCode, ResponseJson<ApiResponse<()>>), ApiError> {
    let pool = &deployment.db().pool;
    let workspace_manager = deployment.workspace_manager();
    let workspace_id = workspace.id;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace_id)
        .await?
    {
        return Err(ApiError::Conflict(
            "Cannot delete workspace while processes are running. Stop all processes first."
                .to_string(),
        ));
    }

    let dev_servers =
        ExecutionProcess::find_running_dev_servers_by_workspace(pool, workspace_id).await?;

    for dev_server in dev_servers {
        tracing::info!(
            "Stopping dev server {} before deleting workspace {}",
            dev_server.id,
            workspace_id
        );

        if let Err(e) = deployment
            .container()
            .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::error!(
                "Failed to stop dev server {} for workspace {}: {}",
                dev_server.id,
                workspace_id,
                e
            );
        }
    }

    let managed_workspace = workspace_manager.load_managed_workspace(workspace).await?;
    let deletion_context = managed_workspace.prepare_deletion_context().await?;
    let rows_affected = managed_workspace.delete_record().await?;

    if rows_affected == 0 {
        return Err(ApiError::Database(SqlxError::RowNotFound));
    }

    WorkspaceManager::spawn_workspace_deletion_cleanup(deletion_context, query.delete_branches);

    Ok((StatusCode::ACCEPTED, ResponseJson(ApiResponse::success(()))))
}

#[axum::debug_handler]
pub async fn mark_seen(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;
    CodingAgentTurn::mark_seen_by_workspace_id(pool, workspace.id).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

/// How many follow-up messages the user queued while the workspace's current
/// execution was still running. A queued message is user-requested work that
/// has not executed yet, so the card must not be promoted to its terminal
/// (Done) status while one is pending — otherwise the queued turn runs
/// "inside" a finished column. Consumed by the `complete_workspace_card` MCP
/// tool as a pre-merge guard.
#[derive(Debug, Serialize)]
pub struct WorkspaceQueueStatus {
    pub has_queued_messages: bool,
    pub session_ids: Vec<uuid::Uuid>,
}

#[axum::debug_handler]
pub async fn get_queue_status(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<WorkspaceQueueStatus>>, ApiError> {
    let pool = &deployment.db().pool;
    let sessions = Session::find_by_workspace_id(pool, workspace.id).await?;
    let service = deployment.queued_message_service();
    let session_ids: Vec<uuid::Uuid> = sessions
        .into_iter()
        .filter(|session| service.has_queued(session.id))
        .map(|session| session.id)
        .collect();
    Ok(ResponseJson(ApiResponse::success(WorkspaceQueueStatus {
        has_queued_messages: !session_ids.is_empty(),
        session_ids,
    })))
}

#[derive(Debug, Deserialize)]
pub struct ReportPipelineStageRequest {
    /// 1-based stage number, matching the numbered list in the card's
    /// `## Pipeline` block (see `cardPipeline.ts`).
    pub stage: i64,
}

/// Called by the `report_pipeline_stage` MCP tool as the execution agent
/// begins each pipeline stage. This is the reliable counterpart to the
/// log-marker tracker (`services::pipeline_stage`): that one depends on the
/// agent narrating a `VK-PIPELINE-STAGE: N` text line, which some agents
/// silently omit even while doing the actual work. A tool call the agent is
/// explicitly instructed to make doesn't share that failure mode. Both
/// write to the same `current_pipeline_stage` column, so either one keeps
/// the UI's live progress accurate.
#[axum::debug_handler]
pub async fn report_pipeline_stage(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<ReportPipelineStageRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;
    Workspace::set_current_pipeline_stage(pool, workspace.id, Some(request.stage)).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Shape of `issue.extension_metadata.pipeline`, written by the frontend's
/// `CreateIssueDialog`/`PipelineSection` (`buildExtensionMetadata` in
/// `CreateIssueDialog.tsx`). Ad-hoc JSON, no shared struct today — this is
/// the server-side mirror, kept in sync by hand.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssuePipelineMetadata {
    #[serde(default)]
    pipeline_ids: Vec<String>,
    #[serde(default)]
    enabled_ids: Vec<String>,
    #[serde(default)]
    executor: Option<String>,
    #[serde(default)]
    custom_text: String,
}

fn empty_pipeline_response(
    workspace_id: uuid::Uuid,
    current_pipeline_stage: Option<i64>,
) -> ResolvedPipelineResponse {
    ResolvedPipelineResponse {
        workspace_id,
        pipeline_names: vec![],
        instructions: String::new(),
        stages: vec![],
        executor: None,
        custom_text: None,
        current_pipeline_stage,
    }
}

/// Resolve the pipeline stages selected on this workspace's linked card,
/// server-side — the single source of truth shared by the `get_pipeline`
/// MCP tool and the frontend's stage-progress UI. Reads
/// `issue.extension_metadata.pipeline` (written at card-creation/edit time),
/// not the card description text, so it works identically for a card whose
/// description carries the old full stage block or the new compact pointer.
///
/// Empty (not an error) when the workspace has no linked issue, or the issue
/// has no pipeline selected.
#[axum::debug_handler]
pub async fn resolve_pipeline(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ResolvedPipelineResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let Some((issue_id, _project_id)) =
        IssueWorkspace::find_issue_and_project_by_workspace(pool, workspace.id).await?
    else {
        return Ok(ResponseJson(ApiResponse::success(empty_pipeline_response(
            workspace.id,
            workspace.current_pipeline_stage,
        ))));
    };

    let Some(issue) = Issue::find_by_id(pool, issue_id).await? else {
        return Ok(ResponseJson(ApiResponse::success(empty_pipeline_response(
            workspace.id,
            workspace.current_pipeline_stage,
        ))));
    };

    let metadata: Option<IssuePipelineMetadata> = issue
        .extension_metadata
        .get("pipeline")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    let Some(metadata) = metadata else {
        return Ok(ResponseJson(ApiResponse::success(empty_pipeline_response(
            workspace.id,
            workspace.current_pipeline_stage,
        ))));
    };

    let all_pipelines = pl::load_pipelines(&pipelines_dir());
    let selected: Vec<&Pipeline> = all_pipelines
        .iter()
        .filter(|p| metadata.pipeline_ids.contains(&p.id))
        .collect();

    let enabled_ids: HashSet<String> = metadata.enabled_ids.into_iter().collect();
    let stages = pl::ordered_enabled_stages(&selected, &enabled_ids);

    let resolved_stages: Vec<ResolvedPipelineStage> = stages
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let index = (i + 1) as i64;
            ResolvedPipelineStage {
                index,
                id: s.id,
                label: s.label,
                prompt_fragment: s.prompt_fragment,
                report_hint: format!(
                    "Ao concluir esta stage, chame `report_pipeline_stage` com stage={index} e emita a linha `VK-PIPELINE-STAGE: {index}` antes de seguir para a próxima."
                ),
            }
        })
        .collect();

    let pipeline_names = selected.iter().map(|p| p.name.clone()).collect();
    let custom_text = metadata.custom_text.trim();

    Ok(ResponseJson(ApiResponse::success(
        ResolvedPipelineResponse {
            workspace_id: workspace.id,
            pipeline_names,
            instructions: if resolved_stages.is_empty() {
                String::new()
            } else {
                "Execute these stages in the order listed. Do not add, skip, or reorder stages."
                    .to_string()
            },
            stages: resolved_stages,
            executor: metadata.executor,
            custom_text: if custom_text.is_empty() {
                None
            } else {
                Some(custom_text.to_string())
            },
            current_pipeline_stage: workspace.current_pipeline_stage,
        },
    )))
}
