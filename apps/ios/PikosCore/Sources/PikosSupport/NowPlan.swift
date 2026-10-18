import Foundation
import PikosCore

/// What the Now widget says at one instant: what's happening, what's next, and what to do in the
/// gap between. `now_plan` in pikos-core decides it; this carries the answer as the widget's
/// pages and dates.
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
        let answer = nowPlan(
            items: items.map {
                NowPage(
                    id: $0.id, start: $0.start.map(Self.millis), end: $0.end.map(Self.millis),
                    priority: Int64($0.priority))
            },
            now: Self.millis(now))
        current = answer.current.map { items[Int($0)] }
        next = answer.next.map { items[Int($0)] }
        freeUntil = answer.freeUntil.map(Self.date)
        suggestion = answer.suggestion.map {
            let reason: Reason =
                switch $0.reason {
                case .topPriority: .topPriority
                case .overdue: .overdue
                case .firstInList: .firstInList
                }
            return Suggestion(id: $0.id, reason: reason)
        }
        changes = answer.changes.map(Self.date)
    }

    private static func millis(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    private static func date(_ millis: Int64) -> Date {
        Date(timeIntervalSince1970: TimeInterval(millis) / 1000)
    }
}
