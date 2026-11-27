import BackgroundTasks
import Observation
import PikosCore
import PikosSupport
// Before the iOS 26 SDK its settings and delivered notifications are not marked Sendable.
@preconcurrency import UserNotifications
import os

/// Reminders, as local notifications planned ahead.
///
/// iOS suspends a process within seconds of backgrounding, so the desktop's wake-every-minute
/// loop would fire almost nothing. Instead the workspace is asked what fires over the next two
/// weeks, each becomes a `UNNotificationRequest` the OS delivers on its own, and the whole plan
/// is rebuilt whenever anything could have changed it. Rebuilding is cheap and is what makes a
/// page moved, completed or deleted stop ringing with no bookkeeping.
///
/// Not here, deliberately: quiet hours, because Focus is the same control on the phone, and the
/// desktop's fired log, because the OS delivers without waking the app and the plan is rebuilt
/// from the workspace, not from history.
@MainActor
@Observable
public final class ReminderScheduler {
    /// Whether the OS will show anything at all, so the settings row can say which switch, ours or
    /// the system's, is off.
    public private(set) var authorization: UNAuthorizationStatus = .notDetermined

    /// What the last plan produced. A count of zero with reminders enabled and permission granted
    /// is not a fault: nothing in the next two weeks asked.
    public private(set) var plannedCount = 0

    /// The soonest reminder in the plan: a named time can be checked against the day, a count
    /// cannot.
    public private(set) var nextPlanned: UpcomingReminder?

    /// The task identifier the OS wakes the app under. Declared once here and
    /// once in `project.yml`; a mismatch means the registration throws and no
    /// refresh ever lands.
    public nonisolated static let refreshTaskIdentifier = "app.pikos.reminders.refresh"
    nonisolated static let categoryIdentifier = "app.pikos.reminder"
    /// `nonisolated`, all three: names on the wire that the notification delegate reads on whatever
    /// queue the system calls it on.
    nonisolated static let completeActionIdentifier = "app.pikos.reminder.complete"

    private let workspace: @MainActor () -> Workspace?
    private let preferences: () -> Preferences
    private nonisolated static let log = Logger(subsystem: "app.pikos", category: "reminders")

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

    /// Ask the system. Asked lazily, not at launch: a permission prompt on first launch is one
    /// nobody has a reason to accept yet.
    public func requestAuthorization() async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [
                .alert, .sound, .badge,
            ])
        } catch {
            // Denied, or the prompt could not be shown. The status read below
            // says which, and the settings row shows it.
            Self.log.notice("asking for notification permission failed: \(FailureText.kind(error), privacy: .public)")
        }
        await refreshAuthorization()
    }

    /// The actions a delivered reminder offers without opening the app. Registered once at launch,
    /// before any notification could be delivered: an unseen category renders no buttons and no error.
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

    /// Replace every pending reminder with the workspace's current answer. Idempotent, and safe to
    /// call more often than needed. It must not run twice at once and interleave removals with
    /// additions, so `syncing` folds a mid-sync call into one more pass.
    public func sync() async {
        #if DEBUG
            // A permission prompt over a design screenshot is noise, not a test of reminders.
            if DemoWorkspace.isRequested { return }
        #endif
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
            nextPlanned = nil
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
            Self.log.error(
                "planning reminders failed, so the last plan stands: \(FailureText.kind(error), privacy: .public): \(FailureText.message(error), privacy: .private)"
            )
            return
        }

        // Permission is asked for only once there is something to deliver.
        if authorization == .notDetermined, !upcoming.isEmpty {
            await requestAuthorization()
        }
        guard authorization == .authorized || authorization == .provisional else {
            center.removeAllPendingNotificationRequests()
            plannedCount = 0
            nextPlanned = nil
            return
        }

        await tidyDelivered(in: center, workspace: workspace)

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
                Self.log.error(
                    "scheduling a reminder for \(reminder.pageId, privacy: .public) failed: \(FailureText.kind(error), privacy: .public)"
                )
            }
        }
        plannedCount = added
        nextPlanned = planned.first
    }

    /// Take down delivered reminders for pages that are now done or gone. Pending requests are
    /// rebuilt on every plan and so follow a completion, but delivered ones sit in Notification
    /// Center, and a banner for a task ticked an hour ago makes the rest untrusted. Only `NotFound`
    /// counts as gone; any other failure leaves the notification, since a stale banner beats one
    /// removed on a guess.
    private func tidyDelivered(in center: UNUserNotificationCenter, workspace: Workspace) async {
        let delivered = await center.deliveredNotifications()
        guard !delivered.isEmpty else { return }

        // One read per page, not per notification: several reminders for one
        // page share its answer.
        var pageIds: Set<String> = []
        for notification in delivered {
            if let id = notification.request.content.userInfo[UserInfoKey.pageId] as? String {
                pageIds.insert(id)
            }
        }
        var finished: Set<String> = []
        for id in pageIds {
            do {
                let page = try await workspace.getPage(id: id)
                if page.status == "done" { finished.insert(id) }
            } catch WorkspaceError.NotFound {
                finished.insert(id)
            } catch {
                // Left alone, as the doc says.
                Self.log.notice(
                    "reading \(id, privacy: .public) to tidy its reminders failed: \(FailureText.kind(error), privacy: .public)"
                )
            }
        }
        guard !finished.isEmpty else { return }

        let stale = delivered.filter { notification in
            guard let id = notification.request.content.userInfo[UserInfoKey.pageId] as? String
            else { return false }
            return finished.contains(id)
        }
        center.removeDeliveredNotifications(withIdentifiers: stale.map(\.request.identifier))
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

    /// Ask the OS to wake the app in a while so the plan is extended. Twelve hours is a request,
    /// not a promise, which is why the horizon is days and this is hours: a refresh that never
    /// comes costs nothing until the horizon is used up.
    public static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 12 * 60 * 60)
        // Replaces a pending request of the same identifier. A refused submission (Simulator, or the
        // identifier missing from Info.plist) isn't worth surfacing: the app re-plans whenever opened.
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            log.notice("asking for a background refresh failed: \(FailureText.kind(error), privacy: .public)")
        }
    }
}

/// Handles a reminder being tapped or acted on, hopping to the main actor before touching the
/// app. "Complete" writes without opening anything, which is why it is offered.
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

    /// A reminder that lands while the app is open is still shown: the one failure a reminder
    /// cannot have is the user not seeing it.
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
