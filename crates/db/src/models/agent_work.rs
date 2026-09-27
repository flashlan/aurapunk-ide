use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

/// A declaration is intentionally short-lived. If an agent disappears
/// without releasing its work, the panel should eventually stop presenting it
/// as active and another agent should be able to continue.
pub const AGENT_WORK_LEASE_SECONDS: i64 = 10 * 60;

/// Owner of the reservation a workspace holds while its agent resolves merge
/// conflicts on its branch (ADR-050 §5). Other workspaces whose merge touches
/// the reserved files are refused as `agent_work_conflict` and wait in the
/// integration queue, so the target cannot move under the resolution again.
pub const CONFLICT_RESOLUTION_OWNER: Uuid =
    Uuid::from_u128(0x6d65_7267_655f_7265_736f_6c76_6500_0001);
pub const CONFLICT_RESOLUTION_AGENT: &str = "merge-resolution";
/// Long enough for an agent to merge the target, resolve and re-run checks;
/// short enough that an abandoned resolution never blocks the repository for
/// long. Every conflicting retry renews it; a successful merge releases it.
pub const CONFLICT_RESOLUTION_LEASE_SECONDS: i64 = 30 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentWorkDeclaration {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub owner_id: Uuid,
    pub execution_process_id: Option<Uuid>,
    pub agent_name: String,
    pub intent: String,
    pub files: Vec<String>,
    pub symbols: Vec<String>,
    pub dependencies: Vec<String>,
    pub lease_expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentWorkConflict {
    pub workspace_id: Uuid,
    pub owner_id: Uuid,
    pub agent_name: String,
    pub intent: String,
    pub files: Vec<String>,
    pub symbols: Vec<String>,
    pub dependencies: Vec<String>,
    pub conflict_type: String,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentWorkDeclarationResult {
    pub declaration: AgentWorkDeclaration,
    pub conflicts: Vec<AgentWorkConflict>,
}

/// Unified activity row used by the UI. A row can represent a genuinely
/// running coding-agent process, a declaration waiting for its process to
/// start, or a running process that missed the mandatory declaration hook.
/// The latter is intentionally visible so the panel exposes coordination
/// gaps instead of silently reporting zero activity.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentActivity {
    pub declaration_id: Option<Uuid>,
    pub workspace_id: Uuid,
    pub session_id: Option<Uuid>,
    pub execution_process_id: Option<Uuid>,
    pub owner_id: Option<Uuid>,
    pub agent_name: String,
    pub intent: String,
    pub files: Vec<String>,
    pub symbols: Vec<String>,
    pub dependencies: Vec<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub is_running: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeclareAgentWork {
    pub workspace_id: Uuid,
    pub owner_id: Uuid,
    pub execution_process_id: Option<Uuid>,
    pub agent_name: String,
    pub intent: String,
    pub files: Vec<String>,
    pub symbols: Vec<String>,
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, FromRow)]
struct AgentWorkRow {
    id: Uuid,
    workspace_id: Uuid,
    owner_id: Uuid,
    execution_process_id: Option<Uuid>,
    agent_name: String,
    intent: String,
    files_json: String,
    symbols_json: String,
    dependencies_json: String,
    lease_expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
struct RunningAgentRow {
    execution_process_id: Uuid,
    session_id: Uuid,
    workspace_id: Uuid,
    executor: Option<String>,
    started_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl AgentWorkRow {
    fn into_declaration(self) -> AgentWorkDeclaration {
        AgentWorkDeclaration {
            id: self.id,
            workspace_id: self.workspace_id,
            owner_id: self.owner_id,
            execution_process_id: self.execution_process_id,
            agent_name: self.agent_name,
            intent: self.intent,
            files: serde_json::from_str(&self.files_json).unwrap_or_default(),
            symbols: serde_json::from_str(&self.symbols_json).unwrap_or_default(),
            dependencies: serde_json::from_str(&self.dependencies_json).unwrap_or_default(),
            lease_expires_at: self.lease_expires_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

impl AgentWorkDeclaration {
    pub async fn list_activity_for_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<AgentActivity>, sqlx::Error> {
        let declarations = Self::list_active(pool, workspace_id).await?;
        let running = sqlx::query_as::<_, RunningAgentRow>(
            "SELECT ep.id AS execution_process_id, ep.session_id, s.workspace_id, s.executor, ep.started_at, ep.updated_at FROM execution_processes ep JOIN sessions s ON s.id = ep.session_id WHERE s.workspace_id = ? AND ep.status = 'running' AND ep.run_reason = 'codingagent' AND ep.dropped = FALSE ORDER BY ep.created_at DESC",
        )
        .bind(workspace_id)
        .fetch_all(pool)
        .await?;

        Ok(build_activity(declarations, running))
    }

    pub async fn list_activity_for_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<AgentActivity>, sqlx::Error> {
        let declarations = Self::list_active_for_project(pool, project_id).await?;
        let running = sqlx::query_as::<_, RunningAgentRow>(
            "SELECT ep.id AS execution_process_id, ep.session_id, s.workspace_id, s.executor, ep.started_at, ep.updated_at FROM execution_processes ep JOIN sessions s ON s.id = ep.session_id WHERE ep.status = 'running' AND ep.run_reason = 'codingagent' AND ep.dropped = FALSE AND (EXISTS (SELECT 1 FROM workspace_repos wr JOIN project_repos pr ON pr.repo_id = wr.repo_id WHERE wr.workspace_id = s.workspace_id AND pr.project_id = ?) OR EXISTS (SELECT 1 FROM issue_workspaces iw JOIN issues i ON i.id = iw.issue_id WHERE iw.workspace_id = s.workspace_id AND i.project_id = ?)) ORDER BY ep.created_at DESC",
        )
        .bind(project_id)
        .bind(project_id)
        .fetch_all(pool)
        .await?;

        Ok(build_activity(declarations, running))
    }

    pub async fn declare(
        pool: &SqlitePool,
        input: &DeclareAgentWork,
    ) -> Result<AgentWorkDeclarationResult, sqlx::Error> {
        Self::upsert(pool, input, AGENT_WORK_LEASE_SECONDS).await
    }

    /// Reserve `files` for the workspace's own conflict resolution against
    /// `target_branch` (renewing an existing reservation). See
    /// [`CONFLICT_RESOLUTION_OWNER`].
    pub async fn reserve_for_conflict_resolution(
        pool: &SqlitePool,
        workspace_id: Uuid,
        target_branch: &str,
        files: Vec<String>,
    ) -> Result<AgentWorkDeclaration, sqlx::Error> {
        let input = DeclareAgentWork {
            workspace_id,
            owner_id: CONFLICT_RESOLUTION_OWNER,
            execution_process_id: None,
            agent_name: CONFLICT_RESOLUTION_AGENT.to_string(),
            intent: format!(
                "Resolving merge conflicts with '{target_branch}' on its branch; merges touching these files wait in the integration queue until it lands"
            ),
            files,
            symbols: Vec::new(),
            dependencies: Vec::new(),
        };
        Ok(
            Self::upsert(pool, &input, CONFLICT_RESOLUTION_LEASE_SECONDS)
                .await?
                .declaration,
        )
    }

    /// Keep conflict reservations tied to real work: renew the ones whose
    /// workspace still has a coding agent running (a long resolution must not
    /// lapse mid-way) and release the ones whose workspace was archived.
    /// Anything else simply expires with its lease.
    pub async fn maintain_conflict_reservations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE agent_work_declarations SET status = 'released', updated_at = ?, lease_expires_at = ? WHERE owner_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = agent_work_declarations.workspace_id AND w.archived = 1)",
        )
        .bind(now)
        .bind(now)
        .bind(CONFLICT_RESOLUTION_OWNER)
        .execute(pool)
        .await?;
        sqlx::query(
            "UPDATE agent_work_declarations SET lease_expires_at = ?, updated_at = ? WHERE owner_id = ? AND status = 'active' AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM execution_processes ep JOIN sessions s ON s.id = ep.session_id WHERE s.workspace_id = agent_work_declarations.workspace_id AND ep.status = 'running' AND ep.run_reason = 'codingagent' AND ep.dropped = FALSE)",
        )
        .bind(now + Duration::seconds(CONFLICT_RESOLUTION_LEASE_SECONDS))
        .bind(now)
        .bind(CONFLICT_RESOLUTION_OWNER)
        .bind(now)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Whether `other`'s declaration may block a merge from a workspace whose
    /// own conflict reservation (if any) started at `own_reservation`.
    ///
    /// Deadlock-free ordering among many parallel agents:
    /// - conflict reservations are served first-come first-served: an older
    ///   reservation blocks, a younger one never does;
    /// - a workspace holding a reservation is already first in line for its
    ///   files, so ordinary (advisory) declarations do not block it — that
    ///   would let an agent that is itself waiting on the reservation block
    ///   it back.
    pub fn blocks_merge(
        other: &AgentWorkDeclaration,
        own_reservation: Option<DateTime<Utc>>,
    ) -> bool {
        match (other.owner_id == CONFLICT_RESOLUTION_OWNER, own_reservation) {
            (true, Some(own)) => other.created_at < own,
            (true, None) => true,
            (false, Some(_)) => false,
            (false, None) => true,
        }
    }

    async fn upsert(
        pool: &SqlitePool,
        input: &DeclareAgentWork,
        lease_seconds: i64,
    ) -> Result<AgentWorkDeclarationResult, sqlx::Error> {
        let now = Utc::now();
        let lease_expires_at = now + Duration::seconds(lease_seconds);
        let agent_name = input.agent_name.trim();
        let intent = input.intent.trim();

        if agent_name.is_empty() || intent.is_empty() {
            return Err(sqlx::Error::Protocol(
                "agent_name and intent must not be empty".to_string(),
            ));
        }

        Self::remove_expired(pool, now).await?;
        let existing = Self::list_active(pool, input.workspace_id).await?;
        let conflicts = existing
            .iter()
            .filter(|other| other.owner_id != input.owner_id)
            // The workspace's own conflict reservation is not a rival agent.
            .filter(|other| other.owner_id != CONFLICT_RESOLUTION_OWNER)
            .filter_map(|other| Self::conflict(other, input))
            .collect();

        let files_json = serde_json::to_string(&input.files)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        let symbols_json = serde_json::to_string(&input.symbols)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        let dependencies_json = serde_json::to_string(&input.dependencies)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;

        sqlx::query(
            r#"INSERT INTO agent_work_declarations (
                    id, workspace_id, owner_id, execution_process_id,
                    agent_name, intent, files_json, symbols_json, dependencies_json,
                    status, lease_expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
                ON CONFLICT (workspace_id, owner_id) DO UPDATE SET
                    execution_process_id = excluded.execution_process_id,
                    agent_name = excluded.agent_name,
                    intent = excluded.intent,
                    files_json = excluded.files_json,
                    symbols_json = excluded.symbols_json,
                    dependencies_json = excluded.dependencies_json,
                    status = 'active',
                    lease_expires_at = excluded.lease_expires_at,
                    updated_at = excluded.updated_at"#,
        )
        .bind(Uuid::new_v4())
        .bind(input.workspace_id)
        .bind(input.owner_id)
        .bind(input.execution_process_id)
        .bind(agent_name)
        .bind(intent)
        .bind(files_json)
        .bind(symbols_json)
        .bind(dependencies_json)
        .bind(lease_expires_at)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        let declaration = sqlx::query_as::<_, AgentWorkRow>(
            "SELECT id, workspace_id, owner_id, execution_process_id, agent_name, intent, files_json, symbols_json, dependencies_json, lease_expires_at, created_at, updated_at FROM agent_work_declarations WHERE workspace_id = ? AND owner_id = ?",
        )
        .bind(input.workspace_id)
        .bind(input.owner_id)
        .fetch_one(pool)
        .await?
        .into_declaration();

        Ok(AgentWorkDeclarationResult {
            declaration,
            conflicts,
        })
    }

    pub async fn heartbeat(
        pool: &SqlitePool,
        workspace_id: Uuid,
        owner_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        let now = Utc::now();
        let lease_expires_at = now + Duration::seconds(AGENT_WORK_LEASE_SECONDS);
        Self::remove_expired(pool, now).await?;
        sqlx::query(
            "UPDATE agent_work_declarations SET lease_expires_at = ?, updated_at = ? WHERE workspace_id = ? AND owner_id = ? AND status = 'active'",
        )
        .bind(lease_expires_at)
        .bind(now)
        .bind(workspace_id)
        .bind(owner_id)
        .execute(pool)
        .await?;

        sqlx::query_as::<_, AgentWorkRow>(
            "SELECT id, workspace_id, owner_id, execution_process_id, agent_name, intent, files_json, symbols_json, dependencies_json, lease_expires_at, created_at, updated_at FROM agent_work_declarations WHERE workspace_id = ? AND owner_id = ? AND status = 'active'",
        )
        .bind(workspace_id)
        .bind(owner_id)
        .fetch_optional(pool)
        .await
        .map(|row| row.map(AgentWorkRow::into_declaration))
    }

    pub async fn release(
        pool: &SqlitePool,
        workspace_id: Uuid,
        owner_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE agent_work_declarations SET status = 'released', updated_at = ?, lease_expires_at = ? WHERE workspace_id = ? AND owner_id = ? AND status = 'active'",
        )
        .bind(Utc::now())
        .bind(Utc::now())
        .bind(workspace_id)
        .bind(owner_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_active(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<AgentWorkDeclaration>, sqlx::Error> {
        let now = Utc::now();
        Self::remove_expired(pool, now).await?;
        sqlx::query_as::<_, AgentWorkRow>(
            "SELECT id, workspace_id, owner_id, execution_process_id, agent_name, intent, files_json, symbols_json, dependencies_json, lease_expires_at, created_at, updated_at FROM agent_work_declarations WHERE workspace_id = ? AND status = 'active' AND lease_expires_at > ? ORDER BY updated_at DESC",
        )
        .bind(workspace_id)
        .bind(now)
        .fetch_all(pool)
        .await
        .map(|rows| rows.into_iter().map(AgentWorkRow::into_declaration).collect())
    }

    pub async fn list_active_for_repo(
        pool: &SqlitePool,
        repo_id: Uuid,
    ) -> Result<Vec<AgentWorkDeclaration>, sqlx::Error> {
        let now = Utc::now();
        Self::remove_expired(pool, now).await?;
        sqlx::query_as::<_, AgentWorkRow>(
            "SELECT awd.id, awd.workspace_id, awd.owner_id, awd.execution_process_id, awd.agent_name, awd.intent, awd.files_json, awd.symbols_json, awd.dependencies_json, awd.lease_expires_at, awd.created_at, awd.updated_at FROM agent_work_declarations awd JOIN workspace_repos wr ON wr.workspace_id = awd.workspace_id WHERE wr.repo_id = ? AND awd.status = 'active' AND awd.lease_expires_at > ? ORDER BY awd.updated_at DESC",
        )
        .bind(repo_id)
        .bind(now)
        .fetch_all(pool)
        .await
            .map(|rows| rows.into_iter().map(AgentWorkRow::into_declaration).collect())
    }

    pub async fn list_active_for_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<AgentWorkDeclaration>, sqlx::Error> {
        let now = Utc::now();
        Self::remove_expired(pool, now).await?;
        sqlx::query_as::<_, AgentWorkRow>(
            "SELECT awd.id, awd.workspace_id, awd.owner_id, awd.execution_process_id, awd.agent_name, awd.intent, awd.files_json, awd.symbols_json, awd.dependencies_json, awd.lease_expires_at, awd.created_at, awd.updated_at FROM agent_work_declarations awd WHERE awd.status = 'active' AND awd.lease_expires_at > ? AND (EXISTS (SELECT 1 FROM workspace_repos wr JOIN project_repos pr ON pr.repo_id = wr.repo_id WHERE wr.workspace_id = awd.workspace_id AND pr.project_id = ?) OR EXISTS (SELECT 1 FROM issue_workspaces iw JOIN issues i ON i.id = iw.issue_id WHERE iw.workspace_id = awd.workspace_id AND i.project_id = ?)) ORDER BY awd.updated_at DESC",
        )
        .bind(now)
        .bind(project_id)
        .bind(project_id)
        .fetch_all(pool)
        .await
        .map(|rows| rows.into_iter().map(AgentWorkRow::into_declaration).collect())
    }

    pub async fn release_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE agent_work_declarations SET status = 'released', updated_at = ?, lease_expires_at = ? WHERE workspace_id = ? AND status = 'active'",
        )
        .bind(Utc::now())
        .bind(Utc::now())
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    async fn remove_expired(pool: &SqlitePool, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM agent_work_declarations WHERE status = 'released' OR lease_expires_at <= ? OR (execution_process_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM execution_processes ep WHERE ep.id = agent_work_declarations.execution_process_id AND ep.status = 'running'))",
        )
        .bind(now)
        .execute(pool)
        .await
        .map(|_| ())
    }

    fn conflict(
        other: &AgentWorkDeclaration,
        input: &DeclareAgentWork,
    ) -> Option<AgentWorkConflict> {
        Self::conflict_with_scope(other, &input.files, &input.symbols, &input.dependencies)
    }

    pub fn conflict_with_scope(
        other: &AgentWorkDeclaration,
        files: &[String],
        symbols: &[String],
        dependencies: &[String],
    ) -> Option<AgentWorkConflict> {
        let file_overlap = lists_overlap(&other.files, files, path_overlaps);
        let symbol_overlap = lists_overlap(&other.symbols, symbols, symbols_overlap);
        let semantic_overlap = lists_overlap(&other.symbols, dependencies, symbols_overlap)
            || lists_overlap(&other.dependencies, symbols, symbols_overlap);

        if !file_overlap && !symbol_overlap && !semantic_overlap {
            return None;
        }

        let conflict_type = match (file_overlap, symbol_overlap, semantic_overlap) {
            (true, true, true) => "file_and_symbol_and_semantic",
            (true, true, false) => "file_and_symbol",
            (true, false, true) => "file_and_semantic",
            (true, false, false) => "file",
            (false, true, true) => "symbol_and_semantic",
            (false, true, false) => "symbol",
            (false, false, true) => "semantic",
            (false, false, false) => return None,
        };

        Some(AgentWorkConflict {
            workspace_id: other.workspace_id,
            owner_id: other.owner_id,
            agent_name: other.agent_name.clone(),
            intent: other.intent.clone(),
            files: other.files.clone(),
            symbols: other.symbols.clone(),
            dependencies: other.dependencies.clone(),
            conflict_type: conflict_type.to_string(),
            lease_expires_at: other.lease_expires_at,
        })
    }
}

fn build_activity(
    declarations: Vec<AgentWorkDeclaration>,
    running: Vec<RunningAgentRow>,
) -> Vec<AgentActivity> {
    let declarations_by_process: HashMap<Uuid, AgentWorkDeclaration> = declarations
        .iter()
        .filter_map(|declaration| {
            declaration
                .execution_process_id
                .map(|process_id| (process_id, declaration.clone()))
        })
        .collect();
    let mut matched_declarations = HashSet::new();
    let mut activity = Vec::with_capacity(running.len() + declarations.len());

    for process in running {
        if let Some(declaration) = declarations_by_process.get(&process.execution_process_id) {
            matched_declarations.insert(declaration.id);
            activity.push(AgentActivity {
                declaration_id: Some(declaration.id),
                workspace_id: process.workspace_id,
                session_id: Some(process.session_id),
                execution_process_id: Some(process.execution_process_id),
                owner_id: Some(declaration.owner_id),
                agent_name: declaration.agent_name.clone(),
                intent: declaration.intent.clone(),
                files: declaration.files.clone(),
                symbols: declaration.symbols.clone(),
                dependencies: declaration.dependencies.clone(),
                lease_expires_at: Some(declaration.lease_expires_at),
                is_running: true,
                started_at: Some(process.started_at),
                updated_at: process.updated_at,
            });
        } else {
            activity.push(AgentActivity {
                declaration_id: None,
                workspace_id: process.workspace_id,
                session_id: Some(process.session_id),
                execution_process_id: Some(process.execution_process_id),
                owner_id: None,
                agent_name: process
                    .executor
                    .filter(|executor| !executor.trim().is_empty())
                    .unwrap_or_else(|| "Coding agent".to_string()),
                intent: "Running without a work declaration".to_string(),
                files: vec![],
                symbols: vec![],
                dependencies: vec![],
                lease_expires_at: None,
                is_running: true,
                started_at: Some(process.started_at),
                updated_at: process.updated_at,
            });
        }
    }

    for declaration in declarations {
        if matched_declarations.contains(&declaration.id) {
            continue;
        }
        activity.push(AgentActivity {
            declaration_id: Some(declaration.id),
            workspace_id: declaration.workspace_id,
            session_id: None,
            execution_process_id: declaration.execution_process_id,
            owner_id: Some(declaration.owner_id),
            agent_name: declaration.agent_name,
            intent: declaration.intent,
            files: declaration.files,
            symbols: declaration.symbols,
            dependencies: declaration.dependencies,
            lease_expires_at: Some(declaration.lease_expires_at),
            is_running: false,
            started_at: None,
            updated_at: declaration.updated_at,
        });
    }

    activity.sort_by(|left, right| {
        right
            .is_running
            .cmp(&left.is_running)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    activity
}

fn lists_overlap<F>(left: &[String], right: &[String], overlaps: F) -> bool
where
    F: Fn(&str, &str) -> bool + Copy,
{
    left.iter()
        .any(|a| right.iter().any(|b| overlaps(a.trim(), b.trim())))
}

fn path_overlaps(left: &str, right: &str) -> bool {
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    if let Some(prefix) = left.strip_suffix('*')
        && right.starts_with(prefix)
    {
        return true;
    }
    if let Some(prefix) = right.strip_suffix('*')
        && left.starts_with(prefix)
    {
        return true;
    }
    right.starts_with(&format!("{left}/")) || left.starts_with(&format!("{right}/"))
}

fn symbols_overlap(left: &str, right: &str) -> bool {
    if left.is_empty() || right.is_empty() || left == right {
        return !left.is_empty() && left == right;
    }
    left.starts_with(&format!("{right}::")) || right.starts_with(&format!("{left}::"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn workspace(pool: &SqlitePool) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES (?, 'main', 'test')")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        id
    }

    async fn repo_for_workspaces(pool: &SqlitePool, workspace_ids: &[Uuid]) -> Uuid {
        let repo_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO repos (id, path, name, display_name) VALUES (?, '/tmp/test-repo', 'test-repo', 'test-repo')",
        )
        .bind(repo_id)
        .execute(pool)
        .await
        .unwrap();
        for workspace_id in workspace_ids {
            sqlx::query(
                "INSERT INTO workspace_repos (id, workspace_id, repo_id, target_branch) VALUES (?, ?, ?, 'main')",
            )
            .bind(Uuid::new_v4())
            .bind(workspace_id)
            .bind(repo_id)
            .execute(pool)
            .await
            .unwrap();
        }
        repo_id
    }

    fn declaration_input(workspace_id: Uuid, owner_id: Uuid) -> DeclareAgentWork {
        DeclareAgentWork {
            workspace_id,
            owner_id,
            execution_process_id: None,
            agent_name: "agent-a".to_string(),
            intent: "Update merge coordination".to_string(),
            files: vec!["crates/git/src/lib.rs".to_string()],
            symbols: vec!["merge_changes".to_string()],
            dependencies: vec![],
        }
    }

    #[tokio::test]
    async fn declaration_reports_file_and_symbol_overlap_without_blocking() {
        let pool = pool().await;
        let workspace_id = workspace(&pool).await;
        let first = declaration_input(workspace_id, Uuid::new_v4());
        AgentWorkDeclaration::declare(&pool, &first).await.unwrap();

        let mut second = declaration_input(workspace_id, Uuid::new_v4());
        second.agent_name = "agent-b".to_string();
        second.intent = "Refactor the same merge path".to_string();
        let result = AgentWorkDeclaration::declare(&pool, &second).await.unwrap();

        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].conflict_type, "file_and_symbol");
        assert_eq!(
            AgentWorkDeclaration::list_active(&pool, workspace_id)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn conflict_reservation_blocks_other_workspaces_until_released() {
        let pool = pool().await;
        let resolving = workspace(&pool).await;
        let other = workspace(&pool).await;
        let repo_id = repo_for_workspaces(&pool, &[resolving, other]).await;

        let reservation = AgentWorkDeclaration::reserve_for_conflict_resolution(
            &pool,
            resolving,
            "main",
            vec!["crates/git/src/lib.rs".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(reservation.agent_name, CONFLICT_RESOLUTION_AGENT);
        assert!(
            reservation.lease_expires_at > Utc::now() + Duration::seconds(AGENT_WORK_LEASE_SECONDS)
        );

        // Another workspace's merge touching the file overlaps; one that
        // does not is free to integrate.
        let active = AgentWorkDeclaration::list_active_for_repo(&pool, repo_id)
            .await
            .unwrap();
        let rival = active
            .iter()
            .find(|declaration| declaration.workspace_id == resolving)
            .unwrap();
        assert!(
            AgentWorkDeclaration::conflict_with_scope(
                rival,
                &["crates/git/src/lib.rs".to_string()],
                &[],
                &[]
            )
            .is_some()
        );
        assert!(
            AgentWorkDeclaration::conflict_with_scope(rival, &["README.md".to_string()], &[], &[])
                .is_none()
        );

        // The resolving workspace's own agent does not see it as a rival.
        let own =
            AgentWorkDeclaration::declare(&pool, &declaration_input(resolving, Uuid::new_v4()))
                .await
                .unwrap();
        assert!(own.conflicts.is_empty());

        AgentWorkDeclaration::release_workspace(&pool, resolving)
            .await
            .unwrap();
        assert!(
            AgentWorkDeclaration::list_active_for_repo(&pool, repo_id)
                .await
                .unwrap()
                .iter()
                .all(|declaration| declaration.workspace_id != resolving)
        );
        let _ = other;
    }

    #[tokio::test]
    async fn merge_blocking_is_first_come_first_served_and_cycle_free() {
        let pool = pool().await;
        let first = workspace(&pool).await;
        let second = workspace(&pool).await;
        let files = vec!["src/lib.rs".to_string()];
        let older = AgentWorkDeclaration::reserve_for_conflict_resolution(
            &pool,
            first,
            "main",
            files.clone(),
        )
        .await
        .unwrap();
        let younger =
            AgentWorkDeclaration::reserve_for_conflict_resolution(&pool, second, "main", files)
                .await
                .unwrap();
        assert!(older.created_at < younger.created_at);

        // Two resolutions on the same files: only the older one goes first.
        assert!(AgentWorkDeclaration::blocks_merge(
            &older,
            Some(younger.created_at)
        ));
        assert!(!AgentWorkDeclaration::blocks_merge(
            &younger,
            Some(older.created_at)
        ));
        // Renewal keeps the place in line.
        let renewed = AgentWorkDeclaration::reserve_for_conflict_resolution(
            &pool,
            first,
            "main",
            vec!["src/lib.rs".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(renewed.created_at, older.created_at);

        // Ordinary declarations block ordinary merges, never a resolution.
        let ordinary =
            AgentWorkDeclaration::declare(&pool, &declaration_input(second, Uuid::new_v4()))
                .await
                .unwrap()
                .declaration;
        assert!(AgentWorkDeclaration::blocks_merge(&ordinary, None));
        assert!(!AgentWorkDeclaration::blocks_merge(
            &ordinary,
            Some(older.created_at)
        ));
        // Any reservation blocks a workspace that holds none.
        assert!(AgentWorkDeclaration::blocks_merge(&younger, None));
    }

    #[tokio::test]
    async fn archived_workspaces_release_their_conflict_reservation() {
        let pool = pool().await;
        let workspace_id = workspace(&pool).await;
        AgentWorkDeclaration::reserve_for_conflict_resolution(
            &pool,
            workspace_id,
            "main",
            vec!["a.rs".to_string()],
        )
        .await
        .unwrap();
        AgentWorkDeclaration::maintain_conflict_reservations(&pool)
            .await
            .unwrap();
        assert_eq!(
            AgentWorkDeclaration::list_active(&pool, workspace_id)
                .await
                .unwrap()
                .len(),
            1
        );
        sqlx::query("UPDATE workspaces SET archived = 1 WHERE id = ?")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        AgentWorkDeclaration::maintain_conflict_reservations(&pool)
            .await
            .unwrap();
        assert!(
            AgentWorkDeclaration::list_active(&pool, workspace_id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn release_removes_declaration_from_active_view() {
        let pool = pool().await;
        let workspace_id = workspace(&pool).await;
        let owner_id = Uuid::new_v4();
        AgentWorkDeclaration::declare(&pool, &declaration_input(workspace_id, owner_id))
            .await
            .unwrap();

        assert!(
            AgentWorkDeclaration::release(&pool, workspace_id, owner_id)
                .await
                .unwrap()
        );
        assert!(
            AgentWorkDeclaration::list_active(&pool, workspace_id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn repo_scope_lists_active_declarations_across_workspaces() {
        let pool = pool().await;
        let first_workspace = workspace(&pool).await;
        let second_workspace = workspace(&pool).await;
        let repo_id = repo_for_workspaces(&pool, &[first_workspace, second_workspace]).await;

        AgentWorkDeclaration::declare(&pool, &declaration_input(first_workspace, Uuid::new_v4()))
            .await
            .unwrap();
        AgentWorkDeclaration::declare(&pool, &declaration_input(second_workspace, Uuid::new_v4()))
            .await
            .unwrap();

        assert_eq!(
            AgentWorkDeclaration::list_active_for_repo(&pool, repo_id)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn project_scope_includes_issue_linked_workspaces() {
        let pool = pool().await;
        let workspace_id = workspace(&pool).await;
        let project_id = Uuid::new_v4();
        let status_id = Uuid::new_v4();
        let issue_id = Uuid::new_v4();

        sqlx::query(
            "INSERT INTO projects (id, name, color, sort_order) VALUES (?, 'P', '#fff', 0)",
        )
        .bind(project_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO project_statuses (id, project_id, name, color) VALUES (?, ?, 'Todo', '#fff')",
        )
        .bind(status_id)
        .bind(project_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO issues (id, project_id, issue_number, simple_id, status_id, title) VALUES (?, ?, 1, 'P-1', ?, 'T')",
        )
        .bind(issue_id)
        .bind(project_id)
        .bind(status_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO issue_workspaces (id, issue_id, workspace_id) VALUES (?, ?, ?)")
            .bind(Uuid::new_v4())
            .bind(issue_id)
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();

        AgentWorkDeclaration::declare(&pool, &declaration_input(workspace_id, Uuid::new_v4()))
            .await
            .unwrap();

        assert_eq!(
            AgentWorkDeclaration::list_active_for_project(&pool, project_id)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn inactive_execution_declaration_is_not_listed() {
        let pool = pool().await;
        let workspace_id = workspace(&pool).await;
        let session_id = Uuid::new_v4();
        let execution_id = Uuid::new_v4();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(session_id)
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO execution_processes (id, session_id, run_reason, executor_action, status) VALUES (?, ?, 'codingagent', '{}', 'failed')",
        )
        .bind(execution_id)
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();

        let mut input = declaration_input(workspace_id, execution_id);
        input.execution_process_id = Some(execution_id);
        AgentWorkDeclaration::declare(&pool, &input).await.unwrap();

        assert!(
            AgentWorkDeclaration::list_active(&pool, workspace_id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn activity_uses_running_processes_as_source_of_truth() {
        let pool = pool().await;
        let workspace_id = workspace(&pool).await;
        let session_id = Uuid::new_v4();
        let execution_id = Uuid::new_v4();
        sqlx::query("INSERT INTO sessions (id, workspace_id, executor) VALUES (?, ?, 'CODEX')")
            .bind(session_id)
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO execution_processes (id, session_id, run_reason, executor_action, status) VALUES (?, ?, 'codingagent', '{}', 'running')",
        )
        .bind(execution_id)
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();

        let activity = AgentWorkDeclaration::list_activity_for_workspace(&pool, workspace_id)
            .await
            .unwrap();
        assert_eq!(activity.len(), 1);
        assert!(activity[0].is_running);
        assert_eq!(activity[0].execution_process_id, Some(execution_id));
        assert_eq!(activity[0].agent_name, "CODEX");
        assert!(activity[0].declaration_id.is_none());

        let owner_id = Uuid::new_v4();
        let mut declaration = declaration_input(workspace_id, owner_id);
        declaration.execution_process_id = Some(execution_id);
        AgentWorkDeclaration::declare(&pool, &declaration)
            .await
            .unwrap();

        let activity = AgentWorkDeclaration::list_activity_for_workspace(&pool, workspace_id)
            .await
            .unwrap();
        assert_eq!(activity.len(), 1);
        assert!(activity[0].is_running);
        assert!(activity[0].declaration_id.is_some());
        assert_eq!(activity[0].agent_name, "agent-a");
    }

    #[test]
    fn dependency_overlap_is_reported_as_semantic_conflict() {
        let workspace_id = Uuid::new_v4();
        let mut owner = declaration_input(workspace_id, Uuid::new_v4());
        owner.symbols = vec!["git::merge_changes".to_string()];
        let declaration = AgentWorkDeclaration {
            id: Uuid::new_v4(),
            workspace_id,
            owner_id: owner.owner_id,
            execution_process_id: None,
            agent_name: owner.agent_name,
            intent: owner.intent,
            files: owner.files,
            symbols: owner.symbols,
            dependencies: vec![],
            lease_expires_at: Utc::now() + Duration::minutes(1),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let conflict = AgentWorkDeclaration::conflict_with_scope(
            &declaration,
            &["crates/other/src/caller.rs".to_string()],
            &[],
            &["git::merge_changes".to_string()],
        )
        .expect("dependency overlap should be reported");

        assert_eq!(conflict.conflict_type, "semantic");
    }
}
