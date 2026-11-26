import XCTest

@testable import PikosSupport

/// Guards a silent failure: parsing `deleted_at` with the scheduling fields'
/// format fails every row without an error and shows the raw stamp.
final class StorageTimestampTests: XCTestCase {
    /// The shape Rust's `now_iso()` writes: `%Y-%m-%dT%H:%M:%S%.3fZ`.
    func testReadsTheFormatTheDataLayerWrites() throws {
        let parsed = try XCTUnwrap(StorageTimestamp.utc("2026-09-13T14:30:00.123Z"))
        XCTAssertEqual(parsed.timeIntervalSince1970, 1_789_309_800.123, accuracy: 0.0005)
    }

    func testReadsAStampWithoutMilliseconds() throws {
        let parsed = try XCTUnwrap(StorageTimestamp.utc("2026-09-13T14:30:00Z"))
        XCTAssertEqual(parsed.timeIntervalSince1970, 1_789_309_800, accuracy: 0.0005)
    }

    func testTheInstantDoesNotDependOnTheReadersZone() {
        XCTAssertEqual(
            StorageTimestamp.utc("2026-09-13T14:30:00.000Z"),
            Date(timeIntervalSince1970: 1_789_309_800))
    }

    /// A zoneless wall clock is `scheduled_start`'s format; reading it as UTC would misplace it.
    func testAWallClockIsRefusedRatherThanAssumedToBeUTC() {
        XCTAssertNil(StorageTimestamp.utc("2026-09-13T14:30:00"))
        XCTAssertNil(StorageTimestamp.utc("2026-09-13"))
    }

    func testMalformedStampsAreRefused() {
        for bad in ["", "2026", "not a date", "2026-13-45T99:99:99.000Z", "2026-09-13T14:30Z"] {
            XCTAssertNil(StorageTimestamp.utc(bad), "should refuse \(bad)")
        }
    }
}

/// Wall clocks: treating one as an instant would still look right in the same
/// zone with no DST, so these deliberately stand somewhere it would not.
extension StorageTimestampTests {
    private var london: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London") ?? .gmt
        return calendar
    }

    func testReadsBothShapes() {
        let allDay = StorageTimestamp.wallClock("2026-03-15", in: london)
        XCTAssertNotNil(allDay)
        XCTAssertEqual(london.component(.hour, from: allDay!), 12)

        let timed = StorageTimestamp.wallClock("2026-03-15T09:30:00", in: london)
        XCTAssertNotNil(timed)
        XCTAssertEqual(london.component(.hour, from: timed!), 9)
        XCTAssertEqual(london.component(.minute, from: timed!), 30)
    }

    func testTheSameWallClockIsTheSameReadingInEveryZone() {
        var auckland = Calendar(identifier: .gregorian)
        auckland.timeZone = TimeZone(identifier: "Pacific/Auckland") ?? .gmt

        let here = StorageTimestamp.wallClock("2026-03-15T09:00:00", in: london)!
        let there = StorageTimestamp.wallClock("2026-03-15T09:00:00", in: auckland)!
        XCTAssertNotEqual(here, there, "different zones, different instants")
        XCTAssertEqual(london.component(.hour, from: here), 9)
        XCTAssertEqual(auckland.component(.hour, from: there), 9)
    }

    func testSecondsMayBeOmitted() {
        let parsed = StorageTimestamp.wallClock("2026-03-15T09:30", in: london)
        XCTAssertEqual(parsed, StorageTimestamp.wallClock("2026-03-15T09:30:00", in: london))
    }

    /// The trailing `Z` makes the seconds unreadable, so it is refused.
    func testAUtcInstantIsNotAWallClock() {
        XCTAssertNil(StorageTimestamp.wallClock("2026-03-15T09:30:00.123Z", in: london))
        XCTAssertNil(StorageTimestamp.wallClock("2026-03-15T09:30:00Z", in: london))
    }

    func testOutOfRangeFieldsAreRefused() {
        for bad in [
            "2026-03-15T24:00:00", "2026-03-15T09:60:00", "2026-03-15T09:30:60",
            "2026-13-01", "2026-03-15T", "2026-03-15Tnope", "",
        ] {
            XCTAssertNil(StorageTimestamp.wallClock(bad, in: london), "should refuse \(bad)")
        }
    }

    func testANonGregorianDeviceCalendarStillReadsTheStoredString() {
        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = TimeZone(identifier: "Europe/London") ?? .gmt

        XCTAssertEqual(
            StorageTimestamp.wallClock("2026-03-15T09:00:00", in: buddhist),
            StorageTimestamp.wallClock("2026-03-15T09:00:00", in: london))
    }

    func testATimeInsideADstGapStillResolves() {
        // Europe/London moves 01:00 to 02:00 on 2026-03-29, so 01:30 is missing.
        XCTAssertNotNil(StorageTimestamp.wallClock("2026-03-29T01:30:00", in: london))
    }
}
