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

    var body: some View {
        @Bindable var route = route

        TabView(selection: $route.tab) {
            PageListScreen()
                .tabItem { Label("Pages", systemImage: "doc.text") }
                .tag(Route.Tab.pages)

            SearchScreen()
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
    }
}
