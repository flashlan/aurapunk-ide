use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

/// Audit record for an operator-controlled Quick checkout decision.
#[derive(Debug, Clone, Serialize, FromRow, TS)]
pub struct QuickGitDecision {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub issue_id: Option<Uuid>,
    pub repo_id: Uuid,
    pub target_branch: String,
    pub checkpoint_sha: String,
    pub head_sha: Option<String>,
    pub action: String,
    pub status: String,
    pub result_sha: Option<String>,
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
}

impl QuickGitDecision {
    pub async fn create(
        pool: &SqlitePool,
        workspace_id: Uuid,
        issue_id: Option<Uuid>,
        repo_id: Uuid,
        target_branch: &str,
        checkpoint_sha: &str,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as(
            "INSERT INTO quick_git_decisions \
             (id, workspace_id, issue_id, repo_id, target_branch, checkpoint_sha, action, status) \
             VALUES (?, ?, ?, ?, ?, ?, 'awaiting_operator', 'pending') \
             RETURNING *",
        )
        .bind(Uuid::new_v4())
        .bind(workspace_id)
        .bind(issue_id)
        .bind(repo_id)
        .bind(target_branch)
        .bind(checkpoint_sha)
        .fetch_one(pool)
        .await
    }

    pub async fn pending(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as(
            "SELECT * FROM quick_git_decisions WHERE status = 'pending' ORDER BY created_at DESC",
        )
        .fetch_all(pool)
        .await
    }

    /// Friendly preflight for the unique active-checkout database constraint.
    pub async fn has_active_checkout(
        pool: &SqlitePool,
        repo_id: Uuid,
        target_branch: &str,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM quick_git_decisions \
             WHERE repo_id = ? AND target_branch = ? AND status IN ('pending', 'delegated'))",
        )
        .bind(repo_id)
        .bind(target_branch)
        .fetch_one(pool)
        .await
    }

    /// Most recent operator decisions, including pending decisions, for the
    /// Agent Activity audit trail. This is intentionally bounded: the full
    /// Git history remains the source of truth for older work.
    pub async fn recent(pool: &SqlitePool, limit: i64) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM quick_git_decisions ORDER BY created_at DESC LIMIT ?")
            .bind(limit)
            .fetch_all(pool)
            .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM quick_git_decisions WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    pub async fn resolve(
        pool: &SqlitePool,
        id: Uuid,
        action: &str,
        status: &str,
        result_sha: Option<&str>,
        detail: Option<&str>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as(
            "UPDATE quick_git_decisions \
             SET action = ?, status = ?, result_sha = ?, detail = ?, decided_at = datetime('now', 'subsec') \
             WHERE id = ? RETURNING *",
        )
        .bind(action)
        .bind(status)
        .bind(result_sha)
        .bind(detail)
        .bind(id)
        .fetch_one(pool)
        .await
    }

    /// Persist the exact HEAD seen when the Quick execution finished. Revert
    /// requests must compare against this value, so a later foreign commit
    /// blocks automation instead of being reverted accidentally.
    pub async fn record_completion_head(
        pool: &SqlitePool,
        workspace_id: Uuid,
        head_sha: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE quick_git_decisions SET head_sha = ? \
             WHERE workspace_id = ? AND status = 'pending'",
        )
        .bind(head_sha)
        .bind(workspace_id)
        .execute(pool)
        .await
        .map(|_| ())
    }
}
