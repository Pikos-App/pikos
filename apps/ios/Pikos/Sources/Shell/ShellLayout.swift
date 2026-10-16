import SwiftUI

/// How the window arranges the surfaces: one pane at a time, the list beside the calendar, or the
/// Mac's three panels.
///
/// Read from both size classes, never from width alone. A Max-sized iPhone sideways reports regular
/// width exactly as an iPad does, with about 400 points of height, so width cannot tell the two
/// apart and compact height can: it is true of every phone in landscape and of no iPad.
///
/// The iPhone Duo needs no case of its own. Apple documents its outer display with an iPhone's
/// size classes and its inner display as regular in both, so folded it is a phone, sideways it
/// is two panes, and unfolded it is the split view. Apple describes folding as resizing the app.
enum ShellLayout {
    case single
    case sideBySide
    case split

    init(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) {
        switch (horizontal, vertical) {
        case (_, .compact): self = .sideBySide
        case (.regular, .regular): self = .split
        default: self = .single
        }
    }
}

extension EnvironmentValues {
    @Entry var shellLayout: ShellLayout = .single
}
