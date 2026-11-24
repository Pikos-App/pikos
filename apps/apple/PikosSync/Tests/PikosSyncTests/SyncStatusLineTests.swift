import XCTest

@testable import PikosSync

final class SyncStatusLineTests: XCTestCase {
    private let empty = SyncStatusLine.Queue(toSend: 0, needsUpdate: false, lastFetch: nil)

    // qa: CLOUD-120:3
    func testSyncTurnedOffSaysOff() {
        XCTAssertEqual(SyncStatusLine(status: nil, queue: empty).text, "Off")
    }

    // qa: CLOUD-120:3
    func testASettledDeviceSaysUpToDateAndWhenItLastChecked() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let queue = SyncStatusLine.Queue(
            toSend: 0, needsUpdate: false, lastFetch: now.addingTimeInterval(-120))

        let line = SyncStatusLine(status: .upToDate, queue: queue, now: now)

        XCTAssertTrue(line.text.hasPrefix("Up to date · checked "), line.text)
        XCTAssertEqual(line.action, .none)
    }

    func testAFetchUnderAMinuteOldOrStampedAfterNowSaysJustNow() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let ahead = SyncStatusLine.Queue(
            toSend: 0, needsUpdate: false, lastFetch: now.addingTimeInterval(0.2))
        let recent = SyncStatusLine.Queue(
            toSend: 0, needsUpdate: false, lastFetch: now.addingTimeInterval(-30))

        XCTAssertEqual(
            SyncStatusLine(status: .upToDate, queue: ahead, now: now).text, "Up to date · checked just now")
        XCTAssertEqual(
            SyncStatusLine(status: .upToDate, queue: recent, now: now).text, "Up to date · checked just now")
    }

    func testASettledDeviceSaysWhenItLastSentAndReceived() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let queue = SyncStatusLine.Queue(
            toSend: 0, needsUpdate: false, lastFetch: now, lastSent: now.addingTimeInterval(-10),
            lastReceived: now.addingTimeInterval(-20))

        let line = SyncStatusLine(status: .upToDate, queue: queue, now: now)

        XCTAssertEqual(line.text, "Up to date · sent just now · received just now · checked just now")
    }

    func testAFailureThatPassedStaysOnTheLine() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let queue = SyncStatusLine.Queue(
            toSend: 2, needsUpdate: false, lastFetch: nil,
            lastFailure: .init(message: "The network connection was lost.", at: now))

        let line = SyncStatusLine(status: .upToDate, queue: queue, now: now)

        XCTAssertEqual(
            line.text,
            "2 changes waiting to send · last failed just now: The network connection was lost. \(SyncStatusLine.reassurance)"
        )
    }

    func testChangesWaitingToSendAreCountedInsteadOfUpToDate() {
        let one = SyncStatusLine(
            status: .upToDate, queue: .init(toSend: 1, needsUpdate: false, lastFetch: nil))
        let many = SyncStatusLine(
            status: .upToDate, queue: .init(toSend: 4, needsUpdate: true, lastFetch: nil))

        XCTAssertEqual(one.text, "1 change waiting to send. \(SyncStatusLine.reassurance)")
        XCTAssertEqual(
            many.text, "4 changes waiting to send · some changes need a newer Pikos. \(SyncStatusLine.reassurance)")
    }

    func testABigUploadSaysHowMuchIsLeftAndThatLeavingIsSafe() {
        let line = SyncStatusLine(
            status: .syncing, queue: .init(toSend: 1819, needsUpdate: false, lastFetch: nil))

        XCTAssertEqual(line.text, "Sending \(1819.formatted()) changes. \(SyncStatusLine.reassurance)")
    }

    func testSyncingWithNothingToSendStaysShort() {
        XCTAssertEqual(SyncStatusLine(status: .syncing, queue: empty).text, "Syncing…")
    }

    func testAnotherAccountOffersToSyncWithIt() {
        let line = SyncStatusLine(status: .accountChanged, queue: empty)

        XCTAssertEqual(line.action, .useThisAccount)
    }

    func testDeletedOrUnreadableICloudDataOffersToUploadAgain() {
        XCTAssertEqual(SyncStatusLine(status: .zoneDeleted, queue: empty).action, .uploadAgain)
        XCTAssertEqual(SyncStatusLine(status: .encryptionReset, queue: empty).action, .uploadAgain)
    }

    func testNoAccountSaysWhereToSignIn() {
        XCTAssertEqual(
            SyncStatusLine(status: .noAccount, queue: empty).text,
            "Sign in to iCloud in the Settings app to sync.")
    }
}
