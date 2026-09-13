import PikosCore
import SwiftUI

@main
struct PikosApp: App {
    @State private var store = WorkspaceStore()
    @State private var route = Route()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(route)
                // Opening the workspace runs migrations, so it happens once,
                // here, in the app process. A widget must never be the process
                // that migrates.
                .task { await store.start() }
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
        .sheet(isPresented: $route.isQuickAddPresented) {
            QuickAddSheet()
        }
    }
}
