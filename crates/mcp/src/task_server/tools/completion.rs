use api_types::Issue;
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{McpServer, ToolError};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpCompleteWorkspaceCardRequest {
    #[schemars(
        description = "Issue/card ID. Optional when the current workspace is linked to a card."
    )]
    issue_id: Option<Uuid>,
    #[schemars(description = "Workspace ID. Optional when running inside that workspace context.")]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Repository ID to integrate. Optional when the current workspace has one repository."
    )]
    repo_id: Option<Uuid>,
    #[schemars(
        description = "A concise, verified, durable summary to save to Mem0 before the card is marked Done."
    )]
    memory_summary: String,
    #[schemars(
        description = "Repository slug used as the Mem0 scope. Optional when it can be resolved from the workspace context."
    )]
    user_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpMergeWorkspaceRequest {
    #[schemars(description = "Workspace ID. Optional when running inside that workspace context.")]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Repository ID to integrate. Optional when the current workspace has one repository."
    )]
    repo_id: Option<Uuid>,
}

/// Mirror of the backend `WorkspaceQueueStatus` returned by
/// `GET /api/workspaces/{id}/queue-status`.
#[derive(Debug, Deserialize)]
struct WorkspaceQueueStatus {
    has_queued_messages: bool,
    #[serde(default)]
    session_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpCompleteWorkspaceCardResponse {
    success: bool,
    issue_id: String,
    workspace_id: String,
    repo_id: String,
    memory_queued: bool,
}

/// Integration Guard refusals that clear by themselves once the other actor
/// finishes: another merge running for this repository, or another
/// workspace's active `declare_agent_work` declarations overlapping the
/// branch. Instead of holding the agent inside the tool call (it used to wait
/// 45 s and then fail, with nothing retrying later), the merge is queued in
/// the backend with the verified commit and integrated as soon as the
/// blocker clears; the outcome arrives in the agent's session (ADR-050).
const TRANSIENT_GUARD_BLOCKERS: [&str; 2] = ["integration_in_progress", "agent_work_conflict"];

/// Mirror of the backend `MergeQueueStatus`
/// (`/api/workspaces/{id}/git/merge-queue`).
#[derive(Debug, Deserialize)]
struct MergeQueueStatus {
    #[serde(default)]
    position: Option<i64>,
    current_head: String,
    integrated_head: bool,
}

/// Result of asking the Integration Guard to merge.
enum MergeOutcome {
    Merged,
    /// Refused by a transient blocker and queued for automatic integration.
    Queued {
        blocker: String,
        reason: Option<String>,
        position: Option<i64>,
        commit: String,
    },
}

#[tool_router(router = completion_tools_router, vis = "pub")]
impl McpServer {
    /// POST `/api/workspaces/{id}/git/merge` through the Integration Guard.
    ///
    /// A transient refusal queues the merge (see [`TRANSIENT_GUARD_BLOCKERS`]);
    /// any other refusal comes back through [`Self::merge_blocked_error`] with
    /// the blocker's type, the backend's reason, and an explicit statement
    /// that neither the merge nor the card move happened.
    async fn post_merge(
        &self,
        workspace_id: Uuid,
        repo_id: Uuid,
        suppress_auto_move: bool,
        keep_workspace_open: bool,
        mode: &str,
    ) -> Result<MergeOutcome, ToolError> {
        let url = self.url(&format!("/api/workspaces/{workspace_id}/git/merge"));
        let body = serde_json::json!({
            "repo_id": repo_id,
            "suppress_auto_move": suppress_auto_move,
            "keep_workspace_open": keep_workspace_open,
        });
        let envelope = self
            .send_envelope(self.client.post(&url).json(&body))
            .await?;
        if envelope.success {
            return Ok(MergeOutcome::Merged);
        }

        let blocker = envelope
            .error_data
            .as_ref()
            .and_then(|data| data.get("type"))
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string();

        if TRANSIENT_GUARD_BLOCKERS.contains(&blocker.as_str()) {
            let queue_url = self.url(&format!("/api/workspaces/{workspace_id}/git/merge-queue"));
            let status: MergeQueueStatus = self
                .send_json(self.client.post(&queue_url).json(&serde_json::json!({
                    "repo_id": repo_id,
                    "mode": mode,
                    "blocker": blocker,
                })))
                .await?;
            return Ok(MergeOutcome::Queued {
                blocker,
                reason: envelope.message,
                position: status.position,
                commit: status.current_head,
            });
        }

        Err(Self::merge_blocked_error(
            &blocker,
            envelope.message,
            envelope.error_data,
        ))
    }

    /// Whether the queue already integrated the branch's current commit, so
    /// completion must not merge it again (a squash cannot be re-applied).
    async fn already_integrated(&self, workspace_id: Uuid, repo_id: Uuid) -> bool {
        let url = self.url(&format!(
            "/api/workspaces/{workspace_id}/git/merge-queue?repo_id={repo_id}"
        ));
        self.send_json::<MergeQueueStatus>(self.client.get(&url))
            .await
            .map(|status| status.integrated_head)
            .unwrap_or(false)
    }

    /// Tool result for a queued merge: clearly NOT integrated and NOT closed,
    /// with what happens next, so the agent keeps working instead of stopping.
    fn queued_result(
        workspace_id: Uuid,
        repo_id: Uuid,
        outcome: MergeOutcome,
        tool: &str,
    ) -> Result<CallToolResult, ErrorData> {
        let MergeOutcome::Queued {
            blocker,
            reason,
            position,
            commit,
        } = outcome
        else {
            unreachable!("queued_result is only called for queued merges");
        };
        McpServer::success(&serde_json::json!({
            "success": false,
            "queued": true,
            "integrated": false,
            "card_closed": false,
            "workspace_id": workspace_id.to_string(),
            "repo_id": repo_id.to_string(),
            "blocker": blocker,
            "reason": reason,
            "queue_position": position,
            "queued_commit": commit,
            "next_step": format!(
                "The merge is QUEUED, not done: the Integration Guard is busy ({blocker}). It will be \
        integrated automatically as soon as the blocker clears, and the result will arrive in this session as a \
        message. Do NOT move the card and do NOT run git merge/rebase/push. Do not commit to this branch while it \
        waits (a new commit cancels the queued merge). Continue with any other remaining work, or end your turn; \
        when the message says the merge succeeded, call `{tool}` again to finish."
            ),
        }))
    }

    /// A merge refusal that must leave the card exactly as it was. The
    /// message carries the backend's own reason (WHAT blocked it); the
    /// details carry the blocker type, the "nothing moved" guarantee and the
    /// wait-and-retry next step, so an agent can never mistake a blocked
    /// merge for a completed card.
    fn merge_blocked_error(
        blocker: &str,
        message: Option<String>,
        error_data: Option<serde_json::Value>,
    ) -> ToolError {
        let message =
            message.unwrap_or_else(|| "The Integration Guard refused the merge.".to_string());
        let next_step = match blocker {
            "integration_in_progress" => {
                "Another integration for this repository is still running. Wait for it to \
                 finish, then call this tool again."
            }
            "agent_work_conflict" => {
                "Another workspace's active agent work overlaps this branch. Wait for that \
                 agent to release its declarations (or review the overlap), then call this \
                 tool again."
            }
            "dirty_worktree" => {
                "Stash, commit or delegate the listed files, then call this tool again."
            }
            "merge_conflicts" => {
                "Resolve (or delegate) the listed files, then call this tool again."
            }
            _ => "Resolve the blocker reported above, then call this tool again.",
        };
        let details = format!(
            "blocker: {blocker}. The card was NOT merged and NOT moved to Done — it is still \
             open. {next_step} Do not use update_issue to set Done: the backend refuses a \
             terminal move for a card that is not integrated, and completing without the merge \
             would make the board claim finished work that never landed."
        );
        let details = match error_data {
            // The structured refusal (conflicted files, dirty branch, the
            // agents whose declarations overlap) rides along so "resolve the
            // files below" actually has files below.
            Some(data) => format!(
                "{details}\nBlocker detail: {}",
                serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string())
            ),
            None => details,
        };
        ToolError::new(message, Some(details))
    }

    #[tool(
        description = "Integrate the current workspace branch into its target branch through Integration Guard without closing the card or moving it to Done. Use this when the user asks to merge into main but does not ask to finish or close the card. Commit verified work first. Do not ask for confirmation unless the tool reports a merge conflict, dirty target, concurrent integration, or another explicit blocker."
    )]
    async fn merge_workspace(
        &self,
        Parameters(request): Parameters<McpMergeWorkspaceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(request.workspace_id) {
            Ok(id) => id,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        if let Err(error) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error));
        }

        let repo_id = request.repo_id.or_else(|| {
            self.context
                .as_ref()
                .and_then(|context| context.workspace_repos.first().map(|repo| repo.repo_id))
        });
        let Some(repo_id) = repo_id else {
            return Ok(Self::tool_error(super::ToolError::message(
                "repo_id is required when the workspace has no repository in MCP context",
            )));
        };

        match self
            .post_merge(workspace_id, repo_id, true, true, "merge")
            .await
        {
            Ok(MergeOutcome::Merged) => {}
            Ok(queued) => {
                return Self::queued_result(workspace_id, repo_id, queued, "merge_workspace");
            }
            Err(error) => return Ok(Self::tool_error(error)),
        }

        McpServer::success(&serde_json::json!({
            "success": true,
            "workspace_id": workspace_id.to_string(),
            "repo_id": repo_id.to_string(),
            "card_closed": false,
        }))
    }

    #[tool(
        description = "Complete a card safely. After you finish and commit the verified work, you MUST call this tool yourself as the final action; do not stop and ask the operator to click Merge or Done, and do not claim completion without a successful response. It integrates the workspace through Integration Guard, then requires Mem0 to acknowledge the verified durable summary, and only then moves the card to its terminal Done status. If another integration or overlapping agent work blocks the merge, the merge is QUEUED (`queued: true`): it lands automatically when possible and a message tells you to call this tool again to finish — keep working meanwhile instead of stopping. On a merge conflict, dirty target, or Mem0 failure, the card remains open. Do not use update_issue to set Done, and do not run manual git merge/rebase/push for this stage."
    )]
    async fn complete_workspace_card(
        &self,
        Parameters(request): Parameters<McpCompleteWorkspaceCardRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(request.workspace_id) {
            Ok(id) => id,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        if let Err(error) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error));
        }

        let issue_id = request
            .issue_id
            .or_else(|| self.context.as_ref().and_then(|context| context.issue_id));
        let Some(issue_id) = issue_id else {
            return Ok(Self::tool_error(super::ToolError::message(
                "issue_id is required when the workspace is not linked to a card",
            )));
        };
        if request.memory_summary.trim().is_empty() {
            return Ok(Self::tool_error(super::ToolError::message(
                "memory_summary is required and must contain a verified durable fact",
            )));
        }

        let issue: Issue = match self
            .send_json(
                self.client
                    .get(self.url(&format!("/api/issues/{issue_id}"))),
            )
            .await
        {
            Ok(issue) => issue,
            Err(error) => return Ok(Self::tool_error(error)),
        };

        let statuses = match self.fetch_project_statuses(issue.project_id).await {
            Ok(statuses) => statuses,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        let Some(done_status_id) = statuses
            .into_iter()
            .find(|status| status.is_terminal)
            .map(|status| status.id)
        else {
            return Ok(Self::tool_error(super::ToolError::message(
                "The project has no terminal status configured; the card was left open",
            )));
        };

        let repo_id = request.repo_id.or_else(|| {
            self.context
                .as_ref()
                .and_then(|context| context.workspace_repos.first().map(|repo| repo.repo_id))
        });
        let Some(repo_id) = repo_id else {
            return Ok(Self::tool_error(super::ToolError::message(
                "repo_id is required when the workspace has no repository in MCP context",
            )));
        };

        let user_id = request.user_id.or_else(|| {
            self.context.as_ref().and_then(|context| {
                context
                    .workspace_repos
                    .iter()
                    .find(|repo| repo.repo_id == repo_id)
                    .map(|repo| repo.repo_name.clone())
            })
        });
        let Some(user_id) = user_id else {
            return Ok(Self::tool_error(super::ToolError::message(
                "user_id is required so the completion summary can be scoped to a repository",
            )));
        };

        // A queued follow-up is user-requested work that has not run yet. Moving
        // the card to Done (or merging, which archives the workspace) now would
        // strand that work in a finished column, so refuse before touching the
        // merge and leave the card in its open (In Progress) state.
        let queue_url = self.url(&format!("/api/workspaces/{workspace_id}/queue-status"));
        let queue: WorkspaceQueueStatus = match self.send_json(self.client.get(&queue_url)).await {
            Ok(status) => status,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        if queue.has_queued_messages {
            let sessions = queue
                .session_ids
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(Self::tool_error(super::ToolError::message(format!(
                "The workspace still has {} queued follow-up message(s) (session(s): {}). The card was left open — it was NOT merged and NOT moved to Done. Wait for the queued work to finish, then call complete_workspace_card again.",
                queue.session_ids.len(),
                sessions,
            ))));
        }

        // Defer the merge route's normal auto-move. The card must not reach
        // Done until the required Mem0 write has been acknowledged below.
        // A transient refusal queues the merge and returns at once; the
        // agent is called back and re-runs this tool, and then the queue has
        // already integrated this commit, so it is not merged twice.
        if !self.already_integrated(workspace_id, repo_id).await {
            match self
                .post_merge(workspace_id, repo_id, true, false, "complete")
                .await
            {
                Ok(MergeOutcome::Merged) => {}
                Ok(queued) => {
                    return Self::queued_result(
                        workspace_id,
                        repo_id,
                        queued,
                        "complete_workspace_card",
                    );
                }
                Err(error) => return Ok(Self::tool_error(error)),
            }
        }

        let memory_queued = match self
            .save_memory_for_completion(&request.memory_summary, &user_id)
            .await
        {
            Ok(true) => true,
            Ok(false) => {
                return Ok(Self::tool_error(super::ToolError::message(
                    "Integration succeeded, but Mem0 did not acknowledge the completion summary; the card was left open",
                )));
            }
            Err(error) => return Err(error),
        };

        if let Err(error) = self
            .send_json::<serde_json::Value>(
                self.client
                    .patch(self.url(&format!("/api/issues/{issue_id}")))
                    .json(&serde_json::json!({ "status_id": done_status_id })),
            )
            .await
        {
            return Ok(Self::tool_error(error));
        }

        McpServer::success(&McpCompleteWorkspaceCardResponse {
            success: true,
            issue_id: issue_id.to_string(),
            workspace_id: workspace_id.to_string(),
            repo_id: repo_id.to_string(),
            memory_queued,
        })
    }
}
