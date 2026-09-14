use std::{collections::HashMap, process::Stdio, time::Duration};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State, ws::Message},
    http,
    response::{IntoResponse, Json as ResponseJson, Response},
    routing::{get, post, put},
};
use deployment::{Deployment, DeploymentError};
use executors::{
    executors::{
        AvailabilityInfo, BaseAgentCapability, BaseCodingAgent, StandardCodingAgentExecutor,
    },
    mcp_config::{
        McpConfig, migrate_legacy_codex_vibe_kanban_mcp, read_agent_config, write_agent_config,
    },
    profile::{ExecutorConfigs, ExecutorProfileId},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::{
    config::{
        Config, ConfigError, DEFAULT_GENERAL_RULES_POST, DEFAULT_GENERAL_RULES_PRE, SoundFile,
        editor::{EditorConfig, EditorType},
        save_config_to_file,
    },
    container::ContainerService,
    project_config,
};
use tokio::{fs, process::Command as TokioCommand, time::timeout};
use ts_rs::TS;
use utils::{assets::config_path, log_msg::LogMsg, response::ApiResponse};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/info", get(get_user_system_info))
        .route("/config", put(update_config))
        .route("/sounds/{sound}", get(get_sound))
        .route("/mcp-config", get(get_mcp_servers).post(update_mcp_servers))
        .route("/profiles", get(get_profiles).put(update_profiles))
        .route("/export", get(export_config))
        .route("/import", post(import_config))
        .route(
            "/editors/check-availability",
            get(check_editor_availability),
        )
        .route("/agents/check-availability", get(check_agent_availability))
        .route("/tools/install", post(install_tool))
        .route("/agents/preset-options", get(get_agent_preset_options))
        .route("/agents/models", get(get_agent_models))
        .route("/general-rules/resolve", get(resolve_general_rules))
        .route(
            "/agents/discovered-options/ws",
            get(stream_executor_discovered_options_ws),
        )
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct Environment {
    pub os_type: String,
    pub os_version: String,
    pub os_architecture: String,
    pub bitness: String,
}

impl Default for Environment {
    fn default() -> Self {
        Self::new()
    }
}

impl Environment {
    pub fn new() -> Self {
        let info = os_info::get();
        Environment {
            os_type: info.os_type().to_string(),
            os_version: info.version().to_string(),
            os_architecture: info.architecture().unwrap_or("unknown").to_string(),
            bitness: info.bitness().to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct UserSystemInfo {
    pub version: String,
    pub config: Config,
    #[serde(flatten)]
    pub profiles: ExecutorConfigs,
    pub environment: Environment,
    /// Capabilities supported per executor (e.g., { "CLAUDE_CODE": ["SESSION_FORK"] })
    pub capabilities: HashMap<String, Vec<BaseAgentCapability>>,
    pub preview_proxy_port: Option<u16>,
}

// TODO: update frontend, BE schema has changed, this replaces GET /config and /config/constants
#[axum::debug_handler]
async fn get_user_system_info(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<UserSystemInfo>> {
    let config = deployment.config().read().await.clone();

    let user_system_info = UserSystemInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        config,
        profiles: ExecutorConfigs::get_cached(),
        environment: Environment::new(),
        capabilities: {
            let mut caps: HashMap<String, Vec<BaseAgentCapability>> = HashMap::new();
            let profs = ExecutorConfigs::get_cached();
            for key in profs.executors.keys() {
                if let Some(agent) = profs.get_coding_agent(&ExecutorProfileId::new(*key)) {
                    caps.insert(key.to_string(), agent.capabilities());
                }
            }
            caps
        },
        preview_proxy_port: deployment.client_info().get_preview_proxy_port(),
    };

    ResponseJson(ApiResponse::success(user_system_info))
}

async fn update_config(
    State(deployment): State<DeploymentImpl>,
    Json(new_config): Json<Config>,
) -> ResponseJson<ApiResponse<Config>> {
    let config_path = config_path();

    // Validate git branch prefix
    if !git::is_valid_branch_prefix(&new_config.git_branch_prefix) {
        return ResponseJson(ApiResponse::error(
            "Invalid git branch prefix. Must be a valid git branch name component without slashes.",
        ));
    }

    // Get old config state before updating
    let _old_config = deployment.config().read().await.clone();

    match save_config_to_file(&new_config, &config_path).await {
        Ok(_) => {
            {
                let mut config = deployment.config().write().await;
                *config = new_config.clone();
            } // tokio write-lock released here

            // Hot-reload the origin-check middleware cache with the new list.
            // An empty list resets the cache to the VK_ALLOWED_ORIGINS env seed.
            // Done AFTER the tokio config lock is released so the std RwLock
            // write never blocks an async worker thread while holding it.
            crate::middleware::origin::set_allowed_origins(&new_config.allowed_origins);

            // Track config events when fields transition from false → true and run side effects

            ResponseJson(ApiResponse::success(new_config))
        }
        Err(e) => ResponseJson(ApiResponse::error(&format!("Failed to save config: {}", e))),
    }
}

#[derive(Debug, Deserialize)]
pub struct ResolveGeneralRulesQuery {
    pub workspace_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
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

    // If no tags were used (e.g. legacy plain text), treat whole text as pre-work rules
    if pre.is_empty() && post.is_empty() && !raw.trim().is_empty() {
        pre = raw.trim().to_string();
    }

    (pre, post)
}

/// `GET /api/general-rules/resolve` — resolved by the `get_rules` MCP tool.
/// Returns global pre/post rules joined with any project-scoped pre/post rules
/// resolved from the workspace/project context.
async fn resolve_general_rules(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ResolveGeneralRulesQuery>,
) -> ResponseJson<ApiResponse<api_types::ResolvedGeneralRules>> {
    let pool = &deployment.db().pool;
    let config = deployment.config().read().await;
    let mut pre = config
        .general_rules_pre
        .clone()
        .unwrap_or_else(|| DEFAULT_GENERAL_RULES_PRE.to_string());
    let mut post = config
        .general_rules_post
        .clone()
        .unwrap_or_else(|| DEFAULT_GENERAL_RULES_POST.to_string());

    let target_project_id = match (query.project_id, query.workspace_id) {
        (Some(pid), _) => Some(pid),
        (None, Some(wid)) => {
            if let Ok(Some((_issue_id, project_id))) =
                db::models::issue_workspace::IssueWorkspace::find_issue_and_project_by_workspace(
                    pool, wid,
                )
                .await
            {
                Some(project_id)
            } else {
                None
            }
        }
        (None, None) => None,
    };

    if let Some(pid) = target_project_id
        && let Ok((project_prompt, _)) =
            db::models::project::Project::resolve_orchestrator_prompt(pool, pid).await
    {
        let (proj_pre, proj_post) = parse_rules_pre_post(&project_prompt);
        if !proj_pre.trim().is_empty() {
            pre = format!(
                "{}\n\n---\n## Project Pre-Work Rules\n{}",
                pre,
                proj_pre.trim()
            );
        }
        if !proj_post.trim().is_empty() {
            post = format!(
                "{}\n\n---\n## Project Closing Checklist & Prohibitions\n{}",
                post,
                proj_post.trim()
            );
        }
    }

    ResponseJson(ApiResponse::success(api_types::ResolvedGeneralRules {
        pre,
        post,
    }))
}

async fn get_sound(Path(sound): Path<SoundFile>) -> Result<Response, ApiError> {
    let sound = sound.serve().await.map_err(DeploymentError::Other)?;
    let response = Response::builder()
        .status(http::StatusCode::OK)
        .header(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("audio/wav"),
        )
        .body(Body::from(sound.data.into_owned()))
        .unwrap();
    Ok(response)
}

#[derive(TS, Debug, Deserialize)]
pub struct McpServerQuery {
    executor: BaseCodingAgent,
}

#[derive(TS, Debug, Serialize, Deserialize)]
pub struct GetMcpServerResponse {
    // servers: HashMap<String, Value>,
    mcp_config: McpConfig,
    config_path: String,
}

#[derive(TS, Debug, Serialize, Deserialize)]
pub struct UpdateMcpServersBody {
    servers: HashMap<String, Value>,
}

async fn get_mcp_servers(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<McpServerQuery>,
) -> Result<ResponseJson<ApiResponse<GetMcpServerResponse>>, ApiError> {
    let coding_agent = ExecutorConfigs::get_cached()
        .get_coding_agent(&ExecutorProfileId::new(query.executor))
        .ok_or(ConfigError::ValidationError(
            "Executor not found".to_string(),
        ))?;

    if !coding_agent.supports_mcp() {
        return Ok(ResponseJson(ApiResponse::error(
            "MCP not supported by this executor",
        )));
    }

    // Resolve supplied config path or agent default
    let config_path = match coding_agent.default_mcp_config_path() {
        Some(path) => path,
        None => {
            return Ok(ResponseJson(ApiResponse::error(
                "Could not determine config file path",
            )));
        }
    };

    let mut mcpc = coding_agent.get_mcp_config();
    let mut raw_config = read_agent_config(&config_path, &mcpc).await?;
    if query.executor == BaseCodingAgent::Codex
        && migrate_legacy_codex_vibe_kanban_mcp(&mut raw_config)
    {
        write_agent_config(&config_path, &mcpc, &raw_config).await?;
    }
    let servers = get_mcp_servers_from_config_path(&raw_config, &mcpc.servers_path);
    mcpc.set_servers(servers);
    Ok(ResponseJson(ApiResponse::success(GetMcpServerResponse {
        mcp_config: mcpc,
        config_path: config_path.to_string_lossy().to_string(),
    })))
}

async fn update_mcp_servers(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<McpServerQuery>,
    Json(payload): Json<UpdateMcpServersBody>,
) -> Result<ResponseJson<ApiResponse<String>>, ApiError> {
    let profiles = ExecutorConfigs::get_cached();
    let agent = profiles
        .get_coding_agent(&ExecutorProfileId::new(query.executor))
        .ok_or(ConfigError::ValidationError(
            "Executor not found".to_string(),
        ))?;

    if !agent.supports_mcp() {
        return Ok(ResponseJson(ApiResponse::error(
            "This executor does not support MCP servers",
        )));
    }

    // Resolve supplied config path or agent default
    let config_path = match agent.default_mcp_config_path() {
        Some(path) => path.to_path_buf(),
        None => {
            return Ok(ResponseJson(ApiResponse::error(
                "Could not determine config file path",
            )));
        }
    };

    let mcpc = agent.get_mcp_config();
    match update_mcp_servers_in_config(&config_path, &mcpc, payload.servers).await {
        Ok(message) => Ok(ResponseJson(ApiResponse::success(message))),
        Err(e) => Ok(ResponseJson(ApiResponse::error(&format!(
            "Failed to update MCP servers: {}",
            e
        )))),
    }
}

async fn update_mcp_servers_in_config(
    config_path: &std::path::Path,
    mcpc: &McpConfig,
    new_servers: HashMap<String, Value>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    // Read existing config (JSON or TOML depending on agent)
    let mut config = read_agent_config(config_path, mcpc).await?;

    // Get the current server count for comparison
    let old_servers = get_mcp_servers_from_config_path(&config, &mcpc.servers_path).len();

    // Set the MCP servers using the correct attribute path
    set_mcp_servers_in_config_path(&mut config, &mcpc.servers_path, &new_servers)?;

    // Write the updated config back to file (JSON or TOML depending on agent)
    write_agent_config(config_path, mcpc, &config).await?;

    let new_count = new_servers.len();
    let message = match (old_servers, new_count) {
        (0, 0) => "No MCP servers configured".to_string(),
        (0, n) => format!("Added {} MCP server(s)", n),
        (old, new) if old == new => format!("Updated MCP server configuration ({} server(s))", new),
        (old, new) => format!(
            "Updated MCP server configuration (was {}, now {})",
            old, new
        ),
    };

    Ok(message)
}

/// Helper function to get MCP servers from config using a path
fn get_mcp_servers_from_config_path(raw_config: &Value, path: &[String]) -> HashMap<String, Value> {
    let mut current = raw_config;
    for part in path {
        current = match current.get(part) {
            Some(val) => val,
            None => return HashMap::new(),
        };
    }
    // Extract the servers object
    match current.as_object() {
        Some(servers) => servers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        None => HashMap::new(),
    }
}

/// Helper function to set MCP servers in config using a path
fn set_mcp_servers_in_config_path(
    raw_config: &mut Value,
    path: &[String],
    servers: &HashMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Ensure config is an object
    if !raw_config.is_object() {
        *raw_config = serde_json::json!({});
    }

    let mut current = raw_config;
    // Navigate/create the nested structure (all parts except the last)
    for part in &path[..path.len() - 1] {
        if current.get(part).is_none() {
            current
                .as_object_mut()
                .unwrap()
                .insert(part.to_string(), serde_json::json!({}));
        }
        current = current.get_mut(part).unwrap();
        if !current.is_object() {
            *current = serde_json::json!({});
        }
    }

    // Set the final attribute
    let final_attr = path.last().unwrap();
    current
        .as_object_mut()
        .unwrap()
        .insert(final_attr.to_string(), serde_json::to_value(servers)?);

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfilesContent {
    pub content: String,
    pub path: String,
}

async fn get_profiles(
    State(_deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<ProfilesContent>> {
    let profiles_path = utils::assets::profiles_path();

    // Use cached data to ensure consistency with runtime and PUT updates
    let profiles = ExecutorConfigs::get_cached();

    let content = serde_json::to_string_pretty(&profiles).unwrap_or_else(|e| {
        tracing::error!("Failed to serialize profiles to JSON: {}", e);
        serde_json::to_string_pretty(&ExecutorConfigs::from_defaults())
            .unwrap_or_else(|_| "{}".to_string())
    });

    ResponseJson(ApiResponse::success(ProfilesContent {
        content,
        path: profiles_path.display().to_string(),
    }))
}

async fn update_profiles(
    State(_deployment): State<DeploymentImpl>,
    body: String,
) -> ResponseJson<ApiResponse<String>> {
    // Try to parse as ExecutorProfileConfigs format
    match serde_json::from_str::<ExecutorConfigs>(&body) {
        Ok(executor_profiles) => {
            // Save the profiles to file
            match executor_profiles.save_overrides() {
                Ok(_) => {
                    tracing::info!("Executor profiles saved successfully");
                    // Reload the cached profiles
                    ExecutorConfigs::reload();
                    ResponseJson(ApiResponse::success(
                        "Executor profiles updated successfully".to_string(),
                    ))
                }
                Err(e) => {
                    tracing::error!("Failed to save executor profiles: {}", e);
                    ResponseJson(ApiResponse::error(&format!(
                        "Failed to save executor profiles: {}",
                        e
                    )))
                }
            }
        }
        Err(e) => ResponseJson(ApiResponse::error(&format!(
            "Invalid executor profiles format: {}",
            e
        ))),
    }
}

#[derive(Debug, Serialize)]
pub struct ConfigExport {
    /// The exported config as a TOML document.
    pub content: String,
}

/// `GET /api/config/export` — serialise the static project/repo/agent config
/// (projects, repos, links, kanban columns, executor profiles) to TOML.
async fn export_config(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<ConfigExport>> {
    match project_config::export_to_string(&deployment.db().pool).await {
        Ok(content) => ResponseJson(ApiResponse::success(ConfigExport { content })),
        Err(e) => ResponseJson(ApiResponse::error(&format!("Export failed: {e}"))),
    }
}

/// `POST /api/config/import` — non-destructively upsert a TOML config document
/// (request body) into the DB and apply any embedded executor profiles.
async fn import_config(
    State(deployment): State<DeploymentImpl>,
    body: String,
) -> ResponseJson<ApiResponse<project_config::ImportSummary>> {
    match project_config::import_from_str(&deployment.db().pool, &body).await {
        Ok(summary) => ResponseJson(ApiResponse::success(summary)),
        Err(e) => ResponseJson(ApiResponse::error(&format!("Import failed: {e}"))),
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CheckEditorAvailabilityQuery {
    editor_type: EditorType,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CheckEditorAvailabilityResponse {
    available: bool,
}

async fn check_editor_availability(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<CheckEditorAvailabilityQuery>,
) -> ResponseJson<ApiResponse<CheckEditorAvailabilityResponse>> {
    // Construct a minimal EditorConfig for checking
    let editor_config = EditorConfig::new(
        query.editor_type,
        None,  // custom_command
        None,  // remote_ssh_host
        None,  // remote_ssh_user
        false, // auto_install_extension
    );

    let available = editor_config.check_availability().await;
    ResponseJson(ApiResponse::success(CheckEditorAvailabilityResponse {
        available,
    }))
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CheckAgentAvailabilityQuery {
    executor: BaseCodingAgent,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum InstallToolKind {
    Agent,
    Editor,
}

#[derive(Debug, Deserialize, TS)]
pub struct InstallToolRequest {
    pub kind: InstallToolKind,
    pub id: String,
}

#[derive(Debug, Serialize, TS)]
pub struct InstallToolResponse {
    pub installed: bool,
    pub message: String,
}

fn npm_install_script(package: &str, executable: &str) -> String {
    format!(
        r#"set -eu
command -v npm >/dev/null 2>&1 || {{ echo "npm is required to install this tool" >&2; exit 127; }}
mkdir -p "$HOME/.local"
npm install --prefix "$HOME/.local" --global {package}
export PATH="$HOME/.local/bin:$PATH"
command -v {executable} >/dev/null 2>&1 || {{ echo "The package installed, but {executable} was not found on PATH" >&2; exit 127; }}
"#
    )
}

fn agent_install_script(agent: &BaseCodingAgent) -> Option<String> {
    let (package, executable) = match agent {
        BaseCodingAgent::ClaudeCode | BaseCodingAgent::ClaudeCodeHeaded => {
            ("@anthropic-ai/claude-code", "claude")
        }
        BaseCodingAgent::Codex => ("@openai/codex", "codex"),
        BaseCodingAgent::Gemini => ("@google/gemini-cli", "gemini"),
        BaseCodingAgent::Opencode | BaseCodingAgent::OpencodeHeaded => ("opencode-ai", "opencode"),
        BaseCodingAgent::Amp => ("@sourcegraph/amp", "amp"),
        BaseCodingAgent::Copilot => ("@github/copilot", "copilot"),
        BaseCodingAgent::QwenCode => ("@qwen-code/qwen-code", "qwen"),
        BaseCodingAgent::CursorAgent => {
            return Some(
                r#"set -eu
command -v curl >/dev/null 2>&1 || { echo "curl is required to install Cursor Agent" >&2; exit 127; }
curl https://cursor.com/install -fsS | bash
export PATH="$HOME/.local/bin:$PATH"
command -v cursor-agent >/dev/null 2>&1 || { echo "Cursor Agent was installed, but cursor-agent was not found on PATH" >&2; exit 127; }
"#
                .to_string(),
            );
        }
        BaseCodingAgent::Antigravity | BaseCodingAgent::AntigravityHeaded => return None,
        BaseCodingAgent::Droid => return None,
    };

    Some(npm_install_script(package, executable))
}

fn editor_install_script(editor: &EditorType) -> Option<String> {
    let (macos_cask, windows_id) = match editor {
        EditorType::VsCode => ("visual-studio-code", "Microsoft.VisualStudioCode"),
        EditorType::VsCodeInsiders => (
            "visual-studio-code@insiders",
            "Microsoft.VisualStudioCode.Insiders",
        ),
        EditorType::Cursor => ("cursor", "Anysphere.Cursor"),
        EditorType::Windsurf => ("windsurf", "Codeium.Windsurf"),
        EditorType::IntelliJ => ("intellij-idea", "JetBrains.IntelliJIDEA.Community"),
        EditorType::Zed => ("zed", "ZedIndustries.Zed"),
        EditorType::Xcode | EditorType::GoogleAntigravity | EditorType::Custom => return None,
    };

    Some(format!(
        r#"set -eu
case "$(uname -s 2>/dev/null || printf unknown)" in
  Darwin)
    command -v brew >/dev/null 2>&1 || {{ echo "Homebrew is required to install this editor" >&2; exit 127; }}
    brew install --cask {macos_cask}
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    command -v winget >/dev/null 2>&1 || {{ echo "winget is required to install this editor" >&2; exit 127; }}
    winget install --id {windows_id} --exact --accept-package-agreements --accept-source-agreements
    ;;
  *)
    echo "Automatic graphical-editor installation is supported on macOS (Homebrew) and Windows (winget). Cloud/Linux environments are CLI-first." >&2
    exit 2
    ;;
esac
"#
    ))
}

fn install_script(request: &InstallToolRequest) -> Option<String> {
    match request.kind {
        InstallToolKind::Agent => {
            let agent = request.id.parse::<BaseCodingAgent>().ok()?;
            agent_install_script(&agent)
        }
        InstallToolKind::Editor => {
            let editor = request.id.parse::<EditorType>().ok()?;
            editor_install_script(&editor)
        }
    }
}

async fn install_tool(
    axum::extract::State(_deployment): axum::extract::State<DeploymentImpl>,
    axum::Json(request): axum::Json<InstallToolRequest>,
) -> Result<ResponseJson<ApiResponse<InstallToolResponse>>, ApiError> {
    let Some(script) = install_script(&request) else {
        return Err(ApiError::BadRequest(format!(
            "No automatic installer is available for {}",
            request.id
        )));
    };

    let output = timeout(
        Duration::from_secs(15 * 60),
        TokioCommand::new("sh")
            .args(["-lc", &script])
            .env("CI", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| ApiError::BadRequest("Tool installation timed out after 15 minutes".into()))?
    .map_err(ApiError::Io)?;

    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr);
        let details = details.trim();
        let details = if details.len() > 2000 {
            &details[details.len() - 2000..]
        } else {
            details
        };
        return Err(ApiError::BadRequest(format!(
            "Installation failed for {}: {}",
            request.id, details
        )));
    }

    Ok(ResponseJson(ApiResponse::success(InstallToolResponse {
        installed: true,
        message: format!("{} installation completed", request.id),
    })))
}

async fn check_agent_availability(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<CheckAgentAvailabilityQuery>,
) -> ResponseJson<ApiResponse<AvailabilityInfo>> {
    let profiles = ExecutorConfigs::get_cached();
    let profile_id = ExecutorProfileId::new(query.executor);

    let info = match profiles.get_coding_agent(&profile_id) {
        Some(agent) => agent.get_availability_info(),
        None => AvailabilityInfo::NotFound,
    };

    ResponseJson(ApiResponse::success(info))
}

#[derive(Debug, Deserialize, TS)]
pub struct AgentPresetOptionsQuery {
    pub executor: BaseCodingAgent,
    pub variant: Option<String>,
}

async fn get_agent_preset_options(
    Query(query): Query<AgentPresetOptionsQuery>,
) -> ResponseJson<ApiResponse<executors::profile::ExecutorConfig>> {
    let profiles = ExecutorConfigs::get_cached();
    let profile_id = if let Some(variant) = query.variant {
        ExecutorProfileId::with_variant(query.executor, variant)
    } else {
        ExecutorProfileId::new(query.executor)
    };

    let options = match profiles.get_coding_agent(&profile_id) {
        Some(agent) => agent.get_preset_options(),
        None => {
            // Return a default config if not found
            executors::profile::ExecutorConfig::new(query.executor)
        }
    };

    ResponseJson(ApiResponse::success(options))
}

#[derive(Debug, Deserialize, TS)]
pub struct AgentModelsQuery {
    pub executor: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct DiscoveredModelEntry {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Full discovered selector for an executor (models + reasoning, providers,
/// agents, permissions, default model). Consumes the same discovery stream as
/// the `/api/agents/discovered-options/ws` endpoint, merging the initial
/// `/options` snapshot with incremental patches. Used by the mobile sync
/// catalog so the APK can render the same CLI -> provider -> model -> effort
/// hierarchy (plus agent modes) as the Desktop workspace.
pub async fn discover_selector_for_agent(
    deployment: &DeploymentImpl,
    base_agent: BaseCodingAgent,
) -> Option<executors::executor_discovery::ExecutorDiscoveredOptions> {
    use futures_util::StreamExt;

    let profile_id = ExecutorProfileId::new(base_agent);
    let mut selector: Option<executors::executor_discovery::ExecutorDiscoveredOptions> = None;

    if let Ok(Some(mut stream)) = deployment
        .container()
        .discover_executor_options(profile_id, None, None, None)
        .await
    {
        while let Some(patch) = stream.next().await {
            for op in patch.0 {
                let value_opt = match &op {
                    json_patch::PatchOperation::Add(op) => Some((&op.path, &op.value)),
                    json_patch::PatchOperation::Replace(op) => Some((&op.path, &op.value)),
                    _ => None,
                };
                let (path, val) = match value_opt {
                    Some(v) => v,
                    None => continue,
                };
                if path == "/options" {
                    if let Ok(opts) = serde_json::from_value::<
                        executors::executor_discovery::ExecutorDiscoveredOptions,
                    >(val.clone())
                    {
                        selector = Some(opts);
                    }
                } else if path == "/options/model_selector/models" {
                    if let Ok(models) = serde_json::from_value::<
                        Vec<executors::model_selector::ModelInfo>,
                    >(val.clone())
                    {
                        match selector.as_mut() {
                            Some(opts) => opts.model_selector.models = models,
                            None => {
                                let mut opts =
                                    executors::executor_discovery::ExecutorDiscoveredOptions::default(
                                    );
                                opts.model_selector.models = models;
                                selector = Some(opts);
                            }
                        }
                    }
                } else if path == "/options/model_selector/providers" {
                    if let Ok(providers) = serde_json::from_value::<
                        Vec<executors::model_selector::ModelProvider>,
                    >(val.clone())
                    {
                        match selector.as_mut() {
                            Some(opts) => opts.model_selector.providers = providers,
                            None => {
                                let mut opts =
                                    executors::executor_discovery::ExecutorDiscoveredOptions::default(
                                    );
                                opts.model_selector.providers = providers;
                                selector = Some(opts);
                            }
                        }
                    }
                } else if path == "/options/model_selector/agents" {
                    if let Ok(agents) = serde_json::from_value::<
                        Vec<executors::model_selector::AgentInfo>,
                    >(val.clone())
                    {
                        match selector.as_mut() {
                            Some(opts) => opts.model_selector.agents = agents,
                            None => {
                                let mut opts =
                                    executors::executor_discovery::ExecutorDiscoveredOptions::default(
                                    );
                                opts.model_selector.agents = agents;
                                selector = Some(opts);
                            }
                        }
                    }
                } else if path == "/options/model_selector/default_model" {
                    let default_model: Option<String> =
                        serde_json::from_value(val.clone()).unwrap_or(None);
                    match selector.as_mut() {
                        Some(opts) => opts.model_selector.default_model = default_model,
                        None => {
                            let mut opts =
                                executors::executor_discovery::ExecutorDiscoveredOptions::default();
                            opts.model_selector.default_model = default_model;
                            selector = Some(opts);
                        }
                    }
                }
            }
        }
    }
    selector
}

pub async fn discover_models_for_agent(
    deployment: &DeploymentImpl,
    base_agent: BaseCodingAgent,
) -> Vec<DiscoveredModelEntry> {
    let profile_id = ExecutorProfileId::new(base_agent);
    let mut models_out = Vec::new();

    if let Ok(Some(mut stream)) = deployment
        .container()
        .discover_executor_options(profile_id, None, None, None)
        .await
    {
        use futures_util::StreamExt;
        while let Some(patch) = stream.next().await {
            for op in patch.0 {
                let value_opt = match &op {
                    json_patch::PatchOperation::Add(op) => Some((&op.path, &op.value)),
                    json_patch::PatchOperation::Replace(op) => Some((&op.path, &op.value)),
                    _ => None,
                };
                if let Some((path, val)) = value_opt {
                    if path == "/options" {
                        if let Ok(opts) = serde_json::from_value::<
                            executors::executor_discovery::ExecutorDiscoveredOptions,
                        >(val.clone())
                        {
                            for m in opts.model_selector.models {
                                if !models_out
                                    .iter()
                                    .any(|existing: &DiscoveredModelEntry| existing.id == m.id)
                                {
                                    models_out.push(DiscoveredModelEntry {
                                        id: m.id,
                                        name: m.name,
                                        provider: m.provider_id,
                                    });
                                }
                            }
                        }
                    } else if path.starts_with("/options/model_selector/models")
                        || path.starts_with("/model_selector/models")
                    {
                        if let Ok(model_list) = serde_json::from_value::<
                            Vec<executors::model_selector::ModelInfo>,
                        >(val.clone())
                        {
                            for m in model_list {
                                if !models_out
                                    .iter()
                                    .any(|existing: &DiscoveredModelEntry| existing.id == m.id)
                                {
                                    models_out.push(DiscoveredModelEntry {
                                        id: m.id,
                                        name: m.name,
                                        provider: m.provider_id,
                                    });
                                }
                            }
                        } else if let Ok(model) = serde_json::from_value::<
                            executors::model_selector::ModelInfo,
                        >(val.clone())
                            && !models_out
                                .iter()
                                .any(|existing: &DiscoveredModelEntry| existing.id == model.id)
                        {
                            models_out.push(DiscoveredModelEntry {
                                id: model.id,
                                name: model.name,
                                provider: model.provider_id,
                            });
                        }
                    }
                }
            }
        }
    }
    models_out
}

async fn get_agent_models(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<AgentModelsQuery>,
) -> ResponseJson<ApiResponse<Vec<DiscoveredModelEntry>>> {
    use std::str::FromStr;

    let base_agent = match BaseCodingAgent::from_str(&query.executor.to_uppercase()) {
        Ok(a) => a,
        Err(_) => {
            match query
                .executor
                .to_lowercase()
                .replace(['-', '_'], "")
                .as_str()
            {
                "antigravity" => BaseCodingAgent::Antigravity,
                "gemini" => BaseCodingAgent::Gemini,
                "claude" | "claudecode" => BaseCodingAgent::ClaudeCode,
                "codex" => BaseCodingAgent::Codex,
                "opencode" => BaseCodingAgent::Opencode,
                "qwen" | "qwencode" => BaseCodingAgent::QwenCode,
                "droid" => BaseCodingAgent::Droid,
                "cursor" | "cursoragent" => BaseCodingAgent::CursorAgent,
                "copilot" => BaseCodingAgent::Copilot,
                "amp" => BaseCodingAgent::Amp,
                _ => return ResponseJson(ApiResponse::success(Vec::new())),
            }
        }
    };

    let models = discover_models_for_agent(&deployment, base_agent).await;
    ResponseJson(ApiResponse::success(models))
}

#[derive(Debug, Deserialize)]
pub struct ExecutorDiscoveredOptionsStreamQuery {
    executor: BaseCodingAgent,
    #[serde(default)]
    session_id: Option<Uuid>,
    #[serde(default)]
    workspace_id: Option<Uuid>,
    #[serde(default)]
    repo_id: Option<Uuid>,
}

pub async fn stream_executor_discovered_options_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ExecutorDiscoveredOptionsStreamQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_executor_discovered_options_ws(socket, deployment, query).await {
            tracing::warn!("discovered options WS closed: {}", e);
        }
    })
}

async fn handle_executor_discovered_options_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    query: ExecutorDiscoveredOptionsStreamQuery,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;

    match deployment
        .container()
        .discover_executor_options(
            ExecutorProfileId::new(query.executor),
            query.session_id,
            query.workspace_id,
            query.repo_id,
        )
        .await
    {
        Ok(Some(mut stream)) => {
            if let Some(patch) = stream.next().await {
                let _ = socket
                    .send(LogMsg::JsonPatch(patch).to_ws_message_unchecked())
                    .await;
            }

            let _ = socket.send(LogMsg::Ready.to_ws_message_unchecked()).await;

            loop {
                tokio::select! {
                    patch = stream.next() => {
                        let Some(patch) = patch else {
                            break;
                        };
                        if socket
                            .send(LogMsg::JsonPatch(patch).to_ws_message_unchecked())
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    inbound = socket.recv() => {
                        match inbound {
                            Ok(Some(Message::Close(_))) => break,
                            Ok(Some(_)) => {}
                            Ok(None) => break,
                            Err(_) => break,
                        }
                    }
                }
            }
        }
        Ok(None) => {
            let _ = socket.send(LogMsg::Ready.to_ws_message_unchecked()).await;
        }
        Err(e) => {
            tracing::warn!("Failed to start discovered options stream: {}", e);
        }
    }

    let _ = socket
        .send(LogMsg::Finished.to_ws_message_unchecked())
        .await;
    Ok(())
}
