import XCTest

@testable import PikosSupport

final class ReminderNotificationTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!

    private func calendar(_ identifier: Calendar.Identifier = .gregorian) -> Calendar {
        var calendar = Calendar(identifier: identifier)
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
    /// calendar would resolve "2026" as a year 543 years away. With the
    /// calendar pinned inside the components, the same digits name the same
    /// instant whatever the device is set to.
    func testComponentsResolveToTheSameInstantOnAnyDeviceCalendar() throws {
        let components = try XCTUnwrap(
            ReminderNotification.fireComponents("2026-05-27T13:30:00", timeZone: london))
        let fromGregorian = try XCTUnwrap(calendar().date(from: components))
        let fromBuddhist = try XCTUnwrap(calendar(.buddhist).date(from: components))
        XCTAssertEqual(fromGregorian, fromBuddhist)
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
            "Today at 15:00")
        XCTAssertEqual(
            ReminderNotification.body(
                scheduledStart: "2026-05-28T09:00:00", fireAt: "2026-05-27T09:00:00",
                calendar: calendar),
            "Tomorrow at 09:00")
        // Two to six days out is a weekday name; further is a date.
        XCTAssertEqual(
            ReminderNotification.body(
                scheduledStart: "2026-05-30T09:00:00", fireAt: "2026-05-27T09:00:00",
                calendar: calendar),
            "Saturday at 09:00")
        XCTAssertEqual(
            ReminderNotification.body(
                scheduledStart: "2026-06-10T09:00:00", fireAt: "2026-05-27T09:00:00",
                calendar: calendar),
            "Wed 10 Jun at 09:00")
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
