//! macOS foreground notifications via the modern UserNotifications framework.
//!
//! `tauri-plugin-notification` delivers through the deprecated `NSUserNotification`
//! API, whose delegate lacks `userNotificationCenter:shouldPresentNotification:`, so
//! macOS doesn't present a banner while Pikos is frontmost. `UNUserNotificationCenter`
//! with a delegate returning `.banner | .list | .sound` presents regardless of focus.
//!
//! `UNUserNotificationCenter currentNotificationCenter` raises an Objective-C
//! exception in a process not running from an app bundle (the unbundled binary of
//! `tauri dev` or a `--no-bundle` build). It is thrown inside the framework's
//! `dispatch_once` initialization, where libdispatch calls `std::terminate` before
//! it can propagate, so `objc2::exception::catch` cannot save us. Every entry point
//! first checks `is_bundled()` and returns `false` (the caller falls back to the
//! plugin path) when unbundled. The `catch` wrappers guard any other Objective-C
//! exception.

#![allow(non_snake_case)]

use std::panic::AssertUnwindSafe;
use std::ptr::NonNull;
use std::sync::OnceLock;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

/// Lets the leaked notification delegate route clicks back into the webview. Set once on the
/// main thread before any notification is delivered.
static NOTIFICATION_APP: OnceLock<AppHandle> = OnceLock::new();

// rustfmt would move the same-line `// SAFETY:` comments (required by the
// source audit) off the `unsafe impl` lines below, so skip formatting here.
#[rustfmt::skip]
define_class!(
    // SAFETY: NSObject has no subclassing requirements we violate, and the
    // delegate holds no Rust ivars / Drop logic.
    #[unsafe(super(NSObject))]
    #[name = "PikosNotificationDelegate"]
    struct PikosNotificationDelegate;

    unsafe impl NSObjectProtocol for PikosNotificationDelegate {} // SAFETY: NSObject conformance, no added invariants

    unsafe impl UNUserNotificationCenterDelegate for PikosNotificationDelegate { // SAFETY: selector + signature match the protocol's willPresent method
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let options = UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound;
            completion_handler.call((options,));
        }

        // The only click callback any desktop platform gives us (see `notifications::click`).
        // The request identifier is the `notification_log` row id, so the click marks that row
        // opened and knows which page to open, via the deep-link channel. We register no
        // dismiss action, so any response is a click.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            // Read the identifier synchronously — the response object is only
            // valid for the duration of this callback.
            let identifier: String = unsafe {
                let notification: Retained<UNNotification> = msg_send![response, notification];
                let request: Retained<UNNotificationRequest> = msg_send![&*notification, request];
                let id: Retained<NSString> = msg_send![&*request, identifier];
                id.to_string()
            };
            if let Some(app) = NOTIFICATION_APP.get() {
                // The log read/write is async, and the OS wants this callback
                // back promptly, so hand the rest to the async runtime.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::notifications::click::route_click(&app, &identifier).await;
                });
            }
            completion_handler.call(());
        }
    }
);

impl PikosNotificationDelegate {
    fn new() -> Retained<Self> {
        unsafe { msg_send![Self::alloc(), init] } // SAFETY: standard alloc/init of a no-ivar NSObject subclass
    }
}

/// Callers must check this before touching the UserNotifications framework, which throws an
/// uncatchable exception unbundled. Read from where the process runs, not from
/// `bundleIdentifier`: the plugin fallback gives an unbundled process an identifier on its
/// first notification, so an identifier check passes from then on and the second aborts the app.
fn is_bundled() -> bool {
    NSBundle::mainBundle()
        .bundlePath()
        .to_string()
        .ends_with(".app")
}

fn auth_status_str(status: UNAuthorizationStatus) -> &'static str {
    match status.0 {
        0 => "not_determined",
        1 => "denied",
        2 => "authorized",
        3 => "provisional",
        4 => "ephemeral",
        _ => "unknown",
    }
}

/// Call once at startup on the main thread. `false` on an unbundled dev binary, where the
/// caller relies on the plugin fallback.
pub fn setup(app: &AppHandle) -> bool {
    if !is_bundled() {
        log::warn!("un_setup_unavailable (unbundled build) — using plugin fallback");
        return false;
    }
    // Before the delegate, so click routing works from the first notification.
    let _ = NOTIFICATION_APP.set(app.clone());
    objc2::exception::catch(AssertUnwindSafe(|| {
        let center = UNUserNotificationCenter::currentNotificationCenter();

        // The center holds its delegate weakly, so the one instance is leaked deliberately.
        let delegate = PikosNotificationDelegate::new();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        std::mem::forget(delegate);

        let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound;
        let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            // A non-null error means the request itself failed (e.g. a code-signature mismatch),
            // distinct from a user "Don't Allow"; name the cause rather than guess.
            match unsafe { error.as_ref() } {
                Some(err) => log::warn!(
                    "un_authorization granted={} error={}",
                    granted.as_bool(),
                    err.localizedDescription()
                ),
                None => log::info!("un_authorization granted={}", granted.as_bool()),
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(options, &handler);

        // Delivery depends on this value, and it can disagree with System Settings when the request
        // errored: Denied/NotDetermined there means this binary isn't the one usernoted authorized.
        let settings_handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let settings = unsafe { settings.as_ref() };
            log::info!(
                "un_settings authorization_status={} alert_setting={}",
                auth_status_str(settings.authorizationStatus()),
                settings.alertSetting().0
            );
        });
        center.getNotificationSettingsWithCompletionHandler(&settings_handler);
    }))
    .map_err(|e| {
        log::warn!(
            "un_setup_unavailable exception={e:?} (unbundled build?) — using plugin fallback"
        )
    })
    .is_ok()
}

const AUTHORIZATION_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Whether the system has notifications turned off for Pikos, read fresh so a
/// change in System Settings counts from the next tick. Only an explicit denial
/// counts: an unbundled build, a read that fails or times out, and every other
/// status answer `false`, so delivery goes ahead as before. Authorized with the
/// alert style set to None is not a denial either, since macOS still lists the
/// notification in Notification Center.
pub async fn notifications_off() -> bool {
    if !is_bundled() {
        return false;
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    // Reduced to text before the await: the exception object isn't `Send`.
    let read_failed = objc2::exception::catch(AssertUnwindSafe(|| {
        let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                let _ = tx.send(status);
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getNotificationSettingsWithCompletionHandler(&handler);
    }))
    .err()
    .map(|e| format!("exception={e:?}"));
    if let Some(why) = read_failed {
        note_settings_unread(&why);
        return false;
    }

    match tokio::time::timeout(AUTHORIZATION_READ_TIMEOUT, rx).await {
        Ok(Ok(status)) => status == UNAuthorizationStatus::Denied,
        Ok(Err(_)) => {
            note_settings_unread("the handler was dropped without answering");
            false
        }
        Err(_) => {
            note_settings_unread("no answer within the timeout");
            false
        }
    }
}

/// The read runs every tick, so a failure that persists is logged once per launch rather than
/// every minute. Delivery goes ahead either way.
fn note_settings_unread(why: &str) {
    static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        log::warn!("un_settings_unread {why}; delivering as if notifications are on");
    }
}

/// `false` (e.g. unbundled dev binary) means the caller should fall back to the plugin.
/// `identifier` is the `notification_log` row id; the click callback reads it back.
pub fn deliver(title: &str, body: &str, identifier: &str) -> bool {
    if !is_bundled() {
        return false;
    }
    let logged_id = identifier.to_string();
    objc2::exception::catch(AssertUnwindSafe(|| {
        let center = UNUserNotificationCenter::currentNotificationCenter();

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));

        // The row id is unique per delivery, so the system doesn't coalesce distinct reminders.
        let identifier = NSString::from_str(identifier);
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );
        // Without a completion handler a rejected add is silent: the scheduler logs
        // `notification_fired` while macOS drops the banner.
        let completion = RcBlock::new(move |error: *mut NSError| {
            if let Some(err) = unsafe { error.as_ref() } {
                log::warn!(
                    "un_deliver_failed log_id={logged_id} domain={} code={} error={}",
                    err.domain(),
                    err.code(),
                    err.localizedDescription()
                );
            }
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    }))
    .map_err(|e| log::warn!("un_deliver_exception exception={e:?}; using plugin fallback"))
    .is_ok()
}
