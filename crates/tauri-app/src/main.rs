// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, sync::Arc, time::Duration};

use async_trait::async_trait;
use services::services::{
    config::load_config_from_file,
    notification::{NotificationService, PushNotifier, set_global_push_notifier},
};
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::menu::MenuItemKind;
#[cfg(not(target_os = "macos"))]
use tauri::menu::Submenu;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{Emitter, Listener};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};
use tokio::{sync::Mutex, time::sleep};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::{EnvFilter, prelude::*};
use utils::assets::config_path;
use uuid::Uuid;

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
const DEFAULT_CLOUD_MEM0_URL: &str = "http://192.168.1.168:8000";

#[cfg(target_os = "linux")]
mod linux_notifications;
#[cfg(target_os = "macos")]
mod macos_notifications;
#[cfg(target_os = "windows")]
mod windows_notifications;

/// Native push notifier for backend-initiated notifications.
/// Uses platform-native APIs with click handling where available,
/// falls back to `tauri-plugin-notification` otherwise.
struct TauriNotifier {
    app_handle: tauri::AppHandle,
}

/// Whether platform-native notifications with click handling are available.
fn use_native_notifications() -> bool {
    #[cfg(target_os = "macos")]
    return macos_notifications::is_available();
    #[cfg(target_os = "windows")]
    return windows_notifications::is_available();
    #[cfg(target_os = "linux")]
    return linux_notifications::is_available();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    false
}

/// Show a notification using the platform-native API (with click handling).
fn show_native_notification(title: &str, body: &str, deeplink_path: Option<&str>) {
    #[cfg(target_os = "macos")]
    macos_notifications::show_notification(title, body, deeplink_path);
    #[cfg(target_os = "windows")]
    windows_notifications::show_notification(title, body, deeplink_path);
    #[cfg(target_os = "linux")]
    linux_notifications::show_notification(title, body, deeplink_path);
}

#[tauri::command]
async fn show_system_notification(
    title: String,
    body: String,
    deeplink_path: Option<String>,
) -> Result<(), String> {
    if use_native_notifications() {
        show_native_notification(&title, &body, deeplink_path.as_deref());
        return Ok(());
    }

    // Fallback: generic NotificationService (e.g. macOS dev mode).
    let config = load_config_from_file(&config_path()).await;
    let notification_service = NotificationService::new(Arc::new(tokio::sync::RwLock::new(config)));
    notification_service.notify(&title, &body, None).await;
    Ok(())
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only HTTP(S) URLs can be opened externally".to_string());
    }

    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| error.to_string())
}

const CLOUD_ACCOUNT_FILE: &str = "cloud-account.json";

#[tauri::command]
fn read_cloud_account(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join(CLOUD_ACCOUNT_FILE);
    match fs::read_to_string(path) {
        Ok(account) => Ok(Some(account)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn write_cloud_account(app: tauri::AppHandle, account: String) -> Result<(), String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join(CLOUD_ACCOUNT_FILE), account).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_cloud_account(app: tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join(CLOUD_ACCOUNT_FILE);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[async_trait]
impl PushNotifier for TauriNotifier {
    async fn send(&self, title: &str, message: &str, workspace_id: Option<Uuid>) {
        let deeplink_path = workspace_id.map(|id| format!("/workspaces/{id}"));

        if use_native_notifications() {
            show_native_notification(title, message, deeplink_path.as_deref());
            return;
        }

        // Fallback: tauri-plugin-notification (no click handling).
        if let Err(e) = self
            .app_handle
            .notification()
            .builder()
            .title(title)
            .body(message)
            .show()
        {
            tracing::warn!("Failed to send Tauri notification: {}", e);
        }
    }
}

fn main() {
    // Packaged desktop builds are the AuraPunk IDE Cloud client: clicking the
    // executable must open the native window with the Cloud login available.
    // Local browser/dev launches remain local because they do not pass through
    // this Tauri entrypoint. `--local` is an explicit escape hatch for
    // diagnostics on a packaged build.
    let local_mode = std::env::args().any(|arg| arg == "--local");
    if !local_mode {
        // Environment mutation is process-wide and intentionally happens
        // before the backend is started; this is safe during single-threaded
        // application initialization.
        unsafe { std::env::set_var("VIBE_KANBAN_MODE", "cloud") };

        // Keep an explicit MEM0_URL override for deployments that use another
        // host while giving the packaged Cloud client a useful default.
        if std::env::var_os("MEM0_URL").is_none() {
            let mem0_url = std::env::var("AURAPUNK_CLOUD_MEM0_URL")
                .unwrap_or_else(|_| DEFAULT_CLOUD_MEM0_URL.to_string());
            unsafe { std::env::set_var("MEM0_URL", mem0_url) };
        }
    }

    // Install rustls crypto provider before any TLS operations
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    let log_level = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());
    let filter_string = format!(
        "warn,server={level},services={level},db={level},executors={level},deployment={level},local_deployment={level},utils={level},vibe_kanban_tauri={level}",
        level = log_level
    );
    let env_filter = EnvFilter::try_new(filter_string).expect("Failed to create tracing filter");

    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_filter(env_filter))
        .init();

    // Shared token so we can tell the server to shut down when the app quits.
    let shutdown_token = Arc::new(CancellationToken::new());
    let shutdown_token_for_event = shutdown_token.clone();

    // Holds downloaded update bytes until the app exits or user restarts.
    // Created here (outside setup) so the RunEvent::Exit handler can access it.
    let pending_update: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(None));
    let pending_for_setup = pending_update.clone();
    let pending_for_exit = pending_update.clone();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            show_system_notification,
            read_clipboard_text,
            open_external_url,
            read_cloud_account,
            write_cloud_account,
            clear_cloud_account
        ]);

    // Unlock WKWebView's native refresh rate on macOS ProMotion / high-Hz displays.
    // On macOS 13–15 WKWebView caps rAF at 60fps; this plugin disables that cap
    // via WebKit's private _features API. No-op on macOS 26+ (cap removed by Apple).
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_fps::init());
    }

    // Only register the updater plugin in release builds — dev builds have a
    // placeholder endpoint that fails config deserialization.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(move |app| {
            // Initialize platform-native notifications (request permission,
            // install click-handling delegates) before anything else.
            #[cfg(target_os = "macos")]
            macos_notifications::initialize(app.handle().clone());
            #[cfg(target_os = "windows")]
            windows_notifications::initialize(app.handle().clone());
            #[cfg(target_os = "linux")]
            linux_notifications::initialize(app.handle().clone());
            #[cfg(target_os = "macos")]
            set_macos_dock_icon();

            // Initialize native application menu (App/File/Edit/View/Window/Help)
            // and expose the actions that are otherwise only available from
            // the in-app toolbar/command palette.
            let menu = build_application_menu(app.handle())?;
            let _ = app.set_menu(menu);
            app.on_menu_event(|app, event| {
                let action = match event.id().as_ref() {
                    "native-settings" => Some("settings"),
                    "native-project-settings" => Some("project-settings"),
                    "native-new-issue" => Some("new-issue"),
                    _ => None,
                };

                if let Some(action) = action {
                    if let Err(error) = app.emit("native-menu-action", action) {
                        tracing::warn!(?error, "Failed to dispatch native menu action");
                    }
                }
            });

            if cfg!(debug_assertions) {
                // Dev mode: frontend dev server (Vite) and backend are started
                // externally. Use WebviewUrl::External so that macOS WKWebView
                // renders with the same content scaling as the production build.
                let frontend_port =
                    std::env::var("FRONTEND_PORT").unwrap_or_else(|_| "3001".to_string());
                let dev_url = format!("http://localhost:{frontend_port}");
                tracing::info!("Running in dev mode — using external frontend/backend servers (devUrl={dev_url})");
                let window = create_window(
                    app,
                    tauri::WebviewUrl::External(dev_url.parse().unwrap()),
                )?;
                #[cfg(target_os = "macos")]
                {
                    disable_pinch_zoom(&window);
                    optimize_webview_performance(&window);
                }
                let _ = window;
            } else {
                // Production: start the Axum server first, then open the window
                // once it's ready so the user never sees a blank/error page.
                let app_handle = app.handle().clone();

                // Register native Tauri notifications before the server starts.
                set_global_push_notifier(Arc::new(TauriNotifier {
                    app_handle: app_handle.clone(),
                }));

                let token = shutdown_token.clone();
                tauri::async_runtime::spawn(async move {
                    match server::startup::start().await {
                        Ok(server_handle) => {
                            let url = server_handle.url();

                            // Create the window on the main thread — macOS
                            // silently drops windows created from async tasks.
                            let url_clone = url.clone();
                            let create_handle = app_handle.clone();
                            let _ = app_handle.run_on_main_thread(move || {
                                let webview_url =
                                    tauri::WebviewUrl::External(url_clone.parse().unwrap());
                                match create_window(&create_handle, webview_url) {
                                    Ok(window) => {
                                        #[cfg(target_os = "macos")]
                                        {
                                            disable_pinch_zoom(&window);
                                            optimize_webview_performance(&window);
                                        }
                                        let _ = window;
                                    }
                                    Err(e) => tracing::error!("Failed to create window: {e}"),
                                }
                            });
                            tracing::info!("Window opened at {url}");

                            // Wait for either the server to exit on its own or
                            // the external shutdown token to be cancelled.
                            let server_token = server_handle.shutdown_token();
                            tauri::async_runtime::spawn(async move {
                                token.cancelled().await;
                                server_token.cancel();
                            });

                            if let Err(e) = server_handle.serve().await {
                                tracing::error!("Server error: {e}");
                            }
                        }
                        Err(e) => {
                            tracing::error!("Server failed to start: {e}");
                        }
                    }
                });

                // Check for updates in the background on startup and then
                // periodically. We only *download* the update here —
                // installing it (which replaces the app bundle on disk) is
                // deferred until the user exits or triggers a restart.
                // Installing while the app is running causes a code-signature
                // mismatch on macOS, which makes NSOpenPanel (and other XPC
                // services) return NULL and crash the app.
                // See tauri-apps/tauri#13047.
                let update_handle = app.handle().clone();
                let pending_for_download = pending_for_setup.clone();
                tauri::async_runtime::spawn(async move {
                    run_periodic_update_checks(update_handle, pending_for_download).await;
                });

                // Listen for restart request from frontend (after update downloaded).
                // Install the previously downloaded bytes *now*, then restart.
                let restart_handle = app.handle().clone();
                let pending_for_install = pending_for_setup.clone();
                app.listen("restart-app", move |_| {
                    let handle = restart_handle.clone();
                    let pending = pending_for_install.clone();
                    tauri::async_runtime::spawn(async move {
                        install_pending_update(&handle, &pending).await;
                        handle.restart();
                    });
                });
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                tauri::WindowEvent::Resized(..) | tauri::WindowEvent::Moved(..) => {
                    let _ = window.app_handle().save_window_state(
                        StateFlags::SIZE
                            | StateFlags::POSITION
                            | StateFlags::MAXIMIZED
                            | StateFlags::FULLSCREEN,
                    );
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let _ = window.app_handle().save_window_state(
                        StateFlags::SIZE
                            | StateFlags::POSITION
                            | StateFlags::MAXIMIZED
                            | StateFlags::FULLSCREEN,
                    );
                    // Hide the window instead of closing it so the app keeps
                    // running in the background (agents/processes stay alive).
                    // The dock icon stays visible so users can click it to reopen.
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Destroyed => {
                    // Only fires on actual app exit (e.g. Cmd+Q).
                    shutdown_token_for_event.cancel();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, _event| {
            // macOS: clicking the dock icon when the window is hidden should reopen it.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_window(_app);
            }

            // Install any pending update when the app exits (e.g. Cmd+Q)
            // so the next launch uses the new version.
            if let tauri::RunEvent::Exit = _event {
                let _ = _app.save_window_state(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                );
                // block_on is safe here — we're on the main (AppKit) thread,
                // not inside the tokio runtime.
                tauri::async_runtime::block_on(install_pending_update(_app, &pending_for_exit));
            }
        });
}

/// Disable trackpad/touchpad pinch-to-zoom on macOS while keeping Cmd+/- zoom.
/// WKWebView handles magnification at the native level — JS `preventDefault()`
/// cannot block it.
#[cfg(target_os = "macos")]
fn disable_pinch_zoom(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        let wk: &objc2_web_kit::WKWebView = &*webview.inner().cast();
        wk.setAllowsMagnification(false);
    });
}

/// Enable GPU-accelerated compositing and drawing in WKWebView.
///
/// Embedded WKWebView may not have the same GPU acceleration defaults as Safari,
/// contributing to the observed performance gap (Chrome > Safari > Tauri).
/// Sets private WebKit preferences via NSKeyValueCoding (setValue:forKey:)
/// using the same raw msg_send pattern as tauri-plugin-macos-fps.
#[cfg(target_os = "macos")]
fn optimize_webview_performance(window: &tauri::WebviewWindow) {
    use objc2::{
        msg_send,
        runtime::{AnyClass, AnyObject, Bool},
    };

    let _ = window.with_webview(|webview| unsafe {
        let wk: &objc2_web_kit::WKWebView = &*webview.inner().cast();

        let config: *mut AnyObject = msg_send![wk, configuration];
        if config.is_null() {
            tracing::warn!("WebView optimization: WKWebViewConfiguration is null");
            return;
        }
        let prefs: *mut AnyObject = msg_send![config, preferences];
        if prefs.is_null() {
            tracing::warn!("WebView optimization: WKPreferences is null");
            return;
        }

        let ns_num_cls = match AnyClass::get(c"NSNumber") {
            Some(cls) => cls,
            None => return,
        };
        let yes: *mut AnyObject = msg_send![ns_num_cls, numberWithBool: Bool::new(true)];

        for key_str in ["acceleratedCompositingEnabled", "acceleratedDrawingEnabled"] {
            let key = objc2_foundation::NSString::from_str(key_str);
            let _: () = msg_send![prefs, setValue: yes, forKey: &*key];
        }

        tracing::info!(
            "WebView: GPU acceleration enabled (acceleratedCompositingEnabled + acceleratedDrawingEnabled)"
        );
    });
}

#[cfg(target_os = "macos")]
fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon() {
    use objc2::{msg_send, runtime::AnyClass};
    use objc2_foundation::NSData;

    let icon_bytes = include_bytes!("../icons/icon.png");
    let nsdata = NSData::with_bytes(icon_bytes);

    if let Some(nsimage_cls) = AnyClass::get(c"NSImage")
        && let Some(nsapp_cls) = AnyClass::get(c"NSApplication")
    {
        unsafe {
            let alloc_img: *mut objc2::runtime::AnyObject = msg_send![nsimage_cls, alloc];
            let img: *mut objc2::runtime::AnyObject = msg_send![alloc_img, initWithData: &*nsdata];
            let app: *mut objc2::runtime::AnyObject = msg_send![nsapp_cls, sharedApplication];
            if !app.is_null() && !img.is_null() {
                let _: () = msg_send![app, setApplicationIconImage: img];
            }
        }
    }
}

fn create_window<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
    url: tauri::WebviewUrl,
) -> Result<tauri::WebviewWindow<R>, tauri::Error> {
    let handle = manager.app_handle().clone();
    let builder = tauri::WebviewWindowBuilder::new(manager, "main", url)
        .title("Aurapunk IDE")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .zoom_hotkeys_enabled(false)
        .disable_drag_drop_handler();

    let window = builder
        .on_new_window(move |url, _features| {
            tracing::info!("New window requested for URL: {}", url);
            let url_str = url.to_string();
            let _ = handle.opener().open_url(&url_str, None::<&str>);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;

    let _ = window.restore_state(
        StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN,
    );
    Ok(window)
}

/// Add app actions to the native menu on every desktop platform.
///
/// macOS already has an application submenu created by Tauri's default menu;
/// append to that submenu so we do not create a duplicate "Vibe Kanban" menu.
/// Windows and Linux do not have that implicit application submenu, so they
/// receive an explicit one at the beginning of the menu bar.
fn build_application_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let settings = MenuItem::with_id(app, "native-settings", "Settings…", true, None::<&str>)?;
    let project_settings = MenuItem::with_id(
        app,
        "native-project-settings",
        "Project Settings",
        true,
        None::<&str>,
    )?;
    let new_issue = MenuItem::with_id(app, "native-new-issue", "New Issue", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    #[cfg(target_os = "macos")]
    {
        if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
            app_menu.insert(&settings, 2)?;
            app_menu.insert(&project_settings, 3)?;
            app_menu.insert(&separator, 4)?;
            app_menu.insert(&new_issue, 5)?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let app_menu = Submenu::with_id_and_items(
            app,
            "native-app-menu",
            "Aurapunk IDE",
            true,
            &[&settings, &project_settings, &separator, &new_issue],
        )?;
        menu.prepend(&app_menu)?;
    }

    Ok(menu)
}

/// Takes the pending update bytes (if any) and installs them.
/// Requires a network call to re-fetch the `Update` metadata.
async fn install_pending_update(app: &tauri::AppHandle, pending: &Mutex<Option<Vec<u8>>>) {
    let bytes = match pending.lock().await.take() {
        Some(b) => b,
        None => return,
    };
    tracing::info!("Installing pending update…");
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            tracing::error!("Failed to init updater for install: {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            if let Err(e) = update.install(bytes) {
                tracing::error!("Failed to install update: {e}");
            } else {
                tracing::info!("Update installed, will apply on next launch");
            }
        }
        Ok(None) => {
            tracing::warn!("Update no longer available when trying to install");
        }
        Err(e) => {
            tracing::error!("Failed to check for update during install: {e}");
        }
    }
}

async fn check_for_updates(app: tauri::AppHandle, pending_update: Arc<Mutex<Option<Vec<u8>>>>) {
    let has_pending_update = pending_update.lock().await.is_some();
    if has_pending_update {
        tracing::info!("Update already downloaded; skipping update check");
        return;
    }

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            tracing::warn!("Failed to initialize updater: {}", e);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            tracing::info!(
                "Update available: {} -> {}",
                update.current_version,
                update.version
            );

            let _ = app.emit(
                "update-available",
                serde_json::json!({
                    "currentVersion": update.current_version.to_string(),
                    "newVersion": update.version.to_string(),
                    "body": update.body
                }),
            );

            // Only *download* the update — do NOT install yet.
            // Installing replaces the app bundle on disk which
            // invalidates the code signature of the running process,
            // causing macOS XPC services (NSOpenPanel etc.) to fail.
            let new_version = update.version.to_string();
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    tracing::info!("Update {new_version} downloaded, waiting for user to restart");
                    *pending_update.lock().await = Some(bytes);
                    let _ = app.emit(
                        "update-installed",
                        serde_json::json!({ "newVersion": new_version }),
                    );
                }
                Err(e) => {
                    tracing::error!("Failed to download update: {}", e);
                }
            }
        }
        Ok(None) => {
            tracing::info!("No updates available");
        }
        Err(e) => {
            tracing::warn!("Failed to check for updates: {}", e);
        }
    }
}

async fn run_periodic_update_checks(
    app: tauri::AppHandle,
    pending_update: Arc<Mutex<Option<Vec<u8>>>>,
) {
    check_for_updates(app.clone(), pending_update.clone()).await;

    loop {
        sleep(UPDATE_CHECK_INTERVAL).await;
        check_for_updates(app.clone(), pending_update.clone()).await;
    }
}
