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
