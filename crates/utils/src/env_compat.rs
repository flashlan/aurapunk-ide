//! Environment-variable lookup with AuraPunk-first, legacy Vibe Kanban fallback.
//!
//! The project was renamed from Vibe Kanban to AuraPunk. Renamed variables keep
//! working through their previous names so existing shells, CI jobs, launcher
//! scripts, and agent configs do not break during (or after) the transition.
//! Each lookup tries the canonical `AURAPUNK_*` name first and only falls back
//! to the legacy `VIBE_*` name when the canonical one is unset or empty.

/// Return the first non-empty value among `keys`, in order.
pub fn get(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| match std::env::var(key) {
        Ok(value) if !value.is_empty() => Some(value),
        _ => None,
    })
}

/// Return the first non-empty [`std::ffi::OsString`] value among `keys`, in
/// order. Use this for paths, which may not be valid UTF-8.
pub fn get_os(keys: &[&str]) -> Option<std::ffi::OsString> {
    keys.iter().find_map(|key| match std::env::var_os(key) {
        Some(value) if !value.is_empty() => Some(value),
        _ => None,
    })
}

/// Resolve a single renamed variable: `AURAPUNK_<suffix>` then
/// `VIBE_KANBAN_<suffix>`, then the older short `VIBE_<suffix>` prefix.
pub fn renamed(suffix: &str) -> Option<String> {
    get(&[
        &format!("AURAPUNK_{suffix}"),
        &format!("VIBE_KANBAN_{suffix}"),
        &format!("VIBE_{suffix}"),
    ])
}

/// Path-valued counterpart of [`renamed`].
pub fn renamed_os(suffix: &str) -> Option<std::ffi::OsString> {
    get_os(&[
        &format!("AURAPUNK_{suffix}"),
        &format!("VIBE_KANBAN_{suffix}"),
        &format!("VIBE_{suffix}"),
    ])
}
