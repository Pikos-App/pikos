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

use db::{
    assets::{init_assets_dir, save_asset, save_asset_bytes},
    connect_db,
    dev::{
        backdate_page, backup_db, backup_db_before_import, dev_seed_synced_calendar, export_csv,
        export_markdown, get_usage_stats, reset_db, wipe_app_data,
    },
    folders::{
        create_folder, delete_folder, get_folder, list_folders, reorder_folders, restore_folder,
        soft_delete_folder, update_folder,
    },
    notifications::{
        create_page_reminder, delete_page_reminder, delete_page_reminders, list_page_reminders,
    },
    pages::{
        clear_pending_description, complete_recurring_page, create_page, delete_page, get_page,
        list_completed_pages, list_pages, list_pages_today, recompute_recurring_schedules,
        reorder_pages, reschedule_virtual_occurrence, restore_page, set_pages_status,
        skip_occurrence, soft_delete_page, uncomplete_recurring_occurrence, undo_skip_occurrence,
        update_page,
    },
    schedules::{
        add_rule_exdates, create_page_schedule, create_recurrence_rule, delete_page_schedule,
        delete_recurrence_rule, expand_recurrence_range, get_recurrence_rule, list_page_schedules,
        list_page_schedules_for_rules, list_recurrence_rules, remove_rule_exdate,
        update_page_schedule, update_recurrence_rule,
    },
    search::search_pages,
    sync::{
        connect_caldav_account, connect_google_account, disconnect_sync_account, get_sync_status,
        google_sync_available, list_sync_calendars, reconnect_caldav_account, refresh_sync_account,
        release_sync_credentials, resync_sync_account, set_sync_calendar_color,
        toggle_sync_calendar,
    },
    tags::search_tags,
    DbState,
};

use notifications::scheduler::{
    check_notification_permission, request_notification_permission, update_notification_settings,
    NotificationSettingsState, SchedulerRuntimeState,
};

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

    builder
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
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![
            // DB connection
            connect_db,
            // Pages
            get_page,
            create_page,
            update_page,
            clear_pending_description,
            delete_page,
            soft_delete_page,
            restore_page,
            list_pages,
            list_pages_today,
            list_completed_pages,
            reorder_pages,
            set_pages_status,
            complete_recurring_page,
            uncomplete_recurring_occurrence,
            skip_occurrence,
            undo_skip_occurrence,
            recompute_recurring_schedules,
            reschedule_virtual_occurrence,
            // Folders
            get_folder,
            create_folder,
            update_folder,
            delete_folder,
            soft_delete_folder,
            restore_folder,
            list_folders,
            reorder_folders,
            // Schedules
            create_page_schedule,
            update_page_schedule,
            delete_page_schedule,
            list_page_schedules,
            list_page_schedules_for_rules,
            // Recurrence rules
            create_recurrence_rule,
            update_recurrence_rule,
            add_rule_exdates,
            remove_rule_exdate,
            delete_recurrence_rule,
            get_recurrence_rule,
            list_recurrence_rules,
            expand_recurrence_range,
            // Search
            search_pages,
            // Tags
            search_tags,
            // Calendar sync
            connect_caldav_account,
            connect_google_account,
            reconnect_caldav_account,
            google_sync_available,
            disconnect_sync_account,
            list_sync_calendars,
            toggle_sync_calendar,
            set_sync_calendar_color,
            resync_sync_account,
            refresh_sync_account,
            get_sync_status,
            release_sync_credentials,
            // Notifications / reminders
            create_page_reminder,
            list_page_reminders,
            delete_page_reminder,
            delete_page_reminders,
            update_notification_settings,
            request_notification_permission,
            check_notification_permission,
            // Assets
            init_assets_dir,
            save_asset,
            save_asset_bytes,
            // Dev / settings
            backdate_page,
            backup_db,
            export_csv,
            backup_db_before_import,
            export_markdown,
            get_usage_stats,
            reset_db,
            dev_seed_synced_calendar,
            wipe_app_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
