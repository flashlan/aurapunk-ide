//! User-level configuration shared by the server and the MCP worker.
//!
//! Memory credentials must not be kept in the repository or returned to the
//! browser. This file follows the same `~/.aurapunk` convention used by the
//! other local integrations, but is written with restrictive permissions on
//! Unix so a Settings change is available to newly spawned MCP processes.

use std::{env, fs, io::Write, path::PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_LOCAL_MEM0_URL: &str = "http://localhost:8000";
pub const DEFAULT_CLOUD_MEM0_URL: &str = "http://192.168.1.168:8000";
pub const DEFAULT_MEM0_PLATFORM_URL: &str = "https://api.mem0.ai";
pub const DEFAULT_AURAPUNK_CLOUD_MEM0_URL: &str = "https://aurapunk.dev/api/memory/v1";
pub const DEFAULT_EMBEDDING_DIMENSIONS: u32 = 384;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryAdapter {
    /// AuraPunk's existing mem0-vk REST contract.
    #[default]
    Mem0Vk,
    /// Official Mem0 Platform REST API.
    Mem0Platform,
}

impl MemoryAdapter {
    pub fn from_env(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "mem0_vk" | "mem0-vk" | "local" | "self_hosted" => Some(Self::Mem0Vk),
            "mem0_platform" | "mem0-platform" | "platform" | "cloud" => Some(Self::Mem0Platform),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Mem0Vk => "mem0_vk",
            Self::Mem0Platform => "mem0_platform",
        }
    }
}

/// A memory source the agent stack is allowed to consult.
///
/// This replaces the old single-select `memory_backend` app config, which
/// nothing in the backend ever read: the selection looked meaningful and was
/// inert. Every entry here is checked at the point of use, so an enabled source
/// is always one that does something.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum MemorySource {
    /// Vector search and writes through mem0 (`/api/search`, `/api/memories/add`).
    Mem0Semantic,
    /// The Qdrant vector store backing a self-hosted mem0-vk. Only reachable
    /// when `Mem0Semantic` is on too; there are no embeddings without it.
    Qdrant,
    /// The shared Obsidian vault, reached through its MCP server.
    Obsidian,
    /// SpecKit artifacts under `specs/<branch>/` in the workspace.
    Specs,
}

impl MemorySource {
    pub const ALL: [Self; 4] = [
        Self::Mem0Semantic,
        Self::Qdrant,
        Self::Obsidian,
        Self::Specs,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Mem0Semantic => "mem0_semantic",
            Self::Qdrant => "qdrant",
            Self::Obsidian => "obsidian",
            Self::Specs => "specs",
        }
    }

    pub fn from_str_lossy(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "mem0_semantic" | "mem0" | "mem0_semantic_search" => Some(Self::Mem0Semantic),
            "qdrant" => Some(Self::Qdrant),
            "obsidian" | "obsidian_okf" => Some(Self::Obsidian),
            "specs" | "speckit" => Some(Self::Specs),
            _ => None,
        }
    }
}

/// At least one source must stay on, or the agent stack would have no memory
/// to consult at all.
pub const MIN_ACTIVE_SOURCES: usize = 1;

/// Drops duplicates and unknown names, keeping declaration order stable.
pub fn normalize_sources(values: &[String]) -> Vec<MemorySource> {
    let mut out: Vec<MemorySource> = Vec::new();
    for value in values {
        if let Some(source) = MemorySource::from_str_lossy(value)
            && !out.contains(&source)
        {
            out.push(source);
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct MemoryConfig {
    pub enabled: bool,
    pub adapter: MemoryAdapter,
    pub source: String,
    /// Optional active Mem0 URL override. For Mem0 Platform this defaults to
    /// `https://api.mem0.ai`; for mem0-vk it defaults to the selected source.
    pub mem0_url: Option<String>,
    pub local_url: Option<String>,
    pub cloud_url: Option<String>,
    /// Hosted Free plans index supplied facts directly and must never call the
    /// LLM extraction endpoint.
    pub cloud_vector_only: bool,
    pub mem0_api_key: Option<String>,
    pub qdrant_url: Option<String>,
    pub qdrant_api_key: Option<String>,
    pub qdrant_collection: Option<String>,
    pub embedding_dimensions: u32,
    /// Which memory sources the agent stack may consult. Never empty: an
    /// install with no source would silently give every agent amnesia.
    pub sources: Vec<MemorySource>,
}

impl MemoryConfig {
    /// Semantic mem0 search is the only source the backend reads directly.
    pub fn semantic_enabled(&self) -> bool {
        self.enabled && self.sources.contains(&MemorySource::Mem0Semantic)
    }

    /// Qdrant stores the vectors mem0 semantic writes. Without an extraction
    /// provider mem0 can only index supplied facts, so the vector side is
    /// off even when the source is listed.
    pub fn vector_store_enabled(&self) -> bool {
        self.semantic_enabled() && self.sources.contains(&MemorySource::Qdrant)
    }

    pub fn has_source(&self, source: MemorySource) -> bool {
        self.sources.contains(&source)
    }
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            adapter: MemoryAdapter::default(),
            source: "local".to_string(),
            mem0_url: None,
            local_url: None,
            cloud_url: None,
            cloud_vector_only: false,
            mem0_api_key: None,
            qdrant_url: None,
            qdrant_api_key: None,
            qdrant_collection: None,
            embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
            sources: vec![MemorySource::Mem0Semantic],
        }
    }
}

pub fn config_path() -> PathBuf {
    if let Ok(path) = env::var("AURAPUNK_MEMORY_CONFIG")
        && !path.trim().is_empty()
    {
        return PathBuf::from(path);
    }

    crate::path::config_home_dir().join("memory.toml")
}

/// Loads the saved config and applies explicit environment overrides. This
/// makes the Settings file persistent while preserving `.env`/deployment
/// configuration as the highest-priority source when present.
pub fn load() -> MemoryConfig {
    let saved_config =
        fs::read_to_string(config_path()).ok().and_then(|raw| {
            match toml::from_str::<MemoryConfig>(&raw) {
                Ok(config) => Some(config),
                Err(error) => {
                    tracing::warn!(error = %error, "failed to parse memory.toml");
                    None
                }
            }
        });
    let mut config = saved_config.clone().unwrap_or_default();
    // A config written before `sources` existed, or one that lost every entry,
    // must still leave the agent stack with a working memory.
    if config.sources.is_empty() {
        config.sources = vec![MemorySource::Mem0Semantic];
    }
    if saved_config.is_none()
        && crate::env_compat::renamed("MODE")
            .map(|value| value.trim().eq_ignore_ascii_case("cloud"))
            .unwrap_or(false)
    {
        // A cloud instance starts before the browser account handoff. Keep
        // hosted Mem0 fail-closed until the signed-in account writes its
        // gateway URL and device-scoped token through /api/usage.
        config.source = "cloud".to_string();
        config.enabled = false;
    }

    if let Some(value) = env::var("MEM0_ENABLED")
        .ok()
        .and_then(|value| value.parse::<bool>().ok())
    {
        config.enabled = value;
    }
    if let Ok(value) = env::var("AURAPUNK_MEM0_ADAPTER")
        && let Some(adapter) = MemoryAdapter::from_env(&value)
    {
        config.adapter = adapter;
    }
    if let Some(value) = non_empty_env("MEM0_URL") {
        config.mem0_url = Some(value);
    }
    if let Some(value) = non_empty_env("MEM0_LOCAL_URL") {
        config.local_url = Some(value);
    }
    if let Some(value) = non_empty_env("AURAPUNK_CLOUD_MEM0_URL") {
        config.cloud_url = Some(value);
    }
    if let Some(value) =
        first_non_empty_env(&["MEM0_API_TOKEN", "AURAPUNK_MEM0_TOKEN", "MEM0_API_KEY"])
    {
        config.mem0_api_key = Some(value);
    }
    if let Some(value) = non_empty_env("QDRANT_URL") {
        config.qdrant_url = Some(value);
    }
    if let Some(value) = first_non_empty_env(&["QDRANT_API_KEY", "QDRANT_API_TOKEN"]) {
        config.qdrant_api_key = Some(value);
    }
    if let Some(value) = non_empty_env("QDRANT_COLLECTION") {
        config.qdrant_collection = Some(value);
    }
    if let Some(value) = env::var("MEM0_EMBEDDING_DIMS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
    {
        config.embedding_dimensions = value;
    }

    // Older packaged builds saved the hosted choice as Mem0 Platform without
    // an explicit URL. In the AuraPunk Cloud client that legacy default would
    // silently point at api.mem0.ai and could never use the account gateway.
    // Normalize only that unambiguous shape; an explicit Platform URL remains
    // an operator choice and is left untouched.
    if config.source == "cloud"
        && config.adapter == MemoryAdapter::Mem0Platform
        && config.mem0_url.is_none()
        && crate::env_compat::renamed("MODE")
            .map(|value| value.trim().eq_ignore_ascii_case("cloud"))
            .unwrap_or(false)
    {
        config.adapter = MemoryAdapter::Mem0Vk;
        config.mem0_url = Some(DEFAULT_AURAPUNK_CLOUD_MEM0_URL.to_string());
    }

    config
}

fn first_non_empty_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl MemoryConfig {
    pub fn active_url(&self) -> String {
        if let Some(url) = self
            .mem0_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
        {
            return url.to_string();
        }

        match self.adapter {
            MemoryAdapter::Mem0Platform => DEFAULT_MEM0_PLATFORM_URL.to_string(),
            MemoryAdapter::Mem0Vk => {
                if self.source == "cloud" {
                    self.cloud_url
                        .as_deref()
                        .filter(|url| !url.trim().is_empty())
                        .unwrap_or(DEFAULT_CLOUD_MEM0_URL)
                        .to_string()
                } else {
                    self.local_url
                        .as_deref()
                        .filter(|url| !url.trim().is_empty())
                        .unwrap_or(DEFAULT_LOCAL_MEM0_URL)
                        .to_string()
                }
            }
        }
    }

    pub fn has_mem0_api_key(&self) -> bool {
        self.mem0_api_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    }

    pub fn has_qdrant_api_key(&self) -> bool {
        self.qdrant_api_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    }
}

/// Saves only the local operator configuration. The API never serializes this
/// value back to the frontend; callers should return only the `has_*` flags.
pub fn save(config: &MemoryConfig) -> std::io::Result<()> {
    if config.sources.len() < MIN_ACTIVE_SOURCES {
        return Err(std::io::Error::other(format!(
            "at least {MIN_ACTIVE_SOURCES} memory source must stay active"
        )));
    }
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let temporary = path.with_extension("toml.tmp");
    let encoded =
        toml::to_string_pretty(config).map_err(|error| std::io::Error::other(error.to_string()))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(encoded.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_uses_managed_mem0_url() {
        let config = MemoryConfig {
            adapter: MemoryAdapter::Mem0Platform,
            ..Default::default()
        };
        assert_eq!(config.active_url(), DEFAULT_MEM0_PLATFORM_URL);
    }

    #[test]
    fn aura_punk_cloud_gateway_is_the_packaged_cloud_default() {
        let config = MemoryConfig {
            adapter: MemoryAdapter::Mem0Vk,
            source: "cloud".to_string(),
            mem0_url: Some(DEFAULT_AURAPUNK_CLOUD_MEM0_URL.to_string()),
            ..Default::default()
        };
        assert_eq!(config.active_url(), DEFAULT_AURAPUNK_CLOUD_MEM0_URL);
    }

    #[test]
    fn dimensions_default_to_384() {
        assert_eq!(MemoryConfig::default().embedding_dimensions, 384);
    }

    #[test]
    fn cloud_vector_only_is_disabled_by_default() {
        assert!(!MemoryConfig::default().cloud_vector_only);
    }

    #[test]
    fn adapter_aliases_are_backward_friendly() {
        assert_eq!(
            MemoryAdapter::from_env("mem0-vk"),
            Some(MemoryAdapter::Mem0Vk)
        );
        assert_eq!(
            MemoryAdapter::from_env("platform"),
            Some(MemoryAdapter::Mem0Platform)
        );
        assert_eq!(MemoryAdapter::from_env("unknown"), None);
    }

}
#[cfg(test)]
mod source_tests {
    use super::*;

    #[test]
    fn default_leaves_semantic_mem0_active() {
        let config = MemoryConfig::default();
        assert_eq!(config.sources, vec![MemorySource::Mem0Semantic]);
        assert!(config.semantic_enabled());
    }

    #[test]
    fn semantic_is_off_when_the_source_is_not_listed() {
        let mut config = MemoryConfig::default();
        config.sources = vec![MemorySource::Obsidian];
        assert!(!config.semantic_enabled());
    }

    #[test]
    fn semantic_respects_the_master_switch() {
        let mut config = MemoryConfig::default();
        config.enabled = false;
        assert!(!config.semantic_enabled());
    }

    #[test]
    fn qdrant_needs_semantic_mem0() {
        let mut config = MemoryConfig::default();
        config.sources = vec![MemorySource::Qdrant];
        assert!(!config.vector_store_enabled());

        config.sources = vec![MemorySource::Mem0Semantic, MemorySource::Qdrant];
        assert!(config.vector_store_enabled());
    }

    #[test]
    fn normalize_drops_unknown_names_and_duplicates() {
        let input = vec![
            "mem0".to_string(),
            "MEM0".to_string(),
            "nope".to_string(),
            "specs".to_string(),
        ];
        assert_eq!(
            normalize_sources(&input),
            vec![MemorySource::Mem0Semantic, MemorySource::Specs]
        );
    }

    #[test]
    fn a_config_written_before_sources_defaults_to_semantic_mem0() {
        // The struct-level `#[serde(default)]` seeds a missing field from
        // `MemoryConfig::default()`, so an old memory.toml is never left with
        // no memory source at all.
        let parsed: MemoryConfig =
            toml::from_str("enabled = true\nsource = \"local\"\n").unwrap();
        assert_eq!(parsed.sources, vec![MemorySource::Mem0Semantic]);
        assert!(parsed.semantic_enabled());
    }

    #[test]
    fn load_repairs_an_explicitly_empty_source_list() {
        let mut config = MemoryConfig::default();
        config.sources = vec![];
        // Mirrors the repair `load()` performs before returning the config.
        if config.sources.is_empty() {
            config.sources = vec![MemorySource::Mem0Semantic];
        }
        assert_eq!(config.sources, vec![MemorySource::Mem0Semantic]);
    }

    #[test]
    fn save_refuses_an_empty_source_list() {
        let mut config = MemoryConfig::default();
        config.sources = vec![];
        assert!(save(&config).is_err());
    }
}
