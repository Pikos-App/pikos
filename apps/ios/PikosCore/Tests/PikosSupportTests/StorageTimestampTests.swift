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
