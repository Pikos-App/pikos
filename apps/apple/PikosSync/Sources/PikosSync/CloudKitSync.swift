import CloudKit
import os

/// What the person sees on the one status line.
public enum SyncStatus: Equatable, Sendable {
    case syncing
    case upToDate
    /// No iCloud account, or iCloud Drive turned off.
    case noAccount
    /// Signed in to a different Apple ID than before: the person confirms before a fresh join.
    case accountChanged
    /// The person deleted the workspace's data from iCloud settings: they choose whether to upload
    /// again or forget sync on this device, since re-uploading on its own would undo the deletion.
    case zoneDeleted
    /// The iCloud Keychain was reset, so the encrypted fields can't be read: the zone is deleted and
    /// everything uploaded again from this device.
    case encryptionReset
    /// The account's iCloud storage is full: changes wait on this device until there's room.
    case storageFull
    /// Settled, except for this many records iCloud refused or this device couldn't build.
    case unsent(Int)
    case failed(String)
}

/// The CloudKit transport, over Apple's sync engine. It owns batching, retries, change tokens and
/// push; the workspace's engine owns every record and every merge.
@available(iOS 17.0, macOS 14.0, *)
public final class CloudKitSync: CKSyncEngineDelegate, @unchecked Sendable {
    private let coordinator: SyncCoordinator
    private let store: ReplicaStore
    private let database: CKDatabase
    private let onStatus: @Sendable (SyncStatus) -> Void
    private var engine: CKSyncEngine?
    private static let log = Logger(subsystem: "app.pikos", category: "sync")

    public init(
        store: ReplicaStore,
        container: CKContainer,
        zoneName: String,
        onStatus: @escaping @Sendable (SyncStatus) -> Void
    ) {
        self.store = store
        self.database = container.privateCloudDatabase
        self.coordinator = SyncCoordinator(
            store: store,
            zone: CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
        )
        self.onStatus = onStatus
    }

    /// The zone to start in, settled before the engine is made: two devices that turned sync on
    /// before either saw the other each made a zone, and the one whose zone lost moves into the
    /// other's and deletes its own.
    public static func join(store: ReplicaStore, container: CKContainer, ownZone: String)
        async throws -> String
    {
        let database = container.privateCloudDatabase
        let zones = try await accountZones(store: store) {
            try await database.allRecordZones().map(\.zoneID.zoneName)
        }
        let zone = try await store.join(zones: zones)
        log.info("account zones \(zones, privacy: .public), syncing in \(zone, privacy: .public)")

        let ownZoneLost = zone != ownZone && zones.contains(ownZone)
        if ownZoneLost {
            let id = CKRecordZone.ID(zoneName: ownZone, ownerName: CKCurrentUserDefaultName)
            _ = try await database.modifyRecordZones(saving: [], deleting: [id])
            log.info("moved from \(ownZone, privacy: .public) into \(zone, privacy: .public)")
        }

        return zone
    }

    /// Why sync waits on the person, kept from an earlier launch, or nil. Checked before `join`,
    /// which would otherwise list and settle zones in an account the person hasn't chosen.
    public static func held(store: ReplicaStore) async throws -> SyncStatus? {
        try await store.heldFor().flatMap { SyncCoordinator.holds[$0] }
    }

    private static let unreachable: Set<CKError.Code> = [
        .networkUnavailable, .networkFailure, .serviceUnavailable, .requestRateLimited,
    ]

    /// The account's zones, or none when iCloud can't be reached and this device has synced before:
    /// joining with none keeps the zone it already has, so sync starts offline and Apple's engine
    /// sends and fetches once the network is back. A device that has never synced has no zone to
    /// keep, so it still fails. Zones made elsewhere meanwhile are settled at the next launch.
    static func accountZones(
        store: ReplicaStore,
        list: () async throws -> [String]
    ) async throws -> [String] {
        do {
            return try await list()
        } catch let error as CKError where unreachable.contains(error.code) {
            guard try await store.engineState() != nil else { throw error }

            log.info("iCloud unreachable, starting in the zone already joined")
            return []
        }
    }

    public func start() async throws {
        let saved = try await store.engineState()
        let state = saved.flatMap {
            try? JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: $0)
        }
        let configuration = CKSyncEngine.Configuration(
            database: database,
            stateSerialization: state,
            delegate: self
        )
        let engine = CKSyncEngine(configuration)
        self.engine = engine
        engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: coordinator.zone))])
        await localChangesHappened()
    }

    /// Stops sending and fetching until `start` runs again.
    public func stop() async {
        await engine?.cancelOperations()
        engine = nil
    }

    /// Call after any local write, the app's own or one another process made: queues what's waiting
    /// to send and sends it now. Left to Apple's engine, a send waits on the system's schedule, which
    /// can hold a phone's edits for a day. A send that fails stays queued for the engine's own retry.
    public func localChangesHappened() async {
        guard let engine, let ids = await queuePending(retryingFull: false) else { return }
        guard await coordinator.hasNewChanges(ids) else { return }

        do {
            try await engine.sendChanges()
        } catch {
            await coordinator.sendFailed(ids)
            Self.log.error("sending changes failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Hands what's waiting to the engine without asking it to send. Inside one of the engine's own
    /// callbacks this is all that's safe: `sendChanges` there traps in CloudKit and takes the app down.
    @discardableResult
    private func queuePending(retryingFull: Bool) async -> [CKRecord.ID]? {
        guard let engine else { return nil }

        do {
            let ids = try await coordinator.pending(retryingFull: retryingFull)
            engine.state.add(pendingRecordZoneChanges: ids.map { .saveRecord($0) })
            return ids
        } catch {
            Self.log.error("queueing changes failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Fetches now rather than waiting for a push: on launch, on foreground and focus, and every few
    /// minutes while focused, since push to an app outside the App Store is unproven. Runs the
    /// daily upkeep first when it's due, and tries a full iCloud again.
    public func fetchNow() async {
        guard await coordinator.paused == nil else { return }

        await upkeep()
        await queuePending(retryingFull: true)
        do {
            try await engine?.fetchChanges()
        } catch {
            onStatus(.failed(error.localizedDescription))
        }
    }

    public func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
        Self.log.info("event: \(String(describing: event), privacy: .public)")
        defer { Self.log.info("event handled") }
        guard await coordinator.paused == nil else { return }

        do {
            switch event {
            case .stateUpdate(let update):
                // Delivered after the fetched changes it records, so they're already applied.
                let data = try JSONEncoder().encode(update.stateSerialization)
                try await coordinator.stateUpdated(data)
            case .fetchedRecordZoneChanges(let changes):
                try await coordinator.fetched(changes.modifications.map(\.record))
            case .sentRecordZoneChanges(let sent):
                try await handleSent(sent, engine: syncEngine)
            case .fetchedDatabaseChanges(let changes):
                for deletion in changes.deletions {
                    if let status = try await coordinator.zoneDeleted(deletion.zoneID, reason: deletion.reason) {
                        onStatus(status)
                    }
                }
            case .accountChange(let change):
                if let status = try await coordinator.accountChanged(change.changeType) {
                    onStatus(status)
                }
            case .willFetchChanges, .willSendChanges:
                onStatus(.syncing)
            case .didFetchChanges:
                try await coordinator.fetchFinished()
                onStatus(await coordinator.settled)
            case .didSendChanges:
                onStatus(await coordinator.settled)
            default:
                break
            }
        } catch {
            Self.log.error("sync event failed: \(error.localizedDescription, privacy: .public)")
            onStatus(.failed(error.localizedDescription))
        }
    }

    public func nextRecordZoneChangeBatch(
        _ context: CKSyncEngine.SendChangesContext,
        syncEngine: CKSyncEngine
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        let pending = syncEngine.state.pendingRecordZoneChanges.filter {
            context.options.scope.contains($0)
        }
        guard !pending.isEmpty else { return nil }
        let coordinator = self.coordinator
        return await CKSyncEngine.RecordZoneChangeBatch(pendingChanges: pending) { id in
            do {
                return try await coordinator.record(for: id)
            } catch {
                Self.log.error("building \(id.recordName) failed: \(error.localizedDescription, privacy: .public)")
                return nil
            }
        }
    }

    private func upkeep() async {
        guard let engine else { return }

        do {
            let upkeep = try await coordinator.upkeepIfDue()
            engine.state.add(pendingRecordZoneChanges: upkeep.expired.map { .deleteRecord($0) })
            if !upkeep.refetch.isEmpty {
                try await refetch(upkeep.refetch)
            }
        } catch {
            Self.log.error("sync upkeep failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Apple's engine hands back a record only when it changes, and an image never does, so a held
    /// one is asked for by id. One that doesn't come stays held until the next upkeep.
    private func refetch(_ ids: [CKRecord.ID]) async throws {
        let results = try await database.records(for: ids)
        let records = results.values.compactMap { try? $0.get() }
        Self.log.info("fetched \(records.count) of \(ids.count) held images again")
        try await coordinator.fetched(records)
    }

    private func handleSent(
        _ sent: CKSyncEngine.Event.SentRecordZoneChanges,
        engine: CKSyncEngine
    ) async throws {
        var again = try await coordinator.saved(sent.savedRecords)
        for failure in sent.failedRecordSaves {
            let id = failure.record.recordID
            switch failure.error.code {
            case .serverRecordChanged:
                if let server = failure.error.serverRecord {
                    again.append(try await coordinator.refused(over: server))
                }
            case .userDeletedZone:
                if let status = try await coordinator.zoneDeleted(id.zoneID, reason: .purged) {
                    onStatus(status)
                }
            case .zoneNotFound:
                engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: id.zoneID))])
                await coordinator.forgetServerCopy(id)
                again.append(id)
            case .unknownItem:
                await coordinator.forgetServerCopy(id)
                again.append(id)
            default:
                if await coordinator.failed(id, code: failure.error.code) {
                    again.append(id)
                }
            }
        }
        if !again.isEmpty {
            engine.state.add(pendingRecordZoneChanges: again.map { .saveRecord($0) })
        }
        // Building a page's body queues the images it shows, which no local write announces.
        await queuePending(retryingFull: false)
    }
}
