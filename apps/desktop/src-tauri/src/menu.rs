//! The application menu: what it contains, and what each item does.
//!
//! Lifted out of `run()` whole — the builder chain there is about wiring
//! plugins, state and windows, and 100-odd lines of menu construction in the
//! middle of it buried that.

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder,
};
use tauri::{AppHandle, Manager, Runtime};

/// Build the whole menu bar. Handed straight to `Builder::menu`.
pub fn build<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
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
}

/// Route a menu click. The items the frontend owns are forwarded to it by id;
/// the rest are handled here.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().0.clone();
    match id.as_str() {
        "help_docs" => {
            let _ = tauri_plugin_opener::open_url("https://pikos.app/faq", None::<&str>);
        }
        "help_release_notes" => {
            let _ = tauri_plugin_opener::open_url("https://pikos.app/release-notes", None::<&str>);
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
}
