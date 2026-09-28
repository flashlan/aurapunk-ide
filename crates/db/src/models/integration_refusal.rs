//! Integration Guard refusals, recorded for the operator (ADR-050).

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, TS)]
pub struct IntegrationRefusal {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub workspace_name: Option<String>,
    pub branch: String,
    pub blocker: String,
    pub message: String,
    pub files: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct Row {
    id: Uuid,
    workspace_id: Uuid,
    workspace_name: Option<String>,
    branch: String,
    blocker: String,
    message: String,
    files_json: String,
    created_at: DateTime<Utc>,
}

impl IntegrationRefusal {
    pub async fn record(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
        blocker: &str,
        message: &str,
        files: &[String],
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO integration_refusals (id, workspace_id, repo_id, blocker, message, files_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4())
        .bind(workspace_id)
        .bind(repo_id)
        .bind(blocker)
        .bind(message)
        .bind(serde_json::to_string(files).unwrap_or_else(|_| "[]".to_string()))
        .bind(Utc::now())
        .execute(pool)
        .await
        .map(|_| ())
    }

    /// Refusals since `since`, newest first.
    pub async fn since(
        pool: &SqlitePool,
        since: DateTime<Utc>,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        let rows = sqlx::query_as::<_, Row>(
            "SELECT r.id, r.workspace_id, w.name AS workspace_name, w.branch, r.blocker, r.message, r.files_json, r.created_at FROM integration_refusals r JOIN workspaces w ON w.id = r.workspace_id WHERE r.created_at >= ? ORDER BY r.created_at DESC LIMIT ?",
        )
        .bind(since)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| Self {
                id: row.id,
                workspace_id: row.workspace_id,
                workspace_name: row.workspace_name,
                branch: row.branch,
                blocker: row.blocker,
                message: row.message,
                files: serde_json::from_str(&row.files_json).unwrap_or_default(),
                created_at: row.created_at,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    #[tokio::test]
    async fn records_and_lists_refusals_newest_first() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let workspace = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES (?, 'vk/x', 'card x')")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        IntegrationRefusal::record(
            &pool,
            workspace,
            Uuid::new_v4(),
            "merge_conflicts",
            "conflict",
            &["a.rs".into()],
        )
        .await
        .unwrap();
        IntegrationRefusal::record(
            &pool,
            workspace,
            Uuid::new_v4(),
            "dirty_worktree",
            "dirty",
            &[],
        )
        .await
        .unwrap();
        let listed = IntegrationRefusal::since(&pool, Utc::now() - chrono::Duration::days(1), 10)
            .await
            .unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].blocker, "dirty_worktree");
        assert_eq!(listed[1].files, vec!["a.rs".to_string()]);
        assert_eq!(listed[0].workspace_name.as_deref(), Some("card x"));
    }
}
