use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

/// A merge waiting for the Integration Guard (ADR-050).
///
/// Uses dynamic queries (no compile-time DB needed).
#[derive(Debug, Clone, Serialize, FromRow, TS)]
pub struct IntegrationRequest {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub repo_id: Uuid,
    pub commit_sha: String,
    pub result_sha: Option<String>,
    pub mode: String,
    pub status: String,
    pub blocker: Option<String>,
    pub message: Option<String>,
    pub attempts: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const COLUMNS: &str = "id, workspace_id, repo_id, commit_sha, result_sha, mode, status, blocker, \
                       message, attempts, created_at, updated_at";

impl IntegrationRequest {
    /// Queue `commit_sha` for integration. A still-queued request for the same
    /// workspace and repository is replaced (newest commit and mode win), so
    /// an agent re-asking never piles up duplicates.
    pub async fn enqueue(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
        commit_sha: &str,
        mode: &str,
        blocker: Option<&str>,
    ) -> Result<Self, sqlx::Error> {
        let mut tx = pool.begin().await?;
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM integration_requests
             WHERE workspace_id = $1 AND repo_id = $2 AND status = 'queued'
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(workspace_id)
        .bind(repo_id)
        .fetch_optional(&mut *tx)
        .await?;
        let id = match existing {
            Some(id) => {
                sqlx::query(
                    "UPDATE integration_requests
                     SET commit_sha = $2, mode = $3, blocker = $4,
                         updated_at = datetime('now', 'subsec')
                     WHERE id = $1",
                )
                .bind(id)
                .bind(commit_sha)
                .bind(mode)
                .bind(blocker)
                .execute(&mut *tx)
                .await?;
                id
            }
            None => {
                let id = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO integration_requests
                         (id, workspace_id, repo_id, commit_sha, mode, blocker)
                     VALUES ($1, $2, $3, $4, $5, $6)",
                )
                .bind(id)
                .bind(workspace_id)
                .bind(repo_id)
                .bind(commit_sha)
                .bind(mode)
                .bind(blocker)
                .execute(&mut *tx)
                .await?;
                id
            }
        };
        let request = sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM integration_requests WHERE id = $1"
        ))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(request)
    }

    /// Queued requests, oldest first (per-repository FIFO).
    pub async fn queued(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM integration_requests
             WHERE status = 'queued' ORDER BY created_at, id"
        ))
        .fetch_all(pool)
        .await
    }

    /// 1-based position of a queued request among those for its repository.
    pub async fn position(pool: &SqlitePool, request: &Self) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM integration_requests
             WHERE status = 'queued' AND repo_id = $1
               AND (created_at < $2 OR (created_at = $2 AND id <= $3))",
        )
        .bind(request.repo_id)
        .bind(request.created_at)
        .bind(request.id)
        .fetch_one(pool)
        .await
    }

    /// Latest request for a workspace and repository, whatever its status.
    pub async fn latest(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM integration_requests
             WHERE workspace_id = $1 AND repo_id = $2
             ORDER BY created_at DESC, updated_at DESC LIMIT 1"
        ))
        .bind(workspace_id)
        .bind(repo_id)
        .fetch_optional(pool)
        .await
    }

    /// Record an attempt that is still blocked by a transient blocker.
    pub async fn still_blocked(
        pool: &SqlitePool,
        id: Uuid,
        blocker: &str,
        message: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE integration_requests
             SET blocker = $2, message = $3, attempts = attempts + 1,
                 updated_at = datetime('now', 'subsec')
             WHERE id = $1 AND status = 'queued'",
        )
        .bind(id)
        .bind(blocker)
        .bind(message)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Record a successful integration and the branch head it left behind.
    pub async fn merged(pool: &SqlitePool, id: Uuid, result_sha: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE integration_requests
             SET status = 'merged', result_sha = $2, blocker = NULL, message = NULL,
                 attempts = attempts + 1, updated_at = datetime('now', 'subsec')
             WHERE id = $1",
        )
        .bind(id)
        .bind(result_sha)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Whether the request integrated the branch at `head` (the queued commit,
    /// or the head the merge left the branch at).
    pub fn integrated(&self, head: &str) -> bool {
        self.status == "merged"
            && (self.commit_sha == head || self.result_sha.as_deref() == Some(head))
    }

    /// Close a request: `merged`, `failed` (a blocker the agent must resolve)
    /// or `superseded` (the branch moved after the request).
    pub async fn finish(
        pool: &SqlitePool,
        id: Uuid,
        status: &str,
        blocker: Option<&str>,
        message: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE integration_requests
             SET status = $2, blocker = $3, message = $4, attempts = attempts + 1,
                 updated_at = datetime('now', 'subsec')
             WHERE id = $1",
        )
        .bind(id)
        .bind(status)
        .bind(blocker)
        .bind(message)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn pool_with_workspace() -> (SqlitePool, Uuid) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES (?, 'vk/x', 't')")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        (pool, id)
    }

    #[tokio::test]
    async fn re_enqueue_replaces_the_queued_request() {
        let (pool, workspace) = pool_with_workspace().await;
        let repo = Uuid::new_v4();
        let first = IntegrationRequest::enqueue(&pool, workspace, repo, "aaa", "merge", None)
            .await
            .unwrap();
        let second = IntegrationRequest::enqueue(
            &pool,
            workspace,
            repo,
            "bbb",
            "complete",
            Some("integration_in_progress"),
        )
        .await
        .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.commit_sha, "bbb");
        assert_eq!(second.mode, "complete");
        assert_eq!(IntegrationRequest::queued(&pool).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn finished_requests_leave_the_queue_and_positions_are_per_repo() {
        let (pool, workspace) = pool_with_workspace().await;
        let (repo_a, repo_b) = (Uuid::new_v4(), Uuid::new_v4());
        let a = IntegrationRequest::enqueue(&pool, workspace, repo_a, "a", "merge", None)
            .await
            .unwrap();
        let b = IntegrationRequest::enqueue(&pool, workspace, repo_b, "b", "merge", None)
            .await
            .unwrap();
        assert_eq!(IntegrationRequest::position(&pool, &a).await.unwrap(), 1);
        assert_eq!(IntegrationRequest::position(&pool, &b).await.unwrap(), 1);

        IntegrationRequest::still_blocked(&pool, a.id, "agent_work_conflict", Some("overlap"))
            .await
            .unwrap();
        IntegrationRequest::merged(&pool, a.id, "a-merged")
            .await
            .unwrap();
        let queued = IntegrationRequest::queued(&pool).await.unwrap();
        assert_eq!(queued.iter().map(|r| r.id).collect::<Vec<_>>(), vec![b.id]);
        let latest = IntegrationRequest::latest(&pool, workspace, repo_a)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((latest.status.as_str(), latest.attempts), ("merged", 2));
        assert!(latest.integrated("a") && latest.integrated("a-merged") && !latest.integrated("x"));
        // A new request after a merged one starts a fresh entry.
        let again = IntegrationRequest::enqueue(&pool, workspace, repo_a, "c", "merge", None)
            .await
            .unwrap();
        assert_ne!(again.id, a.id);
    }
}
