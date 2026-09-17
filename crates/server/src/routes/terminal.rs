use std::path::PathBuf;

use axum::{
    Router,
    extract::{
        Query, State,
        ws::{CloseFrame, Message, Utf8Bytes},
    },
    response::IntoResponse,
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    session::Session,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::interactive::tmux_session_name;
use local_deployment::terminal::tmux_has_session;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    /// Workspace-scoped terminal: the shell opens in the workspace's repo
    /// directory. Required unless `repo_path` is provided.
    pub workspace_id: Option<Uuid>,
    /// Project/repo-scoped terminal: open a shell directly in this directory,
    /// without needing a workspace. Required unless `workspace_id` is provided.
    pub repo_path: Option<String>,
    /// When present, attach the terminal to the running headed agent's tmux
    /// session (`vk-<execution_process_id>`) instead of spawning a plain shell.
    /// The tmux session name is always server-derived from this id; the client
    /// never supplies a shell command. Only valid together with `workspace_id`.
    #[serde(default)]
    pub execution_process_id: Option<Uuid>,
    /// When present, re-attach to an existing tmux session by name (for
    /// persistent terminal sessions that survive page reloads).
    #[serde(default)]
    pub tmux_session: Option<String>,
    /// When true, spawns the aurapunk-tui cockpit inside the terminal session.
    #[serde(default)]
    pub is_tui: Option<bool>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

/// Locate the `aurapunk-tui` binary embedded by a desktop installer, next to
/// the current server executable, or fall back to `cargo run -p tui --`.
fn resolve_tui_command() -> (String, Vec<String>) {
    let binary_name = if cfg!(target_os = "windows") {
        "aurapunk-tui.exe"
    } else {
        "aurapunk-tui"
    };
    if let Some(tui_bin) = std::env::var_os("AURAPUNK_BUNDLED_BIN_DIR")
        .map(std::path::PathBuf::from)
        .map(|dir| dir.join(binary_name))
        .filter(|path| path.exists())
    {
        return (tui_bin.to_string_lossy().to_string(), vec![]);
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        let tui_bin = parent.join(binary_name);
        if tui_bin.exists() {
            return (tui_bin.to_string_lossy().to_string(), vec![]);
        }
    }
    (
        "cargo".to_string(),
        vec![
            "run".to_string(),
            "-p".to_string(),
            "tui".to_string(),
            "--".to_string(),
        ],
    )
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalCommand {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalMessage {
    Output { data: String },
    Error { message: String },
}

/// Why an attach request was rejected. Each variant maps to a user-facing
/// message rendered into the attached terminal before a clean close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachError {
    NotFound,
    NotRunning,
    NotCodingAgent,
    NotInteractive,
    WorkspaceMismatch,
    SessionGone,
}

impl AttachError {
    fn message(self) -> &'static str {
        match self {
            AttachError::NotFound => "No such execution process",
            AttachError::NotRunning => "The agent session is not running",
            AttachError::NotCodingAgent => "That process is not a coding-agent session",
            AttachError::NotInteractive => "That session is not an interactive (tmux) session",
            AttachError::WorkspaceMismatch => "That session belongs to a different workspace",
            AttachError::SessionGone => "The tmux session is no longer running",
        }
    }
}

/// Pure validator for an attach request. Returns the deterministic tmux session
/// name (`vk-<proc_id>`) only when the process is a running, interactive coding
/// agent owned by the requesting workspace. Kept free of DB/socket/tmux IO so it
/// is unit-testable.
fn resolve_attach_target(
    status: &ExecutionProcessStatus,
    run_reason: &ExecutionProcessRunReason,
    has_interactive: bool,
    proc_workspace_id: Uuid,
    query_workspace_id: Uuid,
    proc_id: Uuid,
) -> Result<String, AttachError> {
    if !matches!(status, ExecutionProcessStatus::Running) {
        return Err(AttachError::NotRunning);
    }
    if !matches!(run_reason, ExecutionProcessRunReason::CodingAgent) {
        return Err(AttachError::NotCodingAgent);
    }
    if !has_interactive {
        return Err(AttachError::NotInteractive);
    }
    if proc_workspace_id != query_workspace_id {
        return Err(AttachError::WorkspaceMismatch);
    }
    Ok(tmux_session_name(proc_id))
}

/// Resolve + validate the attach target against the DB (process → session →
/// workspace), then confirm the tmux session is actually alive.
async fn resolve_attach_session(
    deployment: &DeploymentImpl,
    proc_id: Uuid,
    query_workspace_id: Uuid,
) -> Result<String, AttachError> {
    let pool = &deployment.db().pool;

    let process = ExecutionProcess::find_by_id(pool, proc_id)
        .await
        .ok()
        .flatten()
        .ok_or(AttachError::NotFound)?;

    let has_interactive = process
        .executor_action()
        .ok()
        .and_then(|action| action.interactive_config())
        .is_some();

    let session = Session::find_by_id(pool, process.session_id)
        .await
        .ok()
        .flatten()
        .ok_or(AttachError::NotFound)?;

    let session_name = resolve_attach_target(
        &process.status,
        &process.run_reason,
        has_interactive,
        session.workspace_id,
        query_workspace_id,
        process.id,
    )?;

    if !tmux_has_session(&session_name).await {
        return Err(AttachError::SessionGone);
    }

    Ok(session_name)
}

async fn terminal_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<TerminalQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let working_dir = resolve_working_dir(&deployment, &query).await?;

    // NOTE: attach-target validation is intentionally deferred to AFTER the WS
    // upgrade. Failing pre-upgrade would surface to the browser as a failed
    // connection, which the frontend `TerminalProvider` treats as a transient
    // drop and reconnect-loops. Inside the upgraded socket we instead send a
    // `TerminalMessage::Error` and close cleanly (code 1000), which the client
    // treats as terminal.
    let attach_process_id = query.execution_process_id;
    let tmux_session = query.tmux_session;
    let workspace_id = query.workspace_id;
    let is_tui = query.is_tui.unwrap_or(false);
    Ok(ws.on_upgrade(move |socket| {
        handle_terminal_ws(
            socket,
            deployment,
            working_dir,
            query.cols,
            query.rows,
            attach_process_id,
            tmux_session,
            workspace_id,
            is_tui,
        )
    }))
}

/// Validate an explicit `repo_path` for a project/repo-scoped terminal.
fn validate_repo_path(repo_path: &str) -> Result<PathBuf, ApiError> {
    let path = PathBuf::from(repo_path);
    if !path.is_absolute() {
        return Err(ApiError::BadRequest(
            "repo_path must be absolute".to_string(),
        ));
    }
    if !path.exists() {
        return Err(ApiError::BadRequest("repo_path does not exist".to_string()));
    }
    if !path.is_dir() {
        return Err(ApiError::BadRequest(
            "repo_path is not a directory".to_string(),
        ));
    }
    Ok(path)
}

/// Resolve the shell working directory from either a workspace id or an
/// explicit repo path. Returns `BadRequest` when neither or both are supplied.
async fn resolve_working_dir(
    deployment: &DeploymentImpl,
    query: &TerminalQuery,
) -> Result<PathBuf, ApiError> {
    match (&query.workspace_id, &query.repo_path) {
        (None, None) => Err(ApiError::BadRequest(
            "Either workspace_id or repo_path is required".to_string(),
        )),
        (Some(_), Some(_)) => Err(ApiError::BadRequest(
            "Only one of workspace_id or repo_path is allowed".to_string(),
        )),
        (None, Some(repo_path)) => validate_repo_path(repo_path),
        (Some(workspace_id), None) => {
            let attempt = Workspace::find_by_id(&deployment.db().pool, *workspace_id)
                .await?
                .ok_or_else(|| ApiError::BadRequest("Workspace not found".to_string()))?;

            let container_ref = attempt.container_ref.ok_or_else(|| {
                ApiError::BadRequest("Workspace has no workspace directory".to_string())
            })?;

            let base_dir = PathBuf::from(&container_ref);
            if !base_dir.exists() {
                return Err(ApiError::BadRequest(
                    "Workspace directory does not exist".to_string(),
                ));
            }

            let mut working_dir = base_dir.clone();
            match WorkspaceRepo::find_repos_for_workspace(&deployment.db().pool, *workspace_id)
                .await
            {
                Ok(repos) if repos.len() == 1 => {
                    let repo_dir = base_dir.join(&repos[0].name);
                    if repo_dir.exists() {
                        working_dir = repo_dir;
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(
                        "Failed to resolve repos for workspace {}: {}",
                        attempt.id,
                        e
                    );
                }
            }
            Ok(working_dir)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_terminal_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    working_dir: PathBuf,
    cols: u16,
    rows: u16,
    attach_process_id: Option<Uuid>,
    tmux_session: Option<String>,
    workspace_id: Option<Uuid>,
    is_tui: bool,
) {
    let is_attach = attach_process_id.is_some();
    let is_resume = tmux_session.is_some();

    // Attach mode is only meaningful for workspace-scoped terminals; a
    // project/repo-scoped terminal has no execution process to attach to.
    if is_attach && workspace_id.is_none() {
        close_with_error(&mut socket, "execution_process_id requires workspace_id").await;
        return;
    }

    // Resolve the attach target (if any) post-upgrade. Any failure is reported
    // in-band and the socket is closed cleanly so the client does not reconnect.
    let session_result = if let Some(session_name) = &tmux_session {
        // Re-attach to an existing persistent tmux session
        if local_deployment::terminal::tmux_has_session(session_name).await {
            let args = vec![
                "attach-session".to_string(),
                "-f".to_string(),
                "ignore-size".to_string(),
                "-t".to_string(),
                format!("={session_name}"),
            ];
            deployment
                .pty()
                .create_session_with_command("tmux".to_string(), args, working_dir, cols, rows)
                .await
                .map(|(id, rx)| (id, rx, Some(session_name.clone())))
                .map_err(|e| e.to_string())
        } else {
            Err(format!(
                "tmux session '{session_name}' is no longer running"
            ))
        }
    } else if let Some(proc_id) = attach_process_id {
        // Attach to an agent's tmux session. `workspace_id` is guaranteed
        // `Some` here by the guard above.
        let ws_id = workspace_id.expect("workspace_id checked above");
        match resolve_attach_session(&deployment, proc_id, ws_id).await {
            Ok(session_name) => {
                let args = vec![
                    "attach-session".to_string(),
                    "-f".to_string(),
                    "ignore-size".to_string(),
                    "-t".to_string(),
                    format!("={session_name}"),
                ];
                deployment
                    .pty()
                    .create_session_with_command("tmux".to_string(), args, working_dir, cols, rows)
                    .await
                    .map(|(id, rx)| (id, rx, None))
                    .map_err(|e| e.to_string())
            }
            Err(attach_err) => Err(attach_err.message().to_string()),
        }
    } else {
        // Create a new persistent tmux session for regular terminals or TUI
        let session_name = if is_tui {
            format!("vk-tui-{}", Uuid::new_v4())
        } else {
            format!("vk-tab-{}", Uuid::new_v4())
        };

        let (cmd, cmd_args) = if is_tui {
            resolve_tui_command()
        } else {
            let shell = utils::shell::get_interactive_shell().await;
            (shell.to_string_lossy().to_string(), vec![])
        };

        // Create the tmux session with the command
        let mut tmux_args = vec![
            "new-session".to_string(),
            "-d".to_string(),
            "-s".to_string(),
            session_name.clone(),
            "-c".to_string(),
            working_dir.to_string_lossy().to_string(),
            cmd,
        ];
        tmux_args.extend(cmd_args);

        let output = tokio::process::Command::new("tmux")
            .args(&tmux_args)
            .output()
            .await;

        match output {
            Ok(out) if out.status.success() => {
                // Attach to the newly created session
                let args = vec![
                    "attach-session".to_string(),
                    "-f".to_string(),
                    "ignore-size".to_string(),
                    "-t".to_string(),
                    format!("={session_name}"),
                ];
                deployment
                    .pty()
                    .create_session_with_command("tmux".to_string(), args, working_dir, cols, rows)
                    .await
                    .map(|(id, rx)| (id, rx, Some(session_name)))
                    .map_err(|e| e.to_string())
            }
            Ok(out) => Err(format!(
                "tmux new-session failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => Err(format!("failed to run tmux: {e}")),
        }
    };

    let (session_id, mut output_rx, session_name) = match session_result {
        Ok(result) => result,
        Err(message) => {
            tracing::error!("Failed to create terminal session: {}", message);
            if is_attach || is_resume {
                // Clean (code 1000) close so the client treats this as terminal
                // and does not reconnect to a dead/absent session.
                close_with_error(&mut socket, &message).await;
            } else {
                let _ = send_error(&mut socket, &message).await;
            }
            return;
        }
    };

    // Send the tmux session name to the client so it can store it for reconnection
    if let Some(name) = &session_name {
        let msg = serde_json::json!({ "type": "session_name", "name": name });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }
    }

    let pty_service = deployment.pty().clone();
    let session_id_for_input = session_id;

    loop {
        tokio::select! {
            maybe_output = output_rx.recv() => {
                let Some(data) = maybe_output else {
                    break;
                };

                let msg = TerminalMessage::Output {
                    data: BASE64.encode(&data),
                };
                let json = match serde_json::to_string(&msg) {
                    Ok(j) => j,
                    Err(_) => continue,
                };

                if socket.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Text(text))) => {
                        if let Ok(cmd) = serde_json::from_str::<TerminalCommand>(text.as_str()) {
                            match cmd {
                                TerminalCommand::Input { data } => {
                                    if let Ok(bytes) = BASE64.decode(&data) {
                                        let _ = pty_service.write(session_id_for_input, &bytes).await;
                                    }
                                }
                                TerminalCommand::Resize { cols, rows } => {
                                    let _ = pty_service.resize(session_id_for_input, cols, rows).await;
                                }
                            }
                        }
                    }
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!("terminal WS receive error: {}", error);
                        break;
                    }
                }
            }
        }
    }

    let _ = deployment.pty().close_session(session_id).await;

    // A TUI cockpit runs as its own detached `vk-tui-*` tmux session. Closing
    // the terminal tab only detaches the WS/PTY viewer; without explicitly
    // killing the tmux session the `aurapunk-tui` process keeps running in the
    // background forever. Kill it so closing the tab actually stops the cockpit.
    // Attach/resume sessions are intentionally persistent and never killed here.
    if is_tui && let Some(name) = &session_name {
        let _ = tokio::process::Command::new("tmux")
            .args(["kill-session", "-t", name])
            .output()
            .await;
    }

    // For an attach session, the PTY ending means the tmux session died / the
    // agent finished. Tell the client explicitly and close cleanly so it shows
    // the end instead of reconnect-looping against a gone `vk-<id>`.
    if is_attach {
        close_with_error(&mut socket, "tmux session ended").await;
    }
}

async fn send_error(socket: &mut MaybeSignedWebSocket, message: &str) -> anyhow::Result<()> {
    let msg = TerminalMessage::Error {
        message: message.to_string(),
    };
    let json = serde_json::to_string(&msg).unwrap_or_default();
    socket.send(Message::Text(json.into())).await?;
    socket.close().await?;
    Ok(())
}

/// Send an error message then close with code 1000 (`wasClean`). The frontend
/// only suppresses reconnection on a clean 1000 close, so attach failures and
/// attach session-end MUST use this rather than a bare `close()`.
async fn close_with_error(socket: &mut MaybeSignedWebSocket, message: &str) {
    let msg = TerminalMessage::Error {
        message: message.to_string(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = socket.send(Message::Text(json.into())).await;
    }
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: 1000,
            reason: Utf8Bytes::from_static("session ended"),
        })))
        .await;
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new().route("/terminal/ws", get(terminal_ws))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> Uuid {
        Uuid::nil()
    }

    #[test]
    fn resolves_running_interactive_coding_agent_to_tmux_name() {
        let proc_id = Uuid::from_u128(42);
        let ws = workspace();
        let got = resolve_attach_target(
            &ExecutionProcessStatus::Running,
            &ExecutionProcessRunReason::CodingAgent,
            true,
            ws,
            ws,
            proc_id,
        );
        assert_eq!(got, Ok(tmux_session_name(proc_id)));
        assert_eq!(got.unwrap(), format!("vk-{proc_id}"));
    }

    #[test]
    fn rejects_non_running() {
        let ws = workspace();
        assert_eq!(
            resolve_attach_target(
                &ExecutionProcessStatus::Completed,
                &ExecutionProcessRunReason::CodingAgent,
                true,
                ws,
                ws,
                Uuid::from_u128(1),
            ),
            Err(AttachError::NotRunning)
        );
    }

    #[test]
    fn rejects_non_coding_agent() {
        let ws = workspace();
        assert_eq!(
            resolve_attach_target(
                &ExecutionProcessStatus::Running,
                &ExecutionProcessRunReason::DevServer,
                true,
                ws,
                ws,
                Uuid::from_u128(1),
            ),
            Err(AttachError::NotCodingAgent)
        );
    }

    #[test]
    fn rejects_non_interactive() {
        let ws = workspace();
        assert_eq!(
            resolve_attach_target(
                &ExecutionProcessStatus::Running,
                &ExecutionProcessRunReason::CodingAgent,
                false,
                ws,
                ws,
                Uuid::from_u128(1),
            ),
            Err(AttachError::NotInteractive)
        );
    }

    #[test]
    fn rejects_workspace_mismatch() {
        assert_eq!(
            resolve_attach_target(
                &ExecutionProcessStatus::Running,
                &ExecutionProcessRunReason::CodingAgent,
                true,
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                Uuid::from_u128(3),
            ),
            Err(AttachError::WorkspaceMismatch)
        );
    }

    #[test]
    fn validate_repo_path_rejects_relative() {
        let result = validate_repo_path("relative/path");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("absolute"));
    }

    #[test]
    fn validate_repo_path_rejects_missing() {
        let result = validate_repo_path("/definitely/not/a/real/path/xyz");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("does not exist"));
    }

    #[test]
    fn validate_repo_path_accepts_existing_dir() {
        let tmp = std::env::temp_dir();
        let result = validate_repo_path(tmp.to_str().unwrap());
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), tmp);
    }
}
