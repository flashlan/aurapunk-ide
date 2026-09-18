use std::{path::Path, process::Stdio, sync::Arc};

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, process::Command};
use ts_rs::TS;
use workspace_utils::{command_ext::GroupSpawnNoWindowExt, msg_store::MsgStore};

use crate::{
    command::{CmdOverrides, CommandBuildError, CommandBuilder, apply_overrides},
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    executors::{
        AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, SpawnedChild,
        StandardCodingAgentExecutor,
    },
    logs::utils::{EntryIndexProvider, patch},
    model_selector::{ModelInfo, ModelProvider, ModelSelectorConfig, PermissionPolicy},
    profile::ExecutorConfig,
};

pub mod normalize_logs;

/// Command Code's non-interactive (`-p`) mode reads the prompt from stdin when
/// no positional query is supplied, so the full prompt is piped in rather than
/// passed as an argument (avoids ARG_MAX limits on large prompts).
const BASE_COMMAND: &str = "command-code";

/// Command Code CLI executor configuration
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema)]
pub struct CommandCode {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        title = "Model",
        description = "Model id to run on, e.g. deepseek/deepseek-v4-flash (see `command-code --list-models`)"
    )]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        title = "Reasoning Effort",
        description = "Reasoning effort level for the session (e.g. low, medium, high) — depends on the model"
    )]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        title = "Yolo",
        description = "Bypass all permission prompts (--yolo). Required for file writes and shell commands in headless mode."
    )]
    pub yolo: Option<bool>,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
}

impl CommandCode {
    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::new(BASE_COMMAND)
            // Machine-readable NDJSON event stream + a final result line.
            .extend_params(["--output-format", "json"])
            // Automated runs should never block on the taste-onboarding prompt.
            .extend_params(["--skip-onboarding", "--no-auto-update"]);

        if let Some(model) = &self.model {
            builder = builder.extend_params(["-m", model.as_str()]);
        }
        if let Some(effort) = &self.reasoning_effort {
            builder = builder.extend_params(["--effort", effort.as_str()]);
        }
        if self.yolo.unwrap_or(false) {
            builder = builder.extend_params(["--yolo"]);
        }

        apply_overrides(builder, &self.cmd)
    }

    /// Parse `command-code --list-models` output into providers/models.
    ///
    /// Model rows are `<provider>/<model>` followed by two-or-more spaces and a
    /// human description; category headers ("Open Source") and the summary line
    /// are ignored.
    fn parse_list_models_output(
        output: &str,
    ) -> (Vec<ModelProvider>, Vec<ModelInfo>, Option<String>) {
        let mut providers: Vec<ModelProvider> = Vec::new();
        let mut models: Vec<ModelInfo> = Vec::new();
        let mut default_model: Option<String> = None;

        for line in output.lines() {
            let trimmed = line.trim();
            let mut parts = trimmed.splitn(2, "  ");
            let id = parts.next().unwrap_or_default().trim();
            let description = parts.next().unwrap_or_default().trim();
            if !id.contains('/') || description.is_empty() {
                continue;
            }

            let provider_id = id.split('/').next().unwrap_or(id).to_string();
            if !providers.iter().any(|p| p.id == provider_id) {
                providers.push(ModelProvider {
                    name: provider_id.clone(),
                    id: provider_id.clone(),
                });
            }

            if description.to_lowercase().contains("(default)") && default_model.is_none() {
                default_model = Some(id.to_string());
            }

            models.push(ModelInfo {
                id: id.to_string(),
                name: id.to_string(),
                provider_id: Some(provider_id),
                reasoning_options: Vec::new(),
            });
        }

        (providers, models, default_model)
    }

    /// Run `command-code --list-models` and surface the result to the selector.
    /// Best-effort: any failure degrades to an empty model list, and the
    /// selector's free-text field still lets a user type their own id.
    async fn discover_models_from_cli() -> (Vec<ModelProvider>, Vec<ModelInfo>, Option<String>) {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            Command::new(BASE_COMMAND)
                .args(["--list-models", "--no-auto-update"])
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await;

        let stdout = match output {
            Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
            _ => return (Vec::new(), Vec::new(), None),
        };

        Self::parse_list_models_output(&stdout)
    }
}

async fn spawn_command(
    parts: crate::command::CommandParts,
    prompt: &str,
    current_dir: &Path,
    env: &ExecutionEnv,
    cmd_overrides: &CmdOverrides,
) -> Result<SpawnedChild, ExecutorError> {
    let (program_path, args) = parts.into_resolved().await?;

    let mut command = Command::new(program_path);
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(current_dir)
        .args(&args);

    env.clone()
        .with_profile(cmd_overrides)
        .apply_to_command(&mut command);

    let mut child = command.group_spawn_no_window()?;

    if let Some(mut stdin) = child.inner().stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
    }

    Ok(child.into())
}

#[async_trait]
impl StandardCodingAgentExecutor for CommandCode {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }
        if let Some(reasoning_id) = &executor_config.reasoning_id {
            self.reasoning_effort = Some(reasoning_id.clone());
        }
        if let Some(permission_policy) = executor_config.permission_policy.clone() {
            self.yolo = Some(matches!(permission_policy, PermissionPolicy::Auto));
        }
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let command_parts = self
            .build_command_builder()?
            .build_follow_up(&["-p".to_string()])?;
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        spawn_command(command_parts, &combined_prompt, current_dir, env, &self.cmd).await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let command_parts = self.build_command_builder()?.build_follow_up(&[
            "--resume".to_string(),
            session_id.to_string(),
            "-p".to_string(),
        ])?;
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        spawn_command(command_parts, &combined_prompt, current_dir, env, &self.cmd).await
    }

    fn normalize_logs(
        &self,
        msg_store: Arc<MsgStore>,
        worktree_path: &Path,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        normalize_logs::normalize_logs(
            msg_store.clone(),
            worktree_path,
            EntryIndexProvider::start_from(&msg_store),
        )
    }

    fn default_mcp_config_path(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|home| home.join(".commandcode").join("mcp.json"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        let installed = dirs::home_dir()
            .map(|home| home.join(".commandcode").exists())
            .unwrap_or(false);

        if installed {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        ExecutorConfig {
            executor: BaseCodingAgent::CommandCode,
            variant: None,
            model_id: self.model.clone(),
            agent_id: None,
            reasoning_id: self.reasoning_effort.clone(),
            permission_policy: Some(if self.yolo.unwrap_or(false) {
                PermissionPolicy::Auto
            } else {
                PermissionPolicy::Supervised
            }),
        }
    }

    async fn discover_options(
        &self,
        _workdir: Option<&Path>,
        _repo_path: Option<&Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let (providers, models, default_model) = Self::discover_models_from_cli().await;

        let options = ExecutorDiscoveredOptions {
            model_selector: ModelSelectorConfig {
                providers,
                models,
                default_model,
                permissions: vec![PermissionPolicy::Auto, PermissionPolicy::Supervised],
                ..Default::default()
            },
            ..Default::default()
        };
        Ok(Box::pin(futures::stream::once(async move {
            patch::executor_discovered_options(options)
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::CommandCode;
    use crate::model_selector::ModelInfo;

    #[test]
    fn parses_list_models_output() {
        let raw = "Updated 1.55.0 → 1.55.1\n\
Available models  ·  3 models\n\n\
Open Source\n\n\
deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)\n\
moonshotai/kimi-k3                     long-horizon coding with 1M context\n\
\n\
Frontier\n\n\
anthropic/claude-opus-5                most capable Claude\n";

        let (providers, models, default_model) = CommandCode::parse_list_models_output(raw);

        assert_eq!(providers.len(), 3);
        assert!(providers.iter().any(|p| p.id == "deepseek"));

        let ids: Vec<&str> = models.iter().map(|m: &ModelInfo| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "deepseek/deepseek-v4-flash",
                "moonshotai/kimi-k3",
                "anthropic/claude-opus-5",
            ]
        );
        assert_eq!(default_model.as_deref(), Some("deepseek/deepseek-v4-flash"));
    }

    #[test]
    fn ignores_headers_and_malformed_rows() {
        let (providers, models, default_model) =
            CommandCode::parse_list_models_output("Open Source\n\nnonsense   no slash\n");
        assert!(providers.is_empty());
        assert!(models.is_empty());
        assert!(default_model.is_none());
    }
}
