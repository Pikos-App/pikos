#if os(macOS)
    import Foundation
    import PikosReplicaC
    import PikosSync

    /// The workspace as the Mac app's Rust serves it, one JSON call per operation.
    struct RustReplicaStore: ReplicaStore {
        struct Failure: LocalizedError {
            let message: String
            var errorDescription: String? { message }
        }

        func pendingRecords(limit: Int) async throws -> [RecordAddress] {
            let addresses: [WireAddress] = try call("pending", ["limit": limit])
            return addresses.map(\.address)
        }

        func buildRecords(names: [String]) async throws -> [OutgoingRecord] {
            let built: [WireBuilt] = try call("build", ["names": names])
            return built.map {
                OutgoingRecord(
                    record: $0.record.syncRecord,
                    storeName: $0.storeName,
                    builtAt: $0.builtAt,
                    systemFields: $0.systemFields.map { Data($0) })
            }
        }

        func recordsSent(_ sent: [(name: String, builtAt: String)]) async throws -> [String] {
            try call("sent", ["sent": sent.map { WireSent(name: $0.name, builtAt: $0.builtAt) }])
        }

        func applyRecords(_ records: [SyncRecord]) async throws {
            let _: WireApplied = try call("apply", ["records": records.map(WireRecord.init)])
        }

        func engineState() async throws -> Data? {
            let state: [UInt8]? = try call("engine_state", [String: Int]())
            return state.map { Data($0) }
        }

        func setEngineState(_ state: Data) async throws {
            let _: Empty? = try call("set_engine_state", ["state": [UInt8](state)])
        }

        func expire() async throws -> [RecordAddress] {
            let addresses: [WireAddress] = try call("expire", [String: Int]())
            return addresses.map(\.address)
        }

        func saveSystemFields(_ fields: [(name: String, data: Data)]) async throws {
            let records = fields.map { WireNamedData(name: $0.name, data: [UInt8]($0.data)) }
            let _: Empty? = try call("save_system_fields", ["records": records])
        }

        func join(zones: [String]) async throws -> String {
            try call("join", ["zones": zones])
        }

        /// What waits on this device, for the status line.
        func summary() async throws -> (pending: Int, needsUpdate: Bool, lastFetch: Date?) {
            let summary: WireSummary = try call("summary", [String: Int]())
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return (
                summary.pending, summary.needsUpdate,
                summary.lastFetchAt.flatMap(formatter.date(from:))
            )
        }

        /// Hands the line Settings shows to the app.
        func report(_ line: SyncStatusLine) async throws {
            let action =
                switch line.action {
                case .none: "none"
                case .useThisAccount: "useThisAccount"
                case .uploadAgain: "uploadAgain"
                }
            let _: Empty? = try call("status", ["text": line.text, "action": action])
        }

        private func call<Input: Encodable, Output: Decodable>(_ op: String, _ input: Input) throws
            -> Output
        {
            let body = try JSONEncoder().encode(input)
            var length = 0
            let pointer = body.withUnsafeBytes { bytes in
                pikos_replica_call(
                    op, bytes.bindMemory(to: UInt8.self).baseAddress, body.count, &length)
            }
            guard let pointer else { throw Failure(message: "\(op) returned nothing") }
            defer { pikos_replica_free(pointer, length) }

            let reply = try JSONDecoder().decode(
                Reply<Output>.self, from: Data(bytes: pointer, count: length))
            if let message = reply.err { throw Failure(message: message) }
            guard let ok = reply.ok else {
                return try JSONDecoder().decode(Output.self, from: Data("null".utf8))
            }
            return ok
        }
    }

    private struct Empty: Codable {}

    private struct Reply<Value: Decodable>: Decodable {
        let ok: Value?
        let err: String?
    }

    private struct WireAddress: Decodable {
        let name: String
        let storeName: String

        enum CodingKeys: String, CodingKey {
            case name
            case storeName = "store_name"
        }

        var address: RecordAddress { RecordAddress(name: name, storeName: storeName) }
    }

    /// A field's value tagged by type, matching the Rust side's `Wire`.
    private enum WireValue: Codable {
        case integer(Int64)
        case real(Double)
        case text(String)

        enum CodingKeys: String, CodingKey {
            case i, r, t
        }

        init(_ value: SyncFieldValue) {
            switch value {
            case .integer(let v): self = .integer(v)
            case .real(let v): self = .real(v)
            case .text(let v): self = .text(v)
            }
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let v = try container.decodeIfPresent(Int64.self, forKey: .i) {
                self = .integer(v)
            } else if let v = try container.decodeIfPresent(Double.self, forKey: .r) {
                self = .real(v)
            } else {
                self = .text(try container.decode(String.self, forKey: .t))
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .integer(let v): try container.encode(v, forKey: .i)
            case .real(let v): try container.encode(v, forKey: .r)
            case .text(let v): try container.encode(v, forKey: .t)
            }
        }

        var value: SyncFieldValue {
            switch self {
            case .integer(let v): .integer(v)
            case .real(let v): .real(v)
            case .text(let v): .text(v)
            }
        }
    }

    private struct WireRecord: Codable {
        let name: String
        let fields: [String: WireValue]

        init(_ record: SyncRecord) {
            name = record.name
            fields = record.fields.mapValues(WireValue.init)
        }

        var syncRecord: SyncRecord {
            SyncRecord(name: name, fields: fields.mapValues(\.value))
        }
    }

    private struct WireBuilt: Decodable {
        let record: WireRecord
        let storeName: String
        let builtAt: String
        let systemFields: [UInt8]?

        enum CodingKeys: String, CodingKey {
            case record
            case storeName = "store_name"
            case builtAt = "built_at"
            case systemFields = "system_fields"
        }
    }

    private struct WireSent: Encodable {
        let name: String
        let builtAt: String

        enum CodingKeys: String, CodingKey {
            case name
            case builtAt = "built_at"
        }
    }

    private struct WireNamedData: Encodable {
        let name: String
        let data: [UInt8]
    }

    private struct WireSummary: Decodable {
        let pending: Int
        let needsUpdate: Bool
        let lastFetchAt: String?

        enum CodingKeys: String, CodingKey {
            case pending
            case needsUpdate = "needs_update"
            case lastFetchAt = "last_fetch_at"
        }
    }

    private struct WireApplied: Decodable {
        let changed: Int
        let held: Int
    }
#endif
