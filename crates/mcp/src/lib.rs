use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ApiResponseEnvelope<T> {
    pub success: bool,
    pub data: Option<T>,
    pub message: Option<String>,
    /// Structured refusal payload (`ApiResponse::error_with_data`): the
    /// Integration Guard's `GitOperationError` (its `type` plus conflicted /
    /// dirty files, conflicting agents, …). Carried through so an agent can
    /// see exactly what blocked a call instead of a bare status code.
    pub error_data: Option<serde_json::Value>,
}

pub mod task_server;
