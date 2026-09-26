//! Process-wide log of failures talking to external integrations (Mem0, Laya,
//! Jev).
//!
//! These integrations are "best effort" by design — a failed memory write or
//! classifier call must not break the agent run — but that used to mean the
//! failure vanished into a log nobody reads while the sidebar health dot stayed
//! green (the health probe checks reachability, not whether writes land). Every
//! failure is recorded here instead, from the backend itself, from the MCP
//! server (a separate process, via `POST /api/integration-errors`) and from the
//! frontend, and the sidebar indicators surface them as balloons.

use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Oldest entries are dropped past this many; the UI only shows the latest few.
const CAPACITY: usize = 100;
/// Messages come from upstream error bodies; keep the log bounded.
const MAX_MESSAGE_CHARS: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IntegrationService {
    Mem0,
    Laya,
    Jev,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct IntegrationError {
    /// Monotonic id; clients remember the last one they have seen.
    #[ts(type = "number")]
    pub seq: u64,
    pub service: IntegrationService,
    /// What was being attempted, e.g. `memory_save`, `compaction`.
    pub operation: String,
    pub message: String,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct ReportIntegrationErrorRequest {
    pub service: IntegrationService,
    pub operation: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct IntegrationErrorsResponse {
    pub errors: Vec<IntegrationError>,
    /// Highest `seq` recorded so far (0 when none), so a client with nothing
    /// new can still advance its cursor.
    #[ts(type = "number")]
    pub latest_seq: u64,
}

struct Log {
    next_seq: u64,
    entries: VecDeque<IntegrationError>,
}

static LOG: LazyLock<Mutex<Log>> = LazyLock::new(|| {
    Mutex::new(Log {
        next_seq: 1,
        entries: VecDeque::with_capacity(CAPACITY),
    })
});

fn truncate(text: &str) -> String {
    let trimmed = text.trim();
    match trimmed.char_indices().nth(MAX_MESSAGE_CHARS) {
        Some((cut, _)) => format!("{}…", &trimmed[..cut]),
        None => trimmed.to_string(),
    }
}

/// Record a failure. Also emits a `warn` so the event is in the backend log.
pub fn record(service: IntegrationService, operation: &str, message: &str) -> IntegrationError {
    tracing::warn!(?service, operation, message, "integration error");
    let mut log = LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = IntegrationError {
        seq: log.next_seq,
        service,
        operation: truncate(operation),
        message: truncate(message),
        at: Utc::now(),
    };
    log.next_seq += 1;
    if log.entries.len() == CAPACITY {
        log.entries.pop_front();
    }
    log.entries.push_back(entry.clone());
    entry
}

/// Errors with `seq > after`, oldest first.
pub fn since(after: u64) -> IntegrationErrorsResponse {
    let log = LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    IntegrationErrorsResponse {
        errors: log
            .entries
            .iter()
            .filter(|entry| entry.seq > after)
            .cloned()
            .collect(),
        latest_seq: log.next_seq - 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The log is process-global, so assert relative to what this test adds.
    #[test]
    fn records_in_order_and_filters_by_cursor() {
        let before = since(0).latest_seq;
        let a = record(IntegrationService::Mem0, "memory_save", "HTTP 401");
        let b = record(IntegrationService::Laya, "compaction", "timeout");
        assert!(b.seq > a.seq);

        let newer = since(a.seq);
        assert!(newer.errors.iter().any(|e| e.seq == b.seq));
        assert!(newer.errors.iter().all(|e| e.seq > a.seq));
        assert!(since(before).errors.iter().any(|e| e.seq == a.seq));
        assert_eq!(since(b.seq).latest_seq, b.seq.max(since(0).latest_seq));
    }

    #[test]
    fn truncates_long_messages() {
        let long = "x".repeat(MAX_MESSAGE_CHARS + 50);
        let entry = record(IntegrationService::Jev, "evaluate", &long);
        assert_eq!(entry.message.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert!(entry.message.ends_with('…'));
    }
}
