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
    case failed(String)
}

/// The CloudKit transport, over Apple's sync engine. It owns scheduling, batching, retries, change
/// tokens and push; the workspace's engine owns every record and every merge.
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

    /// Call after any local write, the app's own or one another process made: queues what's waiting
    /// to send, and Apple's engine sends it when it next can.
    public func localChangesHappened() async {
        guard let engine else { return }
        do {
            let ids = try await coordinator.pending()
            engine.state.add(pendingRecordZoneChanges: ids.map { .saveRecord($0) })
        } catch {
            Self.log.error("queueing changes failed: \(error.localizedDescription)")
        }
    }

    /// Deletes tombstones past retention from CloudKit and from the workspace. Run now and then,
    /// such as on launch.
    public func expireTombstones() async {
        guard let engine else { return }
        do {
            let ids = try await coordinator.expired()
            engine.state.add(pendingRecordZoneChanges: ids.map { .deleteRecord($0) })
        } catch {
            Self.log.error("expiring tombstones failed: \(error.localizedDescription)")
        }
    }

    /// Fetches now rather than waiting for a push: on launch, on foreground and focus, and every few
    /// minutes while focused, since push to an app outside the App Store is unproven.
    public func fetchNow() async {
        do {
            try await engine?.fetchChanges()
        } catch {
            onStatus(.failed(error.localizedDescription))
        }
    }

    public func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
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
                handleZoneDeletions(changes.deletions)
            case .accountChange(let change):
                handleAccountChange(change)
            case .willFetchChanges, .willSendChanges:
                onStatus(.syncing)
            case .didFetchChanges, .didSendChanges:
                onStatus(.upToDate)
            default:
                break
            }
        } catch {
            Self.log.error("sync event failed: \(error.localizedDescription)")
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
                Self.log.error("building \(id.recordName) failed: \(error.localizedDescription)")
                return nil
            }
        }
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
            case .zoneNotFound, .userDeletedZone:
                engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: id.zoneID))])
                await coordinator.forgetServerCopy(id)
                again.append(id)
            case .unknownItem:
                await coordinator.forgetServerCopy(id)
                again.append(id)
            default:
                await coordinator.failed(id)
                again.append(id)
            }
        }
        if !again.isEmpty {
            engine.state.add(pendingRecordZoneChanges: again.map { .saveRecord($0) })
        }
    }

    private func handleZoneDeletions(
        _ deletions: [CKDatabase.DatabaseChange.Deletion]
    ) {
        for deletion in deletions where deletion.zoneID == coordinator.zone {
            switch deletion.reason {
            case .encryptedDataReset:
                onStatus(.encryptionReset)
            default:
                onStatus(.zoneDeleted)
            }
        }
    }

    private func handleAccountChange(_ change: CKSyncEngine.Event.AccountChange) {
        switch change.changeType {
        case .signIn:
            onStatus(.syncing)
        case .signOut:
            onStatus(.noAccount)
        case .switchAccounts:
            onStatus(.accountChanged)
        @unknown default:
            break
        }
    }
}
