import XCTest

@testable import PikosSupport

/// Reading the UTC instant columns.
///
/// Worth testing because the bug this guards against is silent. The trash sheet
/// originally parsed `deleted_at` with `yyyy-MM-dd'T'HH:mm:ss` — the format the
/// *scheduling* fields use — against a column that carries milliseconds and a
/// `Z`. Every parse failed, every row fell back to its raw stamp, and nothing
/// errored: the screen just showed `2026-09-13T14:30:00.123Z` where it meant to
/// say "Deleted 3 days ago".
final class StorageTimestampTests: XCTestCase {
    /// The exact shape Rust's `now_iso()` writes: `%Y-%m-%dT%H:%M:%S%.3fZ`.
    func testReadsTheFormatTheDataLayerWrites() {
        let parsed = StorageTimestamp.utc("2026-09-13T14:30:00.123Z")
        XCTAssertEqual(parsed?.timeIntervalSince1970, 1_789_309_800.123, accuracy: 0.0005)
    }

    /// Milliseconds are not optional inside one `ISO8601FormatStyle`, so both
    /// shapes are tried. A stamp from an import or an older writer should still
    /// read as a date.
    func testReadsAStampWithoutMilliseconds() {
        let parsed = StorageTimestamp.utc("2026-09-13T14:30:00Z")
        XCTAssertEqual(parsed?.timeIntervalSince1970, 1_789_309_800, accuracy: 0.0005)
    }

    /// The whole point of the type. A value read as UTC must land on the same
    /// instant no matter where the reader is, so "3 days ago" cannot shift by
    /// an offset — the failure that would be invisible in London and wrong by a
    /// day near midnight in Auckland.
    func testTheInstantDoesNotDependOnTheReadersZone() {
        XCTAssertEqual(
            StorageTimestamp.utc("2026-09-13T14:30:00.000Z"),
            Date(timeIntervalSince1970: 1_789_309_800))
    }

    /// A zoneless wall clock is *not* an instant — it is `scheduled_start`'s
    /// format, and reading it here would silently misplace it by the reader's
    /// offset. Refusing it is what keeps the two columns from being confused.
    func testAWallClockIsRefusedRatherThanAssumedToBeUTC() {
        XCTAssertNil(StorageTimestamp.utc("2026-09-13T14:30:00"))
        XCTAssertNil(StorageTimestamp.utc("2026-09-13"))
    }

    /// Nil rather than a substitute, so the caller can show the raw value.
    func testMalformedStampsAreRefused() {
        for bad in ["", "2026", "not a date", "2026-13-45T99:99:99.000Z", "2026-09-13T14:30Z"] {
            XCTAssertNil(StorageTimestamp.utc(bad), "should refuse \(bad)")
        }
    }
}

/// Reading the wall-clock columns — the other half of the split, and the one a
/// schedule editor writes back through.
///
/// A wall clock is not an instant: 09:00 means 09:00 wherever the reader is.
/// The tests that matter are the ones where treating it as an instant would
/// still look right — same zone, no DST — so each of these deliberately stands
/// somewhere it would not.
extension StorageTimestampTests {
    private var london: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London") ?? .gmt
        return calendar
    }

    func testReadsBothShapes() {
        let allDay = StorageTimestamp.wallClock("2026-03-15", in: london)
        XCTAssertNotNil(allDay)
        // Noon, not midnight: midnight is the instant a spring-forward deletes.
        XCTAssertEqual(london.component(.hour, from: allDay!), 12)

        let timed = StorageTimestamp.wallClock("2026-03-15T09:30:00", in: london)
        XCTAssertNotNil(timed)
        XCTAssertEqual(london.component(.hour, from: timed!), 9)
        XCTAssertEqual(london.component(.minute, from: timed!), 30)
    }

    /// The same string is a different instant in a different zone, and the same
    /// *reading* in each. That is the whole contract.
    func testTheSameWallClockIsTheSameReadingInEveryZone() {
        var auckland = Calendar(identifier: .gregorian)
        auckland.timeZone = TimeZone(identifier: "Pacific/Auckland") ?? .gmt

        let here = StorageTimestamp.wallClock("2026-03-15T09:00:00", in: london)!
        let there = StorageTimestamp.wallClock("2026-03-15T09:00:00", in: auckland)!
        XCTAssertNotEqual(here, there, "different zones, different instants")
        XCTAssertEqual(london.component(.hour, from: here), 9)
        XCTAssertEqual(auckland.component(.hour, from: there), 9)
    }

    /// Seconds are optional in the wild even though `now_local_iso` writes them.
    func testSecondsMayBeOmitted() {
        let parsed = StorageTimestamp.wallClock("2026-03-15T09:30", in: london)
        XCTAssertEqual(parsed, StorageTimestamp.wallClock("2026-03-15T09:30:00", in: london))
    }

    /// A UTC instant read as a wall clock would be silently wrong rather than
    /// absent, which is exactly the confusion the two functions exist to keep
    /// apart. The trailing `Z` makes the seconds unreadable, so it is refused.
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

    /// A device on a non-Gregorian calendar must still read the stored string,
    /// which is written in Gregorian years whatever the phone displays.
    func testANonGregorianDeviceCalendarStillReadsTheStoredString() {
        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = TimeZone(identifier: "Europe/London") ?? .gmt

        XCTAssertEqual(
            StorageTimestamp.wallClock("2026-03-15T09:00:00", in: buddhist),
            StorageTimestamp.wallClock("2026-03-15T09:00:00", in: london))
    }

    /// 02:30 on a spring-forward day is a real stored value that no instant
    /// matches. Shifting it forward beats refusing to show the page.
    func testATimeInsideADstGapStillResolves() {
        // Europe/London moves 01:00 → 02:00 on 2026-03-29, so 01:30 is missing.
        XCTAssertNotNil(StorageTimestamp.wallClock("2026-03-29T01:30:00", in: london))
    }
}
