//! Auto-move kanban cards between columns on lifecycle hooks.
//!
//! Triggers:
//! - workspace creation (linked issue) -> In Progress
//! - agent running (any coding-agent execution starts) -> In Progress (even from In Review/Done)
//! - pipeline completion (final execution success) -> In Review
//! - merge (direct or PR merged) -> Done (is_terminal)
//!
//! Gated by `UiPreferencesData::auto_move_cards_enabled` (scratch `UI_PREFERENCES` id 000...001).
//! True by default; toggle in Settings → General. When disabled the hooks are no-op.
//! Never locks the card: the move is a single `UPDATE issues SET status_id = ?` so
//! the user can still drag the card manually at any time.

use db::models::{issue::Issue, issue_workspace::IssueWorkspace, project_status::ProjectStatus};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Stable scratch id for global UI preferences (see `useUiPreferencesScratch.ts`).
const UI_PREFERENCES_ID: Uuid = Uuid::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

/// Read the toggle from the `UI_PREFERENCES` scratch row. Defaults to `true` when
/// the row is missing or the field is absent (fresh install, old payload).
async fn is_enabled(pool: &SqlitePool) -> bool {
    use db::models::scratch::{Scratch, ScratchType};

    let row = match Scratch::find_by_id(pool, UI_PREFERENCES_ID, &ScratchType::UiPreferences).await
    {
        Ok(Some(scratch)) => scratch,
        _ => return true,
    };
    let payload = match &row.payload {
        db::models::scratch::ScratchPayload::UiPreferences(data) => data,
        _ => return true,
    };
    // Field has `#[serde(default = "true")]`-style default, so missing -> true.
    // Direct struct access gives the deserialized default.
    payload.auto_move_cards_enabled
}

/// Move `issue_id` forward to `target_status_id` if auto-move is enabled and
/// the issue hasn't already passed the target (by sort_order). No-op otherwise.
async fn move_issue_forward(
    pool: &SqlitePool,
    issue_id: Uuid,
    target_status_id: Uuid,
) -> Result<bool, sqlx::Error> {
    if !is_enabled(pool).await {
        return Ok(false);
    }
    let Some(issue) = Issue::find_by_id(pool, issue_id).await? else {
        return Ok(false);
    };
    if issue.status_id == target_status_id {
        return Ok(false);
    }
    // Compare sort_order: only move forward, never backwards.
    let statuses = ProjectStatus::list_by_project(pool, issue.project_id).await?;
    let current_pos = statuses.iter().position(|s| s.id == issue.status_id);
    let target_pos = statuses.iter().position(|s| s.id == target_status_id);
    if let (Some(cur), Some(tgt)) = (current_pos, target_pos)
        && cur >= tgt
    {
        return Ok(false);
    }
    // Preserve title/description/etc — only status_id changes.
    // Use a direct status update to avoid clobbering other fields.
    sqlx::query(
        r#"UPDATE issues SET status_id = $1, updated_at = datetime('now', 'subsec') WHERE id = $2"#,
    )
    .bind(target_status_id)
    .bind(issue_id)
    .execute(pool)
    .await?;
    tracing::info!("auto-move card {} -> status {}", issue_id, target_status_id);
    Ok(true)
}

/// Force move to target even if it is backwards (used for AgentRunning: In Review/Done -> In Progress).
async fn move_issue_force(
    pool: &SqlitePool,
    issue_id: Uuid,
    target_status_id: Uuid,
) -> Result<bool, sqlx::Error> {
    if !is_enabled(pool).await {
        return Ok(false);
    }
    let Some(issue) = Issue::find_by_id(pool, issue_id).await? else {
        return Ok(false);
    };
    if issue.status_id == target_status_id {
        return Ok(false);
    }
    sqlx::query(
        r#"UPDATE issues SET status_id = $1, updated_at = datetime('now', 'subsec') WHERE id = $2"#,
    )
    .bind(target_status_id)
    .bind(issue_id)
    .execute(pool)
    .await?;
    tracing::info!(
        "auto-move (force) card {} -> status {}",
        issue_id,
        target_status_id
    );
    Ok(true)
}

fn find_status_by_name<'a>(
    statuses: &'a [ProjectStatus],
    needle: &str,
) -> Option<&'a ProjectStatus> {
    let n = needle.to_lowercase();
    statuses.iter().find(|s| s.name.to_lowercase().contains(&n))
}

async fn resolve_target_for_trigger(
    pool: &SqlitePool,
    project_id: Uuid,
    trigger: Trigger,
) -> Option<Uuid> {
    let statuses = ProjectStatus::list_by_project(pool, project_id)
        .await
        .ok()?;
    if statuses.is_empty() {
        return None;
    }
    match trigger {
        Trigger::WorkspaceCreated | Trigger::AgentRunning => {
            // Prefer a status whose name contains "progress", else second column.
            if let Some(s) = find_status_by_name(&statuses, "progress") {
                return Some(s.id);
            }
            if statuses.len() >= 2 {
                return Some(statuses[1].id);
            }
            // Fallback: first non-first status.
            statuses.get(1).map(|s| s.id)
        }
        Trigger::PipelineCompleted => {
            if let Some(s) = find_status_by_name(&statuses, "review") {
                return Some(s.id);
            }
            if statuses.len() >= 3 {
                return Some(statuses[2].id);
            }
            find_status_by_name(&statuses, "progress").map(|s| s.id)
        }
        Trigger::Merged => {
            // Prefer is_terminal, else status named "done", else last column.
            if let Some(s) = statuses.iter().find(|s| s.is_terminal) {
                return Some(s.id);
            }
            if let Some(s) = find_status_by_name(&statuses, "done") {
                return Some(s.id);
            }
            statuses.last().map(|s| s.id)
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Trigger {
    WorkspaceCreated,
    AgentRunning,
    PipelineCompleted,
    Merged,
}

/// Hook: workspace was created linked to `issue_id` (create_and_start). Move Todo -> In Progress.
/// Only moves when card is still in the first column (Todo / pos 0) — prevents
/// Todo -> In Review skip if this hook missed and pipeline hook fires next.
pub async fn on_workspace_created(pool: &SqlitePool, issue_id: Uuid) {
    let Some(issue) = (match Issue::find_by_id(pool, issue_id).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("auto-move workspace_created lookup failed: {e}");
            return;
        }
    }) else {
        return;
    };
    // Strict gate: only from the first column. If user already moved it manually, respect it.
    let statuses = match ProjectStatus::list_by_project(pool, issue.project_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("auto-move workspace_created list statuses failed: {e}");
            return;
        }
    };
    if let Some(pos) = statuses.iter().position(|s| s.id == issue.status_id)
        && pos != 0
    {
        tracing::info!(
            "auto-move workspace_created skip: card {} not in first column (pos {pos})",
            issue_id
        );
        return;
    }
    let Some(target) =
        resolve_target_for_trigger(pool, issue.project_id, Trigger::WorkspaceCreated).await
    else {
        return;
    };
    if let Err(e) = move_issue_forward(pool, issue_id, target).await {
        tracing::warn!("auto-move workspace_created failed for {issue_id}: {e}");
    }
}

/// Hook: a coding-agent execution started for `workspace_id`. Move any linked card
/// back to In Progress (force, even from In Review/Done) so active work is visible.
/// Idempotent if already In Progress.
pub async fn on_agent_running(pool: &SqlitePool, workspace_id: Uuid) {
    let issue_id =
        match IssueWorkspace::find_issue_and_project_by_workspace(pool, workspace_id).await {
            Ok(Some((iid, _))) => iid,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("auto-move agent_running issue lookup failed: {e}");
                return;
            }
        };
    let Some(issue) = (match Issue::find_by_id(pool, issue_id).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("auto-move agent_running issue fetch failed: {e}");
            return;
        }
    }) else {
        return;
    };
    let Some(target) =
        resolve_target_for_trigger(pool, issue.project_id, Trigger::AgentRunning).await
    else {
        return;
    };
    if let Err(e) = move_issue_force(pool, issue_id, target).await {
        tracing::warn!("auto-move agent_running failed for {issue_id}: {e}");
    }
}

/// Hook: pipeline/execution completed successfully for `workspace_id`. Move -> In Review.
/// Only moves when card is in In Progress (pos 1) — prevents Todo -> In Review skip
/// when workspace_created was missed. This is called only for the *final* coding-agent
/// execution (see local-deployment finalization guard); intermediate turns must not fire.
pub async fn on_pipeline_completed(pool: &SqlitePool, workspace_id: Uuid) {
    let issue_id =
        match IssueWorkspace::find_issue_and_project_by_workspace(pool, workspace_id).await {
            Ok(Some((iid, _))) => iid,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("auto-move pipeline_completed issue lookup failed: {e}");
                return;
            }
        };
    let Some(issue) = (match Issue::find_by_id(pool, issue_id).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("auto-move pipeline_completed issue fetch failed: {e}");
            return;
        }
    }) else {
        return;
    };
    // Strict gate: only from In Progress. If still Todo, the workspace hook was missed —
    // we intentionally do NOT skip to In Review; let the user (or next workspace) move it.
    let statuses = match ProjectStatus::list_by_project(pool, issue.project_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("auto-move pipeline_completed list statuses failed: {e}");
            return;
        }
    };
    if let Some(pos) = statuses.iter().position(|s| s.id == issue.status_id) {
        // Resolve expected pos of In Progress (prefer name match, else pos 1).
        let expected_pos = find_status_by_name(&statuses, "progress")
            .and_then(|s| statuses.iter().position(|x| x.id == s.id))
            .unwrap_or(1.min(statuses.len().saturating_sub(1)));
        if pos != expected_pos {
            tracing::info!(
                "auto-move pipeline_completed skip: card {} pos {pos} != expected In Progress pos {expected_pos}",
                issue_id
            );
            return;
        }
    }
    let Some(target) =
        resolve_target_for_trigger(pool, issue.project_id, Trigger::PipelineCompleted).await
    else {
        return;
    };
    if let Err(e) = move_issue_forward(pool, issue_id, target).await {
        tracing::warn!("auto-move pipeline_completed failed for {issue_id}: {e}");
    }
}

/// Hook: workspace `workspace_id` was merged (direct or PR). Move -> Done.
pub async fn on_workspace_merged(pool: &SqlitePool, workspace_id: Uuid) {
    let issue_id =
        match IssueWorkspace::find_issue_and_project_by_workspace(pool, workspace_id).await {
            Ok(Some((iid, _))) => iid,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("auto-move merged issue lookup failed: {e}");
                return;
            }
        };
    let Some(issue) = (match Issue::find_by_id(pool, issue_id).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("auto-move merged issue fetch failed: {e}");
            return;
        }
    }) else {
        return;
    };
    let Some(target) = resolve_target_for_trigger(pool, issue.project_id, Trigger::Merged).await
    else {
        return;
    };
    if let Err(e) = move_issue_forward(pool, issue_id, target).await {
        tracing::warn!("auto-move merged failed for {issue_id}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use db::models::{issue::NewIssue, project::NewProject, project_status::ProjectStatus};
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn pool() -> SqlitePool {
        let p = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&p).await.unwrap();
        p
    }

    async fn seed_project_with_statuses(pool: &SqlitePool) -> (Uuid, Vec<ProjectStatus>) {
        let pid = Uuid::new_v4();
        db::models::project::Project::create(
            pool,
            NewProject {
                id: pid,
                name: "P",
                key: Some("P"),
                color: "#fff",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();
        let names = ["Todo", "In Progress", "In Review", "Done"];
        let mut statuses = Vec::new();
        for (i, n) in names.iter().enumerate() {
            let s = ProjectStatus::create(
                pool,
                Uuid::new_v4(),
                pid,
                n,
                "#fff",
                i as i64,
                false,
                *n == "Done",
            )
            .await
            .unwrap();
            statuses.push(s);
        }
        (pid, statuses)
    }

    async fn create_issue(pool: &SqlitePool, project_id: Uuid, status_id: Uuid) -> Uuid {
        let iid = Uuid::new_v4();
        Issue::create(
            pool,
            NewIssue {
                id: iid,
                project_id,
                status_id,
                title: "T",
                description: None,
                priority: None,
                start_date: None,
                target_date: None,
                completed_at: None,
                sort_order: 0.0,
                parent_issue_id: None,
                parent_issue_sort_order: None,
                extension_metadata: "{}",
                key: "P",
            },
        )
        .await
        .unwrap();
        iid
    }

    #[tokio::test]
    async fn workspace_created_moves_todo_to_in_progress() {
        let pool = pool().await;
        let (pid, statuses) = seed_project_with_statuses(&pool).await;
        let iid = create_issue(&pool, pid, statuses[0].id).await;
        on_workspace_created(&pool, iid).await;
        let issue = Issue::find_by_id(&pool, iid).await.unwrap().unwrap();
        assert_eq!(issue.status_id, statuses[1].id);
    }

    #[tokio::test]
    async fn does_not_move_backwards() {
        let pool = pool().await;
        let (pid, statuses) = seed_project_with_statuses(&pool).await;
        // Already in Done, should not go back to In Progress.
        let iid = create_issue(&pool, pid, statuses[3].id).await;
        on_workspace_created(&pool, iid).await;
        let issue = Issue::find_by_id(&pool, iid).await.unwrap().unwrap();
        assert_eq!(issue.status_id, statuses[3].id);
    }

    #[tokio::test]
    async fn merged_moves_to_terminal() {
        let pool = pool().await;
        let (pid, statuses) = seed_project_with_statuses(&pool).await;
        let iid = create_issue(&pool, pid, statuses[1].id).await;
        // Simulate linked workspace
        let ws_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'b')")
            .bind(ws_id)
            .execute(&pool)
            .await
            .unwrap();
        db::models::issue_workspace::IssueWorkspace::link(&pool, iid, ws_id)
            .await
            .unwrap();
        on_workspace_merged(&pool, ws_id).await;
        let issue = Issue::find_by_id(&pool, iid).await.unwrap().unwrap();
        assert_eq!(issue.status_id, statuses[3].id);
    }

    #[tokio::test]
    async fn disabled_via_scratch_skips_move() {
        use db::models::scratch::{CreateScratch, ScratchPayload, UiPreferencesData};
        let pool = pool().await;
        let (pid, statuses) = seed_project_with_statuses(&pool).await;
        let iid = create_issue(&pool, pid, statuses[0].id).await;
        // Disable via scratch
        let prefs: UiPreferencesData =
            serde_json::from_value(serde_json::json!({ "auto_move_cards_enabled": false }))
                .unwrap();
        db::models::scratch::Scratch::create(
            &pool,
            UI_PREFERENCES_ID,
            &CreateScratch {
                payload: ScratchPayload::UiPreferences(Box::new(prefs)),
            },
        )
        .await
        .unwrap();
        on_workspace_created(&pool, iid).await;
        let issue = Issue::find_by_id(&pool, iid).await.unwrap().unwrap();
        assert_eq!(
            issue.status_id, statuses[0].id,
            "should not move when disabled"
        );
    }
}
