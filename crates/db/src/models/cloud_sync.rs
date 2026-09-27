use std::collections::HashMap;

use sqlx::{FromRow, SqliteConnection, SqlitePool};
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
            // Everything below belongs to the account that was just unlinked.
            for statement in [
                "DELETE FROM cloud_sync_outbox",
                "DELETE FROM cloud_sync_remote",
                "UPDATE cloud_sync_state SET pull_revision = 0 WHERE id = 1",
            ] {
                sqlx::query(statement).execute(&mut *tx).await?;
            }
        }
        tx.commit().await
    }

    /// Switch change capture off inside the caller's transaction and return
    /// the previous state for [`Self::restore_capture`]. Used while writing
    /// rows that came from the Cloud, so they are not published back. SQLite
    /// serializes writers, so no other connection can observe the switch.
    pub async fn suppress_capture(conn: &mut SqliteConnection) -> Result<bool, sqlx::Error> {
        let enabled: Option<i64> =
            sqlx::query_scalar("SELECT enabled FROM cloud_sync_state WHERE id = 1")
                .fetch_optional(&mut *conn)
                .await?;
        sqlx::query("UPDATE cloud_sync_state SET enabled = 0 WHERE id = 1")
            .execute(&mut *conn)
            .await?;
        Ok(enabled == Some(1))
    }

    pub async fn restore_capture(
        conn: &mut SqliteConnection,
        enabled: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE cloud_sync_state SET enabled = $1 WHERE id = 1")
            .bind(i64::from(enabled))
            .execute(conn)
            .await?;
        Ok(())
    }

    /// Queue one entity for publishing (e.g. to republish a local edit that
    /// won a conflict).
    pub async fn enqueue(
        pool: &SqlitePool,
        entity_type: &str,
        entity_id: Uuid,
        aux_id: Option<Uuid>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO cloud_sync_outbox (entity_type, entity_id, aux_id, operation)
             VALUES ($1, $2, $3, 'upsert')",
        )
        .bind(entity_type)
        .bind(entity_id)
        .bind(aux_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Whether this entity has local changes not yet published.
    pub async fn has_pending(
        pool: &SqlitePool,
        entity_type: &str,
        entity_id: Uuid,
        aux_id: Option<Uuid>,
    ) -> Result<bool, sqlx::Error> {
        let found: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM cloud_sync_outbox
             WHERE entity_type = $1 AND entity_id = $2 AND aux_id IS $3 LIMIT 1",
        )
        .bind(entity_type)
        .bind(entity_id)
        .bind(aux_id)
        .fetch_optional(pool)
        .await?;
        Ok(found.is_some())
    }

    /// Cloud revisions last seen for the given `(entity_type, entity_id)`s.
    pub async fn remote_revisions(
        pool: &SqlitePool,
        keys: &[(String, String)],
    ) -> Result<HashMap<(String, String), i64>, sqlx::Error> {
        let mut found = HashMap::new();
        for (entity_type, entity_id) in keys {
            let revision: Option<i64> = sqlx::query_scalar(
                "SELECT revision FROM cloud_sync_remote WHERE entity_type = $1 AND entity_id = $2",
            )
            .bind(entity_type)
            .bind(entity_id)
            .fetch_optional(pool)
            .await?;
            if let Some(revision) = revision {
                found.insert((entity_type.clone(), entity_id.clone()), revision);
            }
        }
        Ok(found)
    }

    /// Remember the Cloud revision of an entity (after publishing or applying
    /// it). Never moves backwards.
    pub async fn record_remote_revision(
        pool: &SqlitePool,
        entity_type: &str,
        entity_id: &str,
        revision: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO cloud_sync_remote (entity_type, entity_id, revision) VALUES ($1, $2, $3)
             ON CONFLICT(entity_type, entity_id)
             DO UPDATE SET revision = MAX(revision, excluded.revision)",
        )
        .bind(entity_type)
        .bind(entity_id)
        .bind(revision)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Forget an entity's Cloud revision (it was deleted remotely).
    pub async fn forget_remote(
        pool: &SqlitePool,
        entity_type: &str,
        entity_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM cloud_sync_remote WHERE entity_type = $1 AND entity_id = $2")
            .bind(entity_type)
            .bind(entity_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn pull_revision(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        let revision: Option<i64> =
            sqlx::query_scalar("SELECT pull_revision FROM cloud_sync_state WHERE id = 1")
                .fetch_optional(pool)
                .await?;
        Ok(revision.unwrap_or(0))
    }

    pub async fn set_pull_revision(pool: &SqlitePool, revision: i64) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE cloud_sync_state SET pull_revision = $1 WHERE id = 1")
            .bind(revision)
            .execute(pool)
            .await?;
        Ok(())
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
    async fn suppressed_capture_skips_cloud_writes_and_restores_state() {
        let pool = pool().await;
        CloudSyncOutbox::set_enabled(&pool, true).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let previous = CloudSyncOutbox::suppress_capture(&mut tx).await.unwrap();
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES (?, 'main', 'remote')")
            .bind(Uuid::new_v4())
            .execute(&mut *tx)
            .await
            .unwrap();
        CloudSyncOutbox::restore_capture(&mut tx, previous)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(CloudSyncOutbox::pending(&pool).await.unwrap(), 0);
        assert!(CloudSyncOutbox::is_enabled(&pool).await.unwrap());
        // A local write afterwards is captured again.
        insert_workspace(&pool).await;
        assert_eq!(CloudSyncOutbox::pending(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn remote_revisions_only_move_forward_and_reset_on_unlink() {
        let pool = pool().await;
        CloudSyncOutbox::set_enabled(&pool, true).await.unwrap();
        CloudSyncOutbox::record_remote_revision(&pool, "issue", "a", 7)
            .await
            .unwrap();
        CloudSyncOutbox::record_remote_revision(&pool, "issue", "a", 5)
            .await
            .unwrap();
        CloudSyncOutbox::set_pull_revision(&pool, 42).await.unwrap();
        let key = ("issue".to_string(), "a".to_string());
        let found = CloudSyncOutbox::remote_revisions(&pool, std::slice::from_ref(&key))
            .await
            .unwrap();
        assert_eq!(found.get(&key), Some(&7));

        CloudSyncOutbox::set_enabled(&pool, false).await.unwrap();
        assert!(
            CloudSyncOutbox::remote_revisions(&pool, &[key])
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(CloudSyncOutbox::pull_revision(&pool).await.unwrap(), 0);
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
