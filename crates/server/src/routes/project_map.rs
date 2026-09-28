//! Project map endpoints (ADR-054): browse the map of a workspace's
//! repositories and write it to Mem0. See `services::services::project_map`.

use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{repo::Repo, workspace::Workspace, workspace_repo::WorkspaceRepo};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::project_map::{self, MapNode, SyncReport};
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/project-map", get(get_map))
        .route("/project-map/sync", post(sync_map))
}

#[derive(Debug, Deserialize)]
struct MapQuery {
    workspace_id: Option<Uuid>,
    repo_id: Option<Uuid>,
    path: Option<String>,
    depth: Option<usize>,
}

#[derive(Debug, Serialize)]
struct RepoMap {
    repo: String,
    root: String,
    text: String,
    nodes: Vec<MapNode>,
}

#[derive(Debug, Deserialize)]
struct SyncRequest {
    workspace_id: Option<Uuid>,
    repo_id: Option<Uuid>,
    #[serde(default)]
    force: bool,
}

#[derive(Debug, Serialize)]
struct RepoSync {
    repo: String,
    report: SyncReport,
}

/// (repo name, checkout to read). A workspace reads its own worktree, so the
/// map reflects the branch the agent is working on.
async fn roots(
    deployment: &DeploymentImpl,
    workspace_id: Option<Uuid>,
    repo_id: Option<Uuid>,
) -> Result<Vec<(String, PathBuf)>, ApiError> {
    let pool = &deployment.db().pool;
    if let Some(workspace_id) = workspace_id {
        let workspace = Workspace::find_by_id(pool, workspace_id)
            .await?
            .ok_or_else(|| ApiError::BadRequest("workspace not found".to_string()))?;
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await?;
        return Ok(repos
            .into_iter()
            .map(|repo| {
                let worktree = workspace
                    .container_ref
                    .as_deref()
                    .map(|dir| PathBuf::from(dir).join(&repo.name))
                    .filter(|path| path.exists());
                (repo.name.clone(), worktree.unwrap_or(repo.path))
            })
            .collect());
    }
    if let Some(repo_id) = repo_id {
        let repo = Repo::find_by_id(pool, repo_id)
            .await?
            .ok_or_else(|| ApiError::BadRequest("repository not found".to_string()))?;
        return Ok(vec![(repo.name, repo.path)]);
    }
    Err(ApiError::BadRequest(
        "workspace_id or repo_id is required".to_string(),
    ))
}

async fn get_map(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<MapQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<RepoMap>>>, ApiError> {
    // The whole tree at depth 2 is ~60 KB on this repo: overview by default,
    // modules once an area is chosen.
    let default_depth = if query.path.is_some() { 2 } else { 1 };
    let depth = query.depth.unwrap_or(default_depth).clamp(1, 3);
    let mut maps = Vec::new();
    for (repo, root) in roots(&deployment, query.workspace_id, query.repo_id).await? {
        let path = query.path.clone();
        let build_root = root.clone();
        let nodes = tokio::task::spawn_blocking(move || {
            project_map::view(&project_map::build(&build_root), path.as_deref(), depth)
        })
        .await
        .unwrap_or_default();
        maps.push(RepoMap {
            repo,
            root: root.display().to_string(),
            text: project_map::render_tree(&nodes),
            nodes,
        });
    }
    Ok(ResponseJson(ApiResponse::success(maps)))
}

async fn sync_map(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<SyncRequest>,
) -> Result<ResponseJson<ApiResponse<Vec<RepoSync>>>, ApiError> {
    let mut reports = Vec::new();
    for (repo, root) in roots(&deployment, request.workspace_id, request.repo_id).await? {
        let report = project_map::sync_to_memory(root, repo.clone(), request.force).await;
        reports.push(RepoSync { repo, report });
    }
    Ok(ResponseJson(ApiResponse::success(reports)))
}
