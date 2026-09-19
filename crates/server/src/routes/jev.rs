//! Server-side proxy for the TypeSafe Jev API.
//!
//! The TypeSafe API does not send `Access-Control-Allow-Origin`, so the desktop
//! webview (WKWebView/Tauri) cannot call it directly — every browser-side fetch
//! fails with an opaque "Load failed". The frontend therefore posts here (same
//! origin as the local backend) and the backend performs the request server to
//! server, forwarding the caller's `Authorization` header.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::Query,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::Value;

use crate::DeploymentImpl;

/// Official TypeSafe System One endpoint (used when `?endpoint=` is absent).
const DEFAULT_JEV_URL: &str = "https://api.typesafe.ai/v1/systemone";

#[derive(Debug, Deserialize)]
pub struct JevProxyQuery {
    /// Optional override for the upstream Jev endpoint (must be https).
    pub endpoint: Option<String>,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/jev/evaluate", post(evaluate))
}

async fn evaluate(
    Query(query): Query<JevProxyQuery>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let target = query
        .endpoint
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_JEV_URL.to_string());
    let target = target.trim().to_string();

    // Only hop to HTTPS so this cannot be turned into a local-network SSRF tool.
    if !target.starts_with("https://") {
        return (StatusCode::BAD_REQUEST, "endpoint must be an https:// URL").into_response();
    }

    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to build Jev proxy client",
            )
                .into_response();
        }
    };

    match client
        .post(&target)
        .header(header::AUTHORIZATION, authorization)
        .header(header::CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(upstream) => {
            let status = StatusCode::from_u16(upstream.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let bytes = upstream.bytes().await.unwrap_or_default();
            let mut response = Response::new(axum::body::Body::from(bytes));
            *response.status_mut() = status;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            response
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            format!("jev proxy request failed: {error}"),
        )
            .into_response(),
    }
}
