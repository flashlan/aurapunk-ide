use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{SqlitePool, Type};
use ts_rs::TS;
use uuid::Uuid;

use super::pull_request::PullRequest;

#[derive(Debug, Clone, Serialize, Deserialize, TS, Type)]
#[sqlx(type_name = "merge_status", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum MergeStatus {
    Open,
    Merged,
    Closed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Merge {
    Direct(DirectMerge),
    Pr(PrMerge),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DirectMerge {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub repo_id: Uuid,
    pub merge_commit: String,
    pub target_branch_name: String,
    pub created_at: DateTime<Utc>,
}

/// PR merge - represents a pull request merge
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PrMerge {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub repo_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub target_branch_name: String,
    pub pr_info: PullRequestInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PullRequestInfo {
    pub number: i64,
    pub url: String,
    pub status: MergeStatus,
    pub merged_at: Option<chrono::DateTime<chrono::Utc>>,
    pub merge_commit_sha: Option<String>,
}

/// Row type for direct merges only (PR data now lives in pull_requests).
struct DirectMergeRow {
    id: Uuid,
    workspace_id: Uuid,
    repo_id: Uuid,
    merge_commit: Option<String>,
    target_branch_name: String,
    created_at: DateTime<Utc>,
}

impl Merge {
    pub fn merge_commit(&self) -> Option<String> {
        match self {
            Merge::Direct(direct) => Some(direct.merge_commit.clone()),
            Merge::Pr(pr) => pr.pr_info.merge_commit_sha.clone(),
        }
    }

    /// True for a record that actually integrated the work: a direct squash
    /// merge, or a pull request that reached `merged`. An open/closed PR is a
    /// record of an attempt, not of an integration.
    pub fn is_integrated(&self) -> bool {
        matches!(
            self,
            Merge::Direct(_)
                | Merge::Pr(PrMerge {
                    pr_info: PullRequestInfo {
                        status: MergeStatus::Merged,
                        ..
                    },
                    ..
                })
        )
    }

    /// True when `issue_id` has at least one linked workspace and NONE of
    /// them is integrated yet. That is the state in which a terminal (Done)
    /// move must be refused: there is something to merge and it has not been
    /// merged. Issues with no linked workspace have nothing to integrate and
    /// report `false`.
    pub async fn issue_has_unintegrated_workspace(
        pool: &SqlitePool,
        issue_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let workspace_ids = Self::linked_workspace_ids(pool, issue_id).await?;
        if workspace_ids.is_empty() {
            return Ok(false);
        }
        for workspace_id in workspace_ids {
            if Self::find_by_workspace_id(pool, workspace_id)
                .await?
                .iter()
                .any(Self::is_integrated)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// True when at least one workspace linked to `issue_id` has an
    /// integrated merge. Distinct from the negation of
    /// [`Self::issue_has_unintegrated_workspace`]: an issue with NO linked
    /// workspace is not integrated either.
    pub async fn issue_is_integrated(
        pool: &SqlitePool,
        issue_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        for workspace_id in Self::linked_workspace_ids(pool, issue_id).await? {
            if Self::find_by_workspace_id(pool, workspace_id)
                .await?
                .iter()
                .any(Self::is_integrated)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn linked_workspace_ids(
        pool: &SqlitePool,
        issue_id: Uuid,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        Ok(
            super::issue_workspace::IssueWorkspace::list_linked_all(pool)
                .await?
                .into_iter()
                .filter(|link| link.issue_id == issue_id)
                .map(|link| link.workspace_id)
                .collect(),
        )
    }

    /// Create a direct merge record
    pub async fn create_direct(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
        target_branch_name: &str,
        merge_commit: &str,
    ) -> Result<DirectMerge, sqlx::Error> {
        let id = Uuid::new_v4();
        let now = Utc::now();

        sqlx::query!(
            "INSERT INTO merges (id, workspace_id, repo_id, merge_type, merge_commit, created_at, target_branch_name)
            VALUES (?, ?, ?, 'direct', ?, ?, ?)",
            id,
            workspace_id,
            repo_id,
            merge_commit,
            now,
            target_branch_name,
        )
        .execute(pool)
        .await?;

        Ok(DirectMerge {
            id,
            workspace_id,
            repo_id,
            merge_commit: merge_commit.to_string(),
            target_branch_name: target_branch_name.to_string(),
            created_at: now,
        })
    }

    /// Find all merges for a workspace (returns both direct merges and PRs).
    /// Direct merges come from the `merges` table, PRs from `pull_requests`.
    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        let direct_rows = sqlx::query_as!(
            DirectMergeRow,
            r#"SELECT
                id AS "id!: Uuid",
                workspace_id AS "workspace_id!: Uuid",
                repo_id AS "repo_id!: Uuid",
                merge_commit,
                target_branch_name,
                created_at AS "created_at!: DateTime<Utc>"
            FROM merges
            WHERE workspace_id = ? AND merge_type = 'direct'
            ORDER BY created_at DESC"#,
            workspace_id,
        )
        .fetch_all(pool)
        .await?;

        let pull_requests = PullRequest::find_by_workspace_id(pool, workspace_id).await?;

        let mut merges: Vec<Merge> = direct_rows.into_iter().map(|row| row.into()).collect();
        merges.extend(pull_requests.iter().map(|pr| pr.to_merge()));

        // Sort by created_at descending (matching previous behavior)
        merges.sort_by(|a, b| {
            let a_time = match a {
                Merge::Direct(d) => d.created_at,
                Merge::Pr(p) => p.created_at,
            };
            let b_time = match b {
                Merge::Direct(d) => d.created_at,
                Merge::Pr(p) => p.created_at,
            };
            b_time.cmp(&a_time)
        });

        Ok(merges)
    }

    /// Find all merges for a workspace and specific repo
    pub async fn find_by_workspace_and_repo_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        let direct_rows = sqlx::query_as!(
            DirectMergeRow,
            r#"SELECT
                id AS "id!: Uuid",
                workspace_id AS "workspace_id!: Uuid",
                repo_id AS "repo_id!: Uuid",
                merge_commit,
                target_branch_name,
                created_at AS "created_at!: DateTime<Utc>"
            FROM merges
            WHERE workspace_id = ? AND repo_id = ? AND merge_type = 'direct'
            ORDER BY created_at DESC"#,
            workspace_id,
            repo_id,
        )
        .fetch_all(pool)
        .await?;

        let pull_requests =
            PullRequest::find_by_workspace_and_repo_id(pool, workspace_id, repo_id).await?;

        let mut merges: Vec<Merge> = direct_rows.into_iter().map(|row| row.into()).collect();
        merges.extend(pull_requests.iter().map(|pr| pr.to_merge()));

        merges.sort_by(|a, b| {
            let a_time = match a {
                Merge::Direct(d) => d.created_at,
                Merge::Pr(p) => p.created_at,
            };
            let b_time = match b {
                Merge::Direct(d) => d.created_at,
                Merge::Pr(p) => p.created_at,
            };
            b_time.cmp(&a_time)
        });

        Ok(merges)
    }
}

impl From<DirectMergeRow> for DirectMerge {
    fn from(row: DirectMergeRow) -> Self {
        DirectMerge {
            id: row.id,
            workspace_id: row.workspace_id,
            repo_id: row.repo_id,
            merge_commit: row
                .merge_commit
                .expect("direct merge must have merge_commit"),
            target_branch_name: row.target_branch_name,
            created_at: row.created_at,
        }
    }
}

impl From<DirectMergeRow> for Merge {
    fn from(row: DirectMergeRow) -> Self {
        Merge::Direct(DirectMerge::from(row))
    }
}
