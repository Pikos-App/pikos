import SwiftUI

extension Color {
    /// A stored palette value as a colour.
    ///
    /// Only `#RRGGBB`, the workspace's palette form: no three-digit form, alpha or
    /// names. Anything else is refused, since a silent fallback to black would make
    /// a typo look like a deliberate folder dot. `nil` in, `nil` out.
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
