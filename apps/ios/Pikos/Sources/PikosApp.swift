import AppIntents
import BackgroundTasks
import CoreSpotlight
import PikosCore
import PikosSupport
import SwiftUI
import UserNotifications
import WidgetKit

@main
struct PikosApp: App {
    // No default values: `store` and `sync` are built together in `init` so the second can read
    // the first, and a default would construct a `WorkspaceStore` that is thrown away.
    @State private var store: WorkspaceStore
    @State private var settings = SettingsStore()
    @State private var sync: CalendarSyncStore
    @State private var exports: ExportStore
    @State private var reminders: ReminderScheduler
    @State private var route = Route.shared
    /// The home screen's search, kept in step with the workspace. Only the shell talks to it.
    @State private var spotlight: SpotlightIndexer
    @State private var deviceSync: DeviceSync

    /// Held for the life of the app: the notification center keeps only a weak reference to its
    /// delegate, and a dropped one would leave a reminder's tap opening the app wherever it was.
    private let notificationDelegate: ReminderNotificationDelegate

    init() {
        // App Intents run in this process and reach the router through `@Dependency`. Registered
        // here because an intent may be what launched the app.
        AppDependencyManager.shared.add { Route.shared }

        // The sync store reads the workspace through a closure: `WorkspaceStore.start()` opens it
        // asynchronously, so capturing nil once would leave sync permanently unable to do anything.
        let pages = WorkspaceStore()
        _store = State(initialValue: pages)
        let calendars = CalendarSyncStore(workspace: { pages.handle })
        _sync = State(initialValue: calendars)
        _exports = State(initialValue: ExportStore(workspace: { pages.handle }))
        let scheduler = ReminderScheduler(workspace: { pages.handle })
        _reminders = State(initialValue: scheduler)
        _spotlight = State(initialValue: SpotlightIndexer(workspace: { pages.handle }))
        let device = DeviceSync(workspace: { pages.handle }, onApplied: { await pages.refresh() })
        _deviceSync = State(initialValue: device)

        // Here rather than in the first screen's task: a push can launch the app in the background,
        // where no screen appears, and Apple's sync engine takes the push only once it exists.
        Task { @MainActor in
            await pages.ensureStarted()
            await device.resume()
        }

        PikosTips.configure()

        #if DEBUG
            // A UI test run on a phone fails the moment the screen locks.
            if ProcessInfo.processInfo.environment[WorkspaceLocation.workspaceOverrideKey] != nil {
                UIApplication.shared.isIdleTimerDisabled = true
            }
        #endif

        // The delegate routes a tap through the same link a widget uses, and "Complete" through the
        // same store method as the checkbox, so a notification is not a second code path.
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

        // Registered before launch finishes. The handler pulls the connected calendars, then
        // re-plans the reminder horizon over what arrived, then asks for the next refresh, so a
        // meeting that just synced gets its reminder in the same wake. The workspace may not be
        // open in a background launch, so it is opened on demand.
        // The main queue: the handler is main-actor code, and on the scheduler's own queue the
        // isolation check stopped the app every time a refresh ran.
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: ReminderScheduler.refreshTaskIdentifier, using: .main
        ) { task in
            // The task object is not Sendable; it crosses into the main actor in a box, is
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
            #if DEBUG
                if let board = WidgetGallery.requestedBoard {
                    WidgetGallery(board: board)
                } else {
                    shell
                }
            #else
                shell
            #endif
        }
    }

    private var shell: some View {
        RootView(spotlight: spotlight)
            .environment(store)
            .environment(settings)
            .environment(sync)
            .environment(exports)
            .environment(reminders)
            .environment(route)
            .environment(deviceSync)
            .onChange(of: store.dataVersion) {
                Task { await deviceSync.localChangesHappened() }
            }
            .onChange(of: store.typedSaves) {
                Task { await deviceSync.localChangesHappened() }
            }
            .onReceive(
                NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            ) { _ in
                Task { await deviceSync.fetchNow() }
            }
            .onReceive(
                NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            ) { _ in
                Task { await deviceSync.localChangesHappened() }
            }
            // Opening the workspace runs migrations, so it happens once, in the app process: a
            // widget must never be the one that migrates.
            .task {
                await store.ensureStarted()
                // An intent or deep link may have arrived while the workspace was opening.
                route.applyPending(to: store)
                #if DEBUG
                    await DemoWorkspace.applyScreen(route: route, store: store)
                #endif
                await reminders.sync()
                // The launch's own `.active` arrives while the workspace is still opening, so
                // the foreground sync skips it; this is that sync for a cold launch.
                let before = sync.lastAutomaticSyncAt
                await sync.syncIfStale()
                if sync.lastAutomaticSyncAt != before {
                    await store.refresh()
                }
            }
            .onOpenURL { url in route.handle(url, store: store) }
            // A page chosen from the home screen's search goes through the same link a widget tap
            // uses, so Spotlight is not a second code path.
            .onContinueUserActivity(CSSearchableItemActionType) { activity in
                guard let pageId = SpotlightIndexer.pageId(from: activity),
                    let url = URL(string: "pikos://page/\(pageId)")
                else { return }
                route.handle(url, store: store)
            }
    }
}

extension View {
    /// Where each `Route.Destination` leads, in whichever stack holds `Route.path`.
    func routeDestinations() -> some View {
        navigationDestination(for: Route.Destination.self) { destination in
            switch destination {
            case .page(let id): EditorScreen(pageId: id)
            case .search: SearchScreen()
            }
        }
    }
}

struct RootView: View {
    let spotlight: SpotlightIndexer

    @Environment(Route.self) private var route
    @Environment(WorkspaceStore.self) private var store
    @Environment(SettingsStore.self) private var settings
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(CalendarSyncStore.self) private var calendars
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var widthClass
    @Environment(\.verticalSizeClass) private var heightClass

    /// The page that was open when the app was last put away, and when. Scene storage rather
    /// than a preference: it is this window's state, one of several on iPad, and is forgotten with
    /// the scene. See `restoreOpenPage`.
    @SceneStorage("pikos.openPage") private var openPage = ""
    @SceneStorage("pikos.openPageAt") private var openPageAt: Double = 0

    var body: some View {
        @Bindable var route = route

        let layout = ShellLayout(horizontal: widthClass, vertical: heightClass)

        Group {
            if let failure = store.openFailure {
                ContentUnavailableView {
                    Label("Pikos couldn't open its workspace", systemImage: "externaldrive.badge.exclamationmark")
                } description: {
                    Text(failure)
                        .textSelection(.enabled)
                }
            } else if layout == .split {
                WorkspaceSplitView()
            } else {
                // The path lives on the router so a `pikos://page/<id>` link can push from outside.
                NavigationStack(path: $route.path) {
                    WorkspaceScreen()
                        .routeDestinations()
                }
            }
        }
        .environment(\.shellLayout, layout)
        .tint(.textAction)
        // Above the shell rather than in it, so a sheet stays up when the window changes shape.
        .sheet(isPresented: $route.isSettingsPresented) { SettingsScreen() }
        .sheet(isPresented: $route.isTrashPresented) { TrashSheet() }
        .sheet(isPresented: $route.isFolderManagerPresented) { FolderManagerSheet() }
        // One sheet for quick add, wherever it was asked for, so the prefill is read and cleared
        // in one place.
        .sheet(
            isPresented: $route.isQuickAddPresented,
            // Otherwise the next manual open would inherit the last link's text or calendar slot.
            // `onDismiss` is declared before `content`, so it cannot be a second trailing closure.
            onDismiss: { route.clearQuickAddPrefill() }
        ) {
            QuickAddSheet(
                prefill: route.quickAddPrefill.isEmpty ? route.quickAddDraft : route.quickAddPrefill,
                prefillDate: route.quickAddPrefillDate,
                prefillMinutes: route.quickAddPrefillMinutes,
                context: route.quickAddContext)
        }
        // Errors surface above every tab and sheet, so a failed write on the calendar is not an
        // alert waiting on the page list.
        .alert(
            store.failure?.title ?? "",
            isPresented: Binding(
                get: { store.failure != nil },
                set: { if !$0 { store.failure = nil } }
            ),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(store.failure?.message ?? "") }
        )
        .alert(
            "Started a new workspace",
            isPresented: Binding(
                get: { store.startupNote != nil },
                set: { if !$0 { store.startupNote = nil } }
            ),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(store.startupNote ?? "") }
        )
        // A page added by Siri, a widget or a Shortcut lands while the app is suspended, so coming
        // back to the foreground re-reads the workspace.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                guard !store.isLoading else { return }
                // The list first so what is here shows at once, then the calendars if it has been a
                // while, then the list again if they brought anything: that second refresh bumps the
                // version, which re-plans the reminders.
                Task {
                    await store.refresh()
                    let before = calendars.lastAutomaticSyncAt
                    await calendars.syncIfStale()
                    if calendars.lastAutomaticSyncAt != before {
                        await store.refresh()
                    }
                }
            case .background:
                // Leaving is the last moment this process is sure to run for a while: re-plan the
                // horizon and ask to be woken to extend it.
                Task { await reminders.sync() }
                ReminderScheduler.scheduleBackgroundRefresh()
            default:
                break
            }
        }
        // Every write can move, add or remove a reminder and change what a widget shows, so both
        // follow the version rather than guessing which writes matter. Debounced by cancellation:
        // a bulk move plans once, after the last write.
        .task(id: store.dataVersion) {
            guard store.dataVersion > 0 else { return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            await reminders.sync()
            WidgetCenter.shared.reloadAllTimelines()
        }
        // The home screen's search index follows the same signal, more slowly: nobody is searching
        // Spotlight for a page they typed three seconds ago, and a burst of writes catches up once.
        .task(id: store.dataVersion) {
            guard store.dataVersion > 0 else { return }
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            await spotlight.reindex()
        }
        // The two preferences that change the plan without a write.
        .onChange(of: settings.remindersEnabled) { _, _ in Task { await reminders.sync() } }
        .onChange(of: settings.defaultReminderMinutes) { _, _ in
            Task { await reminders.sync() }
        }
        // An App Intent can ask for a scope at any time. `Route.showToday()` has no store to move
        // (it runs from `perform()`, which has no view), so it records the request and this applies it.
        .onChange(of: route.pendingScope) { _, pending in
            guard pending != nil else { return }
            route.applyPending(to: store)
        }
        .onChange(of: route.path) { _, _ in
            openPage = route.openPageId ?? ""
            openPageAt = Date().timeIntervalSince1970
        }
        .onChange(of: store.isLoading) { _, loading in
            guard !loading else { return }
            Task { await restoreOpenPage() }
        }
        .preferredColorScheme(settings.colorScheme)
        .environment(\.calendar, settings.calendar)
    }

    /// Land back on the page that was open, if the app was only just put away.
    ///
    /// iOS ends a suspended app without telling it, so the page is restored, but only within a few
    /// hours: the app opens on Today, and a note from three days ago over the morning's list breaks
    /// that. A link or intent that arrived during launch has already pushed a page and wins, so a
    /// non-empty path is left alone. A page trashed since, here or on another device, is not brought
    /// back.
    private func restoreOpenPage() async {
        guard route.path.isEmpty, !openPage.isEmpty, let workspace = store.handle else { return }
        let saved = Date(timeIntervalSince1970: openPageAt)
        guard Date().timeIntervalSince(saved) < Self.restoreWindow else {
            openPage = ""
            return
        }
        guard (try? await workspace.getPage(id: openPage)) != nil,
            let trashed = try? await workspace.listTrashedPages(),
            !trashed.contains(where: { $0.id == openPage })
        else {
            openPage = ""
            return
        }
        route.path = [.page(openPage)]
    }

    private static let restoreWindow: TimeInterval = 4 * 60 * 60
}
