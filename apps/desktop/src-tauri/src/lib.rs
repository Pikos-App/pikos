use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

mod db;
#[path = "error/error.rs"]
mod error;
#[path = "logging/logging.rs"]
mod logging;
#[path = "markdown/markdown.rs"]
mod markdown;
mod menu;
mod notifications;
mod window_state;

use db::DbState;
use notifications::scheduler::{NotificationSettingsState, SchedulerRuntimeState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMABUF renderer paints a blank/white window on several Linux
    // GPU/driver stacks. Disabling it forces the stable render path.
    // Set before any GTK/webview init. Respect an existing override so
    // users can re-enable it if their stack works.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    logging::install_panic_hook();

    // `mut` is needed under cfg(linux/windows) to chain the single-instance
    // plugin; macOS routes URLs natively and doesn't need it.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window. The URL itself is delivered by the
            // deep-link plugin's on_open_url handler registered in setup().
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    let (sync_trigger_tx, sync_trigger_rx) = db::sync_loop::SyncTriggerSender::new();

    let builder = builder
        .manage(DbState::new())
        .manage(NotificationSettingsState::new())
        .manage(SchedulerRuntimeState::new())
        .manage(sync_trigger_tx)
        .plugin(logging::build_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            log::info!(
                "=== Pikos {} starting on {} ===",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS
            );

            // macOS: install the foreground-presentation delegate and request
            // notification authorization via the modern UserNotifications
            // framework, so reminders show even while Pikos is focused. Runs on
            // the main thread (Tauri setup) and degrades to the plugin path on
            // unbundled dev binaries. See notifications/macos.rs.
            #[cfg(target_os = "macos")]
            notifications::macos::setup(app.handle());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(notifications::scheduler::run(handle));

            let sync_handle = app.handle().clone();
            tauri::async_runtime::spawn(db::sync_loop::run(sync_handle, sync_trigger_rx));

            // Restore saved window size/position. Replaces tauri-plugin-window-state
            // which had a drift bug on macOS with our custom title bar.
            window_state::restore(app.handle());

            // Register pikos:// scheme at runtime for Linux (and Windows dev builds);
            // macOS and Windows release builds register via the bundle config.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                let _ = app.deep_link().register("pikos");
            }

            // Forward incoming pikos:// URLs to the frontend. Fires for both
            // cold-start (URL launched the app) and warm-start.
            let emit_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(window) = emit_handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    let _ = emit_handle.emit("pikos://open-url", url.to_string());
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Save on every resize/move so state is always current on disk.
            // CloseRequested doesn't fire reliably on macOS Cmd+Q (NSApp
            // terminate), so we can't depend on it for persistence.
            match event {
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                    window_state::save(window.app_handle());
                }
                WindowEvent::Focused(true) => {
                    db::sync_loop::on_focus(window.app_handle());
                }
                _ => {}
            }
        })
        .menu(menu::build)
        .on_menu_event(menu::on_event);

    // The app's whole invoke surface, declared and registered in one place —
    // `run()` names no commands, so none can be declared and left unregistered.
    db::commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
