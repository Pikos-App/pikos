import SwiftUI

extension Color {
    /// A stored palette value as a colour.
    ///
    /// The palette is `#RRGGBB` and comes from the workspace, so this is not a
    /// general-purpose hex parser and deliberately does not try to be: no
    /// three-digit form, no alpha, no named colours. What it does do is refuse
    /// anything it does not understand, because the alternative — a silent
    /// fallback to black — turns a one-character typo in a palette into a
    /// folder dot that looks deliberate.
    ///
    /// `nil` in, `nil` out, so an uncoloured folder needs no separate check at
    /// the call site.
    public init?(hex: String?) {
        guard let hex else { return nil }
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1)
    }
}
