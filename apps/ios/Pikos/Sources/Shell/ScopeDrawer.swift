import SwiftUI

/// The switcher as a menu drawn in from the left, the way Fastmail's phone app holds its folders,
/// with the list left showing as a strip beside it. A tap on the strip or a swipe back to the left
/// closes it; on the list, a swipe in from the left edge opens it.
struct ScopeDrawer: View {
    /// Off where the screen's left edge already swipes for something else, such as paging days.
    let opensFromEdge: Bool

    @Environment(Route.self) private var route
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragOffset: CGFloat = 0

    /// How much of the list stays in view beside the menu, enough to tap to go back to it.
    private static let strip: CGFloat = 64
    private static let maxWidth: CGFloat = 360
    /// How far a swipe has to travel, or be flung, to open or close the menu.
    private static let commitDistance: CGFloat = 60

    var body: some View {
        GeometryReader { geometry in
            let width = min(geometry.size.width - Self.strip, Self.maxWidth)

            ZStack(alignment: .leading) {
                ZStack(alignment: .leading) {
                    if route.isSwitcherPresented {
                        scrim
                            .transition(.opacity)
                        ScopeSwitcher(style: .drawer)
                            .frame(width: width)
                            .offset(x: dragOffset)
                            .simultaneousGesture(closeSwipe)
                            .accessibilityAddTraits(.isModal)
                            .accessibilityAction(.escape) { close() }
                            .transition(reduceMotion ? .opacity : .move(edge: .leading))
                    }
                }
                // On the layer that stays, so a menu sliding away stops taking taps at once: a +
                // tapped just after choosing a folder hit the fading backdrop and was lost.
                .allowsHitTesting(route.isSwitcherPresented)

                if !route.isSwitcherPresented && opensFromEdge {
                    edge
                }
            }
        }
        .animation(reduceMotion ? nil : .pkQuick, value: route.isSwitcherPresented)
    }

    private var scrim: some View {
        Color.black.opacity(colorScheme == .dark ? 0.5 : 0.2)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { close() }
            .accessibilityElement()
            .accessibilityLabel("Close menu")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { close() }
    }

    /// Narrow enough to leave a row's checkbox its taps.
    private var edge: some View {
        Color.clear
            .frame(width: 14)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 10)
                    .onEnded { value in
                        let isOpening = max(value.translation.width, value.predictedEndTranslation.width)
                            > Self.commitDistance
                        if isOpening { route.isSwitcherPresented = true }
                    }
            )
            .accessibilityHidden(true)
    }

    /// Follows the finger left, and only a swipe that's more sideways than down, so the folders
    /// still scroll.
    private var closeSwipe: some Gesture {
        DragGesture(minimumDistance: 20)
            .onChanged { value in
                let isSideways = abs(value.translation.width) > abs(value.translation.height)
                if isSideways { dragOffset = min(0, value.translation.width) }
            }
            .onEnded { value in
                let isClosing = min(value.translation.width, value.predictedEndTranslation.width)
                    < -Self.commitDistance && dragOffset < 0
                if isClosing {
                    close()
                } else {
                    withAnimation(reduceMotion ? nil : .pkQuick) { dragOffset = 0 }
                }
            }
    }

    private func close() {
        route.isSwitcherPresented = false
        dragOffset = 0
    }
}
