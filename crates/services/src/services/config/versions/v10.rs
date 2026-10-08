use anyhow::Error;
use executors::{
    executors::BaseCodingAgent, interactive::TerminalKind, profile::ExecutorProfileId,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
// Re-export unchanged types from v9 so downstream code keeps a single import site.
pub use v9::{
    EditorConfig, EditorType, GitHubConfig, GiteaConfig, NotificationConfig, PipelineStep,
    SendMessageShortcut, ShowcaseState, SoundFile, ThemeMode, UiLanguage,
};

use crate::services::config::versions::v9;

fn default_git_branch_prefix() -> String {
    "vk".to_string()
}

fn default_pr_auto_description_enabled() -> bool {
    true
}

fn default_commit_reminder_enabled() -> bool {
    true
}

fn default_terminal() -> TerminalKind {
    TerminalKind::platform_default()
}

fn default_iterm_tabs() -> bool {
    true
}

fn default_theme_variant() -> String {
    "default".to_string()
}

fn default_memory_backend() -> String {
    "mem0".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct Config {
    /// Preferred memory integration. Runtime routing is configured separately.
    #[serde(default = "default_memory_backend")]
    pub memory_backend: String,
    pub config_version: String,
    pub theme: ThemeMode,
    pub executor_profile: ExecutorProfileId,
    pub disclaimer_acknowledged: bool,
    pub onboarding_acknowledged: bool,
    #[serde(default)]
    pub remote_onboarding_acknowledged: bool,
    pub notifications: NotificationConfig,
    pub editor: EditorConfig,
    pub github: GitHubConfig,
    #[serde(default)]
    pub gitea: GiteaConfig,
    pub workspace_dir: Option<String>,
    pub last_app_version: Option<String>,
    pub show_release_notes: bool,
    #[serde(default)]
    pub language: UiLanguage,
    #[serde(default = "default_git_branch_prefix")]
    pub git_branch_prefix: String,
    #[serde(default)]
    pub showcases: ShowcaseState,
    #[serde(default = "default_pr_auto_description_enabled")]
    pub pr_auto_description_enabled: bool,
    #[serde(default)]
    pub pr_auto_description_prompt: Option<String>,
    #[serde(default = "default_commit_reminder_enabled")]
    pub commit_reminder_enabled: bool,
    #[serde(default)]
    pub commit_reminder_prompt: Option<String>,
    /// General project rules resolved by the `get_rules` MCP tool — the
    /// pre/post split lets an execution agent keep guardrails in mind
    /// throughout a card (pre) and run a closing checklist before finishing
    /// (post). `None` means "use the built-in default"
    /// (`DEFAULT_GENERAL_RULES_PRE`/`POST`); previously this text was
    /// duplicated verbatim in every bundled pipeline's `memory` stage.
    #[serde(default)]
    pub general_rules_pre: Option<String>,
    #[serde(default)]
    pub general_rules_post: Option<String>,
    #[serde(default)]
    pub send_message_shortcut: SendMessageShortcut,
    #[serde(default)]
    pub host_nickname: Option<String>,
    #[serde(default = "default_terminal")]
    pub terminal: TerminalKind,
    #[serde(default = "default_iterm_tabs")]
    pub iterm_tabs: bool,
    #[serde(default = "default_theme_variant")]
    pub theme_variant: String,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    #[serde(default)]
    pub pipeline_steps: Option<Vec<PipelineStep>>,
}

impl Config {
    fn from_v9_config(old_config: v9::Config) -> Self {
        Self {
            memory_backend: default_memory_backend(),
            config_version: "v10".to_string(),
            theme: old_config.theme,
            executor_profile: old_config.executor_profile,
            disclaimer_acknowledged: old_config.disclaimer_acknowledged,
            onboarding_acknowledged: old_config.onboarding_acknowledged,
            remote_onboarding_acknowledged: old_config.remote_onboarding_acknowledged,
            notifications: old_config.notifications,
            editor: old_config.editor,
            github: old_config.github,
            gitea: old_config.gitea,
            workspace_dir: old_config.workspace_dir,
            last_app_version: old_config.last_app_version,
            show_release_notes: old_config.show_release_notes,
            language: old_config.language,
            git_branch_prefix: old_config.git_branch_prefix,
            showcases: old_config.showcases,
            pr_auto_description_enabled: old_config.pr_auto_description_enabled,
            pr_auto_description_prompt: old_config.pr_auto_description_prompt,
            commit_reminder_enabled: old_config.commit_reminder_enabled,
            commit_reminder_prompt: old_config.commit_reminder_prompt,
            general_rules_pre: None,
            general_rules_post: None,
            send_message_shortcut: old_config.send_message_shortcut,
            host_nickname: old_config.host_nickname,
            terminal: old_config.terminal,
            iterm_tabs: old_config.iterm_tabs,
            theme_variant: old_config.theme_variant,
            allowed_origins: old_config.allowed_origins,
            pipeline_steps: old_config.pipeline_steps,
        }
    }

    pub fn from_previous_version(raw_config: &str) -> Result<Self, Error> {
        let old_config = v9::Config::from(raw_config.to_string());
        Ok(Self::from_v9_config(old_config))
    }
}

impl From<String> for Config {
    fn from(raw_config: String) -> Self {
        if let Ok(config) = serde_json::from_str::<Config>(&raw_config)
            && config.config_version == "v10"
        {
            return config;
        }

        match Self::from_previous_version(&raw_config) {
            Ok(config) => {
                tracing::info!("Config upgraded to v10");
                config
            }
            Err(e) => {
                tracing::warn!("Config migration failed: {}, using default", e);
                Self::default()
            }
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            memory_backend: default_memory_backend(),
            config_version: "v10".to_string(),
            theme: ThemeMode::System,
            executor_profile: ExecutorProfileId::new(BaseCodingAgent::ClaudeCode),
            disclaimer_acknowledged: false,
            onboarding_acknowledged: false,
            remote_onboarding_acknowledged: false,
            notifications: NotificationConfig::default(),
            editor: EditorConfig::default(),
            github: GitHubConfig::default(),
            gitea: GiteaConfig::default(),
            workspace_dir: None,
            last_app_version: None,
            show_release_notes: false,
            language: UiLanguage::default(),
            git_branch_prefix: default_git_branch_prefix(),
            showcases: ShowcaseState::default(),
            pr_auto_description_enabled: true,
            pr_auto_description_prompt: None,
            commit_reminder_enabled: true,
            commit_reminder_prompt: None,
            general_rules_pre: None,
            general_rules_post: None,
            send_message_shortcut: SendMessageShortcut::default(),
            host_nickname: None,
            terminal: default_terminal(),
            iterm_tabs: default_iterm_tabs(),
            theme_variant: default_theme_variant(),
            allowed_origins: Vec::new(),
            pipeline_steps: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_v9_to_v10_with_no_general_rules_override() {
        let v9_json = serde_json::json!({
            "config_version": "v9",
            "theme": "SYSTEM",
            "executor_profile": { "executor": "CLAUDE_CODE" },
            "disclaimer_acknowledged": true,
            "onboarding_acknowledged": true,
            "notifications": NotificationConfig::default(),
            "editor": EditorConfig::default(),
            "github": GitHubConfig::default(),
            "workspace_dir": null,
            "last_app_version": null,
            "show_release_notes": false,
        })
        .to_string();

        let cfg = Config::from(v9_json);
        assert_eq!(cfg.config_version, "v10");
        assert!(cfg.general_rules_pre.is_none());
        assert!(cfg.general_rules_post.is_none());
    }

    #[test]
    fn v10_round_trips_general_rules() {
        let cfg = Config {
            general_rules_pre: Some("custom pre".to_string()),
            general_rules_post: Some("custom post".to_string()),
            ..Default::default()
        };
        let raw = serde_json::to_string(&cfg).unwrap();
        let back = Config::from(raw);
        assert_eq!(back.general_rules_pre.as_deref(), Some("custom pre"));
        assert_eq!(back.general_rules_post.as_deref(), Some("custom post"));
        assert_eq!(back.config_version, "v10");
    }

    #[test]
    fn v10_config_without_general_rules_defaults_to_none() {
        // A v10 blob predating this field must deserialise with both as
        // None (serde default), so the built-in DEFAULT_GENERAL_RULES_*
        // constants are used.
        let cfg = Config::default();
        let mut value = serde_json::to_value(&cfg).unwrap();
        let obj = value.as_object_mut().unwrap();
        obj.remove("general_rules_pre").unwrap();
        obj.remove("general_rules_post").unwrap();
        let back = Config::from(value.to_string());
        assert!(back.general_rules_pre.is_none());
        assert!(back.general_rules_post.is_none());
        assert_eq!(back.config_version, "v10");
    }
}
