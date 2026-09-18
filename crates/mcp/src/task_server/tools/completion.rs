use api_types::Issue;
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

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

#[tool_router(router = completion_tools_router, vis = "pub")]
impl McpServer {
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

        let url = self.url(&format!("/api/workspaces/{workspace_id}/git/merge"));
        if let Err(error) = self
            .send_empty_json(self.client.post(url).json(&serde_json::json!({
                "repo_id": repo_id,
                "suppress_auto_move": true,
                "keep_workspace_open": true,
            })))
            .await
        {
            return Ok(Self::tool_error(error));
        }

        McpServer::success(&serde_json::json!({
            "success": true,
            "workspace_id": workspace_id.to_string(),
            "repo_id": repo_id.to_string(),
            "card_closed": false,
        }))
    }

    #[tool(
        description = "Complete a card safely. After you finish and commit the verified work, you MUST call this tool yourself as the final action; do not stop and ask the operator to click Merge or Done, and do not claim completion without a successful response. It integrates the workspace through Integration Guard, then requires Mem0 to acknowledge the verified durable summary, and only then moves the card to its terminal Done status. On any merge conflict, dirty target, concurrent integration, or Mem0 failure, the card remains open. Do not use update_issue to set Done, and do not run manual git merge/rebase/push for this stage."
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
        let merge_url = self.url(&format!("/api/workspaces/{workspace_id}/git/merge"));
        if let Err(error) = self
            .send_empty_json(self.client.post(merge_url).json(&serde_json::json!({
                "repo_id": repo_id,
                "suppress_auto_move": true,
            })))
            .await
        {
            return Ok(Self::tool_error(error));
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
