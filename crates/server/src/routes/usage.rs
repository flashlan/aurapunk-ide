//! Aggregated usage data for the Settings → Usage dashboard.
//!
//! Builds per-day activity from `execution_processes` joined with `sessions`
//! (agent breakdown), plus issue progress (created/completed), a per-project
//! summary, and in-memory LLM token + KV-cache telemetry.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    response::Json as ResponseJson,
    routing::{get, post},
};
use deployment::Deployment;
use executors::provider_usage::ProviderQuotaSnapshot;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::mem0_relevance::Mem0RelevanceSummary;
use services::services::token_telemetry::TokenTelemetrySummary;
use sqlx::FromRow;
use ts_rs::TS;
use utils::{
    memory_config::{self, MemoryAdapter},
    response::ApiResponse,
};
use uuid::Uuid;

use crate::DeploymentImpl;

/// Default mem0 server base URL; override with `MEM0_URL`.
fn mem0_url() -> String {
    memory_config::load().active_url()
}

fn mem0_source(url: &str) -> &'static str {
    match url_host(url).as_deref() {
        Some("localhost") | Some("127.0.0.1") | Some("::1") => "local",
        _ => "cloud",
    }
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct Mem0Connection {
    pub source: String,
    pub url: String,
    pub local_url: String,
    pub cloud_url: String,
    pub enabled: bool,
    pub adapter: String,
    pub mem0_api_key_configured: bool,
    pub qdrant_url: String,
    pub qdrant_api_key_configured: bool,
    pub embedding_dimensions: u32,
}

#[derive(Debug, Deserialize)]
struct UpdateMem0ConnectionRequest {
    source: Option<String>,
    adapter: Option<String>,
    enabled: Option<bool>,
    url: Option<String>,
    clear_url: Option<bool>,
    disconnect_cloud: Option<bool>,
    cloud_vector_only: Option<bool>,
    mem0_api_key: Option<String>,
    clear_mem0_api_key: Option<bool>,
    qdrant_url: Option<String>,
    qdrant_api_key: Option<String>,
    clear_qdrant_api_key: Option<bool>,
    qdrant_collection: Option<String>,
    embedding_dimensions: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct UpdateMem0AccountRequest {
    account_id: Option<String>,
}

fn mem0_connection() -> Mem0Connection {
    let config = memory_config::load();
    let url = config.active_url();
    let source = if config.adapter == MemoryAdapter::Mem0Vk && config.mem0_url.is_some() {
        mem0_source(&url).to_string()
    } else {
        config.source.clone()
    };
    Mem0Connection {
        source,
        url,
        local_url: config
            .local_url
            .clone()
            .unwrap_or_else(|| memory_config::DEFAULT_LOCAL_MEM0_URL.to_string()),
        cloud_url: config
            .cloud_url
            .clone()
            .unwrap_or_else(|| memory_config::DEFAULT_CLOUD_MEM0_URL.to_string()),
        enabled: config.enabled,
        adapter: config.adapter.as_str().to_string(),
        mem0_api_key_configured: config.has_mem0_api_key(),
        qdrant_url: config.qdrant_url.clone().unwrap_or_default(),
        qdrant_api_key_configured: config.has_qdrant_api_key(),
        embedding_dimensions: config.embedding_dimensions,
    }
}

/// Apply the same Mem0 API authentication used by the MCP client. The token
/// is shared by the app backend and either the local/Docker or hosted Mem0
/// service; the optional account header lets a hosted service enforce the
/// signed-in user's active license and namespace.
fn authorize_mem0(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    let config = memory_config::load();
    let request = match config
        .mem0_api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        Some(key) if config.adapter == MemoryAdapter::Mem0Platform => request
            .header("Authorization", format!("Token {key}"))
            .header("Accept", "application/json"),
        Some(key) => request.bearer_auth(key),
        None => request,
    };
    if config.adapter == MemoryAdapter::Mem0Platform {
        request
    } else {
        match std::env::var("MEM0_ACCOUNT_ID").or_else(|_| std::env::var("AURAPUNK_ACCOUNT_ID")) {
            Ok(account_id) if !account_id.trim().is_empty() => {
                request.header("X-AuraPunk-Account-Id", account_id)
            }
            _ => request,
        }
    }
}

/// One day of activity for a single agent.
#[derive(Debug, Serialize, TS)]
pub struct DailyAgentActivity {
    /// `YYYY-MM-DD` (local server time).
    pub day: String,
    pub agent: String,
    pub executions: i64,
    /// Total execution time in seconds (completed/failed/killed only).
    pub seconds: i64,
}

/// Issue activity on a single day.
#[derive(Debug, Serialize, TS)]
pub struct DailyIssueActivity {
    pub day: String,
    pub created: i64,
    pub completed: i64,
}

/// Per-project progress summary.
#[derive(Debug, Serialize, TS)]
pub struct ProjectProgress {
    pub project_id: String,
    pub name: String,
    pub total: i64,
    pub done: i64,
    pub open: i64,
}

/// Aggregate issue lifecycle counts across all projects.
#[derive(Debug, Serialize, TS)]
pub struct IssueLifecycleSummary {
    /// Total issues (active + archived).
    pub total: i64,
    /// Issues currently in a "todo"/"backlog" column.
    pub todo: i64,
    /// Issues marked concluded (`completed_at` set).
    pub done: i64,
    /// Archived issues.
    pub archived: i64,
    /// Average lifecycle (created → completed) over concluded issues, in seconds.
    pub avg_lifecycle_seconds: i64,
}

/// Durable token observations grouped for the Usage dashboard. These are
/// observed normalized events, so the numbers are intentionally labelled as
/// usage rather than billing or plan consumption.
#[derive(Debug, Serialize, TS)]
pub struct TokenUsageBreakdown {
    pub issue_id: Option<String>,
    pub issue_title: Option<String>,
    pub agent: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub executions: i64,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
}

#[derive(Debug, Serialize, TS)]
pub struct UsageSummary {
    /// Activity over the last 30 days, one row per (day, agent).
    pub activity: Vec<DailyAgentActivity>,
    /// Issue created/completed over the last 30 days.
    pub issues: Vec<DailyIssueActivity>,
    /// Per-project open/done counts.
    pub projects: Vec<ProjectProgress>,
    /// Aggregate issue lifecycle counts.
    pub issues_lifecycle: IssueLifecycleSummary,
    /// Total executions + duration across the whole window.
    pub total_executions: i64,
    pub total_seconds: i64,
    /// mem0 extraction-model token usage (best-effort; empty when mem0 is down).
    pub mem0_tokens: Mem0TokenUsage,
    /// `memory_search` recall relevance, day-bucketed — reported live by the
    /// `vibe_kanban_mcp` process via `POST /api/usage/mem0-relevance` (a
    /// separate process from this server, so this can't be read from a
    /// shared in-process struct the way the rest of `UsageSummary` is; see
    /// docs/ADR/ADR-030-mem0-context-drift-measurement.md). In-memory only —
    /// resets on server restart.
    pub mem0_relevance: Mem0RelevanceSummary,
    /// LLM token + KV-cache telemetry, day-bucketed per agent — reported
    /// via `POST /api/usage/token-telemetry`. In-memory only — resets on
    /// server restart.
    pub token_telemetry: TokenTelemetrySummary,
    /// Durable normalized token observations grouped by issue, agent and
    /// model over the same 30-day window.
    pub token_usage: Vec<TokenUsageBreakdown>,
    /// Best-effort provider account quota snapshots. These are populated only
    /// when the provider CLI/API exposes a machine-readable value.
    pub provider_limits: Vec<ProviderQuotaSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct Mem0TokenUsage {
    pub days: Vec<Mem0TokenDay>,
    pub providers: Vec<Mem0TokenProvider>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct Mem0TokenDay {
    pub day: String,
    pub prompt: i64,
    pub completion: i64,
    pub total: i64,
    #[serde(default)]
    pub providers: Vec<Mem0TokenProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct Mem0TokenProvider {
    pub provider: String,
    pub model: String,
    pub prompt: i64,
    pub completion: i64,
}

/// Body-free result of `POST /api/usage/re-extract`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct ReExtractResponse {
    pub ok: bool,
    pub scanned: i64,
    pub updated: i64,
    pub entities: i64,
    pub relations: i64,
}

/// mem0 runtime config (sanitized — keys never leave the mem0 container).
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct Mem0Config {
    pub ok: bool,
    pub provider: String,
    pub graph_enabled: bool,
    #[serde(default)]
    pub graph_url: String,
    #[serde(default)]
    pub collection: String,
    #[serde(default)]
    pub providers: std::collections::HashMap<String, Mem0ProviderCfg>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct Mem0ProviderCfg {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub has_key: bool,
}

/// Body sent by Settings → Memory to update the mem0 runtime config.
#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateMem0ConfigRequest {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub graph_enabled: Option<bool>,
    #[serde(default)]
    pub providers: Option<std::collections::HashMap<String, Mem0ProviderPatch>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct Mem0ProviderPatch {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// New key to set. Omit/empty to keep the existing (masked) key.
    #[serde(default)]
    pub key: Option<String>,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/usage/summary", get(usage_summary))
        .route("/usage/re-extract", post(re_extract))
        .route(
            "/usage/mem0-config",
            get(get_mem0_config).post(put_mem0_config),
        )
        .route(
            "/usage/mem0-connection",
            get(get_mem0_connection).put(update_mem0_connection),
        )
        .route(
            "/usage/mem0-account",
            get(get_mem0_account).put(update_mem0_account),
        )
        .route("/usage/mem0-status", get(mem0_status))
        .route("/usage/mem0-relevance", post(report_mem0_relevance))
        .route("/usage/token-telemetry", post(report_token_telemetry))
}

/// mem0 health-status indicator payload for the UI header dot. Reflects the
/// live health of the three mem0-vk containers (mem0, embeddings, qdrant) so
/// the user can see memory degradation at a glance without opening
/// Settings → Memory.
#[derive(Debug, Clone, Serialize, TS)]
pub struct Mem0Status {
    /// `green` | `yellow` | `orange` | `red` — see [`compute_level`].
    pub level: String,
    /// Per-component reachability/health. `true` means up and healthy.
    pub components: Mem0ComponentStatus,
    /// Human-readable summary of the current state.
    pub message: String,
    /// Which configured Mem0 endpoint is currently active.
    pub connection: Mem0Connection,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct Mem0ComponentStatus {
    pub mem0: bool,
    pub embeddings: bool,
    pub qdrant: bool,
}

/// Resolve the three component base URLs. `MEM0_URL` is the canonical one
/// (default `http://localhost:8000`); the other two default to the same host
/// on their well-known ports but can be overridden independently.
fn component_urls() -> (String, String, String) {
    let mem0 = mem0_url();
    let embeddings = std::env::var("EMBEDDINGS_URL").unwrap_or_else(|_| match url_host(&mem0) {
        Some(host) => format!("http://{host}:8001"),
        None => "http://localhost:8001".to_string(),
    });
    let qdrant = memory_config::load()
        .qdrant_url
        .unwrap_or_else(|| match url_host(&mem0) {
            Some(host) => format!("http://{host}:6333"),
            None => "http://localhost:6333".to_string(),
        });
    (mem0, embeddings, qdrant)
}

/// Cheap host extraction from `http(s)://host:port/path` — avoids pulling the
/// `url` crate in for a one-line parse.
fn url_host(input: &str) -> Option<String> {
    let without_scheme = input.split_once("://").map(|(_, r)| r).unwrap_or(input);
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    let host = authority
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(authority);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// mem0: reachable (`/api/config` 2xx) AND its own `/health` reports `ok`.
/// Returns `(reachable, healthy)`.
async fn check_mem0(client: &reqwest::Client, base: &str) -> (bool, bool) {
    if memory_config::load().adapter == MemoryAdapter::Mem0Platform {
        return check_mem0_platform(client, base).await;
    }
    let reachable = match authorize_mem0(client.get(format!("{base}/api/config")))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => true,
        _ => return (false, false),
    };
    let healthy = match client.get(format!("{base}/health")).send().await {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .map(|v| v.get("ok").and_then(|x| x.as_bool()).unwrap_or(true))
            .unwrap_or(true),
        // `/health` missing/erroring is itself a degradation signal.
        _ => false,
    };
    (reachable, healthy)
}

/// Mem0 Platform has no mem0-vk `/api/config` or `/health` endpoint. A scoped
/// search is a safe authenticated liveness probe for the managed API.
async fn check_mem0_platform(client: &reqwest::Client, base: &str) -> (bool, bool) {
    let body = serde_json::json!({
        "query": "health check",
        "filters": { "user_id": "aurapunk-health-check" },
        "top_k": 1,
    });
    match authorize_mem0(client.post(format!("{base}/v3/memories/search/")))
        .json(&body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => (true, true),
        Ok(response) => {
            tracing::debug!(status = %response.status(), "Mem0 Platform health probe failed");
            (true, false)
        }
        Err(error) => {
            tracing::debug!(error = %error, "Mem0 Platform is unreachable");
            (false, false)
        }
    }
}

/// Endpoint that returns a JSON body with an `ok` boolean field (mem0
/// `/health`, embeddings `/health`). Treats absence of the field as healthy
/// only when the request itself succeeded.
async fn check_json_ok(client: &reqwest::Client, url: &str) -> bool {
    match client.get(url).send().await {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .map(|v| v.get("ok").and_then(|x| x.as_bool()).unwrap_or(true))
            .unwrap_or(false),
        _ => false,
    }
}

/// Plain status-code liveness probe (qdrant `/healthz` returns text, not JSON).
async fn check_status(client: &reqwest::Client, url: &str, api_key: Option<&str>) -> bool {
    let request = api_key
        .filter(|key| !key.trim().is_empty())
        .map(|key| client.get(url).header("api-key", key))
        .unwrap_or_else(|| client.get(url));
    match request.send().await {
        Ok(r) => r.status().is_success(),
        _ => false,
    }
}

/// Checks vector search through the mem0 API itself. This is the fallback for
/// the all-in-one Docker image, where Qdrant and embeddings listen on private
/// container ports and are intentionally not published to the host.
///
/// A successful search proves that the API can reach both dependencies without
/// requiring the host-side health checker to reach their internal addresses.
async fn check_mem0_vector_search(client: &reqwest::Client, base: &str) -> bool {
    let body = serde_json::json!({
        "query": "mem0 health check",
        "limit": 1,
    });
    match authorize_mem0(client.post(format!("{base}/api/search")))
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        _ => false,
    }
}

/// Maps the three component states onto the four-level indicator. Most severe
/// first: red (mem0 down) > orange (backend/qdrant error while mem0 up) >
/// yellow (embeddings down; graph degraded, vector search still works) >
/// green (all healthy).
fn compute_level(
    mem0_up: bool,
    mem0_healthy: bool,
    embeddings: bool,
    qdrant: bool,
) -> (&'static str, String) {
    if !mem0_up {
        (
            "red",
            "mem0 indisponível — memory_save/memory_search falharão".to_string(),
        )
    } else if !mem0_healthy || !qdrant {
        if !qdrant {
            (
                "orange",
                "qdrant indisponível — vector search degradado".to_string(),
            )
        } else {
            (
                "orange",
                "mem0 respondendo com erros — backend (qdrant) degradado".to_string(),
            )
        }
    } else if !embeddings {
        (
            "yellow",
            "embeddings indisponível — graph degradado, search ainda funciona".to_string(),
        )
    } else {
        ("green", "mem0 operacional".to_string())
    }
}

/// `GET /api/usage/mem0-status` — parallel health check of the three mem0-vk
/// components (3s timeout per check) and a computed 4-level health indicator
/// for the UI header dot. Best-effort: never errors, always returns a status.
async fn mem0_status() -> ResponseJson<ApiResponse<Mem0Status>> {
    let config = memory_config::load();
    if !config.enabled {
        return ResponseJson(ApiResponse::success(Mem0Status {
            level: "disabled".to_string(),
            components: Mem0ComponentStatus {
                mem0: false,
                embeddings: false,
                qdrant: false,
            },
            message: "memória desativada nas configurações".to_string(),
            connection: mem0_connection(),
        }));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let (mem0_base, emb_base, qdrant_base) = component_urls();

    let emb_health_url = format!("{emb_base}/health");
    let qdrant_health_url = format!("{qdrant_base}/healthz");
    let (mem0_res, emb_res, qdrant_res) = tokio::join!(
        check_mem0(&client, &mem0_base),
        check_json_ok(&client, &emb_health_url),
        check_status(
            &client,
            &qdrant_health_url,
            config.qdrant_api_key.as_deref()
        ),
    );
    let (mem0_up, mem0_healthy) = mem0_res;

    // The all-in-one image exposes only port 8000. If both direct dependency
    // probes fail, use a real search through mem0 before reporting a degraded
    // state. This also remains conservative: a failed search leaves the
    // direct probe results unchanged.
    let (embeddings, qdrant) = if config.adapter == MemoryAdapter::Mem0Platform {
        // Mem0 Platform owns extraction, embeddings and vector storage.
        (true, true)
    } else if mem0_up && !emb_res && !qdrant_res {
        if check_mem0_vector_search(&client, &mem0_base).await {
            (true, true)
        } else {
            (emb_res, qdrant_res)
        }
    } else {
        (emb_res, qdrant_res)
    };

    let (level, message) = compute_level(mem0_up, mem0_healthy, embeddings, qdrant);

    ResponseJson(ApiResponse::success(Mem0Status {
        level: level.to_string(),
        components: Mem0ComponentStatus {
            mem0: mem0_up && mem0_healthy,
            embeddings,
            qdrant,
        },
        message,
        connection: mem0_connection(),
    }))
}

async fn get_mem0_connection() -> ResponseJson<ApiResponse<Mem0Connection>> {
    ResponseJson(ApiResponse::success(mem0_connection()))
}

async fn update_mem0_connection(
    Json(body): Json<UpdateMem0ConnectionRequest>,
) -> ResponseJson<ApiResponse<Mem0Connection>> {
    let mut config = memory_config::load();

    if body.disconnect_cloud.unwrap_or(false) && config.source == "cloud" {
        config.enabled = false;
        config.mem0_url = None;
        config.cloud_url = None;
        config.cloud_vector_only = false;
        config.mem0_api_key = None;
    }

    if let Some(source) = body.source {
        let source = source.trim().to_ascii_lowercase();
        if !matches!(source.as_str(), "local" | "cloud") {
            return ResponseJson(ApiResponse::error("source must be local or cloud"));
        }
        config.source = source;
        if config.adapter == MemoryAdapter::Mem0Vk && body.url.is_none() {
            config.mem0_url = None;
        }
    }

    if let Some(adapter) = body.adapter {
        let Some(adapter) = MemoryAdapter::from_env(&adapter) else {
            return ResponseJson(ApiResponse::error(
                "adapter must be mem0_vk or mem0_platform",
            ));
        };
        config.adapter = adapter;
        if body.url.is_none() {
            config.mem0_url = None;
        }
    }
    if let Some(enabled) = body.enabled {
        config.enabled = enabled;
    }
    if let Some(cloud_vector_only) = body.cloud_vector_only {
        config.cloud_vector_only = cloud_vector_only;
    }
    if body.clear_url.unwrap_or(false) {
        config.mem0_url = None;
        config.cloud_url = None;
    }
    if let Some(url) = body.url {
        let url = url.trim().to_string();
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return ResponseJson(ApiResponse::error(
                "url must start with http:// or https://",
            ));
        }
        config.mem0_url = Some(url);
    }
    if body.clear_mem0_api_key.unwrap_or(false) {
        config.mem0_api_key = None;
    } else if let Some(key) = body.mem0_api_key.filter(|key| !key.trim().is_empty()) {
        config.mem0_api_key = Some(key.trim().to_string());
    }
    if let Some(url) = body.qdrant_url {
        let url = url.trim().to_string();
        if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
            return ResponseJson(ApiResponse::error(
                "qdrant_url must start with http:// or https://",
            ));
        }
        config.qdrant_url = (!url.is_empty()).then_some(url);
    }
    if body.clear_qdrant_api_key.unwrap_or(false) {
        config.qdrant_api_key = None;
    } else if let Some(key) = body.qdrant_api_key.filter(|key| !key.trim().is_empty()) {
        config.qdrant_api_key = Some(key.trim().to_string());
    }
    if let Some(collection) = body.qdrant_collection {
        config.qdrant_collection =
            (!collection.trim().is_empty()).then_some(collection.trim().to_string());
    }
    if let Some(dimensions) = body.embedding_dimensions {
        if !(1..=8192).contains(&dimensions) {
            return ResponseJson(ApiResponse::error(
                "embedding_dimensions must be between 1 and 8192",
            ));
        }
        config.embedding_dimensions = dimensions;
    }

    if let Err(error) = memory_config::save(&config) {
        return ResponseJson(ApiResponse::error(&format!(
            "failed to save memory config: {error}"
        )));
    }

    // Keep legacy environment consumers working in this process. The MCP
    // worker also reads memory.toml directly, so this remains correct after a
    // server restart as well.
    unsafe {
        std::env::set_var("MEM0_URL", config.active_url());
        std::env::set_var("AURAPUNK_MEM0_ADAPTER", config.adapter.as_str());
        std::env::set_var("MEM0_ENABLED", config.enabled.to_string());
    }
    ResponseJson(ApiResponse::success(mem0_connection()))
}

fn current_mem0_account() -> Option<String> {
    std::env::var("MEM0_ACCOUNT_ID")
        .or_else(|_| std::env::var("AURAPUNK_ACCOUNT_ID"))
        .ok()
        .filter(|value| !value.trim().is_empty())
}

async fn get_mem0_account() -> ResponseJson<ApiResponse<Option<String>>> {
    ResponseJson(ApiResponse::success(current_mem0_account()))
}

async fn update_mem0_account(
    Json(request): Json<UpdateMem0AccountRequest>,
) -> ResponseJson<ApiResponse<Option<String>>> {
    let account_id = request
        .account_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(account_id) = &account_id {
        let valid = account_id.len() <= 128
            && account_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
        if !valid {
            return ResponseJson(ApiResponse::error(
                "account_id must contain only letters, numbers, '_' or '-'",
            ));
        }
        unsafe { std::env::set_var("MEM0_ACCOUNT_ID", account_id) };
        unsafe { std::env::remove_var("AURAPUNK_ACCOUNT_ID") };
    } else {
        unsafe { std::env::remove_var("MEM0_ACCOUNT_ID") };
        unsafe { std::env::remove_var("AURAPUNK_ACCOUNT_ID") };
    }

    ResponseJson(ApiResponse::success(account_id))
}

/// Body posted by the `vibe_kanban_mcp` process (a separate process from
/// this server) after each `memory_search` call, once per call — see
/// `crates/mcp/src/task_server/tools/mem0.rs`.
#[derive(Debug, Deserialize)]
struct ReportMem0RelevanceBody {
    /// Highest-ranked hit's score, or `None` when the call returned zero
    /// hits.
    top_score: Option<f64>,
}

/// Best-effort sink: always returns success, even if nothing was recorded,
/// so a malformed/late report from the MCP process never surfaces as an
/// error to it — this is an observability aid, not a critical write path.
async fn report_mem0_relevance(
    State(deployment): State<DeploymentImpl>,
    Json(body): Json<ReportMem0RelevanceBody>,
) -> ResponseJson<ApiResponse<()>> {
    deployment.mem0_relevance_service().record(body.top_score);
    ResponseJson(ApiResponse::success(()))
}

/// Body posted by the frontend (or any caller) when a session accumulates
/// token usage — typically on execution completion or periodic flush.
#[derive(Debug, Deserialize)]
struct ReportTokenTelemetryBody {
    agent: String,
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
    #[serde(default)]
    cache_read_tokens: u32,
    #[serde(default)]
    cache_creation_tokens: u32,
}

/// Best-effort sink: always returns success — same pattern as
/// [`report_mem0_relevance`]. An observability aid, not a critical path.
async fn report_token_telemetry(
    State(deployment): State<DeploymentImpl>,
    Json(body): Json<ReportTokenTelemetryBody>,
) -> ResponseJson<ApiResponse<()>> {
    deployment.token_telemetry_service().record(
        &body.agent,
        body.input_tokens,
        body.output_tokens,
        body.cache_read_tokens,
        body.cache_creation_tokens,
    );
    ResponseJson(ApiResponse::success(()))
}

async fn get_mem0_config(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<Mem0Config>> {
    let _ = deployment;
    let memory = memory_config::load();
    if !memory.enabled || memory.adapter == MemoryAdapter::Mem0Platform {
        return ResponseJson(ApiResponse::success(Mem0Config {
            ok: memory.enabled,
            provider: if memory.adapter == MemoryAdapter::Mem0Platform {
                "mem0_platform"
            } else {
                // Keep the form valid so an operator can re-enable memory
                // while the backend is offline; the provider is not changed
                // by the disabled response.
                "groq"
            }
            .to_string(),
            graph_enabled: false,
            graph_url: String::new(),
            collection: if memory.adapter == MemoryAdapter::Mem0Platform {
                "managed by Mem0 Platform"
            } else {
                "memory disabled"
            }
            .to_string(),
            providers: std::collections::HashMap::new(),
        }));
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return ResponseJson(ApiResponse::error("failed to build mem0 client")),
    };
    let url = format!("{}/api/config", mem0_url());
    match authorize_mem0(client.get(&url)).send().await {
        Ok(r) if r.status().is_success() => match r.json::<Mem0Config>().await {
            Ok(cfg) => ResponseJson(ApiResponse::success(cfg)),
            Err(_) => ResponseJson(ApiResponse::error("failed to parse mem0 config")),
        },
        Ok(r) => ResponseJson(ApiResponse::error(&format!(
            "mem0 config returned status {}",
            r.status()
        ))),
        Err(e) => ResponseJson(ApiResponse::error(&format!("mem0 config failed: {e}"))),
    }
}

async fn put_mem0_config(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<UpdateMem0ConfigRequest>,
) -> ResponseJson<ApiResponse<Mem0Config>> {
    let _ = deployment;
    if memory_config::load().adapter == MemoryAdapter::Mem0Platform {
        // Extraction, embeddings and graph settings are managed by the hosted
        // platform. Keep the endpoint successful so the shared Settings form
        // can be used regardless of the selected adapter.
        return ResponseJson(ApiResponse::success(Mem0Config {
            ok: true,
            provider: "mem0_platform".to_string(),
            graph_enabled: false,
            graph_url: String::new(),
            collection: "managed by Mem0 Platform".to_string(),
            providers: std::collections::HashMap::new(),
        }));
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return ResponseJson(ApiResponse::error("failed to build mem0 client")),
    };
    let url = format!("{}/api/config", mem0_url());
    let memory = memory_config::load();
    let mut body = serde_json::json!({
        "provider": req.provider,
        "graph_enabled": req.graph_enabled,
        "providers": req.providers,
    });
    if memory.qdrant_url.is_some() || memory.qdrant_api_key.is_some() {
        body["vector_store"] = serde_json::json!({
            "provider": "qdrant",
            "url": memory.qdrant_url,
            "api_key": memory.qdrant_api_key,
            "collection_name": memory.qdrant_collection,
            "embedding_model_dims": memory.embedding_dimensions,
        });
    }
    match authorize_mem0(client.post(&url)).json(&body).send().await {
        Ok(r) if r.status().is_success() => match r.json::<Mem0Config>().await {
            Ok(cfg) => ResponseJson(ApiResponse::success(cfg)),
            Err(_) => ResponseJson(ApiResponse::error("failed to parse mem0 config")),
        },
        Ok(r) => ResponseJson(ApiResponse::error(&format!(
            "mem0 config update returned status {}",
            r.status()
        ))),
        Err(e) => ResponseJson(ApiResponse::error(&format!(
            "mem0 config update failed: {e}"
        ))),
    }
}

/// Fetch mem0 extraction-token usage (best-effort).
async fn fetch_mem0_tokens() -> Mem0TokenUsage {
    if memory_config::load().adapter == MemoryAdapter::Mem0Platform {
        return Mem0TokenUsage::default();
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Mem0TokenUsage::default(),
    };
    let url = format!("{}/api/usage/tokens", mem0_url());
    let resp = match authorize_mem0(client.get(&url)).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Mem0TokenUsage::default(),
    };
    resp.json::<Mem0TokenUsage>().await.unwrap_or_default()
}

async fn usage_summary(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<UsageSummary>> {
    let pool = &deployment.db().pool;

    // Per-day, per-agent execution counts and durations (exclude still-running
    // executions from the duration sum — their completed_at is NULL).
    let activity = sqlx::query_as::<_, (String, String, i64, i64)>(
        r#"SELECT date(ep.started_at) AS day,
                  COALESCE(s.executor, 'unknown') AS agent,
                  COUNT(*) AS executions,
                  COALESCE(SUM(
                      CASE
                        WHEN ep.completed_at IS NOT NULL
                          THEN CAST((julianday(ep.completed_at) - julianday(ep.started_at)) * 86400 AS INTEGER)
                        ELSE 0
                      END
                  ), 0) AS seconds
           FROM execution_processes ep
           LEFT JOIN sessions s ON s.id = ep.session_id
           WHERE ep.started_at >= datetime('now', '-30 days')
           GROUP BY day, agent
           ORDER BY day ASC"#,
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|(day, agent, executions, seconds)| DailyAgentActivity {
        day,
        agent,
        executions,
        seconds,
    })
    .collect();

    // Issue created/completed per day.
    let issues = sqlx::query_as::<_, (String, i64, i64)>(
        r#"SELECT COALESCE(d.day, '') AS day,
                  COALESCE(SUM(d.created), 0) AS created,
                  COALESCE(SUM(d.completed), 0) AS completed
           FROM (
               SELECT date(created_at) AS day, 1 AS created, 0 AS completed
                 FROM issues WHERE created_at >= datetime('now', '-30 days')
               UNION ALL
               SELECT date(completed_at) AS day, 0 AS created, 1 AS completed
                 FROM issues WHERE completed_at IS NOT NULL
                               AND completed_at >= datetime('now', '-30 days')
           ) d
           GROUP BY d.day
           ORDER BY d.day ASC"#,
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|(day, created, completed)| DailyIssueActivity {
        day,
        created,
        completed,
    })
    .collect();

    // Per-project open/done counts (done = completed_at set).
    #[derive(FromRow)]
    struct ProjectRow {
        id: Uuid,
        name: String,
        total: i64,
        done: i64,
    }
    let projects = sqlx::query_as::<_, ProjectRow>(
        r#"SELECT p.id, p.name,
                  COUNT(i.id) AS total,
                  COALESCE(SUM(CASE WHEN i.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS done
           FROM projects p
           LEFT JOIN issues i ON i.project_id = p.id
           GROUP BY p.id, p.name
           ORDER BY p.name ASC"#,
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|row| ProjectProgress {
        project_id: row.id.to_string(),
        name: row.name,
        total: row.total,
        done: row.done,
        open: row.total - row.done,
    })
    .collect();

    // Aggregate issue lifecycle counts across all projects.
    #[derive(FromRow)]
    struct LifecycleRow {
        total: i64,
        archived: i64,
        done: i64,
        todo: i64,
        avg_lifecycle: i64,
    }
    let lifecycle = sqlx::query_as::<_, LifecycleRow>(
        r#"SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN i.archived = 1 THEN 1 ELSE 0 END), 0) AS archived,
                  COALESCE(SUM(CASE WHEN i.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS done,
                  COALESCE(SUM(CASE
                      WHEN ps.name LIKE '%todo%' OR ps.name LIKE '%backlog%' OR ps.name LIKE '%to do%'
                      THEN 1 ELSE 0 END), 0) AS todo,
                  COALESCE(CAST(AVG(CASE
                      WHEN i.completed_at IS NOT NULL
                      THEN (julianday(i.completed_at) - julianday(i.created_at)) * 86400
                      ELSE NULL END) AS INTEGER), 0) AS avg_lifecycle
           FROM issues i
           LEFT JOIN project_statuses ps ON ps.id = i.status_id"#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(LifecycleRow {
        total: 0,
        archived: 0,
        done: 0,
        todo: 0,
        avg_lifecycle: 0,
    });
    let issues_lifecycle = IssueLifecycleSummary {
        total: lifecycle.total,
        archived: lifecycle.archived,
        done: lifecycle.done,
        todo: lifecycle.todo,
        avg_lifecycle_seconds: lifecycle.avg_lifecycle,
    };

    // Totals across the whole 30-day window.
    let (total_executions, total_seconds) = sqlx::query_as::<_, (i64, i64)>(
        r#"SELECT COUNT(*) AS executions,
                  COALESCE(SUM(
                      CASE
                        WHEN completed_at IS NOT NULL
                          THEN CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER)
                        ELSE 0
                      END
                  ), 0) AS seconds
           FROM execution_processes
           WHERE started_at >= datetime('now', '-30 days')"#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or((0, 0));

    let mem0_tokens = fetch_mem0_tokens().await;
    let mem0_relevance = deployment.mem0_relevance_service().summary();
    let token_telemetry = deployment.token_telemetry_service().summary();

    #[derive(FromRow)]
    struct TokenUsageRow {
        issue_id: Option<Uuid>,
        issue_title: Option<String>,
        agent: String,
        provider: Option<String>,
        model: Option<String>,
        executions: i64,
        total_tokens: i64,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
    }
    let token_usage = sqlx::query_as::<_, TokenUsageRow>(
        r#"SELECT tur.issue_id,
                  i.title AS issue_title,
                  tur.agent,
                  tur.provider,
                  tur.model,
                  COUNT(DISTINCT tur.execution_process_id) AS executions,
                  COALESCE(SUM(tur.total_tokens), 0) AS total_tokens,
                  COALESCE(SUM(tur.input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(tur.output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(tur.cache_read_tokens), 0) AS cache_read_tokens,
                  COALESCE(SUM(tur.cache_creation_tokens), 0) AS cache_creation_tokens
           FROM token_usage_records tur
           LEFT JOIN issues i ON i.id = tur.issue_id
           WHERE tur.observed_at >= datetime('now', '-30 days')
           GROUP BY tur.issue_id, i.title, tur.agent, tur.provider, tur.model
           ORDER BY total_tokens DESC"#,
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|row| TokenUsageBreakdown {
        issue_id: row.issue_id.map(|id| id.to_string()),
        issue_title: row.issue_title,
        agent: row.agent,
        provider: row.provider,
        model: row.model,
        executions: row.executions,
        total_tokens: row.total_tokens,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_creation_tokens: row.cache_creation_tokens,
    })
    .collect();

    // Provider quota is account state reported by the executor process rather
    // than usage inferred from our local token ledger. Keep the distinction
    // explicit: a missing snapshot means the provider did not expose a safe
    // live value, not that the account has no remaining quota.
    let provider_limits = executors::provider_usage::snapshots();

    ResponseJson(ApiResponse::success(UsageSummary {
        activity,
        issues,
        projects,
        issues_lifecycle,
        total_executions,
        total_seconds,
        mem0_tokens,
        mem0_relevance,
        token_telemetry,
        token_usage,
        provider_limits,
    }))
}

/// Proxy to the mem0 server's `POST /api/re-extract/:user_id` — re-runs graph
/// extraction for memories stored before an extraction LLM was configured.
/// `?user_id=` selects which repository's memories to re-extract.
async fn re_extract(
    State(deployment): State<DeploymentImpl>,
    axum::extract::Query(q): axum::extract::Query<ReExtractQuery>,
) -> ResponseJson<ApiResponse<ReExtractResponse>> {
    let _ = deployment;
    if !memory_config::load().enabled {
        return ResponseJson(ApiResponse::error("memory endpoints are disabled"));
    }
    if memory_config::load().adapter == MemoryAdapter::Mem0Platform {
        return ResponseJson(ApiResponse::error(
            "re-extract is managed by Mem0 Platform and is not available here",
        ));
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return ResponseJson(ApiResponse::error("failed to build mem0 client"));
        }
    };
    let user_id = q.user_id.unwrap_or_else(|| "default".to_string());
    let url = format!("{}/api/re-extract/{}", mem0_url(), user_id);
    match authorize_mem0(client.post(&url)).send().await {
        Ok(r) if r.status().is_success() => match r.json::<ReExtractResponse>().await {
            Ok(res) => ResponseJson(ApiResponse::success(res)),
            Err(_) => ResponseJson(ApiResponse::error(
                "failed to parse mem0 re-extract response",
            )),
        },
        Ok(r) => ResponseJson(ApiResponse::error(&format!(
            "mem0 re-extract returned status {}",
            r.status()
        ))),
        Err(e) => ResponseJson(ApiResponse::error(&format!("mem0 re-extract failed: {e}"))),
    }
}

#[derive(Debug, Deserialize)]
struct ReExtractQuery {
    user_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_host_extracts_host_without_port() {
        assert_eq!(
            url_host("http://localhost:8000").as_deref(),
            Some("localhost")
        );
        assert_eq!(
            url_host("https://192.168.1.99:8082/x").as_deref(),
            Some("192.168.1.99")
        );
        assert_eq!(
            url_host("http://example.com").as_deref(),
            Some("example.com")
        );
    }

    #[test]
    fn level_mapping_all_healthy_is_green() {
        let (level, _) = compute_level(true, true, true, true);
        assert_eq!(level, "green");
    }

    #[test]
    fn level_mapping_mem0_down_is_red() {
        let (level, _) = compute_level(false, false, true, true);
        assert_eq!(level, "red");
    }

    #[test]
    fn level_mapping_mem0_unhealthy_is_orange() {
        let (level, _) = compute_level(true, false, true, true);
        assert_eq!(level, "orange");
    }

    #[test]
    fn level_mapping_qdrant_down_is_orange() {
        let (level, _) = compute_level(true, true, true, false);
        assert_eq!(level, "orange");
    }

    #[test]
    fn level_mapping_embeddings_down_is_yellow() {
        let (level, _) = compute_level(true, true, false, true);
        assert_eq!(level, "yellow");
    }

    #[test]
    fn level_mapping_embeddings_down_beats_nothing_else() {
        // embeddings down while everything else up → yellow, not orange/green.
        let (level, _) = compute_level(true, true, false, true);
        assert_eq!(level, "yellow");
    }
}
