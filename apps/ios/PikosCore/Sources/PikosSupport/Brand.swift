import SwiftUI

/// The one colour that is Pikos's own.
///
/// Spelled once, here, where the app and the widget can both reach it. Three
/// things read it and none of them can read the others: the asset catalog's
/// `AccentColor` tints every native control in the app and cannot be read from
/// Swift; the editor webview is told the hex in its `setTheme` message and
/// cannot read an asset catalog; and the widget is a separate process with no
/// catalog of its own. Before this the app's accent was whatever the system's
/// default was and the editor's was terracotta, so a link tapped in a note and
/// the button that opened it were two different apps' colours.
///
/// `Assets.xcassets/AccentColor.colorset` carries the same value. The test in
/// `BrandTests` pins that the hex here parses; nothing can pin the catalog
/// from Swift, so a change to one is a change to make to both.
public enum Brand {
    /// `#RRGGBB`, the form the editor's `setTheme` message takes and the
    /// desktop's stylesheet declares (`--pikos-accent`).
    public static let accentHex = "#d1603d"

    /// The same colour, for a process that has no asset catalog to draw it
    /// from. The app itself uses `Color.accentColor`, which the catalog sets.
    public static var accent: Color {
        Color(hex: accentHex) ?? .accentColor
    }
}
