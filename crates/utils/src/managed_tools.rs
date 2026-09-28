//! Tools the app provisions itself when the machine lacks them (Node.js for
//! the npm/npx-based coding agents, Git on Windows), installed per user under
//! the app's data dir — no administrator rights, no system package manager.
//! A clean Windows (the Microsoft Store certification machine) has neither.
//!
//! Install scripts put each tool under [`managed_root`]; the backend puts the
//! discovered bin dirs on its own `PATH` at startup and after every install,
//! so agents spawned afterwards find them.

use std::path::{Path, PathBuf};

/// `<data-local>/AuraPunk/tools` (e.g. `%LOCALAPPDATA%\AuraPunk\tools`,
/// `~/Library/Application Support/AuraPunk/tools`, `~/.local/share/...`).
pub fn managed_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("AuraPunk")
        .join("tools")
}

/// Bin directories of the managed tools that are present: the Node.js dir
/// holding `npm` (Windows: the version dir itself; Unix: its `bin`), and on
/// Windows MinGit's `cmd`.
pub fn managed_bin_dirs() -> Vec<PathBuf> {
    managed_bin_dirs_in(&managed_root())
}

fn managed_bin_dirs_in(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    if let Ok(entries) = std::fs::read_dir(root.join("node")) {
        let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        versions.sort();
        // Newest version last; take the newest that is complete.
        for version in versions.into_iter().rev() {
            let bin = if cfg!(windows) {
                version.clone()
            } else {
                version.join("bin")
            };
            if bin.join(npm).is_file() {
                dirs.push(bin);
                break;
            }
        }
    }
    let git_cmd = root.join("git").join("cmd");
    if git_cmd
        .join(if cfg!(windows) { "git.exe" } else { "git" })
        .is_file()
    {
        dirs.push(git_cmd);
    }
    dirs
}

/// Prepend the managed bin dirs to this process's `PATH` (idempotent).
/// Returns whether `PATH` changed.
pub fn add_managed_tools_to_path() -> bool {
    let dirs = managed_bin_dirs();
    if dirs.is_empty() {
        return false;
    }
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let current: Vec<PathBuf> = std::env::split_paths(&existing).collect();
    let missing: Vec<PathBuf> = dirs
        .into_iter()
        .filter(|dir| !current.contains(dir))
        .collect();
    if missing.is_empty() {
        return false;
    }
    let merged = std::env::join_paths(missing.iter().cloned().chain(current)).unwrap_or(existing);
    tracing::info!(dirs = ?missing, "added managed tools to PATH");
    // SAFETY: called at startup and from the install route; PATH is only read
    // by child-process spawns, which copy the environment.
    unsafe { std::env::set_var("PATH", merged) };
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_newest_complete_node_and_git() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let bin = |version: &str| {
            let base = root.join("node").join(version);
            if cfg!(windows) {
                base
            } else {
                base.join("bin")
            }
        };
        for version in ["node-v20.0.0-x", "node-v22.1.0-x"] {
            std::fs::create_dir_all(bin(version)).unwrap();
            std::fs::write(bin(version).join(npm), "").unwrap();
        }
        // Incomplete download: no npm.
        std::fs::create_dir_all(bin("node-v23.0.0-x")).unwrap();
        let found = managed_bin_dirs_in(root);
        assert_eq!(found, vec![bin("node-v22.1.0-x")]);

        let git = root.join("git").join("cmd");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join(if cfg!(windows) { "git.exe" } else { "git" }), "").unwrap();
        assert_eq!(managed_bin_dirs_in(root).len(), 2);
    }
}
