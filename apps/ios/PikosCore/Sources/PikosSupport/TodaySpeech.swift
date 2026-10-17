import Foundation

/// What Siri reads out for "what's on my list today": titles and times, in the list's order.
public enum TodaySpeech {
    public struct Item: Equatable, Sendable {
        public let title: String
        /// "9:30 AM", or nil for a page with a day and no time.
        public let time: String?

        public init(title: String, time: String?) {
            self.title = title
            self.time = time
        }
    }

    /// Past `limit` pages the rest are counted rather than read: a spoken list longer than five
    /// stops being one anybody follows.
    public static func sentence(for items: [Item], limit: Int = 5) -> String {
        guard !items.isEmpty else { return "Nothing is on your list today." }
        let spoken = items.prefix(limit).map { item in
            let title = item.title.isEmpty ? "Untitled" : item.title
            return item.time.map { "\(title) at \($0)" } ?? title
        }
        let rest = items.count - spoken.count
        let lead = items.count == 1 ? "One page today: " : "\(items.count) pages today: "
        var parts = spoken
        if rest > 0 { parts.append("\(rest) more") }
        return lead + joined(parts) + "."
    }

    private static func joined(_ parts: [String]) -> String {
        switch parts.count {
        case 0: return ""
        case 1: return parts[0]
        case 2: return "\(parts[0]) and \(parts[1])"
        default: return parts.dropLast().joined(separator: ", ") + ", and " + parts[parts.count - 1]
        }
    }
}
