use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

/// Cloud sync outbox (ADR-047 phase 2). Triggers on the synced tables record
/// which entity changed while sync is enabled; the backend publisher drains
/// the queue and builds each payload from the current row.
///
/// Uses dynamic queries (no compile-time DB needed).
pub struct CloudSyncOutbox;

#[derive(Debug, Clone, FromRow)]
pub struct OutboxEntry {
    pub seq: i64,
    pub entity_type: String,
    pub entity_id: Uuid,
    pub aux_id: Option<Uuid>,
    pub operation: String,
}

impl CloudSyncOutbox {
    pub async fn is_enabled(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
        let enabled: Option<i64> =
            sqlx::query_scalar("SELECT enabled FROM cloud_sync_state WHERE id = 1")
                .fetch_optional(pool)
                .await?;
        Ok(enabled == Some(1))
    }

    /// Turn change capture on or off. Disabling also drops pending entries:
    /// they belong to the account that was just unlinked.
    pub async fn set_enabled(pool: &SqlitePool, enabled: bool) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE cloud_sync_state SET enabled = $1 WHERE id = 1")
            .bind(i64::from(enabled))
            .execute(&mut *tx)
            .await?;
        if !enabled {
            sqlx::query("DELETE FROM cloud_sync_outbox")
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await
    }

    /// Queue every synced entity once — the bootstrap of a newly linked
    /// account. Later changes arrive through the triggers.
    pub async fn enqueue_all(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        for statement in [
            "INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation)
             SELECT 'project', id, 'upsert' FROM projects",
            "INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation)
             SELECT 'status', id, 'upsert' FROM project_statuses",
            "INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation)
             SELECT 'issue', id, 'upsert' FROM issues",
            "INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation)
             SELECT 'workspace', id, 'upsert' FROM workspaces",
            "INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation)
             SELECT 'workspace_context', id, 'upsert' FROM workspaces",
            "INSERT INTO cloud_sync_outbox (entity_type, entity_id, aux_id, operation)
             SELECT 'issue_workspace', issue_id, workspace_id, 'upsert' FROM issue_workspaces",
            "INSERT INTO cloud_sync_outbox (entity_type, entity_id, operation)
             SELECT 'chat', cat.id, 'upsert'
             FROM coding_agent_turns cat
             JOIN execution_processes ep ON ep.id = cat.execution_process_id
             WHERE ep.dropped = FALSE",
        ] {
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        tx.commit().await
    }

    /// Oldest pending entries, in capture order.
    pub async fn fetch_batch(
        pool: &SqlitePool,
        limit: i64,
    ) -> Result<Vec<OutboxEntry>, sqlx::Error> {
        sqlx::query_as::<_, OutboxEntry>(
            "SELECT seq, entity_type, entity_id, aux_id, operation
             FROM cloud_sync_outbox ORDER BY seq LIMIT $1",
        )
        .bind(limit)
        .fetch_all(pool)
        .await
    }

    /// Drop entries up to `max_seq` once they have been published. Entries
    /// captured afterwards (higher seq) stay queued even for the same entity.
    pub async fn acknowledge(pool: &SqlitePool, max_seq: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM cloud_sync_outbox WHERE seq <= $1")
            .bind(max_seq)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn pending(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COUNT(*) FROM cloud_sync_outbox")
            .fetch_one(pool)
            .await
    }
}

/// Collapse a batch to the latest operation per entity, keeping capture
/// order of each entity's last change.
pub fn coalesce(entries: &[OutboxEntry]) -> Vec<OutboxEntry> {
    let mut latest: Vec<OutboxEntry> = Vec::new();
    for entry in entries {
        latest.retain(|kept| {
            !(kept.entity_type == entry.entity_type
                && kept.entity_id == entry.entity_id
                && kept.aux_id == entry.aux_id)
        });
        latest.push(entry.clone());
    }
    latest
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

    async fn insert_workspace(pool: &SqlitePool) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES (?, 'main', 'test')")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        id
    }

    #[tokio::test]
    async fn nothing_is_captured_while_disabled() {
        let pool = pool().await;
        insert_workspace(&pool).await;
        assert_eq!(CloudSyncOutbox::pending(&pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn changes_are_captured_and_coalesced_once_enabled() {
        let pool = pool().await;
        CloudSyncOutbox::set_enabled(&pool, true).await.unwrap();
        let id = insert_workspace(&pool).await;
        sqlx::query("UPDATE workspaces SET name = 'renamed' WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();

        let batch = CloudSyncOutbox::fetch_batch(&pool, 100).await.unwrap();
        assert_eq!(batch.len(), 6);
        let latest = coalesce(&batch);
        assert_eq!(latest.len(), 2);
        assert!(
            latest
                .iter()
                .all(|entry| entry.entity_id == id && entry.operation == "delete")
        );
    }

    #[tokio::test]
    async fn acknowledge_keeps_later_changes() {
        let pool = pool().await;
        CloudSyncOutbox::set_enabled(&pool, true).await.unwrap();
        insert_workspace(&pool).await;
        let batch = CloudSyncOutbox::fetch_batch(&pool, 100).await.unwrap();
        insert_workspace(&pool).await;
        CloudSyncOutbox::acknowledge(&pool, batch.last().unwrap().seq)
            .await
            .unwrap();
        assert_eq!(CloudSyncOutbox::pending(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn disabling_drops_the_queue_and_bootstrap_requeues_everything() {
        let pool = pool().await;
        CloudSyncOutbox::set_enabled(&pool, true).await.unwrap();
        insert_workspace(&pool).await;
        CloudSyncOutbox::set_enabled(&pool, false).await.unwrap();
        assert_eq!(CloudSyncOutbox::pending(&pool).await.unwrap(), 0);
        assert!(!CloudSyncOutbox::is_enabled(&pool).await.unwrap());

        CloudSyncOutbox::set_enabled(&pool, true).await.unwrap();
        CloudSyncOutbox::enqueue_all(&pool).await.unwrap();
        // workspace + workspace_context for the existing row.
        assert_eq!(CloudSyncOutbox::pending(&pool).await.unwrap(), 2);
    }
}
