//! Project map over MCP (ADR-054): the hierarchy of the workspace's
//! repositories — areas, modules, what each does and its main public items —
//! built from the code on demand. See `services::services::project_map`.

use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::McpServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ProjectMapRequest {
    #[schemars(
        description = "Subtree to show, e.g. `crates/git` or `packages/web-core/features/workspace-chat`. Omit for the whole repository."
    )]
    path: Option<String>,
    #[schemars(
        description = "Levels to show: 1 = areas only (default without `path`), 2 = areas and modules (default with `path`)."
    )]
    depth: Option<usize>,
    #[schemars(description = "Workspace ID. Optional inside a workspace.")]
    workspace_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RefreshProjectMapRequest {
    #[schemars(description = "Workspace ID. Optional inside a workspace.")]
    workspace_id: Option<Uuid>,
}

#[tool_router(router = project_map_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "Map of this workspace's repositories: areas (crates, packages, folders, ADRs) and their modules, each with what it does and its main public items, read from the code of your branch. Use it FIRST to find where something lives instead of launching exploration agents or grepping blindly: start with depth 1 for the overview, then pass `path` to drill into an area."
    )]
    async fn project_map(
        &self,
        Parameters(ProjectMapRequest {
            path,
            depth,
            workspace_id,
        }): Parameters<ProjectMapRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        let mut query = vec![("workspace_id", workspace_id.to_string())];
        if let Some(path) = path {
            query.push(("path", path));
        }
        if let Some(depth) = depth {
            query.push(("depth", depth.to_string()));
        }
        match self
            .send_json::<Vec<Value>>(self.client.get(self.url("/api/project-map")).query(&query))
            .await
        {
            // The rendered tree is what an agent reads; the JSON nodes would
            // double the size for no gain.
            Ok(maps) => Self::success(&serde_json::json!({
                "maps": maps
                    .into_iter()
                    .map(|map| serde_json::json!({ "repo": map["repo"], "tree": map["text"] }))
                    .collect::<Vec<_>>(),
            })),
            Err(error) => Ok(Self::tool_error(error)),
        }
    }

    #[tool(
        description = "Rewrite the project map in the project's memory (Mem0, `map-<repo>`), so memory_search finds where things live. Only changed areas are rewritten. It also refreshes on its own after merges; call this after large restructurings."
    )]
    async fn refresh_project_map(
        &self,
        Parameters(RefreshProjectMapRequest { workspace_id }): Parameters<RefreshProjectMapRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        match self
            .send_json::<Value>(
                self.client
                    .post(self.url("/api/project-map/sync"))
                    .json(&serde_json::json!({ "workspace_id": workspace_id, "force": true })),
            )
            .await
        {
            Ok(reports) => Self::success(&serde_json::json!({ "repos": reports })),
            Err(error) => Ok(Self::tool_error(error)),
        }
    }
}
