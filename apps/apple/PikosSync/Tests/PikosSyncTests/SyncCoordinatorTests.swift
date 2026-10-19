import CloudKit
import XCTest

@testable import PikosSync

/// A workspace's engine in memory: pending records, what it built, what it was told was sent, and
/// what it applied.
private actor FakeStore: ReplicaStore {
    var pending: [RecordAddress] = []
    var records: [String: SyncRecord] = [:]
    var editedSinceBuilt: Set<String> = []
    private(set) var sent: [(name: String, builtAt: String)] = []
    private(set) var applied: [SyncRecord] = []
    private(set) var state: Data?

    func queue(_ record: SyncRecord, storeName: String) {
        records[record.name] = record
        pending.append(RecordAddress(name: record.name, storeName: storeName))
    }

    func edit(_ name: String) { editedSinceBuilt.insert(name) }

    func pendingRecords(limit: Int) async throws -> [RecordAddress] { Array(pending.prefix(limit)) }

    func buildRecords(names: [String]) async throws -> [OutgoingRecord] {
        names.compactMap { name in
            guard let record = records[name],
                let address = pending.first(where: { $0.name == name })
            else { return nil }
            return OutgoingRecord(
                record: record,
                storeName: address.storeName,
                builtAt: "clock-1",
                systemFields: systemFields[name]
            )
        }
    }

    func recordsSent(_ sent: [(name: String, builtAt: String)]) async throws -> [String] {
        self.sent.append(contentsOf: sent)
        return sent.map(\.name).filter(editedSinceBuilt.contains)
    }

    var applyFails = false

    func failApplying() { applyFails = true }

    func applyRecords(_ records: [SyncRecord]) async throws {
        if applyFails { throw CocoaError(.fileWriteUnknown) }
        applied.append(contentsOf: records)
    }

    func engineState() async throws -> Data? { state }

    func setEngineState(_ state: Data) async throws { self.state = state }

    private(set) var fetchesFinished = 0

    func fetchFinished() async throws { fetchesFinished += 1 }

    var expiring: [RecordAddress] = []
    private(set) var upkeepSteps: [String] = []

    func expireLater(_ address: RecordAddress) { expiring.append(address) }

    func expire() async throws -> [RecordAddress] {
        upkeepSteps.append("expire")
        defer { expiring = [] }
        return expiring
    }

    func retryHeld() async throws { upkeepSteps.append("retryHeld") }

    private(set) var systemFields: [String: Data] = [:]

    func saveSystemFields(_ fields: [(name: String, data: Data)]) async throws {
        for (name, data) in fields { systemFields[name] = data }
    }

    func join(zones: [String]) async throws -> String { zones.min() ?? "" }
}

private let workspaceZone = CKRecordZone.ID(zoneName: "ws-test", ownerName: CKCurrentUserDefaultName)

private func page(_ id: String, title: String) -> SyncRecord {
    SyncRecord(
        name: "page:\(id)",
        fields: ["title_0": .text(title), "title_at": .text("0001"), "priority_0": .integer(2)]
    )
}

final class SyncCoordinatorTests: XCTestCase {
    func testAPendingRecordIsBuiltIntoAnEncryptedCloudKitRecord() async throws {
        let store = FakeStore()
        await store.queue(page("p1", title: "Groceries"), storeName: "page:p1")
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)

        let ids = try await coordinator.pending()
        let built = try await coordinator.record(for: ids[0])

        let record = try XCTUnwrap(built)
        XCTAssertEqual(record.recordType, "page")
        XCTAssertEqual(record.recordID.zoneID, workspaceZone)
        XCTAssertEqual(record.encryptedValues["title_0"] as? String, "Groceries")
        XCTAssertEqual(record.encryptedValues["priority_0"] as? Int64, 2)
        XCTAssertEqual(record.encryptedValues["record"] as? String, "page:p1")
    }

    // qa: CLOUD-126:2
    func testAnImageGoesAsACloudKitAssetAndComesBackAsTheFileItDownloaded() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID()).png")
        try Data("harbour".utf8).write(to: file)
        let store = FakeStore()
        let image = SyncRecord(
            name: "asset:\(file.lastPathComponent)",
            fields: ["born": .text("0001"), "file": .text(file.path)])
        await store.queue(image, storeName: image.name)
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)

        let ids = try await coordinator.pending()
        let built = try await coordinator.record(for: ids[0])
        let record = try XCTUnwrap(built)

        XCTAssertEqual((record["file"] as? CKAsset)?.fileURL, file)
        XCTAssertNil(record.encryptedValues["file"])
        XCTAssertEqual(RecordCodec.decode(record)?.fields["file"], .text(file.path))
    }

    func testAFileNamedInATextFieldIsNotTakenAsOneToCopy() {
        let record = CKRecord(recordType: "asset", recordID: CKRecord.ID(recordName: "asset:x", zoneID: workspaceZone))
        record.encryptedValues["record"] = "asset:x"
        record.encryptedValues["file"] = "/etc/hosts"

        XCTAssertNil(RecordCodec.decode(record)?.fields["file"])
    }

    func testARecordStoredUnderAnEscapedNameKeepsItsRealName() async throws {
        let store = FakeStore()
        let tag = SyncRecord(name: "pagetag:p1/café", fields: ["born": .text("0001")])
        await store.queue(tag, storeName: "pagetag:p1/caf%C3%A9")
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)

        let ids = try await coordinator.pending()
        let recordBuilt = try await coordinator.record(for: ids[0])
        let record = try XCTUnwrap(recordBuilt)

        XCTAssertEqual(record.recordID.recordName, "pagetag:p1/caf%C3%A9")
        XCTAssertEqual(RecordCodec.decode(record)?.name, "pagetag:p1/café")
    }

    func testASavedRecordIsReportedSentAndOneEditedMeanwhileGoesAgain() async throws {
        let store = FakeStore()
        await store.queue(page("p1", title: "Groceries"), storeName: "page:p1")
        await store.queue(page("p2", title: "Laundry"), storeName: "page:p2")
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)
        let ids = try await coordinator.pending()
        let firstBuilt = try await coordinator.record(for: ids[0])
        let first = try XCTUnwrap(firstBuilt)
        let secondBuilt = try await coordinator.record(for: ids[1])
        let second = try XCTUnwrap(secondBuilt)
        await store.edit("page:p2")

        let again = try await coordinator.saved([first, second])

        let sent = await store.sent.map(\.name)
        XCTAssertEqual(sent, ["page:p1", "page:p2"])
        XCTAssertEqual(again, [second.recordID])
    }

    // qa: CLOUD-113
    func testARefusedSaveMergesTheServerCopyAndBuildsTheNextSendOnIt() async throws {
        let store = FakeStore()
        await store.queue(page("p1", title: "Groceries"), storeName: "page:p1")
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)
        let ids = try await coordinator.pending()
        _ = try await coordinator.record(for: ids[0])
        let server = RecordCodec.encode(
            OutgoingRecord(record: page("p1", title: "From the Mac"), storeName: "page:p1", builtAt: ""),
            zone: workspaceZone
        )
        server.encryptedValues["stale_0"] = "left by an older build"

        let again = try await coordinator.refused(over: server)
        let nextBuilt = try await coordinator.record(for: again)
        let next = try XCTUnwrap(nextBuilt)

        let applied = await store.applied.map(\.name)
        XCTAssertEqual(applied, ["page:p1"])
        XCTAssertTrue(next === server, "the next send carries the server's change tag")
        XCTAssertEqual(next.encryptedValues["title_0"] as? String, "Groceries")
        XCTAssertNil(next.encryptedValues["stale_0"], "a field the record no longer has is cleared")
    }

    func testFetchedRecordsAreAppliedAndOthersInTheZoneIgnored() async throws {
        let store = FakeStore()
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)
        let ours = RecordCodec.encode(
            OutgoingRecord(record: page("p1", title: "Groceries"), storeName: "page:p1", builtAt: ""),
            zone: workspaceZone
        )
        let stranger = CKRecord(
            recordType: "meta",
            recordID: CKRecord.ID(recordName: "meta", zoneID: workspaceZone)
        )

        try await coordinator.fetched([ours, stranger])

        let applied = await store.applied
        XCTAssertEqual(applied, [page("p1", title: "Groceries")])
    }

    func testTheEngineStateIsSavedThroughTheStore() async throws {
        let store = FakeStore()
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)

        try await coordinator.stateUpdated(Data([1, 2, 3]))

        let saved = await store.state
        XCTAssertEqual(saved, Data([1, 2, 3]))
    }

    // qa: CLOUD-114
    func testAfterFetchedRecordsFailToApplyNoLaterStateIsSavedSoTheNextLaunchFetchesThemAgain()
        async throws
    {
        let store = FakeStore()
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)
        try await coordinator.stateUpdated(Data([1]))
        await store.failApplying()
        let record = RecordCodec.encode(
            OutgoingRecord(record: page("p1", title: "Groceries"), storeName: "page:p1", builtAt: ""),
            zone: workspaceZone
        )

        do {
            try await coordinator.fetched([record])
            XCTFail("the failure reaches the transport")
        } catch {}
        try await coordinator.stateUpdated(Data([2]))
        try await coordinator.fetchFinished()

        let saved = await store.state
        let fetchesFinished = await store.fetchesFinished
        XCTAssertEqual(saved, Data([1]))
        XCTAssertEqual(fetchesFinished, 0, "a fetch that didn't apply isn't counted as one")
    }

    func testAFetchThatFoundNothingStillCountsAsOne() async throws {
        let store = FakeStore()
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)

        try await coordinator.fetched([])
        try await coordinator.fetchFinished()

        let fetchesFinished = await store.fetchesFinished
        XCTAssertEqual(fetchesFinished, 1)
    }

    func testExpiredTombstonesBecomeCloudKitDeletions() async throws {
        let store = FakeStore()
        await store.expireLater(RecordAddress(name: "page:old", storeName: "page:old"))
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)

        let ids = try await coordinator.expired()

        XCTAssertEqual(ids, [CKRecord.ID(recordName: "page:old", zoneID: workspaceZone)])
    }

    func testUpkeepExpiresThenRetriesHeldRecordsAtLaunchAndThenOnceADay() async throws {
        let store = FakeStore()
        await store.expireLater(RecordAddress(name: "page:old", storeName: "page:old"))
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)
        let launch = Date(timeIntervalSince1970: 1_000_000)

        let atLaunch = try await coordinator.upkeepIfDue(now: launch)
        let anHourLater = try await coordinator.upkeepIfDue(now: launch.addingTimeInterval(3_600))
        let stepsWithinTheDay = await store.upkeepSteps
        _ = try await coordinator.upkeepIfDue(now: launch.addingTimeInterval(24 * 3_600))

        XCTAssertEqual(atLaunch, [CKRecord.ID(recordName: "page:old", zoneID: workspaceZone)])
        XCTAssertEqual(anHourLater, [])
        XCTAssertEqual(stepsWithinTheDay, ["expire", "retryHeld"])
        let steps = await store.upkeepSteps
        XCTAssertEqual(steps, ["expire", "retryHeld", "expire", "retryHeld"])
    }

    func testUpkeepWaitsWhileSyncIsPausedSoNothingIsDeletedFromAnotherAccount() async throws {
        let store = FakeStore()
        await store.expireLater(RecordAddress(name: "page:old", storeName: "page:old"))
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)
        _ = await coordinator.zoneDeleted(workspaceZone, reason: .purged)

        let ids = try await coordinator.upkeepIfDue()

        XCTAssertEqual(ids, [])
        let steps = await store.upkeepSteps
        XCTAssertEqual(steps, [])
    }

    // qa: CLOUD-122
    func testAnotherAccountSigningInPausesSyncUntilThePersonChoosesToSyncWithIt() async throws {
        let store = FakeStore()
        await store.queue(page("p1", title: "Groceries"), storeName: "page:p1")
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)
        let queued = try await coordinator.pending()
        let theirs = RecordCodec.encode(
            OutgoingRecord(record: page("p2", title: "Their page"), storeName: "page:p2", builtAt: ""),
            zone: workspaceZone
        )

        let status = await coordinator.accountChanged(
            .switchAccounts(
                previousUser: CKRecord.ID(recordName: "_alex"),
                currentUser: CKRecord.ID(recordName: "_someone")))
        let pendingWhilePaused = try await coordinator.pending()
        let built = try await coordinator.record(for: queued[0])
        try await coordinator.fetched([theirs])
        try await coordinator.stateUpdated(Data([1]))

        let line = SyncStatusLine(status: status, queue: .init(toSend: 1, needsUpdate: false, lastFetch: nil))
        XCTAssertEqual(line.text, "This device is signed in to a different iCloud account, so sync is paused.")
        XCTAssertEqual(line.action, .useThisAccount)
        XCTAssertEqual(pendingWhilePaused, [], "nothing is sent into the other account")
        XCTAssertNil(built)
        let applied = await store.applied
        XCTAssertEqual(applied, [], "nothing of the other account's is applied here")
        let saved = await store.state
        XCTAssertNil(saved)

        let afterChoosing = SyncCoordinator(store: store, zone: workspaceZone)
        let sentAfterChoosing = try await afterChoosing.pending()
        XCTAssertEqual(sentAfterChoosing, queued)
    }

    // qa: CLOUD-123
    func testDeletingTheWorkspacesICloudDataPausesSyncUntilThePersonChoosesToUploadAgain() async throws {
        let store = FakeStore()
        await store.queue(page("p1", title: "Groceries"), storeName: "page:p1")
        let coordinator = SyncCoordinator(store: store, zone: workspaceZone)
        let queued = try await coordinator.pending()
        let otherZone = CKRecordZone.ID(zoneName: "ws-other", ownerName: CKCurrentUserDefaultName)

        let otherStatus = await coordinator.zoneDeleted(otherZone, reason: .purged)
        let stillSending = try await coordinator.pending()
        let status = await coordinator.zoneDeleted(workspaceZone, reason: .purged)
        let pendingWhilePaused = try await coordinator.pending()
        let built = try await coordinator.record(for: queued[0])

        XCTAssertNil(otherStatus, "another zone's deletion leaves sync going")
        XCTAssertEqual(stillSending, queued)
        let line = SyncStatusLine(status: status, queue: .init(toSend: 1, needsUpdate: false, lastFetch: nil))
        XCTAssertEqual(line.text, "Pikos's data was deleted from iCloud, so sync is paused.")
        XCTAssertEqual(line.action, .uploadAgain)
        XCTAssertEqual(pendingWhilePaused, [], "nothing goes back up on its own")
        XCTAssertNil(built)

        let afterChoosing = SyncCoordinator(store: store, zone: workspaceZone)
        let sentAfterChoosing = try await afterChoosing.pending()
        XCTAssertEqual(sentAfterChoosing, queued)
    }

    func testASavedRecordsCloudKitMetadataIsKeptAndANewCoordinatorBuildsOnIt() async throws {
        let store = FakeStore()
        await store.queue(page("p1", title: "Groceries"), storeName: "page:p1")
        let first = SyncCoordinator(store: store, zone: workspaceZone)
        let ids = try await first.pending()
        let sentBuilt = try await first.record(for: ids[0])
        let sent = try XCTUnwrap(sentBuilt)
        _ = try await first.saved([sent])

        let afterRelaunch = SyncCoordinator(store: store, zone: workspaceZone)
        let againIds = try await afterRelaunch.pending()
        let rebuiltBuilt = try await afterRelaunch.record(for: againIds[0])
        let rebuilt = try XCTUnwrap(rebuiltBuilt)

        let kept = await store.systemFields["page:p1"]
        XCTAssertNotNil(kept)
        XCTAssertEqual(rebuilt.recordID, sent.recordID)
        XCTAssertEqual(rebuilt.encryptedValues["title_0"] as? String, "Groceries")
    }
}
