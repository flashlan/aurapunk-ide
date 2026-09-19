use axum::{
    Router,
    extract::{State, ws::Message},
    http::StatusCode,
    response::{IntoResponse, Json as ResponseJson},
    routing::{get, post},
};
use deployment::Deployment;
use futures_util::StreamExt;
use serde::Deserialize;
use services::services::approvals::{ApprovalDetails, ApprovalInfo};
use utils::approvals::{APPROVAL_TIMEOUT_SECONDS, ApprovalQuestion, ApprovalRequest};
use utils::{
    approvals::{ApprovalOutcome, ApprovalResponse},
    log_msg::LogMsg,
    response::ApiResponse,
};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

/// Subset of the Claude Code `PreToolUse` hook payload (delivered on the hook's
/// stdin) that the headed approval bridge needs. Extra fields are ignored.
#[derive(Debug, Deserialize)]
struct HeadedHookPayload {
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    tool_use_id: Option<String>,
    /// The tool's arguments. For `AskUserQuestion` this carries `questions[]`;
    /// for `ExitPlanMode` it carries `plan`. Round-tripped (plus injected
    /// answers) back as `updatedInput` so the agent proceeds with the result.
    #[serde(default)]
    tool_input: serde_json::Value,
}

/// Build a Claude `PreToolUse` hook decision (the exact JSON the CLI reads back
/// from the hook command's stdout). `decision` is "allow" | "deny" | "ask".
fn hook_decision(decision: &str, reason: Option<&str>) -> serde_json::Value {
    let mut out = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
        }
    });
    if let Some(reason) = reason
        && let Some(obj) = out["hookSpecificOutput"].as_object_mut()
    {
        obj.insert(
            "permissionDecisionReason".to_string(),
            serde_json::Value::String(reason.to_string()),
        );
    }
    out
}

/// `allow` decision that also replaces the tool input via `updatedInput` (the
/// PreToolUse mechanism for answering `AskUserQuestion` / round-tripping an
/// `ExitPlanMode` plan). Only attaches `updatedInput` when it is an object —
/// Claude rejects a non-object here, and tools with no input just get a plain
/// allow.
fn hook_allow_with_input(updated_input: serde_json::Value) -> serde_json::Value {
    let mut out = hook_decision("allow", None);
    if updated_input.is_object()
        && let Some(obj) = out["hookSpecificOutput"].as_object_mut()
    {
        obj.insert("updatedInput".to_string(), updated_input);
    }
    out
}

/// Merge the operator's answers into the `AskUserQuestion` tool input as an
/// `answers` map (`question -> selected labels joined`), mirroring the headless
/// control-protocol path so the agent consumes them identically.
fn merge_question_answers(
    mut tool_input: serde_json::Value,
    answers: &[utils::approvals::QuestionAnswer],
) -> serde_json::Value {
    let answers_map: serde_json::Map<String, serde_json::Value> = answers
        .iter()
        .map(|qa| {
            (
                qa.question.clone(),
                serde_json::Value::String(qa.answer.join(", ")),
            )
        })
        .collect();
    let answers_value = serde_json::Value::Object(answers_map);
    match tool_input.as_object_mut() {
        Some(obj) => {
            obj.insert("answers".to_string(), answers_value);
            tool_input
        }
        None => serde_json::json!({ "answers": answers_value }),
    }
}

/// Active Rule Enforcement (Abide Guardrails via Laya System-1):
/// Deterministically checks file edits, diffs, and commands against repository
/// rules in <1ms without token costs. Returns a structured denial and self-healing
/// repair prompt if a violation is detected.
fn check_abide_guardrails(tool_name: &str, tool_input: &serde_json::Value) -> Option<String> {
    // 1. File modification tools
    if matches!(
        tool_name,
        "WriteToFile"
            | "ReplaceFileContent"
            | "Edit"
            | "write_to_file"
            | "replace_file_content"
            | "edit_file"
    ) {
        // Target file check
        let file_path = tool_input
            .get("file_path")
            .or_else(|| tool_input.get("path"))
            .or_else(|| tool_input.get("TargetFile"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        if file_path.ends_with("shared/types.ts") {
            return Some(
                "Abide: This edit appears to break a rule from this repository's instructions.\n\
                 - Rule \"no-direct-shared-types\" from AGENTS.md: \"Do not manually edit shared/types.ts, instead edit crates/server/src/bin/generate_types.rs\".\n\
                 Repair crates/server/src/bin/generate_types.rs instead of editing shared/types.ts."
                    .to_string(),
            );
        }

        // Content inspection (content, new_string, ReplacementContent, CodeContent)
        let content = tool_input
            .get("content")
            .or_else(|| tool_input.get("new_string"))
            .or_else(|| tool_input.get("ReplacementContent"))
            .or_else(|| tool_input.get("CodeContent"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        if content.contains("Co-Authored-By:")
            || content.contains("Generated with AI")
            || content.contains("🤖 Generated by")
        {
            return Some(
                "Abide: This edit appears to break a rule from this repository's instructions.\n\
                 - Rule \"no-ai-attribution\" from AGENTS.md: \"No AI attribution lines in commits or code files\".\n\
                 Remove AI attribution trailer now, then continue with the task."
                    .to_string(),
            );
        }

        if content.contains("ts_live_") || (content.contains("sk-") && content.len() > 40) {
            return Some(
                "Abide: This edit appears to break a rule from this repository's instructions.\n\
                 - Rule \"no-unprotected-secrets\" from AGENTS.md: \"Never commit raw API keys or credentials directly in code\".\n\
                 Use environment variables instead of hardcoding secrets."
                    .to_string(),
            );
        }
    }

    // 2. Dangerous Git commands in Bash / run_command
    if matches!(tool_name, "Bash" | "run_command") {
        let command = tool_input
            .get("command")
            .or_else(|| tool_input.get("CommandLine"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        let trimmed = command.trim();
        if trimmed.starts_with("git push")
            || trimmed.contains(" git push ")
            || trimmed.starts_with("git merge")
            || trimmed.contains(" git merge ")
            || trimmed.starts_with("git rebase")
            || trimmed.contains(" git rebase ")
        {
            return Some(
                "Abide: This edit appears to break a rule from this repository's instructions.\n\
                 - Rule \"no-manual-git-push-in-completion\" from AGENTS.md: \"Do not run git merge, git rebase, git update-ref, or git push manually for terminal completion; use complete_workspace_card tool instead\".\n\
                 Cancel manual git operation and use complete_workspace_card."
                    .to_string(),
            );
        }
    }

    None
}

/// Headed (interactive tmux) approval bridge: a Claude `PreToolUse` command hook
/// POSTs its payload here and blocks on the response. We create an approval in
/// the SAME store the headless flow uses (so the existing WS stream + web UI +
/// `respond` endpoint drive it), wait for the operator's decision, then return
/// the hook-decision JSON that the CLI reads from the hook's stdout.
///
/// Fail-open: on any error we return `permissionDecision: "ask"` so Claude falls
/// back to its own in-TUI permission prompt rather than blocking forever.
async fn headed_approval_request(
    State(deployment): State<DeploymentImpl>,
    axum::extract::Path(execution_process_id): axum::extract::Path<Uuid>,
    ResponseJson(payload): ResponseJson<HeadedHookPayload>,
) -> ResponseJson<serde_json::Value> {
    let tool_name = if payload.tool_name.is_empty() {
        "tool".to_string()
    } else {
        payload.tool_name.clone()
    };

    let tool_input = payload.tool_input.clone();

    // Active Rule Enforcement (Abide Guardrails via Laya System-1 in <1ms)
    if let Some(violation_reason) = check_abide_guardrails(&tool_name, &tool_input) {
        tracing::warn!(
            exec = %execution_process_id,
            tool = %tool_name,
            reason = %violation_reason,
            "Abide guardrail triggered: blocking edit and requesting self-healing repair"
        );
        return ResponseJson(hook_decision("deny", Some(&violation_reason)));
    }

    tracing::info!(
        "headed approval requested: exec={execution_process_id} tool={tool_name} \
         tool_use_id={:?}",
        payload.tool_use_id
    );

    // Classify the interaction so the web UI / MCP can render and resolve it,
    // and so we return the right shape on `allow`:
    // - AskUserQuestion → question approval; answered via `updatedInput.answers`.
    // - ExitPlanMode    → plan approval; allow round-trips the full tool_input.
    // - anything else   → plain tool approval (Supervised mode).
    let details = match tool_name.as_str() {
        "AskUserQuestion" => {
            let questions = tool_input
                .get("questions")
                .and_then(|q| serde_json::from_value::<Vec<ApprovalQuestion>>(q.clone()).ok())
                .unwrap_or_default();
            ApprovalDetails::question(payload.tool_use_id.clone(), questions)
        }
        "ExitPlanMode" => {
            let plan = tool_input
                .get("plan")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            ApprovalDetails::plan(payload.tool_use_id.clone(), plan)
        }
        _ => ApprovalDetails::tool(payload.tool_use_id.clone()),
    };

    // Keep the store deadline just under the hook timeout so a parked request
    // resolves (and the UI clears) before Claude kills the hook.
    let request = ApprovalRequest::new_with_timeout(
        tool_name.clone(),
        execution_process_id,
        APPROVAL_TIMEOUT_SECONDS - 60,
    );
    let outcome = match deployment
        .approvals()
        .create_and_wait_with_details(request, details)
        .await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            tracing::warn!(
                "headed approval bridge failed for exec={execution_process_id}: {e}; \
                 falling back to in-TUI prompt"
            );
            return ResponseJson(hook_decision(
                "ask",
                Some("vibe-kanban approval unavailable"),
            ));
        }
    };

    let decision = match outcome {
        // Tool/plan approvals: allow and round-trip the original input (an
        // approved ExitPlanMode requires `updatedInput`; harmless for others).
        ApprovalOutcome::Approved => hook_allow_with_input(tool_input.clone()),
        ApprovalOutcome::Denied { reason } => hook_decision(
            "deny",
            Some(reason.as_deref().unwrap_or("Denied in vibe-kanban")),
        ),
        // Fail-open to the in-TUI prompt rather than hard-denying on timeout.
        ApprovalOutcome::TimedOut => hook_decision("ask", Some("Approval request timed out")),
        // Questionnaire answered: inject the answers and allow.
        ApprovalOutcome::Answered { answers } => {
            hook_allow_with_input(merge_question_answers(tool_input.clone(), &answers))
        }
    };

    ResponseJson(decision)
}

/// Read surface for pending approvals of one execution process, including the
/// inline question/plan content. Backs the MCP read path (MCP is an
/// out-of-process HTTP client and cannot read the in-process store directly).
async fn pending_approvals_for_execution(
    State(deployment): State<DeploymentImpl>,
    axum::extract::Path(execution_process_id): axum::extract::Path<Uuid>,
) -> ResponseJson<ApiResponse<Vec<ApprovalInfo>>> {
    let infos = deployment
        .approvals()
        .pending_infos_for_execution(execution_process_id);
    ResponseJson(ApiResponse::success(infos))
}

async fn respond_to_approval(
    State(deployment): State<DeploymentImpl>,
    axum::extract::Path(id): axum::extract::Path<String>,
    ResponseJson(request): ResponseJson<ApprovalResponse>,
) -> Result<ResponseJson<ApiResponse<ApprovalOutcome>>, StatusCode> {
    let service = deployment.approvals();

    match service.respond(&id, request).await {
        Ok((outcome, _context)) => Ok(ResponseJson(ApiResponse::success(outcome))),
        Err(e) => {
            tracing::error!("Failed to respond to approval: {:?}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn stream_approvals_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_approvals_ws(socket, deployment).await {
            tracing::warn!("approvals WS closed: {}", e);
        }
    })
}

async fn handle_approvals_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
) -> anyhow::Result<()> {
    let mut stream = deployment.approvals().patch_stream();

    if let Some(snapshot_patch) = stream.next().await {
        socket
            .send(LogMsg::JsonPatch(snapshot_patch).to_ws_message_unchecked())
            .await?;
    } else {
        return Ok(());
    }
    socket.send(LogMsg::Ready.to_ws_message_unchecked()).await?;

    loop {
        tokio::select! {
            patch = stream.next() => {
                let Some(patch) = patch else {
                    break;
                };

                if socket
                    .send(LogMsg::JsonPatch(patch).to_ws_message_unchecked())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!("approvals WS receive error: {}", error);
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/approvals/{id}/respond", post(respond_to_approval))
        .route("/approvals/stream/ws", get(stream_approvals_ws))
        .route(
            "/approvals/pending/{execution_process_id}",
            get(pending_approvals_for_execution),
        )
        .route(
            "/headed-approvals/{execution_process_id}/request",
            post(headed_approval_request),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_decision_shapes_match_claude_contract() {
        let allow = hook_decision("allow", None);
        assert_eq!(allow["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(allow["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(
            allow["hookSpecificOutput"]
                .get("permissionDecisionReason")
                .is_none()
        );

        let deny = hook_decision("deny", Some("nope"));
        assert_eq!(deny["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(
            deny["hookSpecificOutput"]["permissionDecisionReason"],
            "nope"
        );
    }

    #[test]
    fn headed_hook_payload_tolerates_extra_fields() {
        let raw = r#"{
            "session_id":"s","transcript_path":"/t","cwd":"/c",
            "permission_mode":"default","hook_event_name":"PreToolUse",
            "tool_name":"Bash","tool_input":{"command":"ls"},
            "tool_use_id":"toolu_1"
        }"#;
        let parsed: HeadedHookPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.tool_name, "Bash");
        assert_eq!(parsed.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(parsed.tool_input["command"], "ls");
    }

    #[test]
    fn headed_hook_payload_parses_askuserquestion_input() {
        let raw = r#"{
            "tool_name":"AskUserQuestion","tool_use_id":"toolu_1",
            "tool_input":{"questions":[
                {"question":"Pick","header":"H","multiSelect":true,
                 "options":[{"label":"A","description":"a"},{"label":"B"}]}
            ]}
        }"#;
        let parsed: HeadedHookPayload = serde_json::from_str(raw).unwrap();
        let qs: Vec<ApprovalQuestion> =
            serde_json::from_value(parsed.tool_input["questions"].clone()).unwrap();
        assert_eq!(qs.len(), 1);
        assert!(qs[0].multi_select);
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[0].options[0].label, "A");
        assert_eq!(qs[0].options[1].description, None);
    }

    #[test]
    fn hook_allow_with_input_attaches_object_and_omits_non_object() {
        let with = hook_allow_with_input(serde_json::json!({ "plan": "do it" }));
        assert_eq!(with["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(with["hookSpecificOutput"]["updatedInput"]["plan"], "do it");

        let without = hook_allow_with_input(serde_json::Value::Null);
        assert_eq!(without["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(without["hookSpecificOutput"].get("updatedInput").is_none());
    }

    #[test]
    fn merge_question_answers_injects_joined_labels() {
        let tool_input = serde_json::json!({ "questions": [{ "question": "Q1" }] });
        let answers = vec![
            utils::approvals::QuestionAnswer {
                question: "Q1".to_string(),
                answer: vec!["A".to_string(), "B".to_string()],
            },
            utils::approvals::QuestionAnswer {
                question: "Q2".to_string(),
                answer: vec!["only".to_string()],
            },
        ];
        let merged = merge_question_answers(tool_input, &answers);
        // Original input preserved …
        assert_eq!(merged["questions"][0]["question"], "Q1");
        // … plus the answers map (multi-select joined with ", ").
        assert_eq!(merged["answers"]["Q1"], "A, B");
        assert_eq!(merged["answers"]["Q2"], "only");
    }

    #[test]
    fn merge_question_answers_handles_non_object_input() {
        let merged = merge_question_answers(
            serde_json::Value::Null,
            &[utils::approvals::QuestionAnswer {
                question: "Q".to_string(),
                answer: vec!["X".to_string()],
            }],
        );
        assert_eq!(merged["answers"]["Q"], "X");
    }

    #[test]
    fn abide_guardrails_blocks_direct_edits_to_shared_types() {
        let input = serde_json::json!({
            "TargetFile": "/app/shared/types.ts",
            "ReplacementContent": "export type Foo = string;"
        });
        let violation = check_abide_guardrails("replace_file_content", &input);
        assert!(violation.is_some());
        assert!(violation.unwrap().contains("no-direct-shared-types"));
    }

    #[test]
    fn abide_guardrails_blocks_ai_attribution_trailers() {
        let input = serde_json::json!({
            "path": "README.md",
            "content": "Co-Authored-By: Claude <noreply@anthropic.com>"
        });
        let violation = check_abide_guardrails("WriteToFile", &input);
        assert!(violation.is_some());
        assert!(violation.unwrap().contains("no-ai-attribution"));
    }

    #[test]
    fn abide_guardrails_blocks_dangerous_git_push() {
        let input = serde_json::json!({
            "command": "git push origin main"
        });
        let violation = check_abide_guardrails("Bash", &input);
        assert!(violation.is_some());
        assert!(
            violation
                .unwrap()
                .contains("no-manual-git-push-in-completion")
        );
    }

    #[test]
    fn abide_guardrails_permits_clean_actions() {
        let input = serde_json::json!({
            "path": "crates/server/src/main.rs",
            "content": "fn main() { println!(\"hello\"); }"
        });
        assert!(check_abide_guardrails("WriteToFile", &input).is_none());

        let cmd = serde_json::json!({
            "command": "cargo check"
        });
        assert!(check_abide_guardrails("Bash", &cmd).is_none());
    }
}
