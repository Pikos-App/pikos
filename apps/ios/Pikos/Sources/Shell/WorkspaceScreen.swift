import SwiftUI

/// The root of the app: the list pane or the week pane, and the bar that moves between them.
///
/// Both panes stay alive underneath so each keeps its scroll position and loaded range; only
/// the one on screen takes touches or is read out.
struct WorkspaceScreen: View {
    @Environment(Route.self) private var route
    @Environment(WorkspaceStore.self) private var store
    @State private var drag = PageDragSession()

    var body: some View {
        @Bindable var route = route

        ZStack {
            PageListScreen()
                .paneVisible(route.pane == .list)
            CalendarScreen()
                .paneVisible(route.pane == .week)
        }
        .background(.surfacePrimary)
        .bottomChrome {
            if !route.isSelectingPages {
                ShellBar(
                    pane: $route.pane,
                    onSearch: {
                        route.isSwitcherPresented = false
                        route.path.append(.search)
                    },
                    onCapture: {
                        route.isSwitcherPresented = false
                        route.presentQuickAdd(from: store)
                    })
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .onDrop(of: [.text], delegate: PageDragWatch(drag: drag))
        .environment(drag)
        .sheet(isPresented: $route.isSettingsPresented) { SettingsScreen() }
        .sheet(isPresented: $route.isTrashPresented) { TrashSheet() }
        .sheet(isPresented: $route.isFolderManagerPresented) { FolderManagerSheet() }
        .onChange(of: route.pane) { _, _ in route.isSwitcherPresented = false }
        #if DEBUG
            .task(id: store.isLoading) {
                guard !store.isLoading else { return }
                await DemoWorkspace.applyDrag(drag, store: store)
            }
        #endif
    }
}

private extension View {
    func paneVisible(_ isVisible: Bool) -> some View {
        self.opacity(isVisible ? 1 : 0)
            .allowsHitTesting(isVisible)
            .accessibilityHidden(!isVisible)
            .zIndex(isVisible ? 1 : 0)
    }
}
