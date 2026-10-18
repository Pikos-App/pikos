import Foundation
import PikosCore
import PikosSync

/// The sync package's view of the workspace, over its Rust bridge. Both modules name a record
/// `SyncRecord` and an address `RecordAddress`; the workspace's are converted at this seam.
final class WorkspaceReplicaStore: ReplicaStore, @unchecked Sendable {
    private let workspace: Workspace
    private let onApplied: @Sendable () async -> Void

    init(workspace: Workspace, onApplied: @escaping @Sendable () async -> Void) {
        self.workspace = workspace
        self.onApplied = onApplied
    }

    func pendingRecords(limit: Int) async throws -> [PikosSync.RecordAddress] {
        try await workspace.pendingRecords(limit: UInt32(limit)).map(Self.address)
    }

    func buildRecords(names: [String]) async throws -> [OutgoingRecord] {
        try await workspace.buildRecords(names: names).map { built in
            OutgoingRecord(
                record: PikosSync.SyncRecord(
                    name: built.record.name,
                    fields: built.record.fields.mapValues(Self.outgoing)
                ),
                storeName: built.storeName,
                builtAt: built.builtAt,
                systemFields: built.systemFields
            )
        }
    }

    func recordsSent(_ sent: [(name: String, builtAt: String)]) async throws -> [String] {
        try await workspace.recordsSent(
            sent: sent.map { SentRecord(name: $0.name, builtAt: $0.builtAt) })
    }

    func applyRecords(_ records: [PikosSync.SyncRecord]) async throws {
        _ = try await workspace.applyRecords(
            records: records.map {
                PikosCore.SyncRecord(name: $0.name, fields: $0.fields.mapValues(Self.incoming))
            })
        await onApplied()
    }

    func engineState() async throws -> Data? {
        try await workspace.engineState()
    }

    func setEngineState(_ state: Data) async throws {
        try await workspace.setEngineState(state: state)
    }

    func fetchFinished() async throws {
        try await workspace.fetchFinished()
    }

    func expire() async throws -> [PikosSync.RecordAddress] {
        try await workspace.expireSync().map(Self.address)
    }

    func saveSystemFields(_ fields: [(name: String, data: Data)]) async throws {
        try await workspace.saveSystemFields(
            records: fields.map { SystemFields(name: $0.name, data: $0.data) })
    }

    func join(zones: [String]) async throws -> String {
        try await workspace.joinSync(zones: zones)
    }

    private static func address(_ address: PikosCore.RecordAddress) -> PikosSync.RecordAddress {
        PikosSync.RecordAddress(name: address.name, storeName: address.storeName)
    }

    private static func outgoing(_ value: SyncValue) -> SyncFieldValue {
        switch value {
        case .integer(let value): .integer(value)
        case .real(let value): .real(value)
        case .text(let value): .text(value)
        }
    }

    private static func incoming(_ value: SyncFieldValue) -> SyncValue {
        switch value {
        case .integer(let value): .integer(value: value)
        case .real(let value): .real(value: value)
        case .text(let value): .text(value: value)
        }
    }
}
