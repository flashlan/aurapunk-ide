use axum::{
    Extension, Json, Router, extract::State, middleware::from_fn_with_state,
    response::Json as ResponseJson, routing::get,
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    scratch::DraftFollowUpData,
    session::Session,
    workspace::{Workspace, WorkspaceError},
};
use deployment::Deployment;
use executors::profile::ExecutorConfig;
use serde::Deserialize;
use services::services::{container::ContainerService, queued_message::QueueStatus};
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError, middleware::load_session_middleware};

/// Request body for queueing a follow-up message
#[derive(Debug, Deserialize, TS)]
struct QueueMessageRequest {
    pub message: String,
    pub executor_config: ExecutorConfig,
}

/// Queue a follow-up message to be executed when the current execution finishes
async fn queue_message(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<QueueMessageRequest>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let data = DraftFollowUpData {
        message: payload.message,
        executor_config: payload.executor_config,
    };

    let queued = deployment
        .queued_message_service()
        .queue_message(session.id, data);

    Ok(ResponseJson(ApiResponse::success(QueueStatus::Queued {
        message: queued,
    })))
}

/// Preserve a follow-up, then interrupt the active headless turn so the common
/// finalization path starts the message immediately in the same session.
async fn send_now(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<QueueMessageRequest>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let pool = &deployment.db().pool;
    let running = ExecutionProcess::find_latest_running_coding_agent_for_session(pool, session.id)
        .await?
        .ok_or_else(|| {
            ApiError::Workspace(db::models::workspace::WorkspaceError::ValidationError(
                "No running coding-agent execution to interrupt".to_string(),
            ))
        })?;

    let is_interactive = running
        .executor_action()
        .ok()
        .and_then(|action| action.interactive_config().cloned())
        .is_some();
    if is_interactive {
        return Err(ApiError::Workspace(WorkspaceError::ValidationError(
            "Interactive sessions already deliver follow-ups live".to_string(),
        )));
    }

    let data = DraftFollowUpData {
        message: payload.message,
        executor_config: payload.executor_config,
    };
    deployment
        .queued_message_service()
        .queue_message_for_immediate_delivery(session.id, data);

    // The message is stored before stopping, so a fast process-exit event cannot
    // race ahead and lose the follow-up.
    let stop_result = deployment
        .container()
        .stop_execution(&running, ExecutionProcessStatus::Killed)
        .await;

    if let Err(error) = stop_result {
        let refreshed = ExecutionProcess::find_by_id(pool, running.id).await?;
        if refreshed
            .as_ref()
            .is_some_and(|process| matches!(process.status, ExecutionProcessStatus::Failed))
        {
            deployment
                .queued_message_service()
                .cancel_queued(session.id);
            return Err(ApiError::Workspace(WorkspaceError::ValidationError(
                "The active execution failed before Send now could interrupt it; the message was not sent"
                    .to_string(),
            )));
        }
        let ended_before_stop = refreshed
            .as_ref()
            .is_some_and(|process| matches!(process.status, ExecutionProcessStatus::Completed));
        if !ended_before_stop {
            // The prompt is safely queued. Returning success prevents the client
            // from resubmitting it. A live process can finish naturally; one
            // already marked Killed remains owned by its exit finalizer.
            tracing::warn!(
                session_id = %session.id,
                %error,
                "Send-now stop failed while the process remains live; keeping immediate follow-up queued"
            );
        } else if let Some(queued_message) =
            deployment.queued_message_service().take_queued(session.id)
        {
            // The process completed between lookup and stop, before its finalizer
            // could see our insertion. Start the preserved prompt directly.
            let workspace = Workspace::find_by_id(pool, session.workspace_id)
                .await?
                .ok_or(ApiError::Session(
                    db::models::session::SessionError::WorkspaceNotFound,
                ))?;
            super::run_follow_up(
                &deployment,
                session,
                workspace,
                queued_message.data.message,
                queued_message.data.executor_config,
                None,
                None,
                None,
            )
            .await?;

            return Ok(ResponseJson(ApiResponse::success(QueueStatus::Empty)));
        }
    }

    Ok(ResponseJson(ApiResponse::success(
        deployment.queued_message_service().get_status(session.id),
    )))
}

/// Cancel a queued follow-up message
async fn cancel_queued_message(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    deployment
        .queued_message_service()
        .cancel_queued(session.id);

    Ok(ResponseJson(ApiResponse::success(QueueStatus::Empty)))
}

/// Get the current queue status for a session's workspace
async fn get_queue_status(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let status = deployment.queued_message_service().get_status(session.id);

    Ok(ResponseJson(ApiResponse::success(status)))
}

pub(super) fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    Router::new()
        .route(
            "/",
            get(get_queue_status)
                .post(queue_message)
                .delete(cancel_queued_message),
        )
        .route("/send-now", axum::routing::post(send_now))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_session_middleware,
        ))
}
