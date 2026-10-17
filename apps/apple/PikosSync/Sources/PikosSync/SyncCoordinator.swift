import CloudKit

/// What the CloudKit transport does with each thing Apple's sync engine hands it, kept apart from
/// the engine so it runs in tests without an iCloud account.
public actor SyncCoordinator {
    private let store: ReplicaStore
    public nonisolated let zone: CKRecordZone.ID

    /// Each pending record's name, by the name CloudKit stores it under.
    private var names: [String: String] = [:]
    /// Records built and not yet confirmed, by store name.
    private var inFlight: [String: OutgoingRecord] = [:]
    /// The server's last copy of each record this device saved or was refused over. Building on it
    /// keeps the server's change tag, so the next save isn't refused as stale.
    private var serverCopies: [String: CKRecord] = [:]

    public init(store: ReplicaStore, zone: CKRecordZone.ID) {
        self.store = store
        self.zone = zone
    }

    /// The records waiting to send, as CloudKit ids for the engine's pending list.
    public func pending(limit: Int = 1_000) async throws -> [CKRecord.ID] {
        let addresses = try await store.pendingRecords(limit: limit)
        for address in addresses {
            names[address.storeName] = address.name
        }
        return addresses.map { CKRecord.ID(recordName: $0.storeName, zoneID: zone) }
    }

    /// The record to send for a pending id, built now from the live row, or nil when it no longer
    /// needs sending.
    public func record(for id: CKRecord.ID) async throws -> CKRecord? {
        guard let name = names[id.recordName],
            let outgoing = try await store.buildRecords(names: [name]).first
        else { return nil }
        inFlight[outgoing.storeName] = outgoing
        if let copy = serverCopies[outgoing.storeName] {
            RecordCodec.fill(copy, with: outgoing.record)
            return copy
        }
        return RecordCodec.encode(outgoing, zone: zone)
    }

    /// CloudKit stored these. Returns the ids edited here since they were built, to queue again.
    public func saved(_ records: [CKRecord]) async throws -> [CKRecord.ID] {
        var sent: [(name: String, builtAt: String)] = []
        for record in records {
            let storeName = record.recordID.recordName
            serverCopies[storeName] = record
            if let outgoing = inFlight.removeValue(forKey: storeName) {
                sent.append((outgoing.record.name, outgoing.builtAt))
            }
        }
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

    /// A save that failed for a reason worth trying again later: the record stays pending.
    public func failed(_ id: CKRecord.ID) {
        inFlight[id.recordName] = nil
    }

    /// The server no longer has a record this device built on: the next send starts fresh.
    public func forgetServerCopy(_ id: CKRecord.ID) {
        serverCopies[id.recordName] = nil
        inFlight[id.recordName] = nil
    }

    public func fetched(_ records: [CKRecord]) async throws {
        var decoded: [SyncRecord] = []
        for record in records {
            serverCopies[record.recordID.recordName] = record
            if let sync = RecordCodec.decode(record) {
                names[record.recordID.recordName] = sync.name
                decoded.append(sync)
            }
        }
        if !decoded.isEmpty {
            try await store.applyRecords(decoded)
        }
    }

    /// Tombstones past retention, as ids to delete from CloudKit. Every device deletes them, and a
    /// delete of a record already gone changes nothing.
    public func expired() async throws -> [CKRecord.ID] {
        let gone = try await store.expire()
        for address in gone {
            serverCopies[address.storeName] = nil
            names[address.storeName] = nil
        }
        return gone.map { CKRecord.ID(recordName: $0.storeName, zoneID: zone) }
    }

    public func stateUpdated(_ state: Data) async throws {
        try await store.setEngineState(state)
    }
}
