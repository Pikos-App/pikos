import SwiftUI

/// The shell where there is room for the Mac's three panels: every view and folder as a sidebar,
/// the list, and the calendar or the open page.
///
/// The detail column is a stack on `Route.path` with the calendar at its root, so a page opened
/// from the list or from search sits over the week and Back returns to it. The surfaces are the
/// phone's own; only their arrangement is new.
struct WorkspaceSplitView: View {
    @Environment(Route.self) private var route
    @Environment(WorkspaceStore.self) private var store
    @State private var drag = PageDragSession()

    var body: some View {
        @Bindable var route = route

        NavigationSplitView {
            ScopeSwitcher(style: .sidebar)
                .toolbar(.hidden, for: .navigationBar)
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } content: {
            PageListScreen()
                .bottomChrome {
                    if !route.isSelectingPages {
                        ShellBar(
                            pane: nil,
                            onSearch: { route.openSearch(replacing: true) },
                            onCapture: {
                                route.isSwitcherPresented = false
                                route.presentQuickAdd(from: store, under: .list)
                            }
                        )
                        .transition(.opacity)
                    }
                }
                .toolbar(.hidden, for: .navigationBar)
                .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
        } detail: {
            NavigationStack(path: $route.path) {
                CalendarScreen()
                    .toolbar(.hidden, for: .navigationBar)
                    .routeDestinations()
            }
        }
        // For when the sidebar is folded away, as it is on an iPad held upright.
        .overlay { ScopeDrawer(opensFromEdge: false) }
        .onDrop(of: [.text], delegate: PageDragWatch(drag: drag))
        .environment(drag)
    }
}
