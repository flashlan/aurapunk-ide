//! Log normalizer for the Command Code CLI (`command-code -p --output-format json`).
//!
//! Command Code prints newline-delimited JSON frames on stdout:
//! - `{"type":"event","event":{...}}` for every agent event, and
//! - a single trailing `{"type":"result", ...}` line with the run outcome and
//!   the session id.
//!
//! This module turns that event stream into `NormalizedEntry` patches. Anything
//! that isn't JSON is surfaced as a system message, and stderr is handled by the
//! shared plain-text processor.

use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};

use futures::{StreamExt, future::ready};
use serde_json::Value;
use workspace_utils::msg_store::MsgStore;

use crate::logs::{
    ActionType, CommandRunResult, NormalizedEntry, NormalizedEntryError, NormalizedEntryType,
    ToolResult, ToolStatus,
    plain_text_processor::PlainTextLogProcessor,
    utils::{
        EntryIndexProvider,
        patch::{add_normalized_entry, replace_normalized_entry},
    },
};

/// Non-interactive wrapper frames, plus the transport envelope Command Code uses.
const FRAME_EVENT: &str = "event";
const FRAME_RESULT: &str = "result";

pub fn normalize_logs(
    msg_store: Arc<MsgStore>,
    _worktree_path: &Path,
    entry_index_provider: EntryIndexProvider,
) -> Vec<tokio::task::JoinHandle<()>> {
    let h1 = normalize_stderr_logs(msg_store.clone(), entry_index_provider.clone());

    let h2 = tokio::spawn(async move {
        let mut normalizer = CommandCodeNormalizer::new(entry_index_provider, msg_store.clone());

        let mut lines_stream = msg_store
            .stdout_lines_stream()
            .filter_map(|res| ready(res.ok()));

        while let Some(line) = lines_stream.next().await {
            normalizer.process_line(line.trim());
        }

        normalizer.finish();
    });

    vec![h1, h2]
}

struct ToolState {
    index: usize,
    tool_name: String,
    arguments: Value,
    output: Option<String>,
    status: ToolStatus,
}

impl ToolState {
    fn to_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: self.tool_name.clone(),
                action_type: self.action_type(),
                status: self.status.clone(),
            },
            content: self.describe(),
            metadata: None,
        }
    }

    fn describe(&self) -> String {
        if let Some(output) = &self.output {
            output.clone()
        } else {
            self.arguments.to_string()
        }
    }

    fn action_type(&self) -> ActionType {
        match self.tool_name.as_str() {
            "shell_command" | "bash" | "shell" => ActionType::CommandRun {
                command: str_field(&self.arguments, &["command", "cmd"])
                    .unwrap_or_else(|| self.tool_name.clone()),
                result: self.output.as_ref().map(|output| CommandRunResult {
                    exit_status: None,
                    output: Some(output.clone()),
                }),
                category: Default::default(),
            },
            "read" | "read_file" => ActionType::FileRead {
                path: str_field(&self.arguments, &["file_path", "path", "file"])
                    .unwrap_or_default(),
            },
            "grep" | "glob" | "search" => ActionType::Search {
                query: str_field(&self.arguments, &["query", "pattern"]).unwrap_or_default(),
            },
            _ => ActionType::Tool {
                tool_name: self.tool_name.clone(),
                arguments: Some(self.arguments.clone()),
                result: self
                    .output
                    .as_ref()
                    .map(|output| ToolResult::markdown(output.clone())),
            },
        }
    }
}

struct CommandCodeNormalizer {
    msg_store: Arc<MsgStore>,
    entry_index: EntryIndexProvider,
    text: String,
    thinking: String,
    tools: HashMap<String, ToolState>,
    model_reported: bool,
    session_extracted: bool,
    emitted_assistant_text: bool,
}

impl CommandCodeNormalizer {
    fn new(entry_index: EntryIndexProvider, msg_store: Arc<MsgStore>) -> Self {
        Self {
            msg_store,
            entry_index,
            text: String::new(),
            thinking: String::new(),
            tools: HashMap::new(),
            model_reported: false,
            session_extracted: false,
            emitted_assistant_text: false,
        }
    }

    fn process_line(&mut self, trimmed: &str) {
        if trimmed.is_empty() {
            return;
        }

        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => self.handle_frame(&value),
            Err(_) => {
                let entry = self.entry(
                    NormalizedEntryType::SystemMessage,
                    strip_ansi_escapes::strip_str(trimmed).to_string(),
                );
                self.emit(entry);
            }
        }
    }

    fn handle_frame(&mut self, value: &Value) {
        match value.get("type").and_then(Value::as_str) {
            Some(FRAME_EVENT) => {
                if let Some(event) = value.get("event") {
                    self.handle_event(event);
                }
            }
            Some(FRAME_RESULT) => {
                self.extract_session(value);
                self.handle_result(value);
            }
            // Some builds emit bare AgentEvent frames without the envelope.
            _ => self.handle_event(value),
        }
    }

    fn handle_event(&mut self, event: &Value) {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        match event_type {
            "run_start" => self.extract_session(event),
            "model_request_start" => {
                if !self.model_reported
                    && let Some(model) = event.get("model").and_then(Value::as_str)
                {
                    self.model_reported = true;
                    let entry = self.entry(
                        NormalizedEntryType::SystemMessage,
                        format!("model: {model}"),
                    );
                    self.emit(entry);
                }
            }
            "text_delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.text.push_str(delta);
                }
            }
            "thinking_delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.thinking.push_str(delta);
                }
            }
            "thinking_end" => {
                if let Some(text) = event.get("text").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    self.thinking = text.to_string();
                }
                self.flush_thinking();
            }
            "message_end" => self.handle_message_end(event),
            "tool_running" => self.on_tool_running(event),
            "tool_completed" => self.on_tool_finished(event, ToolStatus::Success),
            "tool_errored" => self.on_tool_finished(event, ToolStatus::Failed),
            "tool_denied" => self.on_tool_finished(
                event,
                ToolStatus::Denied {
                    reason: str_field(event, &["reason"]),
                },
            ),
            "run_error" => {
                let message = event
                    .get("error")
                    .map(value_to_string)
                    .unwrap_or_else(|| "Command Code run failed".to_string());
                let entry = self.entry(
                    NormalizedEntryType::ErrorMessage {
                        error_type: NormalizedEntryError::Other,
                    },
                    message,
                );
                self.emit(entry);
            }
            "run_end" => self.handle_run_end(event),
            "notice" => {
                if let Some(message) = event.get("message").and_then(Value::as_str) {
                    let entry = self.entry(NormalizedEntryType::SystemMessage, message.to_string());
                    self.emit(entry);
                }
            }
            _ => {}
        }
    }

    /// Assistant messages carry the full content block list (text, thinking,
    /// tool_use); text deltas were already streamed, so only use blocks as a
    /// fallback and to register tool calls with their real inputs.
    fn handle_message_end(&mut self, event: &Value) {
        let content = event.get("content").and_then(Value::as_array);

        if self.text.is_empty()
            && let Some(blocks) = content
        {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(text) = block.get("text").and_then(Value::as_str)
                {
                    self.text.push_str(text);
                }
            }
        }

        self.flush_text();

        if let Some(blocks) = content {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => self.register_tool(block),
                    Some("thinking") => {
                        if let Some(text) = block.get("thinking").and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            self.thinking.push_str(text);
                        }
                    }
                    _ => {}
                }
            }
        }

        self.flush_thinking();
    }

    fn register_tool(&mut self, block: &Value) {
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() || self.tools.contains_key(&id) {
            return;
        }

        let tool_name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let arguments = block.get("input").cloned().unwrap_or(Value::Null);

        let state = ToolState {
            index: 0,
            tool_name,
            arguments,
            output: None,
            status: ToolStatus::Created,
        };
        let index = add_normalized_entry(&self.msg_store, &self.entry_index, state.to_entry());
        self.tools.insert(id, ToolState { index, ..state });
    }

    fn on_tool_running(&mut self, event: &Value) {
        self.flush_text();

        let id = str_field(event, &["toolCallId", "tool_call_id"]).unwrap_or_default();
        if id.is_empty() || self.tools.contains_key(&id) {
            return;
        }

        let tool_name =
            str_field(event, &["toolName", "tool_name"]).unwrap_or_else(|| "tool".into());
        let arguments = match str_field(event, &["description"]) {
            Some(description) => serde_json::json!({ "description": description }),
            None => Value::Null,
        };
        let state = ToolState {
            index: 0,
            tool_name,
            arguments,
            output: None,
            status: ToolStatus::Created,
        };
        let index = add_normalized_entry(&self.msg_store, &self.entry_index, state.to_entry());
        self.tools.insert(id, ToolState { index, ..state });
    }

    fn on_tool_finished(&mut self, event: &Value, status: ToolStatus) {
        let id = match str_field(event, &["toolCallId", "tool_call_id"]) {
            Some(id) => id,
            None => return,
        };

        if !self.tools.contains_key(&id) {
            self.on_tool_running(event);
        }

        let msg_store = self.msg_store.clone();
        if let Some(state) = self.tools.get_mut(&id) {
            let result_value = event.get("result").or_else(|| event.get("error"));
            state.output = result_value.map(value_to_string);
            state.status = status;

            let entry = state.to_entry();
            replace_normalized_entry(&msg_store, state.index, entry);
        }
    }

    fn handle_run_end(&mut self, event: &Value) {
        if let Some(final_text) = event
            .get("result")
            .and_then(|result| result.get("finalText"))
            .and_then(Value::as_str)
            && !final_text.is_empty()
            && !self.emitted_assistant_text
        {
            self.text.push_str(final_text);
        }
        self.flush_text();
        self.flush_thinking();
    }

    fn handle_result(&mut self, value: &Value) {
        if let Some(final_text) = value.get("finalText").and_then(Value::as_str)
            && !final_text.is_empty()
            && !self.emitted_assistant_text
        {
            self.text.push_str(final_text);
        }
        if let Some(error) = value.get("error").and_then(Value::as_str)
            && !error.trim().is_empty()
        {
            let entry = self.entry(
                NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                error.to_string(),
            );
            self.emit(entry);
        }
        self.flush_text();
    }

    fn flush_text(&mut self) {
        let text = std::mem::take(&mut self.text);
        if text.trim().is_empty() {
            return;
        }
        self.emitted_assistant_text = true;
        let entry = self.entry(NormalizedEntryType::AssistantMessage, text);
        self.emit(entry);
    }

    fn flush_thinking(&mut self) {
        let thinking = std::mem::take(&mut self.thinking);
        if thinking.trim().is_empty() {
            return;
        }
        let entry = self.entry(NormalizedEntryType::Thinking, thinking);
        self.emit(entry);
    }

    fn finish(&mut self) {
        self.flush_text();
        self.flush_thinking();
    }

    fn extract_session(&mut self, value: &Value) {
        if self.session_extracted {
            return;
        }
        if let Some(session_id) = value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .and_then(Value::as_str)
            && !session_id.is_empty()
        {
            self.msg_store.push_session_id(session_id.to_string());
            self.session_extracted = true;
        }
    }

    fn entry(&self, entry_type: NormalizedEntryType, content: String) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type,
            content,
            metadata: None,
        }
    }

    fn emit(&self, entry: NormalizedEntry) {
        add_normalized_entry(&self.msg_store, &self.entry_index, entry);
    }
}

fn normalize_stderr_logs(
    msg_store: Arc<MsgStore>,
    entry_index_provider: EntryIndexProvider,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut stderr = msg_store.stderr_chunked_stream();

        let mut processor = PlainTextLogProcessor::builder()
            .normalized_entry_producer(Box::new(|content: String| NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: strip_ansi_escapes::strip_str(&content).to_string(),
                metadata: None,
            }))
            .time_gap(Duration::from_secs(2))
            .index_provider(entry_index_provider)
            .build();

        while let Some(Ok(chunk)) = stderr.next().await {
            for patch in processor.process(chunk) {
                msg_store.push_patch(patch);
            }
        }
    })
}

fn str_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_string))
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Array(items) => items
            .iter()
            .map(value_to_string)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => {
            for key in ["text", "content", "message", "error"] {
                if let Some(inner) = map.get(key) {
                    return value_to_string(inner);
                }
            }
            value.to_string()
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::value_to_string;
    use serde_json::json;

    #[test]
    fn converts_tool_result_blocks_to_text() {
        let value = json!([
            { "type": "text", "text": "hello" },
            { "type": "text", "text": "world" }
        ]);
        assert_eq!(value_to_string(&value), "hello\nworld");
    }

    #[test]
    fn extracts_named_fields() {
        assert_eq!(value_to_string(&json!({ "text": "done" })), "done");
        assert_eq!(value_to_string(&json!(null)), "");
        assert_eq!(value_to_string(&json!("plain")), "plain");
    }
}
