//! Runtime launch mode exposed to the frontend.
//!
//! The local build remains the default. A launcher may set
//! `AURAPUNK_MODE=cloud` (legacy: `VIBE_KANBAN_MODE=cloud`) to opt into
//! cloud-oriented UI affordances without coupling the frontend bundle to a
//! build-time environment variable.

use axum::{Json, Router, routing::get};
use serde::Serialize;
use utils::response::ApiResponse;

use crate::DeploymentImpl;

/// Version of the public/private integration contract. This is intentionally
/// independent from the application release version: a patch release may
/// change implementation details without changing the cloud wire contract.
pub const AURAPUNK_CLOUD_CONTRACT_VERSION: u16 = 1;

#[derive(Debug, Serialize)]
pub struct AppModeResponse {
    pub mode: &'static str,
    pub cloud: bool,
    pub cloud_url: String,
    pub cloud_contract_version: u16,
    pub cloud_contract_path: &'static str,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/app-mode", get(app_mode))
}

async fn app_mode() -> Json<ApiResponse<AppModeResponse>> {
    let cloud = utils::env_compat::renamed("MODE")
        .map(|value| value.trim().eq_ignore_ascii_case("cloud"))
        .unwrap_or(false);
    let cloud_url = std::env::var("AURAPUNK_CLOUD_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://aurapunk.dev".to_string());

    Json(ApiResponse::success(AppModeResponse {
        mode: if cloud { "cloud" } else { "local" },
        cloud,
        cloud_url,
        cloud_contract_version: AURAPUNK_CLOUD_CONTRACT_VERSION,
        cloud_contract_path: "/api/cloud-contract",
    }))
}
