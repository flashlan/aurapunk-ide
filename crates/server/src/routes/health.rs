use axum::response::Json;
use serde::Serialize;
use utils::response::ApiResponse;

pub(super) async fn health_check() -> Json<ApiResponse<String>> {
    Json(ApiResponse::success("OK".to_string()))
}

#[derive(Debug, Serialize)]
pub struct BuildInfo {
    pub version: String,
    pub build_number: String,
    pub commit: String,
}

/// Build identity baked at compile time (see crates/server/build.rs):
/// app version plus an always-increasing commit count and short SHA, so any
/// running bundle (dev, DMG, cloud) can be traced back to its source.
pub(super) async fn build_info() -> Json<ApiResponse<BuildInfo>> {
    Json(ApiResponse::success(BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_number: option_env!("AURAPUNK_BUILD_NUMBER")
            .unwrap_or("0")
            .to_string(),
        commit: option_env!("AURAPUNK_BUILD_SHA")
            .unwrap_or("unknown")
            .to_string(),
    }))
}
