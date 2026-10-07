//! Recent Integration Guard refusals, for the board's Agent Activity panel.

use axum::{
    Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::get,
};
use chrono::{DateTime, Duration, Utc};
use db::models::integration_refusal::IntegrationRefusal;
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

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
    /// Most recent direct integrations. This is the operator-facing proof that
    /// a Done confirmation actually landed on its target branch.
    pub recent_merges: Vec<RecentDirectMerge>,
}

#[derive(Debug, Serialize, FromRow, TS)]
pub struct RecentDirectMerge {
    pub workspace_id: Uuid,
    pub workspace_name: Option<String>,
    pub branch: String,
    pub merge_commit: String,
    pub target_branch_name: String,
    pub created_at: DateTime<Utc>,
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
    let recent_merges = sqlx::query_as::<_, RecentDirectMerge>(
        "SELECT m.workspace_id, w.name AS workspace_name, w.branch, \
                m.merge_commit, m.target_branch_name, m.created_at \
         FROM merges m \
         JOIN workspaces w ON w.id = m.workspace_id \
         WHERE m.merge_type = 'direct' AND m.created_at >= ? \
         ORDER BY m.created_at DESC LIMIT 8",
    )
    .bind(since)
    .fetch_all(pool)
    .await?;
    Ok(ResponseJson(ApiResponse::success(
        IntegrationRefusalsResponse {
            days,
            merges,
            refusals,
            recent_merges,
        },
    )))
}
