import SwiftUI

/// How the window arranges the surfaces: one pane at a time, the list beside the calendar, or the
/// Mac's three panels.
///
/// Read from both size classes, never from width alone. A Max-sized iPhone sideways reports regular
/// width exactly as an iPad does, with about 400 points of height, so width cannot tell the two
/// apart and compact height can: it is true of every phone in landscape and of no iPad.
///
/// The iPhone Duo needs no case of its own: its outer display has an iPhone's size classes and
/// its inner one is regular in both, since folding is documented as resizing the app.
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
