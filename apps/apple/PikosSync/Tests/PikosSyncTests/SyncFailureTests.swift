import CloudKit
import XCTest

@testable import PikosSync

private let zone = CKRecordZone.ID(zoneName: "ws-test", ownerName: CKCurrentUserDefaultName)

private func recordID(_ name: String) -> CKRecord.ID {
    CKRecord.ID(recordName: name, zoneID: zone)
}

private func partial(_ items: [CKRecord.ID: CKError]) -> CKError {
    CKError(.partialFailure, userInfo: [CKPartialErrorsByItemIDKey: items])
}

final class SyncFailureTests: XCTestCase {
    func testAnAccountProblemAtStartOrFetchSaysToSignInRatherThanThatSyncFailed() {
        let codes: [CKError.Code] = [.notAuthenticated, .accountTemporarilyUnavailable, .managedAccountRestricted]

        for code in codes {
            XCTAssertEqual(SyncFailure.status(for: CKError(code)), .noAccount, SyncFailure.name(code))
        }
    }

    func testAFullICloudAtFetchSaysStorageIsFull() {
        XCTAssertEqual(SyncFailure.status(for: CKError(.quotaExceeded)), .storageFull)
    }

    func testABusyICloudSaysSyncTriesAgainAndWhen() {
        let limited = CKError(.requestRateLimited, userInfo: [CKErrorRetryAfterKey: 300.0])

        XCTAssertEqual(SyncFailure.status(for: limited), .retrying(after: 300))
        XCTAssertEqual(SyncFailure.status(for: CKError(.zoneBusy)), .retrying(after: nil))
        XCTAssertEqual(
            SyncStatusLine(status: .retrying(after: 300), queue: .init(toSend: 0, needsUpdate: false, lastFetch: nil)).text,
            "iCloud is busy right now. Sync tries again by itself in about 5 minutes.")
    }

    func testAPartialFailureTakesItsStatusFromWhatMostItemsFailedWith() {
        let error = partial([
            recordID("page:a"): CKError(.quotaExceeded),
            recordID("page:b"): CKError(.quotaExceeded),
            recordID("page:c"): CKError(.batchRequestFailed),
            recordID("page:d"): CKError(.batchRequestFailed),
            recordID("page:e"): CKError(.batchRequestFailed),
        ])

        XCTAssertEqual(SyncFailure.status(for: error), .storageFull, "items only held back by the batch don't count")
    }

    func testAnyOtherFailureStillSaysCouldntSyncWithApplesMessage() {
        let error = CKError(.badContainer)

        XCTAssertEqual(SyncFailure.status(for: error), .failed(error.localizedDescription))
    }

    func testTheLogLineNamesThePhaseCodeRetryUnderlyingErrorAndEachRecord() {
        let underlying = NSError(domain: NSURLErrorDomain, code: -1009)
        let error = CKError(
            .partialFailure,
            userInfo: [
                CKPartialErrorsByItemIDKey: [
                    recordID("page:a"): CKError(.limitExceeded),
                    recordID("body:a"): CKError(.batchRequestFailed),
                ],
                CKErrorRetryAfterKey: 30.0,
                NSUnderlyingErrorKey: underlying,
            ])

        let line = SyncFailure.logLine("send", error)

        XCTAssertTrue(line.hasPrefix("send failed: partialFailure · retry after 30.0s · under NSURLErrorDomain -1009"), line)
        XCTAssertTrue(line.contains("2 items: body:a batchRequestFailed, page:a limitExceeded"), line)
    }

    func testANonCloudKitFailureLogsItsDomainAndCode() {
        let line = SyncFailure.logLine("upkeep", CocoaError(.fileWriteUnknown))

        XCTAssertTrue(line.hasPrefix("upkeep failed: NSCocoaErrorDomain 512"), line)
    }
}
