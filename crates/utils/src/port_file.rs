use std::{env, path::PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

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
