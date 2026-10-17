import XCTest

@testable import PikosSupport

final class ClockTimeTests: XCTestCase {
    func testMinutesAlwaysAndTheWholePeriodInLowercase() {
        XCTAssertEqual(ClockTime.string(hour: 15, minute: 0), "3:00pm")
        XCTAssertEqual(ClockTime.string(hour: 8, minute: 5), "8:05am")
    }

    func testMidnightAndNoonAreTwelve() {
        XCTAssertEqual(ClockTime.string(hour: 0, minute: 30), "12:30am")
        XCTAssertEqual(ClockTime.string(hour: 12, minute: 0), "12:00pm")
    }

    func testAnInstantIsReadInTheCalendarsZone() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        XCTAssertEqual(ClockTime.string(Date(timeIntervalSince1970: 0), calendar: calendar), "4:00pm")
    }
}
