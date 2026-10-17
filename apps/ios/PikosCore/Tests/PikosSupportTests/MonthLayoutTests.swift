import PikosSupport
import XCTest

final class MonthLayoutTests: XCTestCase {
    private func calendar(firstWeekday: Int) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.firstWeekday = firstWeekday
        return calendar
    }

    private func day(_ year: Int, _ month: Int, _ day: Int, in calendar: Calendar) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }

    private func keys(_ dates: [Date], _ calendar: Calendar) -> [String] {
        dates.map {
            let parts = calendar.dateComponents([.year, .month, .day], from: $0)
            return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
        }
    }

    func testAMonthIsPaddedToWholeMondayFirstWeeks() {
        let calendar = calendar(firstWeekday: 2)
        // September 2026 starts on a Tuesday and ends on a Wednesday.
        let grid = keys(MonthLayout.days(around: day(2026, 9, 14, in: calendar), calendar: calendar), calendar)
        XCTAssertEqual(grid.count % 7, 0)
        XCTAssertEqual(grid.first, "2026-08-31")
        XCTAssertEqual(grid.last, "2026-10-04")
    }

    func testTheWeekStartSettingMovesThePadding() {
        let calendar = calendar(firstWeekday: 1)
        let grid = keys(MonthLayout.days(around: day(2026, 9, 1, in: calendar), calendar: calendar), calendar)
        XCTAssertEqual(grid.first, "2026-08-30")
        XCTAssertEqual(grid.last, "2026-10-03")
    }

    func testAMonthThatFillsWholeWeeksHasNoPadding() {
        let calendar = calendar(firstWeekday: 1)
        // February 2026 starts on a Sunday and has exactly four weeks.
        let grid = keys(MonthLayout.days(around: day(2026, 2, 10, in: calendar), calendar: calendar), calendar)
        XCTAssertEqual(grid.count, 28)
        XCTAssertEqual(grid.first, "2026-02-01")
    }

    func testASpanCountsOnEveryDayItCovers() {
        let days = ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"]
        let items = [
            ("trip", "2026-09-14", Optional("2026-09-15")),
            ("call", "2026-09-15T10:00:00", nil),
        ]
        let placed = MonthLayout.byDay(items, days: days, start: { $0.1 }, end: { $0.2 })
        XCTAssertNil(placed["2026-09-13"])
        XCTAssertEqual(placed["2026-09-14"]?.map(\.0), ["trip"])
        XCTAssertEqual(placed["2026-09-15"]?.map(\.0), ["trip", "call"])
        XCTAssertNil(placed["2026-09-16"])
    }

    func testATimedEndAtMidnightDoesNotClaimTheNextDay() {
        let days = ["2026-09-14", "2026-09-15"]
        let items = [("late", "2026-09-14T22:00:00", Optional("2026-09-15T00:00:00"))]
        let placed = MonthLayout.byDay(items, days: days, start: { $0.1 }, end: { $0.2 })
        XCTAssertEqual(placed["2026-09-14"]?.count, 1)
        XCTAssertNil(placed["2026-09-15"])
    }
}
