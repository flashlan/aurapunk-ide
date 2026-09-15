use std::path::PathBuf;

use axum::{Extension, Json, extract::State, response::Json as ResponseJson};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    session::Session,
    workspace::{Workspace, WorkspaceError},
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::actions::{
    ExecutorAction, ExecutorActionType, open_code_review::OpenCodeReviewRequest,
};
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct StartOpenCodeReviewRequest {
    /// Review the workspace branch since its fork point when available.
    #[serde(default)]
    pub use_all_workspace_commits: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum OpenCodeReviewError {
    ProcessAlreadyRunning,
}

/// Start the optional, locally configured OpenCodeReview CLI for this card.
///
/// The command is deliberately not installed or configured by AuraPunk. Its
/// JSON output is streamed into this card's persistent execution logs.
#[axum::debug_handler]
pub async fn start_open_code_review(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<StartOpenCodeReviewRequest>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, OpenCodeReviewError>>, ApiError> {
    let pool = &deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            OpenCodeReviewError::ProcessAlreadyRunning,
        )));
    }

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let repos =
        WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace.id).await?;

    let base_commit = if payload.use_all_workspace_commits {
        repos.first().and_then(|repo| {
            deployment
                .git()
                .get_fork_point(
                    &PathBuf::from(container_ref.as_str()).join(&repo.repo.name),
                    &repo.target_branch,
                    &workspace.branch,
                )
                .ok()
        })
    } else {
        None
    };
    let working_dir = session
        .agent_working_dir
        .clone()
        .or_else(|| repos.first().map(|repo| repo.repo.name.clone()));

    let action = ExecutorAction::new(
        ExecutorActionType::OpenCodeReviewRequest(OpenCodeReviewRequest {
            base_commit,
            working_dir,
        }),
        None,
    );

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::OpenCodeReview,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}
