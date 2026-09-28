//! What a new agent session starts with (ADR-052, ADR-053).
//!
//! Follow-ups carry only the user's message: the agent resumes its own
//! conversation. The first message of a *new* session — a card starting, a new
//! chat session, switching agents — is the one place the app adds context, once:
//! - a handoff from earlier sessions of the same workspace ([`handoff`]);
//! - project memory relevant to the task, searched by the app itself so it
//!   does not depend on the agent remembering to call `memory_search`
//!   ([`project_memory`]), filtered by the RLCD classifier (Jev / Laya).

pub mod handoff;
pub mod project_memory;

use std::time::Duration;

use db::models::{
    issue::Issue, issue_workspace::IssueWorkspace, workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
pub use handoff::HANDOFF_SUMMARY_MARKER;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::services::{
    integration_errors::{self, IntegrationService},
    rlcd,
};

const MEMORY_OPEN: &str = "<aurapunk-memory>";
const MEMORY_CLOSE: &str = "</aurapunk-memory>";

/// Blocks the app prepends; stripped when earlier prompts are replayed.
pub(crate) const CONTEXT_TAGS: [(&str, &str); 2] = [
    (handoff::OPEN_TAG, handoff::CLOSE_TAG),
    (MEMORY_OPEN, MEMORY_CLOSE),
];

const RECALL_REPOS: usize = 2;
const RECALL_CANDIDATES: usize = 8;
const RECALL_MAX_CANDIDATES: usize = 11;
const RECALL_KEEP: usize = 5;
const RECALL_MIN_SCORE: f64 = 0.6;
const RECALL_QUERY_CHARS: usize = 800;
const MEMORY_CHARS: usize = 500;
const MAP_ENTRY_CHARS: usize = 1200;
const MAP_PREFIX: &str = "Project map";
const RELEVANCE_TIMEOUT: Duration = Duration::from_secs(6);

/// Prefix the first message of a new agent session with its context.
/// Slash commands and prompts with nothing to add pass through unchanged.
pub async fn prepare_initial_prompt(
    pool: &SqlitePool,
    workspace: &Workspace,
    session_id: Uuid,
    prompt: String,
) -> String {
    prepare_initial_prompt_with(pool, workspace, session_id, prompt, true).await
}

pub(crate) async fn prepare_initial_prompt_with(
    pool: &SqlitePool,
    workspace: &Workspace,
    session_id: Uuid,
    prompt: String,
    use_memory: bool,
) -> String {
    if prompt.trim_start().starts_with('/') {
        return prompt;
    }
    let issue = linked_issue(pool, workspace.id).await;
    let remote_summary = if use_memory {
        project_memory::latest(&handoff_user_id(workspace.id, issue.as_ref()))
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(workspace_id = %workspace.id, %error, "could not read the handoff from Mem0");
                None
            })
    } else {
        None
    };
    let handoff = handoff::build(pool, workspace, session_id, remote_summary).await;
    let memory = if use_memory {
        recall_block(pool, workspace, issue.as_ref(), &prompt).await
    } else {
        None
    };

    let mut blocks: Vec<String> = [handoff, memory].into_iter().flatten().collect();
    if blocks.is_empty() {
        return prompt;
    }
    blocks.push(prompt);
    blocks.join("\n\n")
}

/// Keep the agent-written handoff summary in Mem0 under the card, so a session
/// started elsewhere (another machine, a teammate) receives it too.
pub async fn save_handoff_summary(pool: &SqlitePool, workspace_id: Uuid, summary: &str) {
    let summary = summary.trim();
    if summary.is_empty() {
        return;
    }
    let issue = linked_issue(pool, workspace_id).await;
    let user_id = handoff_user_id(workspace_id, issue.as_ref());
    if let Err(error) = project_memory::replace_raw(&user_id, summary).await {
        integration_errors::record(
            IntegrationService::Mem0,
            "handoff summary",
            &format!("the handoff summary was not stored in Mem0: {error}"),
        );
    }
}

/// The handoff only matters until the card's work is integrated.
pub async fn forget_handoff(pool: &SqlitePool, workspace_id: Uuid) {
    let issue = linked_issue(pool, workspace_id).await;
    let user_id = handoff_user_id(workspace_id, issue.as_ref());
    if let Err(error) = project_memory::forget(&user_id).await {
        tracing::warn!(%workspace_id, %error, "could not forget the handoff in Mem0");
    }
}

async fn linked_issue(pool: &SqlitePool, workspace_id: Uuid) -> Option<Issue> {
    let (issue_id, _) = IssueWorkspace::find_issue_and_project_by_workspace(pool, workspace_id)
        .await
        .ok()
        .flatten()?;
    Issue::find_by_id(pool, issue_id).await.ok().flatten()
}

/// Cards sync across machines, workspaces do not: key by the card when there
/// is one.
fn handoff_user_id(workspace_id: Uuid, issue: Option<&Issue>) -> String {
    match issue {
        Some(issue) => format!("handoff-{}", issue.id),
        None => format!("handoff-ws-{workspace_id}"),
    }
}

async fn recall_block(
    pool: &SqlitePool,
    workspace: &Workspace,
    issue: Option<&Issue>,
    prompt: &str,
) -> Option<String> {
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id)
        .await
        .ok()?;
    if repos.is_empty() {
        return None;
    }
    let task = match issue {
        Some(issue) => format!(
            "{}\n{}",
            issue.title,
            issue.description.as_deref().unwrap_or_default()
        ),
        None => handoff::strip_handoff(prompt),
    };
    let query = truncate(task.trim(), RECALL_QUERY_CHARS);
    if query.is_empty() {
        return None;
    }

    let mut hits = Vec::new();
    for repo in repos.iter().take(RECALL_REPOS) {
        // Facts saved by agents, and the project map (where things live).
        let map_user = crate::services::project_map::memory_user_id(&repo.name);
        for (user_id, limit) in [
            (repo.name.as_str(), RECALL_CANDIDATES),
            (map_user.as_str(), 3),
        ] {
            match project_memory::search(user_id, &query, limit).await {
                Ok(found) => hits.extend(found),
                Err(error) => {
                    tracing::warn!(user_id, %error, "project memory recall failed");
                }
            }
        }
    }
    let memories = select_relevant(&query, hits).await;
    (!memories.is_empty()).then(|| render_memory(&memories))
}

/// Vector scores alone are noisy (unrelated facts score 0.6+), so the RLCD
/// classifier judges each candidate against the task. Without an answer, the
/// strongest vector matches above a floor are kept.
async fn select_relevant(task: &str, mut hits: Vec<project_memory::Recalled>) -> Vec<String> {
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut seen = std::collections::HashSet::new();
    hits.retain(|hit| seen.insert(hit.content.clone()));
    hits.truncate(RECALL_MAX_CANDIDATES);
    if hits.is_empty() {
        return Vec::new();
    }

    let state = format!(
        "Task:\n{task}\n\nMemories:\n{}",
        hits.iter()
            .enumerate()
            .map(|(index, hit)| format!("#{index}: {}", truncate(&hit.content, 400)))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let questions: Vec<(String, String)> = (0..hits.len())
        .map(|index| {
            (
                format!("m{index}"),
                format!("Is memory #{index} useful for doing this task?"),
            )
        })
        .collect();
    let verdict = rlcd::evaluate_pairs("memory_recall", &state, &questions, RELEVANCE_TIMEOUT)
        .await
        .ok();
    keep_relevant(hits, verdict.as_ref())
}

fn keep_relevant(
    hits: Vec<project_memory::Recalled>,
    verdict: Option<&std::collections::HashMap<String, f64>>,
) -> Vec<String> {
    hits.into_iter()
        .enumerate()
        .filter(|(index, hit)| match verdict {
            Some(verdict) => verdict
                .get(&format!("m{index}"))
                .is_some_and(|probability| *probability >= 0.5),
            None => hit.score >= RECALL_MIN_SCORE,
        })
        .take(RECALL_KEEP)
        .map(|(_, hit)| hit.content)
        .collect()
}

fn render_memory(memories: &[String]) -> String {
    let mut out = String::from(MEMORY_OPEN);
    out.push_str(
        "\nProject memory (Mem0) that looks relevant to this task: facts earlier sessions saved and entries of the project map. Verify against the code before relying on them; project_map shows where things live, memory_search finds more.\n",
    );
    for memory in memories {
        // Map entries list an area's modules: worth more room than a fact.
        let limit = if memory.starts_with(MAP_PREFIX) {
            MAP_ENTRY_CHARS
        } else {
            MEMORY_CHARS
        };
        out.push_str(&format!("- {}\n", truncate(memory, limit)));
    }
    out.push_str(MEMORY_CLOSE);
    out
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let cut: String = text.chars().take(max_chars).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn hit(score: f64, content: &str) -> project_memory::Recalled {
        project_memory::Recalled {
            score,
            content: content.to_string(),
        }
    }

    #[test]
    fn classifier_decides_relevance_when_it_answers() {
        let hits = vec![hit(0.74, "relevant"), hit(0.9, "unrelated")];
        let verdict = HashMap::from([("m0".to_string(), 0.8), ("m1".to_string(), 0.1)]);
        assert_eq!(keep_relevant(hits, Some(&verdict)), vec!["relevant"]);
    }

    #[test]
    fn score_floor_decides_without_a_classifier() {
        let hits = vec![hit(0.74, "strong"), hit(0.5, "weak")];
        assert_eq!(keep_relevant(hits, None), vec!["strong"]);
    }

    #[test]
    fn memory_block_is_tagged_and_stripped_on_replay() {
        let block = render_memory(&["Integration Guard lives in merge_queue.rs".to_string()]);
        assert!(block.starts_with(MEMORY_OPEN) && block.ends_with(MEMORY_CLOSE));
        assert_eq!(
            handoff::strip_handoff(&format!("{block}\n\nfix it")),
            "fix it"
        );
    }

    #[test]
    fn handoff_is_keyed_by_card_when_linked() {
        let workspace = Uuid::nil();
        assert_eq!(
            handoff_user_id(workspace, None),
            format!("handoff-ws-{workspace}")
        );
    }
}
