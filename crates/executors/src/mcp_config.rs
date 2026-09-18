//! Utilities for reading and writing external agent config files (not the server's own config).
//!
//! These helpers abstract over JSON vs TOML vs JSONC formats used by different agents.
//! JSONC (JSON with Comments) is supported with comment preservation using jsonc-parser's CST.

use std::{collections::HashMap, path::Path, sync::LazyLock};

use jsonc_parser::{
    ParseOptions,
    cst::{CstObject, CstRootNode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::fs;
use ts_rs::TS;

use crate::executors::{CodingAgent, ExecutorError};

fn is_jsonc_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonc"))
}

static DEFAULT_MCP_JSON: &str = include_str!("../default_mcp.json");
pub static PRECONFIGURED_MCP_SERVERS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str::<Value>(DEFAULT_MCP_JSON).expect("Failed to parse default MCP JSON")
});

const LEGACY_VIBE_KANBAN_MCP_PACKAGE: &str = "vibe-kanban@latest";
const LEGACY_VIBE_KANBAN_ALTERNATIVE_MCP_PACKAGE: &str = "vibe-kanban-alternative@latest";
const AURAPUNK_MCP_PACKAGE: &str = "aurapunk-ide@latest";

/// Upgrade a former Vibe Kanban MCP preset in a Codex config to the AuraPunk
/// package and server name.
///
/// Only the exact, previously generated command is migrated. User-managed
/// servers with another package or invocation are intentionally left alone.
/// When an `aurapunk` server already exists, the legacy duplicate is dropped
/// instead of renamed so there is exactly one AuraPunk entry.
pub fn migrate_legacy_codex_vibe_kanban_mcp(config: &mut Value) -> bool {
    let Some(servers) = config.get_mut("mcp_servers").and_then(Value::as_object_mut) else {
        return false;
    };

    let is_legacy = servers
        .get("vibe_kanban")
        .and_then(Value::as_object)
        .is_some_and(|server| {
            server.get("command").and_then(Value::as_str) == Some("npx")
                && server
                    .get("args")
                    .and_then(Value::as_array)
                    .is_some_and(|args| {
                        let mut parts = args.iter().map(Value::as_str);
                        parts.next() == Some(Some("-y"))
                            && matches!(
                                parts.next(),
                                Some(Some(LEGACY_VIBE_KANBAN_MCP_PACKAGE))
                                    | Some(Some(LEGACY_VIBE_KANBAN_ALTERNATIVE_MCP_PACKAGE))
                            )
                            && parts.next() == Some(Some("--mcp"))
                    })
        });

    if !is_legacy {
        return false;
    }

    if let Some(server) = servers
        .get_mut("vibe_kanban")
        .and_then(Value::as_object_mut)
    {
        server.insert(
            "args".to_string(),
            serde_json::json!(["-y", AURAPUNK_MCP_PACKAGE, "--mcp", "--mode", "global"]),
        );
    }

    if servers.contains_key("aurapunk") {
        servers.remove("vibe_kanban");
    } else if let Some(legacy) = servers.remove("vibe_kanban") {
        servers.insert("aurapunk".to_string(), legacy);
    }
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct McpConfig {
    servers: HashMap<String, serde_json::Value>,
    pub servers_path: Vec<String>,
    pub template: serde_json::Value,
    pub preconfigured: serde_json::Value,
    pub is_toml_config: bool,
}

impl McpConfig {
    pub fn new(
        servers_path: Vec<String>,
        template: serde_json::Value,
        preconfigured: serde_json::Value,
        is_toml_config: bool,
    ) -> Self {
        Self {
            servers: HashMap::new(),
            servers_path,
            template,
            preconfigured,
            is_toml_config,
        }
    }
    pub fn set_servers(&mut self, servers: HashMap<String, serde_json::Value>) {
        self.servers = servers;
    }
}

pub async fn read_agent_config(
    config_path: &std::path::Path,
    mcp_config: &McpConfig,
) -> Result<Value, ExecutorError> {
    if let Ok(file_content) = fs::read_to_string(config_path).await {
        if mcp_config.is_toml_config {
            if file_content.trim().is_empty() {
                return Ok(serde_json::json!({}));
            }
            let toml_val: toml::Value = toml::from_str(&file_content)?;
            let json_string = serde_json::to_string(&toml_val)?;
            Ok(serde_json::from_str(&json_string)?)
        } else if is_jsonc_file(config_path) {
            if file_content.trim().is_empty() {
                return Ok(serde_json::json!({}));
            }
            match jsonc_parser::parse_to_serde_value(&file_content, &ParseOptions::default()) {
                Ok(Some(value)) => Ok(value),
                Ok(None) => Ok(serde_json::json!({})),
                Err(_) => Ok(serde_json::from_str(&file_content)?),
            }
        } else {
            Ok(serde_json::from_str(&file_content)?)
        }
    } else {
        Ok(mcp_config.template.clone())
    }
}

pub async fn write_agent_config(
    config_path: &std::path::Path,
    mcp_config: &McpConfig,
    config: &Value,
) -> Result<(), ExecutorError> {
    if mcp_config.is_toml_config {
        let toml_value: toml::Value = serde_json::from_str(&serde_json::to_string(config)?)?;
        let toml_content = toml::to_string_pretty(&toml_value)?;
        fs::write(config_path, toml_content).await?;
    } else if is_jsonc_file(config_path) {
        write_jsonc_preserving_comments(config_path, config).await?;
    } else {
        let json_content = serde_json::to_string_pretty(config)?;
        fs::write(config_path, json_content).await?;
    }
    Ok(())
}

async fn write_jsonc_preserving_comments(
    config_path: &std::path::Path,
    new_config: &Value,
) -> Result<(), ExecutorError> {
    let current_content = fs::read_to_string(config_path)
        .await
        .unwrap_or_else(|_| "{}".to_string());

    let output = update_jsonc_content(&current_content, new_config);

    fs::write(config_path, output).await?;
    Ok(())
}

fn update_jsonc_content(current_content: &str, new_config: &Value) -> String {
    let root = CstRootNode::parse(current_content, &ParseOptions::default())
        .unwrap_or_else(|_| CstRootNode::parse("{}", &ParseOptions::default()).unwrap());

    let root_obj = root.object_value_or_set();

    if let Some(obj) = new_config.as_object() {
        deep_merge_cst_object(&root_obj, obj);
    }

    root.to_string()
}

/// Recursively merges a serde_json Map into an existing CST object.
/// This preserves comments by navigating into existing nested objects rather than replacing them.
fn deep_merge_cst_object(cst_obj: &CstObject, new_obj: &Map<String, Value>) {
    let existing_keys: Vec<String> = cst_obj
        .properties()
        .iter()
        .filter_map(|p| p.name().and_then(|n| n.decoded_value().ok()))
        .collect();

    for key in &existing_keys {
        if !new_obj.contains_key(key)
            && let Some(prop) = cst_obj.get(key)
        {
            prop.remove();
        }
    }

    for (key, new_value) in new_obj {
        if let Some(prop) = cst_obj.get(key) {
            if let (Some(existing_obj), Some(new_obj_map)) =
                (prop.object_value(), new_value.as_object())
            {
                deep_merge_cst_object(&existing_obj, new_obj_map);
            } else {
                prop.set_value(serde_json_to_cst_input(new_value));
            }
        } else {
            cst_obj.append(key, serde_json_to_cst_input(new_value));
        }
    }
}

fn serde_json_to_cst_input(value: &Value) -> jsonc_parser::cst::CstInputValue {
    use jsonc_parser::cst::CstInputValue;

    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(b) => CstInputValue::Bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                CstInputValue::Number(i.to_string())
            } else if let Some(f) = n.as_f64() {
                CstInputValue::Number(f.to_string())
            } else {
                CstInputValue::Number(n.to_string())
            }
        }
        Value::String(s) => CstInputValue::String(s.clone()),
        Value::Array(arr) => {
            CstInputValue::Array(arr.iter().map(serde_json_to_cst_input).collect())
        }
        Value::Object(obj) => CstInputValue::Object(
            obj.iter()
                .map(|(k, v)| (k.clone(), serde_json_to_cst_input(v)))
                .collect(),
        ),
    }
}

type ServerMap = Map<String, Value>;

fn is_http_server(s: &Map<String, Value>) -> bool {
    matches!(s.get("type").and_then(Value::as_str), Some("http"))
}

fn is_stdio(s: &Map<String, Value>) -> bool {
    !is_http_server(s) && s.get("command").is_some()
}

fn extract_meta(mut obj: ServerMap) -> (ServerMap, Option<Value>) {
    let meta = obj.remove("meta");
    (obj, meta)
}

fn attach_meta(mut obj: ServerMap, meta: Option<Value>) -> Value {
    if let Some(m) = meta {
        obj.insert("meta".to_string(), m);
    }
    Value::Object(obj)
}

fn ensure_header(headers: &mut Map<String, Value>, key: &str, val: &str) {
    match headers.get_mut(key) {
        Some(Value::String(_)) => {}
        _ => {
            headers.insert(key.to_string(), Value::String(val.to_string()));
        }
    }
}

fn transform_http_servers<F>(mut servers: ServerMap, mut f: F) -> ServerMap
where
    F: FnMut(Map<String, Value>) -> Map<String, Value>,
{
    for (_k, v) in servers.iter_mut() {
        if let Value::Object(s) = v
            && is_http_server(s)
        {
            let taken = std::mem::take(s);
            *s = f(taken);
        }
    }
    servers
}

// --- Adapters ---------------------------------------------------------------

fn adapt_passthrough(servers: ServerMap, meta: Option<Value>) -> Value {
    attach_meta(servers, meta)
}

fn adapt_gemini(servers: ServerMap, meta: Option<Value>) -> Value {
    let servers = transform_http_servers(servers, |mut s| {
        let url = s
            .remove("url")
            .unwrap_or_else(|| Value::String(String::new()));
        let mut headers = s
            .remove("headers")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();

        ensure_header(
            &mut headers,
            "Accept",
            "application/json, text/event-stream",
        );
        Map::from_iter([
            ("httpUrl".to_string(), url),
            ("headers".to_string(), Value::Object(headers)),
        ])
    });
    attach_meta(servers, meta)
}

fn adapt_cursor(servers: ServerMap, meta: Option<Value>) -> Value {
    let servers = transform_http_servers(servers, |mut s| {
        let url = s
            .remove("url")
            .unwrap_or_else(|| Value::String(String::new()));
        let headers = s
            .remove("headers")
            .unwrap_or_else(|| Value::Object(Default::default()));
        Map::from_iter([("url".to_string(), url), ("headers".to_string(), headers)])
    });
    attach_meta(servers, meta)
}

fn adapt_codex(mut servers: ServerMap, mut meta: Option<Value>) -> Value {
    servers.retain(|_, v| v.as_object().map(is_stdio).unwrap_or(false));

    if let Some(Value::Object(ref mut m)) = meta {
        m.retain(|k, _| servers.contains_key(k));
        servers.insert("meta".to_string(), Value::Object(std::mem::take(m)));
        meta = None; // already attached above
    }
    attach_meta(servers, meta)
}

fn adapt_opencode(servers: ServerMap, meta: Option<Value>) -> Value {
    let mut servers = transform_http_servers(servers, |mut s| {
        let url = s
            .remove("url")
            .unwrap_or_else(|| Value::String(String::new()));

        let mut headers = s
            .remove("headers")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();

        ensure_header(
            &mut headers,
            "Accept",
            "application/json, text/event-stream",
        );

        Map::from_iter([
            ("type".to_string(), Value::String("remote".to_string())),
            ("url".to_string(), url),
            ("headers".to_string(), Value::Object(headers)),
            ("enabled".to_string(), Value::Bool(true)),
        ])
    });

    for (_k, v) in servers.iter_mut() {
        if let Value::Object(s) = v
            && is_stdio(s)
        {
            let command_str = s
                .remove("command")
                .and_then(|v| match v {
                    Value::String(s) => Some(s),
                    _ => None,
                })
                .unwrap_or_default();

            let mut cmd_vec: Vec<Value> = Vec::new();
            if !command_str.is_empty() {
                cmd_vec.push(Value::String(command_str));
            }

            if let Some(arr) = s.remove("args").and_then(|v| match v {
                Value::Array(arr) => Some(arr),
                _ => None,
            }) {
                for a in arr {
                    match a {
                        Value::String(s) => cmd_vec.push(Value::String(s)),
                        other => cmd_vec.push(other), // fall back to raw value if not string
                    }
                }
            }

            let mut new_map = Map::new();
            new_map.insert("type".to_string(), Value::String("local".to_string()));
            new_map.insert("command".to_string(), Value::Array(cmd_vec));
            new_map.insert("enabled".to_string(), Value::Bool(true));
            *s = new_map;
        }
    }

    attach_meta(servers, meta)
}

fn adapt_copilot(mut servers: ServerMap, meta: Option<Value>) -> Value {
    for (_, value) in servers.iter_mut() {
        if let Value::Object(s) = value
            && !s.contains_key("tools")
        {
            s.insert(
                "tools".to_string(),
                Value::Array(vec![Value::String("*".to_string())]),
            );
        }
    }
    attach_meta(servers, meta)
}

enum Adapter {
    Passthrough,
    Gemini,
    Cursor,
    Codex,
    Opencode,
    Copilot,
}

fn apply_adapter(adapter: Adapter, canonical: Value) -> Value {
    let (servers_only, meta) = match canonical.as_object() {
        Some(map) => extract_meta(map.clone()),
        None => (ServerMap::new(), None),
    };

    match adapter {
        Adapter::Passthrough => adapt_passthrough(servers_only, meta),
        Adapter::Gemini => adapt_gemini(servers_only, meta),
        Adapter::Cursor => adapt_cursor(servers_only, meta),
        Adapter::Codex => adapt_codex(servers_only, meta),
        Adapter::Opencode => adapt_opencode(servers_only, meta),
        Adapter::Copilot => adapt_copilot(servers_only, meta),
    }
}

impl CodingAgent {
    pub fn preconfigured_mcp(&self) -> Value {
        use Adapter::*;

        let adapter = match self {
            CodingAgent::ClaudeCode(_)
            | CodingAgent::ClaudeCodeHeaded(_)
            | CodingAgent::Amp(_)
            | CodingAgent::Droid(_)
            | CodingAgent::CommandCode(_) => Passthrough,
            CodingAgent::QwenCode(_)
            | CodingAgent::Gemini(_)
            | CodingAgent::Antigravity(_)
            | CodingAgent::AntigravityHeaded(_) => Gemini,
            CodingAgent::CursorAgent(_) => Cursor,
            CodingAgent::Codex(_) => Codex,
            CodingAgent::Opencode(_) | CodingAgent::OpencodeHeaded(_) => Opencode,
            CodingAgent::Copilot(..) => Copilot,
            #[cfg(feature = "qa-mode")]
            CodingAgent::QaMock(_) => Passthrough, // QA mock doesn't need MCP
        };

        let canonical = PRECONFIGURED_MCP_SERVERS.clone();
        apply_adapter(adapter, canonical)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{
        Adapter, PRECONFIGURED_MCP_SERVERS, apply_adapter, migrate_legacy_codex_vibe_kanban_mcp,
    };

    #[test]
    fn codex_aurapunk_preset_runs_this_forks_global_mcp_server() {
        let preset = apply_adapter(Adapter::Codex, PRECONFIGURED_MCP_SERVERS.clone());
        let aurapunk = preset
            .get("aurapunk")
            .and_then(Value::as_object)
            .expect("Codex must expose the AuraPunk MCP preset");

        assert_eq!(aurapunk.get("command").and_then(Value::as_str), Some("npx"));
        assert_eq!(
            aurapunk.get("args").and_then(Value::as_array),
            Some(&vec![
                Value::String("-y".to_string()),
                Value::String("aurapunk-ide@latest".to_string()),
                Value::String("--mcp".to_string()),
                Value::String("--mode".to_string()),
                Value::String("global".to_string()),
            ])
        );
    }

    #[test]
    fn codex_preset_omits_unsupported_http_servers() {
        let preset = apply_adapter(Adapter::Codex, PRECONFIGURED_MCP_SERVERS.clone());

        assert!(preset.get("context7").is_none());
        assert!(preset.get("aurapunk").is_some());
    }

    #[test]
    fn migrates_only_the_legacy_codex_vibe_kanban_preset() {
        let mut config = serde_json::json!({
            "mcp_servers": {
                "vibe_kanban": {
                    "command": "npx",
                    "args": ["-y", "vibe-kanban@latest", "--mcp"],
                    "env": { "VIBE_BACKEND_URL": "http://localhost:3002" }
                }
            }
        });

        assert!(migrate_legacy_codex_vibe_kanban_mcp(&mut config));
        assert!(config["mcp_servers"].get("vibe_kanban").is_none());
        assert_eq!(
            config["mcp_servers"]["aurapunk"]["args"],
            serde_json::json!(["-y", "aurapunk-ide@latest", "--mcp", "--mode", "global"])
        );
        assert_eq!(
            config["mcp_servers"]["aurapunk"]["env"],
            serde_json::json!({ "VIBE_BACKEND_URL": "http://localhost:3002" })
        );

        // A pre-existing `aurapunk` entry wins; the legacy duplicate is dropped.
        let mut dupe = serde_json::json!({
            "mcp_servers": {
                "aurapunk": {
                    "command": "aurapunk-mcp",
                    "args": ["--mode", "global"]
                },
                "vibe_kanban": {
                    "command": "npx",
                    "args": ["-y", "vibe-kanban@latest", "--mcp"],
                    "env": { "VIBE_BACKEND_URL": "http://localhost:3002" }
                }
            }
        });
        assert!(migrate_legacy_codex_vibe_kanban_mcp(&mut dupe));
        assert!(dupe["mcp_servers"].get("vibe_kanban").is_none());
        assert_eq!(
            dupe["mcp_servers"]["aurapunk"]["command"],
            serde_json::json!("aurapunk-mcp")
        );

        let mut custom_config = serde_json::json!({
            "mcp_servers": {
                "vibe_kanban": {
                    "command": "custom-vibe-kanban",
                    "args": ["--mcp"]
                }
            }
        });
        assert!(!migrate_legacy_codex_vibe_kanban_mcp(&mut custom_config));
    }
}
