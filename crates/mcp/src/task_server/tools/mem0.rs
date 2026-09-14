use std::sync::atomic::{AtomicBool, Ordering};

use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use utils::memory_config::{self, MemoryAdapter};
use uuid::Uuid;

use super::McpServer;

/// mem0-vk Docker container (REST + MCP). Defaults to the local mem0 server;
/// override with `MEM0_URL` when it runs elsewhere.
fn mem0_url() -> String {
    memory_config::load().active_url()
}

fn memory_enabled() -> bool {
    memory_config::load().enabled
}

fn using_mem0_platform() -> bool {
    memory_config::load().adapter == MemoryAdapter::Mem0Platform
}

fn using_cloud_vector_only() -> bool {
    let config = memory_config::load();
    config.enabled
        && config.adapter == MemoryAdapter::Mem0Vk
        && config.source == "cloud"
        && config.cloud_vector_only
}

/// Apply the universal Mem0 service-to-service contract. Local/Docker and
/// hosted Mem0 use the same bearer token variable; hosted deployments also
/// receive the signed-in AuraPunk account identity for license validation and
/// per-account memory scoping.
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

/// Default cap on returned hits when the caller doesn't specify `limit`.
/// Keeps a vague query from flooding the agent's context with loosely
/// related memories — see ADR-028.
const DEFAULT_SEARCH_LIMIT: usize = 5;

/// Below this cosine-similarity score, a `memory_search` top hit is
/// considered weak enough to plausibly be context drift — used only by
/// [`warn_if_weak_relevance`] (debug builds only, a console warning). The
/// always-on `POST /api/usage/mem0-relevance` report below (feeds Settings →
/// Usage "mem0 recall relevance" in every build) sends the raw `top_score`
/// and does the SAME threshold comparison server-side, in
/// `crates/services/src/services/mem0_relevance.rs::WEAK_RELEVANCE_THRESHOLD`
/// (that crate can't depend on this one, hence two constants — keep both in
/// sync if this changes). Not a tuned/validated threshold, just a starting
/// point; see docs/ADR/ADR-030-mem0-context-drift-measurement.md.
#[cfg(debug_assertions)]
const WEAK_RELEVANCE_THRESHOLD: f64 = 0.3;

/// Debug-build-only development aid: warns when a `memory_search` call's
/// best hit looks weak (see [`WEAK_RELEVANCE_THRESHOLD`]), or when it has
/// hits but literally no score at all (shouldn't normally happen from
/// mem0-vk — still worth flagging if seen). Compiled out entirely for
/// `cargo build --release` (`cfg(debug_assertions)` is false there by
/// default, and this crate/workspace does not override it — see the root
/// `Cargo.toml`'s `[profile.release]`), so it costs nothing and never logs
/// in a shipped binary: purely a local-development signal for context
/// drift, not a production alerting mechanism.
#[cfg(debug_assertions)]
fn warn_if_weak_relevance(user_id: &str, query: &str, hit_count: usize, top_score: Option<f64>) {
    let weak = match top_score {
        Some(s) => s < WEAK_RELEVANCE_THRESHOLD,
        None => hit_count > 0,
    };
    if weak {
        tracing::warn!(
            target: "mem0",
            user_id,
            query,
            hits = hit_count,
            top_score = ?top_score,
            "memory_search: weak top relevance score — possible context drift (debug-build-only check, see ADR-030)"
        );
    }
}

/// Best-effort, fire-and-forget POST of one `memory_search` call's relevance
/// to the main VK server's `POST /api/usage/mem0-relevance` (a separate
/// process from this MCP server — see `crates/server/src/routes/usage.rs`),
/// feeding the Settings → Usage "mem0 recall relevance" panel. Spawned
/// rather than awaited inline: this must never add latency to the tool call
/// it's reporting on, and a failure here (VK API down, network hiccup) must
/// never surface to the agent — this is purely observability, unlike
/// `memory_search`'s own graceful-degradation behavior toward mem0 itself.
fn report_mem0_relevance(server_url: String, client: reqwest::Client, top_score: Option<f64>) {
    tokio::spawn(async move {
        let body = serde_json::json!({ "top_score": top_score });
        if let Err(e) = client.post(&server_url).json(&body).send().await {
            tracing::debug!(
                target: "mem0",
                error = %e,
                "failed to report mem0 relevance to VK API (non-fatal, purely observability)"
            );
        }
    });
}

/// mem0 is an OPTIONAL dependency (a separate Docker container the user may
/// not have running). A connection failure — as opposed to mem0 responding
/// with an error — almost always just means "not installed/not started",
/// not a bug worth repeating on every single tool call across a whole
/// session. Log it once per process at `warn`, then drop to `debug` for the
/// rest of that process's lifetime; every call still gracefully degrades
/// (empty search results / stored=false) rather than failing the tool call,
/// so an agent is never blocked by mem0 being absent.
static MEM0_UNREACHABLE_WARNED: AtomicBool = AtomicBool::new(false);

fn note_mem0_unreachable(op: &str, user_id: &str, error: &str) {
    if MEM0_UNREACHABLE_WARNED
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        tracing::warn!(
            target: "mem0",
            op,
            user_id,
            error,
            "mem0 unreachable — treating as not installed; degrading gracefully for the rest of this session (further occurrences logged at debug)"
        );
    } else {
        tracing::debug!(target: "mem0", op, user_id, error, "mem0 still unreachable");
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpMemorySearchRequest {
    #[schemars(
        description = "What to remember / search for, e.g. 'how does the pipeline stage tracker work?'. Scope it to the specific files/modules/area you're about to touch — never a broad or generic query."
    )]
    query: String,
    #[schemars(
        description = "Repo slug (e.g. 'vibe-kanban-alternative') to scope the search to that project's shared memory"
    )]
    user_id: String,
    #[schemars(
        description = "Max number of memories to return, ranked by relevance. Defaults to 5 — raise it only if you genuinely need more context."
    )]
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
struct McpMemorySearchResult {
    memories: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUnifiedSearchRequest {
    #[schemars(description = "Terms describing the card, chat, decision, or operation to find")]
    query: String,
    #[schemars(
        description = "Search scope: 'global' (default) searches the whole repository; use 'current' only when the user explicitly refers to this section/workspace"
    )]
    scope: Option<String>,
    #[schemars(description = "Optional issue/card ID for an exact card scope")]
    issue_id: Option<Uuid>,
    #[schemars(description = "Optional workspace ID for an exact workspace scope")]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Optional repository slug for mem0; defaults to the current repository"
    )]
    repo_id: Option<String>,
    #[schemars(description = "Maximum results per source (default 5, capped at 10)")]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
struct McpDatabaseSearchResult {
    source: String,
    execution_id: String,
    workspace_id: String,
    issue_id: Option<String>,
    created_at: String,
    prompt: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpUnifiedSearchResult {
    database: Vec<McpDatabaseSearchResult>,
    memories: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpMemorySaveRequest {
    #[schemars(
        description = "Self-contained, factual memory to persist. Only save VERIFIED, durable facts — never speculation."
    )]
    content: String,
    #[schemars(
        description = "Repo slug (e.g. 'vibe-kanban-alternative') to scope the memory to that project"
    )]
    user_id: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpMemorySaveResult {
    success: bool,
    /// `true` once mem0-vk has durably queued the save (Redis-backed BullMQ
    /// job) — NOT once the fact is actually extracted/embedded/stored, which
    /// now happens in a background worker after this call already returned.
    /// Kept as `stored` (rather than renamed to `queued`) for API stability.
    stored: bool,
}

/// Cap on `hops` a caller may request. mem0-vk's own `/graph/traverse` caps
/// at 3 server-side too (see `embeddings/app.py`'s `MAX_HOPS`) — this is
/// defense in depth, not the only limit.
const MAX_TRAVERSE_HOPS: u32 = 3;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpGraphTraverseRequest {
    #[schemars(
        description = "Entity name (or substring of one) to start the traversal from — typically a module/file/concept name surfaced by a prior memory_search hit, or a symbol you're about to touch. Matched by substring against node names/descriptions; if nothing matches, the result comes back empty."
    )]
    start: String,
    #[schemars(
        description = "Repo slug (e.g. 'vibe-kanban-alternative') to scope the traversal to that project's shared memory"
    )]
    user_id: String,
    #[schemars(
        description = "How many hops to follow outward from the start node. Defaults to 2; capped at 3 regardless of what you pass."
    )]
    #[serde(default)]
    hops: Option<u32>,
    #[schemars(
        description = "'out' = what depends on / is caused by `start` (follow subject->object edges); 'in' = what `start` depends on (follow object->subject edges); 'both' (default) = either direction. The graph is directed, so 'out' and 'in' are NOT symmetric — pick deliberately based on which direction you actually need."
    )]
    #[serde(default)]
    direction: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpGraphTraverseResult {
    /// Existing node(s) `start` matched to begin the traversal. Empty means
    /// no match — nothing else in this result is populated.
    matched_start_nodes: Vec<String>,
    /// "name (type): description" per node reached within `hops` steps.
    nodes: Vec<String>,
    /// "subject -[predicate]-> object" per edge among the reached nodes.
    relations: Vec<String>,
    /// True if mem0-vk's own node cap cut the traversal short.
    truncated: bool,
}

impl McpGraphTraverseResult {
    fn empty() -> Self {
        Self {
            matched_start_nodes: vec![],
            nodes: vec![],
            relations: vec![],
            truncated: false,
        }
    }
}

/// Cap on how many matching removed-diff lines `memory_check_staleness`
/// returns as evidence — enough to judge relevance without flooding the
/// agent's context (same "cap, don't dump" philosophy as `DEFAULT_SEARCH_
/// LIMIT`/`MAX_TRAVERSE_HOPS` above).
const MAX_STALENESS_EVIDENCE_LINES: usize = 5;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpCheckStalenessRequest {
    #[schemars(
        description = "Repo slug (e.g. 'vibe-kanban-alternative') to scope the check to that project's shared memory"
    )]
    user_id: String,
    #[schemars(
        description = "Entity name to check — e.g. one you saw in a memory_graph_traverse or memory_search result that looks old, vague, or unrelated to the code you're actually looking at."
    )]
    entity: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpCheckStalenessResult {
    /// False if the check itself couldn't run at all (mem0/graph down, no
    /// provenance recorded for this entity, VK API unreachable). Treat as
    /// "unknown," never as "confirmed fresh."
    checked: bool,
    /// The commit this entity was last reinforced at, if known.
    commit_sha: Option<String>,
    /// True if `commit_sha` still resolves in the current worktree. False
    /// (with `checked: true`) means history was rewritten since it was
    /// saved — freshness is unknown, not confirmed either way.
    commit_found: bool,
    /// True if text matching `entity` was found in REMOVED lines of the
    /// diff from `commit_sha` to HEAD — a strong signal, not proof (the
    /// same text could have been removed in one place and still exist
    /// elsewhere). False does not prove freshness — it only means this
    /// specific check found no removal evidence.
    likely_stale: bool,
    /// Matching removed-diff lines that triggered `likely_stale` (capped
    /// at `MAX_STALENESS_EVIDENCE_LINES`).
    evidence: Vec<String>,
}

impl McpCheckStalenessResult {
    fn not_checked() -> Self {
        Self {
            checked: false,
            commit_sha: None,
            commit_found: false,
            likely_stale: false,
            evidence: vec![],
        }
    }
}

#[derive(Debug, Deserialize)]
struct Mem0SearchResponse {
    #[serde(default)]
    vector: Vec<Mem0VectorHit>,
}

#[derive(Debug, Deserialize)]
struct Mem0PlatformSearchResponse {
    #[serde(default)]
    results: Vec<Mem0PlatformHit>,
}

#[derive(Debug, Deserialize)]
struct Mem0PlatformHit {
    #[serde(default)]
    memory: Option<String>,
    score: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct Mem0VectorHit {
    score: Option<f64>,
    payload: Option<Mem0Payload>,
}

#[derive(Debug, Deserialize)]
struct Mem0Payload {
    content: Option<String>,
}

/// Just the fields this file needs from the VK API's
/// `GET /api/workspaces/{id}/git/status` response — the full
/// `RepoBranchStatus` type lives in the `server` crate, which `mcp` doesn't
/// depend on, so this mirrors it locally (same pattern as `Mem0SearchResponse`
/// et al. for mem0-vk's own responses).
#[derive(Debug, Deserialize)]
struct WorkspaceRepoGitStatus {
    repo_id: Uuid,
    head_oid: Option<String>,
}

/// Just the fields this file needs from the VK API's
/// `GET /api/workspaces/{id}/git/diff-since` response — the full
/// `DiffSinceResponse` type lives in the `server` crate; see
/// `WorkspaceRepoGitStatus` above for why this mirrors rather than imports.
#[derive(Debug, Deserialize)]
struct DiffSinceResponse {
    #[serde(default)]
    removed_text: String,
    #[serde(default)]
    commit_found: bool,
}

#[derive(Debug, Deserialize)]
struct Mem0TraverseNode {
    id: String,
    #[serde(rename = "type")]
    node_type: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    commit_sha: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Mem0TraverseEdge {
    subject: String,
    predicate: String,
    object: String,
    #[serde(default)]
    commit_sha: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Mem0TraverseResponse {
    #[serde(default)]
    matched_start_nodes: Vec<String>,
    #[serde(default)]
    nodes: Vec<Mem0TraverseNode>,
    #[serde(default)]
    edges: Vec<Mem0TraverseEdge>,
    #[serde(default)]
    truncated: bool,
}

/// Personal/local Mem0 enqueues `POST /api/memories` (202 Accepted), while a
/// hosted Free account calls `POST /api/memories/index` for direct vector
/// indexing. Neither response needs polling from the calling agent.
#[derive(Debug, Deserialize)]
struct Mem0SaveResponse {
    ok: Option<bool>,
    queued: Option<bool>,
    vector_only: Option<bool>,
    #[allow(dead_code)]
    job_id: Option<String>,
}

impl McpServer {
    /// Enqueue a memory write and return whether Mem0 acknowledged it. Normal
    /// `memory_save` remains best-effort, while card completion uses this
    /// helper as a hard gate before it marks the card Done.
    pub(crate) async fn save_memory_for_completion(
        &self,
        content: &str,
        user_id: &str,
    ) -> Result<bool, ErrorData> {
        if !memory_enabled() {
            tracing::debug!(target: "mem0", user_id, "memory_save skipped because memory is disabled");
            return Ok(false);
        }
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let commit_sha = if using_mem0_platform() {
            None
        } else {
            self.resolve_commit_sha(user_id).await
        };
        let (url, body) = if using_mem0_platform() {
            let mut body = serde_json::json!({
                "messages": [{ "role": "user", "content": content }],
                "user_id": user_id,
            });
            if let Some(commit_sha) = commit_sha {
                body["metadata"] = serde_json::json!({ "commit_sha": commit_sha });
            }
            (format!("{}/v3/memories/add/", mem0_url()), body)
        } else {
            (
                format!(
                    "{}/api/memories{}",
                    mem0_url(),
                    if using_cloud_vector_only() {
                        "/index"
                    } else {
                        ""
                    }
                ),
                serde_json::json!({
                    "content": content,
                    "user_id": user_id,
                    "commit_sha": commit_sha,
                }),
            )
        };

        let resp = match authorize_mem0(client.post(&url)).json(&body).send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                tracing::warn!(
                    target: "mem0",
                    user_id,
                    status = %response.status(),
                    "memory_save: mem0 responded with a non-success status"
                );
                return Ok(false);
            }
            Err(error) => {
                note_mem0_unreachable("memory_save", user_id, &error.to_string());
                return Ok(false);
            }
        };

        if using_mem0_platform() {
            // Mem0 Platform queues extraction and returns an event_id. A 2xx
            // response is the durable acknowledgement available to this tool.
            return Ok(true);
        }

        let parsed: Mem0SaveResponse = match resp.json().await {
            Ok(parsed) => parsed,
            Err(error) => {
                tracing::warn!(
                    target: "mem0",
                    user_id,
                    error = %error,
                    "memory_save: unparseable mem0 response"
                );
                return Ok(false);
            }
        };
        let stored = parsed.queued.unwrap_or(false) || parsed.vector_only.unwrap_or(false);
        let success = parsed.ok.unwrap_or(true);
        if !(success && stored) {
            tracing::warn!(target: "mem0", user_id, success, stored, "memory_save was not queued");
        }
        Ok(success && stored)
    }

    /// Best-effort resolution of the calling workspace's current HEAD commit
    /// for the repo matching `user_id` (a repo slug — see ADR-028's
    /// multi-repo scoping addendum). `None` on ANY failure — no context, no
    /// matching repo, VK API unreachable, no `head_oid` yet (e.g. a fresh
    /// worktree with no commits) — `memory_save` must still succeed without
    /// provenance rather than fail the tool call over this. See
    /// docs/ADR/ADR-030-mem0-context-drift-measurement.md.
    async fn resolve_commit_sha(&self, user_id: &str) -> Option<String> {
        let (workspace_id, repo_id) = self.resolve_workspace_repo(user_id)?;
        let url = self.url(&format!("/api/workspaces/{}/git/status", workspace_id));
        let statuses: Vec<WorkspaceRepoGitStatus> =
            self.send_json(self.client.get(&url)).await.ok()?;
        statuses
            .into_iter()
            .find(|s| s.repo_id == repo_id)
            .and_then(|s| s.head_oid)
    }

    /// Resolves `user_id` (a repo slug) to `(workspace_id, repo_id)` from
    /// the current MCP session's context — shared by `resolve_commit_sha`
    /// and `memory_check_staleness`. `None` if there's no context, or
    /// `user_id` doesn't match any repo in this workspace (see ADR-028's
    /// multi-repo scoping addendum — `user_id` is chosen per-call by the
    /// agent, not fixed per-session).
    fn resolve_workspace_repo(&self, user_id: &str) -> Option<(Uuid, Uuid)> {
        let context = self.context.as_ref()?;
        let repo = context
            .workspace_repos
            .iter()
            .find(|r| r.repo_name == user_id)?;
        Some((context.workspace_id, repo.repo_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_response_maps_to_the_existing_memory_shape() {
        let response: Mem0PlatformSearchResponse = serde_json::from_value(serde_json::json!({
            "results": [{ "id": "memory-1", "memory": "Uses Qdrant", "score": 0.82 }]
        }))
        .expect("valid Mem0 Platform response");

        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].memory.as_deref(), Some("Uses Qdrant"));
        assert_eq!(response.results[0].score, Some(0.82));
    }
}

#[tool_router(router = mem0_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "Search the project's operation history and mem0 with one compact call. Use this for questions about cards, chats, changes, decisions, or work already performed. The default scope is global across the repository; use scope='current' only when the user explicitly refers to this section/workspace, or pass issue_id/workspace_id for an exact scope. The database provides exact execution facts; mem0 provides related semantic context. Results are capped per source and intentionally omit full transcripts to save tokens."
    )]
    async fn search_workspace(
        &self,
        Parameters(request): Parameters<McpUnifiedSearchRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = request.limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, 10);
        let use_current_scope = request.scope.as_deref() == Some("current");
        let workspace_id = request.workspace_id.or_else(|| {
            use_current_scope
                .then(|| self.scoped_workspace_id())
                .flatten()
        });
        let issue_id = request.issue_id.or_else(|| {
            use_current_scope
                .then(|| self.context.as_ref().and_then(|context| context.issue_id))
                .flatten()
        });
        let query = request.query;
        let repo_id = request.repo_id.or_else(|| {
            self.context
                .as_ref()
                .and_then(|context| context.workspace_repos.first())
                .map(|repo| repo.repo_name.clone())
        });

        let database = self
            .client
            .post(self.url("/api/search/agent-history"))
            .json(&serde_json::json!({
                "q": query.clone(),
                "issue_id": issue_id,
                "workspace_id": workspace_id,
                "limit": limit,
            }))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
            .json::<crate::ApiResponseEnvelope<Vec<McpDatabaseSearchResult>>>()
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
            .data
            .unwrap_or_default();

        let memories = if let Some(user_id) = repo_id {
            let result = self
                .memory_search(Parameters(McpMemorySearchRequest {
                    query: query.to_string(),
                    user_id,
                    limit: Some(limit),
                }))
                .await?;
            result
                .content
                .first()
                .and_then(|content| content.as_text())
                .and_then(|content| {
                    serde_json::from_str::<McpMemorySearchResult>(&content.text).ok()
                })
                .map(|result| result.memories)
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        McpServer::success_compact(&McpUnifiedSearchResult { database, memories })
    }

    /// Search the project's shared mem0 memory for facts relevant to a query.
    /// Returns ranked, deduplicated memory contents. Best-effort: mem0 is an
    /// optional dependency, so any failure (unreachable, bad status,
    /// unparseable response) degrades to an empty list instead of failing
    /// the tool call — a missing/misbehaving mem0 must never block an agent.
    #[tool(
        description = "Search the project's shared memory (mem0) for facts relevant to a query. Use this BEFORE analyzing code or starting work to recall decisions, conventions, and lessons the project already learned. Returns at most `limit` hits (default 5) — a small, cheap call. If the results don't cover what you need, call this again with a narrower or differently-worded query rather than raising `limit`; iterating with a sharper query beats fetching more of a vague one. mem0 is optional — if it isn't running, this returns an empty list rather than an error."
    )]
    async fn memory_search(
        &self,
        Parameters(McpMemorySearchRequest {
            query,
            user_id,
            limit,
        }): Parameters<McpMemorySearchRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);

        if !memory_enabled() {
            return McpServer::success(&McpMemorySearchResult { memories: vec![] });
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let (url, body) = if using_mem0_platform() {
            (
                format!("{}/v3/memories/search/", mem0_url()),
                serde_json::json!({
                    "query": query,
                    "filters": { "user_id": user_id },
                    "top_k": limit,
                }),
            )
        } else {
            // `limit` is sent as a best-effort hint for servers that honor it;
            // the client-side sort+truncate below is what actually guarantees
            // the cap regardless of server support.
            (
                format!("{}/api/search", mem0_url()),
                serde_json::json!({ "query": query, "user_id": user_id, "limit": limit }),
            )
        };

        let resp = match authorize_mem0(client.post(&url)).json(&body).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                tracing::warn!(
                    target: "mem0",
                    user_id = %user_id,
                    status = %r.status(),
                    "memory_search: mem0 responded with a non-success status; degrading to empty results"
                );
                return McpServer::success(&McpMemorySearchResult { memories: vec![] });
            }
            Err(e) => {
                note_mem0_unreachable("memory_search", &user_id, &e.to_string());
                return McpServer::success(&McpMemorySearchResult { memories: vec![] });
            }
        };

        let mut hits: Vec<Mem0VectorHit> = if using_mem0_platform() {
            match resp.json::<Mem0PlatformSearchResponse>().await {
                Ok(parsed) => parsed
                    .results
                    .into_iter()
                    .map(|hit| Mem0VectorHit {
                        score: hit.score,
                        payload: Some(Mem0Payload {
                            content: hit.memory,
                        }),
                    })
                    .collect(),
                Err(e) => {
                    tracing::warn!(
                        target: "mem0",
                        user_id = %user_id,
                        error = %e,
                        "memory_search: unparseable Mem0 Platform response; degrading to empty results"
                    );
                    return McpServer::success(&McpMemorySearchResult { memories: vec![] });
                }
            }
        } else {
            match resp.json::<Mem0SearchResponse>().await {
                Ok(parsed) => parsed.vector,
                Err(e) => {
                    tracing::warn!(
                        target: "mem0",
                        user_id = %user_id,
                        error = %e,
                        "memory_search: unparseable mem0 response; degrading to empty results"
                    );
                    return McpServer::success(&McpMemorySearchResult { memories: vec![] });
                }
            }
        };

        // Rank by score (higher = more relevant; unscored hits sort last),
        // dedupe by content keeping the best-ranked occurrence, then cap to
        // `limit` — a vague query must not flood the agent's context.
        hits.sort_by(|a, b| {
            b.score
                .unwrap_or(f64::MIN)
                .total_cmp(&a.score.unwrap_or(f64::MIN))
        });

        let mut seen = std::collections::HashSet::new();
        // Scores of the hits that actually made it into `memories`, in rank
        // order — used below to log a drift/relevance signal alongside the
        // hit count (see docs/ADR/ADR-030-mem0-context-drift-measurement.md).
        let mut scores: Vec<f64> = Vec::new();
        let memories: Vec<String> = hits
            .into_iter()
            .filter_map(|hit| {
                let content = hit.payload?.content?;
                Some((content, hit.score))
            })
            .filter(|(content, _)| seen.insert(content.clone()))
            .take(limit)
            .map(|(content, score)| {
                if let Some(s) = score {
                    scores.push(s);
                }
                content
            })
            .collect();

        // Highest-ranked hit's score and the mean over all returned hits —
        // a cheap proxy for how relevant this batch actually was. A low
        // top_score means the agent's next stage is working from weakly
        // related (or no) memory: the raw signal for measuring context
        // drift across a stage handoff.
        let top_score = scores.first().copied();
        let avg_score = if scores.is_empty() {
            None
        } else {
            Some(scores.iter().sum::<f64>() / scores.len() as f64)
        };

        // Debug-build-only: a step up from the info-level score log above —
        // flags a call whose top hit looks weak enough to plausibly be
        // context drift, at `warn` so it stands out in a dev console. Gated
        // on `cfg(debug_assertions)` (true for `cargo build`/`check`/`test`,
        // false for `cargo build --release` — no Cargo.toml override here,
        // see `[profile.release]`), so this never compiles into, runs in, or
        // logs from a release binary: a local development aid, not a
        // production alerting mechanism. See
        // docs/ADR/ADR-030-mem0-context-drift-measurement.md.
        #[cfg(debug_assertions)]
        warn_if_weak_relevance(&user_id, &query, memories.len(), top_score);

        report_mem0_relevance(
            self.url("/api/usage/mem0-relevance"),
            self.client.clone(),
            top_score,
        );

        tracing::info!(
            target: "mem0",
            user_id = %user_id,
            query = %query,
            hits = memories.len(),
            top_score = ?top_score,
            avg_score = ?avg_score,
            "memory_search ok"
        );

        McpServer::success(&McpMemorySearchResult { memories })
    }

    /// Save a fact to the project's shared mem0 memory. Only persist VERIFIED,
    /// durable, self-contained facts (decisions, conventions, root causes) —
    /// never speculation or unverified claims, so future agents do not pick up
    /// false memories. Best-effort: mem0 is an optional dependency, so any
    /// failure degrades to `stored: false` instead of failing the tool call.
    #[tool(
        description = "Save a verified, durable fact to the project's shared memory (mem0). Best-effort: returns stored=false when mem0 is unreachable or misbehaving, rather than an error — mem0 is optional."
    )]
    async fn memory_save(
        &self,
        Parameters(McpMemorySaveRequest { content, user_id }): Parameters<McpMemorySaveRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let stored = self.save_memory_for_completion(&content, &user_id).await?;
        let success = stored;
        McpServer::success(&McpMemorySaveResult { success, stored })
    }

    /// Multi-hop traversal of the project's mem0 knowledge graph from a
    /// named entity. Complements `memory_search` (semantic similarity to a
    /// query) with actual graph structure — use it once you already have a
    /// specific entity name and want its neighborhood, not just text that
    /// reads similarly. Best-effort, same graceful-degradation contract as
    /// `memory_search`/`memory_save` — mem0/graph absence degrades to an
    /// empty result, never a failed tool call. See
    /// docs/ADR/ADR-030-mem0-context-drift-measurement.md.
    #[tool(
        description = "Traverse the project's mem0 knowledge graph from a named entity (module, file, concept) outward up to `hops` steps (default 2, max 3), following relation edges. Unlike memory_search (semantic similarity to a query), this follows actual graph structure: direction 'out' = what depends on/is caused by `start`; 'in' = what `start` depends on; 'both' (default) = either. Use this once you already have a specific entity name — e.g. from a prior memory_search hit, or a module/file you're about to touch — and want its neighborhood, not just semantically similar text. `start` is matched by substring against node names/descriptions; no match returns an empty result. Optional — mem0/graph absence degrades to empty, not an error."
    )]
    async fn memory_graph_traverse(
        &self,
        Parameters(McpGraphTraverseRequest {
            start,
            user_id,
            hops,
            direction,
        }): Parameters<McpGraphTraverseRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let hops = hops.unwrap_or(2).min(MAX_TRAVERSE_HOPS);
        let direction = direction.unwrap_or_else(|| "both".to_string());

        // Mem0 Platform's managed API does not expose the custom graph
        // traversal contract used by mem0-vk.
        if !memory_enabled() || using_mem0_platform() {
            return McpServer::success(&McpGraphTraverseResult::empty());
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let url = format!("{}/api/graph/traverse", mem0_url());
        let body = serde_json::json!({
            "start": start,
            "user_id": user_id,
            "hops": hops,
            "direction": direction,
        });

        let resp = match authorize_mem0(client.post(&url)).json(&body).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                tracing::warn!(
                    target: "mem0",
                    user_id = %user_id,
                    status = %r.status(),
                    "memory_graph_traverse: mem0 responded with a non-success status; degrading to empty result"
                );
                return McpServer::success(&McpGraphTraverseResult::empty());
            }
            Err(e) => {
                note_mem0_unreachable("memory_graph_traverse", &user_id, &e.to_string());
                return McpServer::success(&McpGraphTraverseResult::empty());
            }
        };

        let parsed: Mem0TraverseResponse = match resp.json().await {
            Ok(parsed) => parsed,
            Err(e) => {
                tracing::warn!(
                    target: "mem0",
                    user_id = %user_id,
                    error = %e,
                    "memory_graph_traverse: unparseable mem0 response; degrading to empty result"
                );
                return McpServer::success(&McpGraphTraverseResult::empty());
            }
        };

        tracing::info!(
            target: "mem0",
            user_id = %user_id,
            start = %start,
            hops,
            matched = parsed.matched_start_nodes.len(),
            nodes = parsed.nodes.len(),
            edges = parsed.edges.len(),
            truncated = parsed.truncated,
            "memory_graph_traverse ok"
        );

        McpServer::success(&McpGraphTraverseResult {
            matched_start_nodes: parsed.matched_start_nodes,
            nodes: parsed
                .nodes
                .into_iter()
                .map(|n| {
                    // Short commit prefix (7 chars, git's own convention) when
                    // provenance is known — pass this to memory_check_staleness
                    // as `commit_sha` if a node here looks suspicious (old,
                    // vague, unrelated to your current task).
                    let commit_suffix = n
                        .commit_sha
                        .as_deref()
                        .map(|c| format!(" [commit {}]", &c[..c.len().min(7)]))
                        .unwrap_or_default();
                    if n.description.is_empty() {
                        format!("{} ({}){}", n.id, n.node_type, commit_suffix)
                    } else {
                        format!(
                            "{} ({}){}: {}",
                            n.id, n.node_type, commit_suffix, n.description
                        )
                    }
                })
                .collect(),
            relations: parsed
                .edges
                .into_iter()
                .map(|e| {
                    let commit_suffix = e
                        .commit_sha
                        .as_deref()
                        .map(|c| format!(" [commit {}]", &c[..c.len().min(7)]))
                        .unwrap_or_default();
                    format!(
                        "{} -[{}]-> {}{}",
                        e.subject, e.predicate, e.object, commit_suffix
                    )
                })
                .collect(),
            truncated: parsed.truncated,
        })
    }

    /// Checks whether a named graph entity is likely stale — i.e. the code
    /// it refers to was removed since the fact/entity was saved. Uses the
    /// entity's own stored `commit_sha` (provenance captured at
    /// `memory_save` time) and the VK API's `git/diff-since` route to look
    /// for the entity's name in text REMOVED between that commit and HEAD.
    /// This is what would have caught the `VK-MEMORY`/`LazyLock`/`Regex`
    /// nodes still present in this repo's own project memory after
    /// ADR-028 removed the mechanism they describe — see
    /// docs/ADR/ADR-030-mem0-context-drift-measurement.md.
    #[tool(
        description = "Check whether a graph entity (from a prior memory_graph_traverse or memory_search result) is likely STALE — the code it refers to may have been removed since the fact was saved. Looks up the entity's stored commit_sha (provenance captured at memory_save time), diffs the repo from that commit to HEAD, and checks whether text matching the entity name appears in REMOVED lines. checked=false means the check itself couldn't run (no provenance recorded, mem0/graph down, VK API unreachable) — treat that as 'unknown,' never as 'confirmed fresh.' Use this before relying on an old-looking or suspicious node surfaced by memory_graph_traverse."
    )]
    async fn memory_check_staleness(
        &self,
        Parameters(McpCheckStalenessRequest { user_id, entity }): Parameters<
            McpCheckStalenessRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        if !memory_enabled() || using_mem0_platform() {
            return McpServer::success(&McpCheckStalenessResult::not_checked());
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        // 1. Look up the entity's own stored commit_sha via a 1-hop
        //    traverse — the start node itself is always included in the
        //    result, so hops=1 is just the cheapest valid call.
        let traverse_url = format!("{}/api/graph/traverse", mem0_url());
        let traverse_body = serde_json::json!({
            "start": entity,
            "user_id": user_id,
            "hops": 1,
            "direction": "out",
        });
        let traverse_resp = match authorize_mem0(client.post(&traverse_url))
            .json(&traverse_body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                tracing::warn!(
                    target: "mem0",
                    user_id = %user_id,
                    entity = %entity,
                    status = %r.status(),
                    "memory_check_staleness: graph traverse lookup failed; degrading to checked=false"
                );
                return McpServer::success(&McpCheckStalenessResult::not_checked());
            }
            Err(e) => {
                note_mem0_unreachable("memory_check_staleness", &user_id, &e.to_string());
                return McpServer::success(&McpCheckStalenessResult::not_checked());
            }
        };
        let traverse: Mem0TraverseResponse = match traverse_resp.json().await {
            Ok(t) => t,
            Err(_) => return McpServer::success(&McpCheckStalenessResult::not_checked()),
        };
        let Some(commit_sha) = traverse
            .nodes
            .iter()
            .find(|n| traverse.matched_start_nodes.contains(&n.id))
            .and_then(|n| n.commit_sha.clone())
        else {
            // No matching node, or it has no recorded provenance (saved
            // before commit_sha tracking existed) — genuinely can't check.
            return McpServer::success(&McpCheckStalenessResult::not_checked());
        };

        // 2. Diff the repo from that commit to HEAD.
        let Some((workspace_id, repo_id)) = self.resolve_workspace_repo(&user_id) else {
            return McpServer::success(&McpCheckStalenessResult::not_checked());
        };
        let diff_url = self.url(&format!(
            "/api/workspaces/{workspace_id}/git/diff-since?repo_id={repo_id}&commit_sha={commit_sha}"
        ));
        let diff: DiffSinceResponse = match self.send_json(self.client.get(&diff_url)).await {
            Ok(d) => d,
            Err(_) => return McpServer::success(&McpCheckStalenessResult::not_checked()),
        };
        if !diff.commit_found {
            return McpServer::success(&McpCheckStalenessResult {
                checked: true,
                commit_sha: Some(commit_sha),
                commit_found: false,
                likely_stale: false,
                evidence: vec![],
            });
        }

        // 3. Search removed lines for the entity name.
        let needle = entity.to_lowercase();
        let evidence: Vec<String> = diff
            .removed_text
            .lines()
            .filter(|l| l.to_lowercase().contains(&needle))
            .take(MAX_STALENESS_EVIDENCE_LINES)
            .map(|l| l.to_string())
            .collect();
        let likely_stale = !evidence.is_empty();

        tracing::info!(
            target: "mem0",
            user_id = %user_id,
            entity = %entity,
            commit_sha = %commit_sha,
            likely_stale,
            "memory_check_staleness ok"
        );

        McpServer::success(&McpCheckStalenessResult {
            checked: true,
            commit_sha: Some(commit_sha),
            commit_found: true,
            likely_stale,
            evidence,
        })
    }
}
