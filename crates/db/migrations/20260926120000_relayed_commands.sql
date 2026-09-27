-- Commands relayed from AuraPunk Cloud (Mobile chat prompts, workspace
-- requests) are delivered at-least-once: a lost cursor or a second open window
-- replays them. Each command id is claimed here before it runs, so a replay is
-- acknowledged without re-sending a prompt to an agent.
CREATE TABLE IF NOT EXISTS relayed_commands (
    command_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    claimed_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
CREATE INDEX IF NOT EXISTS idx_relayed_commands_claimed
    ON relayed_commands (claimed_at);
