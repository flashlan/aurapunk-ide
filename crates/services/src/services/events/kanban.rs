//! Kanban delta bus.
//!
//! Board tables (`issues`, `project_statuses`, `tags`, `issue_tags`,
//! `issue_relationships`) get their own small broadcast channel instead of
//! riding the global event `MsgStore`: that store keeps ~100 MB of history so
//! transcripts can be replayed, and board churn must never grow it. Consumers
//! are the `/api/kanban/stream/ws` endpoints, which turn these events into
//! per-table upsert/delete deltas for the web board — replacing the 30 s
//! fallback poll as the primary update path.
//!
//! Every event carries a monotonic `seq` so a subscriber can tell a clean
//! stream from a gap; a lagging subscriber is told to resync rather than the
//! server retaining unbounded history for it.

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use serde::Serialize;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Kanban edits are human-scale (plus occasional agent-driven bulk writes).
/// Well above any burst this app produces, small enough that a stalled
/// subscriber forces a resnapshot instead of unbounded server memory.
const KANBAN_CHANNEL_CAPACITY: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KanbanOp {
    Upsert,
    Delete,
}

/// One board change. `row` is NOT carried: the WebSocket resolves it from the
/// typed `list_by_project` queries, which keeps the hook side (a synchronous
/// SQLite callback, or a small async lookup) free of row serialization.
#[derive(Debug, Clone, Serialize)]
pub struct KanbanEvent {
    pub seq: u64,
    /// Wire table name (`issues`, `tags`, …) — the one `/v1/fallback/*` uses.
    pub table: &'static str,
    /// Owning project. `None` means "fan out": deletes recorded from the
    /// preupdate hook for junction tables can't resolve a project after the
    /// row is gone, so every subscriber sees them and ignores ids it doesn't
    /// hold.
    pub project_id: Option<Uuid>,
    pub op: KanbanOp,
    pub id: Uuid,
}

#[derive(Clone)]
pub struct KanbanEventBus {
    tx: broadcast::Sender<KanbanEvent>,
    seq: Arc<AtomicU64>,
}

impl Default for KanbanEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl KanbanEventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(KANBAN_CHANNEL_CAPACITY);
        Self {
            tx,
            seq: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<KanbanEvent> {
        self.tx.subscribe()
    }

    /// Highest sequence handed out so far (0 when nothing was ever published).
    pub fn last_seq(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }

    pub fn publish(&self, table: &'static str, project_id: Option<Uuid>, op: KanbanOp, id: Uuid) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        // A receiver that dropped (all WS handlers closed) is not an error:
        // there is simply nobody to notify right now.
        let _ = self.tx.send(KanbanEvent {
            seq,
            table,
            project_id,
            op,
            id,
        });
    }
}
