//! What a click on a delivered notification does.
//!
//! **What the platform actually gives us.** `tauri-plugin-notification` 2.3.3
//! has no click callback and no action buttons on desktop at all: its desktop
//! `show()` (src/desktop.rs) copies title/body/icon/sound onto a `notify_rust`
//! notification and drops everything else, and `register_action_types` — the API
//! that would declare Done/Snooze buttons — is `#[cfg(mobile)]`. A notification
//! sent through the plugin is therefore write-only; nothing comes back when the
//! user clicks it, on any desktop platform.
//!
//! macOS is the exception, because Pikos already bypasses the plugin there:
//! `notifications::macos` delivers through `UNUserNotificationCenter` (for
//! foreground presentation) and installs a delegate, and that delegate's
//! `didReceiveNotificationResponse:` is a real OS click callback. So
//! click-through is macOS-only, and Linux/Windows reminders stay one-way until
//! the plugin grows a callback — noted here rather than papered over with a
//! button that would do nothing.
//!
//! **How a click finds its row.** The notification's OS identifier *is* its
//! `notification_log` row id (the scheduler passes what `log_reminder_fired`
//! returned). That makes the mapping durable — a banner sitting in Notification
//! Centre overnight still routes after a restart — and leaves no live-banner
//! table to keep in memory or evict. The log write happens here, in Rust, off
//! the OS callback; the webview is only told where to navigate.

// The only caller is the macOS notification delegate, because it is the only OS
// click callback that exists (above). On Linux and Windows nothing here is
// reached — that is the platform finding, not an oversight — but the module
// still builds and its rules still run under test on every platform, so the
// routing behaviour cannot rot on the machines that can't exercise it.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use tauri::{AppHandle, Emitter, Manager};

use crate::db::DbState;

/// The deep link a click on a notification should route to.
///
/// Reuses the `pikos://` channel the deep-link router already dispatches
/// (`shared/deep-link/useDeepLinkRouter.ts`), so a notification click lands in
/// the same navigation as an OS-level `pikos://page/…` open — one routing path,
/// not two. A notification with no page (the daily summary, or a row the prune
/// has since removed) falls back to the calendar, which is where the summary has
/// always pointed.
pub(crate) fn deep_link_for(page_id: Option<&str>) -> String {
    match page_id {
        Some(page_id) => format!("pikos://page/{page_id}"),
        None => "pikos://calendar".to_string(),
    }
}

/// Mark the clicked notification opened and answer with the link to route to.
///
/// Split from [`route_click`] so the part with rules — the log write and the
/// routing decision — is testable against a pool, with no Tauri runtime and no
/// OS callback in sight.
pub(crate) async fn resolve_click(
    pool: &sqlx::SqlitePool,
    notification_id: &str,
) -> Result<String, sqlx::Error> {
    let page_id = pikos_db::mark_notification_opened(pool, notification_id).await?;
    Ok(deep_link_for(page_id.as_deref()))
}

/// Handle an OS notification click: focus the window, record the open, navigate.
///
/// Focusing happens first and unconditionally — the user clicked a Pikos banner,
/// so Pikos comes forward even if the log read fails or the pool is not open
/// yet. A failed read degrades to the calendar rather than to nothing.
pub async fn route_click(app: &AppHandle, notification_id: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    let link = match app.state::<DbState>().get_pool().await {
        Ok(pool) => match resolve_click(&pool, notification_id).await {
            Ok(link) => link,
            Err(_) => {
                // Content-free: the sqlx Display impl can echo parameter values.
                log::warn!("notification_click_log_failed");
                deep_link_for(None)
            }
        },
        Err(_) => deep_link_for(None),
    };

    let _ = app.emit("pikos://open-url", link);
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikos_db::{insert_test_page, test_pool, TestPage};

    #[test]
    fn a_page_notification_routes_to_its_page() {
        assert_eq!(
            deep_link_for(Some("11111111-1111-4111-8111-111111111111")),
            "pikos://page/11111111-1111-4111-8111-111111111111"
        );
    }

    #[test]
    fn a_page_less_notification_routes_to_the_calendar() {
        assert_eq!(deep_link_for(None), "pikos://calendar");
    }

    #[tokio::test]
    async fn resolving_a_click_records_the_open_and_routes_to_the_page() {
        let pool = test_pool().await;
        insert_test_page(&pool, TestPage::new("p1", "Standup"))
            .await
            .unwrap();
        let id = pikos_db::log_reminder_fired(&pool, "p1", "s1#10", "2026-05-25 08:50:00")
            .await
            .unwrap();

        assert_eq!(
            resolve_click(&pool, &id).await.unwrap(),
            "pikos://page/p1",
            "the click routes to the reminded page"
        );
        let action: Option<String> =
            sqlx::query_scalar("SELECT action FROM notification_log WHERE id = ?")
                .bind(&id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(action.as_deref(), Some("opened"));
    }

    #[tokio::test]
    async fn resolving_a_summary_click_routes_to_the_calendar() {
        let pool = test_pool().await;
        let id = pikos_db::log_daily_summary(&pool, "2026-05-25 07:00:00")
            .await
            .unwrap();

        assert_eq!(resolve_click(&pool, &id).await.unwrap(), "pikos://calendar");
    }

    #[tokio::test]
    async fn resolving_an_unknown_click_routes_to_the_calendar() {
        let pool = test_pool().await;
        assert_eq!(
            resolve_click(&pool, "not-a-row").await.unwrap(),
            "pikos://calendar",
            "a banner that outlived its log row still opens the app"
        );
    }
}
