import XCTest

@testable import PikosSupport

/// Naming a day in Upcoming.
///
/// Worth testing on the host because the two relative words are the part a
/// reader notices being wrong, and because "tomorrow" is date arithmetic
/// wearing a string's clothes — the cases that break it are month ends, leap
/// days and DST, none of which need a simulator to reach.
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

    /// The day after tomorrow is a date, not a third relative word — past two
    /// days the words stop meaning anything without counting.
    func testAnythingFurtherOutGetsADate() {
        let label = DayLabel.relative("2026-09-16", today: "2026-09-13", calendar: gregorian)
        XCTAssertNotEqual(label, "Today")
        XCTAssertNotEqual(label, "Tomorrow")
        XCTAssertTrue(label.contains("16"), "should name the day of the month, got \(label)")
    }

    /// Yesterday is not "Tomorrow". An `abs()` in the wrong place would make it
    /// so, and Upcoming's window makes that case rare enough to ship.
    func testTheDayBeforeIsNotTomorrow() {
        let label = DayLabel.relative("2026-09-12", today: "2026-09-13", calendar: gregorian)
        XCTAssertNotEqual(label, "Tomorrow")
        XCTAssertNotEqual(label, "Today")
    }

    /// Midnight is the one instant a spring-forward can delete, which is why
    /// the parse lands on noon. Lisbon moves at 01:00 and Santiago at 00:00 —
    /// the second is the one that would return nil or the previous day.
    func testADayThatHasNoMidnightStillHasALabel() {
        var santiago = Calendar(identifier: .gregorian)
        santiago.timeZone = TimeZone(identifier: "America/Santiago") ?? .gmt
        santiago.locale = Locale(identifier: "en_US")

        // 2026-09-06 is the DST spring-forward in Santiago: 00:00 does not exist.
        XCTAssertNotNil(DayLabel.date(from: "2026-09-06", in: santiago))
        XCTAssertEqual(
            DayLabel.relative("2026-09-06", today: "2026-09-05", calendar: santiago), "Tomorrow")
    }

    /// Shown as itself rather than hidden behind an invented date.
    func testAnUnreadableDayIsShownRaw() {
        for bad in ["", "2026", "2026-13-01", "2026-09-99", "not a date"] {
            XCTAssertEqual(
                DayLabel.relative(bad, today: "2026-09-13", calendar: gregorian), bad,
                "should pass through \(bad)")
            XCTAssertNil(DayLabel.date(from: bad, in: gregorian))
        }
    }
}

/// `today()` produces the key the shared Rust compares against.
///
/// Separate from the labelling tests because the failure mode is different and
/// worse: a label that reads oddly is cosmetic, but a key in the wrong shape
/// matches no row and empties the view with nothing logged.
extension DayLabelTests {
    func testTodayIsAZeroPaddedGregorianKey() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London") ?? .gmt

        // 2026-01-05, chosen for the single-digit month and day that padding
        // would otherwise drop.
        let noon = calendar.date(
            from: DateComponents(
                calendar: calendar, timeZone: calendar.timeZone,
                year: 2026, month: 1, day: 5, hour: 12))!
        XCTAssertEqual(DayLabel.today(calendar, now: noon), "2026-01-05")
    }

    /// A non-Gregorian calendar must not leak into a storage key. Set as the
    /// device calendar, this one numbers 2026 as 2569.
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
}
