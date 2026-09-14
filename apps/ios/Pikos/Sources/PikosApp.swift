import AppIntents
import BackgroundTasks
import PikosCore
import SwiftUI
import UserNotifications

@main
struct PikosApp: App {
    // No default values: `store` and `sync` are built together in `init` so the
    // second can read the first, and a default here would construct a
    // `WorkspaceStore` that is then thrown away.
    @State private var store: WorkspaceStore
    @State private var settings = SettingsStore()
    @State private var sync: CalendarSyncStore
    @State private var exports: ExportStore
    @State private var reminders: ReminderScheduler
    @State private var route = Route.shared

    /// Held for the life of the app: the notification center keeps only a
    /// weak reference to its delegate, and a delegate that is dropped is a
    /// tap on a reminder that opens the app to wherever it last was.
    private let notificationDelegate: ReminderNotificationDelegate

    init() {
        // App Intents run in this process and reach the router through
        // `@Dependency`. Registered here, at the one point that runs before any
        // intent can — an intent may be what launched the app.
        AppDependencyManager.shared.add { Route.shared }

        // The sync store reads the workspace through a closure rather than
        // holding it: `WorkspaceStore.start()` opens it asynchronously, so
        // there is nothing to hand over at construction time and capturing nil
        // once would leave sync permanently unable to do anything.
        let pages = WorkspaceStore()
        _store = State(initialValue: pages)
        let calendars = CalendarSyncStore(workspace: { pages.handle })
        _sync = State(initialValue: calendars)
        _exports = State(initialValue: ExportStore(workspace: { pages.handle }))
        let scheduler = ReminderScheduler(workspace: { pages.handle })
        _reminders = State(initialValue: scheduler)

        // Reminders. The delegate routes a tap through the same link a widget
        // uses, and "Complete" through the same store method the checkbox
        // uses, so a notification is another entry point and not a second
        // code path.
        let delegate = ReminderNotificationDelegate(
            onOpen: { pageId in
                if let url = URL(string: "pikos://page/\(pageId)") {
                    Route.shared.handle(url, store: pages)
                }
            },
            onComplete: { pageId in
                await pages.ensureStarted()
                await pages.setStatus(pageId: pageId, done: true)
            })
        notificationDelegate = delegate
        UNUserNotificationCenter.current().delegate = delegate
        ReminderScheduler.registerCategories()

        // The background refresh has to be registered before launch finishes,
        // which in a SwiftUI app means here. The handler pulls the connected
        // calendars, then re-plans the reminder horizon over what arrived,
        // then asks for the next refresh; the workspace may not be open yet
        // in a background launch, so it is opened on demand. The order is the
        // point: a meeting that landed in the sync gets its reminder planned
        // in the same wake.
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: ReminderScheduler.refreshTaskIdentifier, using: nil
        ) { task in
            // The task object is handed over on the scheduler's queue and is
            // not Sendable; it crosses into the main actor in a box, is
            // completed exactly once there, and is never shared beyond that.
            let handle = BackgroundTaskHandle(task: task)
            let work = Task { @MainActor in
                await pages.ensureStarted()
                await calendars.syncAll(quiet: true)
                await scheduler.sync()
                ReminderScheduler.scheduleBackgroundRefresh()
                handle.task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    /// See the comment at the registration above.
    private struct BackgroundTaskHandle: @unchecked Sendable {
        let task: BGTask
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(settings)
                .environment(sync)
                .environment(exports)
                .environment(reminders)
                .environment(route)
                // Opening the workspace runs migrations, so it happens once,
                // here, in the app process. A widget must never be the process
                // that migrates.
                .task {
                    await store.start()
                    // An intent or deep link may have arrived while the
                    // workspace was still opening.
                    route.applyPending(to: store)
                    await reminders.sync()
                }
                .onOpenURL { url in route.handle(url, store: store) }
        }
    }
}

struct RootView: View {
    @Environment(Route.self) private var route
    @Environment(WorkspaceStore.self) private var store
    @Environment(SettingsStore.self) private var settings
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(CalendarSyncStore.self) private var calendars
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var route = route

        // The shell owns navigation; the screens are content.
        //
        // That split is the one thing worth preserving deliberately, because it
        // is expensive to retrofit and free to keep. A `pikos://page/<id>` link
        // can push only because the path lives out here, and the iPad build —
        // a `NavigationSplitView` with a folder sidebar, the list as content
        // and the editor as detail, closer to the desktop app than to this —
        // replaces this view and nothing else. `PageListScreen` and
        // `SearchScreen` do not know which shell they are in.
        // Both applied at the root rather than per screen. `preferredColorScheme`
        // has to sit above the sheets or a presented sheet keeps the system
        // appearance while the app behind it does not, and the calendar is read
        // by every `DatePicker` below here — including the ones inside sheets,
        // which is exactly what a per-screen modifier would miss.
        TabView(selection: $route.tab) {
            NavigationStack(path: $route.pagesPath) {
                PageListScreen()
                    .navigationDestination(for: String.self) { EditorScreen(pageId: $0) }
                    .noticeOverlay()
            }
            .tabItem { Label("Pages", systemImage: "doc.text") }
            .tag(Route.Tab.pages)

            NavigationStack(path: $route.calendarPath) {
                CalendarScreen()
                    .navigationDestination(for: String.self) { EditorScreen(pageId: $0) }
                    .noticeOverlay()
            }
            .tabItem { Label("Calendar", systemImage: "calendar") }
            .tag(Route.Tab.calendar)

            NavigationStack(path: $route.searchPath) {
                SearchScreen()
                    .navigationDestination(for: String.self) { EditorScreen(pageId: $0) }
                    .noticeOverlay()
            }
            .tabItem { Label("Search", systemImage: "magnifyingglass") }
            .tag(Route.Tab.search)
        }
        // One sheet for quick add, wherever it was asked for. The toolbar
        // button, the empty state and a `pikos://quick-add` link all set the
        // same flag, so there is one place the prefill is read and one place
        // it is cleared.
        .sheet(
            isPresented: $route.isQuickAddPresented,
            // Otherwise the next manual open would inherit the last link's
            // text. `onDismiss` is declared before `content`, so it cannot be
            // written as a second trailing closure.
            onDismiss: { route.quickAddPrefill = "" }
        ) {
            QuickAddSheet(prefill: route.quickAddPrefill)
        }
        // Errors surface here, above every tab and sheet, so a write that
        // fails on the calendar is not an alert waiting on the page list.
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { store.errorMessage != nil },
                set: { if !$0 { store.errorMessage = nil } }
            ),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(store.errorMessage ?? "") }
        )
        // Coming back to the foreground re-reads the workspace. A page added
        // by Siri, a widget or a Shortcut lands while the app is suspended,
        // and without this the list shows the world as it was when the user
        // left — and a page they just dictated is missing from it.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                guard !store.isLoading else { return }
                // The list first, so what is already here shows at once;
                // then the calendars, if it has been a while, and the list
                // again if they brought anything. That second refresh bumps
                // the version, which is what re-plans the reminders for
                // whatever arrived.
                Task {
                    await store.refresh()
                    let before = calendars.lastAutomaticSyncAt
                    await calendars.syncIfStale()
                    if calendars.lastAutomaticSyncAt != before {
                        await store.refresh()
                    }
                }
            case .background:
                // Leaving is the last moment this process is sure to run for
                // a while: re-plan the horizon so it is as fresh as it can be,
                // and ask to be woken to extend it.
                Task { await reminders.sync() }
                ReminderScheduler.scheduleBackgroundRefresh()
            default:
                break
            }
        }
        // Every write bumps the version, and every write can move, add or
        // remove a reminder. Re-planning is one query and a few dozen
        // requests, so it simply follows the version rather than guessing
        // which writes matter. Debounced by cancellation: a burst of writes
        // — a bulk move — plans once, after the last one.
        .task(id: store.dataVersion) {
            guard store.dataVersion > 0 else { return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            await reminders.sync()
        }
        // The two preferences that change the plan without a write.
        .onChange(of: settings.remindersEnabled) { _, _ in Task { await reminders.sync() } }
        .onChange(of: settings.defaultReminderMinutes) { _, _ in
            Task { await reminders.sync() }
        }
        // An App Intent can ask for a scope at any time, not only during
        // launch. `Route.showToday()` has no store to move — it runs from
        // `perform()`, which has no view — so it records the request and this
        // applies it. Without it, "Open today" on an app that is already
        // running switched the tab and left the list showing whatever folder
        // the user was last in.
        .onChange(of: route.pendingScope) { _, pending in
            guard pending != nil else { return }
            route.applyPending(to: store)
        }
        .preferredColorScheme(settings.colorScheme)
        .environment(\.calendar, settings.calendar)
    }
}
