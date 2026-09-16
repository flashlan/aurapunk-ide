pub mod client;
pub mod jsonrpc;
pub mod normalize_logs;
pub mod review;
pub mod slash_commands;
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
};

/// Returns the Codex home directory.
///
/// Checks the `CODEX_HOME` environment variable first, then falls back to `~/.codex`.
/// This allows users to configure a custom location for Codex configuration and state.
pub fn codex_home() -> Option<PathBuf> {
    if let Ok(codex_home) = env::var("CODEX_HOME")
        && !codex_home.trim().is_empty()
    {
        return Some(PathBuf::from(codex_home));
    }
    dirs::home_dir().map(|home| home.join(".codex"))
}

pub(crate) fn resolve_model(model: Option<&str>) -> (Option<&str>, bool) {
    match model.and_then(|m| m.strip_suffix("-fast")) {
        Some(base) => (Some(base), true),
        None => (model, false),
    }
}

const MIN_SUPPORTED_CODEX_VERSION: CodexVersion = CodexVersion::new(0, 124, 0);
const NAMED_PERMISSIONS_VERSION: CodexVersion = CodexVersion::new(0, 149, 0);

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct CodexVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl CodexVersion {
    const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    fn parse(output: &str) -> Option<Self> {
        output.split_whitespace().find_map(|word| {
            let version = word.trim_start_matches('v');
            let mut parts = version.split('.');
            let major = parts.next()?.parse().ok()?;
            let minor = parts.next()?.parse().ok()?;
            let patch = parts
                .next()?
                .split(|c: char| !c.is_ascii_digit())
                .next()?
                .parse()
                .ok()?;
            Some(Self::new(major, minor, patch))
        })
    }
}

impl std::fmt::Display for CodexVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AppServerCompatibility {
    LegacyPermissionProfile,
    NamedPermissions,
}

fn compatibility_for_version(
    version: CodexVersion,
) -> Result<AppServerCompatibility, ExecutorError> {
    if version < MIN_SUPPORTED_CODEX_VERSION {
        return Err(ExecutorError::Io(std::io::Error::other(format!(
            "Codex {version} is not compatible with this app. Supported versions are >= {MIN_SUPPORTED_CODEX_VERSION}. Update Vibe Kanban Alternative or install a compatible Codex version."
        ))));
    }

    if version >= NAMED_PERMISSIONS_VERSION {
        Ok(AppServerCompatibility::NamedPermissions)
    } else {
        Ok(AppServerCompatibility::LegacyPermissionProfile)
    }
}

pub(crate) fn fork_params_from(thread_id: String, params: ThreadStartParams) -> ThreadForkParams {
    ThreadForkParams {
        thread_id,
        model: params.model,
        model_provider: params.model_provider,
        cwd: params.cwd,
        approval_policy: params.approval_policy,
        sandbox: params.sandbox,
        config: params.config,
        base_instructions: params.base_instructions,
        developer_instructions: params.developer_instructions,
        service_tier: params.service_tier,
        ..Default::default()
    }
}

use async_trait::async_trait;
use codex_app_server_protocol::{
    AskForApproval as V2AskForApproval, ReviewTarget, SandboxMode as V2SandboxMode,
    ThreadForkParams, ThreadStartParams, UserInput,
};
use codex_protocol::config_types::ServiceTier;
use derivative::Derivative;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use strum_macros::{AsRefStr, EnumString};
use tokio::process::Command;
use ts_rs::TS;
use workspace_utils::{
    command_ext::GroupSpawnNoWindowExt, msg_store::MsgStore,
    shell::resolve_executable_path_blocking,
};

use self::{
    client::{AppServerClient, LogWriter},
    jsonrpc::{ExitSignalSender, JsonRpcPeer},
    normalize_logs::{Error, normalize_logs},
};
use crate::provider_usage::{ProviderQuotaSnapshot, ProviderQuotaWindow, record_snapshot};
use crate::{
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandBuildError, CommandBuilder, CommandParts, apply_overrides},
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    executors::{
        AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, ExecutorExitResult,
        SlashCommandDescription, SpawnedChild, StandardCodingAgentExecutor,
    },
    logs::utils::patch,
    model_selector::{ModelInfo, ModelSelectorConfig, PermissionPolicy, ReasoningOption},
    profile::ExecutorConfig,
    stdout_dup::create_stdout_pipe_writer,
};

/// Sandbox policy modes for Codex
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum SandboxMode {
    Auto,
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

/// Determines when the user is consulted to approve Codex actions.
///
/// - `UnlessTrusted`: Read-only commands are auto-approved. Everything else will
///   ask the user to approve.
/// - `OnFailure`: All commands run in a restricted sandbox initially. If a
///   command fails, the user is asked to approve execution without the sandbox.
/// - `OnRequest`: The model decides when to ask the user for approval.
/// - `Never`: Commands never ask for approval. Commands that fail in the
///   restricted sandbox are not retried.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum AskForApproval {
    UnlessTrusted,
    OnFailure,
    OnRequest,
    Never,
}

/// Reasoning effort for the underlying model
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr, EnumString)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

/// Model reasoning summary style
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningSummary {
    Auto,
    Concise,
    Detailed,
    None,
}

/// Format for model reasoning summaries
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningSummaryFormat {
    None,
    Experimental,
}

enum CodexSessionAction {
    Chat { prompt: String },
    Review { target: ReviewTarget },
}

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema, Default)]
#[derivative(Debug, PartialEq)]
pub struct Codex {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_for_approval: Option<AskForApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oss: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_summary: Option<ReasoningSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_summary_format: Option<ReasoningSummaryFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_apply_patch_tool: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    #[serde(default)]
    pub plan: bool,
    #[serde(flatten)]
    pub cmd: CmdOverrides,

    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

#[async_trait]
impl StandardCodingAgentExecutor for Codex {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }
        if let Some(reasoning_id) = &executor_config.reasoning_id
            && let Ok(reasoning_effort) = ReasoningEffort::from_str(reasoning_id)
        {
            self.model_reasoning_effort = Some(reasoning_effort)
        }
        if let Some(permission_policy) = &executor_config.permission_policy {
            match permission_policy {
                crate::model_selector::PermissionPolicy::Auto => {
                    self.ask_for_approval = Some(AskForApproval::Never);
                    self.plan = false;
                }
                crate::model_selector::PermissionPolicy::Supervised => {
                    if matches!(self.ask_for_approval, None | Some(AskForApproval::Never)) {
                        self.ask_for_approval = Some(AskForApproval::UnlessTrusted);
                    }
                    self.plan = false;
                }
                crate::model_selector::PermissionPolicy::Plan => {
                    self.plan = true;
                }
            }
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        self.spawn_slash_command(current_dir, prompt, None, env)
            .await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        self.spawn_slash_command(current_dir, prompt, Some(session_id), env)
            .await
    }

    fn normalize_logs(
        &self,
        msg_store: Arc<MsgStore>,
        worktree_path: &Path,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        normalize_logs(msg_store, worktree_path)
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        codex_home().map(|home| home.join("config.toml"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        if let Some(timestamp) = codex_home()
            .and_then(|home| std::fs::metadata(home.join("auth.json")).ok())
            .and_then(|m| m.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
        {
            return AvailabilityInfo::LoginDetected {
                last_auth_timestamp: timestamp,
            };
        }

        let mcp_config_found = self
            .default_mcp_config_path()
            .map(|p| p.exists())
            .unwrap_or(false);

        let installation_indicator_found = codex_home()
            .map(|home| home.join("version.json").exists())
            .unwrap_or(false);

        let binary_found = resolve_executable_path_blocking("codex").is_some();

        if mcp_config_found || installation_indicator_found || binary_found {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        use crate::model_selector::*;
        let permission_policy = if self.plan {
            PermissionPolicy::Plan
        } else if matches!(self.ask_for_approval, None | Some(AskForApproval::Never)) {
            PermissionPolicy::Auto
        } else {
            PermissionPolicy::Supervised
        };

        ExecutorConfig {
            executor: BaseCodingAgent::Codex,
            variant: None,
            model_id: self.model.clone(),
            agent_id: None,
            reasoning_id: self
                .model_reasoning_effort
                .as_ref()
                .map(|e| e.as_ref().to_string()),
            permission_policy: Some(permission_policy),
        }
    }

    async fn discover_options(
        &self,
        workdir: Option<&std::path::Path>,
        repo_path: Option<&std::path::Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let models = self.discover_models_live(workdir, repo_path).await;

        let options = ExecutorDiscoveredOptions {
            model_selector: ModelSelectorConfig {
                models,
                permissions: vec![
                    PermissionPolicy::Auto,
                    PermissionPolicy::Supervised,
                    PermissionPolicy::Plan,
                ],
                ..Default::default()
            },
            slash_commands: vec![
                SlashCommandDescription {
                    name: "compact".to_string(),
                    description: Some(
                        "summarize conversation to prevent hitting the context limit".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "init".to_string(),
                    description: Some(
                        "create an AGENTS.md file with instructions for Codex".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "status".to_string(),
                    description: Some(
                        "show current session configuration and token usage".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "mcp".to_string(),
                    description: Some("list configured MCP tools".to_string()),
                },
                SlashCommandDescription {
                    name: "model".to_string(),
                    description: Some("view or switch the active model".to_string()),
                },
                SlashCommandDescription {
                    name: "fast".to_string(),
                    description: Some(
                        "toggle fast mode for highest speed inference (2× plan usage). Use `/fast on` or `/fast off` to set explicitly".to_string(),
                    ),
                },
            ],
            ..Default::default()
        };
        Ok(Box::pin(futures::stream::once(async move {
            patch::executor_discovered_options(options)
        })))
    }

    async fn spawn_review(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let command_parts = self.build_command_builder()?.build_initial()?;
        let review_target = ReviewTarget::Custom {
            instructions: prompt.to_string(),
        };
        let action = CodexSessionAction::Review {
            target: review_target,
        };
        self.spawn_inner(current_dir, command_parts, action, session_id, env)
            .await
    }
}

impl Codex {
    pub fn base_command() -> &'static str {
        if resolve_executable_path_blocking("codex").is_some() {
            "codex"
        } else {
            "npx -y @openai/codex"
        }
    }

    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::new(Self::base_command());
        builder = builder.extend_params(["app-server"]);
        if self.oss.unwrap_or(false) {
            builder = builder.extend_params(["--oss"]);
        }

        apply_overrides(builder, &self.cmd)
    }

    /// Live-query the real `codex app-server` `model/list` RPC for the
    /// currently available model list, replacing what used to be a
    /// hand-copied snapshot (it had already drifted — retired ids like
    /// `gpt-5.3-codex-spark` stayed listed). This spawns a throwaway
    /// app-server process (the same one real sessions use), calls
    /// `AppServerClient::list_models`, then tears the process down — it's a
    /// one-shot query, not a session, so nothing is left running after it.
    ///
    /// Returns empty when Codex isn't installed/configured, the spawn
    /// fails, or the RPC call times out — never a stale guess.
    async fn discover_models_live(
        &self,
        workdir: Option<&Path>,
        repo_path: Option<&Path>,
    ) -> Vec<ModelInfo> {
        if matches!(self.get_availability_info(), AvailabilityInfo::NotFound) {
            return Vec::new();
        }

        let Ok(command_parts) = self.build_command_builder().and_then(|b| b.build_initial()) else {
            return Vec::new();
        };

        let current_dir = workdir.or(repo_path).unwrap_or_else(|| Path::new("."));
        let env = ExecutionEnv::new(crate::env::RepoContext::default(), false, String::new());

        let (tx, rx) = tokio::sync::oneshot::channel();

        let spawned = self
            .spawn_app_server(
                current_dir,
                command_parts,
                &env,
                move |client, _| async move {
                    let _ = tx.send(client.list_models().await);
                    Ok(())
                },
            )
            .await;

        let Ok(mut spawned) = spawned else {
            tracing::warn!("failed to spawn Codex app-server for model discovery");
            return Vec::new();
        };

        // Generous timeout: the pinned `npx -y @openai/codex@...` version
        // may need a fresh download on first use.
        //
        // Known environment issue (seen 2026-08-20 on an Apple Silicon Mac):
        // macOS Gatekeeper/XProtect (syspolicyd) may identify and delete the
        // downloaded `codex` binary as malware immediately after npx
        // extracts it (`Attempting to move malware to trash: (team:
        // 2DC432GLL2), (id: codex)`), so every spawn attempt fails with
        // ENOENT — this is a system-level security action, not an app bug,
        // and re-downloading does not help (it gets flagged again). Not
        // addressed here; do not attempt to bypass Gatekeeper to work
        // around it.
        let response = tokio::time::timeout(std::time::Duration::from_secs(45), rx).await;

        if let Some(cancel) = spawned.cancel.take() {
            cancel.cancel();
        }
        let _ = spawned.child.kill().await;

        let response = match response {
            Ok(Ok(Ok(response))) => response,
            Ok(Ok(Err(error))) => {
                tracing::warn!("Codex model discovery request failed: {error}");
                return Vec::new();
            }
            Ok(Err(_)) => {
                tracing::warn!("Codex model discovery channel closed before responding");
                return Vec::new();
            }
            Err(_) => {
                tracing::warn!("Codex model discovery timed out");
                return Vec::new();
            }
        };

        response
            .data
            .into_iter()
            .filter(|m| !m.hidden)
            .map(|m| {
                let default_effort = m.default_reasoning_effort.unwrap_or_default();
                ModelInfo {
                    id: m.id,
                    name: m.display_name,
                    provider_id: None,
                    reasoning_options: m
                        .supported_reasoning_efforts
                        .into_iter()
                        .map(|opt| {
                            let id = opt.reasoning_effort;
                            let is_default = id == default_effort;
                            ReasoningOption {
                                id,
                                label: opt.description,
                                is_default,
                            }
                        })
                        .collect(),
                }
            })
            .collect()
    }

    fn build_thread_start_params(&self, cwd: &Path) -> ThreadStartParams {
        let sandbox = match self.sandbox.as_ref() {
            None | Some(SandboxMode::Auto) => Some(V2SandboxMode::WorkspaceWrite), // match the Auto preset in codex
            Some(SandboxMode::ReadOnly) => Some(V2SandboxMode::ReadOnly),
            Some(SandboxMode::WorkspaceWrite) => Some(V2SandboxMode::WorkspaceWrite),
            Some(SandboxMode::DangerFullAccess) => Some(V2SandboxMode::DangerFullAccess),
        };

        let approval_policy = match self.ask_for_approval.as_ref() {
            None if matches!(self.sandbox.as_ref(), None | Some(SandboxMode::Auto)) => {
                // match the Auto preset in codex
                Some(V2AskForApproval::OnRequest)
            }
            None => None,
            Some(AskForApproval::UnlessTrusted) => Some(V2AskForApproval::UnlessTrusted),
            Some(AskForApproval::OnFailure) => Some(V2AskForApproval::OnFailure),
            Some(AskForApproval::OnRequest) => Some(V2AskForApproval::OnRequest),
            Some(AskForApproval::Never) => Some(V2AskForApproval::Never),
        };

        let mut config = self.build_config_overrides();
        // V1 top-level params that moved into config overrides in v2
        if let Some(profile) = &self.profile {
            config
                .get_or_insert_with(HashMap::new)
                .insert("profile".to_string(), Value::String(profile.clone()));
        }
        if let Some(include) = self.include_apply_patch_tool {
            config
                .get_or_insert_with(HashMap::new)
                .insert("include_apply_patch_tool".to_string(), Value::Bool(include));
        }
        if let Some(compact) = &self.compact_prompt {
            config
                .get_or_insert_with(HashMap::new)
                .insert("compact_prompt".to_string(), Value::String(compact.clone()));
        }
        if !matches!(approval_policy, None | Some(V2AskForApproval::Never)) {
            let map = config.get_or_insert_with(HashMap::new);
            map.insert(
                "features.default_mode_request_user_input".to_string(),
                Value::Bool(true),
            );
            map.insert(
                "suppress_unstable_features_warning".to_string(),
                Value::Bool(true),
            );
        }

        let (model, is_fast) = resolve_model(self.model.as_deref());
        let service_tier = if is_fast {
            Some(Some(ServiceTier::Fast))
        } else {
            None
        };

        ThreadStartParams {
            model: model.map(|m| m.to_string()),
            cwd: Some(cwd.to_string_lossy().to_string()),
            approval_policy,
            sandbox,
            config,
            base_instructions: self.base_instructions.clone(),
            model_provider: self.model_provider.clone(),
            developer_instructions: self.developer_instructions.clone(),
            service_tier,
            ..Default::default()
        }
    }

    fn build_config_overrides(&self) -> Option<HashMap<String, Value>> {
        let mut overrides = HashMap::new();

        // This app-server client does not implement DynamicToolCall execution.
        // Keep Codex on its built-in shell path even when a user's global
        // config enables Code Mode, otherwise a run initializes successfully
        // but cannot execute repository commands without code-mode-host.
        overrides.insert("features.code_mode".to_string(), Value::Bool(false));
        overrides.insert("features.code_mode_host".to_string(), Value::Bool(false));

        if let Some(effort) = &self.model_reasoning_effort {
            overrides.insert(
                "model_reasoning_effort".to_string(),
                Value::String(effort.as_ref().to_string()),
            );
        }

        if let Some(summary) = &self.model_reasoning_summary {
            overrides.insert(
                "model_reasoning_summary".to_string(),
                Value::String(summary.as_ref().to_string()),
            );
        }

        if let Some(format) = &self.model_reasoning_summary_format
            && format != &ReasoningSummaryFormat::None
        {
            overrides.insert(
                "model_reasoning_summary_format".to_string(),
                Value::String(format.as_ref().to_string()),
            );
        }

        if overrides.is_empty() {
            None
        } else {
            Some(overrides)
        }
    }

    async fn spawn_inner(
        &self,
        current_dir: &Path,
        command_parts: CommandParts,
        action: CodexSessionAction,
        resume_session: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let params = self.build_thread_start_params(current_dir);
        let resume_session = resume_session.map(|s| s.to_string());

        self.spawn_app_server(
            current_dir,
            command_parts,
            env,
            move |client, _| async move {
                match action {
                    CodexSessionAction::Chat { prompt } => {
                        Self::launch_codex_agent(params, resume_session, prompt, client).await
                    }
                    CodexSessionAction::Review { target } => {
                        review::launch_codex_review(params, resume_session, target, client).await
                    }
                }
            },
        )
        .await
    }

    async fn launch_codex_agent(
        thread_start_params: ThreadStartParams,
        resume_session: Option<String>,
        combined_prompt: String,
        client: Arc<AppServerClient>,
    ) -> Result<(), ExecutorError> {
        let account = client.get_account().await?;
        if account.requires_openai_auth && account.account.is_none() {
            return Err(ExecutorError::AuthRequired(
                "Codex authentication required".to_string(),
            ));
        }

        let (thread_id, resolved_model) = match resume_session {
            None => {
                let response = client.thread_start(thread_start_params).await?;
                (response.thread.id, response.model)
            }
            Some(session_id) => {
                let response = client
                    .thread_fork(fork_params_from(session_id, thread_start_params))
                    .await?;
                tracing::debug!("forked thread, new thread_id={}", response.thread.id);
                (response.thread.id, response.model)
            }
        };

        client.set_resolved_model(resolved_model);
        client.register_session(&thread_id).await?;
        let collaboration_mode = client.initial_collaboration_mode()?;
        client
            .turn_start_with_mode(
                thread_id,
                vec![UserInput::Text {
                    text: combined_prompt,
                    text_elements: vec![],
                }],
                Some(collaboration_mode),
            )
            .await?;

        Ok(())
    }

    /// Common boilerplate for spawning a Codex app server process
    /// Handles process spawning, stdout/stderr piping, exit signal handling, client initialization, and error logging.
    /// Delegates the actual Codex session logic to the provided `task` closure.
    async fn spawn_app_server<F, Fut>(
        &self,
        current_dir: &Path,
        command_parts: CommandParts,
        env: &ExecutionEnv,
        task: F,
    ) -> Result<SpawnedChild, ExecutorError>
    where
        F: FnOnce(Arc<AppServerClient>, ExitSignalSender) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), ExecutorError>> + Send + 'static,
    {
        let (program_path, args) = command_parts.into_resolved().await?;
        let compatibility = self
            .detect_app_server_compatibility(&program_path, &args, current_dir, env)
            .await?;

        let mut process = Command::new(program_path);
        process
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(current_dir)
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1")
            .env("NO_COLOR", "1")
            .env("RUST_LOG", "error")
            .args(&args);

        env.clone()
            .with_profile(&self.cmd)
            .apply_to_command(&mut process);

        let mut child = process.group_spawn_no_window()?;

        let child_stdout = child.inner().stdout.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Codex app server missing stdout"))
        })?;
        let child_stdin = child.inner().stdin.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Codex app server missing stdin"))
        })?;

        let new_stdout = create_stdout_pipe_writer(&mut child)?;
        let (exit_signal_tx, exit_signal_rx) = tokio::sync::oneshot::channel();
        let cancel = tokio_util::sync::CancellationToken::new();

        let auto_approve = matches!(
            (&self.sandbox, &self.ask_for_approval),
            (Some(SandboxMode::DangerFullAccess), None)
        );
        let plan_mode = self.plan;
        let approvals = self.approvals.clone();
        let repo_context = env.repo_context.clone();
        let commit_reminder = env.commit_reminder;
        let commit_reminder_prompt = env.commit_reminder_prompt.clone();
        let cancel_for_task = cancel.clone();

        tokio::spawn(async move {
            let exit_signal_tx = ExitSignalSender::new(exit_signal_tx);
            let log_writer = LogWriter::new(new_stdout);

            // Initialize the AppServerClient
            let client = AppServerClient::new(
                log_writer.clone(),
                approvals,
                auto_approve,
                plan_mode,
                repo_context,
                commit_reminder,
                commit_reminder_prompt,
                compatibility,
                cancel_for_task.clone(),
                exit_signal_tx.clone(),
            );
            let rpc_peer = JsonRpcPeer::spawn(
                child_stdin,
                child_stdout,
                client.clone(),
                exit_signal_tx.clone(),
                cancel_for_task,
            );
            client.connect(rpc_peer);

            let result = async {
                client.initialize().await?;
                if let Ok(rate_limits) = client.get_account_rate_limits().await {
                    record_codex_rate_limits(&rate_limits);
                }
                task(client, exit_signal_tx.clone()).await
            }
            .await;

            if let Err(err) = result {
                match &err {
                    ExecutorError::Io(io_err)
                        if io_err.kind() == std::io::ErrorKind::BrokenPipe =>
                    {
                        // Broken pipe likely means the parent process exited, so we can ignore it
                        return;
                    }
                    ExecutorError::AuthRequired(message) => {
                        log_writer
                            .log_raw(&Error::auth_required(message.clone()).raw())
                            .await
                            .ok();
                        exit_signal_tx
                            .send_exit_signal(ExecutorExitResult::Failure)
                            .await;
                        return;
                    }
                    _ => {
                        tracing::error!("Codex spawn error: {}", err);
                        log_writer
                            .log_raw(&Error::launch_error(err.to_string()).raw())
                            .await
                            .ok();
                    }
                }
                exit_signal_tx
                    .send_exit_signal(ExecutorExitResult::Failure)
                    .await;
            }
        });

        Ok(SpawnedChild {
            child,
            exit_signal: Some(exit_signal_rx),
            cancel: Some(cancel),
        })
    }

    async fn detect_app_server_compatibility(
        &self,
        program_path: &Path,
        app_server_args: &[String],
        current_dir: &Path,
        env: &ExecutionEnv,
    ) -> Result<AppServerCompatibility, ExecutorError> {
        let app_server_index = app_server_args
            .iter()
            .position(|arg| arg == "app-server")
            .ok_or_else(|| {
                ExecutorError::Io(std::io::Error::other(
                    "Codex command is missing the app-server argument",
                ))
            })?;
        let mut version_args = app_server_args[..app_server_index].to_vec();
        version_args.push("--version".to_string());

        let mut command = Command::new(program_path);
        command
            .kill_on_drop(true)
            .current_dir(current_dir)
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1")
            .env("NO_COLOR", "1")
            .args(version_args);
        env.clone()
            .with_profile(&self.cmd)
            .apply_to_command(&mut command);

        let output = command.output().await.map_err(ExecutorError::Io)?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let version = CodexVersion::parse(&stdout)
            .or_else(|| CodexVersion::parse(&stderr))
            .ok_or_else(|| {
                ExecutorError::Io(std::io::Error::other(format!(
                    "Could not determine the Codex version from `{}`. Expected output such as `codex-cli 0.149.1`.",
                    stdout.trim()
                )))
            })?;

        compatibility_for_version(version)
    }
}

fn record_codex_rate_limits(response: &codex_app_server_protocol::GetAccountRateLimitsResponse) {
    let limits = &response.rate_limits;
    let window =
        |name: &str, value: &codex_app_server_protocol::RateLimitWindow| ProviderQuotaWindow {
            name: name.to_string(),
            used_percent: Some(value.used_percent as f64),
            limit_value: None,
            used_value: None,
            unit: Some("percent".to_string()),
            duration_minutes: value.window_duration_mins,
            resets_at: value.resets_at,
            status: limits
                .rate_limit_reached_type
                .as_ref()
                .map(|status| format!("{status:?}")),
        };
    let mut windows = Vec::new();
    if let Some(primary) = &limits.primary {
        windows.push(window("primary", primary));
    }
    if let Some(secondary) = &limits.secondary {
        windows.push(window("secondary", secondary));
    }
    let credits_balance = limits
        .credits
        .as_ref()
        .and_then(|credits| credits.balance.clone());
    let credits_unlimited = limits
        .credits
        .as_ref()
        .is_some_and(|credits| credits.unlimited);
    record_snapshot(ProviderQuotaSnapshot {
        provider: "codex".to_string(),
        plan: limits.plan_type.as_ref().map(|plan| format!("{plan:?}")),
        windows,
        credits_balance,
        credits_unlimited,
        status: limits
            .rate_limit_reached_type
            .as_ref()
            .map(|status| format!("{status:?}")),
        observed_at: 0,
    });
}

#[cfg(test)]
mod tests {
    use super::{
        AppServerCompatibility, CodexVersion, MIN_SUPPORTED_CODEX_VERSION,
        compatibility_for_version, resolve_model,
    };

    #[test]
    fn resolve_model_detects_fast_suffix() {
        assert_eq!(resolve_model(Some("gpt-5.5-fast")), (Some("gpt-5.5"), true));
        assert_eq!(resolve_model(Some("gpt-5.4-fast")), (Some("gpt-5.4"), true));
    }

    #[test]
    fn resolve_model_leaves_non_fast_models_unchanged() {
        assert_eq!(resolve_model(Some("gpt-5.5")), (Some("gpt-5.5"), false));
        assert_eq!(
            resolve_model(Some("gpt-5.4-mini")),
            (Some("gpt-5.4-mini"), false)
        );
        assert_eq!(resolve_model(None), (None, false));
    }

    #[test]
    fn test_serialize_thread_start_params() {
        let codex = super::Codex::default();
        let params = codex.build_thread_start_params(std::path::Path::new("/tmp"));
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("workspace-write"));
        assert_eq!(params.config.as_ref().unwrap()["features.code_mode"], false);
        assert_eq!(
            params.config.as_ref().unwrap()["features.code_mode_host"],
            false
        );
    }

    #[test]
    fn parses_codex_cli_versions() {
        assert_eq!(
            CodexVersion::parse("codex-cli 0.149.1\n"),
            Some(CodexVersion::new(0, 149, 1))
        );
        assert_eq!(
            CodexVersion::parse("warning\ncodex-cli v0.124.0-beta.1"),
            Some(CodexVersion::new(0, 124, 0))
        );
    }

    #[test]
    fn compatibility_matrix_covers_minimum_and_current_versions() {
        assert_eq!(
            compatibility_for_version(MIN_SUPPORTED_CODEX_VERSION).unwrap(),
            AppServerCompatibility::LegacyPermissionProfile
        );
        assert_eq!(
            compatibility_for_version(CodexVersion::new(0, 149, 1)).unwrap(),
            AppServerCompatibility::NamedPermissions
        );
        assert_eq!(
            compatibility_for_version(CodexVersion::new(0, 152, 0)).unwrap(),
            AppServerCompatibility::NamedPermissions
        );
        assert_eq!(
            compatibility_for_version(CodexVersion::new(0, 999, 0)).unwrap(),
            AppServerCompatibility::NamedPermissions
        );
    }

    #[test]
    fn rejects_versions_below_minimum_with_actionable_error() {
        let error = compatibility_for_version(CodexVersion::new(0, 123, 9))
            .unwrap_err()
            .to_string();
        assert!(error.contains("not compatible"));
        assert!(error.contains("Supported versions"));
        assert!(error.contains(">= 0.124.0"));
        assert!(error.contains("install a compatible Codex version"));
    }

    #[tokio::test]
    #[ignore = "requires a locally installed and authenticated Codex CLI"]
    async fn test_discover_models_live() {
        let codex = super::Codex::default();
        let models = codex.discover_models_live(None, None).await;
        assert!(
            !models.is_empty(),
            "Expected models to be discovered from codex"
        );
        let terra = models.iter().find(|m| m.id == "gpt-5.6-terra");
        assert!(terra.is_some(), "Expected gpt-5.6-terra in models");
    }
}
