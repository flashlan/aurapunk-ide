//! Pipeline authoring over MCP (ADR-051 step 2).
//!
//! Pipelines are the `~/.aurapunk/pipelines/*.toml` definitions the Settings
//! editor manages. These tools let an agent list them, read and write their
//! TOML (validated first), delete them, and attach a pipeline to a card — the
//! same pointer (`vk:pipeline` block + metadata) the Desktop and Mobile
//! create-card dialogs write, which `get_pipeline` resolves for the agent that
//! runs the card.

use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::{McpServer, ToolError};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct PipelineIdRequest {
    #[schemars(description = "Pipeline id (the TOML file stem, e.g. `async-claude-opus`)")]
    pipeline_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SavePipelineRequest {
    #[schemars(
        description = "Pipeline id (file stem): lowercase letters, digits and dashes. An existing id is overwritten."
    )]
    pipeline_id: String,
    #[schemars(
        description = "Full TOML: `name`, optional `description`, and `[[stage]]` tables with `id`, `label`, `default_enabled`, `prompt` (and optional `heavy`). Read an existing one with get_pipeline_definition for the exact format."
    )]
    content: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SetIssuePipelineRequest {
    #[schemars(description = "Card (issue) ID")]
    issue_id: Uuid,
    #[schemars(
        description = "Pipeline ids to attach (usually one). Empty removes the card's pipeline."
    )]
    pipeline_ids: Vec<String>,
    #[schemars(description = "Stage ids to enable. Omit to use each stage's `default_enabled`.")]
    enabled_stage_ids: Option<Vec<String>>,
    #[schemars(
        description = "Executor the card should run with (e.g. `CLAUDE_CODE`, `CODEX`); see list_agents."
    )]
    executor: Option<String>,
    #[schemars(description = "Extra instructions appended to the card's pipeline block")]
    custom_text: Option<String>,
}

/// Drop stage prompts from a pipeline listing: they can be kilobytes each and
/// an agent choosing a pipeline needs the structure, not the prompt text.
fn summarize(mut pipeline: Value) -> Value {
    if let Some(stages) = pipeline.get_mut("stages").and_then(Value::as_array_mut) {
        for stage in stages {
            if let Some(stage) = stage.as_object_mut() {
                stage.remove("prompt");
                stage.remove("prompt_fragment");
            }
        }
    }
    pipeline
}

fn valid_pipeline_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[tool_router(router = pipeline_admin_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "List the available card pipelines: id, name, description and ordered stages (id, label, default_enabled, heavy). Stage prompts are omitted — use get_pipeline_definition for the full TOML."
    )]
    async fn list_pipelines(&self) -> Result<CallToolResult, ErrorData> {
        match self
            .send_json::<Vec<Value>>(self.client.get(self.url("/api/pipelines")))
            .await
        {
            Ok(pipelines) => Self::success(&serde_json::json!({
                "pipelines": pipelines.into_iter().map(summarize).collect::<Vec<_>>(),
            })),
            Err(error) => Ok(Self::tool_error(error)),
        }
    }

    #[tool(description = "Read a pipeline's full TOML definition, including every stage prompt.")]
    async fn get_pipeline_definition(
        &self,
        Parameters(PipelineIdRequest { pipeline_id }): Parameters<PipelineIdRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url(&format!("/api/pipelines/{pipeline_id}/raw"));
        match self.send_json::<String>(self.client.get(&url)).await {
            Ok(content) => Self::success(&serde_json::json!({
                "pipeline_id": pipeline_id,
                "content": content,
            })),
            Err(error) => Ok(Self::tool_error(error)),
        }
    }

    #[tool(
        description = "Create or overwrite a pipeline from TOML. The content is validated first; on a parse or schema error nothing is written and the error (with line/column when known) is returned."
    )]
    async fn save_pipeline(
        &self,
        Parameters(SavePipelineRequest {
            pipeline_id,
            content,
        }): Parameters<SavePipelineRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if !valid_pipeline_id(&pipeline_id) {
            return Ok(Self::tool_error(ToolError::message(
                "pipeline_id must use lowercase letters, digits and dashes (max 80)",
            )));
        }
        let validation: Value = match self
            .send_json(
                self.client
                    .post(self.url("/api/pipelines/validate"))
                    .json(&serde_json::json!({ "id": pipeline_id, "content": content })),
            )
            .await
        {
            Ok(validation) => validation,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        if validation.get("valid").and_then(Value::as_bool) != Some(true) {
            return Ok(Self::tool_error(ToolError::new(
                "The pipeline TOML is invalid; nothing was written.",
                Some(
                    validation
                        .get("error")
                        .cloned()
                        .unwrap_or(Value::Null)
                        .to_string(),
                ),
            )));
        }
        let url = self.url(&format!("/api/pipelines/{pipeline_id}/raw"));
        match self
            .send_json::<Value>(
                self.client
                    .put(&url)
                    .json(&serde_json::json!({ "content": content })),
            )
            .await
        {
            Ok(pipeline) => Self::success(&serde_json::json!({ "pipeline": summarize(pipeline) })),
            Err(error) => Ok(Self::tool_error(error)),
        }
    }

    #[tool(
        description = "Delete a pipeline definition. Cards that point at it keep their pointer but get_pipeline will no longer resolve it."
    )]
    async fn delete_pipeline(
        &self,
        Parameters(PipelineIdRequest { pipeline_id }): Parameters<PipelineIdRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url(&format!("/api/pipelines/{pipeline_id}"));
        match self.send_empty_json(self.client.delete(&url)).await {
            Ok(()) => Self::success(&serde_json::json!({ "deleted": pipeline_id })),
            Err(error) => Ok(Self::tool_error(error)),
        }
    }

    #[tool(
        description = "Attach a pipeline to a card (or remove it with an empty pipeline_ids): writes the card's `## Pipeline` pointer block and metadata exactly as the create-card dialog does, replacing any previous one. The agent that runs the card then fetches the stages with get_pipeline."
    )]
    async fn set_issue_pipeline(
        &self,
        Parameters(request): Parameters<SetIssuePipelineRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let enabled_ids = match request.enabled_stage_ids {
            Some(ids) => ids,
            None if request.pipeline_ids.is_empty() => Vec::new(),
            None => {
                // Default to each stage's `default_enabled`.
                let pipelines: Vec<Value> = match self
                    .send_json(self.client.get(self.url("/api/pipelines")))
                    .await
                {
                    Ok(pipelines) => pipelines,
                    Err(error) => return Ok(Self::tool_error(error)),
                };
                pipelines
                    .iter()
                    .filter(|pipeline| {
                        pipeline
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| request.pipeline_ids.iter().any(|want| want == id))
                    })
                    .flat_map(|pipeline| {
                        pipeline
                            .get("stages")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default()
                    })
                    .filter(|stage| {
                        stage.get("default_enabled").and_then(Value::as_bool) == Some(true)
                    })
                    .filter_map(|stage| stage.get("id").and_then(Value::as_str).map(String::from))
                    .collect()
            }
        };
        let url = self.url(&format!("/api/issues/{}/pipeline", request.issue_id));
        match self
            .send_json::<Value>(self.client.put(&url).json(&serde_json::json!({
                "pipeline_ids": request.pipeline_ids,
                "enabled_ids": enabled_ids,
                "executor": request.executor,
                "custom_text": request.custom_text,
            })))
            .await
        {
            Ok(issue) => Self::success(&serde_json::json!({
                "issue_id": request.issue_id.to_string(),
                "pipeline_ids": request.pipeline_ids,
                "enabled_stage_ids": enabled_ids,
                "title": issue.get("title"),
            })),
            Err(error) => Ok(Self::tool_error(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_drops_stage_prompts() {
        let summary = summarize(serde_json::json!({
            "id": "p", "stages": [{ "id": "a", "label": "A", "prompt": "long" }]
        }));
        assert_eq!(
            summary["stages"][0],
            serde_json::json!({ "id": "a", "label": "A" })
        );
    }

    #[test]
    fn pipeline_ids_are_file_safe() {
        assert!(valid_pipeline_id("async-claude-opus"));
        for bad in ["", "../x", "Upper", "a b", "a/b", "a.toml"] {
            assert!(!valid_pipeline_id(bad), "{bad}");
        }
    }
}
