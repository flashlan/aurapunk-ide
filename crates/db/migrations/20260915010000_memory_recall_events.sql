-- Durable recall observations for the Memory Intelligence timeline.  The
-- event is deliberately small: memory content and query text never leave
-- mem0-vk, while quality/timing can still be observed locally.
CREATE TABLE memory_recall_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    top_score REAL,
    outcome TEXT NOT NULL CHECK (outcome IN ('hit', 'weak')),
    recorded_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_memory_recall_events_recorded_at
    ON memory_recall_events (recorded_at);
