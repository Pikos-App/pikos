import SwiftUI

/// The floating create button.
///
/// Bottom-trailing, where a thumb already is. Quick capture is the app's
/// headline feature, and for the first version of the phone app the way to it
/// was a pencil in the top-right corner — the one place on a modern phone a
/// thumb cannot reach without shifting grip. Things' Magic Plus, Todoist's
/// add button and Apple's own iOS 26 layouts (compose and search in the
/// bottom bar) all make the same call: the primary action lives at the
/// bottom.
///
/// It floats over the content rather than taking a toolbar row, so the list
/// keeps its full height; the screens that show it give their scroll content
/// a bottom margin (`floatingButtonClearance`) so the last row can still be
/// read above it. Glass on iOS 26 with the interactive bounce the system's
/// own buttons have; a material circle before that.
///
/// One accessibility label — "New page" — shared with the App Shortcut and
/// the widget, and the one the UI tests tap.
struct NewPageButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: Self.diameter, height: Self.diameter)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .floatingSurface(in: Circle(), interactive: true)
        .accessibilityLabel("New page")
        .accessibilityHint("Type a sentence and Pikos reads the date, priority and tags out of it")
    }

    /// Comfortably over the 44-point minimum, and the size Things and
    /// Reminders draw theirs at.
    static let diameter: CGFloat = 56

    /// How much the scroll content under the button should keep clear at the
    /// bottom, so the last row can scroll above it rather than under it.
    static let clearance: CGFloat = diameter + 24
}
