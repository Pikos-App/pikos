import XCTest

@testable import PikosSync

final class SyncStatusLineTests: XCTestCase {
    private let empty = SyncStatusLine.Queue(toSend: 0, needsUpdate: false, lastFetch: nil)

    func testSyncTurnedOffSaysOff() {
        XCTAssertEqual(SyncStatusLine(status: nil, queue: empty).text, "Off")
    }

    func testASettledDeviceSaysUpToDateAndWhenItLastChecked() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let queue = SyncStatusLine.Queue(
            toSend: 0, needsUpdate: false, lastFetch: now.addingTimeInterval(-120))

        let line = SyncStatusLine(status: .upToDate, queue: queue, now: now)

        XCTAssertTrue(line.text.hasPrefix("Up to date · checked "), line.text)
        XCTAssertEqual(line.action, .none)
    }

    func testChangesWaitingToSendAreCountedInsteadOfUpToDate() {
        let one = SyncStatusLine(
            status: .upToDate, queue: .init(toSend: 1, needsUpdate: false, lastFetch: nil))
        let many = SyncStatusLine(
            status: .upToDate, queue: .init(toSend: 4, needsUpdate: true, lastFetch: nil))

        XCTAssertEqual(one.text, "1 change waiting to send")
        XCTAssertEqual(many.text, "4 changes waiting to send · some changes need a newer Pikos")
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
