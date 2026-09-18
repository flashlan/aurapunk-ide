use api_types::{
    CreateProjectStatusRequest, InjectSdlcStatusesResponse, MutationResponse, ProjectStatus,
    UpdateProjectStatusRequest,
};
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct StatusSummary {
    #[schemars(description = "Status ID")]
    id: String,
    #[schemars(description = "Status name as shown on the board")]
    name: String,
    #[schemars(description = "Hex color, e.g. #3b82f6")]
    color: String,
    #[schemars(description = "Column order (ascending)")]
    sort_order: i32,
    #[schemars(description = "Hidden columns are tabs rather than board columns")]
    hidden: bool,
    #[schemars(description = "Whether this column marks a card as finished")]
    is_terminal: bool,
}

impl StatusSummary {
    fn from_status(status: ProjectStatus) -> Self {
        Self {
            id: status.id.to_string(),
            name: status.name,
            color: status.color,
            sort_order: status.sort_order,
            hidden: status.hidden,
            is_terminal: status.is_terminal,
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListProjectStatusesRequest {
    #[schemars(
        description = "Project ID. Optional if running inside a workspace linked to a project."
    )]
    project_id: Option<Uuid>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListProjectStatusesResponse {
    project_id: String,
    statuses: Vec<StatusSummary>,
    count: usize,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpCreateProjectStatusRequest {
    #[schemars(
        description = "Project ID. Optional if running inside a workspace linked to a project."
    )]
    project_id: Option<Uuid>,
    #[schemars(description = "Column name (e.g. 'testing')")]
    name: String,
    #[schemars(description = "Hex color, e.g. '#3b82f6'")]
    color: String,
    #[schemars(
        description = "Column order. Omit to append after the project's current last column."
    )]
    sort_order: Option<i32>,
    #[schemars(description = "Hide from board columns (tab only). Defaults to false.")]
    hidden: Option<bool>,
    #[schemars(description = "Mark as the project's terminal/finished column. Defaults to false.")]
    is_terminal: Option<bool>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpCreateProjectStatusResponse {
    status: StatusSummary,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUpdateProjectStatusRequest {
    #[schemars(description = "Status ID to update (from `list_project_statuses`)")]
    status_id: Uuid,
    #[schemars(description = "New column name")]
    name: Option<String>,
    #[schemars(description = "New hex color")]
    color: Option<String>,
    #[schemars(description = "New column order")]
    sort_order: Option<i32>,
    #[schemars(description = "Hide from board columns (tab only)")]
    hidden: Option<bool>,
    #[schemars(description = "Mark as the terminal/finished column")]
    is_terminal: Option<bool>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpUpdateProjectStatusResponse {
    status: StatusSummary,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpDeleteProjectStatusRequest {
    #[schemars(description = "Status ID to delete")]
    status_id: Uuid,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpDeleteProjectStatusResponse {
    success: bool,
    status_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpInjectSdlcStatusesRequest {
    #[schemars(
        description = "Project ID. Optional if running inside a workspace linked to a project."
    )]
    project_id: Option<Uuid>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpInjectSdlcStatusesResponse {
    project_id: String,
    #[schemars(description = "Number of preset columns created (existing ones are skipped)")]
    added: i32,
    statuses: Vec<StatusSummary>,
    count: usize,
}

#[tool_router(router = project_statuses_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "List the card statuses (board columns) of a project. Use the returned IDs with `update_project_status` / `delete_project_status`, and the names with card create/update tools."
    )]
    async fn list_project_statuses(
        &self,
        Parameters(McpListProjectStatusesRequest { project_id }): Parameters<
            McpListProjectStatusesRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        let project_id = match self.resolve_project_id(project_id) {
            Ok(id) => id,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        let statuses = match self.fetch_project_statuses(project_id).await {
            Ok(s) => s,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        let statuses: Vec<StatusSummary> = statuses
            .into_iter()
            .map(StatusSummary::from_status)
            .collect();
        McpServer::success(&McpListProjectStatusesResponse {
            project_id: project_id.to_string(),
            count: statuses.len(),
            statuses,
        })
    }

    #[tool(
        description = "Create a new card status (board column) in a project. `sort_order` defaults to appending after the project's current last column."
    )]
    async fn create_project_status(
        &self,
        Parameters(McpCreateProjectStatusRequest {
            project_id,
            name,
            color,
            sort_order,
            hidden,
            is_terminal,
        }): Parameters<McpCreateProjectStatusRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let project_id = match self.resolve_project_id(project_id) {
            Ok(id) => id,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        let sort_order = match sort_order {
            Some(value) => value,
            None => match self.fetch_project_statuses(project_id).await {
                Ok(statuses) => statuses
                    .iter()
                    .map(|s| s.sort_order)
                    .max()
                    .map(|max| max + 1)
                    .unwrap_or(0),
                Err(e) => return Ok(Self::tool_error(e)),
            },
        };

        let payload = CreateProjectStatusRequest {
            id: None,
            project_id,
            name,
            color,
            sort_order,
            hidden: hidden.unwrap_or(false),
            is_terminal: is_terminal.unwrap_or(false),
        };

        let url = self.url("/api/project-statuses");
        let response: MutationResponse<ProjectStatus> =
            match self.send_json(self.client.post(&url).json(&payload)).await {
                Ok(r) => r,
                Err(e) => return Ok(Self::tool_error(e)),
            };

        McpServer::success(&McpCreateProjectStatusResponse {
            status: StatusSummary::from_status(response.data),
        })
    }

    #[tool(
        description = "Update a card status (board column): rename, recolor, reorder, hide, or toggle terminal. Only the fields you pass are changed."
    )]
    async fn update_project_status(
        &self,
        Parameters(McpUpdateProjectStatusRequest {
            status_id,
            name,
            color,
            sort_order,
            hidden,
            is_terminal,
        }): Parameters<McpUpdateProjectStatusRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let payload = UpdateProjectStatusRequest {
            name,
            color,
            sort_order,
            hidden,
            is_terminal,
        };

        let url = self.url(&format!("/api/project-statuses/{}", status_id));
        let response: MutationResponse<ProjectStatus> =
            match self.send_json(self.client.patch(&url).json(&payload)).await {
                Ok(r) => r,
                Err(e) => return Ok(Self::tool_error(e)),
            };

        McpServer::success(&McpUpdateProjectStatusResponse {
            status: StatusSummary::from_status(response.data),
        })
    }

    #[tool(
        description = "Delete a card status (board column). Cards currently in that column are not moved; prefer moving them first."
    )]
    async fn delete_project_status(
        &self,
        Parameters(McpDeleteProjectStatusRequest { status_id }): Parameters<
            McpDeleteProjectStatusRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url(&format!("/api/project-statuses/{}", status_id));
        if let Err(e) = self.send_empty_json(self.client.delete(&url)).await {
            return Ok(Self::tool_error(e));
        }

        McpServer::success(&McpDeleteProjectStatusResponse {
            success: true,
            status_id: status_id.to_string(),
        })
    }

    #[tool(
        description = "Inject the pre-fabricated SDLC status preset (planning, development, testing, review, iteration, deployment) into a project. Idempotent: existing columns are kept and duplicates are skipped."
    )]
    async fn inject_sdlc_statuses(
        &self,
        Parameters(McpInjectSdlcStatusesRequest { project_id }): Parameters<
            McpInjectSdlcStatusesRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        let project_id = match self.resolve_project_id(project_id) {
            Ok(id) => id,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        let url = self.url("/api/project-statuses/inject-sdlc");
        let payload = serde_json::json!({ "project_id": project_id });
        let response: InjectSdlcStatusesResponse =
            match self.send_json(self.client.post(&url).json(&payload)).await {
                Ok(r) => r,
                Err(e) => return Ok(Self::tool_error(e)),
            };

        let statuses: Vec<StatusSummary> = response
            .project_statuses
            .into_iter()
            .map(StatusSummary::from_status)
            .collect();
        McpServer::success(&McpInjectSdlcStatusesResponse {
            project_id: project_id.to_string(),
            added: response.added,
            count: statuses.len(),
            statuses,
        })
    }
}
