use std::sync::Arc;

use db::{DBService, models::token_usage::TokenUsageRecord};
use executors::{
    actions::{ExecutorAction, ExecutorActionType},
    logs::{NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch},
};
use futures::StreamExt;
use tokio::task::JoinHandle;
use utils::{log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

/// Return the identity selected for an execution. The model may be absent
/// when the CLI uses its own default; that is kept as NULL rather than guessed.
pub fn execution_identity(
    action: &ExecutorAction,
) -> Option<(String, Option<String>, Option<String>)> {
    let config = match action.typ() {
        ExecutorActionType::CodingAgentInitialRequest(request) => &request.executor_config,
        ExecutorActionType::CodingAgentFollowUpRequest(request) => &request.executor_config,
        ExecutorActionType::ReviewRequest(request) => &request.executor_config,
        ExecutorActionType::ScriptRequest(_) | ExecutorActionType::OpenCodeReviewRequest(_) => {
            return None;
        }
    };

    let model = config.model_id.clone();
    let provider = model.as_deref().and_then(|value| {
        value
            .split_once('/')
            .map(|(provider, _)| provider.to_string())
    });
    Some((config.executor.to_string(), model, provider))
}

/// Consume normalized conversation patches and persist token observations.
/// The database uniqueness constraint makes this safe to run during both a
/// normal launch and headed-session re-adoption.
#[allow(clippy::too_many_arguments)]
pub fn spawn_token_usage_tracker(
    store: Arc<MsgStore>,
    db: DBService,
    execution_process_id: Uuid,
    session_id: Uuid,
    workspace_id: Uuid,
    issue_id: Option<Uuid>,
    agent: String,
    model: Option<String>,
    provider: Option<String>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut stream = store.history_plus_stream();
        while let Some(result) = stream.next().await {
            let Ok(message) = result else { continue };
            let LogMsg::JsonPatch(patch) = message else {
                if matches!(message, LogMsg::Finished) {
                    break;
                }
                continue;
            };

            let Some((entry_index, entry)) = extract_normalized_entry_from_patch(&patch) else {
                continue;
            };
            let NormalizedEntryType::TokenUsageInfo(info) = entry.entry_type else {
                continue;
            };

            if let Err(error) = TokenUsageRecord::upsert(
                &db.pool,
                execution_process_id,
                session_id,
                workspace_id,
                issue_id,
                entry_index as i64,
                &agent,
                provider.as_deref(),
                model.as_deref(),
                info.total_tokens as i64,
                info.model_context_window as i64,
                info.input_tokens.unwrap_or_default() as i64,
                info.output_tokens.unwrap_or_default() as i64,
                info.cache_read_tokens.unwrap_or_default() as i64,
                info.cache_creation_tokens.unwrap_or_default() as i64,
            )
            .await
            {
                tracing::warn!(
                    %execution_process_id,
                    %entry_index,
                    "Failed to persist token usage observation: {error}"
                );
            }
        }
    })
}
