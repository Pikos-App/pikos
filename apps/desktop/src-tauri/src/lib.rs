use tauri::WindowEvent;

mod db;

use db::{
    connect_db, DbState,
    folders::{
        create_folder, delete_folder, get_folder, list_folders, reorder_folders, update_folder,
    },
    pages::{
        create_page, delete_page, get_page, list_pages, reorder_pages, update_page,
    },
    search::search_pages,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DbState::new())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
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
            list_pages,
            reorder_pages,
            // Folders
            get_folder,
            create_folder,
            update_folder,
            delete_folder,
            list_folders,
            reorder_folders,
            // Search
            search_pages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
