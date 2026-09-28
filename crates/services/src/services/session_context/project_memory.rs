//! Backend Mem0 client for session context (ADR-053).
//!
//! Two uses, both on the self-hosted / AuraPunk Cloud `mem0-vk` service:
//! - **recall**: a vector search the app runs itself when a session starts,
//!   so relevant project memory reaches the agent without depending on it
//!   calling `memory_search`;
//! - **handoff**: the agent-written handoff summary kept verbatim (`raw`, no
//!   fact extraction, no graph) under a per-card `user_id`, so a session
//!   started on another machine gets it too; forgotten when the card merges.
//!
//! Mem0 Platform is not supported here yet (the MCP tools still work with it).
//! Every call is best-effort with a short timeout: memory never blocks a run.

use std::time::Duration;

use serde::Deserialize;
use utils::memory_config::{self, MemoryAdapter, MemoryConfig};

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
pub struct Recalled {
    pub score: f64,
    pub content: String,
}

#[derive(Debug, Deserialize)]
struct Payload {
    content: Option<String>,
    created_at: Option<String>,
    /// Set by `mem0-vk` for verbatim writes. A server without raw support
    /// splits the text into extracted facts instead; those are never used as
    /// a handoff.
    #[serde(default)]
    raw: bool,
}

#[derive(Debug, Deserialize)]
struct Point {
    score: Option<f64>,
    payload: Option<Payload>,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    vector: Vec<Point>,
}

#[derive(Debug, Deserialize)]
struct RecallResponse {
    #[serde(default)]
    memories: Vec<Point>,
}

fn active_config() -> Option<MemoryConfig> {
    let config = memory_config::load();
    (config.enabled && config.adapter == MemoryAdapter::Mem0Vk).then_some(config)
}

fn request(
    config: &MemoryConfig,
    method: reqwest::Method,
    path: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}{path}", config.active_url().trim_end_matches('/'));
    let mut request = client.request(method, url);
    if let Some(key) = config
        .mem0_api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        request = request.bearer_auth(key);
    }
    // Hosted Mem0 scopes memory per signed-in account (set at login).
    if let Ok(account) =
        std::env::var("MEM0_ACCOUNT_ID").or_else(|_| std::env::var("AURAPUNK_ACCOUNT_ID"))
        && !account.trim().is_empty()
    {
        request = request.header("X-AuraPunk-Account-Id", account);
    }
    Ok(request)
}

async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let response = request.send().await.map_err(|e| e.to_string())?;
    if response.status().is_success() {
        Ok(response)
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("HTTP {status}: {}", body.trim()))
    }
}

fn encode_segment(segment: &str) -> String {
    segment
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn content_of(point: Point) -> Option<(Option<f64>, Option<String>, String)> {
    let payload = point.payload?;
    let content = payload.content?.trim().to_string();
    (!content.is_empty()).then_some((point.score, payload.created_at, content))
}

/// Vector search in one repository's memory (`user_id` = repo slug).
pub async fn search(user_id: &str, query: &str, limit: usize) -> Result<Vec<Recalled>, String> {
    let Some(config) = active_config() else {
        return Ok(Vec::new());
    };
    let response = send(
        request(&config, reqwest::Method::POST, "/api/search")?.json(&serde_json::json!({
            "query": query,
            "user_id": user_id,
            "limit": limit,
        })),
    )
    .await?;
    let parsed: SearchResponse = response.json().await.map_err(|e| e.to_string())?;
    Ok(parsed
        .vector
        .into_iter()
        .filter_map(content_of)
        .map(|(score, _, content)| Recalled {
            score: score.unwrap_or(0.0),
            content,
        })
        .collect())
}

#[derive(Debug, Deserialize)]
struct Features {
    #[serde(default)]
    raw: bool,
    #[serde(default)]
    scoped_delete: bool,
}

/// Whether the memory service stores `raw` writes verbatim and supports
/// owner-scoped point deletes. An older `mem0-vk` ignores `raw` and splits the
/// text into extracted facts, so raw writers must check first.
async fn ensure_raw_support(config: &MemoryConfig) -> Result<(), String> {
    let response = send(request(config, reqwest::Method::GET, "/api/features")?)
        .await
        .map_err(|_| {
            "the memory service does not support verbatim (raw) writes yet — update mem0-vk"
                .to_string()
        })?;
    let features: Features = response.json().await.map_err(|e| e.to_string())?;
    if features.raw && features.scoped_delete {
        Ok(())
    } else {
        Err(
            "the memory service does not support verbatim (raw) writes yet — update mem0-vk"
                .to_string(),
        )
    }
}

/// `Ok(false)` when project memory is off; `Err` when the service cannot
/// store raw entries (checked before touching anything).
pub async fn raw_writes_available() -> Result<bool, String> {
    let Some(config) = active_config() else {
        return Ok(false);
    };
    ensure_raw_support(&config).await.map(|()| true)
}

/// Replace everything stored under `user_id` with `content`, verbatim.
pub async fn replace_raw(user_id: &str, content: &str) -> Result<(), String> {
    let Some(config) = active_config() else {
        return Ok(());
    };
    ensure_raw_support(&config).await?;
    forget(user_id).await?;
    send(
        request(&config, reqwest::Method::POST, "/api/memories")?.json(&serde_json::json!({
            "content": content,
            "user_id": user_id,
            "raw": true,
        })),
    )
    .await
    .map(|_| ())
}

#[derive(Debug, Deserialize)]
struct StoreResponse {
    #[serde(default)]
    ids: Vec<String>,
}

/// Add `content` verbatim under `user_id`; returns the new point id, or
/// `None` when project memory is off.
pub async fn store_raw(user_id: &str, content: &str) -> Result<Option<String>, String> {
    let Some(config) = active_config() else {
        return Ok(None);
    };
    ensure_raw_support(&config).await?;
    let response = send(
        request(&config, reqwest::Method::POST, "/api/memories")?.json(&serde_json::json!({
            "content": content,
            "user_id": user_id,
            "raw": true,
        })),
    )
    .await?;
    let parsed: StoreResponse = response.json().await.map_err(|e| e.to_string())?;
    parsed
        .ids
        .into_iter()
        .next()
        .map(Some)
        .ok_or_else(|| "the memory service returned no id".to_string())
}

/// Delete one point, only if it belongs to `user_id` (the service checks).
pub async fn delete_point(user_id: &str, id: &str) -> Result<(), String> {
    let Some(config) = active_config() else {
        return Ok(());
    };
    let path = format!(
        "/api/memories/{}?user_id={}",
        encode_segment(id),
        encode_segment(user_id)
    );
    send(request(&config, reqwest::Method::DELETE, &path)?)
        .await
        .map(|_| ())
}

/// The newest entry stored under `user_id`, if any.
pub async fn latest(user_id: &str) -> Result<Option<String>, String> {
    let Some(config) = active_config() else {
        return Ok(None);
    };
    let path = format!("/api/memories/{}", encode_segment(user_id));
    let response = send(request(&config, reqwest::Method::GET, &path)?).await?;
    let parsed: RecallResponse = response.json().await.map_err(|e| e.to_string())?;
    Ok(newest_raw(parsed.memories))
}

fn newest_raw(points: Vec<Point>) -> Option<String> {
    points
        .into_iter()
        .filter(|point| point.payload.as_ref().is_some_and(|payload| payload.raw))
        .filter_map(content_of)
        .max_by(|a, b| a.1.cmp(&b.1))
        .map(|(_, _, content)| content)
}

/// Delete everything stored under `user_id`.
pub async fn forget(user_id: &str) -> Result<(), String> {
    let Some(config) = active_config() else {
        return Ok(());
    };
    let path = format!("/api/memories/{}", encode_segment(user_id));
    send(request(&config, reqwest::Method::DELETE, &path)?)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_raw_points_count_and_newest_wins() {
        let parsed: RecallResponse = serde_json::from_value(serde_json::json!({
            "memories": [
                { "id": "a", "payload": { "content": "old", "raw": true, "created_at": "2026-09-27T10:00:00Z" } },
                { "id": "b", "payload": { "content": "  ", "raw": true } },
                { "id": "c", "payload": { "content": "new", "raw": true, "created_at": "2026-09-27T11:00:00Z" } },
                { "id": "d", "payload": { "content": "extracted fact", "created_at": "2026-09-27T12:00:00Z" } },
                { "id": "e" }
            ]
        }))
        .unwrap();
        assert_eq!(newest_raw(parsed.memories).as_deref(), Some("new"));
    }

    #[test]
    fn path_segments_are_encoded() {
        assert_eq!(encode_segment("handoff-1f2e"), "handoff-1f2e");
        assert_eq!(encode_segment("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn search_hits_keep_their_score() {
        let parsed: SearchResponse = serde_json::from_value(serde_json::json!({
            "vector": [{ "score": 0.74, "payload": { "content": "Integration Guard ..." } }]
        }))
        .unwrap();
        let hits: Vec<_> = parsed.vector.into_iter().filter_map(content_of).collect();
        assert_eq!(hits[0].0, Some(0.74));
    }
}
