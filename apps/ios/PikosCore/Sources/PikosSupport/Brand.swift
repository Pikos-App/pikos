import SwiftUI

/// The two colours a process with no asset catalog reaches for: the widget, the Live
/// Activity and the editor webview. Terracotta is identity only (the icon, About);
/// anything tappable, current or selected is the teal the desktop draws with.
public enum Brand {
    public static var accent: Color { Color(PikosToken.interactivePrimary) }

    public static var identity: Color { Color(PikosToken.brandIdentity) }

    /// For the editor's `setTheme`, which takes a hex rather than a trait-resolving colour.
    public static func linkHex(dark: Bool) -> String {
        PikosToken.textAction.hex(dark: dark)
    }
}
