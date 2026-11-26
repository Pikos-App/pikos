import XCTest

@testable import PikosSupport

final class DayLabelTests: XCTestCase {
    private let gregorian: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London") ?? .gmt
        calendar.locale = Locale(identifier: "en_GB")
        return calendar
    }()

    func testTodayAndTomorrowGetWords() {
        XCTAssertEqual(
            DayLabel.relative("2026-09-13", today: "2026-09-13", calendar: gregorian), "Today")
        XCTAssertEqual(
            DayLabel.relative("2026-09-14", today: "2026-09-13", calendar: gregorian), "Tomorrow")
    }

    /// String arithmetic on the day number would call the 1st of the next month
    /// something other than tomorrow.
    func testTomorrowCrossesMonthAndYearEnds() {
        XCTAssertEqual(
            DayLabel.relative("2026-10-01", today: "2026-09-30", calendar: gregorian), "Tomorrow")
        XCTAssertEqual(
            DayLabel.relative("2027-01-01", today: "2026-12-31", calendar: gregorian), "Tomorrow")
    }

    func testTomorrowCrossesALeapDay() {
        XCTAssertEqual(
            DayLabel.relative("2024-02-29", today: "2024-02-28", calendar: gregorian), "Tomorrow")
        XCTAssertEqual(
            DayLabel.relative("2024-03-01", today: "2024-02-29", calendar: gregorian), "Tomorrow")
    }

    func testAnythingFurtherOutGetsADate() {
        let label = DayLabel.relative("2026-09-16", today: "2026-09-13", calendar: gregorian)
        XCTAssertNotEqual(label, "Today")
        XCTAssertNotEqual(label, "Tomorrow")
        XCTAssertTrue(label.contains("16"), "should name the day of the month, got \(label)")
    }

    /// An `abs()` in the wrong place would make yesterday "Tomorrow".
    func testTheDayBeforeIsNotTomorrow() {
        let label = DayLabel.relative("2026-09-12", today: "2026-09-13", calendar: gregorian)
        XCTAssertNotEqual(label, "Tomorrow")
        XCTAssertNotEqual(label, "Today")
    }

    /// Santiago springs forward at 00:00, so a midnight parse would return nil or the previous day.
    func testADayThatHasNoMidnightStillHasALabel() {
        var santiago = Calendar(identifier: .gregorian)
        santiago.timeZone = TimeZone(identifier: "America/Santiago") ?? .gmt
        santiago.locale = Locale(identifier: "en_US")

        // 2026-09-06 is the DST spring-forward in Santiago: 00:00 does not exist.
        XCTAssertNotNil(DayLabel.date(from: "2026-09-06", in: santiago))
        XCTAssertEqual(
            DayLabel.relative("2026-09-06", today: "2026-09-05", calendar: santiago), "Tomorrow")
    }

    func testAnUnreadableDayIsShownRaw() {
        for bad in ["", "2026", "2026-13-01", "2026-09-99", "not a date"] {
            XCTAssertEqual(
                DayLabel.relative(bad, today: "2026-09-13", calendar: gregorian), bad,
                "should pass through \(bad)")
            XCTAssertNil(DayLabel.date(from: bad, in: gregorian))
        }
    }
}

extension DayLabelTests {
    func testTodayIsAZeroPaddedGregorianKey() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London") ?? .gmt

        // Single-digit month and day, to catch dropped padding.
        let noon = calendar.date(
            from: DateComponents(
                calendar: calendar, timeZone: calendar.timeZone,
                year: 2026, month: 1, day: 5, hour: 12))!
        XCTAssertEqual(DayLabel.today(calendar, now: noon), "2026-01-05")
    }

    func testTodayIgnoresANonGregorianDeviceCalendar() {
        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = TimeZone(identifier: "Asia/Bangkok") ?? .gmt
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = buddhist.timeZone

        let noon = gregorian.date(
            from: DateComponents(
                calendar: gregorian, timeZone: gregorian.timeZone,
                year: 2026, month: 1, day: 5, hour: 12))!
        XCTAssertEqual(
            DayLabel.today(buddhist, now: noon), "2026-01-05",
            "a Buddhist-calendar device would otherwise write 2569")
    }

    func testShortIsNeverRelative() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let today = DayLabel.today(calendar, now: Date(timeIntervalSince1970: 1_789_309_800))

        let label = DayLabel.short(today, calendar: calendar)
        XCTAssertNotEqual(label, "Today")
        XCTAssertFalse(label.isEmpty)
        XCTAssertNotEqual(label, today, "and it is formatted, not passed through")
    }

    func testShortCarriesTheWeekdayTheDayAndTheMonth() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let label = DayLabel.short("2026-05-05", calendar: calendar)
        // Order and separators follow the locale; the three parts must be present.
        XCTAssertTrue(label.contains("5"), label)
        XCTAssertTrue(label.lowercased().contains("may"), label)
        XCTAssertTrue(label.lowercased().contains("tue"), label)
    }

    func testAnUnreadableDayIsShownRawByShortToo() {
        XCTAssertEqual(DayLabel.short("not-a-date"), "not-a-date")
        XCTAssertEqual(DayLabel.short(""), "")
    }
}
