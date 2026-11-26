use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(feature = "bench")]
mod bench;
mod db;
#[cfg(feature = "e2e-bridge")]
pub mod e2e_bridge;
#[path = "error/error.rs"]
mod error;
#[path = "logging/logging.rs"]
mod logging;
mod menu;
mod notifications;
mod window_state;

pub use db::commands::dispatch as dispatch_db_command;
#[cfg(debug_assertions)]
pub use db::dev::{backdate_page_impl, dev_seed_synced_calendar_impl, BackdateParams};
use db::DbState;
use notifications::scheduler::{NotificationSettingsState, SchedulerRuntimeState};

/// A blank window says nothing about which render path produced it, and the answer decides
/// the next step: the DMABUF override, compositing, or Wayland.
#[cfg(target_os = "linux")]
fn log_render_environment() {
    let read = |name: &str| std::env::var(name).unwrap_or_else(|_| "unset".to_string());
    log::info!(
        "linux render environment: session={} gdk_backend={} dmabuf_disabled={} compositing_disabled={}",
        read("XDG_SESSION_TYPE"),
        read("GDK_BACKEND"),
        read("WEBKIT_DISABLE_DMABUF_RENDERER"),
        read("WEBKIT_DISABLE_COMPOSITING_MODE"),
    );
}

/// Two copies is two notification schedulers and two sync loops over one SQLite file, so a
/// reminder arrives twice, and macOS picks freely which copy a notification click activates.
/// This applies on macOS too: two bundles at different paths are distinct to LaunchServices.
///
/// Goes first in the builder chain so a second launch exits before the scheduler and sync loop start.
fn single_instance_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // The URL arrives through the deep-link plugin's on_open_url handler in setup().
        log::info!("second_instance_refused — focused the running window");
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "bench")]
    bench::mark_start();

    // WebKitGTK's DMABUF renderer paints a blank window on several Linux GPU/driver stacks.
    // Set before any GTK/webview init, and an existing override is respected.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    logging::install_panic_hook();

    let (sync_trigger_tx, sync_trigger_rx) = db::sync_loop::SyncTriggerSender::new();

    let builder = tauri::Builder::default()
        .plugin(single_instance_guard())
        .manage(DbState::new())
        .manage(NotificationSettingsState::new())
        .manage(SchedulerRuntimeState::new())
        .manage(notifications::click::PendingClicks::default())
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
            #[cfg(target_os = "linux")]
            log_render_environment();

            // Must run on the main thread; degrades to the plugin path on unbundled dev binaries.
            #[cfg(target_os = "macos")]
            notifications::macos::setup(app.handle());

            // A benchmark launch would deliver the seeded workspace's reminders to whoever is
            // running it, and the delivery work would land in the timings.
            if !cfg!(feature = "bench") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(notifications::scheduler::run(handle));
            }

            let sync_handle = app.handle().clone();
            tauri::async_runtime::spawn(db::sync_loop::run(sync_handle, sync_trigger_rx));

            window_state::restore(app.handle());

            // macOS and Windows release builds register the scheme via the bundle config.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                let _ = app.deep_link().register("pikos");
            }

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
            // CloseRequested doesn't fire reliably on macOS Cmd+Q, so save on every resize/move.
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

    // `run()` names no commands, so none can be declared and left unregistered.
    db::commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
