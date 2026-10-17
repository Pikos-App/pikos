import SwiftUI

extension View {
    /// Scrolling this view down shrinks the shell's bar, and scrolling it back up restores it.
    func minimizesShellBar() -> some View {
        modifier(MinimizesShellBar())
    }
}

/// iOS 17 has no scroll geometry to read, so there the bar stays as it is. Only the single-pane
/// layout shrinks it; side by side and in the split there's nothing to reclaim.
private struct MinimizesShellBar: ViewModifier {
    @Environment(Route.self) private var route
    @Environment(\.shellLayout) private var layout
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Only a scroll the person is making moves the bar: coming back from a page shifts the list's
    /// offset too, and that shrank the bar with nobody scrolling.
    @State private var isScrolling = false

    /// Close enough to the top that the bar comes back whichever way the last scroll went.
    private static let nearTop: CGFloat = 24
    /// An upward scroll smaller than this is a finger settling, not a request for the bar.
    private static let upward: CGFloat = 6

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.onScrollPhaseChange { _, phase in
                isScrolling = phase == .interacting || phase == .decelerating
            }
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top
            } action: { old, new in
                guard isScrolling, layout == .single else { return }
                if new < Self.nearTop {
                    minimize(false)
                } else if new > old {
                    minimize(true)
                } else if old - new > Self.upward {
                    minimize(false)
                }
            }
        } else {
            content
        }
    }

    private func minimize(_ minimized: Bool) {
        guard route.isBarMinimized != minimized else { return }
        withAnimation(reduceMotion ? nil : .pkQuick) { route.isBarMinimized = minimized }
    }
}
