import SwiftUI

/// The one object at the bottom of the app: which pane fills the screen, search, and capture.
///
/// The desktop's document/calendar pair swaps its right-hand panel; this is that toggle at thumb
/// height, with the page list standing in for the document because a phone opens a page by
/// pushing it. Search and capture share the bar so both are in reach from either pane and
/// nothing else floats over the content.
struct ShellBar: View {
    /// Nil when the list and the calendar are both on screen, which leaves search and capture.
    let pane: Binding<Route.Pane>?
    /// Only while the panes take turns: side by side, the bar already holds just search and capture.
    var isMinimized = false
    let onSearch: () -> Void
    let onCapture: () -> Void
    var onExpand: () -> Void = {}

    @Namespace private var selection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let height: CGFloat = 56
    /// What content under the bar keeps clear so its last line can scroll above it.
    static let clearance: CGFloat = height + 20

    var body: some View {
        HStack(spacing: 4) {
            if isMinimized, let pane {
                expandButton(pane.wrappedValue)
            } else {
                if let pane {
                    segment(.list, title: "List", systemImage: "list.bullet", pane: pane)
                    segment(.week, title: "Calendar", systemImage: "calendar", pane: pane)
                }
                searchButton
                    .padding(.leading, 2)
            }
            captureButton
                .padding(.leading, 2)
        }
        .padding(6)
        .frame(height: Self.height)
        // A bar of fixed height: past this size its labels truncate to a letter.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .floatingSurface(in: Capsule())
        .sensoryFeedback(.selection, trigger: pane?.wrappedValue)
    }

    private func segment(
        _ value: Route.Pane, title: LocalizedStringKey, systemImage: String, pane: Binding<Route.Pane>
    ) -> some View {
        let isSelected = pane.wrappedValue == value
        return Button {
            withAnimation(reduceMotion ? nil : .pkQuick) { pane.wrappedValue = value }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .medium))
                Text(title)
                    .font(.pkUI)
            }
            .foregroundStyle(isSelected ? Color.textAction : Color.textSecondary)
            .padding(.horizontal, 16)
            .frame(maxHeight: .infinity)
            .background {
                if isSelected {
                    Capsule()
                        .fill(.surfaceSelected)
                        .matchedGeometryEffect(id: "selection", in: selection)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// The pane on screen, standing in for the whole bar while it is out of the way.
    private func expandButton(_ pane: Route.Pane) -> some View {
        Button(action: onExpand) {
            Image(systemName: pane == .list ? "list.bullet" : "calendar")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.textAction)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(CaptureButtonStyle())
        .accessibilityLabel("Show the bar")
    }

    private var searchButton: some View {
        Button(action: onSearch) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.textSecondary)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(CaptureButtonStyle())
        .accessibilityLabel("Search")
    }

    private var captureButton: some View {
        Button(action: onCapture) {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.textInverse)
                .frame(width: 44, height: 44)
                .background(Circle().fill(.textAction))
                .contentShape(Circle())
        }
        .buttonStyle(CaptureButtonStyle())
        .accessibilityLabel("New page")
        .accessibilityHint("Type a sentence and Pikos reads the date, priority and tags out of it")
    }
}

private struct CaptureButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}
