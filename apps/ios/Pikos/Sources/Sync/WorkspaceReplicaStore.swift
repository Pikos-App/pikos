import Foundation
import PikosCore
import PikosSupport
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

    /// Names the call and carries the workspace's message: the sync package reads only
    /// `localizedDescription`, which for `WorkspaceError` is its Swift spelling.
    struct Failure: LocalizedError {
        let op: String
        let kind: String
        let message: String
        var errorDescription: String? { "\(message) (\(op))" }
    }

    static func readable(_ error: Error, op: String) -> Error {
        guard error is WorkspaceError else { return error }

        return Failure(op: op, kind: FailureText.kind(error), message: FailureText.message(error))
    }

    private func call<T>(_ op: String, _ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch {
            throw Self.readable(error, op: op)
        }
    }

    func pendingRecords(limit: Int) async throws -> [PikosSync.RecordAddress] {
        try await call("pendingRecords") { try await workspace.pendingRecords(limit: UInt32(limit)) }
            .map(Self.address)
    }

    func buildRecords(names: [String]) async throws -> [OutgoingRecord] {
        try await call("buildRecords") { try await workspace.buildRecords(names: names) }.map { built in
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
        try await call("recordsSent") {
            try await workspace.recordsSent(sent: sent.map { SentRecord(name: $0.name, builtAt: $0.builtAt) })
        }
    }

    func applyRecords(_ records: [PikosSync.SyncRecord]) async throws {
        _ = try await call("applyRecords") {
            try await workspace.applyRecords(
                records: records.map {
                    PikosCore.SyncRecord(name: $0.name, fields: $0.fields.mapValues(Self.incoming))
                })
        }
        await onApplied()
    }

    func engineState() async throws -> Data? {
        try await call("engineState") { try await workspace.engineState() }
    }

    func setEngineState(_ state: Data) async throws {
        try await call("setEngineState") { try await workspace.setEngineState(state: state) }
    }

    func heldFor() async throws -> String? {
        try await call("heldFor") { try await workspace.syncHeldFor() }
    }

    func hold(_ reason: String) async throws {
        try await call("hold") { try await workspace.holdSync(reason: reason) }
    }

    func fetchFinished() async throws {
        try await call("fetchFinished") { try await workspace.fetchFinished() }
    }

    func expire() async throws -> [PikosSync.RecordAddress] {
        try await call("expire") { try await workspace.expireSync() }.map(Self.address)
    }

    func retryHeld() async throws -> [PikosSync.RecordAddress] {
        let applied = try await call("retryHeld") { try await workspace.retryHeldRecords() }
        if applied.changed > 0 {
            await onApplied()
        }

        return applied.refetch.map(Self.address)
    }

    func saveSystemFields(_ fields: [(name: String, data: Data)]) async throws {
        try await call("saveSystemFields") {
            try await workspace.saveSystemFields(
                records: fields.map { SystemFields(name: $0.name, data: $0.data) })
        }
    }

    func join(zones: [String]) async throws -> String {
        try await call("join") { try await workspace.joinSync(zones: zones) }
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
