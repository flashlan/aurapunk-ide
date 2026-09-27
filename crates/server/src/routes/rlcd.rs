//! RLCD configuration sync and memory classification. See
//! `services::services::rlcd`.

use axum::{
    Json, Router,
    response::Json as ResponseJson,
    routing::{get, post},
};
use serde::Deserialize;
use services::services::rlcd::{self, MemoryVerdict, RlcdConfig, RlcdConfigView};
use utils::response::ApiResponse;

use crate::DeploymentImpl;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/rlcd/config", get(get_config).put(put_config))
        .route("/rlcd/classify-memory", post(classify_memory))
        .route("/rlcd/classify-tool-call", post(classify_tool_call))
        .route("/rlcd/route-task", post(route_task))
}

async fn get_config() -> ResponseJson<ApiResponse<RlcdConfigView>> {
    ResponseJson(ApiResponse::success(RlcdConfigView::from(&rlcd::config())))
}

/// Settings mirrors its Laya / Jev / guardrail preferences here so backend
/// features (tool-call guardrails, the memory gate) follow them.
async fn put_config(Json(config): Json<RlcdConfig>) -> ResponseJson<ApiResponse<RlcdConfigView>> {
    let view = RlcdConfigView::from(&config);
    match rlcd::save_config(config) {
        Ok(()) => ResponseJson(ApiResponse::success(view)),
        Err(error) => ResponseJson(ApiResponse::error(&format!(
            "failed to save rlcd.toml: {error}"
        ))),
    }
}

#[derive(Debug, Deserialize)]
pub struct ClassifyMemoryRequest {
    pub content: String,
}

/// Used by the MCP `memory_save` before writing to Mem0.
async fn classify_memory(
    Json(body): Json<ClassifyMemoryRequest>,
) -> ResponseJson<ApiResponse<MemoryVerdict>> {
    ResponseJson(ApiResponse::success(
        rlcd::classify_memory(&body.content).await,
    ))
}

#[derive(Debug, Deserialize)]
pub struct ClassifyToolCallRequest {
    pub command: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ToolCallVerdict {
    pub blocked: bool,
    pub reason: Option<String>,
}

/// Diagnostic: the semantic guardrail verdict for a shell command, exactly as
/// the headed approval hook would compute it (Settings test / benchmarks).
async fn classify_tool_call(
    Json(body): Json<ClassifyToolCallRequest>,
) -> ResponseJson<ApiResponse<ToolCallVerdict>> {
    let reason = rlcd::classify_tool_call("Bash", &body.command).await;
    ResponseJson(ApiResponse::success(ToolCallVerdict {
        blocked: reason.is_some(),
        reason,
    }))
}

#[derive(Debug, Deserialize)]
pub struct RouteTaskRequest {
    pub task: String,
}

/// `POST /api/rlcd/route-task` (ADR-051): recommend roles, a pipeline and
/// whether to split a task, from classifier scores. Advisory only.
async fn route_task(
    Json(body): Json<RouteTaskRequest>,
) -> ResponseJson<ApiResponse<rlcd::RouteRecommendation>> {
    let candidates: Vec<rlcd::RouteCandidate> =
        services::services::pipelines::load_pipelines(&utils::path::pipelines_dir())
            .into_iter()
            .map(|pipeline| rlcd::RouteCandidate {
                id: pipeline.id,
                name: pipeline.name,
                description: pipeline.description,
            })
            .collect();
    ResponseJson(ApiResponse::success(
        rlcd::route_task(&body.task, &candidates).await,
    ))
}
