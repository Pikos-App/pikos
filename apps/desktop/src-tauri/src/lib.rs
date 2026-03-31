use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, WindowEvent};

mod db;
mod markdown;

use db::{
    connect_db, DbState,
    dev::{backup_db, export_json, export_markdown, get_db_stats, reset_db},
    folders::{
        create_folder, delete_folder, get_folder, list_folders, reorder_folders, update_folder,
    },
    pages::{create_page, delete_page, get_page, list_pages, list_pages_today, reorder_pages, restore_page, soft_delete_page, update_page},
    schedules::{
        create_page_schedule, create_recurrence_rule, delete_page_schedule,
        delete_recurrence_rule, get_recurrence_rule, list_page_schedules,
        list_page_schedules_range, update_page_schedule, update_recurrence_rule,
    },
    search::search_pages,
    tags::search_tags,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DbState::new())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .menu(|handle| {
            // Custom menu without Print (Cmd+P) — that shortcut is used for search palette.
            let app_menu = SubmenuBuilder::new(handle, "Pikos")
                .about(Some(AboutMetadataBuilder::new().build()))
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let file_menu = SubmenuBuilder::new(handle, "File")
                .close_window()
                .build()?;

            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

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
                .item(&toggle_calendar)
                .build()?;

            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .separator()
                .fullscreen()
                .build()?;

            MenuBuilder::new(handle)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&window_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            match id {
                "toggle_sidebar" | "toggle_calendar" => {
                    let _ = app.emit("menu-event", id);
                }
                _ => {}
            }
        })
        .on_window_event(|_window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
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
            reorder_pages,
            // Folders
            get_folder,
            create_folder,
            update_folder,
            delete_folder,
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
            // Search
            search_pages,
            // Tags
            search_tags,
            // Dev / settings
            backup_db,
            export_json,
            export_markdown,
            get_db_stats,
            reset_db,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
