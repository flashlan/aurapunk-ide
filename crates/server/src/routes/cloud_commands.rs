//! Cloud command consumer (ADR-047 phase 3).
//!
//! Mobile prompts, workspace requests and card moves are queued in AuraPunk
//! Cloud (`/api/sync/commands`) and routed to the instance that owns the
//! workspace or card. This loop claims them with a lease, runs them through
//! the same handlers as the direct LAN/Tailcat path and completes them with a
//! result. It replaces the webview loop that replayed commands from the sync
//! event log with a cursor kept in browser storage.

use std::time::Duration;

use api_types::UpdateIssueRequest;
use axum::{Json, extract::State, response::Response};
use db::models::issue::Issue;
use deployment::Deployment;
use serde::Deserialize;
use serde_json::Value;

use super::{
    cloud_sync::{
        CloudOperation, CloudSyncAccount, account_changed, current_instance_id, linked_account,
        push,
    },
    mobile_sync::{
        MobileChatCommand, MobileWorkspaceRequest, post_chat_command, post_workspace_request,
    },
};
use crate::{DeploymentImpl, error::ApiError};

const CLAIM_WAIT_MS: u64 = 25_000;
const IDLE_WITHOUT_ACCOUNT: Duration = Duration::from_secs(10);
const MAX_BACKOFF: Duration = Duration::from_secs(120);
const MIN_EMPTY_CLAIM: Duration = Duration::from_secs(1);

#[derive(Debug, Deserialize)]
struct ClaimResponse {
    #[serde(default)]
    commands: Vec<ClaimedCommand>,
}

#[derive(Debug, Deserialize)]
struct ClaimedCommand {
    id: String,
    kind: String,
    payload: Value,
}

/// How a command ended, as reported to the Cloud.
#[derive(Debug)]
enum Outcome {
    Done(Value),
    Failed(String),
    /// This instance cannot run it (workspace or card lives elsewhere).
    Released(String),
}

pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_millis(CLAIM_WAIT_MS + 15_000))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                tracing::error!(%error, "cloud command consumer disabled: no HTTP client");
                return;
            }
        };
        let mut backoff = Duration::from_secs(2);
        loop {
            let Some(account) = linked_account() else {
                tokio::select! {
                    _ = account_changed().notified() => {}
                    _ = tokio::time::sleep(IDLE_WITHOUT_ACCOUNT) => {}
                }
                continue;
            };
            match claim_and_run(&deployment, &client, &account).await {
                Ok(()) => backoff = Duration::from_secs(2),
                Err(error) => {
                    tracing::warn!(error = %error, "cloud command poll failed; retrying");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    });
}

fn endpoint(account: &CloudSyncAccount, path: &str) -> String {
    format!("{}{path}", account.cloud_url.trim_end_matches('/'))
}

async fn claim_and_run(
    deployment: &DeploymentImpl,
    client: &reqwest::Client,
    account: &CloudSyncAccount,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let response = client
        .post(endpoint(account, "/api/sync/commands/claim"))
        .bearer_auth(&account.access_token)
        .json(&serde_json::json!({
            "instance_id": current_instance_id(),
            "limit": 10,
            "wait_ms": CLAIM_WAIT_MS,
        }))
        .send()
        .await?;
    let code = response.status();
    if code == reqwest::StatusCode::NOT_FOUND {
        // A Cloud without the command queue: wait for it to be deployed.
        tokio::time::sleep(Duration::from_secs(60)).await;
        return Ok(());
    }
    if !code.is_success() {
        let body: String = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        anyhow::bail!("command claim returned HTTP {code}: {body}");
    }
    let claimed: ClaimResponse = response.json().await?;
    if claimed.commands.is_empty() && started.elapsed() < MIN_EMPTY_CLAIM {
        // The Cloud normally holds an empty claim for `wait_ms`; one that
        // answers at once (an older deployment, a proxy) must not turn this
        // loop into a busy poll.
        tokio::time::sleep(MIN_EMPTY_CLAIM).await;
    }
    for command in claimed.commands {
        let outcome = run(deployment, &command).await;
        tracing::info!(id = %command.id, kind = %command.kind, ?outcome, "cloud command handled");
        if command.kind == "workspace_request" {
            publish_workspace_result(client, account, &command, &outcome).await;
        }
        let (status, result) = match &outcome {
            Outcome::Done(result) => ("done", result.clone()),
            Outcome::Failed(message) => ("failed", serde_json::json!({ "error": message })),
            Outcome::Released(reason) => ("released", serde_json::json!({ "reason": reason })),
        };
        let completed = client
            .post(endpoint(account, "/api/sync/commands/complete"))
            .bearer_auth(&account.access_token)
            .json(&serde_json::json!({
                "instance_id": current_instance_id(),
                "id": command.id,
                "status": status,
                "result": result,
            }))
            .send()
            .await?;
        if !completed.status().is_success() {
            // The lease may have expired; the command id keeps a replay from
            // running twice here (relayed_commands).
            tracing::warn!(id = %command.id, status = %completed.status(), "command completion refused");
        }
    }
    Ok(())
}

async fn run(deployment: &DeploymentImpl, command: &ClaimedCommand) -> Outcome {
    match command.kind.as_str() {
        "chat" => run_chat(deployment, command).await,
        "workspace_request" => run_workspace_request(deployment, command).await,
        "issue_update" => run_issue_update(deployment, command).await,
        other => Outcome::Failed(format!("unknown command kind {other}")),
    }
}

async fn response_json(response: Response) -> (bool, Value) {
    let ok = response.status().is_success();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap_or_default();
    (ok, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn api_message(error: &ApiError) -> String {
    format!("{error:?}").chars().take(500).collect()
}

async fn run_chat(deployment: &DeploymentImpl, command: &ClaimedCommand) -> Outcome {
    let mut chat: MobileChatCommand = match serde_json::from_value(command.payload.clone()) {
        Ok(chat) => chat,
        Err(error) => return Outcome::Failed(format!("invalid chat command: {error}")),
    };
    let pool = &deployment.db().pool;
    match db::models::workspace::Workspace::find_by_id(pool, chat.workspace_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Outcome::Released("workspace is not on this instance".into()),
        Err(error) => return Outcome::Failed(error.to_string()),
    }
    chat.command_id = Some(command.id.clone());
    match post_chat_command(State(deployment.clone()), Json(chat)).await {
        Ok(response) => match response_json(response).await {
            (true, body) => Outcome::Done(body.get("data").cloned().unwrap_or(Value::Null)),
            (false, body) => Outcome::Failed(body.to_string()),
        },
        Err(error) => Outcome::Failed(api_message(&error)),
    }
}

async fn run_workspace_request(deployment: &DeploymentImpl, command: &ClaimedCommand) -> Outcome {
    let mut request: MobileWorkspaceRequest = match serde_json::from_value(command.payload.clone())
    {
        Ok(request) => request,
        Err(error) => return Outcome::Failed(format!("invalid workspace request: {error}")),
    };
    match Issue::find_by_id(&deployment.db().pool, request.issue_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Outcome::Released("card is not on this instance".into()),
        Err(error) => return Outcome::Failed(error.to_string()),
    }
    request.command_id = Some(command.id.clone());
    match post_workspace_request(State(deployment.clone()), Json(request)).await {
        Ok(response) => match response_json(response).await {
            (true, body) => Outcome::Done(body.get("data").cloned().unwrap_or(Value::Null)),
            (false, body) => Outcome::Failed(body.to_string()),
        },
        Err(error) => Outcome::Failed(api_message(&error)),
    }
}

#[derive(Debug, Deserialize)]
struct IssueUpdate {
    issue_id: uuid::Uuid,
    status_id: uuid::Uuid,
    /// `updated_at` of the card as the sender saw it.
    base_updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Apply a card move unless the card changed here after the sender's view of
/// it — optimistic concurrency on `updated_at`. The old mirror compared the
/// unchanged `updated_at` Mobile re-sent against the local row and therefore
/// dropped every move made from the phone.
async fn run_issue_update(deployment: &DeploymentImpl, command: &ClaimedCommand) -> Outcome {
    let update: IssueUpdate = match serde_json::from_value(command.payload.clone()) {
        Ok(update) => update,
        Err(error) => return Outcome::Failed(format!("invalid card move: {error}")),
    };
    let pool = &deployment.db().pool;
    let existing = match Issue::find_by_id(pool, update.issue_id).await {
        Ok(Some(issue)) => issue,
        Ok(None) => return Outcome::Released("card is not on this instance".into()),
        Err(error) => return Outcome::Failed(error.to_string()),
    };
    if let Some(base) = update.base_updated_at
        && existing.updated_at > base
    {
        return Outcome::Done(serde_json::json!({ "applied": false, "conflict": true }));
    }
    if existing.status_id == update.status_id {
        return Outcome::Done(serde_json::json!({ "applied": false }));
    }
    let request = UpdateIssueRequest {
        // A move made on the phone is the operator acting on another device,
        // with the same standing as the board's "Move without merging".
        allow_unmerged_done: Some(true),
        status_id: Some(update.status_id),
        title: None,
        description: None,
        priority: None,
        start_date: None,
        target_date: None,
        completed_at: None,
        sort_order: None,
        parent_issue_id: None,
        parent_issue_sort_order: None,
        extension_metadata: None,
    };
    match super::local_kanban::merge_and_update_issue(pool, update.issue_id, request).await {
        Ok(Some(_)) => Outcome::Done(serde_json::json!({ "applied": true })),
        Ok(None) => Outcome::Released("card is not on this instance".into()),
        Err(error) => Outcome::Failed(api_message(&error)),
    }
}

/// Older Mobile builds read the outcome of a workspace request from a
/// `chat_command` record named `<id>:result`; keep publishing it.
async fn publish_workspace_result(
    client: &reqwest::Client,
    account: &CloudSyncAccount,
    command: &ClaimedCommand,
    outcome: &Outcome,
) {
    let issue_id = command
        .payload
        .get("issue_id")
        .cloned()
        .unwrap_or(Value::Null);
    let payload = match outcome {
        Outcome::Done(data) => serde_json::json!({
            "kind": "workspace_request_result",
            "issue_id": issue_id,
            "status": "completed",
            "workspace_id": data.get("workspace_id").cloned().unwrap_or(Value::Null),
        }),
        Outcome::Failed(message) => serde_json::json!({
            "kind": "workspace_request_result",
            "issue_id": issue_id,
            "status": "error",
            "message": message,
        }),
        Outcome::Released(_) => return,
    };
    if let Err(error) = push(
        client,
        account,
        vec![CloudOperation::upsert(
            "chat_command",
            format!("{}:result", command.id),
            payload,
        )],
    )
    .await
    {
        tracing::warn!(id = %command.id, error = %error, "could not publish workspace request result");
    }
}
