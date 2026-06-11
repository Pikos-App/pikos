use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

mod db;
#[path = "error/error.rs"]
mod error;
#[path = "logging/logging.rs"]
mod logging;
#[path = "markdown/markdown.rs"]
mod markdown;
mod notifications;
mod window_state;

use db::{
    assets::{init_assets_dir, save_asset, save_asset_bytes},
    connect_db,
    dev::{
        backdate_page, backup_db, backup_db_before_import, export_csv, export_json,
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
        complete_recurring_page, create_page, delete_page, get_page, list_completed_pages,
        list_pages, list_pages_today, reorder_pages, reschedule_virtual_occurrence, restore_page,
        set_pages_status, soft_delete_page, update_page,
    },
    schedules::{
        add_rule_exdates, create_page_schedule, create_recurrence_rule, delete_page_schedule,
        delete_recurrence_rule, get_recurrence_rule, list_page_schedules,
        list_page_schedules_range, list_recurrence_rules, remove_rule_exdate, update_page_schedule,
        update_recurrence_rule,
    },
    search::search_pages,
    switch_workspace,
    tags::search_tags,
    DbState,
};

use notifications::scheduler::{
    check_notification_permission, request_notification_permission, update_notification_settings,
    NotificationSettingsState, SchedulerRuntimeState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

    builder
        .manage(DbState::new())
        .manage(NotificationSettingsState::new())
        .manage(SchedulerRuntimeState::new())
        .plugin(logging::build_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
                _ => {}
            }
        })
        .menu(|handle| {
            let settings = MenuItemBuilder::new("Settings…")
                .id("settings")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?;
            let check_updates = MenuItemBuilder::new("Check for Updates…")
                .id("check_updates")
                .build(handle)?;
            let app_menu = SubmenuBuilder::new(handle, "Pikos")
                .about(Some(
                    AboutMetadataBuilder::new()
                        .name(Some("Pikos"))
                        .version(Some(env!("CARGO_PKG_VERSION")))
                        .short_version(Some(env!("PIKOS_GIT_COMMIT")))
                        .authors(Some(vec!["Alex King".into()]))
                        .copyright(Some("© 2026 Alex King"))
                        .license(Some("BUSL-1.1"))
                        .website(Some("https://pikos.app"))
                        .website_label(Some("pikos.app"))
                        .comments(Some("Notes, tasks, and calendar — local-first"))
                        .build(),
                ))
                .separator()
                .item(&check_updates)
                .separator()
                .item(&settings)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            // ── File ──────────────────────────────────────────────────────
            let new_page = MenuItemBuilder::new("New Page")
                .id("new_page")
                .accelerator("CmdOrCtrl+N")
                .build(handle)?;
            let close_page = MenuItemBuilder::new("Close Page")
                .id("close_page")
                .accelerator("CmdOrCtrl+W")
                .build(handle)?;
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&new_page)
                .item(&close_page)
                .build()?;

            // ── Edit ─────────────────────────────────────────────────────
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            // ── View ─────────────────────────────────────────────────────
            let toggle_sidebar = MenuItemBuilder::new("Toggle Sidebar")
                .id("toggle_sidebar")
                .accelerator("CmdOrCtrl+\\")
                .build(handle)?;
            let toggle_calendar = MenuItemBuilder::new("Toggle Calendar")
                .id("toggle_calendar")
                .accelerator("CmdOrCtrl+Shift+C")
                .build(handle)?;

            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&toggle_sidebar)
                .separator()
                .item(&toggle_calendar)
                .build()?;

            // ── Window ───────────────────────────────────────────────────
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .separator()
                .fullscreen()
                .build()?;

            // ── Help ─────────────────────────────────────────────────────
            let help_docs = MenuItemBuilder::new("Pikos FAQ")
                .id("help_docs")
                .build(handle)?;
            let help_release_notes = MenuItemBuilder::new("Release Notes")
                .id("help_release_notes")
                .build(handle)?;
            let help_shortcuts = MenuItemBuilder::new("Keyboard Shortcuts")
                .id("keyboard_shortcuts")
                .accelerator("CmdOrCtrl+/")
                .build(handle)?;
            let help_bug = MenuItemBuilder::new("Report a Bug…")
                .id("help_bug")
                .build(handle)?;
            let help_menu = SubmenuBuilder::new(handle, "Help")
                .item(&help_docs)
                .item(&help_release_notes)
                .item(&help_shortcuts)
                .separator()
                .item(&help_bug)
                .build()?;

            MenuBuilder::new(handle)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            match id.as_str() {
                "help_docs" => {
                    let _ = tauri_plugin_opener::open_url("https://pikos.app/faq", None::<&str>);
                }
                "help_release_notes" => {
                    let _ = tauri_plugin_opener::open_url(
                        "https://pikos.app/release-notes",
                        None::<&str>,
                    );
                }
                "help_bug" => {
                    let os = if cfg!(target_os = "macos") {
                        "macOS"
                    } else {
                        "Linux"
                    };
                    let url = format!(
                        "https://pikos.app/bugs?os={}&version={}",
                        os,
                        env!("CARGO_PKG_VERSION"),
                    );
                    let _ = tauri_plugin_opener::open_url(&url, None::<&str>);
                }
                "new_page" | "close_page" | "settings" | "toggle_sidebar" | "toggle_calendar"
                | "check_updates" | "keyboard_shortcuts" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval(format!(
                            "window.__onMenuEvent && window.__onMenuEvent('{}')",
                            id
                        ));
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // DB connection
            connect_db,
            switch_workspace,
            // Pages
            get_page,
            create_page,
            update_page,
            delete_page,
            soft_delete_page,
            restore_page,
            list_pages,
            list_pages_today,
            list_completed_pages,
            reorder_pages,
            set_pages_status,
            complete_recurring_page,
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
            list_page_schedules_range,
            // Recurrence rules
            create_recurrence_rule,
            update_recurrence_rule,
            add_rule_exdates,
            remove_rule_exdate,
            delete_recurrence_rule,
            get_recurrence_rule,
            list_recurrence_rules,
            // Search
            search_pages,
            // Tags
            search_tags,
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
            export_json,
            export_markdown,
            get_usage_stats,
            reset_db,
            wipe_app_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
