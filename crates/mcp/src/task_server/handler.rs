use rmcp::{
    ServerHandler,
    model::{Implementation, ProtocolVersion, ServerCapabilities, ServerInfo},
    tool_handler,
};

use super::{McpMode, McpServer};

#[tool_handler]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        let mut tool_names = self
            .tool_router
            .list_all()
            .into_iter()
            .map(|tool| format!("'{}'", tool.name))
            .collect::<Vec<_>>();
        tool_names.sort();

        let preamble = match self.mode() {
            McpMode::Global => {
                "A Vibe Kanban MCP server for task, issue, repository, workspace, and session management."
            }
            McpMode::Orchestrator => {
                "An orchestrator-scoped Vibe Kanban MCP server with tools limited to the configured workspace and orchestrator session context."
            }
        };
        let mut instruction = format!(
            "{} Use list/read tools first when you need IDs or current state. Before editing code, call `declare_agent_work` with files, symbols, and semantic dependencies; refresh it during long work with `heartbeat_agent_work`, and call `release_agent_work` when done. If the user asks to close or mark a card Done, use `complete_workspace_card`; if the user asks only to merge into main, use `merge_workspace` and keep the card open. Never report coding work as complete without a successful guarded merge unless the user explicitly asks to leave it unmerged. TOOLS: {}.",
            preamble,
            tool_names.join(", ")
        );
        if self.context.is_some() {
            instruction = format!(
                "Use 'get_context' to fetch project, issue, workspace, and orchestrator-session metadata for the active MCP context when available. {}",
                instruction
            );
        }

        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            // Keep the MCP handshake version aligned with the workspace release.
            // A fixed protocol-facing version made stale cached binaries look
            // current to clients and hid launcher/update problems.
            .with_server_info(Implementation::new(
                "aurapunk-mcp",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_protocol_version(ProtocolVersion::V_2025_03_26)
            .with_instructions(instruction)
    }
}
