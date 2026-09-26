use anyhow;
use axum::{
    Extension, Router,
    extract::{Json, Path, Query, State, ws::Message},
    middleware::from_fn_with_state,
    response::{IntoResponse, Json as ResponseJson},
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    execution_process_repo_state::ExecutionProcessRepoState,
};
use deployment::Deployment;
use futures_util::{StreamExt, TryStreamExt};
use json_patch::{Patch, PatchOperation};
use serde::Deserialize;
use services::services::container::{AgentProgress, ContainerService};
use std::collections::BTreeMap;
use utils::{log_msg::LogMsg, response::ApiResponse};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::{
        load_execution_process_middleware,
        signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
    },
};

#[derive(Debug, Deserialize)]
struct SessionExecutionProcessQuery {
    pub session_id: Uuid,
    /// If true, include soft-deleted (dropped) processes in results/stream
    #[serde(default)]
    pub show_soft_deleted: Option<bool>,
}

/// Default slice served by `GET /{id}/entries`. Deliberately small: a chat is
/// rendered from a window, not from the whole transcript — a long opencode
/// session's raw log measures in the tens of MB per process.
const DEFAULT_ENTRY_WINDOW: usize = 200;

#[derive(Debug, Deserialize)]
struct EntriesQuery {
    /// First entry index to return. Defaults to the newest window
    /// (`total - limit`), so omitting it asks for "the end of the chat".
    #[serde(default)]
    from_index: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    /// Thinking content is withheld unless asked for: it is the single largest
    /// part of a reasoning-heavy transcript and most turns never open it.
    #[serde(default)]
    include_thinking: Option<bool>,
}

#[derive(Debug, serde::Serialize)]
struct EntrySlot {
    /// Position in the process's transcript — the same index the patch wire
    /// uses (`/entries/{N}`), so `patchKey = <processId>:<index>` stays stable
    /// across window fetches.
    index: usize,
    value: serde_json::Value,
    /// This is a `thinking` entry whose `content` was emptied. The client
    /// re-fetches with `include_thinking=true` to hydrate it on expand.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    thinking_omitted: bool,
}

#[derive(Debug, serde::Serialize)]
struct EntriesPage {
    entries: Vec<EntrySlot>,
    from_index: usize,
    /// Exclusive end of the returned range.
    end_index: usize,
    total_entries: usize,
    /// Older window to request next, `None` when the beginning is reached.
    next_from_index: Option<usize>,
}

fn entry_index(path: &str) -> Option<usize> {
    path.strip_prefix("/entries/")?.parse().ok()
}

/// Apply the stored patch stream to rebuild the final entry table. Patches are
/// append/replace/remove on `/entries/{N}`, so a map keyed by index is the
/// exact document the streaming client would have ended up with.
fn materialize_entries(patches: &[Patch]) -> BTreeMap<usize, serde_json::Value> {
    let mut entries: BTreeMap<usize, serde_json::Value> = BTreeMap::new();
    for patch in patches {
        for op in &patch.0 {
            let Some(index) = entry_index(op.path().as_str()) else {
                continue;
            };
            match op {
                PatchOperation::Add(add) => {
                    entries.insert(index, add.value.clone());
                }
                PatchOperation::Replace(replace) => {
                    entries.insert(index, replace.value.clone());
                }
                PatchOperation::Remove(_) => {
                    entries.remove(&index);
                }
                _ => {}
            }
        }
    }
    entries
}

fn is_thinking(value: &serde_json::Value) -> bool {
    value.get("type").and_then(serde_json::Value::as_str) == Some("NORMALIZED_ENTRY")
        && value
            .get("content")
            .and_then(|c| c.get("entry_type"))
            .and_then(|t| t.get("type"))
            .and_then(serde_json::Value::as_str)
            == Some("thinking")
}

async fn execution_entries(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<EntriesQuery>,
) -> Result<ResponseJson<ApiResponse<EntriesPage>>, ApiError> {
    let Some(patches) = deployment
        .container()
        .normalized_transcript(&execution_process.id)
        .await
    else {
        return Err(ApiError::BadRequest("transcript unavailable".into()));
    };

    let entries = materialize_entries(&patches);
    let total_entries = entries.len();
    // Upper bound is generous on purpose: script turns render their output
    // whole and are fetched with a "give me everything" limit, while `end_index`
    // is still clamped to the real entry count — so the only thing this caps
    // is a bogus query, not memory.
    let limit = query
        .limit
        .unwrap_or(DEFAULT_ENTRY_WINDOW)
        .clamp(1, 1_000_000);
    let default_from = total_entries.saturating_sub(limit);
    let from_index = query.from_index.unwrap_or(default_from).min(total_entries);
    let end_index = from_index.saturating_add(limit).min(total_entries);
    let include_thinking = query.include_thinking.unwrap_or(false);

    let mut page: Vec<EntrySlot> = Vec::new();
    for (index, value) in entries.range(from_index..end_index) {
        let mut value = value.clone();
        let mut thinking_omitted = false;
        if !include_thinking
            && is_thinking(&value)
            && let Some(content) = value.get_mut("content").and_then(|c| c.get_mut("content"))
            && !content.as_str().is_some_and(str::is_empty)
        {
            *content = serde_json::Value::String(String::new());
            thinking_omitted = true;
        }
        page.push(EntrySlot {
            index: *index,
            value,
            thinking_omitted,
        });
    }

    Ok(ResponseJson(ApiResponse::success(EntriesPage {
        entries: page,
        from_index,
        end_index,
        total_entries,
        next_from_index: (from_index > 0).then(|| from_index.saturating_sub(limit)),
    })))
}

async fn get_execution_process_by_id(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(_deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess>>, ApiError> {
    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

async fn stream_raw_logs_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Path(exec_id): Path<Uuid>,
) -> impl IntoResponse {
    // Always accept the WebSocket upgrade — handle "not found" inside the
    // connection by sending `finished` and closing cleanly, instead of
    // rejecting with HTTP 404 which the browser surfaces as an opaque
    // connection failure.
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_raw_logs_ws(socket, deployment, exec_id).await {
            tracing::warn!("raw logs WS closed: {}", e);
        }
    })
}

async fn handle_raw_logs_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    exec_id: Uuid,
) -> anyhow::Result<()> {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use executors::logs::utils::patch::ConversationPatch;
    use utils::log_msg::LogMsg;

    // Get the raw stream — if not found, send finished and close cleanly
    let raw_stream = match deployment.container().stream_raw_logs(&exec_id).await {
        Some(stream) => stream,
        None => {
            // No logs available: send finished so the client gets a clean
            // close instead of retrying endlessly.
            let _ = socket
                .send(LogMsg::Finished.to_ws_message_unchecked())
                .await;
            let _ = socket.close().await;
            return Ok(());
        }
    };

    let counter = Arc::new(AtomicUsize::new(0));
    let mut stream = raw_stream.map_ok({
        let counter = counter.clone();
        move |m| match m {
            LogMsg::Stdout(content) => {
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let patch = ConversationPatch::add_stdout(index, content);
                LogMsg::JsonPatch(patch).to_ws_message_unchecked()
            }
            LogMsg::Stderr(content) => {
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let patch = ConversationPatch::add_stderr(index, content);
                LogMsg::JsonPatch(patch).to_ws_message_unchecked()
            }
            LogMsg::Finished => LogMsg::Finished.to_ws_message_unchecked(),
            _ => unreachable!("Raw stream should only have Stdout/Stderr/Finished"),
        }
    });

    loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    Some(Ok(msg)) => {
                        if socket.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::error!("stream error: {}", e);
                        break;
                    }
                    None => break,
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
    // Send a proper close frame so the client sees code 1000 (normal closure)
    // instead of an abnormal TCP drop that triggers reconnection attempts.
    let _ = socket.close().await;
    Ok(())
}

async fn stream_normalized_logs_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Path(exec_id): Path<Uuid>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        let stream = deployment
            .container()
            .stream_normalized_logs(&exec_id)
            .await;

        match stream {
            Some(stream) => {
                let stream = stream.err_into::<anyhow::Error>().into_stream();
                if let Err(e) = handle_normalized_logs_ws(socket, stream).await {
                    tracing::warn!("normalized logs WS closed: {}", e);
                }
            }
            None => {
                // No logs available: send finished and close cleanly
                let mut socket = socket;
                let _ = socket
                    .send(utils::log_msg::LogMsg::Finished.to_ws_message_unchecked())
                    .await;
                let _ = socket.close().await;
            }
        }
    })
}

async fn handle_normalized_logs_ws(
    mut socket: MaybeSignedWebSocket,
    stream: impl futures_util::Stream<Item = anyhow::Result<LogMsg>> + Unpin + Send + 'static,
) -> anyhow::Result<()> {
    let mut stream = stream.map_ok(|msg| msg.to_ws_message_unchecked());
    loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    Some(Ok(msg)) => {
                        if socket.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::error!("stream error: {}", e);
                        break;
                    }
                    None => break,
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
    let _ = socket.close().await;
    Ok(())
}

async fn stop_execution_process(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    deployment
        .container()
        .stop_execution(&execution_process, ExecutionProcessStatus::Killed)
        .await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

async fn open_terminal_process(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    deployment
        .container()
        .open_interactive_terminal(&execution_process)
        .await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Open a NEW detached tmux session running `claude --resume <session_uuid>` for
/// this headed execution and attach a terminal to it (distinct from the live
/// `vk-<id>` session).
async fn open_claude_resume_process(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    deployment
        .container()
        .open_claude_resume_terminal(&execution_process)
        .await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Open a terminal in the execution's owning workspace directory.
async fn open_workspace_terminal_process(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    deployment
        .container()
        .open_workspace_terminal_for_process(&execution_process)
        .await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Reveal the execution's owning workspace directory in the OS file manager
/// (Finder / xdg-open).
async fn reveal_workspace_process(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    deployment
        .container()
        .reveal_workspace_for_process(&execution_process)
        .await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

#[derive(Debug, Deserialize)]
struct SendInputBody {
    text: String,
}

/// Max length of a single line of interactive input (defensive guard; the UI is
/// single-line and an answer/approval is always short).
const MAX_INPUT_LEN: usize = 10_000;

async fn send_input_process(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Json(body): Json<SendInputBody>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let text = body.text.trim();
    if text.is_empty() {
        return Err(ApiError::BadRequest("Input is empty".to_string()));
    }
    if text.len() > MAX_INPUT_LEN {
        return Err(ApiError::BadRequest(format!(
            "Input is too long (max {MAX_INPUT_LEN} characters)"
        )));
    }
    // The UI is single-line; a newline would submit mid-message in the TUI, and
    // other control chars could inject unintended keystrokes.
    if text.chars().any(|c| c.is_control()) {
        return Err(ApiError::BadRequest(
            "Input must be a single line without control characters".to_string(),
        ));
    }
    deployment
        .container()
        .send_interactive_input(&execution_process, text)
        .await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

async fn stream_execution_processes_by_session_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionExecutionProcessQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_execution_processes_by_session_ws(
            socket,
            deployment,
            query.session_id,
            query.show_soft_deleted.unwrap_or(false),
        )
        .await
        {
            tracing::warn!("execution processes by session WS closed: {}", e);
        }
    })
}

async fn handle_execution_processes_by_session_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    session_id: uuid::Uuid,
    show_soft_deleted: bool,
) -> anyhow::Result<()> {
    // Get the raw stream and convert LogMsg to WebSocket messages
    let mut stream = deployment
        .events()
        .stream_execution_processes_for_session_raw(session_id, show_soft_deleted)
        .await?
        .map_ok(|msg| msg.to_ws_message_unchecked());

    loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    Some(Ok(msg)) => {
                        if socket.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::error!("stream error: {}", e);
                        break;
                    }
                    None => break,
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
    Ok(())
}

/// One-shot snapshot of a running (or finished) agent's progress: the latest
/// assistant message plus, for Claude Code Headed runs, the direct-access
/// identifiers. Consumed by the MCP layer (`get_execution`).
async fn get_agent_progress(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<AgentProgress>>, ApiError> {
    let progress = deployment
        .container()
        .agent_progress(&execution_process)
        .await;
    Ok(ResponseJson(ApiResponse::success(progress)))
}

async fn get_execution_process_repo_states(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<ExecutionProcessRepoState>>>, ApiError> {
    let pool = &deployment.db().pool;
    let repo_states =
        ExecutionProcessRepoState::find_by_execution_process_id(pool, execution_process.id).await?;
    Ok(ResponseJson(ApiResponse::success(repo_states)))
}

pub(super) fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    let workspace_id_router = Router::new()
        .route("/", get(get_execution_process_by_id))
        .route("/stop", post(stop_execution_process))
        .route("/open-terminal", post(open_terminal_process))
        .route("/open-claude-resume", post(open_claude_resume_process))
        .route(
            "/open-workspace-terminal",
            post(open_workspace_terminal_process),
        )
        .route("/reveal-workspace", post(reveal_workspace_process))
        .route("/send-input", post(send_input_process))
        .route("/repo-states", get(get_execution_process_repo_states))
        .route("/agent-progress", get(get_agent_progress))
        .route("/raw-logs/ws", get(stream_raw_logs_ws))
        .route("/normalized-logs/ws", get(stream_normalized_logs_ws))
        .route("/entries", get(execution_entries))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_execution_process_middleware,
        ));

    let workspaces_router = Router::new()
        .route(
            "/stream/session/ws",
            get(stream_execution_processes_by_session_ws),
        )
        .nest("/{id}", workspace_id_router);

    Router::new().nest("/execution-processes", workspaces_router)
}
