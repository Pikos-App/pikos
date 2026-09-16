import PikosSupport
import XCTest

final class WhenChoiceTests: XCTestCase {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London")!
        return calendar
    }()

    /// 15 September 2026 is a Tuesday.
    private func at(_ day: String, hour: Int = 10) -> Date {
        DayLabel.date(from: day, in: calendar)!.addingTimeInterval(TimeInterval((hour - 12) * 3600))
    }

    func testTodayAndTomorrowAreTheNextTwoDays() {
        XCTAssertEqual(WhenChoice.today.day(from: at("2026-09-15"), calendar: calendar), "2026-09-15")
        XCTAssertEqual(WhenChoice.tomorrow.day(from: at("2026-09-15"), calendar: calendar), "2026-09-16")
    }

    func testTomorrowCrossesTheEndOfAMonth() {
        XCTAssertEqual(WhenChoice.tomorrow.day(from: at("2026-09-30"), calendar: calendar), "2026-10-01")
    }

    func testThisWeekendIsTheComingSaturday() {
        XCTAssertEqual(WhenChoice.thisWeekend.day(from: at("2026-09-15"), calendar: calendar), "2026-09-19")
        XCTAssertEqual(WhenChoice.thisWeekend.day(from: at("2026-09-18"), calendar: calendar), "2026-09-19")
    }

    func testThisWeekendIsTodayOnceTheWeekendHasStarted() {
        XCTAssertEqual(WhenChoice.thisWeekend.day(from: at("2026-09-19"), calendar: calendar), "2026-09-19")
        XCTAssertEqual(WhenChoice.thisWeekend.day(from: at("2026-09-20"), calendar: calendar), "2026-09-20")
    }

    func testNextWeekIsTheFollowingMonday() {
        XCTAssertEqual(WhenChoice.nextWeek.day(from: at("2026-09-15"), calendar: calendar), "2026-09-21")
        XCTAssertEqual(WhenChoice.nextWeek.day(from: at("2026-09-20"), calendar: calendar), "2026-09-21")
    }

    func testNextWeekFromAMondayIsAWeekAwayNotToday() {
        XCTAssertEqual(WhenChoice.nextWeek.day(from: at("2026-09-14"), calendar: calendar), "2026-09-21")
    }

    func testNextWeekIsMondayEvenForASundayFirstWeek() {
        var sundayFirst = calendar
        sundayFirst.firstWeekday = 1
        XCTAssertEqual(WhenChoice.nextWeek.day(from: at("2026-09-15"), calendar: sundayFirst), "2026-09-21")
    }

    func testAnUnscheduledPageBecomesAllDay() {
        let moved = ScheduleShift.move(start: nil, end: nil, toDay: "2026-09-16")
        XCTAssertEqual(moved.start, "2026-09-16")
        XCTAssertNil(moved.end)
    }

    func testATimedPageKeepsItsTimeAndLength() {
        let moved = ScheduleShift.move(
            start: "2026-09-15T15:00:00", end: "2026-09-15T16:30:00", toDay: "2026-09-16")
        XCTAssertEqual(moved.start, "2026-09-16T15:00:00")
        XCTAssertEqual(moved.end, "2026-09-16T16:30:00")
    }

    func testATimedPageRunningPastMidnightKeepsItsEndDayOffset() {
        let moved = ScheduleShift.move(
            start: "2026-09-15T22:00:00", end: "2026-09-16T01:00:00", toDay: "2026-09-30")
        XCTAssertEqual(moved.start, "2026-09-30T22:00:00")
        XCTAssertEqual(moved.end, "2026-10-01T01:00:00")
    }

    func testAnAllDayRangeKeepsHowManyDaysItSpans() {
        let moved = ScheduleShift.move(start: "2026-09-15", end: "2026-09-17", toDay: "2026-09-21")
        XCTAssertEqual(moved.start, "2026-09-21")
        XCTAssertEqual(moved.end, "2026-09-23")
    }

    func testOnlyEarlierDaysAreOverdueOnToday() {
        XCTAssertTrue(TodayGrouping.isFromAnEarlierDay("2026-09-12T08:00:00", today: "2026-09-15"))
        XCTAssertTrue(TodayGrouping.isFromAnEarlierDay("2026-09-14", today: "2026-09-15"))
        XCTAssertFalse(TodayGrouping.isFromAnEarlierDay("2026-09-15T05:00:00", today: "2026-09-15"))
        XCTAssertFalse(TodayGrouping.isFromAnEarlierDay(nil, today: "2026-09-15"))
    }
}
