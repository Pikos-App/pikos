use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager};

mod db;
mod markdown;
mod notifications;

use db::{
    connect_db, DbState,
    dev::{backdate_page, backup_db, backup_db_before_import, export_json, export_markdown, get_usage_stats, reset_db},
    folders::{
        create_folder, delete_folder, get_folder, list_folders, reorder_folders,
        restore_folder, soft_delete_folder, update_folder,
    },
    pages::{complete_recurring_page, create_page, delete_page, get_page, list_completed_pages, list_pages, list_pages_today, reorder_pages, restore_page, soft_delete_page, update_page},
    schedules::{
        create_page_schedule, create_recurrence_rule, delete_page_schedule,
        delete_recurrence_rule, get_recurrence_rule, list_page_schedules,
        list_page_schedules_range, list_recurrence_rules, update_page_schedule,
        update_recurrence_rule,
    },
    search::search_pages,
    tags::search_tags,
    notifications::{
        create_page_reminder, delete_page_reminder, delete_page_reminders,
        list_page_reminders,
    },
};

use notifications::scheduler::{update_notification_settings, NotificationSettingsState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DbState::new())
        .manage(NotificationSettingsState::new())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(notifications::scheduler::run(handle));
            Ok(())
        })
        .menu(|handle| {
            // Custom menu without Print (Cmd+P) — that shortcut is used for search palette.
            let settings = MenuItemBuilder::new("Settings…")
                .id("settings")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?;
            let app_menu = SubmenuBuilder::new(handle, "Pikos")
                .about(Some(
                    AboutMetadataBuilder::new()
                        .website(Some("https://pikos.app"))
                        .comments(Some("Notes, tasks, and calendar — local-first"))
                        .build(),
                ))
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
            let pikos_help = MenuItemBuilder::new("Pikos Help")
                .id("pikos_help")
                .build(handle)?;
            let help_menu = SubmenuBuilder::new(handle, "Help")
                .item(&pikos_help)
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
                "pikos_help" => {
                    let _ = tauri_plugin_opener::open_url("https://pikos.app", None::<&str>);
                }
                "new_page" | "close_page" | "settings"
                | "toggle_sidebar" | "toggle_calendar" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval(
                            &format!("window.__onMenuEvent && window.__onMenuEvent('{}')", id)
                        );
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // DB connection
            connect_db,
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
            complete_recurring_page,
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
            // Dev / settings
            backdate_page,
            backup_db,
            backup_db_before_import,
            export_json,
            export_markdown,
            get_usage_stats,
            reset_db,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
