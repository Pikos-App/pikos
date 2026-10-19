import Foundation

/// A record field's value, as CloudKit stores one. An absent field is NULL.
public enum SyncFieldValue: Equatable, Sendable {
    case integer(Int64)
    case real(Double)
    case text(String)
}

/// A record as the workspace's engine reads and writes it: its name, such as `page:<id>`, and its
/// fields, already named the way CloudKit allows.
public struct SyncRecord: Equatable, Sendable {
    public var name: String
    public var fields: [String: SyncFieldValue]

    public init(name: String, fields: [String: SyncFieldValue]) {
        self.name = name
        self.fields = fields
    }
}

/// A record's name in the workspace and the name it's stored under in CloudKit, which allows
/// only ASCII and caps the length. The workspace's engine makes the second from the first, and the
/// record carries the first, so the transport never has to reverse it.
public struct RecordAddress: Hashable, Sendable {
    public var name: String
    public var storeName: String

    public init(name: String, storeName: String) {
        self.name = name
        self.storeName = storeName
    }
}

/// A record ready to send, with the clock it was built at, handed back when the send is confirmed.
public struct OutgoingRecord: Equatable, Sendable {
    public var record: SyncRecord
    public var storeName: String
    public var builtAt: String
    /// CloudKit's own metadata for the record as last seen, change tag included, so a save builds on
    /// the server's copy instead of being refused as stale.
    public var systemFields: Data?

    public init(record: SyncRecord, storeName: String, builtAt: String, systemFields: Data? = nil) {
        self.record = record
        self.storeName = storeName
        self.builtAt = builtAt
        self.systemFields = systemFields
    }
}

/// The workspace's sync engine, as the CloudKit transport drives it. Each app backs it with its
/// workspace's Rust bridge; tests back it with a fake.
public protocol ReplicaStore: Sendable {
    /// Records waiting to send, oldest change first.
    func pendingRecords(limit: Int) async throws -> [RecordAddress]
    /// Full records for those names, built from the live rows. A name that no longer needs sending
    /// is left out.
    func buildRecords(names: [String]) async throws -> [OutgoingRecord]
    /// CloudKit stored these. Returns the names edited since they were built, to queue again.
    func recordsSent(_ sent: [(name: String, builtAt: String)]) async throws -> [String]
    /// Merges fetched records in one transaction.
    func applyRecords(_ records: [SyncRecord]) async throws
    /// CloudKit's sync engine state, saved with the workspace.
    func engineState() async throws -> Data?
    /// Saved only after the changes it records have been applied: the engine never hands back
    /// changes once its state has moved past them.
    func setEngineState(_ state: Data) async throws
    /// A fetch finished and everything it brought is applied, whether or not the state moved.
    func fetchFinished() async throws
    /// Why sync waits on the person, saved with the workspace so a relaunch keeps waiting, or nil
    /// while it runs. Forgetting sync on the device clears it.
    func heldFor() async throws -> String?
    func hold(_ reason: String) async throws
    /// Forgets tombstones past retention and returns them, to delete from CloudKit too.
    func expire() async throws -> [RecordAddress]
    /// Applies every held record this build can now read.
    func retryHeld() async throws
    /// Keeps CloudKit's metadata for records it saved or sent, by record name.
    func saveSystemFields(_ fields: [(name: String, data: Data)]) async throws
    /// The zone to sync in, given every zone the account holds. When another device's zone wins,
    /// the workspace moves into it.
    func join(zones: [String]) async throws -> String
}
