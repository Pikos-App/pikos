import AppIntents
import PikosCore
import SwiftUI

@main
struct PikosApp: App {
    @State private var store = WorkspaceStore()
    @State private var route = Route.shared

    init() {
        // App Intents run in this process and reach the router through
        // `@Dependency`. Registered here, at the one point that runs before any
        // intent can — an intent may be what launched the app.
        AppDependencyManager.shared.add { Route.shared }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
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
        TabView(selection: $route.tab) {
            NavigationStack(path: $route.pagesPath) {
                PageListScreen()
                    .navigationDestination(for: String.self) { EditorScreen(pageId: $0) }
            }
            .tabItem { Label("Pages", systemImage: "doc.text") }
            .tag(Route.Tab.pages)

            NavigationStack(path: $route.calendarPath) {
                CalendarScreen()
                    .navigationDestination(for: String.self) { EditorScreen(pageId: $0) }
            }
            .tabItem { Label("Calendar", systemImage: "calendar") }
            .tag(Route.Tab.calendar)

            NavigationStack(path: $route.searchPath) {
                SearchScreen()
                    .navigationDestination(for: String.self) { EditorScreen(pageId: $0) }
            }
            .tabItem { Label("Search", systemImage: "magnifyingglass") }
            .tag(Route.Tab.search)
        }
        .sheet(
            isPresented: $route.isQuickAddPresented,
            // Otherwise the next manual open would inherit the last link's
            // text. `onDismiss` is declared before `content`, so it cannot be
            // written as a second trailing closure.
            onDismiss: { route.quickAddPrefill = "" }
        ) {
            QuickAddSheet(prefill: route.quickAddPrefill)
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
    }
}
