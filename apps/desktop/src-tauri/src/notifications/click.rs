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
//!
//! **Why a click is sometimes held rather than routed.** A reminder fires
//! because you are not looking at the app, so the common case is clicking a
//! banner with Pikos closed. macOS then delivers the click within a second of
//! the process starting, and at that moment neither half of the routing exists
//! yet: `connect_db` has not opened the pool, so nothing can resolve the row to
//! a page, and the shell has not subscribed to `pikos://open-url`, so the emit
//! lands on an empty room. Both fail quietly, which is how a cold click came to
//! open the app on yesterday's view with no `action` written anywhere. Clicks
//! that arrive early are therefore held in [`PendingClicks`] and replayed when
//! the shell reports itself ready.

// The only caller is the macOS notification delegate, because it is the only OS
// click callback that exists (above). On Linux and Windows nothing here is
// reached — that is the platform finding, not an oversight — but the module
// still builds and its rules still run under test on every platform, so the
// routing behaviour cannot rot on the machines that can't exercise it.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use crate::db::DbState;

/// Clicks that arrived before the shell could receive them (see the module doc).
///
/// Holding them is only safe because the hold is short and self-clearing: the
/// shell calls [`replay_pending_notification_clicks`] on mount, and from then on
/// `listening` is true for the life of the process and every click routes
/// straight through.
#[derive(Default)]
pub struct PendingClicks {
    inner: Mutex<PendingClicksInner>,
}

#[derive(Default)]
struct PendingClicksInner {
    listening: bool,
    queued: Vec<String>,
}

impl PendingClicks {
    /// Whether this click can be routed now. `false` means it has been queued.
    async fn accept(&self, notification_id: &str) -> bool {
        let mut guard = self.inner.lock().await;
        if guard.listening {
            return true;
        }
        guard.queued.push(notification_id.to_string());
        false
    }

    /// Mark the shell as listening and take everything held for it.
    async fn start_listening(&self) -> Vec<String> {
        let mut guard = self.inner.lock().await;
        guard.listening = true;
        std::mem::take(&mut guard.queued)
    }
}

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

/// Handle an OS notification click, or hold it until the shell can receive it.
///
/// Generic over the runtime, like `toggle_sync_calendar`, so a `MockRuntime`
/// test can drive the hold-then-replay sequence end to end — the part a pool
/// alone cannot show.
pub async fn route_click<R: tauri::Runtime>(app: &AppHandle<R>, notification_id: &str) {
    if !app.state::<PendingClicks>().accept(notification_id).await {
        log::info!("notification_click_held (shell not listening yet)");
        return;
    }
    deliver_click(app, notification_id).await;
}

/// Replay whatever was held, and let every later click through.
///
/// The shell calls this once it has subscribed to `pikos://open-url`. It mounts
/// only after the workspace is open, so the pool a replay needs is there by
/// definition — which is why readiness is something the frontend reports rather
/// than something the backend polls for.
#[tauri::command]
pub async fn replay_pending_notification_clicks<R: tauri::Runtime>(app: AppHandle<R>) {
    let held = app.state::<PendingClicks>().start_listening().await;
    for notification_id in held {
        deliver_click(&app, &notification_id).await;
    }
}

/// Focus the window, record the open, navigate.
///
/// Focusing happens first and unconditionally — the user clicked a Pikos banner,
/// so Pikos comes forward even if the log read fails or the pool is not open
/// yet. A failed read degrades to the calendar rather than to nothing.
async fn deliver_click<R: tauri::Runtime>(app: &AppHandle<R>, notification_id: &str) {
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
        assert_eq!(logged_action(&pool, &id).await.as_deref(), Some("opened"));
    }

    #[tokio::test]
    async fn resolving_a_summary_click_routes_to_the_calendar() {
        let pool = test_pool().await;
        let id = pikos_db::log_daily_summary(&pool, "2026-05-25 07:00:00")
            .await
            .unwrap();

        assert_eq!(resolve_click(&pool, &id).await.unwrap(), "pikos://calendar");
    }

    /// The cold-launch sequence, which is the whole point of the queue: the OS
    /// delivers the click, the shell is not up, and the open must still be
    /// recorded once it is. Before the queue existed this wrote nothing at all —
    /// the pool was not open when the click arrived and nothing came back to it.
    #[tokio::test]
    async fn a_click_that_beat_the_shell_records_the_open_once_the_shell_arrives() {
        let pool = test_pool().await;
        insert_test_page(&pool, TestPage::new("p1", "Standup"))
            .await
            .unwrap();
        let id = pikos_db::log_reminder_fired(&pool, "p1", "s1#10", "2026-05-25 08:50:00")
            .await
            .unwrap();

        let app = tauri::test::mock_app();
        app.manage(DbState::with_pool(pool.clone()));
        app.manage(PendingClicks::default());

        route_click(app.handle(), &id).await;
        assert_eq!(
            logged_action(&pool, &id).await,
            None,
            "nothing is written while the click is still held"
        );

        replay_pending_notification_clicks(app.handle().clone()).await;
        assert_eq!(logged_action(&pool, &id).await.as_deref(), Some("opened"));
    }

    async fn logged_action(pool: &sqlx::SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT action FROM notification_log WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_click_before_the_shell_is_listening_is_held_and_replayed_in_order() {
        let pending = PendingClicks::default();

        assert!(!pending.accept("first").await);
        assert!(!pending.accept("second").await);

        assert_eq!(pending.start_listening().await, vec!["first", "second"]);
    }

    #[tokio::test]
    async fn a_click_after_the_shell_is_listening_routes_straight_through() {
        let pending = PendingClicks::default();
        pending.start_listening().await;

        assert!(pending.accept("first").await);
        assert!(
            pending.start_listening().await.is_empty(),
            "an accepted click was routed, so nothing is left to replay"
        );
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
