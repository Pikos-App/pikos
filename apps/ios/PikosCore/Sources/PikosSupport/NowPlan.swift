import Foundation

/// What the Now widget says at one instant: what's happening, what's next, and what to do in the
/// gap between.
///
/// The suggestion is a fixed rule, not a guess: priority first, then the order the day's list
/// already has. Each one carries the reason it was picked, so the widget can say why. A widget
/// that picks a page for unexplained reasons loses trust the first time it picks wrong.
///
/// A timed page with no end is a moment, not a span: it is never "happening now", and once its
/// time passes it is due, like any page dated today. Assuming a length the person never typed
/// would make the widget claim they're busy when they aren't.
public struct NowPlan: Equatable, Sendable {
    public struct Item: Equatable, Sendable {
        public let id: String
        /// Nil for a page dated today with no time.
        public let start: Date?
        public let end: Date?
        /// 1 is most urgent; 0 means none, which ranks last.
        public let priority: Int

        public init(id: String, start: Date?, end: Date?, priority: Int) {
            self.id = id
            self.start = start
            self.end = end
            self.priority = priority
        }
    }

    public enum Reason: Equatable, Sendable {
        case topPriority
        case overdue
        case firstInList
    }

    public struct Suggestion: Equatable, Sendable {
        public let id: String
        public let reason: Reason

        public init(id: String, reason: Reason) {
            self.id = id
            self.reason = reason
        }
    }

    /// The span in progress, if any.
    public let current: Item?
    /// The next timed page to start.
    public let next: Item?
    /// When the person is next busy, or nil when nothing else is timed today.
    public let freeUntil: Date?
    /// Only offered while nothing is in progress.
    public let suggestion: Suggestion?
    /// The instants after `now` when this plan changes, for the widget's timeline.
    public let changes: [Date]

    /// `items` is today's open pages in the order the day's list shows them.
    public init(items: [Item], now: Date) {
        current = items
            .filter { item in
                guard let start = item.start, let end = item.end else { return false }
                return start <= now && now < end
            }
            .min { ($0.end ?? now) < ($1.end ?? now) }

        next = items
            .filter { ($0.start ?? now) > now }
            .min { ($0.start ?? now) < ($1.start ?? now) }

        freeUntil = current == nil ? next?.start : nil

        if current != nil {
            suggestion = nil
        } else {
            suggestion = Self.suggest(from: items, now: now)
        }

        let edges = items.flatMap { [$0.start, $0.end] }.compactMap { $0 }.filter { $0 > now }
        changes = Array(Set(edges)).sorted()
    }

    /// Ranked by priority, then by list order. The reason names whichever of the two decided it.
    private static func suggest(from items: [Item], now: Date) -> Suggestion? {
        let candidates = items.enumerated().filter { _, item in
            guard let start = item.start else { return true }
            return start <= now && (item.end ?? start) <= now
        }
        func rank(_ priority: Int) -> Int { priority == 0 ? Int.max : priority }
        guard
            let best = candidates.min(by: { a, b in
                rank(a.element.priority) != rank(b.element.priority)
                    ? rank(a.element.priority) < rank(b.element.priority)
                    : a.offset < b.offset
            })
        else { return nil }

        let item = best.element
        let outranks = candidates.contains { rank($0.element.priority) > rank(item.priority) }
        let reason: Reason =
            if item.priority != 0 && outranks {
                .topPriority
            } else if item.start != nil {
                .overdue
            } else {
                .firstInList
            }
        return Suggestion(id: item.id, reason: reason)
    }
}
