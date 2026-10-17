import CloudKit

/// Records as CloudKit stores them. Every field goes in the record's encrypted values: content can
/// never move from a plain field to an encrypted one once deployed, and sync only ever fetches by
/// zone, so nothing needs a queryable field.
public enum RecordCodec {
    /// The field holding the record's name in the workspace, since the CloudKit name may be an
    /// escaped or shortened form of it.
    static let nameField = "record"

    /// The record type: the entity prefix of the record's name, such as `page`.
    static func recordType(of name: String) -> String {
        String(name.prefix { $0 != ":" })
    }

    public static func encode(_ outgoing: OutgoingRecord, zone: CKRecordZone.ID) -> CKRecord {
        let id = CKRecord.ID(recordName: outgoing.storeName, zoneID: zone)
        let record = CKRecord(recordType: recordType(of: outgoing.record.name), recordID: id)
        fill(record, with: outgoing.record)
        return record
    }

    /// Writes `source` into `record`, clearing any field `source` no longer has, so a record fetched
    /// from the server keeps its change tag and takes the new values whole.
    public static func fill(_ record: CKRecord, with source: SyncRecord) {
        let values = record.encryptedValues
        for key in values.allKeys() where key != nameField && source.fields[key] == nil {
            values[key] = nil
        }
        values[nameField] = source.name
        for (key, value) in source.fields {
            switch value {
            case .integer(let v): values[key] = v
            case .real(let v): values[key] = v
            case .text(let v): values[key] = v
            }
        }
    }

    /// CloudKit's metadata for a record, change tag included, without its fields.
    public static func systemFields(of record: CKRecord) -> Data {
        let archiver = NSKeyedArchiver(requiringSecureCoding: true)
        record.encodeSystemFields(with: archiver)
        archiver.finishEncoding()
        return archiver.encodedData
    }

    /// A record rebuilt from saved metadata, empty of fields, or nil when the data doesn't read.
    public static func record(fromSystemFields data: Data) -> CKRecord? {
        guard let unarchiver = try? NSKeyedUnarchiver(forReadingFrom: data) else { return nil }
        unarchiver.requiresSecureCoding = true
        defer { unarchiver.finishDecoding() }
        return CKRecord(coder: unarchiver)
    }

    /// The record a fetched CloudKit record carries, or nil for one that isn't a workspace record.
    public static func decode(_ record: CKRecord) -> SyncRecord? {
        let values = record.encryptedValues
        guard let name = values[nameField] as? String else { return nil }
        var fields: [String: SyncFieldValue] = [:]
        for key in values.allKeys() where key != nameField {
            switch values[key] {
            case let v as Int64: fields[key] = .integer(v)
            case let v as Double: fields[key] = .real(v)
            case let v as String: fields[key] = .text(v)
            case let v as NSNumber where CFNumberIsFloatType(v): fields[key] = .real(v.doubleValue)
            case let v as NSNumber: fields[key] = .integer(v.int64Value)
            default: continue
            }
        }
        return SyncRecord(name: name, fields: fields)
    }
}
