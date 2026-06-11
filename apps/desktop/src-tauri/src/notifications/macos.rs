//! macOS foreground notifications via the modern UserNotifications framework.
//!
//! Why this module exists: `tauri-plugin-notification` delivers through the
//! deprecated `NSUserNotification` API (via `mac-notification-sys`), whose
//! delegate does not implement `userNotificationCenter:shouldPresentNotification:`.
//! macOS's default for that missing method is "don't present while the app is
//! frontmost", so reminders silently fail to show whenever Pikos is the active
//! app (e.g. while the user is editing a page). They only appear reliably when
//! the app is in the background.
//!
//! The modern `UNUserNotificationCenter` lets us install a delegate that
//! implements `willPresentNotification` and returns `.banner | .list | .sound`,
//! which is exactly how Apple documents presenting notifications in the
//! foreground. We deliver reminders through it so they fire regardless of focus.
//!
//! Bundling requirement: `UNUserNotificationCenter currentNotificationCenter`
//! raises an Objective-C exception in a process without a bundle identifier —
//! i.e. the unbundled binary produced by `tauri dev`. That exception is thrown
//! inside the framework's `dispatch_once` initialization, where libdispatch's
//! `_dispatch_client_callout` calls `std::terminate` before it can propagate —
//! so `objc2::exception::catch` around the call cannot save us. We must avoid
//! the call entirely when unbundled: every entry point first checks
//! `is_bundled()` and returns `false` (caller falls back to the plugin path)
//! when there's no bundle identifier. The `catch` wrappers remain as a
//! belt-and-suspenders guard for any other Objective-C exception.

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
use tauri::{AppHandle, Emitter, Manager};

/// AppHandle stashed at `setup()` so the leaked notification delegate can route
/// clicks back into the webview. Set once on the main thread before any
/// notification is delivered.
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
        // Called while the app is frontmost. Returning presentation options
        // forces the banner (and sound) to show instead of being suppressed.
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

        // Called when the user activates a delivered notification (the default
        // action — clicking the banner). Reminders and the daily summary both
        // open the calendar at the current time: a single page block sits near
        // the now-line regardless of its reminder lead time, and the summary
        // covers multiple pages with no single target. We reuse the deep-link
        // channel (`pikos://open-url` → useDeepLinkRouter) so routing stays in
        // one place. Dismiss actions are not delivered here (we don't register a
        // category with a custom dismiss action), so any response is a click.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            _response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            if let Some(app) = NOTIFICATION_APP.get() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = app.emit("pikos://open-url", "pikos://calendar");
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

/// Whether this process is running inside a real app bundle (has a bundle
/// identifier). `UNUserNotificationCenter currentNotificationCenter` throws an
/// uncatchable exception when this is false, so callers must check it before
/// touching the UserNotifications framework. `tauri dev` runs the bare binary
/// from `target/debug/`, where `bundleIdentifier` is nil.
fn is_bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Human-readable name for a `UNAuthorizationStatus`, for diagnostics.
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

/// Install the foreground-presentation delegate and request notification
/// authorization. Call once at startup on the main thread. Returns `true` when
/// the UserNotifications path is available (a properly bundled, signed app);
/// `false` on an unbundled dev binary, where the caller should rely on the
/// tauri-plugin-notification fallback.
pub fn setup(app: &AppHandle) -> bool {
    if !is_bundled() {
        log::warn!("un_setup_unavailable (unbundled build) — using plugin fallback");
        return false;
    }
    // Stash the handle before installing the delegate so click routing works
    // for the first notification onward. Ignore a second set (idempotent setup).
    let _ = NOTIFICATION_APP.set(app.clone());
    objc2::exception::catch(AssertUnwindSafe(|| {
        let center = UNUserNotificationCenter::currentNotificationCenter();

        // The center holds only a weak reference to its delegate, so the
        // delegate must outlive this call. It lives for the whole app, so we
        // intentionally leak the one instance rather than track ownership.
        let delegate = PikosNotificationDelegate::new();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        std::mem::forget(delegate);

        let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound;
        let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            // A non-null error means the request itself failed (e.g. the app
            // can't register with usernoted because of a code-signature /
            // bundle mismatch) — granted is false but for a reason distinct
            // from a user "Don't Allow". Surface its localized description so
            // the cause is named instead of guessed.
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

        // Independently read the center's current authorization status. This
        // is the value delivery actually depends on, and it can disagree with
        // the System Settings toggle when the request errored — if it logs
        // Denied/NotDetermined while System Settings shows the app allowed,
        // the running binary isn't the one usernoted has authorized.
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
    .map_err(|_| log::warn!("un_setup_unavailable (unbundled build?) — using plugin fallback"))
    .is_ok()
}

/// Deliver a notification immediately via UserNotifications. Returns `true` on
/// success; `false` (e.g. unbundled dev binary) means the caller should fall
/// back to the plugin.
pub fn deliver(title: &str, body: &str) -> bool {
    if !is_bundled() {
        return false;
    }
    objc2::exception::catch(AssertUnwindSafe(|| {
        let center = UNUserNotificationCenter::currentNotificationCenter();

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));

        // `nil` trigger delivers right away. A unique identifier avoids the
        // system coalescing distinct reminders into one.
        let identifier = NSString::from_str(&uuid::Uuid::new_v4().to_string());
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );
        // Pass a completion handler so a rejected add (e.g. unauthorized, or a
        // usernoted error) is logged. Without it the scheduler logs
        // `notification_fired` while macOS silently drops the banner — exactly
        // the "fires in the log but nothing shows" symptom.
        let completion = RcBlock::new(move |error: *mut NSError| {
            if let Some(err) = unsafe { error.as_ref() } {
                log::warn!("un_deliver_failed error={}", err.localizedDescription());
            }
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    }))
    .is_ok()
}
