use std::path::{Path, PathBuf};

/// Directory name for storing attachments in worktrees
pub const VIBE_ATTACHMENTS_DIR: &str = ".vibe-attachments";

/// Directories that should always be skipped regardless of gitignore.
/// .git is not in .gitignore but should never be watched.
pub const ALWAYS_SKIP_DIRS: &[&str] = &[".git", "node_modules"];

/// Convert absolute paths to relative paths based on worktree path
/// This is a robust implementation that handles symlinks and edge cases
pub fn make_path_relative(path: &str, worktree_path: &str) -> String {
    tracing::trace!("Making path relative: {} -> {}", path, worktree_path);

    let path_obj = normalize_macos_private_alias(Path::new(&path));
    let worktree_path_obj = normalize_macos_private_alias(Path::new(worktree_path));

    // If path is already relative, return as is
    if path_obj.is_relative() {
        return path.to_string();
    }

    if let Ok(relative_path) = path_obj.strip_prefix(&worktree_path_obj) {
        let result = relative_path.to_string_lossy().to_string();
        tracing::trace!("Successfully made relative: '{}' -> '{}'", path, result);
        if result.is_empty() {
            return ".".to_string();
        }
        return result;
    }

    if !path_obj.exists() || !worktree_path_obj.exists() {
        return path.to_string();
    }

    // canonicalize may fail if paths don't exist
    let canonical_path = std::fs::canonicalize(&path_obj);
    let canonical_worktree = std::fs::canonicalize(&worktree_path_obj);

    match (canonical_path, canonical_worktree) {
        (Ok(canon_path), Ok(canon_worktree)) => {
            tracing::trace!(
                "Trying canonical path resolution: '{}' -> '{}', '{}' -> '{}'",
                path,
                canon_path.display(),
                worktree_path,
                canon_worktree.display()
            );

            match canon_path.strip_prefix(&canon_worktree) {
                Ok(relative_path) => {
                    let result = relative_path.to_string_lossy().to_string();
                    tracing::trace!(
                        "Successfully made relative with canonical paths: '{}' -> '{}'",
                        path,
                        result
                    );
                    if result.is_empty() {
                        return ".".to_string();
                    }
                    result
                }
                Err(e) => {
                    tracing::trace!(
                        "Failed to make canonical path relative: '{}' relative to '{}', error: {}, returning original",
                        canon_path.display(),
                        canon_worktree.display(),
                        e
                    );
                    path.to_string()
                }
            }
        }
        _ => {
            tracing::trace!(
                "Could not canonicalize paths (paths may not exist): '{}', '{}', returning original",
                path,
                worktree_path
            );
            path.to_string()
        }
    }
}

/// Normalize macOS prefix /private/var/ and /private/tmp/ to their public aliases without resolving paths.
/// This allows prefix normalization to work when the full paths don't exist.
pub fn normalize_macos_private_alias<P: AsRef<Path>>(p: P) -> PathBuf {
    let p = p.as_ref();
    if cfg!(target_os = "macos")
        && let Some(s) = p.to_str()
    {
        if s == "/private/var" {
            return PathBuf::from("/var");
        }
        if let Some(rest) = s.strip_prefix("/private/var/") {
            return PathBuf::from(format!("/var/{rest}"));
        }
        if s == "/private/tmp" {
            return PathBuf::from("/tmp");
        }
        if let Some(rest) = s.strip_prefix("/private/tmp/") {
            return PathBuf::from(format!("/tmp/{rest}"));
        }
    }
    p.to_path_buf()
}

/// Legacy Vibe Kanban directory names. Release installs used `.vibe-kanban`
/// and debug builds `.vibe-kanban-dev`; both are still honored so live data
/// written before the rename keeps working.
const LEGACY_HOME_DIR: &str = ".vibe-kanban";
const LEGACY_HOME_DIR_DEV: &str = ".vibe-kanban-dev";

pub fn get_aurapunk_temp_dir() -> std::path::PathBuf {
    let dir_name = if cfg!(debug_assertions) {
        "aurapunk-dev"
    } else {
        "aurapunk"
    };

    if cfg!(target_os = "macos") {
        // macOS already uses /var/folders/... which is persistent storage
        std::env::temp_dir().join(dir_name)
    } else if cfg!(target_os = "linux") {
        // Linux: use /var/tmp instead of /tmp to avoid RAM usage
        std::path::PathBuf::from("/var/tmp").join(dir_name)
    } else {
        // Windows and other platforms: use temp dir with aurapunk subdirectory
        std::env::temp_dir().join(dir_name)
    }
}

/// Persistent AuraPunk home directory: `~/.aurapunk` (or `~/.aurapunk-dev` for
/// debug builds, so dev and release worktrees/state never collide). This is the
/// same convention used for `telegram.toml`/`projects.toml`.
///
/// Resolution order:
/// 1. `$AURAPUNK_HOME_DIR` (legacy: `$VIBE_KANBAN_HOME_DIR`).
/// 2. `~/.aurapunk` when it already exists, or when no legacy directory exists.
/// 3. `~/.vibe-kanban` (pre-rename name) when only that directory exists, so
///    migration never orphans existing data.
///
/// Falls back to [`get_aurapunk_temp_dir`] when the home directory can't be
/// determined.
pub fn get_aurapunk_home_dir() -> std::path::PathBuf {
    if let Some(dir) = crate::env_compat::renamed_os("HOME_DIR") {
        return PathBuf::from(dir);
    }

    let (dir_name, legacy_name) = if cfg!(debug_assertions) {
        (".aurapunk-dev", LEGACY_HOME_DIR_DEV)
    } else {
        (".aurapunk", LEGACY_HOME_DIR)
    };

    let Some(home) = dirs::home_dir() else {
        return get_aurapunk_temp_dir();
    };

    let dir = home.join(dir_name);
    let legacy_dir = home.join(legacy_name);
    if dir.exists() || !legacy_dir.exists() {
        dir
    } else {
        legacy_dir
    }
}

/// Directory holding the user-editable pipeline definition files
/// (`~/.aurapunk/pipelines/*.toml`, legacy `~/.vibe-kanban/pipelines`, or the
/// `-dev` variants in debug builds). Each `*.toml` file is one selectable card
/// pipeline.
pub fn pipelines_dir() -> PathBuf {
    get_aurapunk_home_dir().join("pipelines")
}

/// Directory holding the user-editable recurrent routine definition files
/// (`~/.aurapunk/recurrent/*.toml`, legacy `~/.vibe-kanban/recurrent`, or the
/// `-dev` variants in debug builds). Each `*.toml` file is one scheduled
/// routine; the file stem is the routine id.
pub fn recurrent_dir() -> PathBuf {
    get_aurapunk_home_dir().join("recurrent")
}

/// Home directory for shared config files (`telegram.toml`, `projects.toml`,
/// `gitea.toml`, `memory.toml`).
///
/// Unlike [`get_aurapunk_home_dir`] this is intentionally NOT debug-suffixed:
/// these files are shared by dev and release builds. It prefers `~/.aurapunk`
/// and falls back to the legacy `~/.vibe-kanban` when only that directory
/// exists, so the rename never orphans existing configuration.
pub fn config_home_dir() -> PathBuf {
    if let Some(dir) = crate::env_compat::renamed_os("HOME_DIR") {
        return PathBuf::from(dir);
    }

    let Some(home) = dirs::home_dir() else {
        return crate::assets::asset_dir();
    };

    let dir = home.join(".aurapunk");
    let legacy_dir = home.join(LEGACY_HOME_DIR);
    if dir.exists() || !legacy_dir.exists() {
        dir
    } else {
        legacy_dir
    }
}

/// Outcome of [`migrate_legacy_dir`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DirMigration {
    /// The whole legacy directory was renamed to the target.
    pub moved: bool,
    /// Entries moved one by one into an already existing target.
    pub merged: Vec<String>,
    /// Entries left in the legacy directory because the target has the same
    /// name; the legacy directory then stays a real directory.
    pub conflicts: Vec<String>,
    /// The legacy path now is a symlink to the target.
    pub linked: bool,
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// Whether `legacy` is a symlink resolving to `target`.
pub fn is_linked_to(legacy: &Path, target: &Path) -> bool {
    is_symlink(legacy)
        && match (std::fs::canonicalize(legacy), std::fs::canonicalize(target)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
}

/// Move a pre-rename directory to its new name and leave a symlink behind.
///
/// Absolute paths into the legacy directory live on elsewhere — worktree
/// paths in the database, Git's `.git/worktrees/*/gitdir`, MCP launcher
/// scripts registered in other tools — so the legacy path must keep
/// resolving. A same-filesystem rename is atomic and keeps open files valid.
/// When both directories exist, entries missing from the target are moved
/// and name clashes are left in place (reported as conflicts). Idempotent;
/// Unix only (symlinks need privileges on Windows, where the legacy
/// directory simply stays in use).
pub fn migrate_legacy_dir(legacy: &Path, target: &Path) -> std::io::Result<DirMigration> {
    let mut outcome = DirMigration::default();
    if !cfg!(unix) || is_symlink(legacy) || !legacy.is_dir() || is_symlink(target) {
        outcome.linked = is_linked_to(legacy, target);
        return Ok(outcome);
    }

    if !target.exists() {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(legacy, target)?;
        outcome.moved = true;
    } else {
        for entry in std::fs::read_dir(legacy)? {
            let entry = entry?;
            let name = entry.file_name();
            let destination = target.join(&name);
            if std::fs::symlink_metadata(&destination).is_ok() {
                outcome.conflicts.push(name.to_string_lossy().into_owned());
            } else {
                std::fs::rename(entry.path(), &destination)?;
                outcome.merged.push(name.to_string_lossy().into_owned());
            }
        }
        if !outcome.conflicts.is_empty() {
            return Ok(outcome);
        }
        std::fs::remove_dir(legacy)?;
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(target, legacy)?;
    outcome.linked = true;
    Ok(outcome)
}

fn migrated_prefixes() -> &'static std::sync::Mutex<Vec<(PathBuf, PathBuf)>> {
    static PREFIXES: std::sync::OnceLock<std::sync::Mutex<Vec<(PathBuf, PathBuf)>>> =
        std::sync::OnceLock::new();
    PREFIXES.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Remember that `legacy` now resolves to `target`, so paths stored under the
/// legacy name are still recognized (see [`legacy_aliases`]).
pub fn register_migrated_prefix(legacy: PathBuf, target: PathBuf) {
    let mut prefixes = migrated_prefixes().lock().unwrap();
    if !prefixes.iter().any(|(l, t)| *l == legacy && *t == target) {
        prefixes.push((legacy, target));
    }
}

/// Every registered `(legacy, target)` pair.
pub fn registered_migrated_prefixes() -> Vec<(PathBuf, PathBuf)> {
    migrated_prefixes().lock().unwrap().clone()
}

/// Pre-rename spellings of `path`: for each migrated directory that contains
/// `path`, the same path under the legacy name. Used to match records written
/// before the rename.
pub fn legacy_aliases(path: &Path) -> Vec<PathBuf> {
    registered_migrated_prefixes()
        .into_iter()
        .filter_map(|(legacy, target)| {
            path.strip_prefix(&target)
                .ok()
                .map(|rest| legacy.join(rest))
        })
        .collect()
}

/// Rename the pre-rename home directories (`~/.vibe-kanban` →
/// `~/.aurapunk`, `~/.vibe-kanban-dev` → `~/.aurapunk-dev`) and register them.
/// Skipped when the home directory is overridden by environment.
pub fn migrate_legacy_home_dirs() {
    if crate::env_compat::renamed_os("HOME_DIR").is_some() {
        return;
    }
    let Some(home) = dirs::home_dir() else {
        return;
    };
    for (legacy, current) in [
        (LEGACY_HOME_DIR, ".aurapunk"),
        (LEGACY_HOME_DIR_DEV, ".aurapunk-dev"),
    ] {
        let legacy = home.join(legacy);
        let target = home.join(current);
        match migrate_legacy_dir(&legacy, &target) {
            Ok(outcome) => {
                if outcome.moved || !outcome.merged.is_empty() {
                    tracing::info!(
                        from = %legacy.display(),
                        to = %target.display(),
                        ?outcome,
                        "migrated legacy home directory"
                    );
                }
                if !outcome.conflicts.is_empty() {
                    tracing::warn!(
                        from = %legacy.display(),
                        to = %target.display(),
                        conflicts = ?outcome.conflicts,
                        "legacy home directory kept: entries exist in both places"
                    );
                }
                if outcome.linked {
                    register_migrated_prefix(legacy, target);
                }
            }
            Err(error) => tracing::warn!(
                from = %legacy.display(),
                to = %target.display(),
                %error,
                "could not migrate legacy home directory"
            ),
        }
    }
}

/// The opencode global config directory, matching opencode-ai's own XDG-style
/// resolution (`$XDG_CONFIG_HOME`, else `$HOME/.config/opencode`) — NOT the
/// platform-default config dir — so it lines up with where opencode actually
/// reads `agents/*.md` and `opencode.json`. Used to seed the bundled aurapunk
/// subagent definitions.
pub fn opencode_config_dir() -> PathBuf {
    if let Ok(xdg_config) = std::env::var("XDG_CONFIG_HOME")
        && !xdg_config.is_empty()
    {
        return PathBuf::from(xdg_config).join("opencode");
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".config").join("opencode")
}

/// Expand leading ~ to user's home directory.
pub fn expand_tilde(path_str: &str) -> std::path::PathBuf {
    shellexpand::tilde(path_str).as_ref().into()
}

#[cfg(all(test, unix))]
mod legacy_dir_tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aurapunk-migrate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn moves_and_links_when_target_is_missing() {
        let root = temp();
        let legacy = root.join(".vibe-kanban");
        let target = root.join(".aurapunk");
        std::fs::create_dir_all(legacy.join("worktrees/ws1")).unwrap();
        std::fs::write(legacy.join("rlcd.toml"), "x").unwrap();

        let outcome = migrate_legacy_dir(&legacy, &target).unwrap();
        assert!(outcome.moved && outcome.linked);
        assert_eq!(
            std::fs::read_to_string(target.join("rlcd.toml")).unwrap(),
            "x"
        );
        // Old absolute paths keep resolving through the symlink.
        assert!(legacy.join("worktrees/ws1").is_dir());
        assert!(is_linked_to(&legacy, &target));

        // Idempotent.
        let again = migrate_legacy_dir(&legacy, &target).unwrap();
        assert_eq!(
            again,
            DirMigration {
                linked: true,
                ..Default::default()
            }
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merges_into_existing_target_and_keeps_conflicts() {
        let root = temp();
        let legacy = root.join(".vibe-kanban");
        let target = root.join(".aurapunk");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(legacy.join("only-legacy.toml"), "a").unwrap();
        std::fs::write(legacy.join("both.toml"), "legacy").unwrap();
        std::fs::write(target.join("both.toml"), "new").unwrap();

        let outcome = migrate_legacy_dir(&legacy, &target).unwrap();
        assert_eq!(outcome.merged, vec!["only-legacy.toml".to_string()]);
        assert_eq!(outcome.conflicts, vec!["both.toml".to_string()]);
        assert!(!outcome.linked && legacy.is_dir() && !is_symlink(&legacy));
        assert_eq!(
            std::fs::read_to_string(target.join("both.toml")).unwrap(),
            "new"
        );

        // Once the clash is resolved, the next run finishes the migration.
        std::fs::remove_file(legacy.join("both.toml")).unwrap();
        let outcome = migrate_legacy_dir(&legacy, &target).unwrap();
        assert!(outcome.linked && is_linked_to(&legacy, &target));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_aliases_map_new_paths_back() {
        let root = temp();
        let legacy = root.join("legacy-home");
        let target = root.join("new-home");
        register_migrated_prefix(legacy.clone(), target.clone());
        assert_eq!(
            legacy_aliases(&target.join("worktrees/ws1")),
            vec![legacy.join("worktrees/ws1")]
        );
        assert!(legacy_aliases(&root.join("elsewhere")).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_make_path_relative() {
        // Test with relative path (should remain unchanged)
        assert_eq!(
            make_path_relative("src/main.rs", "/tmp/test-worktree"),
            "src/main.rs"
        );

        // Test with absolute path (should become relative if possible)
        let test_worktree = "/tmp/test-worktree";
        let absolute_path = format!("{test_worktree}/src/main.rs");
        let result = make_path_relative(&absolute_path, test_worktree);
        assert_eq!(result, "src/main.rs");

        // Test with path outside worktree (should return original)
        assert_eq!(
            make_path_relative("/other/path/file.js", "/tmp/test-worktree"),
            "/other/path/file.js"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_make_path_relative_macos_private_alias() {
        // Simulate a worktree under /var with a path reported under /private/var
        let worktree = "/var/folders/zz/abc123/T/vibe-kanban-dev/worktrees/vk-test";
        let path_under_private = format!(
            "/private/var{}/hello-world.txt",
            worktree.strip_prefix("/var").unwrap()
        );
        assert_eq!(
            make_path_relative(&path_under_private, worktree),
            "hello-world.txt"
        );

        // Also handle the inverse: worktree under /private and path under /var
        let worktree_private = format!("/private{worktree}");
        let path_under_var = format!("{worktree}/hello-world.txt");
        assert_eq!(
            make_path_relative(&path_under_var, &worktree_private),
            "hello-world.txt"
        );
    }
}
