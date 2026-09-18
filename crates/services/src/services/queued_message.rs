use std::sync::Arc;

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use db::models::scratch::DraftFollowUpData;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// Represents a queued follow-up message for a session
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct QueuedMessage {
    /// The session this message is queued for
    pub session_id: Uuid,
    /// The follow-up data (message + variant)
    pub data: DraftFollowUpData,
    /// Timestamp when the message was queued
    pub queued_at: DateTime<Utc>,
    /// Whether an intentional process interruption may dispatch this message.
    /// This is server-only state; clients only need the queued message data.
    #[serde(skip, default)]
    #[ts(skip)]
    pub dispatch_after_interruption: bool,
}

impl QueuedMessage {
    pub fn should_dispatch_after(
        &self,
        status: &db::models::execution_process::ExecutionProcessStatus,
    ) -> bool {
        use db::models::execution_process::ExecutionProcessStatus;

        !matches!(
            status,
            ExecutionProcessStatus::Failed | ExecutionProcessStatus::Killed
        ) || (self.dispatch_after_interruption && matches!(status, ExecutionProcessStatus::Killed))
    }
}

/// Status of the queue for a session (for frontend display)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum QueueStatus {
    /// No message queued
    Empty,
    /// Message is queued and waiting for execution to complete
    Queued { message: QueuedMessage },
}

/// In-memory service for managing queued follow-up messages.
/// One queued message per session.
#[derive(Clone)]
pub struct QueuedMessageService {
    queue: Arc<DashMap<Uuid, QueuedMessage>>,
}

impl QueuedMessageService {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(DashMap::new()),
        }
    }

    /// Queue a message for a session. Replaces any existing queued message.
    pub fn queue_message(&self, session_id: Uuid, data: DraftFollowUpData) -> QueuedMessage {
        self.queue_message_with_policy(session_id, data, false)
    }

    /// Queue a message that should run after the current process is intentionally
    /// interrupted. Replaces any existing queued message.
    pub fn queue_message_for_immediate_delivery(
        &self,
        session_id: Uuid,
        data: DraftFollowUpData,
    ) -> QueuedMessage {
        self.queue_message_with_policy(session_id, data, true)
    }

    fn queue_message_with_policy(
        &self,
        session_id: Uuid,
        data: DraftFollowUpData,
        dispatch_after_interruption: bool,
    ) -> QueuedMessage {
        let queued = QueuedMessage {
            session_id,
            data,
            queued_at: Utc::now(),
            dispatch_after_interruption,
        };
        self.queue.insert(session_id, queued.clone());
        queued
    }

    /// Cancel/remove a queued message for a session
    pub fn cancel_queued(&self, session_id: Uuid) -> Option<QueuedMessage> {
        self.queue.remove(&session_id).map(|(_, v)| v)
    }

    /// Get the queued message for a session (if any)
    pub fn get_queued(&self, session_id: Uuid) -> Option<QueuedMessage> {
        self.queue.get(&session_id).map(|r| r.clone())
    }

    /// Take (remove and return) the queued message for a session.
    /// Used by finalization flow to consume the queued message.
    pub fn take_queued(&self, session_id: Uuid) -> Option<QueuedMessage> {
        self.queue.remove(&session_id).map(|(_, v)| v)
    }

    /// Check if a session has a queued message
    pub fn has_queued(&self, session_id: Uuid) -> bool {
        self.queue.contains_key(&session_id)
    }

    /// Get queue status for frontend display
    pub fn get_status(&self, session_id: Uuid) -> QueueStatus {
        match self.get_queued(session_id) {
            Some(msg) => QueueStatus::Queued { message: msg },
            None => QueueStatus::Empty,
        }
    }
}

#[cfg(test)]
mod tests {
    use db::models::execution_process::ExecutionProcessStatus;

    use super::*;

    fn queued(dispatch_after_interruption: bool) -> QueuedMessage {
        QueuedMessage {
            session_id: Uuid::new_v4(),
            data: DraftFollowUpData {
                message: "follow up".to_string(),
                executor_config: serde_json::from_value(serde_json::json!({
                    "executor": "CODEX"
                }))
                .expect("valid executor config"),
            },
            queued_at: Utc::now(),
            dispatch_after_interruption,
        }
    }

    #[test]
    fn normal_queue_only_dispatches_after_success() {
        let message = queued(false);

        assert!(message.should_dispatch_after(&ExecutionProcessStatus::Completed));
        assert!(!message.should_dispatch_after(&ExecutionProcessStatus::Killed));
        assert!(!message.should_dispatch_after(&ExecutionProcessStatus::Failed));
    }

    #[test]
    fn immediate_queue_dispatches_after_intentional_kill() {
        let message = queued(true);

        assert!(message.should_dispatch_after(&ExecutionProcessStatus::Completed));
        assert!(message.should_dispatch_after(&ExecutionProcessStatus::Killed));
        assert!(!message.should_dispatch_after(&ExecutionProcessStatus::Failed));
    }
}

impl Default for QueuedMessageService {
    fn default() -> Self {
        Self::new()
    }
}
