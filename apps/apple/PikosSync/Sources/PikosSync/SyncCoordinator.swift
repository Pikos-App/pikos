import CloudKit
import os

/// What the CloudKit transport does with each thing Apple's sync engine hands it, kept apart from
/// the engine so it runs in tests without an iCloud account.
public actor SyncCoordinator {
    private let store: ReplicaStore
    public nonisolated let zone: CKRecordZone.ID
    private static let log = Logger(subsystem: "app.pikos", category: "sync")

    /// Each pending record's name, by the name CloudKit stores it under.
    private var names: [String: String] = [:]
    /// Records built and not yet confirmed, by store name.
    private var inFlight: [String: OutgoingRecord] = [:]
    /// The server's last copy of each record this device saved or was refused over. Building on it
    /// keeps the server's change tag, so the next save isn't refused as stale.
    private var serverCopies: [String: CKRecord] = [:]
    /// Fetched records failed to apply. Apple's engine has moved past them anyway, so no state is
    /// saved for the rest of this launch: the next one starts from the last state saved before
    /// them and fetches them again.
    private var fetchUnapplied = false
    /// Set when iCloud changed under this device in a way only the person settles: another Apple ID
    /// signed in, or the workspace's zone was deleted. From then on nothing is sent or applied, no
    /// state is saved, and the status line keeps saying so. Kept in the workspace too, so a relaunch
    /// before the person chooses doesn't start sync again. Their choice starts sync over with a new
    /// coordinator.
    public private(set) var paused: SyncStatus?
    /// The pauses kept in the workspace, by the name stored there.
    static let holds: [String: SyncStatus] = [
        "accountChanged": .accountChanged,
        "zoneDeleted": .zoneDeleted,
        "encryptionReset": .encryptionReset,
    ]
    /// Records iCloud refused for good, by store name. They aren't queued again for the rest of
    /// this launch, so an edit that fixes one goes at the next.
    private var refusedForGood: Set<String> = []
    /// Set when a save was refused because the account's iCloud storage is full, and cleared by
    /// the next save that goes through. Meanwhile only a fetch queues records again, so a full
    /// account is tried every few minutes rather than after every send.
    private var storageFull = false

    /// Save failures that sending the same record again can't fix: it's too big, or an image it
    /// carries is gone. Apple's sample retries only the transient codes.
    static let permanentFailures: Set<CKError.Code> = [.limitExceeded, .assetFileNotFound]

    static let upkeepEvery: TimeInterval = 24 * 60 * 60
    private var lastUpkeep: Date?

    private var savesState: Bool { !fetchUnapplied && paused == nil }

    public init(store: ReplicaStore, zone: CKRecordZone.ID) {
        self.store = store
        self.zone = zone
    }

    /// The records waiting to send, as CloudKit ids for the engine's pending list.
    public func pending(limit: Int = 1_000, retryingFull: Bool = false) async throws -> [CKRecord.ID] {
        let isHeldBack = paused != nil || (storageFull && !retryingFull)
        guard !isHeldBack else { return [] }

        let addresses = try await store.pendingRecords(limit: limit)
            .filter { !refusedForGood.contains($0.storeName) }
        for address in addresses {
            names[address.storeName] = address.name
        }
        return addresses.map { CKRecord.ID(recordName: $0.storeName, zoneID: zone) }
    }

    /// The record to send for a pending id, built now from the live row, or nil when it no longer
    /// needs sending.
    public func record(for id: CKRecord.ID) async throws -> CKRecord? {
        guard paused == nil, !refusedForGood.contains(id.recordName), let name = names[id.recordName],
            let outgoing = try await store.buildRecords(names: [name]).first
        else { return nil }
        inFlight[outgoing.storeName] = outgoing
        let saved = outgoing.systemFields.flatMap(RecordCodec.record(fromSystemFields:))
        if let copy = serverCopies[outgoing.storeName] ?? saved {
            RecordCodec.fill(copy, with: outgoing.record)
            return copy
        }
        return RecordCodec.encode(outgoing, zone: zone)
    }

    /// CloudKit stored these. Returns the ids edited here since they were built, to queue again.
    public func saved(_ records: [CKRecord]) async throws -> [CKRecord.ID] {
        var sent: [(name: String, builtAt: String)] = []
        var metadata: [(name: String, data: Data)] = []
        if !records.isEmpty {
            storageFull = false
        }

        for record in records {
            let storeName = record.recordID.recordName
            serverCopies[storeName] = record
            if let outgoing = inFlight.removeValue(forKey: storeName) {
                sent.append((outgoing.record.name, outgoing.builtAt))
                metadata.append((outgoing.record.name, RecordCodec.systemFields(of: record)))
            }
        }
        try await store.saveSystemFields(metadata)
        let stillPending = Set(try await store.recordsSent(sent))
        return records
            .filter { record in names[record.recordID.recordName].map(stillPending.contains) ?? false }
            .map(\.recordID)
    }

    /// The server holds a newer copy than the one this device sent. It's merged in like a fetch,
    /// and the record goes again built on the server's copy.
    public func refused(over server: CKRecord) async throws -> CKRecord.ID {
        let storeName = server.recordID.recordName
        inFlight[storeName] = nil
        serverCopies[storeName] = server
        if let record = RecordCodec.decode(server) {
            names[storeName] = record.name
            try await store.applyRecords([record])
        }
        return server.recordID
    }

    /// A save failed for a reason the transport doesn't handle itself. Returns whether to queue the
    /// record again now.
    public func failed(_ id: CKRecord.ID, code: CKError.Code) -> Bool {
        inFlight[id.recordName] = nil
        if code == .quotaExceeded {
            storageFull = true
            return false
        }

        let isPermanent = Self.permanentFailures.contains(code)
        if isPermanent {
            Self.log.error("iCloud refused \(id.recordName, privacy: .public) for good: \(code.rawValue)")
            refusedForGood.insert(id.recordName)
        }

        return !isPermanent
    }

    /// What the status line says once a send or fetch finishes.
    public var settled: SyncStatus {
        storageFull ? .storageFull : .upToDate
    }

    /// The server no longer has a record this device built on: the next send starts fresh.
    public func forgetServerCopy(_ id: CKRecord.ID) {
        serverCopies[id.recordName] = nil
        inFlight[id.recordName] = nil
    }

    public func fetched(_ records: [CKRecord]) async throws {
        guard paused == nil else { return }

        var decoded: [SyncRecord] = []
        var metadata: [(name: String, data: Data)] = []
        for record in records {
            serverCopies[record.recordID.recordName] = record
            if let sync = RecordCodec.decode(record) {
                names[record.recordID.recordName] = sync.name
                decoded.append(sync)
                metadata.append((sync.name, RecordCodec.systemFields(of: record)))
            }
        }
        Self.log.info("fetched \(records.count) records, \(decoded.count) readable")
        if !decoded.isEmpty {
            do {
                try await store.applyRecords(decoded)
            } catch {
                fetchUnapplied = true
                throw error
            }
            Self.log.info("applied \(decoded.count) records")
            try await store.saveSystemFields(metadata)
        }
    }

    /// On the first call of a launch and then a day apart: forgets tombstones past retention, then
    /// tries held records again, since an update may read them now. Returns the expired ids to
    /// delete from CloudKit, or none when it isn't due. Paused, it waits, so nothing is deleted from
    /// an account the person hasn't chosen.
    public func upkeepIfDue(now: Date = Date()) async throws -> [CKRecord.ID] {
        let isDue = lastUpkeep.map { now.timeIntervalSince($0) >= Self.upkeepEvery } ?? true
        guard paused == nil, isDue else { return [] }

        lastUpkeep = now
        let gone = try await expired()
        try await store.retryHeld()
        return gone
    }

    /// Tombstones past retention, as ids to delete from CloudKit. Every device deletes them, and a
    /// delete of a record already gone changes nothing.
    func expired() async throws -> [CKRecord.ID] {
        let gone = try await store.expire()
        for address in gone {
            serverCopies[address.storeName] = nil
            names[address.storeName] = nil
        }
        return gone.map { CKRecord.ID(recordName: $0.storeName, zoneID: zone) }
    }

    public func stateUpdated(_ state: Data) async throws {
        guard savesState else { return }

        try await store.setEngineState(state)
    }

    public func fetchFinished() async throws {
        guard savesState else { return }

        try await store.fetchFinished()
    }

    /// What an account change puts on the status line. Another Apple ID signing in pauses sync.
    public func accountChanged(_ change: CKSyncEngine.Event.AccountChange.ChangeType) async throws
        -> SyncStatus?
    {
        switch change {
        case .signIn:
            return .syncing
        case .signOut:
            return .noAccount
        case .switchAccounts:
            try await pause(.accountChanged)
            return .accountChanged
        @unknown default:
            return nil
        }
    }

    /// Pauses sync when the deleted zone is this workspace's, and says why. Nil for any other zone.
    public func zoneDeleted(
        _ id: CKRecordZone.ID,
        reason: CKDatabase.DatabaseChange.Deletion.Reason
    ) async throws -> SyncStatus? {
        guard id == zone else { return nil }

        let status: SyncStatus = reason == .encryptedDataReset ? .encryptionReset : .zoneDeleted
        try await pause(status)
        return status
    }

    private func pause(_ status: SyncStatus) async throws {
        paused = status
        if let name = Self.holds.first(where: { $0.value == status })?.key {
            try await store.hold(name)
        }
    }
}
