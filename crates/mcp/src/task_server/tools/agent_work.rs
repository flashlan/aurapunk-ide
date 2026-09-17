use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpDeclareAgentWorkRequest {
    #[schemars(description = "Workspace ID. Optional when running inside that workspace context.")]
    workspace_id: Option<Uuid>,
    #[schemars(description = "Short agent label shown in the workspace activity panel")]
    agent_name: Option<String>,
    #[schemars(description = "One-sentence description of the work being attempted")]
    intent: String,
    #[schemars(description = "Files or file globs the agent expects to modify")]
    files: Vec<String>,
    #[schemars(
        description = "Rust/TypeScript symbols, modules, or functions the agent expects to modify"
    )]
    symbols: Vec<String>,
    #[schemars(
        description = "Symbols, modules, APIs, or contracts the agent depends on but does not intend to modify"
    )]
    dependencies: Vec<String>,
    #[schemars(description = "Execution process ID when known")]
    execution_process_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpAgentWorkWorkspaceRequest {
    #[schemars(description = "Workspace ID. Optional when running inside that workspace context.")]
    workspace_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
struct McpAgentWorkResponse {
    declaration: serde_json::Value,
    conflicts: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
struct McpAgentWorkHeartbeatResponse {
    declaration: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpAgentWorkListResponse {
    declarations: Vec<serde_json::Value>,
}

static MCP_OWNER_ID: std::sync::OnceLock<Uuid> = std::sync::OnceLock::new();

fn owner_id() -> Uuid {
    if let Ok(value) = std::env::var("VK_EXECUTION_PROCESS_ID")
        && let Ok(id) = value.parse()
    {
        return id;
    }
    *MCP_OWNER_ID.get_or_init(Uuid::new_v4)
}

fn default_agent_name() -> String {
    utils::env_compat::renamed("AGENT_NAME")
        .unwrap_or_else(|| format!("agent-{}", &owner_id().to_string()[..8]))
}

fn resolve_execution_process_id(explicit: Option<Uuid>) -> Option<Uuid> {
    explicit.or_else(|| {
        std::env::var("VK_EXECUTION_PROCESS_ID")
            .ok()
            .and_then(|value| value.parse().ok())
    })
}

#[tool_router(router = agent_work_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "Declare the files and symbols this agent intends to modify. Call this BEFORE the first code edit. This is a soft reservation: overlapping work returns warnings with the other agent's intent; the caller may wait, choose another area, or continue with shared review."
    )]
    async fn declare_agent_work(
        &self,
        Parameters(McpDeclareAgentWorkRequest {
            workspace_id,
            agent_name,
            intent,
            files,
            symbols,
            dependencies,
            execution_process_id,
        }): Parameters<McpDeclareAgentWorkRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let body = serde_json::json!({
            "owner_id": owner_id(),
            "execution_process_id": resolve_execution_process_id(execution_process_id),
            "agent_name": agent_name.unwrap_or_else(default_agent_name),
            "intent": intent,
            "files": files,
            "symbols": symbols,
            "dependencies": dependencies,
        });
        let url = self.url(&format!("/api/workspaces/{workspace_id}/agent-work"));
        let response: McpAgentWorkResponse =
            match self.send_json(self.client.put(&url).json(&body)).await {
                Ok(response) => response,
                Err(error_result) => return Ok(Self::tool_error(error_result)),
            };

        McpServer::success(&response)
    }

    #[tool(
        description = "Refresh the current agent work declaration lease. Call periodically during long edits so the declaration remains visible."
    )]
    async fn heartbeat_agent_work(
        &self,
        Parameters(McpAgentWorkWorkspaceRequest { workspace_id }): Parameters<
            McpAgentWorkWorkspaceRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let url = self.url(&format!(
            "/api/workspaces/{workspace_id}/agent-work/heartbeat"
        ));
        let response: McpAgentWorkHeartbeatResponse = match self
            .send_json(self.client.post(&url).json(&serde_json::json!({
                "owner_id": owner_id(),
            })))
            .await
        {
            Ok(response) => response,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        McpServer::success(&response)
    }

    #[tool(
        description = "Release the current agent work declaration after the intended edits are complete or abandoned."
    )]
    async fn release_agent_work(
        &self,
        Parameters(McpAgentWorkWorkspaceRequest { workspace_id }): Parameters<
            McpAgentWorkWorkspaceRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let url = self.url(&format!(
            "/api/workspaces/{workspace_id}/agent-work/release"
        ));
        let response: bool = match self
            .send_json(self.client.delete(&url).json(&serde_json::json!({
                "owner_id": owner_id(),
            })))
            .await
        {
            Ok(response) => response,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        McpServer::success(&serde_json::json!({ "released": response }))
    }

    #[tool(
        description = "List the active agent work declarations for a workspace. Use this before starting work when you need to inspect possible file or symbol overlap."
    )]
    async fn list_agent_work(
        &self,
        Parameters(McpAgentWorkWorkspaceRequest { workspace_id }): Parameters<
            McpAgentWorkWorkspaceRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let url = self.url(&format!("/api/workspaces/{workspace_id}/agent-work"));
        let declarations: Vec<serde_json::Value> = match self.send_json(self.client.get(&url)).await
        {
            Ok(declarations) => declarations,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        McpServer::success(&McpAgentWorkListResponse { declarations })
    }
}
