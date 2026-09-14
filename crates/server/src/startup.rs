use std::{
    collections::HashSet,
    fs, io,
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use deployment::{Deployment, DeploymentError};
use serde::Serialize;
use services::services::container::ContainerService;
use tokio_util::sync::CancellationToken;
use tower_http::validate_request::ValidateRequestHeaderLayer;
use utils::{assets::asset_dir, port_file::write_port_file_with_proxy};

use crate::{DeploymentImpl, middleware, middleware::origin::validate_origin, routes};

/// A running server instance. Callers can read the port, then call `serve()`
/// to run the server until the shutdown token is cancelled.
pub struct ServerHandle {
    pub port: u16,
    pub proxy_port: u16,
    pub deployment: DeploymentImpl,
    shutdown_token: CancellationToken,
    main_listener: tokio::net::TcpListener,
    proxy_listener: tokio::net::TcpListener,
}

#[derive(Clone)]
pub struct LanServerControl {
    inner: Arc<LanServerControlInner>,
}

struct LanServerControlInner {
    deployment: DeploymentImpl,
    shutdown_token: CancellationToken,
    state: tokio::sync::Mutex<Option<LanServerInfo>>,
}

/// Address information needed by the QR pairing flow.
///
/// The listener uses one port for every interface. The endpoint list contains
/// the addresses that a phone can try, so the user does not have to know
/// whether the Desktop is currently reachable through Wi-Fi, Ethernet, or a
/// private VPN/WireGuard interface.
#[derive(Debug, Clone, Serialize)]
pub struct LanServerInfo {
    pub port: u16,
    pub endpoints: Vec<String>,
}

impl LanServerControl {
    fn new(deployment: DeploymentImpl, shutdown_token: CancellationToken) -> Self {
        Self {
            inner: Arc::new(LanServerControlInner {
                deployment,
                shutdown_token,
                state: tokio::sync::Mutex::new(None),
            }),
        }
    }

    /// Start the mobile-only listener once and return its detected endpoints.
    ///
    /// The main Desktop server remains loopback-only unless explicitly
    /// configured otherwise. This listener shares the same deployment and
    /// shuts down with the Desktop process.
    pub async fn start(&self) -> anyhow::Result<LanServerInfo> {
        let mut state = self.inner.state.lock().await;
        if let Some(info) = state.as_ref() {
            return Ok(info.clone());
        }

        let requested_port = std::env::var("AURAPUNK_LAN_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(58421);
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", requested_port)).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", 0)).await?,
        };
        let port = listener.local_addr()?.port();
        let endpoints = detect_lan_endpoints(port);
        if endpoints.is_empty() {
            return Err(anyhow::anyhow!(
                "nenhum endereço de rede local foi detectado"
            ));
        }
        let app_router = routes::router(self.inner.deployment.clone());
        let shutdown = self.inner.shutdown_token.clone();
        tokio::spawn(async move {
            let server = axum::serve(listener, app_router)
                .with_graceful_shutdown(async move { shutdown.cancelled().await });
            if let Err(error) = server.await {
                tracing::warn!(%error, "LAN mobile server stopped with an error");
            }
        });
        let info = LanServerInfo { port, endpoints };
        tracing::info!(port, endpoints = ?info.endpoints, "LAN mobile server started on demand");
        *state = Some(info.clone());
        Ok(info)
    }
}

/// Detect addresses that can plausibly reach this machine from another device
/// on the same network. A UDP connect only asks the OS which local address it
/// would use for a route; it does not send a packet. Interface enumeration is
/// then used as a fallback so VPNs that do not carry the default route (such as
/// a WireGuard peer network) are still included in the QR invite.
fn detect_lan_endpoints(port: u16) -> Vec<String> {
    let mut addresses = Vec::new();

    for target in [
        Ipv4Addr::new(1, 1, 1, 1),
        Ipv4Addr::new(8, 8, 8, 8),
        Ipv4Addr::new(192, 168, 1, 1),
        Ipv4Addr::new(10, 0, 0, 1),
        Ipv4Addr::new(100, 64, 0, 1),
    ] {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else {
            continue;
        };
        if socket.connect(SocketAddr::from((target, 80))).is_ok()
            && let Ok(SocketAddr::V4(local)) = socket.local_addr()
        {
            push_candidate(&mut addresses, *local.ip());
        }
    }

    for output in interface_command_outputs() {
        collect_interface_addresses(&output, &mut addresses);
    }

    addresses
        .into_iter()
        .take(8)
        .map(|address| format!("http://{address}:{port}"))
        .collect()
}

fn push_candidate(addresses: &mut Vec<Ipv4Addr>, address: Ipv4Addr) {
    if address.is_unspecified()
        || address.is_loopback()
        || address.is_link_local()
        || address == Ipv4Addr::BROADCAST
        || addresses.contains(&address)
    {
        return;
    }

    // Put ordinary private LAN routes before VPN/CGNAT routes. The mobile app
    // still tries every candidate, so this is only an ordering preference.
    let private = is_private_lan(address);
    let insertion_index = addresses
        .iter()
        .position(|existing| private && !is_private_lan(*existing))
        .unwrap_or(addresses.len());
    addresses.insert(insertion_index, address);
}

fn is_private_lan(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn interface_command_outputs() -> Vec<String> {
    let commands: &[(&str, &[&str])] = if cfg!(target_os = "windows") {
        &[("ipconfig", &[])]
    } else {
        &[("ip", &["-4", "-o", "addr", "show"]), ("ifconfig", &["-a"])]
    };

    commands
        .iter()
        .filter_map(|(command, args)| {
            Command::new(command)
                .args(*args)
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        })
        .collect()
}

fn collect_interface_addresses(output: &str, addresses: &mut Vec<Ipv4Addr>) {
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        let is_unix_inet_line = lower
            .split_whitespace()
            .any(|token| token == "inet" || token.starts_with("inet"));
        let is_windows_ipv4_line = lower.contains("ipv4") && lower.contains("address");
        if !is_unix_inet_line && !is_windows_ipv4_line {
            continue;
        }

        for token in line.split(|character: char| {
            character.is_whitespace() || matches!(character, ':' | ',' | '(' | ')')
        }) {
            let token = token.split('/').next().unwrap_or_default();
            if let Ok(address) = token.parse::<Ipv4Addr>() {
                push_candidate(addresses, address);
                break;
            }
        }
    }
}

impl ServerHandle {
    /// The base URL the main server is listening on.
    ///
    /// Uses `localhost` rather than `127.0.0.1` so that macOS ATS
    /// (App Transport Security) exception domains apply correctly in
    /// the Tauri desktop app — IP address literals aren't reliably
    /// matched by ATS, which causes WebSocket connections to fail.
    pub fn url(&self) -> String {
        format!("http://localhost:{}", self.port)
    }

    /// Run both the main and proxy servers until the shutdown token is cancelled.
    pub async fn serve(self) -> anyhow::Result<()> {
        self.deployment
            .client_info()
            .set_server_addr(self.main_listener.local_addr()?)
            .expect("client server address already set");
        self.deployment
            .client_info()
            .set_preview_proxy_port(self.proxy_port)
            .expect("client preview proxy port already set");

        let app_router = routes::router(self.deployment.clone());
        let proxy_router: axum::Router = routes::preview::subdomain_router(self.deployment.clone())
            .layer(ValidateRequestHeaderLayer::custom(validate_origin));

        // Seed the origin-check middleware with the saved config's allowed origins
        // (env var VK_ALLOWED_ORIGINS is the fallback when the config list is empty).
        middleware::origin::set_allowed_origins(
            &self.deployment.config().read().await.allowed_origins,
        );

        let main_shutdown = self.shutdown_token.clone();
        let proxy_shutdown = self.shutdown_token.clone();

        let main_server = axum::serve(self.main_listener, app_router)
            .with_graceful_shutdown(async move { main_shutdown.cancelled().await });
        let proxy_server = axum::serve(self.proxy_listener, proxy_router)
            .with_graceful_shutdown(async move { proxy_shutdown.cancelled().await });

        let main_handle = tokio::spawn(async move {
            if let Err(e) = main_server.await {
                tracing::error!("Main server error: {}", e);
            }
        });
        let proxy_handle = tokio::spawn(async move {
            if let Err(e) = proxy_server.await {
                tracing::error!("Preview proxy error: {}", e);
            }
        });

        tokio::select! {
            _ = main_handle => {}
            _ = proxy_handle => {}
        }

        perform_cleanup_actions(&self.deployment).await;
        Ok(())
    }

    /// Return a clone of the shutdown token. Cancel it to stop `serve()`.
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown_token.clone()
    }

    pub fn lan_control(&self) -> LanServerControl {
        LanServerControl::new(self.deployment.clone(), self.shutdown_token.clone())
    }
}

/// Initialize the deployment, bind listeners on `localhost` with OS-assigned
/// ports, and return a handle that is ready to serve.
///
/// Uses `localhost` rather than `127.0.0.1` so the bind address matches
/// the hostname the frontend connects to. On modern macOS, `localhost`
/// resolves to `::1` (IPv6) first — binding to `127.0.0.1` (IPv4) while
/// the browser connects via `::1` causes "connection refused".
pub async fn start() -> anyhow::Result<ServerHandle> {
    let host = if std::env::var("AURAPUNK_LAN_SYNC").as_deref() == Ok("1") {
        "0.0.0.0"
    } else {
        "localhost"
    };
    start_with_bind(
        &format!("{host}:0"),
        &format!("{host}:0"),
        CancellationToken::new(),
    )
    .await
}

/// Like [`start`], but lets the caller specify the bind addresses for the main
/// server and the preview proxy (e.g. `"0.0.0.0:8080"`).
pub async fn start_with_bind(
    main_addr: &str,
    proxy_addr: &str,
    shutdown_token: CancellationToken,
) -> anyhow::Result<ServerHandle> {
    let deployment = initialize_deployment(shutdown_token.clone()).await?;

    let listener = tokio::net::TcpListener::bind(main_addr).await?;
    let port = listener.local_addr()?.port();

    let proxy_listener = tokio::net::TcpListener::bind(proxy_addr).await?;
    let proxy_port = proxy_listener.local_addr()?.port();

    // Write the port file here too, not just in the standalone `server`
    // binary's `main()` — this is also the path the packaged Tauri app uses
    // (via `server::startup::start()`), and its port is freshly auto-assigned
    // (`localhost:0`) on every launch. Without this, `vibe-kanban-mcp` (and
    // anything else that port-file-discovers the backend, e.g. the TUI) can
    // silently read a stale port left behind by an earlier dev-mode run,
    // instead of failing loudly or finding the real one.
    if let Err(e) = write_port_file_with_proxy(port, Some(proxy_port)).await {
        tracing::warn!("Failed to write port file: {}", e);
    }

    tracing::info!("Server on :{port}, Preview proxy on :{proxy_port}");

    Ok(ServerHandle {
        port,
        proxy_port,
        deployment,
        shutdown_token,
        main_listener: listener,
        proxy_listener,
    })
}

/// Initialize the deployment: create asset directory, run migrations, backfill data,
/// and pre-warm caches. Shared between the standalone server and the Tauri app.
pub async fn initialize_deployment(
    shutdown: CancellationToken,
) -> Result<DeploymentImpl, DeploymentError> {
    // Create asset directory if it doesn't exist
    if !asset_dir().exists() {
        std::fs::create_dir_all(asset_dir()).map_err(|e| {
            DeploymentError::Other(anyhow::anyhow!("Failed to create asset directory: {}", e))
        })?;
    }

    // Copy old database to new location for safe downgrades
    let old_db = asset_dir().join("db.sqlite");
    let new_db = asset_dir().join("db.v2.sqlite");
    if !new_db.exists() && old_db.exists() {
        tracing::info!(
            "Copying database to new location: {:?} -> {:?}",
            old_db,
            new_db
        );
        std::fs::copy(&old_db, &new_db).expect("Failed to copy database file");
        tracing::info!("Database copy complete");
    }

    let deployment = DeploymentImpl::new(shutdown).await?;
    migrate_legacy_attachment_directories(&deployment).await?;
    deployment
        .container()
        .cleanup_orphan_executions()
        .await
        .map_err(DeploymentError::from)?;
    deployment
        .container()
        .backfill_before_head_commits()
        .await
        .map_err(DeploymentError::from)?;
    deployment
        .container()
        .backfill_repo_names()
        .await
        .map_err(DeploymentError::from)?;

    // Preload global executor options cache for all executors with DEFAULT presets
    tokio::spawn(async move {
        executors::executors::utils::preload_global_executor_options_cache().await;
    });

    Ok(deployment)
}

/// Gracefully shut down running execution processes.
pub async fn perform_cleanup_actions(deployment: &DeploymentImpl) {
    deployment
        .container()
        .kill_all_running_processes()
        .await
        .expect("Failed to cleanly kill running execution processes");
}

const LEGACY_ATTACHMENT_MIGRATION_MARKER: &str = ".attachment-directories-migrated-v1";

#[derive(Default)]
struct DirectoryMigrationStats {
    moved_files: u64,
    removed_duplicates: u64,
    created_directories: u64,
    failures: u64,
}

impl DirectoryMigrationStats {
    fn merge(&mut self, other: DirectoryMigrationStats) {
        self.moved_files += other.moved_files;
        self.removed_duplicates += other.removed_duplicates;
        self.created_directories += other.created_directories;
        self.failures += other.failures;
    }
}

async fn migrate_legacy_attachment_directories(
    deployment: &DeploymentImpl,
) -> Result<(), DeploymentError> {
    let marker_path = asset_dir().join(LEGACY_ATTACHMENT_MIGRATION_MARKER);
    if marker_path.exists() {
        return Ok(());
    }

    let mut stats = DirectoryMigrationStats::default();

    let cache_root = utils::cache_dir();
    stats.merge(migrate_legacy_directory(
        &cache_root.join("images"),
        &cache_root.join("attachments"),
        false,
    ));

    for base_path in collect_attachment_migration_paths(deployment).await? {
        stats.merge(migrate_legacy_directory(
            &base_path.join(".vibe-images"),
            &base_path.join(utils::path::VIBE_ATTACHMENTS_DIR),
            true,
        ));
    }

    if stats.failures == 0 {
        fs::write(&marker_path, b"ok")?;
        tracing::info!(
            "Legacy attachment directory migration completed: moved {}, removed duplicates {}, created directories {}",
            stats.moved_files,
            stats.removed_duplicates,
            stats.created_directories
        );
    } else {
        tracing::warn!(
            "Legacy attachment directory migration completed with {} failures; will retry on next startup",
            stats.failures
        );
    }

    Ok(())
}

async fn collect_attachment_migration_paths(
    deployment: &DeploymentImpl,
) -> Result<Vec<PathBuf>, DeploymentError> {
    use db::models::{session::Session, workspace::Workspace, workspace_repo::WorkspaceRepo};

    let workspaces = Workspace::fetch_all(&deployment.db().pool).await?;
    let mut paths = HashSet::new();

    for workspace in workspaces {
        let Some(container_ref) = workspace.container_ref.as_deref() else {
            continue;
        };
        if container_ref.is_empty() {
            continue;
        }

        let workspace_root = PathBuf::from(container_ref);
        paths.insert(workspace_root.clone());

        for repo in
            WorkspaceRepo::find_repos_for_workspace(&deployment.db().pool, workspace.id).await?
        {
            let repo_base = match repo.default_working_dir.as_deref() {
                Some(default_dir) if !default_dir.is_empty() => {
                    workspace_root.join(&repo.name).join(default_dir)
                }
                _ => workspace_root.join(&repo.name),
            };
            paths.insert(repo_base);
        }

        for session in Session::find_by_workspace_id(&deployment.db().pool, workspace.id).await? {
            let base_path = match session.agent_working_dir.as_deref() {
                Some(dir) if !dir.is_empty() => workspace_root.join(dir),
                _ => workspace_root.clone(),
            };
            paths.insert(base_path);
        }
    }

    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn migrate_legacy_directory(
    src_dir: &Path,
    dst_dir: &Path,
    ensure_gitignore: bool,
) -> DirectoryMigrationStats {
    let mut stats = DirectoryMigrationStats::default();

    if !src_dir.exists() {
        return stats;
    }

    if let Err(error) = fs::create_dir_all(dst_dir) {
        tracing::warn!(
            "Failed to create attachment directory {}: {}",
            dst_dir.display(),
            error
        );
        stats.failures += 1;
        return stats;
    }
    stats.created_directories += 1;

    if let Err(error) = migrate_directory_contents(src_dir, dst_dir, ensure_gitignore, &mut stats) {
        tracing::warn!(
            "Failed to migrate legacy attachment directory {} -> {}: {}",
            src_dir.display(),
            dst_dir.display(),
            error
        );
        stats.failures += 1;
    }

    if ensure_gitignore && let Err(error) = ensure_attachments_gitignore(dst_dir) {
        tracing::warn!(
            "Failed to ensure .gitignore in {}: {}",
            dst_dir.display(),
            error
        );
        stats.failures += 1;
    }

    if let Err(error) = remove_empty_dir_tree(src_dir) {
        tracing::warn!(
            "Failed to clean up legacy attachment directory {}: {}",
            src_dir.display(),
            error
        );
        stats.failures += 1;
    }

    stats
}

fn migrate_directory_contents(
    src_dir: &Path,
    dst_dir: &Path,
    ensure_gitignore: bool,
    stats: &mut DirectoryMigrationStats,
) -> io::Result<()> {
    for entry in fs::read_dir(src_dir)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();

        if ensure_gitignore && file_name == ".gitignore" {
            continue;
        }

        let dst_path = dst_dir.join(&file_name);
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            fs::create_dir_all(&dst_path)?;
            migrate_directory_contents(&src_path, &dst_path, false, stats)?;
            remove_empty_dir_tree(&src_path)?;
            continue;
        }

        if dst_path.exists() {
            fs::remove_file(&src_path)?;
            stats.removed_duplicates += 1;
            continue;
        }

        move_path(&src_path, &dst_path)?;
        stats.moved_files += 1;
    }

    Ok(())
}

fn move_path(src_path: &Path, dst_path: &Path) -> io::Result<()> {
    match fs::rename(src_path, dst_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
            fs::copy(src_path, dst_path)?;
            fs::remove_file(src_path)
        }
        Err(error) => Err(error),
    }
}

fn ensure_attachments_gitignore(dir: &Path) -> io::Result<()> {
    let gitignore_path = dir.join(".gitignore");
    if !gitignore_path.exists() {
        fs::write(gitignore_path, "*\n")?;
    }
    Ok(())
}

fn remove_empty_dir_tree(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }

    if fs::read_dir(path)?.next().is_none() {
        fs::remove_dir(path)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn migrates_legacy_cache_directory_contents() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("images");
        let dst = temp_dir.path().join("attachments");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("asset.png"), b"hello").unwrap();

        let stats = migrate_legacy_directory(&src, &dst, false);

        assert_eq!(stats.moved_files, 1);
        assert!(dst.join("asset.png").exists());
        assert!(!src.exists());
    }

    #[test]
    fn removes_legacy_duplicates_when_destination_exists() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join(".vibe-images");
        let dst = temp_dir.path().join(".vibe-attachments");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("asset.png"), b"old").unwrap();
        fs::write(dst.join("asset.png"), b"new").unwrap();

        let stats = migrate_legacy_directory(&src, &dst, true);

        assert_eq!(stats.removed_duplicates, 1);
        assert_eq!(fs::read(dst.join("asset.png")).unwrap(), b"new");
        assert!(!src.exists());
    }

    #[test]
    fn ensures_gitignore_for_workspace_attachment_dir() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join(".vibe-images");
        let dst = temp_dir.path().join(".vibe-attachments");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("file.pdf"), b"attachment").unwrap();

        migrate_legacy_directory(&src, &dst, true);

        assert_eq!(fs::read_to_string(dst.join(".gitignore")).unwrap(), "*\n");
        assert!(dst.join("file.pdf").exists());
    }

    #[test]
    fn collects_private_addresses_from_unix_interface_output() {
        let mut addresses = Vec::new();
        collect_interface_addresses(
            "2: en0 inet 192.168.1.20/24 brd 192.168.1.255\n3: wg0 inet 10.8.0.2/24",
            &mut addresses,
        );

        assert_eq!(
            addresses,
            vec![Ipv4Addr::new(192, 168, 1, 20), Ipv4Addr::new(10, 8, 0, 2)]
        );
    }

    #[test]
    fn collects_private_addresses_from_windows_interface_output() {
        let mut addresses = Vec::new();
        collect_interface_addresses(
            "   IPv4 Address. . . . . . . . . . . : 192.168.1.20\n   IPv4 Address. . . . . . . . . . . : 100.121.87.65",
            &mut addresses,
        );

        assert_eq!(
            addresses,
            vec![
                Ipv4Addr::new(192, 168, 1, 20),
                Ipv4Addr::new(100, 121, 87, 65)
            ]
        );
    }
}
