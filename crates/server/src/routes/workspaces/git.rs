use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    str::FromStr,
};

use axum::{
    Extension, Json, Router,
    extract::State,
    response::{IntoResponse, Json as ResponseJson},
    routing::{get, post},
};
use db::models::{
    agent_work::AgentWorkDeclaration,
    integration_guard::IntegrationGuardLease as DbIntegrationGuardLease,
    merge::{Merge, MergeStatus, PrMerge, PullRequestInfo},
    repo::{Repo, RepoError},
    scratch::{DraftFollowUpData, Scratch, ScratchPayload, ScratchType, UpdateScratch},
    session::{CreateSession, Session},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};
use git::{ConflictOp, GitCli, GitCliError, GitServiceError};
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use super::streams::{DiffStreamQuery, stream_workspace_diff_ws};
use crate::{DeploymentImpl, error::ApiError, middleware::signed_ws::SignedWsUpgrade};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct RebaseWorkspaceRequest {
    pub repo_id: Uuid,
    pub old_base_branch: Option<String>,
    pub new_base_branch: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct AbortConflictsRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct ContinueRebaseRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GitOperationError {
    MergeConflicts {
        message: String,
        op: ConflictOp,
        conflicted_files: Vec<String>,
        target_branch: String,
    },
    RebaseInProgress,
    AgentWorkConflict {
        message: String,
        conflicts: Vec<db::models::agent_work::AgentWorkConflict>,
    },
    /// Target checkout has uncommitted tracked modifications. Returned by the
    /// Integration Guard cleanliness gate before the critical section, with
    /// file lists the UI and agents can act on. Untracked files are reported
    /// for visibility and never block the merge.
    DirtyWorktree {
        message: String,
        branch: String,
        modified: Vec<String>,
        untracked: Vec<String>,
    },
    IntegrationInProgress {
        message: String,
    },
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct MergeWorkspaceRequest {
    pub repo_id: Uuid,
    #[serde(default)]    #[ts(optional)]
    pub suppress_auto_move: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub keep_workspace_open: Option<bool>,
}

/// Successful merge result. `pending_stashes` lists our own stash entries
/// (`aurapunk:` prefix) still sitting in the repo so the UI can offer to
/// pop the latest back — WIP is never left forgotten silently.
#[derive(Debug, Deserialize, Serialize, TS)]
pub struct MergeWorkspaceResponse {
    pub pending_stashes: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct CommitWorkspaceRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CommitWorkspaceResponse {
    /// Whether a new commit was created. `false` means the worktree was clean
    /// (nothing to commit) — not an error.
    pub committed: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct PushWorkspaceRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum PushError {
    ForcePushRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct BranchStatus {
    pub commits_behind: Option<usize>,
    pub commits_ahead: Option<usize>,
    pub has_uncommitted_changes: Option<bool>,
    pub head_oid: Option<String>,
    pub uncommitted_count: Option<usize>,
    pub untracked_count: Option<usize>,
    pub target_branch_name: String,
    pub remote_commits_behind: Option<usize>,
    pub remote_commits_ahead: Option<usize>,
    pub merges: Vec<Merge>,
    pub is_rebase_in_progress: bool,
    pub conflict_op: Option<ConflictOp>,
    pub conflicted_files: Vec<String>,
    pub is_target_remote: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct RepoBranchStatus {
    pub repo_id: Uuid,
    pub repo_name: String,
    #[serde(flatten)]
    pub status: BranchStatus,
}

#[derive(Deserialize, Debug, TS)]
pub struct ChangeTargetBranchRequest {
    pub repo_id: Uuid,
    pub new_target_branch: String,
}

#[derive(Serialize, Debug, TS)]
pub struct ChangeTargetBranchResponse {
    pub repo_id: Uuid,
    pub new_target_branch: String,
    pub status: (usize, usize),
}

#[derive(Deserialize, Debug, TS)]
pub struct RenameBranchRequest {
    pub new_branch_name: String,
}

#[derive(Serialize, Debug, TS)]
pub struct RenameBranchResponse {
    pub branch: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum RenameBranchError {
    EmptyBranchName,
    InvalidBranchNameFormat,
    OpenPullRequest,
    BranchAlreadyExists { repo_name: String },
    RebaseInProgress { repo_name: String },
    RenameFailed { repo_name: String, message: String },
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/status", get(get_workspace_branch_status))
        .route("/diff-since", get(get_diff_since))
        .route("/diff/ws", get(stream_diff_ws))
        .route("/merge", post(merge_workspace))
        .route("/stash", post(stash_workspace_changes))
        .route("/stash-pop", post(pop_workspace_stash))
        .route("/delegate-block", post(delegate_merge_block))
        .route("/commit", post(commit_workspace))
        .route("/push", post(push_workspace_branch))
        .route("/push/force", post(force_push_workspace_branch))
        .route("/rebase", post(rebase_workspace))
        .route("/rebase/continue", post(continue_workspace_rebase))
        .route("/conflicts/abort", post(abort_workspace_conflicts))
        .route("/target-branch", axum::routing::put(change_target_branch))
        .route("/branch", axum::routing::put(rename_branch))
}

/// The process keeps a handle to the database-backed Integration Guard lease.
/// Drop releases it asynchronously on every return path, including errors.
struct IntegrationGuardHandle {
    pool: sqlx::SqlitePool,
    lease: DbIntegrationGuardLease,
}

impl Drop for IntegrationGuardHandle {
    fn drop(&mut self) {
        let pool = self.pool.clone();
        let repo_id = self.lease.repo_id;
        let owner_id = self.lease.owner_id;
        tokio::spawn(async move {
            if let Err(error) = DbIntegrationGuardLease::release(&pool, repo_id, owner_id).await {
                tracing::warn!(%error, %repo_id, "Failed to release Integration Guard lease");
            }
        });
    }
}

async fn acquire_integration_guard(
    pool: &sqlx::SqlitePool,
    repo_id: Uuid,
    owner_id: Uuid,
) -> Result<Option<IntegrationGuardHandle>, ApiError> {
    const MAX_WAIT_ATTEMPTS: usize = 150;

    for attempt in 0..MAX_WAIT_ATTEMPTS {
        if let Some(lease) = DbIntegrationGuardLease::try_acquire(pool, repo_id, owner_id).await? {
            return Ok(Some(IntegrationGuardHandle {
                pool: pool.clone(),
                lease,
            }));
        }
        if attempt + 1 < MAX_WAIT_ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    Ok(None)
}

async fn resolve_vibe_kanban_identifier(
    _deployment: &DeploymentImpl,
    local_workspace_id: Uuid,
) -> String {
    local_workspace_id.to_string()
}

#[axum::debug_handler]
pub async fn stream_diff_ws(
    ws: SignedWsUpgrade,
    query: axum::extract::Query<DiffStreamQuery>,
    workspace: Extension<Workspace>,
    deployment: State<DeploymentImpl>,
) -> impl IntoResponse {
    stream_workspace_diff_ws(ws, query, workspace, deployment).await
}

#[axum::debug_handler]
pub async fn merge_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MergeWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<MergeWorkspaceResponse, GitOperationError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    // Integration Guard cleanliness gate (validation phase): refuse a dirty
    // target checkout with structured data instead of dying inside the CLI
    // merge with raw stderr. Cheap and read-only, so it runs before the
    // lease is acquired. Only tracked modifications block; untracked files
    // are reported for visibility.
    {
        let cleanliness = deployment
            .git()
            .worktree_cleanliness(&repo.path, &workspace_repo.target_branch)?;
        if !cleanliness.modified.is_empty() {
            let message = format!(
                "Branch '{}' has {} uncommitted tracked file{} ({} untracked reported). Stash, commit, or delegate cleanup before retrying the merge.",
                workspace_repo.target_branch,
                cleanliness.modified.len(),
                if cleanliness.modified.len() == 1 { "" } else { "s" },
                cleanliness.untracked.len(),
            );
            return Ok(ResponseJson(
                ApiResponse::error_with_data(GitOperationError::DirtyWorktree {
                    message: message.clone(),
                    branch: workspace_repo.target_branch.clone(),
                    modified: cleanliness.modified,
                    untracked: cleanliness.untracked,
                })
                .with_message(message),
            ));
        }
    }

    // All direct merges update a shared branch reference. The lease is stored
    // in SQLite so separate backend processes cannot validate and write the
    // same repository concurrently.
    let Some(_integration_guard) = acquire_integration_guard(pool, repo.id, workspace.id).await?
    else {
        let message =
            "Integration Guard is busy for this repository. Retry after the active integration finishes."
                .to_string();
        return Ok(ResponseJson(
            ApiResponse::error_with_data(GitOperationError::IntegrationInProgress {
                message: message.clone(),
            })
            .with_message(message),
        ));
    };

    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id).await?;
    let has_open_pr = merges
        .iter()
        .any(|m| matches!(m, Merge::Pr(pr) if matches!(pr.pr_info.status, MergeStatus::Open)));
    if has_open_pr {
        return Err(ApiError::BadRequest(
            "Cannot merge directly when a pull request is open for this repository.".to_string(),
        ));
    }

    let is_target_remote = deployment
        .git()
        .is_remote_branch(&repo.path, &workspace_repo.target_branch)?;
    if is_target_remote {
        return Err(ApiError::BadRequest(
            "Cannot merge directly into a remote branch. Please create a pull request instead."
                .to_string(),
        ));
    }

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(repo.name);

    // Use the merge base as the task's original HEAD. This keeps changes made
    // on the target branch after the task started out of the task scope and
    // lets Git perform a three-way merge instead of requiring a rebase first.
    let target_head = deployment
        .git()
        .get_branch_oid(&repo.path, &workspace_repo.target_branch)?;
    let task_head = deployment
        .git()
        .get_branch_oid(&repo.path, &workspace.branch)?;
    let original_head = deployment.git().get_fork_point(
        &repo.path,
        &workspace_repo.target_branch,
        &workspace.branch,
    )?;
    let target_changed_files =
        deployment
            .git()
            .get_commit_diff_file_paths(&repo.path, &original_head, &target_head)?;
    let mut changed_files =
        deployment
            .git()
            .get_commit_diff_file_paths(&repo.path, &original_head, &task_head)?;
    if !target_changed_files.is_empty() {
        tracing::info!(
            workspace_id = %workspace.id,
            target_branch = %workspace_repo.target_branch,
            original_head = %original_head,
            target_head = %target_head,
            changed_files = target_changed_files.len(),
            "Target HEAD advanced; attempting a three-way integration"
        );
    }
    let current_declarations = AgentWorkDeclaration::list_active(pool, workspace.id).await?;
    let mut changed_symbols = Vec::new();
    let mut changed_dependencies = Vec::new();
    for declaration in &current_declarations {
        changed_files.extend(declaration.files.iter().cloned());
        changed_symbols.extend(declaration.symbols.iter().cloned());
        changed_dependencies.extend(declaration.dependencies.iter().cloned());
    }
    let changed_files = changed_files.into_iter().collect::<Vec<_>>();

    let conflicts = AgentWorkDeclaration::list_active_for_repo(pool, repo.id)
        .await?
        .into_iter()
        .filter(|declaration| declaration.workspace_id != workspace.id)
        .filter_map(|declaration| {
            AgentWorkDeclaration::conflict_with_scope(
                &declaration,
                &changed_files,
                &changed_symbols,
                &changed_dependencies,
            )
        })
        .collect::<Vec<_>>();
    if !conflicts.is_empty() {
        let agents = conflicts
            .iter()
            .map(|conflict| conflict.agent_name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let message = format!(
            "Merge blocked: active agent work overlaps this branch ({agents}). Review or release the conflicting declarations before integrating."
        );
        return Ok(ResponseJson(
            ApiResponse::error_with_data(GitOperationError::AgentWorkConflict {
                message: message.clone(),
                conflicts,
            })
            .with_message(message),
        ));
    }

    let workspace_label = workspace.name.as_deref().unwrap_or(&workspace.branch);
    let vk_id = resolve_vibe_kanban_identifier(&deployment, workspace.id).await;
    let commit_message = format!("{} (vibe-kanban {})", workspace_label, vk_id);

    // A clean workspace can already point at the target HEAD (for example
    // when an agent made no changes). Treat that as an idempotent integration
    // instead of asking `git merge --squash` to create an empty commit.
    let merge_commit_id = if task_head == target_head {
        target_head.clone()
    } else {
        match deployment.git().merge_changes(
            &repo.path,
            &worktree_path,
            &workspace.branch,
            &workspace_repo.target_branch,
            &commit_message,
        ) {
            Ok(sha) => sha,
            // Textual conflicts surface as structured data (file list) so
            // the UI and agents can act on them instead of showing raw git
            // stderr. Every other failure keeps the generic error path.
            Err(git::GitServiceError::MergeConflicts {
                message,
                conflicted_files,
            }) => {
                let message = format!(
                    "{message} Resolve the files below (or delegate the resolution) before retrying."
                );
                return Ok(ResponseJson(
                    ApiResponse::error_with_data(GitOperationError::MergeConflicts {
                        message: message.clone(),
                        op: ConflictOp::Merge,
                        conflicted_files,
                        target_branch: workspace_repo.target_branch.clone(),
                    })
                    .with_message(message),
                ));
            }
            Err(other) => return Err(other.into()),
        }
    };

    Merge::create_direct(
        pool,
        workspace.id,
        workspace_repo.repo_id,
        &workspace_repo.target_branch,
        &merge_commit_id,
    )
    .await?;

    AgentWorkDeclaration::release_workspace(pool, workspace.id).await?;

    // Normal manual merges retain the historical auto-move behavior. The
    // agent completion workflow defers this transition until its mandatory
    // Mem0 write has been acknowledged.
    if !request.suppress_auto_move.unwrap_or(false) {
        let pool_clone = pool.clone();
        let ws_id = workspace.id;
        tokio::spawn(async move {
            services::services::auto_move::on_workspace_merged(&pool_clone, ws_id).await;
        });
    }

    if !request.keep_workspace_open.unwrap_or(false)
        && !workspace.pinned
        && let Err(e) = deployment.container().archive_workspace(workspace.id).await
    {
        tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
    }

    // Our own stash entries (pre-merge stashes, agent cleanups) survive the
    // merge by design. Report them so the UI can offer to pop the latest
    // back instead of letting WIP sit forgotten in the stash list.
    let pending_stashes = GitCli::new().aurapunk_stashes(&repo.path);

    Ok(ResponseJson(ApiResponse::success(
        MergeWorkspaceResponse { pending_stashes },
    )))
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct StashWorkspaceRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct StashWorkspaceResponse {
    pub stashed: bool,
    pub output: String,
}

/// Stash tracked modifications and untracked files in the target checkout so
/// a blocked merge can be retried. Explicitly user-initiated through the
/// merge dialog; the backend never stashes on its own.
#[axum::debug_handler]
pub async fn stash_workspace_changes(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<StashWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<StashWorkspaceResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;
    let cleanliness = deployment
        .git()
        .worktree_cleanliness(&repo.path, &workspace_repo.target_branch)?;
    let Some(checkout) = cleanliness.checkout_path else {
        return Err(ApiError::BadRequest(
            "Target branch is not checked out anywhere; nothing to stash.".to_string(),
        ));
    };
    let output = GitCli::new()
        .stash_push(
            &checkout,
            "aurapunk: pre-merge stash (merge dialog)",
        )
        .map_err(|e| ApiError::BadRequest(format!("Git stash failed: {e}")))?;
    Ok(ResponseJson(ApiResponse::success(StashWorkspaceResponse {
        stashed: true,
        output: output.chars().take(500).collect(),
    })))
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct PopWorkspaceStashRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct PopWorkspaceStashResponse {
    pub popped: bool,
    pub output: String,
}

/// Restore the most recent stash entry in the target checkout. Offered to
/// the operator right after a stash-and-retry merge succeeds, so WIP never
/// sits forgotten in the stash list. Fails loudly on conflicts instead of
/// guessing, so the operator (or a delegated agent) resolves them.
#[axum::debug_handler]
pub async fn pop_workspace_stash(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PopWorkspaceStashRequest>,
) -> Result<ResponseJson<ApiResponse<PopWorkspaceStashResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;
    let cleanliness = deployment
        .git()
        .worktree_cleanliness(&repo.path, &workspace_repo.target_branch)?;
    let Some(checkout) = cleanliness.checkout_path else {
        return Err(ApiError::BadRequest(
            "Target branch is not checked out anywhere; nothing to pop into.".to_string(),
        ));
    };
    let output = GitCli::new()
        .stash_pop(&checkout)
        .map_err(|e| ApiError::BadRequest(format!("Git stash pop failed: {e}")))?;
    Ok(ResponseJson(ApiResponse::success(
        PopWorkspaceStashResponse {
            popped: true,
            output: output.chars().take(500).collect(),
        },
    )))
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct DelegateMergeBlockRequest {
    pub repo_id: Uuid,
    /// Optional caller context (e.g. "merge-conflict") prepended to the
    /// agent instruction so resolution advice matches the block kind.
    #[serde(default)]
    pub note: Option<String>,
    /// Free-text operator instructions typed in the merge dialog (e.g.
    /// "commit A and B, stash the rest, gitignore X but not Y"). Appended
    /// verbatim so selective intent survives to the agent.
    #[serde(default)]
    pub user_note: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct DelegateMergeBlockResponse {
    pub delegated: bool,
    pub reason: String,
    pub session_id: Option<Uuid>,
}

/// Hand a merge block to the agent system: re-derives the dirty state,
/// resolves the workspace's saved executor, and queues a cleanup follow-up
/// on the latest session so the next agent run picks it up. Safe actions
/// (stash, gitignore junk) are described as autonomous; anything ambiguous
/// or destructive is flagged for the agent to ask the user about first.
/// Returns `delegated: false` with a machine-readable reason when there is
/// nothing to delegate (clean tree) or nobody to delegate to (no executor).
#[axum::debug_handler]
pub async fn delegate_merge_block(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<DelegateMergeBlockRequest>,
) -> Result<ResponseJson<ApiResponse<DelegateMergeBlockResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;
    let cleanliness = deployment
        .git()
        .worktree_cleanliness(&repo.path, &workspace_repo.target_branch)?;
    if cleanliness.modified.is_empty() {
        return Ok(ResponseJson(ApiResponse::success(
            DelegateMergeBlockResponse {
                delegated: false,
                reason: "already_clean".to_string(),
                session_id: None,
            },
        )));
    }

    let chat_config = Scratch::find_by_id(pool, workspace.id, &ScratchType::WorkspaceChatConfig)
        .await?
        .and_then(|scratch| match scratch.payload {
            ScratchPayload::WorkspaceChatConfig(config) => Some(config),
            _ => None,
        })
        .unwrap_or_default();
    let executor = chat_config
        .executor
        .as_deref()
        .map(|raw| raw.replace('-', "_").to_ascii_uppercase())
        .and_then(|norm| BaseCodingAgent::from_str(&norm).ok());
    let Some(executor) = executor else {
        return Ok(ResponseJson(ApiResponse::success(
            DelegateMergeBlockResponse {
                delegated: false,
                reason: "no_agent_configured".to_string(),
                session_id: None,
            },
        )));
    };
    let executor_config = ExecutorConfig {
        executor,
        variant: chat_config.preset.clone(),
        model_id: chat_config.model_id.clone(),
        agent_id: chat_config.agent_id.clone(),
        reasoning_id: chat_config.reasoning_id.clone(),
        permission_policy: None,
    };

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(session) => session,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    fn summarize(files: &[String], max: usize) -> String {
        if files.len() <= max {
            return files.join(", ");
        }
        format!("{}, +{} more", files[..max].join(", "), files.len() - max)
    }
        let mut message = if request.note.as_deref() == Some("merge-conflict") {        format!(
            "Integration Guard delegated conflict resolution: merging into '{}' hit textual conflicts in: {}. \
Plan: 1) open each file and resolve the conflict markers, keeping the intended behavior of both sides; \
2) `git add` the resolved files and COMMIT the result on '{}' with a clear message (this completes the integration; the user retries afterwards for the idempotent success path); \
3) never commit generated junk (db.v2.sqlite, installer-output/, *.log) — gitignore when missing; \
4) report exactly what was resolved. Do NOT push. Ask the user before anything destructive or ambiguous.",
            workspace_repo.target_branch,
            summarize(&cleanliness.modified, 20),
            workspace_repo.target_branch,
        )
    } else {
        format!(
            "Integration Guard delegated cleanup: merging into '{}' is blocked by {} uncommitted tracked file(s): {}. Untracked (informational, do not commit junk): {}. \
Plan: 1) inspect `git status`; 2) keep generated junk (db.v2.sqlite, installer-output/, *.log) OUT of commits — add to .gitignore when missing; \
3) stash (`git stash push -u`) or commit the real changes; 4) report exactly what was done. Do NOT push. Ask the user before anything destructive or ambiguous (commit messages, discarding changes). The user will retry the merge afterwards.",
            workspace_repo.target_branch,
            cleanliness.modified.len(),
            summarize(&cleanliness.modified, 20),
            if cleanliness.untracked.is_empty() {
                "none".to_string()
            } else {
                summarize(&cleanliness.untracked, 20)
            },
        )
    };
    // Operator's own selective instructions (typed in the merge dialog)
    // travel verbatim so intent like "commit A, stash the rest" survives.
    if let Some(note) = request.user_note.as_deref() {
        let note = note.trim();
        if !note.is_empty() {
            message.push_str("\n\nOperator instructions (follow literally, they override the defaults above): ");
            message.push_str(&note.chars().take(2000).collect::<String>());
        }
    }
    let follow_up = DraftFollowUpData {
        message,
        executor_config: executor_config.clone(),
    };
    Scratch::update(
        pool,
        session.id,
        &ScratchType::DraftFollowUp,
        &UpdateScratch {
            payload: ScratchPayload::DraftFollowUp(follow_up.clone()),
        },
    )
    .await?;
    deployment
        .queued_message_service()
        .queue_message(session.id, follow_up);
    Ok(ResponseJson(ApiResponse::success(
        DelegateMergeBlockResponse {
            delegated: true,
            reason: "queued".to_string(),
            session_id: Some(session.id),
        },
    )))
}

/// Commit all currently-uncommitted changes in the selected repo's worktree to
/// the task branch, reusing the same git plumbing as the coding-agent
/// auto-commit path (`GitService::commit` stages everything and skips when the
/// worktree is clean). This is the reliable way to capture work left behind by
/// headed (interactive) sessions, which do not auto-commit per turn.
#[axum::debug_handler]
pub async fn commit_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<CommitWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<CommitWorkspaceResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    // Refuse to commit while the worktree is mid-rebase or has unresolved
    // conflicts — committing there would capture a half-resolved state.
    if deployment
        .git()
        .is_rebase_in_progress(&worktree_path)
        .unwrap_or(false)
    {
        return Err(ApiError::BadRequest(
            "Cannot commit while a rebase is in progress.".to_string(),
        ));
    }
    if !deployment
        .git()
        .get_conflicted_files(&worktree_path)
        .unwrap_or_default()
        .is_empty()
    {
        return Err(ApiError::BadRequest(
            "Cannot commit while there are unresolved conflicts.".to_string(),
        ));
    }

    let workspace_label = workspace.name.as_deref().unwrap_or(&workspace.branch);
    let vk_id = resolve_vibe_kanban_identifier(&deployment, workspace.id).await;
    let commit_message = format!(
        "Commit uncommitted changes for {} (vibe-kanban {})",
        workspace_label, vk_id
    );

    let committed = deployment.git().commit(&worktree_path, &commit_message)?;

    Ok(ResponseJson(ApiResponse::success(
        CommitWorkspaceResponse { committed },
    )))
}

pub async fn push_workspace_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PushWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<(), PushError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    match deployment
        .git()
        .push_to_remote(&worktree_path, &workspace.branch, false)
    {
        Ok(_) => Ok(ResponseJson(ApiResponse::success(()))),
        Err(GitServiceError::GitCLI(GitCliError::PushRejected(_))) => Ok(ResponseJson(
            ApiResponse::error_with_data(PushError::ForcePushRequired),
        )),
        Err(e) => Err(ApiError::GitService(e)),
    }
}

pub async fn force_push_workspace_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PushWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<(), PushError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    deployment
        .git()
        .push_to_remote(&worktree_path, &workspace.branch, true)?;

    Ok(ResponseJson(ApiResponse::success(())))
}

pub async fn get_workspace_branch_status(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<RepoBranchStatus>>>, ApiError> {
    let pool = &deployment.db().pool;

    let repositories = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace.id).await?;
    let target_branches: HashMap<_, _> = workspace_repos
        .iter()
        .map(|wr| (wr.repo_id, wr.target_branch.clone()))
        .collect();

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_dir = PathBuf::from(&container_ref);

    let all_merges = Merge::find_by_workspace_id(pool, workspace.id).await?;
    let merges_by_repo: HashMap<Uuid, Vec<Merge>> =
        all_merges
            .into_iter()
            .fold(HashMap::new(), |mut acc, merge| {
                let repo_id = match &merge {
                    Merge::Direct(dm) => dm.repo_id,
                    Merge::Pr(pm) => pm.repo_id,
                };
                acc.entry(repo_id).or_insert_with(Vec::new).push(merge);
                acc
            });

    let mut results = Vec::with_capacity(repositories.len());

    for repo in repositories {
        let Some(target_branch) = target_branches.get(&repo.id).cloned() else {
            continue;
        };

        let repo_merges = merges_by_repo.get(&repo.id).cloned().unwrap_or_default();
        let worktree_path = workspace_dir.join(&repo.name);

        let head_oid = deployment
            .git()
            .get_head_info(&worktree_path)
            .ok()
            .map(|h| h.oid);

        let (is_rebase_in_progress, conflicted_files, conflict_op) = {
            let in_rebase = deployment
                .git()
                .is_rebase_in_progress(&worktree_path)
                .unwrap_or(false);
            let conflicts = deployment
                .git()
                .get_conflicted_files(&worktree_path)
                .unwrap_or_default();
            let op = if conflicts.is_empty() {
                None
            } else {
                deployment
                    .git()
                    .detect_conflict_op(&worktree_path)
                    .unwrap_or(None)
            };
            (in_rebase, conflicts, op)
        };

        let (uncommitted_count, untracked_count) =
            match deployment.git().get_worktree_change_counts(&worktree_path) {
                Ok((a, b)) => (Some(a), Some(b)),
                Err(_) => (None, None),
            };

        let has_uncommitted_changes = uncommitted_count.map(|c| c > 0);

        let is_target_remote = deployment
            .git()
            .is_remote_branch(&repo.path, &target_branch)?;

        let (commits_ahead, commits_behind) = if is_target_remote {
            let (ahead, behind) = deployment.git().get_remote_branch_status(
                &repo.path,
                &workspace.branch,
                Some(&target_branch),
            )?;
            (Some(ahead), Some(behind))
        } else {
            let (a, b) = deployment.git().get_branch_status(
                &repo.path,
                &workspace.branch,
                &target_branch,
            )?;
            (Some(a), Some(b))
        };

        let (remote_ahead, remote_behind) = if let Some(Merge::Pr(PrMerge {
            pr_info:
                PullRequestInfo {
                    status: MergeStatus::Open,
                    ..
                },
            ..
        })) = repo_merges.first()
        {
            match deployment
                .git()
                .get_remote_branch_status(&repo.path, &workspace.branch, None)
            {
                Ok((ahead, behind)) => (Some(ahead), Some(behind)),
                Err(_) => (None, None),
            }
        } else {
            (None, None)
        };

        results.push(RepoBranchStatus {
            repo_id: repo.id,
            repo_name: repo.name,
            status: BranchStatus {
                commits_ahead,
                commits_behind,
                has_uncommitted_changes,
                head_oid,
                uncommitted_count,
                untracked_count,
                remote_commits_ahead: remote_ahead,
                remote_commits_behind: remote_behind,
                merges: repo_merges,
                target_branch_name: target_branch,
                is_rebase_in_progress,
                conflict_op,
                conflicted_files,
                is_target_remote,
            },
        });
    }

    Ok(ResponseJson(ApiResponse::success(results)))
}

#[derive(Debug, Deserialize)]
pub struct DiffSinceQuery {
    pub repo_id: Uuid,
    pub commit_sha: String,
}

#[derive(Debug, Serialize, TS)]
pub struct DiffSinceResponse {
    /// Concatenated removed-lines (`git diff` `-` lines, marker stripped)
    /// from `commit_sha..HEAD` for this repo — best-effort staleness-check
    /// input for mem0: a fact/graph node whose provenance commit's
    /// referenced text shows up here was likely removed since that fact
    /// was saved (see docs/ADR/ADR-030-mem0-context-drift-measurement.md).
    /// This is NOT proof — text can be removed in one place and still
    /// exist elsewhere — just a much sharper signal than grepping the
    /// current repo state with no provenance at all.
    pub removed_text: String,
    pub files_changed: Vec<String>,
    /// True if `removed_text` was cut off at the size cap.
    pub truncated: bool,
    /// False if `commit_sha` doesn't resolve in this worktree (e.g. history
    /// was rewritten and it no longer exists) — the caller should treat
    /// that as "can't determine," not "definitely not stale."
    pub commit_found: bool,
}

/// Best-effort diff-since-commit for mem0 staleness checks — see
/// `DiffSinceResponse`. Deliberately generic (not mem0-specific plumbing):
/// it answers "what got removed in this repo since commit X," which mem0's
/// `memory_check_staleness` MCP tool (`crates/mcp/src/task_server/tools/
/// mem0.rs`) is the first, but need not be the only, consumer of.
pub async fn get_diff_since(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    axum::extract::Query(q): axum::extract::Query<DiffSinceQuery>,
) -> Result<ResponseJson<ApiResponse<DiffSinceResponse>>, ApiError> {
    const MAX_REMOVED_TEXT_BYTES: usize = 200_000;

    let pool = &deployment.db().pool;
    let repositories = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let Some(repo) = repositories.into_iter().find(|r| r.id == q.repo_id) else {
        return Ok(ResponseJson(ApiResponse::error(
            "repo not found in this workspace",
        )));
    };

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let worktree_path = PathBuf::from(&container_ref).join(&repo.name);

    let git_cli = GitCli::new();

    // Validate the commit still resolves in THIS worktree before diffing —
    // an unknown/rewritten-away commit_sha must degrade to "can't
    // determine," never a crash or a silently-misleading empty diff.
    let commit_found = git_cli
        .git(
            &worktree_path,
            ["cat-file", "-e", &format!("{}^{{commit}}", q.commit_sha)],
        )
        .is_ok();
    if !commit_found {
        return Ok(ResponseJson(ApiResponse::success(DiffSinceResponse {
            removed_text: String::new(),
            files_changed: vec![],
            truncated: false,
            commit_found: false,
        })));
    }

    let range = format!("{}..HEAD", q.commit_sha);

    let files_changed: Vec<String> = git_cli
        .git(&worktree_path, ["diff", "--name-only", &range])
        .unwrap_or_default()
        .lines()
        .map(|s| s.to_string())
        .collect();

    let raw_diff = git_cli
        .git(&worktree_path, ["diff", "--unified=0", &range])
        .unwrap_or_default();

    let mut removed_text = String::new();
    let mut truncated = false;
    for line in raw_diff.lines() {
        // Only single-`-` removed CONTENT lines — not the `---` file
        // header, which also starts with `-`.
        if line.starts_with("---") || !line.starts_with('-') {
            continue;
        }
        let rest = &line[1..];
        if removed_text.len() + rest.len() + 1 > MAX_REMOVED_TEXT_BYTES {
            truncated = true;
            break;
        }
        removed_text.push_str(rest);
        removed_text.push('\n');
    }

    Ok(ResponseJson(ApiResponse::success(DiffSinceResponse {
        removed_text,
        files_changed,
        truncated,
        commit_found: true,
    })))
}

#[axum::debug_handler]
pub async fn change_target_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<ChangeTargetBranchRequest>,
) -> Result<ResponseJson<ApiResponse<ChangeTargetBranchResponse>>, ApiError> {
    let repo_id = payload.repo_id;
    let new_target_branch = payload.new_target_branch;
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    if !deployment
        .git()
        .check_branch_exists(&repo.path, &new_target_branch)?
    {
        return Ok(ResponseJson(ApiResponse::error(
            format!(
                "Branch '{}' does not exist in repository '{}'",
                new_target_branch, repo.name
            )
            .as_str(),
        )));
    };

    WorkspaceRepo::update_target_branch(pool, workspace.id, repo_id, &new_target_branch).await?;

    let status =
        deployment
            .git()
            .get_branch_status(&repo.path, &workspace.branch, &new_target_branch)?;

    Ok(ResponseJson(ApiResponse::success(
        ChangeTargetBranchResponse {
            repo_id,
            new_target_branch,
            status,
        },
    )))
}

#[axum::debug_handler]
pub async fn rename_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<RenameBranchRequest>,
) -> Result<ResponseJson<ApiResponse<RenameBranchResponse, RenameBranchError>>, ApiError> {
    let new_branch_name = payload.new_branch_name.trim();

    if new_branch_name.is_empty() {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RenameBranchError::EmptyBranchName,
        )));
    }
    if !deployment.git().is_branch_name_valid(new_branch_name) {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RenameBranchError::InvalidBranchNameFormat,
        )));
    }
    if new_branch_name == workspace.branch {
        return Ok(ResponseJson(ApiResponse::success(RenameBranchResponse {
            branch: workspace.branch.clone(),
        })));
    }

    let pool = &deployment.db().pool;

    let merges = Merge::find_by_workspace_id(pool, workspace.id).await?;
    let has_open_pr = merges.into_iter().any(|merge| {
        matches!(merge, Merge::Pr(pr_merge) if matches!(pr_merge.pr_info.status, MergeStatus::Open))
    });
    if has_open_pr {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RenameBranchError::OpenPullRequest,
        )));
    }

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_dir = PathBuf::from(&container_ref);

    for repo in &repos {
        let worktree_path = workspace_dir.join(&repo.name);

        if deployment
            .git()
            .check_branch_exists(&repo.path, new_branch_name)?
        {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RenameBranchError::BranchAlreadyExists {
                    repo_name: repo.name.clone(),
                },
            )));
        }

        if deployment.git().is_rebase_in_progress(&worktree_path)? {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RenameBranchError::RebaseInProgress {
                    repo_name: repo.name.clone(),
                },
            )));
        }
    }

    let old_branch = workspace.branch.clone();
    let mut renamed_repos: Vec<&Repo> = Vec::new();

    for repo in &repos {
        let worktree_path = workspace_dir.join(&repo.name);

        match deployment.git().rename_local_branch(
            &worktree_path,
            &workspace.branch,
            new_branch_name,
        ) {
            Ok(()) => {
                renamed_repos.push(repo);
            }
            Err(e) => {
                for renamed_repo in &renamed_repos {
                    let rollback_path = workspace_dir.join(&renamed_repo.name);
                    if let Err(rollback_err) = deployment.git().rename_local_branch(
                        &rollback_path,
                        new_branch_name,
                        &old_branch,
                    ) {
                        tracing::error!(
                            "Failed to rollback branch rename in '{}': {}",
                            renamed_repo.name,
                            rollback_err
                        );
                    }
                }
                return Ok(ResponseJson(ApiResponse::error_with_data(
                    RenameBranchError::RenameFailed {
                        repo_name: repo.name.clone(),
                        message: e.to_string(),
                    },
                )));
            }
        }
    }

    db::models::workspace::Workspace::update_branch_name(pool, workspace.id, new_branch_name)
        .await?;
    let updated_children_count = WorkspaceRepo::update_target_branch_for_children_of_workspace(
        pool,
        workspace.id,
        &old_branch,
        new_branch_name,
    )
    .await?;

    if updated_children_count > 0 {
        tracing::info!(
            "Updated {} child workspaces to target new branch '{}'",
            updated_children_count,
            new_branch_name
        );
    }

    Ok(ResponseJson(ApiResponse::success(RenameBranchResponse {
        branch: new_branch_name.to_string(),
    })))
}

#[axum::debug_handler]
pub async fn rebase_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<RebaseWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<(), GitOperationError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, payload.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let old_base_branch = payload
        .old_base_branch
        .unwrap_or_else(|| workspace_repo.target_branch.clone());
    let new_base_branch = payload
        .new_base_branch
        .unwrap_or_else(|| workspace_repo.target_branch.clone());

    match deployment
        .git()
        .check_branch_exists(&repo.path, &new_base_branch)?
    {
        true => {
            WorkspaceRepo::update_target_branch(
                pool,
                workspace.id,
                payload.repo_id,
                &new_base_branch,
            )
            .await?;
        }
        false => {
            return Ok(ResponseJson(ApiResponse::error(
                format!(
                    "Branch '{}' does not exist in the repository",
                    new_base_branch
                )
                .as_str(),
            )));
        }
    }

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    let result = deployment.git().rebase_branch(
        &repo.path,
        &worktree_path,
        &new_base_branch,
        &old_base_branch,
        &workspace.branch.clone(),
    );
    if let Err(e) = result {
        return match e {
            GitServiceError::MergeConflicts {
                message,
                conflicted_files,
            } => Ok(ResponseJson(
                ApiResponse::<(), GitOperationError>::error_with_data(
                    GitOperationError::MergeConflicts {
                        message,
                        op: ConflictOp::Rebase,
                        conflicted_files,
                        target_branch: new_base_branch.clone(),
                    },
                ),
            )),
            GitServiceError::RebaseInProgress => Ok(ResponseJson(ApiResponse::<
                (),
                GitOperationError,
            >::error_with_data(
                GitOperationError::RebaseInProgress,
            ))),
            other => Err(ApiError::GitService(other)),
        };
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

#[axum::debug_handler]
pub async fn abort_workspace_conflicts(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<AbortConflictsRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, payload.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    deployment.git().abort_conflicts(&worktree_path)?;

    Ok(ResponseJson(ApiResponse::success(())))
}

#[axum::debug_handler]
pub async fn continue_workspace_rebase(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<ContinueRebaseRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, payload.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    deployment.git().continue_rebase(&worktree_path)?;

    Ok(ResponseJson(ApiResponse::success(())))
}
