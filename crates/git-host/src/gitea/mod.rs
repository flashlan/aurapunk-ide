//! Gitea/Forgejo provider backed by the REST API.
//!
//! Unlike the GitHub provider (which shells out to `gh`), this talks to any
//! Gitea-compatible instance over HTTP. The host is arbitrary, so it is not
//! derived from the git remote; it comes from the configured `base_url` plus a
//! token resolved from `~/.aurapunk/gitea.toml` (or the `GITEA_TOKEN` env
//! var) at construction time.

use std::path::Path;
use std::time::Duration;

use backon::{ExponentialBuilder, Retryable};
use chrono::{DateTime, Utc};
use db::models::merge::MergeStatus;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use url::Url;

use crate::types::{
    CreatePrRequest, GitHostError, ProviderKind, PullRequestDetail, UnifiedPrComment,
};

use super::GitHostProvider;

/// Provider for Gitea/Forgejo instances via the REST API.
pub struct GiteaProvider {
    client: reqwest::Client,
    base_url: String,
    token: String,
}

#[derive(Debug, Serialize)]
struct CreatePullRequestPayload {
    title: String,
    body: Option<String>,
    head: String,
    base: String,
    draft: bool,
}

#[derive(Debug, Deserialize)]
struct GiteaPrResponse {
    number: i64,
    url: String,
    #[serde(default)]
    state: String,
    merged_at: Option<DateTime<Utc>>,
    #[serde(default)]
    merge_commit_sha: Option<String>,
    #[serde(default)]
    title: Option<String>,
    base: Option<GiteaRefResponse>,
    head: Option<GiteaRefResponse>,
}

#[derive(Debug, Deserialize)]
struct GiteaRefResponse {
    #[serde(rename = "ref")]
    branch: String,
    /// For head refs this is `owner:branch`; for base it is the branch name.
    #[serde(default)]
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GiteaUser {
    #[serde(default)]
    login: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GiteaIssueComment {
    id: i64,
    #[serde(default)]
    user: Option<GiteaUser>,
    #[serde(default)]
    body: String,
    created_at: Option<DateTime<Utc>>,
}

impl GiteaProvider {
    pub fn new(base_url: &str, token: &str) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            base_url,
            token: token.to_string(),
        }
    }

    fn repo_from_remote(remote_url: &str) -> Result<(String, String), GitHostError> {
        let url = Url::parse(remote_url)
            .or_else(|_| Url::parse(&format!("https://{remote_url}")))
            .map_err(|_| {
                GitHostError::PullRequest(format!("Unparseable remote URL: {remote_url}"))
            })?;
        let path = url.path().trim_matches('/');
        let (owner, repo) = path.rsplit_once('/').ok_or_else(|| {
            GitHostError::PullRequest(format!("Unparseable remote URL: {remote_url}"))
        })?;
        let repo = repo.trim_end_matches(".git");
        Ok((owner.to_string(), repo.to_string()))
    }

    fn repo_from_pr_url(pr_url: &str) -> Result<(String, String), GitHostError> {
        let url = Url::parse(pr_url)
            .map_err(|_| GitHostError::PullRequest(format!("Unparseable PR URL: {pr_url}")))?;
        let segments: Vec<&str> = url.path().trim_matches('/').split('/').collect();
        // Expected: {owner}/{repo}/pulls/{number}
        if segments.len() < 4 {
            return Err(GitHostError::PullRequest(format!(
                "Unparseable PR URL: {pr_url}"
            )));
        }
        let owner = segments[0].to_string();
        let repo = segments[1].to_string();
        Ok((owner, repo))
    }

    fn parse_pr(pr: GiteaPrResponse) -> PullRequestDetail {
        let status = match pr.state.to_ascii_uppercase().as_str() {
            "OPEN" => MergeStatus::Open,
            "MERGED" => MergeStatus::Merged,
            "CLOSED" => MergeStatus::Closed,
            _ => MergeStatus::Unknown,
        };
        PullRequestDetail {
            number: pr.number,
            url: pr.url,
            status,
            merged_at: pr.merged_at,
            merge_commit_sha: pr.merge_commit_sha,
            title: pr.title.unwrap_or_default(),
            base_branch: pr.base.map(|b| b.branch).unwrap_or_default(),
            head_branch: pr
                .head
                .map(|h| h.label.clone().unwrap_or(h.branch))
                .unwrap_or_default(),
        }
    }
}

/// Minimal URL-encoding helper for the two path segments we control.
fn urlencoding(s: &str) -> String {
    s.replace('%', "%25").replace('/', "%2F")
}

fn http_err(err: reqwest::Error) -> GitHostError {
    GitHostError::Repository(format!("Gitea request failed: {err}"))
}

fn repo_segments(owner: &str, repo: &str) -> String {
    format!("/repos/{}/{}", urlencoding(owner), urlencoding(repo))
}

fn endpoint(base_url: &str, path: &str, query: &str) -> String {
    let mut url = format!("{base_url}/api/v1{path}");
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }
    url
}

fn authed_get(client: &reqwest::Client, token: &str, url: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header("Authorization", format!("token {token}"))
}

#[async_trait::async_trait]
impl GitHostProvider for GiteaProvider {
    async fn create_pr(
        &self,
        _repo_path: &Path,
        remote_url: &str,
        request: &CreatePrRequest,
    ) -> Result<PullRequestDetail, GitHostError> {
        let (owner, repo) = Self::repo_from_remote(remote_url)?;
        let url = endpoint(&self.base_url, &repo_segments(&owner, &repo), "");
        let payload = CreatePullRequestPayload {
            title: request.title.clone(),
            body: request.body.clone(),
            head: request.head_branch.clone(),
            base: request.base_branch.clone(),
            draft: request.draft.unwrap_or(false),
        };

        let client = self.client.clone();
        let token = self.token.clone();

        let op = (|| async {
            let resp = client
                .post(&url)
                .header("Authorization", format!("token {token}"))
                .json(&payload)
                .send()
                .await
                .map_err(http_err)?;
            let status = resp.status();
            let text = resp.text().await.map_err(http_err)?;
            if !(200..300).contains(&status.as_u16()) {
                return Err(map_status(status.as_u16(), &text));
            }
            let pr: GiteaPrResponse = serde_json::from_str(&text).map_err(|e| {
                GitHostError::UnexpectedOutput(format!(
                    "Failed to parse Gitea create PR response: {e}; raw: {text}"
                ))
            })?;
            Ok(Self::parse_pr(pr))
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err, dur: Duration| {
            warn!(
                error = %err,
                retry_in_secs = dur.as_secs(),
                "Retrying Gitea create_pr"
            );
        })
        .await;

        match op {
            Ok(detail) => {
                info!(pr_number = detail.number, "Created PR on Gitea");
                Ok(detail)
            }
            Err(e) => Err(e),
        }
    }

    async fn get_pr_status(&self, pr_url: &str) -> Result<PullRequestDetail, GitHostError> {
        let (owner, repo) = Self::repo_from_pr_url(pr_url)?;
        let number = extract_pr_number(pr_url)?;
        let url = endpoint(
            &self.base_url,
            &repo_segments(&owner, &repo),
            &format!("pulls/{number}"),
        );

        let client = self.client.clone();
        let token = self.token.clone();

        let pr: GiteaPrResponse = (|| async {
            let resp = authed_get(&client, &token, &url)
                .send()
                .await
                .map_err(http_err)?;
            let status = resp.status();
            let text = resp.text().await.map_err(http_err)?;
            if !(200..300).contains(&status.as_u16()) {
                return Err(map_status(status.as_u16(), &text));
            }
            serde_json::from_str(&text).map_err(|e| {
                GitHostError::UnexpectedOutput(format!("Failed to parse Gitea PR response: {e}"))
            })
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err, dur: Duration| {
            warn!(
                error = %err,
                retry_in_secs = dur.as_secs(),
                "Retrying Gitea get_pr_status"
            );
        })
        .await?;
        Ok(Self::parse_pr(pr))
    }

    async fn list_prs_for_branch(
        &self,
        _repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError> {
        let (owner, repo) = Self::repo_from_remote(remote_url)?;
        let url = endpoint(
            &self.base_url,
            &repo_segments(&owner, &repo),
            &format!("pulls?state=all&head={}", urlencoding(branch_name)),
        );

        let client = self.client.clone();
        let token = self.token.clone();

        let list: Vec<GiteaPrResponse> = (|| async {
            let resp = authed_get(&client, &token, &url)
                .send()
                .await
                .map_err(http_err)?;
            let status = resp.status();
            let text = resp.text().await.map_err(http_err)?;
            if !(200..300).contains(&status.as_u16()) {
                return Err(map_status(status.as_u16(), &text));
            }
            serde_json::from_str(&text).map_err(|e| {
                GitHostError::PullRequest(format!("Failed to parse Gitea PR list: {e}"))
            })
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err, dur: Duration| {
            warn!(
                error = %err,
                retry_in_secs = dur.as_secs(),
                "Retrying Gitea list_prs_for_branch"
            );
        })
        .await?;
        Ok(list.into_iter().map(Self::parse_pr).collect())
    }

    async fn get_pr_comments(
        &self,
        _repo_path: &Path,
        remote_url: &str,
        pr_number: i64,
    ) -> Result<Vec<UnifiedPrComment>, GitHostError> {
        let (owner, repo) = Self::repo_from_remote(remote_url)?;
        let comments_url = endpoint(
            &self.base_url,
            &repo_segments(&owner, &repo),
            &format!("pulls/{pr_number}/comments"),
        );
        let issue_url = endpoint(
            &self.base_url,
            &repo_segments(&owner, &repo),
            &format!("issues/{pr_number}/comments"),
        );

        let (issue, review) = tokio::join!(
            fetch_comments(&self.client, &self.token, &comments_url),
            fetch_comments(&self.client, &self.token, &issue_url)
        );
        let (mut issue, review) = (issue?, review?);
        issue.extend(review);
        issue.sort_by_key(|c| c.created_at());
        Ok(issue)
    }

    async fn list_open_prs(
        &self,
        _repo_path: &Path,
        remote_url: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError> {
        let (owner, repo) = Self::repo_from_remote(remote_url)?;
        let url = endpoint(
            &self.base_url,
            &repo_segments(&owner, &repo),
            "pulls?state=open",
        );

        let client = self.client.clone();
        let token = self.token.clone();

        let list: Vec<GiteaPrResponse> = (|| async {
            let resp = authed_get(&client, &token, &url)
                .send()
                .await
                .map_err(http_err)?;
            let status = resp.status();
            let text = resp.text().await.map_err(http_err)?;
            if !(200..300).contains(&status.as_u16()) {
                return Err(map_status(status.as_u16(), &text));
            }
            serde_json::from_str(&text).map_err(|e| {
                GitHostError::PullRequest(format!("Failed to parse Gitea open PR list: {e}"))
            })
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err, dur: Duration| {
            warn!(
                error = %err,
                retry_in_secs = dur.as_secs(),
                "Retrying Gitea list_open_prs"
            );
        })
        .await?;
        let mut prs: Vec<PullRequestDetail> = list.into_iter().map(Self::parse_pr).collect();
        prs.sort_by_key(|pr| std::cmp::Reverse(pr.number));
        Ok(prs)
    }

    fn provider_kind(&self) -> ProviderKind {
        ProviderKind::Gitea
    }
}

async fn fetch_comments(
    client: &reqwest::Client,
    token: &str,
    url: &str,
) -> Result<Vec<UnifiedPrComment>, GitHostError> {
    let resp = client
        .get(url)
        .header("Authorization", format!("token {token}"))
        .send()
        .await
        .map_err(http_err)?;
    let status = resp.status();
    let text = resp.text().await.map_err(http_err)?;
    // 404 on one of the two comment sources is not fatal; treat as empty.
    if status.as_u16() == 404 {
        return Ok(Vec::new());
    }
    if !(200..300).contains(&status.as_u16()) {
        return Err(map_status(status.as_u16(), &text));
    }
    let items: Vec<GiteaIssueComment> = serde_json::from_str(&text)
        .map_err(|e| GitHostError::PullRequest(format!("Failed to parse Gitea comments: {e}")))?;
    Ok(items
        .into_iter()
        .map(|c| UnifiedPrComment::General {
            id: c.id.to_string(),
            author: c
                .user
                .and_then(|u| u.login)
                .unwrap_or_else(|| "unknown".to_string()),
            author_association: None,
            body: c.body,
            created_at: c.created_at.unwrap_or_else(Utc::now),
            url: None,
        })
        .collect())
}

fn extract_pr_number(pr_url: &str) -> Result<i64, GitHostError> {
    let number = pr_url
        .rsplit('/')
        .next()
        .ok_or_else(|| GitHostError::PullRequest(format!("Unparseable PR URL: {pr_url}")))?
        .trim_end_matches(|c: char| !c.is_ascii_digit())
        .parse::<i64>()
        .map_err(|err| GitHostError::PullRequest(format!("Invalid PR URL: {err}")))?;
    Ok(number)
}

fn map_status(code: u16, body: &str) -> GitHostError {
    match code {
        401 => GitHostError::AuthFailed(format!("Gitea auth failed ({code}): {body}")),
        403 if body.to_lowercase().contains("permission")
            || body.to_lowercase().contains("forbidden") =>
        {
            GitHostError::InsufficientPermissions(body.to_string())
        }
        403 => GitHostError::AuthFailed(format!("Gitea auth failed ({code}): {body}")),
        404 => GitHostError::RepoNotFoundOrNoAccess(format!("Gitea 404: {body}")),
        _ => GitHostError::Repository(format!("Gitea HTTP {code}: {body}")),
    }
}
