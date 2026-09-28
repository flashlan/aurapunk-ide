//! Project map: a hierarchical view of a repository built from its code
//! (ADR-054).
//!
//! Areas (crates, packages, top-level folders, the ADR index) contain modules;
//! each module carries the first sentence of its doc comment and its main
//! public items. Descriptions come from the code itself (`//!` docs, exported
//! names), `AGENTS.md`'s "Project Structure" list and the ADR titles and
//! decisions — nothing is invented, so the map is only as good as those.
//!
//! Served two ways: the `project_map` MCP tool browses it locally (instant,
//! always current), and [`sync_to_memory`] keeps one Mem0 entry per area under
//! `map-<repo>` so a semantic search ("where is X handled") lands on the right
//! module. Only entries whose text changed are rewritten.

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, SystemTime},
};

use git::GitCli;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::session_context::project_memory;

const MAX_ITEMS: usize = 8;
const MAX_SUMMARY_CHARS: usize = 220;
const ENTRY_CHARS: usize = 1500;
/// Automatic refreshes (after a merge) at most this often per repository.
const AUTO_SYNC_INTERVAL: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MapNode {
    pub path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<MapNode>,
}

static RUST_ITEM: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?m)^\s*pub\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )
    .expect("valid regex")
});
static TS_EXPORT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?m)^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|class|interface|type|enum)\s+([A-Za-z0-9_$]+)",
    )
    .expect("valid regex")
});
static STRUCTURE_ITEM: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"`([a-z][a-z0-9-]*)` \(([^)]+)\)").expect("valid regex"));

/// Build the map of the repository checked out at `root`.
pub fn build(root: &Path) -> Vec<MapNode> {
    let files = tracked_files(root);
    let descriptions = agents_descriptions(root);
    let mut areas: BTreeMap<String, MapNode> = BTreeMap::new();

    for file in &files {
        if is_test_or_generated(file) {
            continue;
        }
        let Some((area, module)) = area_and_module(file) else {
            continue;
        };
        let node = areas.entry(area.clone()).or_insert_with(|| MapNode {
            path: area.clone(),
            summary: String::new(),
            items: Vec::new(),
            children: Vec::new(),
        });
        let text = std::fs::read_to_string(root.join(file)).unwrap_or_default();
        if file.ends_with(".rs") {
            let doc = rust_module_doc(&text);
            if is_crate_root(file) && !doc.is_empty() && node.summary.is_empty() {
                node.summary = doc.clone();
            }
            let items = capture_names(&RUST_ITEM, &text);
            if !doc.is_empty() || !items.is_empty() {
                node.children.push(MapNode {
                    path: module,
                    summary: doc,
                    items,
                    children: Vec::new(),
                });
            }
        } else {
            let items = capture_names(&TS_EXPORT, &text);
            merge_ts_directory(node, &module, items);
        }
    }

    for node in areas.values_mut() {
        if node.summary.is_empty() {
            node.summary = describe_area(root, &node.path, &descriptions);
        }
        node.children.sort_by(|a, b| a.path.cmp(&b.path));
    }
    let mut map: Vec<MapNode> = areas
        .into_values()
        .filter(|node| !node.children.is_empty())
        .collect();
    if let Some(adrs) = adr_index(root, &files) {
        map.push(adrs);
    }
    map
}

/// The subtree at `path` (or the whole map), cut at `depth` levels.
pub fn view(map: &[MapNode], path: Option<&str>, depth: usize) -> Vec<MapNode> {
    let selected: Vec<MapNode> = match path.map(|p| p.trim_matches('/')).filter(|p| !p.is_empty()) {
        None => map.to_vec(),
        Some(wanted) => {
            let mut found = Vec::new();
            for area in map {
                if area.path == wanted || area.path.starts_with(&format!("{wanted}/")) {
                    found.push(area.clone());
                } else if wanted.starts_with(&format!("{}/", area.path)) {
                    let module = wanted.trim_start_matches(&format!("{}/", area.path));
                    let children: Vec<MapNode> = area
                        .children
                        .iter()
                        .filter(|child| {
                            child.path == module || child.path.starts_with(&format!("{module}/"))
                        })
                        .cloned()
                        .collect();
                    if !children.is_empty() {
                        found.push(MapNode {
                            children,
                            ..area.clone()
                        });
                    }
                }
            }
            found
        }
    };
    selected
        .into_iter()
        .map(|node| cut(node, depth.max(1)))
        .collect()
}

fn cut(mut node: MapNode, depth: usize) -> MapNode {
    if depth <= 1 {
        node.children.clear();
    } else {
        node.children = node
            .children
            .into_iter()
            .map(|child| cut(child, depth - 1))
            .collect();
    }
    node
}

/// Text entries for Mem0: an overview, then one entry per area (split when
/// long), keyed so a refresh rewrites only what changed.
pub fn memory_entries(repo: &str, map: &[MapNode]) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let overview = map
        .iter()
        .map(|area| {
            format!(
                "`{}` — {}",
                area.path,
                if area.summary.is_empty() {
                    "(no description)"
                } else {
                    &area.summary
                }
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    entries.push((
        "overview".to_string(),
        format!("Project map of {repo} — top-level areas: {overview}"),
    ));

    for area in map {
        let header = if area.summary.is_empty() {
            format!("Project map — `{}`:", area.path)
        } else {
            format!("Project map — `{}` ({}):", area.path, area.summary)
        };
        let mut part = 1;
        let mut current = header.clone();
        for child in &area.children {
            let mut line = format!(" `{}/{}`", area.path, child.path);
            if !child.summary.is_empty() {
                line.push_str(&format!(" — {}", child.summary));
            }
            if !child.items.is_empty() {
                line.push_str(&format!(" [{}]", child.items.join(", ")));
            }
            line.push(';');
            if current.len() + line.len() > ENTRY_CHARS && current.len() > header.len() {
                entries.push((format!("{}#{part}", area.path), current));
                part += 1;
                current = format!("{header} (continued)");
            }
            current.push_str(&line);
        }
        entries.push((format!("{}#{part}", area.path), current));
    }
    entries
}

/// Render for the MCP tool: indented tree, one line per node.
pub fn render_tree(nodes: &[MapNode]) -> String {
    fn walk(node: &MapNode, prefix: &str, indent: usize, out: &mut String) {
        let path = if prefix.is_empty() {
            node.path.clone()
        } else {
            format!("{prefix}/{}", node.path)
        };
        out.push_str(&"  ".repeat(indent));
        out.push_str(&path);
        if !node.summary.is_empty() {
            out.push_str(" — ");
            out.push_str(&node.summary);
        }
        if !node.items.is_empty() {
            out.push_str(&format!(" [{}]", node.items.join(", ")));
        }
        out.push('\n');
        for child in &node.children {
            walk(child, &path, indent + 1, out);
        }
    }
    let mut out = String::new();
    for node in nodes {
        walk(node, "", 0, &mut out);
    }
    out
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    /// entry key → (content hash, Mem0 point id)
    entries: HashMap<String, (String, String)>,
    synced_at: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct SyncReport {
    pub entries: usize,
    pub written: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub skipped: Option<String>,
}

fn manifest_path(repo: &str) -> PathBuf {
    utils::path::config_home_dir()
        .join("project-map")
        .join(format!("{}.json", repo.replace(['/', '\\'], "_")))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn memory_user_id(repo: &str) -> String {
    format!("map-{repo}")
}

/// Write the map of `root` to Mem0 under `map-<repo>`, rewriting only entries
/// whose text changed. `force = false` (automatic refresh) returns early when
/// the last sync was recent.
pub async fn sync_to_memory(root: PathBuf, repo: String, force: bool) -> SyncReport {
    let path = manifest_path(&repo);
    let mut manifest: Manifest = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if !force
        && manifest
            .synced_at
            .is_some_and(|at| now_secs().saturating_sub(at) < AUTO_SYNC_INTERVAL.as_secs())
    {
        return SyncReport {
            entries: manifest.entries.len(),
            written: 0,
            removed: 0,
            unchanged: manifest.entries.len(),
            skipped: Some("synced recently".to_string()),
        };
    }

    match project_memory::raw_writes_available().await {
        Ok(true) => {}
        Ok(false) => {
            return SyncReport {
                entries: 0,
                written: 0,
                removed: 0,
                unchanged: 0,
                skipped: Some("project memory is disabled or not mem0-vk".to_string()),
            };
        }
        Err(error) => return failed(0, error),
    }

    let repo_for_build = repo.clone();
    let entries =
        tokio::task::spawn_blocking(move || memory_entries(&repo_for_build, &build(&root)))
            .await
            .unwrap_or_default();
    let user_id = memory_user_id(&repo);
    let hashed: HashMap<String, (String, String)> = entries
        .into_iter()
        .map(|(key, text)| {
            let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
            (key, (hash, text))
        })
        .collect();

    // Without a manifest (first sync on this machine) the entries already in
    // Mem0 are unknown: start from a clean namespace instead of duplicating.
    if manifest.entries.is_empty()
        && let Err(error) = project_memory::forget(&user_id).await
    {
        return failed(hashed.len(), error);
    }

    let mut report = SyncReport {
        entries: hashed.len(),
        written: 0,
        removed: 0,
        unchanged: 0,
        skipped: None,
    };
    let stale: Vec<(String, String)> = manifest
        .entries
        .iter()
        .filter(|(key, (hash, _))| {
            hashed
                .get(*key)
                .is_none_or(|(new_hash, _)| new_hash != hash)
        })
        .map(|(key, (_, id))| (key.clone(), id.clone()))
        .collect();
    for (key, id) in stale {
        match project_memory::delete_point(&user_id, &id).await {
            Ok(()) => {
                manifest.entries.remove(&key);
                report.removed += 1;
            }
            // A server without scoped deletes: rebuild the namespace.
            Err(_) => {
                if let Err(error) = project_memory::forget(&user_id).await {
                    return failed(hashed.len(), error);
                }
                manifest.entries.clear();
                break;
            }
        }
    }
    for (key, (hash, text)) in &hashed {
        if manifest
            .entries
            .get(key)
            .is_some_and(|(stored, _)| stored == hash)
        {
            report.unchanged += 1;
            continue;
        }
        match project_memory::store_raw(&user_id, text).await {
            Ok(Some(id)) => {
                manifest.entries.insert(key.clone(), (hash.clone(), id));
                report.written += 1;
            }
            Ok(None) => {
                report.skipped = Some("project memory is disabled or not mem0-vk".to_string());
                return report;
            }
            Err(error) => {
                save_manifest(&path, &manifest);
                return failed(hashed.len(), error);
            }
        }
    }
    manifest.synced_at = Some(now_secs());
    save_manifest(&path, &manifest);
    report
}

fn failed(entries: usize, error: String) -> SyncReport {
    super::integration_errors::record(
        super::integration_errors::IntegrationService::Mem0,
        "project map",
        &format!("the project map was not written to Mem0: {error}"),
    );
    SyncReport {
        entries,
        written: 0,
        removed: 0,
        unchanged: 0,
        skipped: Some(error),
    }
}

fn save_manifest(path: &Path, manifest: &Manifest) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(manifest) {
        let _ = std::fs::write(path, raw);
    }
}

fn tracked_files(root: &Path) -> Vec<String> {
    GitCli::new()
        .git(root, ["ls-files"])
        .map(|out| out.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn is_test_or_generated(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.contains("/tests/")
        || lower.contains("__tests__")
        || lower.contains(".test.")
        || lower.contains(".spec.")
        || lower.contains(".stories.")
        || lower.ends_with("_test.rs")
        || lower.contains("/bindings/")
        || lower.starts_with("shared/types")
        || lower.contains("/migrations/")
        || lower.contains("/node_modules/")
}

/// `crates/<crate>/src/<module>` or `packages/<pkg>/src/<dir>/<dir>` for code
/// files; everything else is not part of the map.
fn area_and_module(file: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = file.split('/').collect();
    let is_code = file.ends_with(".rs") || file.ends_with(".ts") || file.ends_with(".tsx");
    if !is_code {
        return None;
    }
    match parts.as_slice() {
        ["crates", krate, "src", rest @ ..] if file.ends_with(".rs") && !rest.is_empty() => {
            let module = rest.join("/");
            let module = module
                .strip_suffix("/mod.rs")
                .map(str::to_string)
                .unwrap_or(module);
            Some((format!("crates/{krate}"), module))
        }
        ["packages", pkg, "src", rest @ ..] if !rest.is_empty() => {
            // Group TS by directory, two levels under src (features/<name>).
            let dir = if rest.len() > 2 {
                rest[..2].join("/")
            } else if rest.len() == 2 {
                rest[0].to_string()
            } else {
                ".".to_string()
            };
            Some((format!("packages/{pkg}"), dir))
        }
        _ => None,
    }
}

fn is_crate_root(file: &str) -> bool {
    file.ends_with("/src/lib.rs") || file.ends_with("/src/main.rs")
}

/// First sentence of the leading `//!` doc block.
fn rust_module_doc(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(doc) = trimmed.strip_prefix("//!") {
            let doc = doc.trim();
            if doc.is_empty() && !lines.is_empty() {
                break;
            }
            if !doc.is_empty() {
                lines.push(doc.to_string());
            }
        } else if trimmed.is_empty() || trimmed.starts_with("#!") || trimmed.starts_with("#![") {
            if !lines.is_empty() {
                break;
            }
        } else {
            break;
        }
    }
    first_sentence(&lines.join(" "))
}

fn first_sentence(text: &str) -> String {
    let text = text.trim();
    let end = text
        .char_indices()
        .find(|(i, c)| *c == '.' && text[i + 1..].starts_with(' '))
        .map(|(i, _)| i + 1)
        .unwrap_or(text.len());
    let sentence = &text[..end];
    if sentence.chars().count() > MAX_SUMMARY_CHARS {
        format!(
            "{}…",
            sentence.chars().take(MAX_SUMMARY_CHARS).collect::<String>()
        )
    } else {
        sentence.to_string()
    }
}

fn capture_names(pattern: &regex::Regex, text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for capture in pattern.captures_iter(text) {
        let name = capture[1].to_string();
        if !names.contains(&name) {
            names.push(name);
        }
        if names.len() == MAX_ITEMS {
            break;
        }
    }
    names
}

fn merge_ts_directory(area: &mut MapNode, dir: &str, items: Vec<String>) {
    if let Some(existing) = area.children.iter_mut().find(|child| child.path == dir) {
        for item in items {
            if existing.items.len() < MAX_ITEMS && !existing.items.contains(&item) {
                existing.items.push(item);
            }
        }
    } else if !items.is_empty() {
        area.children.push(MapNode {
            path: dir.to_string(),
            summary: String::new(),
            items,
            children: Vec::new(),
        });
    }
}

/// Crate and folder descriptions from `AGENTS.md`'s "Project Structure".
fn agents_descriptions(root: &Path) -> HashMap<String, String> {
    let text = std::fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default();
    let mut out = HashMap::new();
    let section = text
        .split("## Project Structure")
        .nth(1)
        .and_then(|rest| rest.split("\n## ").next())
        .unwrap_or_default();
    for line in section.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("- `") else {
            continue;
        };
        if let Some((path, description)) = rest.split_once("`:") {
            let path = path.trim_end_matches('/').to_string();
            if path == "crates" {
                for capture in STRUCTURE_ITEM.captures_iter(description) {
                    out.insert(format!("crates/{}", &capture[1]), capture[2].to_string());
                }
            } else {
                out.insert(path, first_sentence(description.trim()));
            }
        }
    }
    out
}

fn describe_area(root: &Path, area: &str, descriptions: &HashMap<String, String>) -> String {
    let cargo = std::fs::read_to_string(root.join(area).join("Cargo.toml")).unwrap_or_default();
    if let Some(description) = cargo
        .lines()
        .find_map(|line| line.trim().strip_prefix("description"))
        .and_then(|rest| rest.trim_start().strip_prefix('='))
        .map(|value| value.trim().trim_matches('"'))
        .filter(|value| !value.is_empty())
    {
        return first_sentence(description);
    }
    if let Some(description) = descriptions.get(area) {
        return description.clone();
    }
    let package = std::fs::read_to_string(root.join(area).join("package.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&package)
        .ok()
        .and_then(|value| value.get("description")?.as_str().map(first_sentence))
        .unwrap_or_default()
}

/// `docs/ADR`: title and the first sentence of each decision.
fn adr_index(root: &Path, files: &[String]) -> Option<MapNode> {
    let mut children = Vec::new();
    for file in files
        .iter()
        .filter(|f| f.starts_with("docs/ADR/") && f.ends_with(".md"))
    {
        let text = std::fs::read_to_string(root.join(file)).unwrap_or_default();
        let title = text
            .lines()
            .find_map(|line| line.strip_prefix("# "))
            .unwrap_or_default()
            .trim()
            .to_string();
        let decision = text
            .split("## Decision")
            .nth(1)
            .and_then(|rest| {
                rest.lines()
                    .map(|line| {
                        line.trim()
                            .trim_start_matches(['-', '*', ' '])
                            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.')
                            .trim()
                    })
                    .find(|line| !line.is_empty() && !line.starts_with('#'))
                    .map(first_sentence)
            })
            .unwrap_or_default();
        let name = file
            .trim_start_matches("docs/ADR/")
            .trim_end_matches(".md")
            .to_string();
        children.push(MapNode {
            path: name,
            summary: if decision.is_empty() {
                title
            } else {
                format!("{title}: {decision}")
            },
            items: Vec::new(),
            children: Vec::new(),
        });
    }
    (!children.is_empty()).then(|| MapNode {
        path: "docs/ADR".to_string(),
        summary: "Architecture Decision Records".to_string(),
        items: Vec::new(),
        children,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let write = |path: &str, text: &str| {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        };
        write(
            "AGENTS.md",
            "# X\n\n## Project Structure\n- `crates/`: Rust crates — `git` (Git operations), `db` (SQLx models)\n- `docs/`: Documentation files.\n\n## Other\n",
        );
        write(
            "crates/git/src/lib.rs",
            "//! Git service.\n//! More detail.\n\npub mod cli;\npub struct GitService;\n",
        );
        write(
            "crates/git/src/cli.rs",
            "//! Wrapper around the git CLI. Second sentence.\n\npub struct GitCli;\nimpl GitCli {\n    pub fn merge_tree_conflicts() {}\n}\n",
        );
        write("crates/git/src/private.rs", "fn hidden() {}\n");
        write("crates/git/tests/safety.rs", "//! test\npub fn t() {}\n");
        write(
            "packages/web/package.json",
            "{\"description\": \"The web app. Built with Vite.\"}",
        );
        write(
            "packages/web/src/features/chat/ui/Box.tsx",
            "export function ChatBox() {}\n",
        );
        write(
            "packages/web/src/features/chat/model/store.ts",
            "export const useChat = 1;\n",
        );
        write(
            "docs/ADR/ADR-001-x.md",
            "# ADR-001: Queue merges\n\n## Decision\n\n- Transient refusals are queued. Then retried.\n",
        );
        let status = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(root)
            .status()
            .unwrap();
        assert!(status.success());
        let status = std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(root)
            .status()
            .unwrap();
        assert!(status.success());
        dir
    }

    #[test]
    fn builds_areas_modules_and_adrs_from_the_code() {
        let dir = repo();
        let map = build(dir.path());
        let git = map.iter().find(|n| n.path == "crates/git").unwrap();
        assert_eq!(git.summary, "Git service.");
        let cli = git.children.iter().find(|n| n.path == "cli.rs").unwrap();
        assert_eq!(cli.summary, "Wrapper around the git CLI.");
        assert!(cli.items.contains(&"GitCli".to_string()));
        assert!(cli.items.contains(&"merge_tree_conflicts".to_string()));
        assert!(
            git.children.iter().all(|n| n.path != "private.rs"),
            "no doc, no pub items"
        );
        assert!(
            git.children.iter().all(|n| !n.path.contains("safety")),
            "tests skipped"
        );

        let web = map.iter().find(|n| n.path == "packages/web").unwrap();
        assert_eq!(web.summary, "The web app.");
        let chat = web
            .children
            .iter()
            .find(|n| n.path == "features/chat")
            .unwrap();
        assert_eq!(
            chat.items,
            vec!["useChat".to_string(), "ChatBox".to_string()]
        );

        let adrs = map.iter().find(|n| n.path == "docs/ADR").unwrap();
        assert_eq!(
            adrs.children[0].summary,
            "ADR-001: Queue merges: Transient refusals are queued."
        );
    }

    #[test]
    fn view_selects_subtrees_and_cuts_depth() {
        let dir = repo();
        let map = build(dir.path());
        let top = view(&map, None, 1);
        assert!(top.iter().all(|n| n.children.is_empty()));
        let cli = view(&map, Some("crates/git/cli.rs"), 2);
        assert_eq!(cli.len(), 1);
        assert_eq!(cli[0].children.len(), 1);
        let tree = render_tree(&view(&map, Some("crates/git"), 2));
        assert!(
            tree.contains(
                "crates/git/cli.rs — Wrapper around the git CLI. [GitCli, merge_tree_conflicts]"
            ),
            "{tree}"
        );
    }

    #[test]
    fn memory_entries_have_stable_keys_and_bounded_size() {
        let dir = repo();
        let entries = memory_entries("demo", &build(dir.path()));
        assert_eq!(entries[0].0, "overview");
        assert!(entries[0].1.contains("`crates/git` — Git service."));
        let git = entries
            .iter()
            .find(|(key, _)| key == "crates/git#1")
            .unwrap();
        assert!(
            git.1
                .contains("`crates/git/cli.rs` — Wrapper around the git CLI."),
            "{}",
            git.1
        );
        assert!(
            entries
                .iter()
                .all(|(_, text)| text.len() <= ENTRY_CHARS + 400)
        );
    }

    #[test]
    fn cargo_description_wins_over_agents_md() {
        let dir = repo();
        std::fs::create_dir_all(dir.path().join("crates/db")).unwrap();
        std::fs::write(
            dir.path().join("crates/db/Cargo.toml"),
            "[package]\nname = \"db\"\ndescription = \"SQLite models. More.\"\n",
        )
        .unwrap();
        let descriptions = agents_descriptions(dir.path());
        assert_eq!(
            describe_area(dir.path(), "crates/db", &descriptions),
            "SQLite models."
        );
    }

    #[test]
    fn agents_structure_describes_crates_without_docs() {
        let dir = repo();
        let descriptions = agents_descriptions(dir.path());
        assert_eq!(
            descriptions.get("crates/db").map(String::as_str),
            Some("SQLx models")
        );
        assert_eq!(
            descriptions.get("docs").map(String::as_str),
            Some("Documentation files.")
        );
    }
}
