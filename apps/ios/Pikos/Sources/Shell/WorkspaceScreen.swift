import SwiftUI

/// The root of the app on a phone: the list pane or the week pane and the bar that moves between
/// them, or with the phone sideways the two side by side, as the desktop sets them.
///
/// Both panes stay alive underneath so each keeps its scroll position and loaded range; only
/// the one on screen takes touches or is read out. The arrangement is an `AnyLayout` rather than
/// a branch, so turning the phone moves the same two panes instead of building new ones.
struct WorkspaceScreen: View {
    @Environment(Route.self) private var route
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.shellLayout) private var layout
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag = PageDragSession()

    /// The desktop's list column is about this wide; past it the calendar gets the room.
    private static let maxListWidth: CGFloat = 400

    var body: some View {
        @Bindable var route = route
        let isSideBySide = layout == .sideBySide

        GeometryReader { geometry in
            let listWidth = min(geometry.size.width * 0.45, Self.maxListWidth)
            let arrangement = isSideBySide ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(ZStackLayout())

            arrangement {
                PageListScreen()
                    .frame(width: isSideBySide ? listWidth : nil)
                    .overlay(alignment: .trailing) {
                        if isSideBySide {
                            Rectangle().fill(.borderSecondary).frame(width: 1 / displayScale)
                        }
                    }
                    .paneVisible(isSideBySide || route.pane == .list)
                CalendarScreen()
                    .paneVisible(isSideBySide || route.pane == .week)
            }
            .bottomChrome {
                if !route.isSelectingPages {
                    ShellBar(
                        pane: isSideBySide ? nil : $route.pane,
                        isMinimized: !isSideBySide && route.isBarMinimized,
                        onSearch: { route.openSearch() },
                        onCapture: {
                            route.isSwitcherPresented = false
                            route.presentQuickAdd(from: store, under: isSideBySide ? .list : route.pane)
                        },
                        onExpand: {
                            withAnimation(reduceMotion ? nil : .pkQuick) { route.isBarMinimized = false }
                        }
                    )
                    // Under the list it serves, not across the line between the two panes.
                    .frame(width: isSideBySide ? listWidth - 32 : nil)
                    .frame(maxWidth: .infinity, alignment: isSideBySide ? .leading : .center)
                    .transition(.opacity)
                }
            }
        }
        .background(.surfacePrimary)
        .overlay { ScopeDrawer(opensFromEdge: layout == .sideBySide || route.pane == .list) }
        .toolbar(.hidden, for: .navigationBar)
        .onDrop(of: [.text], delegate: PageDragWatch(drag: drag))
        .environment(drag)
        .onChange(of: route.pane) { _, _ in
            route.isSwitcherPresented = false
            route.isBarMinimized = false
        }
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
