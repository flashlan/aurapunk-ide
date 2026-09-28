//! Recent Integration Guard refusals, for the board's Agent Activity panel.

use axum::{
    Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::get,
};
use chrono::{Duration, Utc};
use db::models::integration_refusal::IntegrationRefusal;
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize)]
struct RefusalsQuery {
    days: Option<i64>,
}

#[derive(Debug, Serialize, TS)]
pub struct IntegrationRefusalsResponse {
    #[ts(type = "number")]
    pub days: i64,
    /// Direct merges in the same window, to put the refusals in proportion.
    #[ts(type = "number")]
    pub merges: i64,
    pub refusals: Vec<IntegrationRefusal>,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/integration-refusals", get(list))
}

async fn list(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<RefusalsQuery>,
) -> Result<ResponseJson<ApiResponse<IntegrationRefusalsResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let days = query.days.unwrap_or(7).clamp(1, 90);
    let since = Utc::now() - Duration::days(days);
    let refusals = IntegrationRefusal::since(pool, since, 50).await?;
    let merges: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM merges WHERE merge_type = 'direct' AND created_at >= ?",
    )
    .bind(since)
    .fetch_one(pool)
    .await?;
    Ok(ResponseJson(ApiResponse::success(
        IntegrationRefusalsResponse {
            days,
            merges,
            refusals,
        },
    )))
}
