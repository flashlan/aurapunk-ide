//! Read and report integration failures (Mem0, Laya, Jev). See
//! `services::services::integration_errors` for why this exists.

use axum::{Json, Router, extract::Query, response::Json as ResponseJson, routing::get};
use serde::Deserialize;
use services::services::integration_errors::{
    self, IntegrationError, IntegrationErrorsResponse, ReportIntegrationErrorRequest,
};
use utils::response::ApiResponse;

use crate::DeploymentImpl;

#[derive(Debug, Deserialize)]
pub struct IntegrationErrorsQuery {
    /// Only return errors with a `seq` greater than this cursor.
    pub after: Option<u64>,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/integration-errors", get(list).post(report))
}

async fn list(
    Query(query): Query<IntegrationErrorsQuery>,
) -> ResponseJson<ApiResponse<IntegrationErrorsResponse>> {
    ResponseJson(ApiResponse::success(integration_errors::since(
        query.after.unwrap_or(0),
    )))
}

/// Used by the MCP server (a separate process) and by the frontend, whose
/// Laya calls run in the webview.
async fn report(
    Json(body): Json<ReportIntegrationErrorRequest>,
) -> ResponseJson<ApiResponse<IntegrationError>> {
    ResponseJson(ApiResponse::success(integration_errors::record(
        body.service,
        &body.operation,
        &body.message,
    )))
}
