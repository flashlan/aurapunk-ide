use std::{env, path::PathBuf, sync::OnceLock};

use serde::{Deserialize, Serialize};
use tokio::fs;

/// The port this process' own backend is bound to, learned when the port file
/// is written at startup.
///
/// The on-disk port file is a single global path shared by every AuraPunk
/// server on the machine (dev server, packaged Tauri app, …): the last writer
/// wins. A coding agent spawned by one instance can therefore read a *different*
/// instance's port, and its MCP child loses the workspace context (the tools
/// then fail with "workspace_id is required"). Remembering our own port here
/// lets the spawning server hand its agents an unambiguous
/// `AURAPUNK_BACKEND_URL` env var, which the MCP client prefers over the file.
static ACTIVE_PORT: OnceLock<u16> = OnceLock::new();

/// The port this process' own backend bound to, if known.
///
/// `None` until [`write_port_file_with_proxy`] has run (i.e. before the server
/// is listening).
pub fn active_port() -> Option<u16> {
    ACTIVE_PORT.get().copied()
}

/// Build the backend base URL for this process' own server, or `None` when the
/// port isn't known yet. Matches `aurapunk_mcp`'s own resolution (host
/// `localhost`, so macOS' `::1`-first resolution works).
pub fn active_backend_url() -> Option<String> {
    active_port().map(backend_url_for_port)
}

/// Format the backend base URL for a bound port. Kept pure so the shape is
/// testable without touching the process-global [`ACTIVE_PORT`].
fn backend_url_for_port(port: u16) -> String {
    format!("http://localhost:{port}")
}

/// Path of the persisted "preferred UI port" file, kept next to the database.
///
/// The packaged app's webview origin is `http://localhost:<port>`, and
/// `localStorage` is keyed by origin. With a fresh OS-assigned port every
/// launch the origin changes each time, so every browser-side preference (Jev
/// API key, engine selection, layered theme choices, …) lands in a per-launch
/// store and is silently lost on the next start. Persisting the port lets the
/// server reuse it whenever it is still free.
pub fn preferred_ui_port_path() -> PathBuf {
    crate::assets::asset_dir().join("ui-port.txt")
}

/// The last UI port this machine bound to, if it was recorded.
pub fn read_preferred_ui_port() -> Option<u16> {
    let content = std::fs::read_to_string(preferred_ui_port_path()).ok()?;
    parse_preferred_ui_port(&content)
}

/// Parse the persisted port, rejecting blanks, junk, and port 0 (which would
/// mean "let the OS choose").
fn parse_preferred_ui_port(content: &str) -> Option<u16> {
    content.trim().parse::<u16>().ok().filter(|port| *port != 0)
}

/// Remember the port the UI/webview was served from, so the next launch can
/// reuse it and keep the origin (and its `localStorage`) stable.
pub fn write_preferred_ui_port(port: u16) -> std::io::Result<()> {
    std::fs::write(preferred_ui_port_path(), port.to_string())
}

/// Canonical application name used for the runtime port file, and its
/// pre-rename (Vibe Kanban) counterpart. The rename from Vibe Kanban to
/// AuraPunk must not orphan the port file: writers keep both files up to date
/// and readers fall back to the legacy name.
pub const PORT_FILE_APP: &str = "aurapunk";
pub const PORT_FILE_APP_LEGACY: &str = "vibe-kanban";

#[derive(Debug, Serialize, Deserialize)]
pub struct PortInfo {
    pub main_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_proxy_port: Option<u16>,
}

pub async fn write_port_file_with_proxy(
    main_port: u16,
    preview_proxy_port: Option<u16>,
) -> std::io::Result<PathBuf> {
    let port_info = PortInfo {
        main_port,
        preview_proxy_port,
    };
    let content = serde_json::to_string(&port_info)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Remember our own port before touching the shared file, so an executor
    // spawned later in this process can inject the correct backend URL even if
    // another instance overwrites the file in the meantime.
    let _ = ACTIVE_PORT.set(main_port);

    let mut canonical = None;
    for app in [PORT_FILE_APP, PORT_FILE_APP_LEGACY] {
        let dir = env::temp_dir().join(app);
        let path = dir.join(format!("{app}.port"));
        tracing::debug!("Writing ports {:?} to {:?}", port_info, path);
        fs::create_dir_all(&dir).await?;
        fs::write(&path, &content).await?;
        canonical.get_or_insert(path);
    }

    Ok(canonical.expect("at least one port file is always written"))
}

pub async fn read_port_file(app_name: &str) -> std::io::Result<u16> {
    read_port_info(app_name).await.map(|info| info.main_port)
}

pub async fn read_port_info(app_name: &str) -> std::io::Result<PortInfo> {
    let mut last_err = None;
    for app in candidate_app_names(app_name) {
        match read_port_info_for(app).await {
            Ok(info) => return Ok(info),
            Err(err) => last_err = Some(err),
        }
    }

    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no port file candidates")
    }))
}

/// Canonical name first, then the legacy Vibe Kanban name. Callers passing an
/// unrelated `app_name` only ever read that name.
fn candidate_app_names(app_name: &str) -> Vec<&str> {
    if app_name == PORT_FILE_APP {
        vec![PORT_FILE_APP, PORT_FILE_APP_LEGACY]
    } else {
        vec![app_name]
    }
}

async fn read_port_info_for(app_name: &str) -> std::io::Result<PortInfo> {
    let dir = env::temp_dir().join(app_name);
    let path = dir.join(format!("{app_name}.port"));
    tracing::debug!("Reading port from {:?}", path);

    let content = fs::read_to_string(&path).await?;

    if let Ok(port_info) = serde_json::from_str::<PortInfo>(&content) {
        return Ok(port_info);
    }

    let port: u16 = content
        .trim()
        .parse()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    Ok(PortInfo {
        main_port: port,
        preview_proxy_port: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{backend_url_for_port, parse_preferred_ui_port};

    #[test]
    fn backend_url_uses_localhost_and_the_given_port() {
        assert_eq!(backend_url_for_port(3002), "http://localhost:3002");
        assert_eq!(backend_url_for_port(51182), "http://localhost:51182");
    }

    #[test]
    fn preferred_ui_port_parses_trimmed_numbers() {
        assert_eq!(parse_preferred_ui_port("51182"), Some(51182));
        assert_eq!(parse_preferred_ui_port("  50412\n"), Some(50412));
    }

    #[test]
    fn preferred_ui_port_rejects_junk_and_zero() {
        assert_eq!(parse_preferred_ui_port(""), None);
        assert_eq!(parse_preferred_ui_port("0"), None);
        assert_eq!(parse_preferred_ui_port("not-a-port"), None);
        assert_eq!(parse_preferred_ui_port("70000"), None);
    }
}
