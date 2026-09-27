use sqlx::SqlitePool;

/// Claims on commands relayed from AuraPunk Cloud (Mobile chat prompts,
/// workspace requests). Cloud delivery is at-least-once — a lost cursor or a
/// second open window replays events — so each command id is claimed before
/// it runs and a replay is acknowledged without executing again.
///
/// Uses dynamic queries (no compile-time DB needed).
pub struct RelayedCommand;

/// Claims older than this are pruned; a replay that late is not expected.
const RETENTION: &str = "-30 days";

impl RelayedCommand {
    /// Atomically claim `command_id`. Returns `false` when it was already
    /// claimed (by an earlier delivery or a concurrent window).
    pub async fn claim(
        pool: &SqlitePool,
        command_id: &str,
        kind: &str,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query("DELETE FROM relayed_commands WHERE claimed_at < datetime('now', $1)")
            .bind(RETENTION)
            .execute(pool)
            .await?;
        let result = sqlx::query(
            "INSERT INTO relayed_commands (command_id, kind) VALUES ($1, $2)
             ON CONFLICT(command_id) DO NOTHING",
        )
        .bind(command_id)
        .bind(kind)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Drop a claim whose execution failed so a later delivery may retry it.
    pub async fn release(pool: &SqlitePool, command_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM relayed_commands WHERE command_id = $1")
            .bind(command_id)
            .execute(pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn a_command_is_claimed_once() {
        let pool = pool().await;
        assert!(RelayedCommand::claim(&pool, "cmd-1", "chat").await.unwrap());
        assert!(!RelayedCommand::claim(&pool, "cmd-1", "chat").await.unwrap());
        assert!(RelayedCommand::claim(&pool, "cmd-2", "chat").await.unwrap());
    }

    #[tokio::test]
    async fn a_released_claim_can_be_retried() {
        let pool = pool().await;
        assert!(
            RelayedCommand::claim(&pool, "cmd-1", "workspace")
                .await
                .unwrap()
        );
        RelayedCommand::release(&pool, "cmd-1").await.unwrap();
        assert!(
            RelayedCommand::claim(&pool, "cmd-1", "workspace")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn stale_claims_are_pruned() {
        let pool = pool().await;
        sqlx::query(
            "INSERT INTO relayed_commands (command_id, kind, claimed_at)
             VALUES ('old', 'chat', datetime('now', '-31 days'))",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(RelayedCommand::claim(&pool, "new", "chat").await.unwrap());
        assert!(RelayedCommand::claim(&pool, "old", "chat").await.unwrap());
    }
}
