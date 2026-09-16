import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// One design token in both schemes, as `0xRRGGBBAA`. Values live in the generated
/// `DesignTokens.swift`, so the phone draws with the numbers the desktop does.
public struct TokenColor: Sendable, Hashable {
    public let light: UInt32
    public let dark: UInt32

    public init(light: UInt32, dark: UInt32) {
        self.light = light
        self.dark = dark
    }

    public func hex(dark isDark: Bool) -> String {
        String(format: "#%06X", (isDark ? dark : light) >> 8)
    }

    static func components(_ rgba: UInt32) -> (Double, Double, Double, Double) {
        (
            Double((rgba >> 24) & 0xFF) / 255, Double((rgba >> 16) & 0xFF) / 255,
            Double((rgba >> 8) & 0xFF) / 255, Double(rgba & 0xFF) / 255
        )
    }
}

/// A step of the desktop's type scale, in CSS pixels.
public struct TokenType: Sendable, Hashable {
    public let size: Double
    public let weight: Int
    public let lineHeight: Double
}

extension Color {
    /// Resolves per trait collection, so a sheet in the other scheme repaints without a re-render.
    public init(_ token: TokenColor) {
        #if canImport(UIKit)
            self.init(
                uiColor: UIColor { traits in
                    let (r, g, b, a) = TokenColor.components(
                        traits.userInterfaceStyle == .dark ? token.dark : token.light)
                    return UIColor(red: r, green: g, blue: b, alpha: a)
                })
        #elseif canImport(AppKit)
            self.init(
                nsColor: NSColor(name: nil) { appearance in
                    let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                    let (r, g, b, a) = TokenColor.components(isDark ? token.dark : token.light)
                    return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
                })
        #endif
    }
}
