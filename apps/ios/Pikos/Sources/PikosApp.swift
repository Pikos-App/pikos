import AppIntents
import PikosCore
import SwiftUI

@main
struct PikosApp: App {
    // No default values: `store` and `sync` are built together in `init` so the
    // second can read the first, and a default here would construct a
    // `WorkspaceStore` that is then thrown away.
    @State private var store: WorkspaceStore
    @State private var settings = SettingsStore()
    @State private var sync: CalendarSyncStore
    @State private var exports: ExportStore
    @State private var route = Route.shared

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
        _sync = State(initialValue: CalendarSyncStore(workspace: { pages.handle }))
        _exports = State(initialValue: ExportStore(workspace: { pages.handle }))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(settings)
                .environment(sync)
                .environment(exports)
                .environment(route)
                // Opening the workspace runs migrations, so it happens once,
                // here, in the app process. A widget must never be the process
                // that migrates.
                .task {
                    await store.start()
                    // An intent or deep link may have arrived while the
                    // workspace was still opening.
                    route.applyPending(to: store)
                }
                .onOpenURL { url in route.handle(url, store: store) }
        }
    }
}

struct RootView: View {
    @Environment(Route.self) private var route
    @Environment(WorkspaceStore.self) private var store
    @Environment(SettingsStore.self) private var settings
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
            guard phase == .active, !store.isLoading else { return }
            Task { await store.refresh() }
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
