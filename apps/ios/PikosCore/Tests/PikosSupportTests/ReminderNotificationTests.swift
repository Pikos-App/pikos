import XCTest

@testable import PikosSupport

final class ReminderNotificationTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!

    private func calendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = london
        calendar.locale = Locale(identifier: "en_GB")
        return calendar
    }

    func testComponentsCarryEveryFieldAndAGregorianCalendar() {
        let components = ReminderNotification.fireComponents(
            "2026-05-27T13:30:05", timeZone: london)
        XCTAssertEqual(components?.year, 2026)
        XCTAssertEqual(components?.month, 5)
        XCTAssertEqual(components?.day, 27)
        XCTAssertEqual(components?.hour, 13)
        XCTAssertEqual(components?.minute, 30)
        XCTAssertEqual(components?.second, 5)
        XCTAssertEqual(components?.calendar?.identifier, .gregorian)
        XCTAssertEqual(components?.timeZone, london)
    }

    /// The trap the components exist to avoid: a device on the Buddhist
    /// calendar would resolve "2026" as a year 543 years away. Because the
    /// components carry their own calendar and zone, the digits name one
    /// instant with no device setting taking part.
    ///
    /// Read through `DateComponents.date`, which resolves against the calendar
    /// inside the components — the same one `UNCalendarNotificationTrigger`
    /// matches on. `Calendar.date(from:)` is not the same question: it answers
    /// with the calendar it is called on and ignores the one it is handed.
    func testComponentsNameOneInstantWithNoDeviceCalendarInvolved() throws {
        let components = try XCTUnwrap(
            ReminderNotification.fireComponents("2026-05-27T13:30:00", timeZone: london))
        XCTAssertEqual(components.date, Date(timeIntervalSince1970: 1_779_885_000))
    }

    func testMalformedWallClocksAreRefused() {
        XCTAssertNil(ReminderNotification.fireComponents("2026-05-27"))
        XCTAssertNil(ReminderNotification.fireComponents("2026-13-01T09:00:00"))
        XCTAssertNil(ReminderNotification.fireComponents("2026-05-27T25:00:00"))
        XCTAssertNil(ReminderNotification.fireComponents("not a clock"))
    }

    func testTheBodyIsRelativeToTheDayTheReminderFires() {
        let calendar = calendar()
        XCTAssertEqual(
            ReminderNotification.body(
                scheduledStart: "2026-05-27T15:00:00", fireAt: "2026-05-27T14:30:00",
                calendar: calendar),
            "Today at 3:00pm")
        XCTAssertEqual(
            ReminderNotification.body(
                scheduledStart: "2026-05-28T09:00:00", fireAt: "2026-05-27T09:00:00",
                calendar: calendar),
            "Tomorrow at 9:00am")
        // Two to six days out is a weekday name; further is a date.
        XCTAssertEqual(
            ReminderNotification.body(
                scheduledStart: "2026-05-30T09:00:00", fireAt: "2026-05-27T09:00:00",
                calendar: calendar),
            "Saturday at 9:00am")
        XCTAssertEqual(
            ReminderNotification.body(
                scheduledStart: "2026-06-10T09:00:00", fireAt: "2026-05-27T09:00:00",
                calendar: calendar),
            "Wed 10 Jun at 9:00am")
    }

    func testAnAllDayPageSaysSoInsteadOfATime() {
        XCTAssertEqual(
            ReminderNotification.body(
                scheduledStart: "2026-05-28", fireAt: "2026-05-27T09:00:00", calendar: calendar()),
            "Tomorrow, all day")
    }

    func testTheBudgetStaysUnderTheSystemCap() {
        XCTAssertLessThan(ReminderNotification.planningLimit, 64)
        XCTAssertGreaterThan(ReminderNotification.horizonDays, 0)
    }
}
