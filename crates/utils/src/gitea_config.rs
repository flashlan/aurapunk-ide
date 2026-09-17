//! Gitea credential loading.
//!
//! The app Settings hold only non-secret Gitea config (`base_url`,
//! `default_branch`). The personal access token is a secret and is kept OUT
//! of the app, mirroring the Telegram bot token: it is read from a TOML file
//! outside the repo (or an environment variable), never stored in
//! versioned JSON.
//!
//! Resolution order for the token:
//! 1. `$VIBE_KANBAN_GITEA_CONFIG` (or `~/.vibe-kanban/gitea.toml`) — `token = "..."`
//! 2. `GITEA_TOKEN` environment variable
//!
//! Example `~/.vibe-kanban/gitea.toml`:
//! ```toml
//! token = "my-gitea-personal-access-token"
//! ```

use std::env;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Secret Gitea credentials, loaded from a TOML file (or env vars).
///
/// Only non-secret Gitea config (base_url, default_branch) lives in the app
/// Settings; the token belongs here.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct GiteaSecretConfig {
    /// Gitea personal access token (a `token <PAT>` bearer).
    pub token: Option<String>,
}

/// Resolves the Gitea config path.
///
/// Priority:
/// 1. `$AURAPUNK_GITEA_CONFIG` (legacy: `$VIBE_KANBAN_GITEA_CONFIG`) if set and
///    non-empty (used in tests/CI).
/// 2. `~/.aurapunk/gitea.toml` (legacy: `~/.vibe-kanban/gitea.toml`).
///
/// Mirrors [`telegram_config::config_path`](crate::telegram_config::config_path).
pub fn config_path() -> PathBuf {
    if let Some(p) = crate::env_compat::get(&["AURAPUNK_GITEA_CONFIG", "VIBE_KANBAN_GITEA_CONFIG"])
        && !p.is_empty()
    {
        return PathBuf::from(p);
    }
    crate::path::config_home_dir().join("gitea.toml")
}

/// Loads Gitea secret config from the config path.
///
/// Returns `None` when the file is absent or unparseable (logged at
/// debug/warn). Mirrors [`telegram_config::load`](crate::telegram_config::load).
pub fn load() -> Option<GiteaSecretConfig> {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(content) => match toml::from_str(&content) {
            Ok(cfg) => Some(cfg),
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "failed to parse gitea.toml"
                );
                None
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "failed to read gitea.toml"
            );
            None
        }
    }
}

/// Where a resolved Gitea token came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// `token = "..."` in gitea.toml.
    Toml,
    /// `GITEA_TOKEN` environment variable.
    Env,
}

impl TokenSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            TokenSource::Toml => "gitea.toml",
            TokenSource::Env => "GITEA_TOKEN",
        }
    }
}

/// Resolves the Gitea token from the config file, then the environment.
///
/// Returns `(token, source)`, or `None` if no token is configured.
pub fn resolve_token(cfg: &GiteaSecretConfig) -> Option<(String, TokenSource)> {
    if let Some(token) = cfg
        .token
        .as_ref()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
    {
        return Some((token.to_string(), TokenSource::Toml));
    }

    if let Ok(token) = env::var("GITEA_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Some((token, TokenSource::Env));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{TempDir, tempdir};

    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn write_toml(dir: &TempDir, name: &str, content: &str) -> std::path::PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn resolves_token_from_toml() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempdir().unwrap();
        let path = write_toml(&dir, "gitea.toml", "token = \"pat-from-toml\"\n");
        unsafe {
            std::env::set_var("VIBE_KANBAN_GITEA_CONFIG", path);
            std::env::remove_var("GITEA_TOKEN");
        }

        let cfg = load().expect("should load");
        let (token, source) = resolve_token(&cfg).expect("should resolve");
        assert_eq!(token, "pat-from-toml");
        assert_eq!(source, TokenSource::Toml);
    }

    #[test]
    fn falls_back_to_env_when_toml_absent() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempdir().unwrap();
        unsafe {
            std::env::set_var("VIBE_KANBAN_GITEA_CONFIG", dir.path().join("missing.toml"));
            std::env::set_var("GITEA_TOKEN", "pat-from-env");
        }

        let cfg = load().unwrap_or_default();
        let (token, source) = resolve_token(&cfg).expect("should resolve from env");
        assert_eq!(token, "pat-from-env");
        assert_eq!(source, TokenSource::Env);

        unsafe {
            std::env::remove_var("GITEA_TOKEN");
        }
    }

    #[test]
    fn toml_takes_priority_over_env() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempdir().unwrap();
        let path = write_toml(&dir, "gitea.toml", "token = \"pat-from-toml\"\n");
        unsafe {
            std::env::set_var("VIBE_KANBAN_GITEA_CONFIG", path);
            std::env::set_var("GITEA_TOKEN", "pat-from-env");
        }

        let cfg = load().expect("should load");
        let (token, source) = resolve_token(&cfg).expect("should resolve");
        assert_eq!(token, "pat-from-toml");
        assert_eq!(source, TokenSource::Toml);

        unsafe {
            std::env::remove_var("GITEA_TOKEN");
        }
    }

    #[test]
    fn no_token_anywhere_resolves_none() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempdir().unwrap();
        unsafe {
            std::env::set_var("VIBE_KANBAN_GITEA_CONFIG", dir.path().join("missing.toml"));
            std::env::remove_var("GITEA_TOKEN");
        }

        let cfg = load().unwrap_or_default();
        assert!(resolve_token(&cfg).is_none());
    }

    #[test]
    fn missing_config_file_returns_none() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempdir().unwrap();
        unsafe {
            std::env::set_var("VIBE_KANBAN_GITEA_CONFIG", dir.path().join("missing.toml"));
        }
        assert!(load().is_none());
    }

    #[test]
    fn empty_token_is_treated_as_absent() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempdir().unwrap();
        let path = write_toml(&dir, "gitea.toml", "token = \"   \"\n");
        unsafe {
            std::env::set_var("VIBE_KANBAN_GITEA_CONFIG", path);
            std::env::remove_var("GITEA_TOKEN");
        }

        let cfg = load().expect("should load");
        assert!(resolve_token(&cfg).is_none());
    }
}
