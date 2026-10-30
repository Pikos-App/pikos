import XCTest

@testable import PikosSupport

/// The four orders, on the cases that look right while being wrong.
final class PageSortTests: XCTestCase {
    private func page(
        _ title: String, priority: Int64 = 0, order: Int64 = 0, at start: String? = nil
    ) -> PageSort.Key {
        PageSort.Key(title: title, priority: priority, sortOrder: order, scheduledStart: start)
    }

    private func titles(_ keys: [PageSort.Key], by mode: PageSort.Mode) -> [String] {
        PageSort.order(keys, by: mode) { $0 }.map(\.title)
    }

    func testManualFollowsTheStoredOrder() {
        let keys = [page("c", order: 3), page("a", order: 1), page("b", order: 2)]
        XCTAssertEqual(titles(keys, by: .manual), ["a", "b", "c"])
    }

    /// Unscheduled pages sink; an all-day page follows its day's timed pages
    /// and precedes the next day's.
    func testDatePutsTheUnscheduledLastAndAllDayAfterItsDaysTimedPages() {
        let keys = [
            page("nothing"),
            page("lunch", at: "2026-09-20T12:00:00"),
            page("that day", at: "2026-09-20"),
            page("sooner", at: "2026-09-16T09:00:00"),
            page("next day", at: "2026-09-21T00:00:00"),
        ]
        XCTAssertEqual(titles(keys, by: .date), ["sooner", "lunch", "that day", "next day", "nothing"])
    }

    /// Urgent first, none last, and the date breaks ties within a tier.
    func testPriorityRunsUrgentToLowWithNoneLast() {
        let keys = [
            page("none", priority: 0, at: "2026-09-15"),
            page("low", priority: 4),
            page("urgent later", priority: 1, at: "2026-09-18"),
            page("urgent soon", priority: 1, at: "2026-09-15"),
            page("urgent undated", priority: 1),
            page("high", priority: 2),
        ]
        XCTAssertEqual(
            titles(keys, by: .priority),
            ["urgent soon", "urgent later", "urgent undated", "high", "low", "none"])
    }

    func testTitleIsTheReadersCollation() {
        let keys = [page("banana"), page("Apple"), page("cherry")]
        XCTAssertEqual(titles(keys, by: .title), ["Apple", "banana", "cherry"])
    }

    /// Equal keys keep their incoming order, so a re-sort never shuffles
    /// rows that tie.
    func testTheSortIsStable() {
        let keys = [page("first", order: 1), page("second", order: 1), page("third", order: 1)]
        XCTAssertEqual(titles(keys, by: .manual), ["first", "second", "third"])
        XCTAssertEqual(titles(keys, by: .date), ["first", "second", "third"])
    }
}
