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
    // No defaults: `store` and `sync` are built together in `init`, and a default
    // would construct a `WorkspaceStore` that is thrown away.
    @State private var store: WorkspaceStore
    @State private var settings = SettingsStore()
    @State private var sync: CalendarSyncStore
    @State private var exports: ExportStore
    @State private var reminders: ReminderScheduler
    @State private var route = Route.shared
    /// Not in the environment: only the shell talks to it.
    @State private var spotlight: SpotlightIndexer
    @State private var deviceSync: DeviceSync

    /// Held for the app's life: the notification center keeps its delegate weakly, and a
    /// dropped one makes a reminder tap open the app wherever it last was.
    private let notificationDelegate: ReminderNotificationDelegate

    init() {
        // App Intents reach the router through `@Dependency`. Register before any intent can
        // run, since an intent may be what launched the app.
        AppDependencyManager.shared.add { Route.shared }

        // Sync reads the workspace through a closure: `start()` opens it asynchronously, so
        // capturing nil here would leave sync unable to do anything.
        let pages = WorkspaceStore()
        _store = State(initialValue: pages)
        let calendars = CalendarSyncStore(workspace: { pages.handle })
        _sync = State(initialValue: calendars)
        _exports = State(initialValue: ExportStore(workspace: { pages.handle }))
        let scheduler = ReminderScheduler(workspace: { pages.handle })
        _reminders = State(initialValue: scheduler)
        _spotlight = State(initialValue: SpotlightIndexer(workspace: { pages.handle }))
        _deviceSync = State(
            initialValue: DeviceSync(workspace: { pages.handle }, onApplied: { await pages.refresh() }))

        PikosTips.configure()

        #if DEBUG
            // A UI test run on a phone fails the moment the screen locks.
            if ProcessInfo.processInfo.environment[WorkspaceLocation.workspaceOverrideKey] != nil {
                UIApplication.shared.isIdleTimerDisabled = true
            }
        #endif

        // A tap and "Complete" reuse the widget link and the checkbox's store method.
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

        // Registered before launch finishes, which in SwiftUI means here. The order matters: a
        // meeting that landed in the calendar sync gets its reminder planned in the same wake.
        // The workspace may not be open in a background launch, so it is opened on demand.
        // The main queue: the handler is main-actor code, and on the scheduler's own queue the
        // isolation check stopped the app every time a refresh ran.
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: ReminderScheduler.refreshTaskIdentifier, using: .main
        ) { task in
            // `BGTask` is not Sendable: it crosses into the main actor in a box, completed once there.
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

    /// Boxes the non-Sendable `BGTask` for the hop to the main actor.
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
            .onReceive(
                NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            ) { _ in
                Task { await deviceSync.fetchNow() }
            }
            // Opening runs migrations, so it happens once, in the app process. A widget must never
            // be the process that migrates.
            .task {
                await store.start()
                await deviceSync.resume()
                // An intent or link may have arrived while the workspace was opening.
                route.applyPending(to: store)
                #if DEBUG
                    await DemoWorkspace.applyScreen(route: route, store: store)
                #endif
                await reminders.sync()
            }
            .onOpenURL { url in route.handle(url, store: store) }
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

    /// The page open when the app was last put away, and when.
    ///
    /// Scene storage because it is this window's state, forgotten with the scene.
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
        // One sheet for every quick-add entry, so the prefill is read and cleared in one place.
        .sheet(
            isPresented: $route.isQuickAddPresented,
            // Otherwise the next manual open inherits the last prefill. `onDismiss` is declared
            // before `content`, so it can't be a second trailing closure.
            onDismiss: { route.clearQuickAddPrefill() }
        ) {
            QuickAddSheet(
                prefill: route.quickAddPrefill.isEmpty ? route.quickAddDraft : route.quickAddPrefill,
                prefillDate: route.quickAddPrefillDate,
                prefillMinutes: route.quickAddPrefillMinutes,
                context: route.quickAddContext)
        }
        // Above every tab and sheet, so a failed calendar write isn't an alert waiting on the list.
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { store.errorMessage != nil },
                set: { if !$0 { store.errorMessage = nil } }
            ),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(store.errorMessage ?? "") }
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
        // A page added by Siri, a widget or a Shortcut lands while suspended, so re-read on
        // foreground.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                guard !store.isLoading else { return }
                // The list first so what is here shows at once, then stale calendars, then the list
                // again if they brought anything: that bump re-plans the reminders.
                Task {
                    await store.refresh()
                    let before = calendars.lastAutomaticSyncAt
                    await calendars.syncIfStale()
                    if calendars.lastAutomaticSyncAt != before {
                        await store.refresh()
                    }
                }
            case .background:
                // Leaving is the last sure run: re-plan the horizon and ask to be woken to extend it.
                Task { await reminders.sync() }
                ReminderScheduler.scheduleBackgroundRefresh()
            default:
                break
            }
        }
        // Every write can move a reminder or change a widget, so both follow the version
        // rather than guess which writes matter. Cancelling the sleep debounces a burst to one plan.
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
        // An intent can ask for a scope after launch. `showToday()` has no store, so it records
        // the request and this applies it.
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

    /// Reopens the page that was open when the app was put away, within `restoreWindow`.
    /// A link or intent that already pushed a page wins, and a trashed page is not restored.
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

    /// The app opens on Today, so a note from days ago must not appear over the morning's
    /// list. This window separates an interruption from starting a day.
    private static let restoreWindow: TimeInterval = 4 * 60 * 60
}
