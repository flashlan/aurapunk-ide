//! Context export and local dispatch endpoints consumed by the Mobile/Cloud
//! sync path. The local server never trusts a browser-supplied account id for
//! authorization and remains the only component allowed to start an executor.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use api_types::{CreateIssueRequest, IssuePriority, UpdateIssueRequest};
use axum::{
    Json, Router,
    extract::{Path, State, ws::Message},
    http::HeaderMap,
    response::{IntoResponse, Json as ResponseJson, Response},
    routing::{get, patch, post},
};
use base64::Engine;
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::ExecutionProcess,
    file::WorkspaceAttachment,
    issue::Issue,
    issue_workspace::IssueWorkspace,
    kanban_tag::{IssueTag as DbIssueTag, KanbanTag},
    project::Project,
    project_repo::ProjectRepo,
    project_status::ProjectStatus,
    repo::Repo,
    requests::{CreateAndStartWorkspaceRequest, LinkedIssueInfo, WorkspaceRepoInput},
    scratch::{Scratch, ScratchPayload, ScratchType, UpdateScratch, WorkspaceChatConfigData},
    session::{CreateSession, Session},
    workspace::{Workspace, WorkspaceKind},
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::model_selector::PermissionPolicy;
use executors::{
    executors::BaseCodingAgent,
    logs::{NormalizedEntry, NormalizedEntryType, utils::patch::ConversationPatch},
    profile::{ExecutorConfig, ExecutorConfigs},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::pipelines::load_pipelines;
use sqlx::Row;
use utils::log_msg::LogMsg;
use utils::path::pipelines_dir;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
    routes::{instance, local_kanban},
};

#[derive(Debug, Clone, Serialize)]
pub struct MobileSyncRecord {
    pub entity_type: &'static str,
    pub entity_id: String,
    pub operation: &'static str,
    pub payload: Value,
}

#[derive(Debug, Serialize)]
pub struct MobileContextResponse {
    pub records: Vec<MobileSyncRecord>,
}

#[derive(Debug, Deserialize)]
pub struct MobileChatCommand {
    pub workspace_id: Uuid,
    pub prompt: String,
    pub executor: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub reasoning_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub permission_policy: Option<PermissionPolicy>,
    #[serde(default)]
    pub attachments: Vec<MobileChatAttachment>,
}

#[derive(Debug, Deserialize)]
pub struct MobileChatAttachment {
    pub file_name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Deserialize)]
pub struct MobileWorkspaceRequest {
    pub issue_id: Uuid,
    pub executor: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub reasoning_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub permission_policy: Option<PermissionPolicy>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub pipeline_id: Option<String>,
    #[serde(default)]
    pub pipeline_stage_ids: Vec<String>,
    #[serde(default)]
    pub pre_prompt: Option<String>,
    #[serde(default)]
    pub post_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CloudImportRequest {
    #[serde(default)]
    pub records: Vec<CloudImportRecord>,
}

#[derive(Debug, Deserialize)]
pub struct CloudImportRecord {
    #[serde(alias = "entityType")]
    pub entity_type: String,
    #[serde(alias = "entityId")]
    pub entity_id: String,
    pub operation: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
struct CloudIssueWorkspacePayload {
    issue_id: Uuid,
    workspace_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct CloudSessionPayload {
    id: Uuid,
    workspace_id: Uuid,
    name: Option<String>,
    executor: Option<String>,
    agent_working_dir: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
struct CloudExecutionPayload {
    id: Uuid,
    session_id: Uuid,
    run_reason: String,
    status: String,
    exit_code: Option<i64>,
    started_at: chrono::DateTime<chrono::Utc>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
struct CloudTurnPayload {
    id: Uuid,
    execution_process_id: Uuid,
    agent_session_id: Option<String>,
    agent_message_id: Option<String>,
    seen: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
struct CloudWorkspaceContextPayload {
    workspace_id: Uuid,
    #[serde(default)]
    sessions: Vec<CloudSessionPayload>,
    #[serde(default)]
    executions: Vec<CloudExecutionPayload>,
    #[serde(default)]
    turns: Vec<CloudTurnPayload>,
}

#[derive(Debug, Deserialize)]
struct CloudChatPayload {
    id: Uuid,
    workspace_id: Uuid,
    prompt: Option<String>,
    summary: Option<String>,
    agent_session_id: Option<String>,
    agent_message_id: Option<String>,
    seen: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
struct CloudImportSummary {
    imported: usize,
    skipped: usize,
}

#[derive(Debug, Deserialize)]
pub struct LocalPairingInviteRequest {
    /// LAN-reachable base URLs, for example Wi-Fi, Ethernet, or WireGuard
    /// addresses. The Desktop detects these before creating the invite.
    #[serde(default)]
    pub endpoints: Vec<String>,
    /// Kept for compatibility with older Desktop clients that sent one URL.
    #[serde(default)]
    pub endpoint: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LocalPairingInviteResponse {
    pub pairing_url: String,
    pub invite_id: Uuid,
    pub instance_id: String,
    pub endpoint: String,
    pub endpoints: Vec<String>,
    pub expires_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct LocalPairingClaimRequest {
    pub invite_id: Uuid,
    pub secret: String,
    /// The endpoint that successfully reached this Desktop. This lets the
    /// response preserve the working Wi-Fi/LAN/WireGuard route when the QR
    /// contains more than one candidate.
    #[serde(default)]
    pub endpoint: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LocalPairingClaimResponse {
    pub instance_id: String,
    pub name: String,
    pub endpoint: String,
    pub direct_token: String,
    pub transport: &'static str,
}

#[derive(Debug, Clone)]
struct LocalPairingInvite {
    secret: String,
    instance_id: String,
    endpoints: Vec<String>,
    expires_at: u64,
}

static LOCAL_PAIRING_INVITES: OnceLock<Mutex<HashMap<Uuid, LocalPairingInvite>>> = OnceLock::new();

fn local_pairing_invites() -> &'static Mutex<HashMap<Uuid, LocalPairingInvite>> {
    LOCAL_PAIRING_INVITES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

static BOARD_EVENTS: OnceLock<tokio::sync::broadcast::Sender<String>> = OnceLock::new();

fn board_events() -> &'static tokio::sync::broadcast::Sender<String> {
    BOARD_EVENTS.get_or_init(|| {
        let (tx, _) = tokio::sync::broadcast::channel(256);
        tx
    })
}

pub fn broadcast_board_event(event: Value) {
    if let Ok(json_str) = serde_json::to_string(&event) {
        let _ = board_events().send(json_str);
    }
}

fn parse_rules_pre_post(raw: &str) -> (String, String) {
    const PRE_START: &str = "<!-- vk:rules:pre:start -->";
    const PRE_END: &str = "<!-- vk:rules:pre:end -->";
    const POST_START: &str = "<!-- vk:rules:post:start -->";
    const POST_END: &str = "<!-- vk:rules:post:end -->";

    let mut pre = String::new();
    let mut post = String::new();

    if let (Some(pre_s), Some(pre_e)) = (raw.find(PRE_START), raw.find(PRE_END))
        && pre_s + PRE_START.len() <= pre_e
    {
        pre = raw[pre_s + PRE_START.len()..pre_e].trim().to_string();
    }

    if let (Some(post_s), Some(post_e)) = (raw.find(POST_START), raw.find(POST_END))
        && post_s + POST_START.len() <= post_e
    {
        post = raw[post_s + POST_START.len()..post_e].trim().to_string();
    }

    if pre.is_empty() && post.is_empty() && !raw.trim().is_empty() {
        pre = raw.trim().to_string();
    }

    (pre, post)
}

/// Ultra-fast batch fetch for the Kanban board and mobile cockpit.
/// Avoids N+1 queries across sessions/execution processes/turns and
/// packages pipelines, pre/post prompt rules, and available models.
pub async fn get_kanban_context(
    deployment: &DeploymentImpl,
) -> Result<ResponseJson<ApiResponse<MobileContextResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let mut records = Vec::new();

    // 1. Instance descriptor
    let node = instance::describe(deployment);
    records.push(MobileSyncRecord {
        entity_type: "instance",
        entity_id: node.instance_id.clone(),
        operation: "upsert",
        payload: serde_json::to_value(node)
            .map_err(|error| ApiError::BadRequest(error.to_string()))?,
    });

    // 2. Pipelines catalog
    for pipeline in load_pipelines(&pipelines_dir()) {
        records.push(MobileSyncRecord {
            entity_type: "pipeline",
            entity_id: pipeline.id.clone(),
            operation: "upsert",
            payload: serde_json::json!({
                "id": pipeline.id,
                "name": pipeline.name,
                "description": pipeline.description,
                "stages": pipeline.stages.iter().map(|stage| serde_json::json!({
                    "id": stage.id,
                    "label": stage.label,
                    "default_enabled": stage.default_enabled,
                    "prompt_fragment": stage.prompt_fragment,
                })).collect::<Vec<_>>(),
            }),
        });
    }

    // 3. Executor & model options catalog
    let (global_pre, global_post) = {
        let config = deployment.config().read().await;
        (
            config.general_rules_pre.clone().unwrap_or_default(),
            config.general_rules_post.clone().unwrap_or_default(),
        )
    };

    let executors_catalog = vec![
        (
            "CODEX",
            BaseCodingAgent::Codex,
            vec![
                ("gpt-4o", "GPT-4o", "OpenAI"),
                ("gpt-4.5-preview", "GPT-4.5 Preview", "OpenAI"),
                ("o1", "o1 (Reasoning)", "OpenAI"),
                ("o3-mini", "o3-mini", "OpenAI"),
            ],
        ),
        (
            "CLAUDE_CODE",
            BaseCodingAgent::ClaudeCode,
            vec![
                (
                    "claude-3-7-sonnet",
                    "Claude 3.7 Sonnet (Hybrid)",
                    "Anthropic",
                ),
                ("claude-3-5-sonnet", "Claude 3.5 Sonnet", "Anthropic"),
                ("claude-3-5-haiku", "Claude 3.5 Haiku", "Anthropic"),
            ],
        ),
        (
            "GEMINI",
            BaseCodingAgent::Gemini,
            vec![
                ("gemini-2.5-pro", "Gemini 2.5 Pro", "Google"),
                ("gemini-2.5-flash", "Gemini 2.5 Flash", "Google"),
                ("gemini-2.0-pro-exp", "Gemini 2.0 Pro Exp", "Google"),
                ("gemini-2.0-flash", "Gemini 2.0 Flash", "Google"),
            ],
        ),
        (
            "OPENCODE",
            BaseCodingAgent::Opencode,
            vec![
                ("deepseek-r1", "DeepSeek R1", "DeepSeek"),
                ("deepseek-v3", "DeepSeek V3", "DeepSeek"),
                ("qwen-2.5-coder-32b", "Qwen 2.5 Coder 32B", "Alibaba"),
                ("llama-3.3-70b", "Llama 3.3 70B", "Meta"),
            ],
        ),
        (
            "ANTIGRAVITY",
            BaseCodingAgent::Antigravity,
            vec![
                ("gemini-2.5-pro", "Gemini 2.5 Pro (Thinking)", "Google"),
                ("gemini-2.5-flash", "Gemini 2.5 Flash", "Google"),
                ("claude-3-7-sonnet", "Claude 3.7 Sonnet", "Anthropic"),
            ],
        ),
        (
            "AMP",
            BaseCodingAgent::Amp,
            vec![("amp-default", "AMP Agent Default", "AMP")],
        ),
    ];

    for (exec_id, agent_kind, fallback_models) in executors_catalog {
        // Full discovered selector (models + reasoning, providers, agent
        // modes, permissions, default model) so mobile can render the same
        // CLI -> provider -> model -> effort hierarchy as Desktop.
        let selector =
            crate::routes::config::discover_selector_for_agent(deployment, agent_kind).await;
        // Preset variants (DEFAULT, PLAN, ...) registered for this executor.
        let presets: Vec<String> = ExecutorConfigs::get_cached()
            .executors
            .get(&agent_kind)
            .map(|profile| {
                let mut keys: Vec<String> = profile.configurations.keys().cloned().collect();
                keys.sort();
                keys
            })
            .unwrap_or_default();

        let (models_json, providers_json, agents_json, permissions_json, default_model_json) =
            match selector.filter(|s| {
                !s.model_selector.models.is_empty()
                    || !s.model_selector.agents.is_empty()
                    || !s.model_selector.providers.is_empty()
            }) {
                Some(opts) => {
                    let models: Vec<Value> = opts
                        .model_selector
                        .models
                        .into_iter()
                        .map(|m| {
                            serde_json::json!({
                                "id": m.id,
                                "name": m.name,
                                "provider": m.provider_id.unwrap_or_else(|| "Default".to_string()),
                                "reasoning_options": m.reasoning_options.iter().map(|r| serde_json::json!({
                                    "id": r.id,
                                    "label": r.label,
                                    "is_default": r.is_default,
                                })).collect::<Vec<_>>(),
                            })
                        })
                        .collect();
                    (
                        models,
                        serde_json::to_value(&opts.model_selector.providers)
                            .unwrap_or(Value::Array(vec![])),
                        serde_json::to_value(&opts.model_selector.agents)
                            .unwrap_or(Value::Array(vec![])),
                        serde_json::to_value(&opts.model_selector.permissions)
                            .unwrap_or(Value::Array(vec![])),
                        opts.model_selector
                            .default_model
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    )
                }
                None => (
                    fallback_models
                        .into_iter()
                        .map(|(mid, mname, mprov)| {
                            serde_json::json!({
                                "id": mid,
                                "name": mname,
                                "provider": mprov,
                                "reasoning_options": [],
                            })
                        })
                        .collect(),
                    Value::Array(vec![]),
                    Value::Array(vec![]),
                    Value::Array(vec![]),
                    Value::Null,
                ),
            };

        records.push(MobileSyncRecord {
            entity_type: "executor_options",
            entity_id: exec_id.to_string(),
            operation: "upsert",
            payload: serde_json::json!({
                "executor": exec_id,
                "models": models_json,
                "providers": providers_json,
                "agents": agents_json,
                "permissions": permissions_json,
                "default_model": default_model_json,
                "presets": presets,
            }),
        });
    }

    // 4. Batch query projects and their pre/post prompt rules
    let projects = Project::find_all(pool).await?;
    for project in &projects {
        let (pre, post) = parse_rules_pre_post(&project.orchestrator_prompt);
        let eff_pre = if pre.is_empty() {
            global_pre.clone()
        } else {
            pre
        };
        let eff_post = if post.is_empty() {
            global_post.clone()
        } else {
            post
        };

        records.push(MobileSyncRecord {
            entity_type: "project",
            entity_id: project.id.to_string(),
            operation: "upsert",
            payload: serde_json::json!({
                "id": project.id,
                "name": project.name,
                "color": project.color,
                "pre_prompt": eff_pre,
                "post_prompt": eff_post,
            }),
        });

        records.push(MobileSyncRecord {
            entity_type: "project_rules",
            entity_id: project.id.to_string(),
            operation: "upsert",
            payload: serde_json::json!({
                "project_id": project.id,
                "pre_prompt": eff_pre,
                "post_prompt": eff_post,
                "global_pre_prompt": global_pre,
                "global_post_prompt": global_post,
            }),
        });

        // 4b. Project tags and card<->tag links for the mobile create-card dialog.
        for tag in KanbanTag::list_by_project(pool, project.id).await? {
            records.push(MobileSyncRecord {
                entity_type: "tag",
                entity_id: tag.id.to_string(),
                operation: "upsert",
                payload: serde_json::json!({
                    "id": tag.id,
                    "project_id": tag.project_id,
                    "name": tag.name,
                    "color": tag.color,
                }),
            });
        }
        for link in DbIssueTag::list_by_project(pool, project.id).await? {
            records.push(MobileSyncRecord {
                entity_type: "issue_tag",
                entity_id: link.id.to_string(),
                operation: "upsert",
                payload: serde_json::json!({
                    "id": link.id,
                    "issue_id": link.issue_id,
                    "tag_id": link.tag_id,
                }),
            });
        }
    }

    // 5. Batch query project statuses in single SQL call
    let status_rows = sqlx::query(
        r#"SELECT id, project_id, name, color, sort_order, hidden, is_terminal
           FROM project_statuses
           WHERE COALESCE(hidden, 0) = 0
           ORDER BY sort_order ASC"#,
    )
    .fetch_all(pool)
    .await?;

    for row in status_rows {
        let id: Uuid = row.try_get("id")?;
        let project_id: Uuid = row.try_get("project_id")?;
        let name: String = row.try_get("name")?;
        let color: String = row.try_get("color")?;
        let sort_order: i64 = row
            .try_get::<i64, _>("sort_order")
            .or_else(|_| row.try_get::<f64, _>("sort_order").map(|v| v as i64))
            .unwrap_or(0);
        let hidden: bool = row
            .try_get::<bool, _>("hidden")
            .or_else(|_| row.try_get::<i64, _>("hidden").map(|v| v != 0))
            .unwrap_or(false);
        let is_terminal: bool = row
            .try_get::<bool, _>("is_terminal")
            .or_else(|_| row.try_get::<i64, _>("is_terminal").map(|v| v != 0))
            .unwrap_or(false);

        records.push(MobileSyncRecord {
            entity_type: "status",
            entity_id: id.to_string(),
            operation: "upsert",
            payload: serde_json::json!({
                "id": id,
                "project_id": project_id,
                "name": name,
                "color": color,
                "sort_order": sort_order,
                "hidden": hidden,
                "is_terminal": is_terminal,
            }),
        });
    }

    // 6. Batch query issue_workspace links
    let issue_workspace_links = IssueWorkspace::list_linked_all(pool).await?;

    // 7. Batch query active issues in single SQL call
    let issue_rows = sqlx::query(
        r#"SELECT id, project_id, status_id, simple_id, title, description, priority, sort_order
           FROM issues
           WHERE COALESCE(archived, 0) = 0
           ORDER BY sort_order ASC"#,
    )
    .fetch_all(pool)
    .await?;

    for row in issue_rows {
        let id: Uuid = row.try_get("id")?;
        let project_id: Uuid = row.try_get("project_id")?;
        let status_id: Uuid = row.try_get("status_id")?;
        let simple_id: String = row.try_get("simple_id")?;
        let title: String = row.try_get("title")?;
        let description: Option<String> = row.try_get("description")?;
        let priority: Option<String> = row.try_get("priority")?;
        let sort_order: f64 = row
            .try_get::<f64, _>("sort_order")
            .or_else(|_| row.try_get::<i64, _>("sort_order").map(|v| v as f64))
            .unwrap_or(0.0);

        let ws_link = issue_workspace_links.iter().find(|l| l.issue_id == id);

        records.push(MobileSyncRecord {
            entity_type: "issue",
            entity_id: id.to_string(),
            operation: "upsert",
            payload: serde_json::json!({
                "id": id,
                "project_id": project_id,
                "status_id": status_id,
                "simple_id": simple_id,
                "title": title,
                "description": description,
                "priority": priority,
                "sort_order": sort_order,
                "workspace_id": ws_link.map(|l| l.workspace_id),
            }),
        });
    }

    // 8. Add issue_workspace links to records
    for link in &issue_workspace_links {
        records.push(MobileSyncRecord {
            entity_type: "issue_workspace",
            entity_id: format!("{}:{}", link.issue_id, link.workspace_id),
            operation: "upsert",
            payload: serde_json::json!({
                "issue_id": link.issue_id,
                "workspace_id": link.workspace_id,
                "project_id": link.project_id,
            }),
        });
    }

    // 9. Batch query active workspaces (lightweight summary only)
    let workspace_rows = sqlx::query(
        r#"SELECT w.id, w.name, w.branch,
                  CASE WHEN EXISTS (
                      SELECT 1 FROM sessions s
                      JOIN execution_processes ep ON ep.session_id = s.id
                      WHERE s.workspace_id = w.id AND ep.status = 'running'
                      LIMIT 1
                  ) THEN 1 ELSE 0 END AS is_running
           FROM workspaces w
           WHERE COALESCE(w.archived, 0) = 0 AND COALESCE(w.ephemeral, 0) = 0
           ORDER BY w.updated_at DESC
           LIMIT 50"#,
    )
    .fetch_all(pool)
    .await?;

    for row in workspace_rows {
        let id: Uuid = row.try_get("id")?;
        let name: Option<String> = row.try_get("name")?;
        let branch: String = row.try_get("branch")?;
        let is_running = row.try_get::<i64, _>("is_running").unwrap_or(0) == 1;

        records.push(MobileSyncRecord {
            entity_type: "workspace",
            entity_id: id.to_string(),
            operation: "upsert",
            payload: serde_json::json!({
                "id": id,
                "name": name.unwrap_or_else(|| id.to_string()),
                "branch": branch,
                "is_running": is_running,
            }),
        });
    }

    Ok(ResponseJson(ApiResponse::success(MobileContextResponse {
        records,
    })))
}

/// Export the current local context in the same record shape accepted by the
/// Cloud `/api/sync` endpoint. The endpoint does not mutate the local DB.
pub async fn get_context(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<MobileContextResponse>>, ApiError> {
    get_context_for(&deployment, true).await
}

async fn get_context_for(
    deployment: &DeploymentImpl,
    include_chat: bool,
) -> Result<ResponseJson<ApiResponse<MobileContextResponse>>, ApiError> {
    const MAX_WORKSPACE_CONTEXT_EXECUTIONS: usize = 24;

    let pool = &deployment.db().pool;
    let mut records = Vec::new();
    let node = instance::describe(deployment);
    records.push(MobileSyncRecord {
        entity_type: "instance",
        entity_id: node.instance_id.clone(),
        operation: "upsert",
        payload: serde_json::to_value(node)
            .map_err(|error| ApiError::BadRequest(error.to_string()))?,
    });
    for pipeline in load_pipelines(&pipelines_dir()) {
        records.push(MobileSyncRecord {
            entity_type: "pipeline",
            entity_id: pipeline.id.clone(),
            operation: "upsert",
            payload: serde_json::json!({
                "id": pipeline.id,
                "name": pipeline.name,
                "description": pipeline.description,
                "stages": pipeline.stages.iter().map(|stage| serde_json::json!({
                    "id": stage.id,
                    "label": stage.label,
                    "default_enabled": stage.default_enabled,
                    "prompt_fragment": stage.prompt_fragment,
                })).collect::<Vec<_>>(),
            }),
        });
    }
    let issue_workspace_links = IssueWorkspace::list_linked_all(pool).await?;

    for workspace in Workspace::find_all_with_status(pool, None, None).await? {
        records.push(MobileSyncRecord {
            entity_type: "workspace",
            entity_id: workspace.id.to_string(),
            operation: "upsert",
            payload: serde_json::to_value(&workspace)
                .map_err(|error| ApiError::BadRequest(error.to_string()))?,
        });

        // Keep the board record small, but publish the detail needed when a
        // Mobile user opens a workspace: sessions/agents, execution state,
        // repository branches, notes and the turn identifiers used to join
        // the compact chat stream. This is deliberately one bounded record
        // per workspace instead of copying the full local database.
        let sessions = Session::find_by_workspace_id(pool, workspace.id).await?;
        let mut workspace_processes = Vec::new();
        for session in &sessions {
            workspace_processes
                .extend(ExecutionProcess::find_by_session_id(pool, session.id, false).await?);
        }
        workspace_processes.sort_by_key(|process| process.created_at);
        let workspace_processes = workspace_processes
            .into_iter()
            .rev()
            .take(MAX_WORKSPACE_CONTEXT_EXECUTIONS)
            .collect::<Vec<_>>();
        let mut executions = Vec::new();
        let mut turns = Vec::new();
        for process in workspace_processes.into_iter().rev() {
            // Full prompts and summaries remain in individual chat records.
            // The context payload only needs stable join identifiers and must
            // stay safely below the Cloud operation size limit.
            if let Some(turn) =
                CodingAgentTurn::find_by_execution_process_id(pool, process.id).await?
            {
                turns.push(serde_json::json!({
                    "id": turn.id,
                    "execution_process_id": turn.execution_process_id,
                    "agent_session_id": turn.agent_session_id,
                    "agent_message_id": turn.agent_message_id,
                    "seen": turn.seen,
                    "created_at": turn.created_at,
                    "updated_at": turn.updated_at,
                }));
            }
            executions.push(serde_json::json!({
                "id": process.id,
                "session_id": process.session_id,
                "run_reason": process.run_reason,
                "status": process.status,
                "exit_code": process.exit_code,
                "started_at": process.started_at,
                "completed_at": process.completed_at,
                "created_at": process.created_at,
                "updated_at": process.updated_at,
            }));
        }
        let workspace_repos =
            WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace.id).await?;
        let repositories = workspace_repos
            .iter()
            .map(|repo| {
                serde_json::json!({
                    "id": repo.repo.id,
                    "name": repo.repo.name,
                    "display_name": repo.repo.display_name,
                    "target_branch": repo.target_branch,
                })
            })
            .collect::<Vec<_>>();
        let notes = Scratch::find_by_id(pool, workspace.id, &ScratchType::WorkspaceNotes)
            .await?
            .and_then(|scratch| match scratch.payload {
                ScratchPayload::WorkspaceNotes(notes) => Some(notes.content),
                _ => None,
            });
        // Default chat config do workspace (executor/modelo/effort/...),
        // salva pelo app ou Mobile e aplicada nos follow-ups.
        let chat_config: Option<WorkspaceChatConfigData> =
            Scratch::find_by_id(pool, workspace.id, &ScratchType::WorkspaceChatConfig)
                .await?
                .and_then(|scratch| match scratch.payload {
                    ScratchPayload::WorkspaceChatConfig(config) => Some(config),
                    _ => None,
                });
        // Latest model context usage for this workspace (same numbers as the
        // Desktop context gauge: used vs window + prompt-cache hit rate).
        let context_usage: Option<Value> = sqlx::query(
            r#"SELECT total_tokens, model_context_window, input_tokens, output_tokens,
                      cache_read_tokens, cache_creation_tokens, agent, provider, model
               FROM token_usage_records
               WHERE workspace_id = ?
               ORDER BY observed_at DESC
               LIMIT 1"#,
        )
        .bind(workspace.id)
        .fetch_optional(pool)
        .await?
        .map(|row| {
            serde_json::json!({
                "total_tokens": row.try_get::<i64, _>("total_tokens").unwrap_or(0),
                "model_context_window": row.try_get::<i64, _>("model_context_window").unwrap_or(0),
                "input_tokens": row.try_get::<i64, _>("input_tokens").unwrap_or(0),
                "output_tokens": row.try_get::<i64, _>("output_tokens").unwrap_or(0),
                "cache_read_tokens": row.try_get::<i64, _>("cache_read_tokens").unwrap_or(0),
                "cache_creation_tokens": row.try_get::<i64, _>("cache_creation_tokens").unwrap_or(0),
                "agent": row.try_get::<String, _>("agent").ok(),
                "provider": row.try_get::<Option<String>, _>("provider").unwrap_or(None),
                "model": row.try_get::<Option<String>, _>("model").unwrap_or(None),
            })
        });
        let session_payload = sessions
            .iter()
            .map(|session| {
                serde_json::json!({
                    "id": session.id,
                    "workspace_id": session.workspace_id,
                    "name": session.name,
                    "executor": session.executor,
                    "agent_working_dir": session.agent_working_dir,
                    "created_at": session.created_at,
                    "updated_at": session.updated_at,
                })
            })
            .collect::<Vec<_>>();
        records.push(MobileSyncRecord {
            entity_type: "workspace_context",
            entity_id: workspace.id.to_string(),
            operation: "upsert",
            payload: serde_json::json!({
                "workspace_id": workspace.id,
                "branch": workspace.branch,
                "sessions": session_payload,
                "executions": executions,
                "turns": turns,
                "repositories": repositories,
                "git": {
                    "branch": workspace.branch,
                    "repositories": repositories,
                },
                "notes": notes,
                "context_usage": context_usage,
                "chat_config": chat_config,
            }),
        });
    }

    for project in Project::find_all(pool).await? {
        records.push(MobileSyncRecord {
            entity_type: "project",
            entity_id: project.id.to_string(),
            operation: "upsert",
            payload: serde_json::to_value(&project)
                .map_err(|error| ApiError::BadRequest(error.to_string()))?,
        });

        for status in ProjectStatus::list_by_project(pool, project.id).await? {
            records.push(MobileSyncRecord {
                entity_type: "status",
                entity_id: status.id.to_string(),
                operation: "upsert",
                payload: serde_json::to_value(status)
                    .map_err(|error| ApiError::BadRequest(error.to_string()))?,
            });
        }

        for issue in Issue::list_by_project(pool, project.id).await? {
            let mut payload = serde_json::to_value(&issue)
                .map_err(|error| ApiError::BadRequest(error.to_string()))?;
            if let Some(link) = issue_workspace_links
                .iter()
                .find(|link| link.issue_id == issue.id)
                && let Some(object) = payload.as_object_mut()
            {
                object.insert(
                    "workspace_id".to_string(),
                    serde_json::to_value(link.workspace_id)
                        .map_err(|error| ApiError::BadRequest(error.to_string()))?,
                );
            }
            records.push(MobileSyncRecord {
                entity_type: "issue",
                entity_id: issue.id.to_string(),
                operation: "upsert",
                payload,
            });
        }
    }

    // Keep the relationship that lets a mobile card open the conversation of
    // the workspace launched for that issue. The workspace and issue records
    // alone do not carry this association.
    for link in issue_workspace_links {
        records.push(MobileSyncRecord {
            entity_type: "issue_workspace",
            entity_id: format!("{}:{}", link.issue_id, link.workspace_id),
            operation: "upsert",
            payload: serde_json::json!({
                "issue_id": link.issue_id,
                "workspace_id": link.workspace_id,
                "project_id": link.project_id,
            }),
        });
    }

    if include_chat {
        let chat_rows = sqlx::query(
            r#"SELECT cat.id, s.workspace_id, cat.prompt, cat.summary, cat.seen,
                      cat.agent_session_id, cat.agent_message_id,
                      cat.created_at, cat.updated_at
               FROM coding_agent_turns cat
               JOIN execution_processes ep ON ep.id = cat.execution_process_id
               JOIN sessions s ON s.id = ep.session_id
               WHERE ep.dropped = FALSE
               ORDER BY cat.created_at ASC"#,
        )
        .fetch_all(pool)
        .await?;

        for row in chat_rows {
            let id: Uuid = row.try_get("id")?;
            let payload = serde_json::json!({
                "id": id,
                "workspace_id": row.try_get::<Uuid, _>("workspace_id")?,
                "prompt": row.try_get::<Option<String>, _>("prompt")?,
                "summary": row.try_get::<Option<String>, _>("summary")?,
                "agent_session_id": row.try_get::<Option<String>, _>("agent_session_id")?,
                "agent_message_id": row.try_get::<Option<String>, _>("agent_message_id")?,
                "seen": row.try_get::<bool, _>("seen")?,
                "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")?,
                "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at")?,
            });
            records.push(MobileSyncRecord {
                entity_type: "chat",
                entity_id: id.to_string(),
                operation: "upsert",
                payload,
            });
        }
    }

    Ok(ResponseJson(ApiResponse::success(MobileContextResponse {
        records,
    })))
}

/// Import the board portion of a Cloud snapshot into this instance's local
/// SQLite database. Cloud IDE containers start with empty volumes, so pushing
/// the local context to Cloud is not enough: the first authenticated startup
/// must also materialize the account's projects, columns, cards and workspace
/// links locally. Every write is an idempotent upsert keyed by the Cloud UUID.
/// Clamp a client-provided timestamp that is ahead of the server clock.
///
/// Every instance serializes `DateTime<Utc>`, so values from different
/// timezones are comparable as-is — the timezone itself is never a problem.
/// The residual risk is a device with a wrong clock: a future-dated write
/// would win every future comparison and permanently block real edits, so
/// anything beyond a small tolerance is treated as "now" instead.
fn clamp_future_timestamp(
    value: chrono::DateTime<chrono::Utc>,
) -> chrono::DateTime<chrono::Utc> {
    let now = chrono::Utc::now();
    if value > now + chrono::Duration::minutes(5) {
        tracing::warn!(
            incoming = %value,
            server_now = %now,
            "import-context: incoming timestamp is in the future (client clock skew); clamping to now"
        );
        now
    } else {
        value
    }
}

async fn import_cloud_context(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<CloudImportRequest>,
) -> Result<ResponseJson<ApiResponse<CloudImportSummary>>, ApiError> {
    const MAX_RECORDS: usize = 5_000;
    if request.records.len() > MAX_RECORDS {
        return Err(ApiError::BadRequest(format!(
            "Cloud snapshot contains more than {MAX_RECORDS} records"
        )));
    }

    let mut projects = Vec::new();
    let mut statuses = Vec::new();
    let mut issues = Vec::new();
    let mut workspaces = Vec::new();
    let mut links = Vec::new();
    let mut workspace_contexts = Vec::new();
    let mut chats = Vec::new();
    let mut skipped = 0;

    for record in request.records {
        if record.operation != "upsert" {
            skipped += 1;
            continue;
        }
        let parsed = match record.entity_type.as_str() {
            "project" => {
                serde_json::from_value::<Project>(record.payload).map(|value| projects.push(value))
            }
            "status" => serde_json::from_value::<ProjectStatus>(record.payload)
                .map(|value| statuses.push(value)),
            "issue" => {
                serde_json::from_value::<Issue>(record.payload).map(|value| issues.push(value))
            }
            "workspace" => serde_json::from_value::<Workspace>(record.payload)
                .map(|value| workspaces.push(value)),
            "issue_workspace" => {
                serde_json::from_value::<CloudIssueWorkspacePayload>(record.payload)
                    .map(|value| links.push(value))
            }
            "workspace_context" => {
                serde_json::from_value::<CloudWorkspaceContextPayload>(record.payload)
                    .map(|value| workspace_contexts.push(value))
            }
            "chat" => serde_json::from_value::<CloudChatPayload>(record.payload)
                .map(|value| chats.push(value)),
            _ => continue,
        };
        if parsed.is_err() {
            tracing::warn!(
                entity_type = %record.entity_type,
                entity_id = %record.entity_id,
                "skipping malformed Cloud snapshot record"
            );
            skipped += 1;
        }
    }

    let pool = &deployment.db().pool;
    let mut transaction = pool.begin().await?;

    // Insert projects without parent_id first. A snapshot is sorted by update
    // time, not by the project hierarchy, so setting the parent in a second
    // pass avoids a foreign-key ordering failure.
    for project in &projects {
        sqlx::query(
            r#"INSERT INTO projects (
                    id, name, key, color, sort_order, parent_id,
                    default_agent_working_dir, remote_project_id,
                    orchestrator_prompt, archived, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    key = excluded.key,
                    color = excluded.color,
                    sort_order = excluded.sort_order,
                    default_agent_working_dir = excluded.default_agent_working_dir,
                    remote_project_id = excluded.remote_project_id,
                    orchestrator_prompt = excluded.orchestrator_prompt,
                    archived = excluded.archived,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at"#,
        )
        .bind(project.id)
        .bind(&project.name)
        .bind(&project.key)
        .bind(&project.color)
        .bind(project.sort_order)
        .bind(&project.default_agent_working_dir)
        .bind(project.remote_project_id)
        .bind(&project.orchestrator_prompt)
        .bind(project.archived)
        .bind(project.created_at)
        .bind(project.updated_at)
        .execute(&mut *transaction)
        .await?;
    }
    for project in &projects {
        if let Some(parent_id) = project.parent_id {
            sqlx::query("UPDATE projects SET parent_id = ? WHERE id = ?")
                .bind(parent_id)
                .bind(project.id)
                .execute(&mut *transaction)
                .await?;
        }
    }

    for status in &statuses {
        sqlx::query(
            r#"INSERT INTO project_statuses (
                    id, project_id, name, color, sort_order, hidden,
                    is_terminal, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
                    name = excluded.name,
                    color = excluded.color,
                    sort_order = excluded.sort_order,
                    hidden = excluded.hidden,
                    is_terminal = excluded.is_terminal,
                    created_at = excluded.created_at"#,
        )
        .bind(status.id)
        .bind(status.project_id)
        .bind(&status.name)
        .bind(&status.color)
        .bind(status.sort_order)
        .bind(status.hidden)
        .bind(status.is_terminal)
        .bind(status.created_at)
        .execute(&mut *transaction)
        .await?;
    }

    // As with projects, defer self-referencing issue parents until all cards
    // are present. The status/project foreign keys are already available.
    //
    // `issues` carries UNIQUE(project_id, issue_number): the cloud and a
    // local device can hold the SAME card under different ids (independent
    // creation, or an id regenerated elsewhere). An upsert keyed only on
    // `id` then hits the unique constraint and fails the whole import with
    // SQLITE_CONSTRAINT, which is what kept the release app from ever
    // reconciling its board. Match by id first, then by
    // (project_id, issue_number), and insert only when neither exists — the
    // local row id is preserved so linked workspaces keep resolving.
    for issue in &issues {
        let extension_metadata = serde_json::to_string(&issue.extension_metadata)
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;

        // Last-writer-wins reconciliation. `issues` also carries
        // UNIQUE(project_id, issue_number): the cloud and a local device can
        // hold the SAME card under different ids (independent creation, or an
        // id regenerated elsewhere). An upsert keyed only on `id` then hits
        // that unique constraint and fails the whole import with a 500,
        // which is what kept the release app from ever reconciling its board.
        // Resolve the local row by id first, then by (project_id,
        // issue_number); keep it when it is newer than the incoming card
        // (so a stale snapshot can never undo a fresh local move) and only
        // insert when no row matches either key.
        let local_updated: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
            "SELECT updated_at FROM issues WHERE id = ?",
        )
        .bind(issue.id)
        .fetch_optional(&mut *transaction)
        .await?;
        let local_updated = match local_updated {
            Some(timestamp) => Some(timestamp),
            None => {
                sqlx::query_scalar(
                    "SELECT updated_at FROM issues WHERE project_id = ? AND issue_number = ?",
                )
                .bind(issue.project_id)
                .bind(issue.issue_number)
                .fetch_optional(&mut *transaction)
                .await?
            }
        };

        let incoming_updated_at = clamp_future_timestamp(issue.updated_at);
        match local_updated {
            Some(local_timestamp) => {
                if local_timestamp > incoming_updated_at {
                    continue;
                }
                sqlx::query(
                    r#"UPDATE issues SET
                            id = ?, project_id = ?, issue_number = ?, simple_id = ?,
                            status_id = ?, title = ?, description = ?, priority = ?,
                            start_date = ?, target_date = ?, completed_at = ?,
                            sort_order = ?, parent_issue_sort_order = ?,
                            extension_metadata = ?, archived = ?, archived_at = ?,
                            created_at = ?, updated_at = ?
                        WHERE id = ? OR (project_id = ? AND issue_number = ?)"#,
                )
                .bind(issue.id)
                .bind(issue.project_id)
                .bind(issue.issue_number)
                .bind(&issue.simple_id)
                .bind(issue.status_id)
                .bind(&issue.title)
                .bind(&issue.description)
                .bind(&issue.priority)
                .bind(issue.start_date)
                .bind(issue.target_date)
                .bind(issue.completed_at)
                .bind(issue.sort_order)
                .bind(issue.parent_issue_sort_order)
                .bind(&extension_metadata)
                .bind(issue.archived)
                .bind(issue.archived_at)
                .bind(issue.created_at)
                .bind(incoming_updated_at)
                .bind(issue.id)
                .bind(issue.project_id)
                .bind(issue.issue_number)
                .execute(&mut *transaction)
                .await?;
            }
            None => {
                sqlx::query(
                    r#"INSERT INTO issues (
                            id, project_id, issue_number, simple_id, status_id, title,
                            description, priority, start_date, target_date,
                            completed_at, sort_order, parent_issue_id,
                            parent_issue_sort_order, extension_metadata, archived,
                            archived_at, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)"#,
                )
                .bind(issue.id)
                .bind(issue.project_id)
                .bind(issue.issue_number)
                .bind(&issue.simple_id)
                .bind(issue.status_id)
                .bind(&issue.title)
                .bind(&issue.description)
                .bind(&issue.priority)
                .bind(issue.start_date)
                .bind(issue.target_date)
                .bind(issue.completed_at)
                .bind(issue.sort_order)
                .bind(issue.parent_issue_sort_order)
                .bind(&extension_metadata)
                .bind(issue.archived)
                .bind(issue.archived_at)
                .bind(issue.created_at)
                .bind(incoming_updated_at)
                .execute(&mut *transaction)
                .await?;
            }
        }
    }
    for issue in &issues {
        if let Some(parent_issue_id) = issue.parent_issue_id {
            sqlx::query("UPDATE issues SET parent_issue_id = ? WHERE id = ?")
                .bind(parent_issue_id)
                .bind(issue.id)
                .execute(&mut *transaction)
                .await?;
        }
    }

    for workspace in &workspaces {
        let kind = workspace.kind.map(WorkspaceKind::as_sql_str);
        sqlx::query(
            r#"INSERT INTO workspaces (
                    id, task_id, container_ref, branch, setup_completed_at,
                    created_at, updated_at, archived, pinned, name,
                    worktree_deleted, ephemeral, kind, current_pipeline_stage
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    container_ref = excluded.container_ref,
                    branch = excluded.branch,
                    setup_completed_at = excluded.setup_completed_at,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    archived = excluded.archived,
                    pinned = excluded.pinned,
                    name = excluded.name,
                    worktree_deleted = excluded.worktree_deleted,
                    ephemeral = excluded.ephemeral,
                    kind = excluded.kind,
                    current_pipeline_stage = excluded.current_pipeline_stage"#,
        )
        .bind(workspace.id)
        .bind(workspace.task_id)
        .bind(&workspace.container_ref)
        .bind(&workspace.branch)
        .bind(workspace.setup_completed_at)
        .bind(workspace.created_at)
        .bind(workspace.updated_at)
        .bind(workspace.archived)
        .bind(workspace.pinned)
        .bind(&workspace.name)
        .bind(workspace.worktree_deleted)
        .bind(workspace.ephemeral)
        .bind(kind)
        .bind(workspace.current_pipeline_stage)
        .execute(&mut *transaction)
        .await?;
    }

    // Materialize the conversation index that belongs to the imported
    // workspaces. The cloud snapshot already contains the board rows, but the
    // workspace page needs sessions and execution processes before it can
    // request the historical conversation stream.
    let chats_by_id: HashMap<Uuid, &CloudChatPayload> =
        chats.iter().map(|chat| (chat.id, chat)).collect();
    let mut imported_context_records = 0usize;

    for context in &workspace_contexts {
        for session in &context.sessions {
            sqlx::query(
                r#"INSERT INTO sessions (
                        id, workspace_id, name, executor, agent_working_dir,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        workspace_id = excluded.workspace_id,
                        name = excluded.name,
                        executor = excluded.executor,
                        agent_working_dir = excluded.agent_working_dir,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at"#,
            )
            .bind(session.id)
            .bind(session.workspace_id)
            .bind(&session.name)
            .bind(&session.executor)
            .bind(&session.agent_working_dir)
            .bind(session.created_at)
            .bind(session.updated_at)
            .execute(&mut *transaction)
            .await?;
            imported_context_records += 1;
        }

        for execution in &context.executions {
            if execution.run_reason != "codingagent" {
                continue;
            }

            let turn = context
                .turns
                .iter()
                .find(|turn| turn.execution_process_id == execution.id);
            let chat = turn
                .and_then(|turn| chats_by_id.get(&turn.id).copied())
                .filter(|chat| chat.workspace_id == context.workspace_id);
            let prompt = chat
                .and_then(|chat| chat.prompt.clone())
                .unwrap_or_default();
            let executor = context
                .sessions
                .iter()
                .find(|session| session.id == execution.session_id)
                .and_then(|session| session.executor.as_deref())
                .map(|value| value.replace('-', "_").to_ascii_uppercase())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "CODEX".to_string());
            let executor_action = serde_json::json!({
                "typ": {
                    "type": "CodingAgentInitialRequest",
                    "prompt": prompt,
                    "executor_config": { "executor": executor }
                },
                "next_action": null
            });

            sqlx::query(
                r#"INSERT INTO execution_processes (
                        id, session_id, run_reason, executor_action, status,
                        exit_code, dropped, started_at, completed_at,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        session_id = excluded.session_id,
                        run_reason = excluded.run_reason,
                        executor_action = excluded.executor_action,
                        status = excluded.status,
                        exit_code = excluded.exit_code,
                        started_at = excluded.started_at,
                        completed_at = excluded.completed_at,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at"#,
            )
            .bind(execution.id)
            .bind(execution.session_id)
            .bind(&execution.run_reason)
            .bind(executor_action.to_string())
            .bind(&execution.status)
            .bind(execution.exit_code)
            .bind(execution.started_at)
            .bind(execution.completed_at)
            .bind(execution.created_at)
            .bind(execution.updated_at)
            .execute(&mut *transaction)
            .await?;

            if let Some(turn) = turn {
                let turn_created_at = chat.map(|chat| chat.created_at).unwrap_or(turn.created_at);
                sqlx::query(
                    r#"INSERT INTO coding_agent_turns (
                            id, execution_process_id, agent_session_id,
                            agent_message_id, prompt, summary, seen,
                            created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            execution_process_id = excluded.execution_process_id,
                            agent_session_id = excluded.agent_session_id,
                            agent_message_id = excluded.agent_message_id,
                            prompt = excluded.prompt,
                            summary = excluded.summary,
                            seen = excluded.seen,
                            created_at = excluded.created_at,
                            updated_at = excluded.updated_at"#,
                )
                .bind(turn.id)
                .bind(turn.execution_process_id)
                .bind(
                    chat.and_then(|chat| chat.agent_session_id.clone())
                        .or_else(|| turn.agent_session_id.clone()),
                )
                .bind(
                    chat.and_then(|chat| chat.agent_message_id.clone())
                        .or_else(|| turn.agent_message_id.clone()),
                )
                .bind(chat.and_then(|chat| chat.prompt.clone()))
                .bind(chat.and_then(|chat| chat.summary.clone()))
                .bind(chat.map(|chat| chat.seen).unwrap_or(turn.seen))
                .bind(turn_created_at)
                .bind(turn.updated_at)
                .execute(&mut *transaction)
                .await?;

                // Cloud snapshots carry the durable prompt/summary rather
                // than the potentially huge raw executor transcript. Store a
                // compact normalized transcript so the existing workspace
                // WebSocket can render imported history immediately.
                let mut logs = Vec::new();
                if !prompt.is_empty() {
                    logs.push(LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(
                        0,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::UserMessage,
                            content: prompt.clone(),
                            metadata: None,
                        },
                    )));
                }
                if let Some(summary) = chat.and_then(|chat| chat.summary.clone())
                    && !summary.is_empty()
                {
                    logs.push(LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(
                        logs.len(),
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::AssistantMessage,
                            content: summary,
                            metadata: None,
                        },
                    )));
                }
                let log_json = logs
                    .iter()
                    .map(serde_json::to_string)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| ApiError::BadRequest(error.to_string()))?
                    .join("\n");
                // `execution_process_logs` lost its PRIMARY KEY on
                // execution_id (migration 20251101090000); only a non-unique
                // index remains, so `ON CONFLICT(execution_id)` is invalid
                // (SQLITE_ERROR "ON CONFLICT clause does not match any
                // PRIMARY KEY or UNIQUE constraint"). Replace this
                // execution's row instead, keeping the one-row-per-execution
                // invariant.
                sqlx::query("DELETE FROM execution_process_logs WHERE execution_id = ?")
                    .bind(execution.id)
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query(
                    r#"INSERT INTO execution_process_logs (
                            execution_id, logs, byte_size, inserted_at
                        ) VALUES (?, ?, ?, ?)"#,
                )
                .bind(execution.id)
                .bind(&log_json)
                .bind(log_json.len() as i64)
                .bind(execution.updated_at)
                .execute(&mut *transaction)
                .await?;
                imported_context_records += 1;
            }
        }
    }

    // A chat record can arrive independently of workspace_context. Upsert its
    // durable text when the corresponding turn already exists, which makes
    // repeated snapshot imports safe and order-independent.
    for chat in &chats {
        sqlx::query(
            r#"UPDATE coding_agent_turns
               SET prompt = ?, summary = ?, agent_session_id = ?,
                   agent_message_id = ?, seen = ?, updated_at = ?
               WHERE id = ?"#,
        )
        .bind(&chat.prompt)
        .bind(&chat.summary)
        .bind(&chat.agent_session_id)
        .bind(&chat.agent_message_id)
        .bind(chat.seen)
        .bind(chat.updated_at)
        .bind(chat.id)
        .execute(&mut *transaction)
        .await?;
    }

    for link in &links {
        sqlx::query(
            r#"INSERT INTO issue_workspaces (id, issue_id, workspace_id)
               VALUES (?, ?, ?)
               ON CONFLICT(workspace_id) DO UPDATE SET issue_id = excluded.issue_id"#,
        )
        .bind(Uuid::new_v4())
        .bind(link.issue_id)
        .bind(link.workspace_id)
        .execute(&mut *transaction)
        .await?;
    }

    transaction.commit().await?;
    Ok(ResponseJson(ApiResponse::success(CloudImportSummary {
        imported: projects.len()
            + statuses.len()
            + issues.len()
            + workspaces.len()
            + links.len()
            + imported_context_records
            + chats.len(),
        skipped,
    })))
}

/// Dispatch a message received from Mobile through the local Desktop session.
/// The local server remains the only component allowed to start an executor.
pub async fn post_chat_command(
    State(deployment): State<DeploymentImpl>,
    Json(command): Json<MobileChatCommand>,
) -> Result<Response, ApiError> {
    let prompt = command.prompt.trim();
    if prompt.is_empty() || prompt.len() > 100_000 {
        return Err(ApiError::BadRequest(
            "Mobile chat prompt must contain 1 to 100000 characters".to_string(),
        ));
    }

    let pool = &deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, command.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(
            db::models::workspace::WorkspaceError::WorkspaceNotFound,
        ))?;

    // Status commands use the same guarded mutation path as the Desktop
    // Kanban. This keeps `/close`, `/review`, and `/in-progress` consistent
    // with Integration Guard and the normal Mem0 completion flow.
    if let Some(status_kind) = status_command(prompt) {
        if let Some((issue_id, project_id)) =
            IssueWorkspace::find_issue_and_project_by_workspace(pool, workspace.id).await?
        {
            let statuses =
                db::models::project_status::ProjectStatus::list_by_project(pool, project_id)
                    .await?;
            let target = statuses.iter().find(|status| match status_kind {
                "close" => {
                    status.is_terminal
                        || status.name.to_ascii_lowercase().contains("done")
                        || status.name.to_ascii_lowercase().contains("closed")
                        || status.name.to_ascii_lowercase().contains("conclu")
                        || status.name.to_ascii_lowercase().contains("fech")
                }
                "review" => {
                    status.name.to_ascii_lowercase().contains("review")
                        || status.name.to_ascii_lowercase().contains("revis")
                }
                "progress" => {
                    status.name.to_ascii_lowercase().contains("progress")
                        || status.name.to_ascii_lowercase().contains("progres")
                        || status.name.to_ascii_lowercase().contains("andamento")
                }
                _ => false,
            });
            let target = target.ok_or_else(|| {
                ApiError::BadRequest(format!(
                    "No status matching /{status_kind} exists in this project"
                ))
            })?;
            crate::routes::local_kanban::merge_and_update_issue(
                pool,
                issue_id,
                UpdateIssueRequest {
                    allow_unmerged_done: None,
                    status_id: Some(target.id),
                    title: None,
                    description: None,
                    priority: None,
                    start_date: None,
                    target_date: None,
                    completed_at: None,
                    sort_order: None,
                    parent_issue_id: None,
                    parent_issue_sort_order: None,
                    extension_metadata: None,
                },
            )
            .await?
            .ok_or_else(|| ApiError::BadRequest("Issue not found".to_string()))?;
            return Ok(
                ResponseJson(ApiResponse::<Value, Value>::success(serde_json::json!({
                    "status": target.name,
                    "issue_id": issue_id,
                })))
                .into_response(),
            );
        }
        return Err(ApiError::BadRequest(
            "This workspace has no linked card".to_string(),
        ));
    }

    let mut prompt = prompt.to_string();
    let mut attachment_paths = Vec::new();
    for attachment in command.attachments {
        if !attachment.mime_type.starts_with("image/") {
            return Err(ApiError::BadRequest(
                "Mobile chat attachments must be images".to_string(),
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&attachment.data_base64)
            .map_err(|_| ApiError::BadRequest("Invalid mobile image attachment".to_string()))?;
        if bytes.len() > 350_000 {
            return Err(ApiError::BadRequest(
                "Mobile image attachments must be smaller than 350 KB".to_string(),
            ));
        }
        let file = deployment
            .file()
            .store_file(&bytes, &attachment.file_name)
            .await?;
        WorkspaceAttachment::associate_many_dedup(pool, workspace.id, &[file.id]).await?;
        attachment_paths.push((file.original_name, file.file_path));
    }
    if !attachment_paths.is_empty() {
        prompt.push_str("\n\n## Images attached from AuraPunk Mobile\n");
        for (name, path) in attachment_paths {
            prompt.push_str(&format!("- Inspect `.vibe-attachments/{path}` ({name})\n"));
        }
    }

    // Bilateral CLI selection: follow-ups cannot change executor mid-session
    // (ExecutorMismatch), so a different CLI chosen on Mobile starts a new
    // session thread instead of being silently dropped. Same CLI reuses the
    // latest session; an untouched session is simply retargeted.
    // Defaults salvos do workspace (modal do app/Mobile): valem quando o
    // comando não traz override explícito.
    let saved_config = read_chat_config(pool, workspace.id).await?;
    let requested_executor = command
        .executor
        .clone()
        .or_else(|| saved_config.executor.clone())
        .unwrap_or_else(|| "CODEX".to_string())
        .parse::<BaseCodingAgent>()
        .map_err(|_| ApiError::BadRequest("Unknown mobile chat executor".to_string()))?;

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(session) if session.executor.as_deref() == Some(&requested_executor.to_string()) => {
            session
        }
        Some(mut session) => {
            let has_executions = !ExecutionProcess::find_by_session_id(pool, session.id, false)
                .await?
                .is_empty();
            if has_executions {
                Session::create(
                    pool,
                    &CreateSession {
                        executor: Some(requested_executor.to_string()),
                        name: Some("Mobile chat".to_string()),
                    },
                    Uuid::new_v4(),
                    workspace.id,
                )
                .await?
            } else {
                Session::update_executor(pool, session.id, &requested_executor.to_string()).await?;
                session.executor = Some(requested_executor.to_string());
                session
            }
        }
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: Some(requested_executor.to_string()),
                    name: Some("Mobile chat".to_string()),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let executor = requested_executor;
    let mut executor_config = ExecutorConfig::new(executor);
    executor_config.model_id = command.model_id.clone().or(saved_config.model_id.clone());
    executor_config.reasoning_id = command
        .reasoning_id
        .clone()
        .or(saved_config.reasoning_id.clone());
    executor_config.agent_id = command.agent_id.clone().or(saved_config.agent_id.clone());
    executor_config.permission_policy = command.permission_policy.clone().or_else(|| {
        saved_config.permission_policy.as_deref().and_then(|raw| {
            serde_json::from_value::<PermissionPolicy>(serde_json::Value::String(raw.to_string()))
                .ok()
        })
    });
    let workspace_name = workspace
        .name
        .clone()
        .unwrap_or_else(|| "Workspace".to_string());
    let response = crate::routes::sessions::run_follow_up(
        &deployment,
        session.clone(),
        workspace,
        prompt,
        executor_config,
        None,
        None,
        None,
    )
    .await?;
    // Anuncia o turno pronto (cobre /mobile/chat e /tailcat/chat): o APK
    // atualiza só esse workspace em vez de polling cego.
    broadcast_board_event(serde_json::json!({
        "type": "chat_turn",
        "workspace_id": session.workspace_id,
        "session_id": session.id,
        "revision": now_seconds()
    }));
    // Push FCM fora do caminho da resposta (best-effort, nunca atrasa o chat).
    push_to_all(
        deployment.db().pool.clone(),
        &format!("Nova resposta em {workspace_name}"),
        "Toque para abrir o workspace",
        [
            ("type".to_string(), "chat_turn".to_string()),
            ("workspace_id".to_string(), session.workspace_id.to_string()),
            ("session_id".to_string(), session.id.to_string()),
            (
                "title".to_string(),
                format!("Nova resposta em {workspace_name}"),
            ),
        ]
        .into_iter()
        .collect(),
    );
    Ok(response.into_response())
}

/// Create and start the workspace for a card requested by Mobile. The browser
/// or Mobile app never receives permission to create worktrees directly: the
/// local Desktop remains the owner of repositories, sessions and executors.
pub async fn post_workspace_request(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MobileWorkspaceRequest>,
) -> Result<Response, ApiError> {
    let pool = &deployment.db().pool;
    let pool_owned = pool.clone();
    let issue = Issue::find_by_id(pool, request.issue_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("issue not found".to_string()))?;

    if let Some(workspace_id) = IssueWorkspace::find_latest_by_issue(pool, issue.id).await?
        && let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await?
        && !workspace.archived
    {
        return Ok(
            ResponseJson(ApiResponse::<Value>::success(serde_json::json!({
                "workspace_id": workspace.id,
                "created": false,
            })))
            .into_response(),
        );
    }

    let repo_ids = ProjectRepo::list_repo_ids(pool, issue.project_id).await?;
    let mut repos = Repo::find_by_ids(pool, &repo_ids).await?;
    if repos.is_empty() {
        let all_repos = Repo::list_all(pool).await?;
        if !all_repos.is_empty() {
            let project = Project::find_by_id(pool, issue.project_id).await?;
            let proj_name_clean = project
                .as_ref()
                .map(|p| p.name.to_lowercase().replace(['-', '_'], ""))
                .unwrap_or_default();

            let best_repo = all_repos
                .iter()
                .find(|r| {
                    let repo_name_clean = r.name.to_lowercase().replace(['-', '_'], "");
                    !proj_name_clean.is_empty()
                        && (repo_name_clean.contains(&proj_name_clean)
                            || proj_name_clean.contains(&repo_name_clean))
                })
                .unwrap_or(&all_repos[0]);

            let _ = ProjectRepo::link(pool, issue.project_id, best_repo.id).await;
            repos.push(best_repo.clone());
        }
    }
    if repos.is_empty() {
        return Err(ApiError::BadRequest(
            "the issue project has no repository configured and no repositories exist".to_string(),
        ));
    }

    let executor = request
        .executor
        .as_deref()
        .unwrap_or("CODEX")
        .parse::<BaseCodingAgent>()
        .map_err(|_| ApiError::BadRequest("unknown mobile workspace executor".to_string()))?;
    let repos = repos
        .into_iter()
        .map(|repo| WorkspaceRepoInput {
            repo_id: repo.id,
            target_branch: repo
                .default_target_branch
                .unwrap_or_else(|| "main".to_string()),
        })
        .collect();
    let mut prompt = match request.prompt.as_deref() {
        Some(prompt) if !prompt.trim().is_empty() => prompt.trim().to_string(),
        _ => match issue.description.as_deref() {
            Some(description) if !description.trim().is_empty() => {
                format!("{}\n\n{}", issue.title, description)
            }
            _ => issue.title.clone(),
        },
    };

    // Inject custom pre-prompt / post-prompt rules if supplied from mobile
    let mut rules_block = String::new();
    if let Some(ref pre) = request.pre_prompt {
        let trimmed = pre.trim();
        if !trimmed.is_empty() {
            rules_block.push_str(&format!(
                "<!-- vk:rules:pre:start -->\n{}\n<!-- vk:rules:pre:end -->\n\n",
                trimmed
            ));
        }
    }
    if let Some(ref post) = request.post_prompt {
        let trimmed = post.trim();
        if !trimmed.is_empty() {
            rules_block.push_str(&format!(
                "<!-- vk:rules:post:start -->\n{}\n<!-- vk:rules:post:end -->\n\n",
                trimmed
            ));
        }
    }
    if !rules_block.is_empty() {
        prompt.push_str(&format!(
            "\n\n---\n## Instructions & Rules\n{}",
            rules_block.trim()
        ));
    }

    if let Some(ref pipeline_id) = request.pipeline_id {
        let all_pipelines = load_pipelines(&pipelines_dir());
        if let Some(pipe) = all_pipelines.iter().find(|p| &p.id == pipeline_id) {
            let mut stage_fragments = Vec::new();
            for stage in &pipe.stages {
                if request.pipeline_stage_ids.is_empty()
                    || request.pipeline_stage_ids.contains(&stage.id)
                {
                    stage_fragments
                        .push(format!("- **{}**: {}", stage.label, stage.prompt_fragment));
                }
            }
            if !stage_fragments.is_empty() {
                prompt.push_str(&format!(
                    "\n\n---\n## Pipeline: {}\n{}\n",
                    pipe.name,
                    stage_fragments.join("\n")
                ));
            }
        }

        let pipeline_metadata = serde_json::json!({
            "pipeline": {
                "pipelineIds": vec![pipeline_id.clone()],
                "enabledIds": request.pipeline_stage_ids,
                "executor": request.executor,
                "customText": "",
            }
        });
        crate::routes::local_kanban::merge_and_update_issue(
            pool,
            issue.id,
            UpdateIssueRequest {
                allow_unmerged_done: None,
                status_id: None,
                title: None,
                description: None,
                priority: None,
                start_date: None,
                target_date: None,
                completed_at: None,
                sort_order: None,
                parent_issue_id: None,
                parent_issue_sort_order: None,
                extension_metadata: Some(pipeline_metadata),
            },
        )
        .await?;
    }

    let mut executor_config = ExecutorConfig::new(executor);
    executor_config.model_id = request.model_id;
    executor_config.reasoning_id = request.reasoning_id;
    executor_config.agent_id = request.agent_id;
    executor_config.permission_policy = request.permission_policy;

    let response = crate::routes::workspaces::create::create_and_start_workspace(
        State(deployment),
        Json(CreateAndStartWorkspaceRequest {
            name: Some(issue.simple_id.clone()),
            repos,
            linked_issue: Some(LinkedIssueInfo {
                remote_project_id: issue.project_id,
                issue_id: issue.id,
            }),
            executor_config,
            prompt,
            attachment_ids: None,
            kind: None,
        }),
    )
    .await?;

    if let Some(data) = response.0.data() {
        let created_ws = &data.workspace;
        broadcast_board_event(serde_json::json!({
            "type": "workspace_created",
            "workspace_id": created_ws.id,
            "issue_id": issue.id,
            "project_id": issue.project_id,
            "name": created_ws.name,
            "branch": created_ws.branch,
            "revision": now_seconds()
        }));
        let ws_name = created_ws
            .name
            .clone()
            .unwrap_or_else(|| "Workspace".to_string());
        push_to_all(
            pool_owned,
            &format!("Workspace pronto: {ws_name}"),
            "Toque para abrir o workspace",
            [
                ("type".to_string(), "workspace_created".to_string()),
                ("workspace_id".to_string(), created_ws.id.to_string()),
                ("issue_id".to_string(), issue.id.to_string()),
                ("title".to_string(), format!("Workspace pronto: {ws_name}")),
            ]
            .into_iter()
            .collect(),
        );
    }

    Ok(response.into_response())
}

/// Push FCM best-effort para todos os aparelhos registrados (fora do caminho
/// da resposta; nunca atrasa o chat). Sem credenciais, não faz nada.
fn push_to_all(
    pool: sqlx::SqlitePool,
    title: &str,
    body: &str,
    data: std::collections::HashMap<String, String>,
) {
    let title = title.to_string();
    let body = body.to_string();
    tokio::spawn(async move {
        let tokens = db::models::push_token::PushToken::find_all(&pool)
            .await
            .unwrap_or_default();
        for device in tokens {
            match crate::fcm::send_to_token(&device.token, &title, &body, &data).await {
                Ok(()) => {}
                Err(crate::fcm::FcmError::InvalidToken) => {
                    let _ =
                        db::models::push_token::PushToken::delete_by_token(&pool, &device.token)
                            .await;
                }
                Err(crate::fcm::FcmError::NotConfigured) => break,
                Err(e) => {
                    tracing::warn!("FCM push failed: {e:?}");
                }
            }
        }
    });
}

fn status_command(prompt: &str) -> Option<&'static str> {
    match prompt
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "/close" | "/closed" | "/done" | "/complete" | "/fechar" | "/concluir" => Some("close"),
        "/review" | "/revisao" | "/revisão" => Some("review"),
        "/progress" | "/in-progress" | "/in_progress" | "/andamento" => Some("progress"),
        _ => None,
    }
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/mobile/context", get(get_context))
        .route("/mobile/import-context", post(import_cloud_context))
        .route("/mobile/kanban", get(get_mobile_kanban))
        .route("/mobile/chat", post(post_chat_command))
        .route("/mobile/workspace", post(post_workspace_request))
        .route("/mobile/issues", post(mobile_create_issue))
        .route("/mobile/push-tokens", post(mobile_register_push_token))
        .route(
            "/mobile/workspaces/{workspace_id}/chat-config",
            post(mobile_save_chat_config),
        )
        .route("/mobile/pairing/invite", post(create_local_pairing_invite))
        .route("/mobile/pairing/claim", post(claim_local_pairing_invite))
}

pub async fn get_mobile_kanban(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<MobileContextResponse>>, ApiError> {
    get_kanban_context(&deployment).await
}

async fn create_local_pairing_invite(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<LocalPairingInviteRequest>,
) -> Result<ResponseJson<ApiResponse<LocalPairingInviteResponse>>, ApiError> {
    let mut endpoints = request.endpoints;
    if endpoints.is_empty()
        && let Some(endpoint) = request.endpoint
    {
        endpoints.push(endpoint);
    }
    let endpoints = endpoints
        .into_iter()
        .map(|endpoint| endpoint.trim().trim_end_matches('/').to_string())
        .filter(|endpoint| !endpoint.is_empty())
        .collect::<Vec<_>>();
    if endpoints.is_empty() {
        return Err(ApiError::BadRequest("no LAN endpoint was detected".into()));
    }
    for endpoint in &endpoints {
        let parsed_endpoint = url::Url::parse(endpoint)
            .map_err(|_| ApiError::BadRequest("invalid LAN endpoint".into()))?;
        if !matches!(parsed_endpoint.scheme(), "http" | "https")
            || parsed_endpoint.host_str().is_none()
        {
            return Err(ApiError::BadRequest(
                "LAN endpoint must be an http(s) URL".into(),
            ));
        }
    }

    let node = instance::describe(&deployment);
    let invite_id = Uuid::new_v4();
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let expires_at = now_seconds() + 120;
    let mut pairing_serializer =
        url::form_urlencoded::Serializer::new("aurapunk://pair-local?".to_string());
    for endpoint in &endpoints {
        pairing_serializer.append_pair("endpoint", endpoint);
    }
    let pairing_url = pairing_serializer
        .append_pair("invite_id", &invite_id.to_string())
        .append_pair("secret", &secret)
        .append_pair("instance_id", &node.instance_id)
        .append_pair("expires_at", &expires_at.to_string())
        .finish();

    let mut invites = local_pairing_invites()
        .lock()
        .map_err(|_| ApiError::BadRequest("pairing store unavailable".into()))?;
    let now = now_seconds();
    invites.retain(|_, invite| invite.expires_at > now);
    invites.insert(
        invite_id,
        LocalPairingInvite {
            secret,
            instance_id: node.instance_id.clone(),
            endpoints: endpoints.clone(),
            expires_at,
        },
    );

    Ok(ResponseJson(ApiResponse::success(
        LocalPairingInviteResponse {
            pairing_url,
            invite_id,
            instance_id: node.instance_id,
            endpoint: endpoints[0].clone(),
            endpoints,
            expires_at,
        },
    )))
}

async fn claim_local_pairing_invite(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<LocalPairingClaimRequest>,
) -> Result<ResponseJson<ApiResponse<LocalPairingClaimResponse>>, ApiError> {
    let invite = {
        let mut invites = local_pairing_invites()
            .lock()
            .map_err(|_| ApiError::BadRequest("pairing store unavailable".into()))?;
        let now = now_seconds();
        invites.retain(|_, item| item.expires_at > now);
        let invite = invites
            .get(&request.invite_id)
            .cloned()
            .ok_or_else(|| ApiError::Forbidden("pairing invite expired or already used".into()))?;
        if invite.expires_at <= now_seconds() || invite.secret != request.secret {
            return Err(ApiError::Forbidden("invalid pairing invite".into()));
        }
        invites.remove(&request.invite_id);
        invite
    };

    let node = instance::describe(&deployment);
    if node.instance_id != invite.instance_id {
        return Err(ApiError::Forbidden(
            "pairing invite belongs to another instance".into(),
        ));
    }

    let endpoint = request
        .endpoint
        .filter(|endpoint| {
            invite
                .endpoints
                .iter()
                .any(|candidate| candidate == endpoint)
        })
        .unwrap_or_else(|| invite.endpoints[0].clone());

    Ok(ResponseJson(ApiResponse::success(
        LocalPairingClaimResponse {
            instance_id: node.instance_id,
            name: node.name,
            endpoint,
            direct_token: node.direct_token,
            transport: "tailcat",
        },
    )))
}

/// Direct Mobile transport over the configured Tailcat network. The bearer
/// token is generated per Desktop instance and is separate from the Cloud
/// account token. Tailcat ACLs provide network isolation; this token provides
/// an application-level second check.
pub fn tailcat_router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/tailcat/health", get(tailcat_health))
        .route("/tailcat/context", get(tailcat_context))
        .route("/tailcat/kanban", get(tailcat_kanban))
        .route(
            "/tailcat/workspaces/{workspace_id}/chat",
            get(tailcat_workspace_chat),
        )
        .route("/tailcat/chat", post(tailcat_chat))
        .route("/tailcat/workspace", post(tailcat_workspace))
        .route("/tailcat/issues", post(tailcat_create_issue))
        .route("/tailcat/issues/{id}", patch(tailcat_update_issue))
        .route("/tailcat/push-tokens", post(tailcat_register_push_token))
        .route(
            "/tailcat/workspaces/{workspace_id}/chat-config",
            post(tailcat_save_chat_config),
        )
        .route("/tailcat/events/ws", get(tailcat_events_ws))
}

async fn tailcat_health(
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Value>>, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    Ok(ResponseJson(ApiResponse::success(serde_json::json!({
        "service": "aurapunk-desktop",
        "transport": "tailcat",
        "instance_id": instance::describe(&deployment).instance_id,
    }))))
}

async fn tailcat_context(
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<MobileContextResponse>>, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    get_context_for(&deployment, true).await
}

async fn tailcat_kanban(
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<MobileContextResponse>>, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    get_kanban_context(&deployment).await
}

async fn tailcat_workspace_chat(
    headers: HeaderMap,
    Path(workspace_id): Path<Uuid>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<MobileContextResponse>>, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    let rows = sqlx::query(
        r#"SELECT cat.id, s.workspace_id, cat.prompt, cat.summary,
                      cat.agent_session_id, cat.agent_message_id, cat.seen,
                  cat.created_at, cat.updated_at
           FROM coding_agent_turns cat
           JOIN execution_processes ep ON ep.id = cat.execution_process_id
           JOIN sessions s ON s.id = ep.session_id
           WHERE ep.dropped = FALSE AND s.workspace_id = ?
           ORDER BY cat.created_at ASC
           LIMIT 300"#,
    )
    .bind(workspace_id)
    .fetch_all(&deployment.db().pool)
    .await?;
    let records = rows
        .into_iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let payload = serde_json::json!({
                "id": id,
                "workspace_id": row.try_get::<Uuid, _>("workspace_id")?,
                "prompt": row.try_get::<Option<String>, _>("prompt")?,
                "summary": row.try_get::<Option<String>, _>("summary")?,
                "seen": row.try_get::<bool, _>("seen")?,
                "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")?,
                "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at")?,
            });
            Ok::<_, sqlx::Error>(MobileSyncRecord {
                entity_type: "chat",
                entity_id: id.to_string(),
                operation: "upsert",
                payload,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ResponseJson(ApiResponse::success(MobileContextResponse {
        records,
    })))
}

async fn tailcat_chat(
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
    Json(command): Json<MobileChatCommand>,
) -> Result<Response, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    post_chat_command(State(deployment), Json(command)).await
}

async fn tailcat_workspace(
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MobileWorkspaceRequest>,
) -> Result<Response, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    post_workspace_request(State(deployment), Json(request)).await
}

/// Create a new card (issue) from Mobile, mirroring the Desktop
/// create-card dialog: title, description, status, priority, tags and an
/// optional pipeline pointer (extension metadata + `vk:pipeline` block).
#[derive(Debug, Deserialize)]
pub struct MobileIssuePipeline {
    #[serde(default)]
    pub pipeline_ids: Vec<String>,
    #[serde(default)]
    pub enabled_ids: Vec<String>,
    pub executor: Option<String>,
    pub custom_text: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MobileIssueCreateRequest {
    pub project_id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub status_id: Option<Uuid>,
    /// "urgent" | "high" | "medium" | "low"
    pub priority: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<Uuid>,
    pub pipeline: Option<MobileIssuePipeline>,
}

async fn post_issue_create(
    deployment: &DeploymentImpl,
    req: MobileIssueCreateRequest,
) -> Result<Response, ApiError> {
    let pool = &deployment.db().pool;
    let title = req.title.trim().to_string();
    if title.is_empty() || title.len() > 500 {
        return Err(ApiError::BadRequest(
            "Mobile card title must contain 1 to 500 characters".to_string(),
        ));
    }
    if Project::find_by_id(pool, req.project_id).await?.is_none() {
        return Err(ApiError::BadRequest("project not found".into()));
    }

    // Default status: first status of the project (same as Desktop dialog).
    let statuses = ProjectStatus::list_by_project(pool, req.project_id).await?;
    let status_id = match req.status_id {
        Some(sid) => {
            if !statuses.iter().any(|s| s.id == sid) {
                return Err(ApiError::BadRequest(
                    "status does not belong to this project".into(),
                ));
            }
            sid
        }
        None => {
            statuses
                .first()
                .ok_or_else(|| ApiError::BadRequest("project has no statuses".into()))?
                .id
        }
    };

    let priority: Option<IssuePriority> = match req.priority.as_deref() {
        None => None,
        Some(raw) => Some(
            serde_json::from_value::<IssuePriority>(serde_json::Value::String(
                raw.trim().to_lowercase(),
            ))
            .map_err(|_| ApiError::BadRequest("unknown priority".into()))?,
        ),
    };

    // Append at the end of the target column.
    let max_sort: Option<f64> = sqlx::query(
        r#"SELECT MAX(sort_order) AS m FROM issues WHERE project_id = ? AND status_id = ?"#,
    )
    .bind(req.project_id)
    .bind(status_id)
    .fetch_one(pool)
    .await?
    .try_get::<Option<f64>, _>("m")
    .or_else(|_| {
        // `sort_order` may be stored as INTEGER on older databases.
        Ok::<_, sqlx::Error>(None)
    })?;
    let sort_order = max_sort.unwrap_or(0.0) + 1.0;

    // Pipeline pointer, compatible with the Desktop `vk:pipeline` block. The
    // heavy stage list stays in extension metadata (read via `get_pipeline`).
    let mut description = req
        .description
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    let extension_metadata = match &req.pipeline {
        Some(p) if !p.pipeline_ids.is_empty() => {
            let mut block = String::from("<!-- vk:pipeline:start -->\n## Pipeline\n");
            if let Some(exec) = p
                .executor
                .as_deref()
                .map(str::trim)
                .filter(|e| !e.is_empty())
            {
                block.push_str(&format!(
                    "- Run this card with the **{exec}** execution agent: pass `executor: \"{exec}\"` when starting the workspace.\n"
                ));
            }
            block.push_str("This card has pipeline stages defined via `get_pipeline` — call that MCP tool BEFORE any code edits, execute the returned stages in order (do not add, skip, or reorder), and report each one via `report_pipeline_stage` as instructed in the tool's response.\n");
            if let Some(custom) = p
                .custom_text
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
            {
                block.push_str(custom);
                block.push('\n');
            }
            block.push_str("<!-- vk:pipeline:end -->");
            description = Some(match description {
                Some(d) => format!("{d}\n\n{block}"),
                None => block,
            });
            serde_json::json!({"pipeline": {
                "pipelineIds": p.pipeline_ids,
                "enabledIds": p.enabled_ids,
                "executor": p.executor,
                "customText": p.custom_text,
            }})
        }
        _ => serde_json::json!({}),
    };

    let issue = crate::routes::local_kanban::create_issue_record(
        pool,
        CreateIssueRequest {
            id: None,
            project_id: req.project_id,
            status_id,
            title,
            description,
            priority,
            start_date: None,
            target_date: None,
            completed_at: None,
            sort_order,
            parent_issue_id: None,
            parent_issue_sort_order: None,
            extension_metadata,
        },
    )
    .await?;

    if !req.tag_ids.is_empty() {
        let project_tags = KanbanTag::list_by_project(pool, req.project_id).await?;
        for tag_id in req.tag_ids {
            if !project_tags.iter().any(|t| t.id == tag_id) {
                return Err(ApiError::BadRequest("tag not found in this project".into()));
            }
            DbIssueTag::create(pool, Uuid::new_v4(), issue.id, tag_id).await?;
        }
    }

    broadcast_board_event(serde_json::json!({
        "type": "issue_created",
        "issue_id": issue.id,
        "status_id": issue.status_id,
        "project_id": issue.project_id,
        "revision": now_seconds()
    }));

    Ok(
        ResponseJson(ApiResponse::<_, Value>::success(serde_json::json!({
            "id": issue.id,
            "simple_id": issue.simple_id,
            "project_id": issue.project_id,
            "status_id": issue.status_id,
        })))
        .into_response(),
    )
}

async fn tailcat_create_issue(
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MobileIssueCreateRequest>,
) -> Result<Response, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    post_issue_create(&deployment, request).await
}

/// Registra o token FCM de um aparelho para push de respostas de agentes.
#[derive(Debug, Deserialize)]
pub struct MobilePushTokenRequest {
    pub token: String,
    pub platform: Option<String>,
    pub label: Option<String>,
}

async fn post_push_token(
    deployment: &DeploymentImpl,
    req: MobilePushTokenRequest,
) -> Result<Response, ApiError> {
    let token = req.token.trim().to_string();
    if token.is_empty() || token.len() > 500 {
        return Err(ApiError::BadRequest("invalid push token".into()));
    }
    db::models::push_token::PushToken::upsert(
        &deployment.db().pool,
        &token,
        req.platform.as_deref().unwrap_or("android"),
        req.label.as_deref(),
    )
    .await
    .map_err(|e| ApiError::BadRequest(format!("push token store failed: {e}")))?;
    Ok(
        ResponseJson(ApiResponse::<_, Value>::success(serde_json::json!({
            "registered": true,
        })))
        .into_response(),
    )
}

/// Salva a config padrão de chat do workspace (executor/modelo/effort/
/// agent/permission/preset). Campos ausentes preservam o salvo.
#[derive(Debug, Deserialize)]
pub struct MobileChatConfigRequest {
    pub executor: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_id: Option<String>,
    pub agent_id: Option<String>,
    pub permission_policy: Option<String>,
    pub preset: Option<String>,
}

pub(crate) async fn read_chat_config(
    pool: &sqlx::SqlitePool,
    workspace_id: Uuid,
) -> Result<WorkspaceChatConfigData, ApiError> {
    Ok(
        Scratch::find_by_id(pool, workspace_id, &ScratchType::WorkspaceChatConfig)
            .await?
            .and_then(|scratch| match scratch.payload {
                ScratchPayload::WorkspaceChatConfig(config) => Some(config),
                _ => None,
            })
            .unwrap_or_default(),
    )
}

async fn post_chat_config(
    deployment: &DeploymentImpl,
    workspace_id: Uuid,
    req: MobileChatConfigRequest,
) -> Result<Response, ApiError> {
    let pool = &deployment.db().pool;
    Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("workspace not found".into()))?;

    if let Some(executor) = &req.executor {
        executor
            .parse::<BaseCodingAgent>()
            .map_err(|_| ApiError::BadRequest("Unknown executor".to_string()))?;
    }
    if let Some(policy) = &req.permission_policy {
        serde_json::from_value::<PermissionPolicy>(serde_json::Value::String(policy.clone()))
            .map_err(|_| ApiError::BadRequest("Unknown permission policy".into()))?;
    }

    let mut config = read_chat_config(pool, workspace_id).await?;
    if let Some(v) = req.executor {
        config.executor = Some(v.to_uppercase());
    }
    if let Some(v) = req.model_id {
        config.model_id = Some(v);
    }
    if let Some(v) = req.reasoning_id {
        config.reasoning_id = Some(v);
    }
    if let Some(v) = req.agent_id {
        config.agent_id = Some(v);
    }
    if let Some(v) = req.permission_policy {
        config.permission_policy = Some(v.to_uppercase());
    }
    if let Some(v) = req.preset {
        config.preset = Some(v.to_uppercase());
    }
    Scratch::update(
        pool,
        workspace_id,
        &ScratchType::WorkspaceChatConfig,
        &UpdateScratch {
            payload: ScratchPayload::WorkspaceChatConfig(config),
        },
    )
    .await?;
    broadcast_board_event(serde_json::json!({
        "type": "chat_config",
        "workspace_id": workspace_id,
        "revision": now_seconds()
    }));
    Ok(
        ResponseJson(ApiResponse::<_, Value>::success(serde_json::json!({
            "workspace_id": workspace_id,
            "saved": true,
        })))
        .into_response(),
    )
}

async fn tailcat_save_chat_config(
    headers: HeaderMap,
    Path(workspace_id): Path<Uuid>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MobileChatConfigRequest>,
) -> Result<Response, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    post_chat_config(&deployment, workspace_id, request).await
}

async fn mobile_save_chat_config(
    Path(workspace_id): Path<Uuid>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MobileChatConfigRequest>,
) -> Result<Response, ApiError> {
    post_chat_config(&deployment, workspace_id, request).await
}

async fn tailcat_register_push_token(
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MobilePushTokenRequest>,
) -> Result<Response, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    post_push_token(&deployment, request).await
}

async fn mobile_register_push_token(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MobilePushTokenRequest>,
) -> Result<Response, ApiError> {
    post_push_token(&deployment, request).await
}

async fn mobile_create_issue(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MobileIssueCreateRequest>,
) -> Result<Response, ApiError> {
    post_issue_create(&deployment, request).await
}

async fn tailcat_update_issue(
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(request): Json<UpdateIssueRequest>,
) -> Result<Response, ApiError> {
    authorize_tailcat(&headers, &deployment)?;
    let issue = local_kanban::merge_and_update_issue(&deployment.db().pool, id, request)
        .await?
        .ok_or_else(|| ApiError::BadRequest("issue not found".into()))?;

    broadcast_board_event(serde_json::json!({
        "type": "issue_updated",
        "issue_id": issue.id,
        "status_id": issue.status_id,
        "title": issue.title,
        "priority": issue.priority,
        "project_id": issue.project_id,
        "revision": now_seconds()
    }));

    Ok(ResponseJson(ApiResponse::<_, Value>::success(issue)).into_response())
}

async fn tailcat_events_ws(
    ws: SignedWsUpgrade,
    headers: HeaderMap,
    State(deployment): State<DeploymentImpl>,
) -> Response {
    if let Err(error) = authorize_tailcat(&headers, &deployment) {
        return error.into_response();
    }
    ws.on_upgrade(move |mut socket: MaybeSignedWebSocket| async move {
        use futures_util::StreamExt;

        let mut events = deployment.stream_events().await;
        let mut board_rx = board_events().subscribe();

        loop {
            tokio::select! {
                board_res = board_rx.recv() => {
                    match board_res {
                        Ok(msg) => {
                            if socket.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                event = events.next() => {
                    match event {
                        Some(Ok(_)) => {
                            if socket
                                .send(Message::Text("{\"type\":\"context_changed\"}".into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        _ => break,
                    }
                }
            }
        }
    })
    .into_response()
}

fn authorize_tailcat(headers: &HeaderMap, deployment: &impl Deployment) -> Result<(), ApiError> {
    let expected = instance::describe(deployment).direct_token;
    let supplied = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if supplied.is_empty() || supplied != expected {
        return Err(ApiError::Forbidden("invalid Tailcat instance token".into()));
    }
    Ok(())
}
