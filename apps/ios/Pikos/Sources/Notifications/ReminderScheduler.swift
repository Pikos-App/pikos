import BackgroundTasks
import Observation
import PikosCore
import PikosSupport
import UserNotifications

/// Reminders, as local notifications planned ahead.
///
/// The desktop wakes a task every clock minute and asks the workspace what is
/// due. iOS suspends a process within seconds of backgrounding, so that loop
/// would fire almost nothing; the model here is the inverse. The workspace is
/// asked what will fire over the next two weeks, every one of those becomes a
/// `UNNotificationRequest` the OS delivers on its own, and the whole plan is
/// thrown away and rebuilt whenever anything could have changed it — a write
/// to the workspace, the app going to the background, a background refresh
/// landing days later. Rebuilding is cheap (one query, a few dozen requests)
/// and is what makes a page moved, completed or deleted stop ringing without
/// any bookkeeping about which requests to touch.
///
/// Two things are deliberately not here. Quiet hours: the desktop suppresses
/// a reminder inside them, and on the phone the system's Focus modes are the
/// same control, so a second copy would only ever silence something Focus had
/// let through. And the fired log the desktop keeps: the OS delivers without
/// waking the app, so the moment of firing is never seen here — and nothing
/// needs it, since the plan is rebuilt from the workspace, not from history.
@MainActor
@Observable
public final class ReminderScheduler {
    /// Whether the OS will show anything at all. Read on every sync and after
    /// the request, so the settings row can say which of the two switches —
    /// ours or the system's — is the one that is off.
    public private(set) var authorization: UNAuthorizationStatus = .notDetermined

    /// What the last plan produced, for the settings screen to show. A count
    /// of zero with reminders enabled and permission granted is not a fault:
    /// there is simply nothing in the next two weeks that asked.
    public private(set) var plannedCount = 0

    /// The task identifier the OS wakes the app under. Declared once here and
    /// once in `project.yml`; a mismatch means the registration throws and no
    /// refresh ever lands.
    public static let refreshTaskIdentifier = "app.pikos.reminders.refresh"
    static let categoryIdentifier = "app.pikos.reminder"
    static let completeActionIdentifier = "app.pikos.reminder.complete"

    private let workspace: @MainActor () -> Workspace?
    private let preferences: () -> Preferences

    /// Takes the workspace as a closure for the same reason the sync store
    /// does: it opens asynchronously after construction.
    public init(
        workspace: @escaping @MainActor () -> Workspace?,
        preferences: @escaping () -> Preferences = { .shared }
    ) {
        self.workspace = workspace
        self.preferences = preferences
    }

    // MARK: - Permission

    public func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings()
            .authorizationStatus
    }

    /// Ask the system. Asked lazily — the first time there is a reminder to
    /// plan, or from the settings row — rather than at launch, because a
    /// permission prompt on a first launch is one nobody has a reason to say
    /// yes to yet.
    public func requestAuthorization() async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [
                .alert, .sound, .badge,
            ])
        } catch {
            // Denied, or the prompt could not be shown. The status read below
            // says which, and the settings row shows it.
        }
        await refreshAuthorization()
    }

    /// The actions a delivered reminder offers without opening the app.
    ///
    /// Registered once, at launch, before any notification could be delivered
    /// — a category the OS has not seen renders the notification with no
    /// buttons and no error.
    public static func registerCategories() {
        let complete = UNNotificationAction(
            identifier: completeActionIdentifier,
            title: String(localized: "Complete"),
            options: [])
        let category = UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [complete],
            intentIdentifiers: [],
            options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    // MARK: - Planning

    /// Replace every pending reminder with the workspace's current answer.
    ///
    /// Idempotent, and safe to call more often than needed — every caller
    /// does, on purpose. The one thing it must not do is run twice at once and
    /// interleave removals with additions; `syncing` folds a call that arrives
    /// mid-sync into one more pass afterwards.
    public func sync() async {
        if syncing {
            syncAgain = true
            return
        }
        syncing = true
        defer { syncing = false }
        repeat {
            syncAgain = false
            await plan()
        } while syncAgain
    }

    private var syncing = false
    private var syncAgain = false

    private func plan() async {
        let center = UNUserNotificationCenter.current()
        await refreshAuthorization()

        let settings = preferences()
        guard settings.remindersEnabled, let workspace = workspace() else {
            center.removeAllPendingNotificationRequests()
            plannedCount = 0
            return
        }

        let upcoming: [UpcomingReminder]
        do {
            upcoming = try await workspace.upcomingReminders(
                timezone: TimeZone.current.identifier,
                horizonDays: UInt32(ReminderNotification.horizonDays),
                defaultMinutes: settings.defaultReminderMinutes)
        } catch {
            // A workspace that cannot answer leaves the last plan standing:
            // stale reminders beat none, and the next write re-plans.
            return
        }

        // Permission is asked for only once there is something to deliver.
        if authorization == .notDetermined, !upcoming.isEmpty {
            await requestAuthorization()
        }
        guard authorization == .authorized || authorization == .provisional else {
            center.removeAllPendingNotificationRequests()
            plannedCount = 0
            return
        }

        // The soonest first, cut at the budget: the workspace already sorts
        // them, so the ones that fall off the end are the furthest out and
        // the next re-plan will reach them.
        let planned = upcoming.prefix(ReminderNotification.planningLimit)
        center.removeAllPendingNotificationRequests()
        var added = 0
        for reminder in planned {
            guard let request = Self.request(for: reminder) else { continue }
            do {
                try await center.add(request)
                added += 1
            } catch {
                // One bad request — a fire in the past by the time it was
                // added, say — must not stop the rest being planned.
            }
        }
        plannedCount = added
    }

    /// One local notification, from one row of the plan.
    ///
    /// Identified by the workspace's key, which is distinct per occurrence and
    /// lead, and threaded by page so several reminders for one page stack in
    /// Notification Center rather than scattering.
    static func request(for reminder: UpcomingReminder) -> UNNotificationRequest? {
        guard let components = ReminderNotification.fireComponents(reminder.fireAt) else {
            return nil
        }
        let content = UNMutableNotificationContent()
        content.title = reminder.title.isEmpty ? String(localized: "Untitled") : reminder.title
        content.body = ReminderNotification.body(
            scheduledStart: reminder.scheduledStart, fireAt: reminder.fireAt)
        content.sound = .default
        content.threadIdentifier = reminder.pageId
        content.categoryIdentifier = categoryIdentifier
        content.userInfo = [UserInfoKey.pageId: reminder.pageId, UserInfoKey.key: reminder.key]
        return UNNotificationRequest(
            identifier: reminder.key,
            content: content,
            trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false))
    }

    enum UserInfoKey {
        static let pageId = "pageId"
        static let key = "key"
    }

    // MARK: - Background refresh

    /// Ask the OS to wake the app in a while so the plan is extended.
    ///
    /// Called on the way to the background. Twelve hours is a request, not a
    /// promise — the system decides from the app's usage — which is why the
    /// horizon is measured in days and this in hours: a refresh that never
    /// comes costs nothing until the horizon is used up.
    public static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 12 * 60 * 60)
        // A pending request of the same identifier is replaced; a submission
        // refused (Simulator, or the identifier missing from Info.plist) is
        // not worth surfacing to the user — the app still re-plans every time
        // it is opened.
        try? BGTaskScheduler.shared.submit(request)
    }
}

/// Handles a reminder being tapped or acted on.
///
/// The system calls back on whichever queue it likes; every path hops to the
/// main actor before touching the app. Taps go through the router as a
/// `pikos://page/<id>` link, so a notification opens a page by exactly the
/// path a widget or a Shortcut does. "Complete" writes without opening
/// anything, which is the reason it is offered.
final class ReminderNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    private let onOpen: @MainActor (String) -> Void
    private let onComplete: @MainActor (String) async -> Void

    init(
        onOpen: @escaping @MainActor (String) -> Void,
        onComplete: @escaping @MainActor (String) async -> Void
    ) {
        self.onOpen = onOpen
        self.onComplete = onComplete
    }

    /// A reminder that lands while the app is open is still shown. The user
    /// may be in another page, and a reminder they asked for and did not see
    /// is the one failure a reminder cannot have.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let pageId = info[ReminderScheduler.UserInfoKey.pageId] as? String else { return }
        let action = response.actionIdentifier
        if action == ReminderScheduler.completeActionIdentifier {
            await onComplete(pageId)
        } else if action == UNNotificationDefaultActionIdentifier {
            await onOpen(pageId)
        }
    }
}
