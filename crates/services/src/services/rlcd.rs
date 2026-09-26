//! RLCD — the Laya / Jev "System-1" classifiers, usable from the backend.
//!
//! The classifiers used to be reachable only from the webview: their endpoints,
//! the AuraPunk Cloud device token and the Jev API key live in the frontend's
//! localStorage, so nothing server-side (tool-call guardrails, the MCP memory
//! writes) could ask them anything, and the guardrail toggles in Settings were
//! read by the Settings screen alone. Settings now mirrors that configuration
//! here (`PUT /api/rlcd/config`), persisted as `rlcd.toml` next to
//! `memory.toml`, and the backend classifies:
//!
//! * **tool calls** — a semantic check on top of the deterministic Abide rules
//!   (`classify_tool_call`), and
//! * **memory writes** — whether a fact is worth storing in Mem0 / Qdrant at all
//!   (`classify_memory`).
//!
//! Every classifier call is bounded by a short timeout and fails open: a slow
//! or unreachable classifier must never block an agent or lose a memory. Such
//! failures are recorded in `integration_errors` so the sidebar shows them.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, RwLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use super::integration_errors::{self, IntegrationService};

/// Which classifier answers. `Adaptive` tries Jev first and falls back to Laya.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
pub enum RlcdEngine {
    Laya,
    Jev,
    #[default]
    Adaptive,
}

/// What a guardrail hit does to the tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
pub enum GuardrailAction {
    /// Deny the tool call and hand the agent a repair instruction.
    #[default]
    Block,
    /// Let the call through; the hit is only logged.
    Warn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct GuardrailSettings {
    /// Master switch for all tool-call guardrails.
    pub enabled: bool,
    pub action: GuardrailAction,
    pub protected_files: bool,
    pub ai_attribution: bool,
    pub secret_leak: bool,
    pub git_ops: bool,
    /// Ask the classifier about destructive / exfiltrating commands.
    pub semantic: bool,
}

impl Default for GuardrailSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            action: GuardrailAction::Block,
            protected_files: true,
            ai_attribution: true,
            secret_leak: true,
            git_ops: true,
            semantic: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct MemoryGateSettings {
    /// Classify each memory write before it reaches Mem0 / Qdrant.
    pub enabled: bool,
}

impl Default for MemoryGateSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// Full configuration as stored on disk and sent by Settings.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct RlcdConfig {
    pub engine: RlcdEngine,
    /// Laya base URL (Docker container or AuraPunk Cloud gateway).
    pub laya_url: Option<String>,
    /// Bearer token for the Cloud gateway (the signed-in device token).
    pub laya_token: Option<String>,
    pub jev_url: Option<String>,
    pub jev_key: Option<String>,
    pub jev_model: Option<String>,
    pub guardrails: GuardrailSettings,
    pub memory_gate: MemoryGateSettings,
}

/// What `GET /api/rlcd/config` returns: the config without its secrets.
#[derive(Debug, Clone, Serialize, TS)]
pub struct RlcdConfigView {
    pub engine: RlcdEngine,
    pub laya_url: Option<String>,
    pub has_laya_token: bool,
    pub jev_url: Option<String>,
    pub has_jev_key: bool,
    pub guardrails: GuardrailSettings,
    pub memory_gate: MemoryGateSettings,
}

impl From<&RlcdConfig> for RlcdConfigView {
    fn from(config: &RlcdConfig) -> Self {
        Self {
            engine: config.engine,
            laya_url: config.laya_url.clone(),
            has_laya_token: non_empty(&config.laya_token).is_some(),
            jev_url: config.jev_url.clone(),
            has_jev_key: non_empty(&config.jev_key).is_some(),
            guardrails: config.guardrails.clone(),
            memory_gate: config.memory_gate.clone(),
        }
    }
}

const DEFAULT_JEV_URL: &str = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_JEV_MODEL: &str = "jev-latest";

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

fn config_path() -> PathBuf {
    utils::path::config_home_dir().join("rlcd.toml")
}

static CONFIG: LazyLock<RwLock<Option<RlcdConfig>>> = LazyLock::new(|| RwLock::new(None));

/// Current configuration (defaults until Settings has synced once).
pub fn config() -> RlcdConfig {
    if let Some(config) = CONFIG.read().unwrap_or_else(|p| p.into_inner()).clone() {
        return config;
    }
    let loaded = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| match toml::from_str::<RlcdConfig>(&raw) {
            Ok(config) => Some(config),
            Err(error) => {
                tracing::warn!(%error, "failed to parse rlcd.toml; using defaults");
                None
            }
        })
        .unwrap_or_default();
    *CONFIG.write().unwrap_or_else(|p| p.into_inner()) = Some(loaded.clone());
    loaded
}

/// Persist and activate a new configuration.
pub fn save_config(config: RlcdConfig) -> std::io::Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = toml::to_string_pretty(&config).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, raw)?;
    std::fs::rename(&tmp, &path)?;
    *CONFIG.write().unwrap_or_else(|p| p.into_inner()) = Some(config);
    Ok(())
}

/// A yes/no question for the classifier.
pub struct Question {
    pub key: &'static str,
    pub instructions: &'static str,
}

fn questions_json(questions: &[Question]) -> Value {
    let map: serde_json::Map<String, Value> = questions
        .iter()
        .map(|q| {
            (
                q.key.to_string(),
                json!({ "type": "noul", "instructions": q.instructions }),
            )
        })
        .collect();
    Value::Object(map)
}

/// Probability that each question's answer is "yes", in [0, 1]. Accepts the
/// shapes Laya and Jev use: a bare number, `{probability}` or `{noul}`.
fn parse_probabilities(body: &Value, questions: &[Question]) -> HashMap<&'static str, f64> {
    let answers = body.get("answers").unwrap_or(&Value::Null);
    questions
        .iter()
        .filter_map(|q| {
            let raw = answers.get(q.key)?;
            let p = raw
                .as_f64()
                .or_else(|| raw.get("probability").and_then(Value::as_f64))
                .or_else(|| raw.get("noul").and_then(Value::as_f64))?;
            Some((q.key, p.clamp(0.0, 1.0)))
        })
        .collect()
}

#[derive(Debug, thiserror::Error)]
pub enum RlcdError {
    #[error("no classifier configured (set a Laya endpoint or a Jev API key in Settings)")]
    NotConfigured,
    #[error("{0}")]
    Request(String),
}

struct Target {
    service: IntegrationService,
    url: String,
    bearer: Option<String>,
    body: Value,
}

fn targets(config: &RlcdConfig, state: &str, questions: &Value) -> Vec<Target> {
    let laya = non_empty(&config.laya_url).map(|url| Target {
        service: IntegrationService::Laya,
        url: format!("{}/predict", url.trim_end_matches('/')),
        bearer: non_empty(&config.laya_token).map(str::to_string),
        body: json!({ "state": state, "questions": questions }),
    });
    let jev = non_empty(&config.jev_key).map(|key| Target {
        service: IntegrationService::Jev,
        url: non_empty(&config.jev_url)
            .unwrap_or(DEFAULT_JEV_URL)
            .to_string(),
        bearer: Some(key.to_string()),
        body: json!({
            "model": non_empty(&config.jev_model).unwrap_or(DEFAULT_JEV_MODEL),
            "state": state,
            "questions": questions,
        }),
    });
    match config.engine {
        RlcdEngine::Laya => laya.into_iter().collect(),
        RlcdEngine::Jev => jev.into_iter().collect(),
        RlcdEngine::Adaptive => jev.into_iter().chain(laya).collect(),
    }
}

/// Ask the configured classifier(s). Tries each target in engine order and
/// returns the first answer; every failed attempt is recorded for the sidebar.
pub async fn evaluate(
    operation: &str,
    state: &str,
    questions: &[Question],
    timeout: Duration,
) -> Result<HashMap<&'static str, f64>, RlcdError> {
    let config = config();
    let questions_value = questions_json(questions);
    let targets = targets(&config, state, &questions_value);
    if targets.is_empty() {
        return Err(RlcdError::NotConfigured);
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| RlcdError::Request(e.to_string()))?;

    let mut last_error = String::new();
    for target in targets {
        let mut request = client.post(&target.url).json(&target.body);
        if let Some(token) = &target.bearer {
            request = request.bearer_auth(token);
        }
        let outcome = match request.send().await {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>().await {
                    Ok(body) => {
                        let probabilities = parse_probabilities(&body, questions);
                        if probabilities.is_empty() {
                            Err(format!("{} returned no answers", target.url))
                        } else {
                            Ok(probabilities)
                        }
                    }
                    Err(error) => Err(format!("unparseable response from {}: {error}", target.url)),
                }
            }
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                Err(format!(
                    "{} returned HTTP {status}: {}",
                    target.url,
                    body.trim()
                ))
            }
            Err(error) => Err(format!("{} unreachable: {error}", target.url)),
        };
        match outcome {
            Ok(probabilities) => return Ok(probabilities),
            Err(message) => {
                integration_errors::record(target.service, operation, &message);
                last_error = message;
            }
        }
    }
    Err(RlcdError::Request(last_error))
}

// ---------------------------------------------------------------------------
// Memory gate
// ---------------------------------------------------------------------------

const MEMORY_QUESTIONS: &[Question] = &[
    Question {
        key: "durable",
        instructions: "Does this text state a durable fact about a software project that stays true for future work — a decision, convention, architecture, dependency, root cause or how something works?",
    },
    Question {
        key: "volatile",
        instructions: "Is this text transient noise — a raw log, compiler or test output, a stack trace, a timestamp, a commit hash, or the current state of an in-progress task?",
    },
    Question {
        key: "secret",
        instructions: "Does this text contain a credential, API key, token, password or other secret?",
    },
];

#[derive(Debug, Clone, Serialize, TS)]
pub struct MemoryVerdict {
    pub store: bool,
    /// Why the fact was rejected, or why it was stored without a verdict.
    pub reason: Option<String>,
    /// Classifier probabilities, when the classifier answered.
    pub durable: Option<f64>,
    pub volatile: Option<f64>,
    pub secret: Option<f64>,
}

fn memory_decision(p: &HashMap<&'static str, f64>) -> MemoryVerdict {
    let (durable, volatile, secret) = (
        p.get("durable").copied(),
        p.get("volatile").copied(),
        p.get("secret").copied(),
    );
    let reason = if secret.unwrap_or(0.0) >= 0.5 {
        Some("classified as containing a secret".to_string())
    } else if volatile.unwrap_or(0.0) >= 0.6 && durable.unwrap_or(1.0) < 0.5 {
        Some("classified as volatile (log/output/transient state), not a durable fact".to_string())
    } else {
        None
    };
    MemoryVerdict {
        store: reason.is_none(),
        reason,
        durable,
        volatile,
        secret,
    }
}

/// Decide whether `content` should be written to Mem0. Fails open: with the
/// gate disabled, no classifier configured, or the classifier failing, the
/// fact is stored.
pub async fn classify_memory(content: &str) -> MemoryVerdict {
    let stored_without = |reason: &str| MemoryVerdict {
        store: true,
        reason: Some(reason.to_string()),
        durable: None,
        volatile: None,
        secret: None,
    };
    if !config().memory_gate.enabled {
        return stored_without("memory gate disabled");
    }
    match evaluate(
        "memory_gate",
        content,
        MEMORY_QUESTIONS,
        Duration::from_secs(4),
    )
    .await
    {
        Ok(probabilities) => memory_decision(&probabilities),
        Err(RlcdError::NotConfigured) => stored_without("no classifier configured"),
        Err(error) => stored_without(&format!("classifier unavailable: {error}")),
    }
}

// ---------------------------------------------------------------------------
// Tool-call semantic guardrail
// ---------------------------------------------------------------------------

const TOOL_QUESTIONS: &[Question] = &[
    Question {
        key: "destructive",
        instructions: "Would running this irreversibly destroy data outside the task's own working copy — deleting a home directory or other repositories, dropping a database, wiping a disk, or force-overwriting remote history?",
    },
    Question {
        key: "exfiltration",
        instructions: "Would running this send credentials, secrets or private source code to an external host?",
    },
];

/// Semantic check of a shell command. Returns a denial reason when the
/// classifier is confident the command is destructive or exfiltrating; `None`
/// otherwise, including when no classifier is configured or it fails.
pub async fn classify_tool_call(tool_name: &str, command: &str) -> Option<String> {
    let state = format!("Tool: {tool_name}\nCommand:\n{command}");
    let probabilities = evaluate(
        "tool_guardrail",
        &state,
        TOOL_QUESTIONS,
        Duration::from_millis(2500),
    )
    .await
    .ok()?;
    let destructive = probabilities.get("destructive").copied().unwrap_or(0.0);
    let exfiltration = probabilities.get("exfiltration").copied().unwrap_or(0.0);
    if destructive >= 0.8 {
        Some(format!(
            "RLCD guardrail: this command looks irreversibly destructive (p={destructive:.2}). \
             Do not run it; find a non-destructive way to reach the goal or ask the operator."
        ))
    } else if exfiltration >= 0.8 {
        Some(format!(
            "RLCD guardrail: this command looks like it sends secrets or private code to an \
             external host (p={exfiltration:.2}). Do not run it; ask the operator."
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probs(pairs: &[(&'static str, f64)]) -> HashMap<&'static str, f64> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn parses_numbers_and_objects() {
        let body = json!({ "answers": {
            "durable": 0.9,
            "volatile": { "probability": 0.2 },
            "secret": { "noul": 1.4 },
        }});
        let p = parse_probabilities(&body, MEMORY_QUESTIONS);
        assert_eq!(p["durable"], 0.9);
        assert_eq!(p["volatile"], 0.2);
        assert_eq!(p["secret"], 1.0, "clamped to [0, 1]");
    }

    #[test]
    fn stores_durable_facts_and_rejects_noise_and_secrets() {
        assert!(
            memory_decision(&probs(&[
                ("durable", 0.9),
                ("volatile", 0.1),
                ("secret", 0.0)
            ]))
            .store
        );
        assert!(
            !memory_decision(&probs(&[
                ("durable", 0.2),
                ("volatile", 0.9),
                ("secret", 0.0)
            ]))
            .store
        );
        assert!(
            !memory_decision(&probs(&[
                ("durable", 0.9),
                ("volatile", 0.1),
                ("secret", 0.7)
            ]))
            .store
        );
        // Volatile-looking but still a durable fact (e.g. a root cause citing a log).
        assert!(
            memory_decision(&probs(&[
                ("durable", 0.7),
                ("volatile", 0.8),
                ("secret", 0.0)
            ]))
            .store
        );
    }

    #[test]
    fn engine_order_and_missing_config() {
        let mut config = RlcdConfig {
            laya_url: Some("http://localhost:8765/".into()),
            jev_key: Some("k".into()),
            ..Default::default()
        };
        let q = questions_json(MEMORY_QUESTIONS);
        let adaptive: Vec<_> = targets(&config, "s", &q)
            .into_iter()
            .map(|t| t.service)
            .collect();
        assert_eq!(
            adaptive,
            vec![IntegrationService::Jev, IntegrationService::Laya]
        );
        assert_eq!(
            targets(&config, "s", &q)[1].url,
            "http://localhost:8765/predict"
        );

        config.engine = RlcdEngine::Laya;
        config.laya_url = None;
        assert!(targets(&config, "s", &q).is_empty());
    }

    #[test]
    fn view_redacts_secrets() {
        let config = RlcdConfig {
            laya_token: Some("secret-token".into()),
            jev_key: Some("  ".into()),
            ..Default::default()
        };
        let view = RlcdConfigView::from(&config);
        assert!(view.has_laya_token);
        assert!(!view.has_jev_key);
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("secret-token"));
    }
}
