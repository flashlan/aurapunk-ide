//! Handoff context for a new agent session in a workspace that already had one
//! (ADR-052).
//!
//! An agent keeps its own conversation (`--resume <id>` or a live terminal), so
//! follow-ups carry only the new message. The one moment an agent really lacks
//! context is the first message of a *new* session in a workspace that was
//! already worked on — switching agents, or starting over. Only then is a
//! handoff block prepended, once, built from:
//! - the summary the previous agent wrote on request (`HANDOFF_SUMMARY_MARKER`),
//!   the best source when present;
//! - the branch state from git (commits, changed files, uncommitted count);
//! - the current pipeline stage;
//! - the previous exchanges (prompt + final answer of each turn), selected by
//!   the RLCD classifier (Jev / Laya) when there are too many to include.
//!
//! Rebuilt from the database and the branch each time, so it lives as long as
//! the workspace. The agent-written summary is also kept in Mem0 under the card
//! (see [`super::save_handoff_summary`]) so another machine gets it, and is
//! forgotten when the card merges. Durable knowledge goes to Mem0 when the card
//! completes.

use std::{path::Path, time::Duration};

use db::models::{
    coding_agent_turn::CodingAgentTurn, session::Session, workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use git::GitCli;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::services::rlcd;

/// Starts the prompt that asks an agent for a handoff summary. The turn's final
/// answer becomes the summary handed to the next session.
pub const HANDOFF_SUMMARY_MARKER: &str = "[aurapunk:handoff-summary]";

pub(super) const OPEN_TAG: &str = "<aurapunk-handoff>";
pub(super) const CLOSE_TAG: &str = "</aurapunk-handoff>";
const MAX_TURNS: usize = 8;
const PROMPT_CHARS: usize = 600;
const ANSWER_CHARS: usize = 1200;
const AGENT_SUMMARY_CHARS: usize = 8000;
const MAX_COMMITS: usize = 20;
const MAX_FILES: usize = 40;
const CLASSIFIER_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, PartialEq)]
struct Exchange {
    agent: String,
    prompt: String,
    answer: String,
}

/// Handoff block for the first message of a new session, or `None` when the
/// workspace has no earlier session. `remote_summary` is the latest handoff
/// summary kept in Mem0 for this card (written on another machine, or before
/// the local history was lost); a summary in the local history wins.
pub(super) async fn build(
    pool: &SqlitePool,
    workspace: &Workspace,
    session_id: Uuid,
    remote_summary: Option<String>,
) -> Option<String> {
    let mut sessions = Session::find_by_workspace_id(pool, workspace.id)
        .await
        .ok()?
        .into_iter()
        .filter(|session| session.id != session_id)
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| session.created_at);

    let mut exchanges = Vec::new();
    for session in &sessions {
        let agent = session
            .executor
            .clone()
            .unwrap_or_else(|| "agent".to_string());
        let history = CodingAgentTurn::find_conversation_history_for_session(pool, session.id)
            .await
            .unwrap_or_default();
        exchanges.extend(history.into_iter().map(|(prompt, answer)| Exchange {
            agent: agent.clone(),
            prompt: strip_handoff(&prompt),
            answer,
        }));
    }
    if exchanges.is_empty() && remote_summary.is_none() {
        return None;
    }

    let (agent_summary, exchanges) = split_agent_summary(exchanges);
    let agent_summary = agent_summary.or(remote_summary);
    let exchanges = if agent_summary.is_some() {
        exchanges
    } else {
        select(exchanges).await
    };

    let git = {
        let repos = WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace.id)
            .await
            .unwrap_or_default();
        let branch = workspace.branch.clone();
        let container = workspace.container_ref.clone();
        tokio::task::spawn_blocking(move || {
            repos
                .iter()
                .filter_map(|repo| {
                    let worktree = container
                        .as_deref()
                        .map(|dir| Path::new(dir).join(&repo.repo.name));
                    branch_state(
                        &repo.repo.path,
                        worktree.as_deref(),
                        &repo.repo.name,
                        &branch,
                        &repo.target_branch,
                    )
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default()
    };

    Some(render(
        agent_summary.as_deref(),
        &git,
        workspace.current_pipeline_stage,
        &exchanges,
    ))
}

/// Context blocks the app prepended to an old prompt (handoff, project
/// memory) are not history worth repeating: keep only what the user wrote.
pub(super) fn strip_handoff(prompt: &str) -> String {
    let mut rest = prompt.trim();
    loop {
        let Some((_, close)) = super::CONTEXT_TAGS
            .iter()
            .find(|(open, _)| rest.starts_with(open))
        else {
            return rest.to_string();
        };
        match rest.find(close) {
            Some(end) => rest = rest[end + close.len()..].trim_start(),
            None => return rest.to_string(),
        }
    }
}

/// The latest summary the agent wrote on request replaces everything before
/// it; exchanges after it are still reported.
fn split_agent_summary(exchanges: Vec<Exchange>) -> (Option<String>, Vec<Exchange>) {
    let Some(position) = exchanges.iter().rposition(|exchange| {
        exchange.prompt.contains(HANDOFF_SUMMARY_MARKER) && !exchange.answer.trim().is_empty()
    }) else {
        return (
            None,
            exchanges
                .into_iter()
                .filter(|exchange| !exchange.prompt.contains(HANDOFF_SUMMARY_MARKER))
                .collect(),
        );
    };
    let summary = truncate(exchanges[position].answer.trim(), AGENT_SUMMARY_CHARS);
    let after = exchanges
        .into_iter()
        .skip(position + 1)
        .filter(|exchange| !exchange.prompt.contains(HANDOFF_SUMMARY_MARKER))
        .collect();
    (Some(summary), after)
}

/// Keep every exchange when they fit; otherwise always the first (the task as
/// originally asked) and the last two (where the work stopped), and let the
/// classifier pick the middle ones that still matter. Without a classifier
/// answer the most recent ones win.
async fn select(exchanges: Vec<Exchange>) -> Vec<Exchange> {
    if exchanges.len() <= MAX_TURNS {
        return exchanges;
    }
    let last = exchanges.len() - 1;
    let middle: Vec<usize> = (1..last - 1).collect();
    let state = middle
        .iter()
        .map(|&index| {
            format!(
                "#{index}\nUser: {}\nAgent: {}",
                truncate(&exchanges[index].prompt, 300),
                truncate(&exchanges[index].answer, 400)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let questions = middle
        .iter()
        .map(|&index| {
            (
                format!("t{index}"),
                format!(
                    "Does exchange #{index} state a requirement, decision or result still needed to continue the task?"
                ),
            )
        })
        .collect::<Vec<_>>();
    let scores = rlcd::evaluate_pairs("handoff", &state, &questions, CLASSIFIER_TIMEOUT)
        .await
        .ok();
    let keep = pick_middle(&middle, scores.as_ref(), MAX_TURNS - 3);
    exchanges
        .into_iter()
        .enumerate()
        .filter(|(index, _)| *index == 0 || *index >= last - 1 || keep.contains(index))
        .map(|(_, exchange)| exchange)
        .collect()
}

fn pick_middle(
    middle: &[usize],
    scores: Option<&std::collections::HashMap<String, f64>>,
    budget: usize,
) -> Vec<usize> {
    let mut ranked: Vec<(usize, f64)> = middle
        .iter()
        .map(|&index| {
            let score = scores
                .and_then(|scores| scores.get(&format!("t{index}")).copied())
                // Without an answer, recency decides.
                .unwrap_or(index as f64 / 1_000_000.0);
            (index, score)
        })
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
    let mut keep: Vec<usize> = ranked
        .into_iter()
        .take(budget)
        .map(|(index, _)| index)
        .collect();
    keep.sort_unstable();
    keep
}

fn branch_state(
    repo_path: &Path,
    worktree: Option<&Path>,
    name: &str,
    branch: &str,
    target: &str,
) -> Option<String> {
    let cli = GitCli::new();
    let range = format!("{target}..{branch}");
    let commits = cli
        .git(
            repo_path,
            [
                "log",
                "--oneline",
                "--no-decorate",
                "-n",
                &(MAX_COMMITS + 1).to_string(),
                &range,
            ],
        )
        .ok()?;
    let files = cli
        .git(
            repo_path,
            ["diff", "--name-only", &format!("{target}...{branch}")],
        )
        .unwrap_or_default();
    let uncommitted = worktree
        .filter(|path| path.exists())
        .and_then(|path| cli.git(path, ["status", "--porcelain"]).ok())
        .map(|status| status.lines().filter(|line| !line.is_empty()).count())
        .unwrap_or(0);

    let commits: Vec<&str> = commits.lines().filter(|line| !line.is_empty()).collect();
    let files: Vec<&str> = files.lines().filter(|line| !line.is_empty()).collect();
    let mut out = format!("Repository `{name}`, branch `{branch}` (target `{target}`):\n");
    if commits.is_empty() {
        out.push_str("- No commits on the branch yet.\n");
    } else {
        out.push_str("- Commits:\n");
        for commit in commits.iter().take(MAX_COMMITS) {
            out.push_str(&format!("  - {commit}\n"));
        }
        if commits.len() > MAX_COMMITS {
            out.push_str("  - (older commits omitted)\n");
        }
    }
    if !files.is_empty() {
        out.push_str(&format!("- Changed files ({}): ", files.len()));
        out.push_str(
            &files
                .iter()
                .take(MAX_FILES)
                .copied()
                .collect::<Vec<_>>()
                .join(", "),
        );
        if files.len() > MAX_FILES {
            out.push_str(", …");
        }
        out.push('\n');
    }
    if uncommitted > 0 {
        out.push_str(&format!(
            "- Uncommitted changes in the worktree: {uncommitted} file(s).\n"
        ));
    }
    Some(out)
}

fn render(
    agent_summary: Option<&str>,
    git: &[String],
    stage: Option<i64>,
    exchanges: &[Exchange],
) -> String {
    let mut out = String::new();
    out.push_str(OPEN_TAG);
    out.push_str(
        "\nThis workspace was already worked on in an earlier agent session whose conversation you do not have. Use this handoff as context; verify against the files before relying on it.\n",
    );
    if let Some(summary) = agent_summary {
        out.push_str("\n## Summary written by the previous agent\n");
        out.push_str(summary);
        out.push('\n');
    }
    if !git.is_empty() {
        out.push_str("\n## Branch state\n");
        for repo in git {
            out.push_str(repo);
        }
    }
    if let Some(stage) = stage {
        out.push_str(&format!(
            "\n## Pipeline\nLast reported stage: {stage}. Call get_pipeline for the stages.\n"
        ));
    }
    if !exchanges.is_empty() {
        out.push_str(if agent_summary.is_some() {
            "\n## Exchanges after that summary\n"
        } else {
            "\n## Previous exchanges\n"
        });
        for exchange in exchanges {
            out.push_str(&format!(
                "\n[{}] User: {}\n",
                exchange.agent,
                truncate(&exchange.prompt, PROMPT_CHARS)
            ));
            if !exchange.answer.trim().is_empty() {
                out.push_str(&format!(
                    "Agent: {}\n",
                    truncate(exchange.answer.trim(), ANSWER_CHARS)
                ));
            }
        }
    }
    out.push_str(CLOSE_TAG);
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

    fn exchange(prompt: &str, answer: &str) -> Exchange {
        Exchange {
            agent: "CLAUDE_CODE".to_string(),
            prompt: prompt.to_string(),
            answer: answer.to_string(),
        }
    }

    #[test]
    fn old_handoff_blocks_are_not_repeated() {
        let prompt = format!(
            "{OPEN_TAG}\nold context\n{CLOSE_TAG}\n\n<aurapunk-memory>\nm\n</aurapunk-memory>\n\nfix the login"
        );
        assert_eq!(strip_handoff(&prompt), "fix the login");
        assert_eq!(strip_handoff("  plain  "), "plain");
    }

    #[test]
    fn agent_summary_replaces_earlier_exchanges() {
        let (summary, rest) = split_agent_summary(vec![
            exchange("build the page", "done"),
            exchange(
                &format!("{HANDOFF_SUMMARY_MARKER} summarize"),
                "the summary",
            ),
            exchange("now add tests", "added"),
        ]);
        assert_eq!(summary.as_deref(), Some("the summary"));
        assert_eq!(rest, vec![exchange("now add tests", "added")]);
    }

    #[test]
    fn unanswered_summary_request_is_dropped() {
        let (summary, rest) = split_agent_summary(vec![
            exchange("build the page", "done"),
            exchange(HANDOFF_SUMMARY_MARKER, ""),
        ]);
        assert!(summary.is_none());
        assert_eq!(rest.len(), 1);
    }

    #[test]
    fn classifier_scores_pick_the_middle() {
        let middle = [1, 2, 3, 4];
        let scores = HashMap::from([
            ("t1".to_string(), 0.9),
            ("t2".to_string(), 0.1),
            ("t3".to_string(), 0.8),
            ("t4".to_string(), 0.2),
        ]);
        assert_eq!(pick_middle(&middle, Some(&scores), 2), vec![1, 3]);
        // No classifier: the most recent ones.
        assert_eq!(pick_middle(&middle, None, 2), vec![3, 4]);
    }

    #[tokio::test]
    async fn few_exchanges_are_all_kept() {
        let exchanges = vec![exchange("a", "1"), exchange("b", "2")];
        assert_eq!(select(exchanges.clone()).await, exchanges);
    }

    #[test]
    fn render_is_wrapped_and_skips_empty_sections() {
        let text = render(None, &[], None, &[exchange("do it", "")]);
        assert!(text.starts_with(OPEN_TAG) && text.ends_with(CLOSE_TAG));
        assert!(text.contains("User: do it"));
        assert!(!text.contains("Agent:"));
        assert!(!text.contains("## Branch state"));
        assert!(!text.contains("## Pipeline"));
    }

    #[test]
    fn branch_state_reports_commits_files_and_uncommitted() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(["-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .current_dir(repo)
                .status()
                .unwrap();
            assert!(status.success());
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "base"]);
        git(&["switch", "-q", "-c", "vk/x"]);
        std::fs::write(repo.join("b.txt"), "b").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "add b"]);
        std::fs::write(repo.join("a.txt"), "changed").unwrap();

        let state = branch_state(repo, Some(repo), "r", "vk/x", "main").unwrap();
        assert!(state.contains("add b"), "{state}");
        assert!(state.contains("Changed files (1): b.txt"), "{state}");
        assert!(
            state.contains("Uncommitted changes in the worktree: 1"),
            "{state}"
        );
    }

    async fn db() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }

    async fn session(pool: &SqlitePool, workspace: Uuid, created_at: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO sessions (id, workspace_id, executor, created_at) VALUES (?, ?, 'CLAUDE_CODE', ?)",
        )
        .bind(id)
        .bind(workspace)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn turn(pool: &SqlitePool, session: Uuid, at: &str, prompt: &str, answer: &str) {
        let process = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO execution_processes (id, session_id, status, run_reason, created_at) VALUES (?, ?, 'completed', 'codingagent', ?)",
        )
        .bind(process)
        .bind(session)
        .bind(at)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO coding_agent_turns (id, execution_process_id, prompt, summary) VALUES (?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4())
        .bind(process)
        .bind(prompt)
        .bind(answer)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn new_session_in_a_worked_workspace_gets_the_handoff_once() {
        let pool = db().await;
        let workspace_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES (?, 'vk/x', 'w')")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        let workspace = Workspace::find_by_id(&pool, workspace_id)
            .await
            .unwrap()
            .unwrap();
        let first = session(&pool, workspace_id, "2026-09-27 10:00:00").await;

        // The first session of a workspace has nothing to hand over.
        assert_eq!(
            super::super::prepare_initial_prompt_with(
                &pool,
                &workspace,
                first,
                "build it".into(),
                false
            )
            .await,
            "build it"
        );

        turn(
            &pool,
            first,
            "2026-09-27 10:01:00",
            "build the login page",
            "Login page added in src/login.tsx",
        )
        .await;
        let second = session(&pool, workspace_id, "2026-09-27 11:00:00").await;
        let prompt = super::super::prepare_initial_prompt_with(
            &pool,
            &workspace,
            second,
            "now add tests".into(),
            false,
        )
        .await;
        assert!(prompt.starts_with(OPEN_TAG), "{prompt}");
        assert!(prompt.contains("User: build the login page"), "{prompt}");
        assert!(
            prompt.contains("Agent: Login page added in src/login.tsx"),
            "{prompt}"
        );
        assert!(
            prompt.ends_with(&format!("{CLOSE_TAG}\n\nnow add tests")),
            "{prompt}"
        );

        // Slash commands are never wrapped.
        assert_eq!(
            super::super::prepare_initial_prompt_with(
                &pool,
                &workspace,
                second,
                "/compact".into(),
                false
            )
            .await,
            "/compact"
        );

        // A summary the agent wrote on request replaces the raw exchanges.
        turn(
            &pool,
            first,
            "2026-09-27 10:02:00",
            &format!("{HANDOFF_SUMMARY_MARKER} write a summary"),
            "Goal: login. Done: page. Open: tests.",
        )
        .await;
        let prompt = super::super::prepare_initial_prompt_with(
            &pool,
            &workspace,
            second,
            "go".into(),
            false,
        )
        .await;
        assert!(
            prompt.contains("## Summary written by the previous agent\nGoal: login."),
            "{prompt}"
        );
        assert!(!prompt.contains("build the login page"), "{prompt}");
    }
}
