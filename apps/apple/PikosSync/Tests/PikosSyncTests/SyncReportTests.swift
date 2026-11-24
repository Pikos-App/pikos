import XCTest

@testable import PikosSync

final class SyncReportTests: XCTestCase {
    // qa: CLOUD-141:3
    func testARecordNameKeepsItsKindAndLosesItsKey() {
        let report = SyncReport.text(
            state: ["Couldn't sync: tag:Therapy%20notes was refused"],
            log: [
                "10:01:02 iCloud refused done:4f2a/2026-11-24 for good: 12",
                "10:01:03 building tomb:pagetag:4f2a/Health failed: gone",
            ])

        XCTAssertFalse(report.contains("Therapy"), report)
        XCTAssertFalse(report.contains("2026-11-24"), report)
        XCTAssertFalse(report.contains("Health"), report)
        XCTAssertTrue(report.contains("Couldn't sync: tag:… was refused"), report)
        XCTAssertTrue(report.contains("refused done:… for good"), report)
        XCTAssertTrue(report.contains("building pagetag:… failed"), report)
    }

    // qa: CLOUD-141:3
    func testASyncEventKeepsOnlyItsKind() {
        let report = SyncReport.text(
            state: [],
            log: [#"10:01:02 event: fetchedRecordZoneChanges(<CKRecord values={title="Diary"}>)"#])

        XCTAssertTrue(report.hasSuffix("10:01:02 event: fetchedRecordZoneChanges"), report)
        XCTAssertFalse(report.contains("Diary"), report)
    }

    func testTheStateComesFirstAndTheLogKeepsItsTail() {
        let log = (1...(SyncReport.logLimit + 5)).map { "line \($0)" }

        let report = SyncReport.text(state: ["Up to date"], log: log).components(separatedBy: "\n")

        XCTAssertEqual(Array(report.prefix(3)), ["Up to date", "", "Sync log:"])
        XCTAssertEqual(report[3], "line 6")
        XCTAssertEqual(report.last, "line \(SyncReport.logLimit + 5)")
    }
}
