import Foundation

/// How a folder's list is ordered, and the ordering itself.
///
/// The desktop's four modes (`SortMode` in `@pikos/core`), with the same
/// rules: manual is the hand-arranged `sort_order`; date puts the unscheduled
/// last and an all-day page after its day's timed pages; priority runs urgent
/// to low with "none" last and dates breaking ties; title is the reader's own
/// collation. Here rather than in the app so the rules can be tested on the
/// host — the two that go wrong quietly are the unscheduled sinking and the
/// all-day placement, and neither needs a simulator to check.
///
/// Generic over the page, because the summary type is generated and lives in
/// a package this one cannot see; the caller hands over the four facts.
public enum PageSort {
    public enum Mode: String, CaseIterable, Sendable {
        case manual, date, title, priority

        public var label: String {
            switch self {
            case .manual: return "Manual"
            case .date: return "Date"
            case .title: return "Title"
            case .priority: return "Priority"
            }
        }
    }

    /// What ordering needs to know about a page.
    public struct Key: Equatable, Sendable {
        public var title: String
        /// 1 urgent through 4 low; 0 is none.
        public var priority: Int64
        public var sortOrder: Int64
        /// The stored wall clock, date-only or with a time, or nil.
        public var scheduledStart: String?

        public init(title: String, priority: Int64, sortOrder: Int64, scheduledStart: String?) {
            self.title = title
            self.priority = priority
            self.sortOrder = sortOrder
            self.scheduledStart = scheduledStart
        }
    }

    /// The pages in the mode's order. Stable, so equal keys keep their
    /// incoming order — which for manual is the workspace's own.
    public static func order<Page>(_ pages: [Page], by mode: Mode, key: (Page) -> Key) -> [Page] {
        let keyed = pages.enumerated().map { (index: $0.offset, page: $0.element, key: key($0.element)) }
        let sorted = keyed.sorted { lhs, rhs in
            let comparison = compare(lhs.key, rhs.key, by: mode)
            return comparison == .orderedSame ? lhs.index < rhs.index : comparison == .orderedAscending
        }
        return sorted.map { $0.page }
    }

    static func compare(_ a: Key, _ b: Key, by mode: Mode) -> ComparisonResult {
        switch mode {
        case .manual:
            return compareNumbers(a.sortOrder, b.sortOrder)
        case .title:
            return a.title.localizedStandardCompare(b.title)
        case .date:
            return compareDates(a.scheduledStart, b.scheduledStart)
        case .priority:
            let tiers = compareNumbers(a.priority == 0 ? 5 : a.priority, b.priority == 0 ? 5 : b.priority)
            guard tiers == .orderedSame else { return tiers }
            return compareDates(a.scheduledStart, b.scheduledStart)
        }
    }

    /// Scheduled before unscheduled; then by instant.
    private static func compareDates(_ a: String?, _ b: String?) -> ComparisonResult {
        switch (a, b) {
        case (nil, nil): return .orderedSame
        case (nil, _): return .orderedDescending
        case (_, nil): return .orderedAscending
        case (let a?, let b?):
            let left = instant(of: a)
            let right = instant(of: b)
            return left == right ? .orderedSame : (left < right ? .orderedAscending : .orderedDescending)
        }
    }

    /// A wall clock every stored value can be compared as.
    ///
    /// Zero-padded ISO compares correctly as text, which is what lets this
    /// stay string arithmetic. A timed value is already one. An all-day value
    /// becomes the end of its day, after everything timed that day and before
    /// the next day's midnight.
    static func instant(of iso: String) -> String {
        iso.contains("T") ? iso : iso + "T24:00:00"
    }

    private static func compareNumbers(_ a: Int64, _ b: Int64) -> ComparisonResult {
        a == b ? .orderedSame : (a < b ? .orderedAscending : .orderedDescending)
    }
}
