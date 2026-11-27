import CloudKit

/// A sync failure in the terms the log and the status line need. Pikos has no telemetry, so the
/// device's log line is the only account of how a sync failed: which phase, which CloudKit code,
/// when CloudKit asked to be tried again, what lay under it, and which records it named.
public enum SyncFailure {
    /// One log line for a failure in `phase`, such as "fetch" or "send". Names records by their
    /// CloudKit name and nothing else, so it carries no page content.
    public static func logLine(_ phase: String, _ error: Error) -> String {
        guard let error = error as? CKError else {
            let ns = error as NSError
            return "\(phase) failed: \(ns.domain) \(ns.code): \(error.localizedDescription)"
        }

        var parts = ["\(phase) failed: \(name(error.code))"]
        if let after = error.retryAfterSeconds {
            parts.append("retry after \(after)s")
        }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            parts.append("under \(underlying.domain) \(underlying.code)")
        }
        if let partial = error.partialErrorsByItemID, !partial.isEmpty {
            let items = partial.map { item, failure in "\(itemName(item)) \(codeName(failure))" }.sorted()
            let shown = items.prefix(partialLimit).joined(separator: ", ")
            let more = items.count > partialLimit ? " and \(items.count - partialLimit) more" : ""
            parts.append("\(partial.count) items: \(shown)\(more)")
        }
        parts.append(error.localizedDescription)

        return parts.joined(separator: " · ")
    }

    /// A long partial failure is one cause repeated; the first few name it.
    static let partialLimit = 20

    /// What the status line says about a failure. Account and storage problems have lines of their
    /// own that say what to do; a busy iCloud says sync tries again by itself.
    public static func status(for error: Error) -> SyncStatus {
        guard let error = error as? CKError else { return .failed(error.localizedDescription) }

        let (code, retryAfter) = topCause(error)
        switch code {
        case .notAuthenticated, .accountTemporarilyUnavailable, .managedAccountRestricted:
            return .noAccount
        case .quotaExceeded:
            return .storageFull
        case .requestRateLimited, .zoneBusy, .serviceUnavailable:
            return .retrying(after: retryAfter)
        default:
            return .failed(error.localizedDescription)
        }
    }

    /// The code that decides the status: a partial failure's most common item code, leaving out
    /// items held back only because another in the batch failed.
    static func topCause(_ error: CKError) -> (CKError.Code, TimeInterval?) {
        guard error.code == .partialFailure, let partial = error.partialErrorsByItemID else {
            return (error.code, error.retryAfterSeconds)
        }

        let causes = partial.values.compactMap { $0 as? CKError }.filter { $0.code != .batchRequestFailed }
        let counts = Dictionary(grouping: causes, by: \.code)
        guard let top = counts.max(by: { ($0.value.count, $1.key.rawValue) < ($1.value.count, $0.key.rawValue) })
        else { return (error.code, error.retryAfterSeconds) }

        let retryAfter = top.value.compactMap(\.retryAfterSeconds).max() ?? error.retryAfterSeconds
        return (top.key, retryAfter)
    }

    /// Whether sending again unchanged can succeed.
    public static func isTransient(_ code: CKError.Code) -> Bool {
        SyncCoordinator.transientFailures.contains(code)
    }

    private static func itemName(_ item: AnyHashable) -> String {
        switch item.base {
        case let id as CKRecord.ID: id.recordName
        case let id as CKRecordZone.ID: "zone \(id.zoneName)"
        default: "item"
        }
    }

    private static func codeName(_ error: Error) -> String {
        guard let error = error as? CKError else {
            let ns = error as NSError
            return "\(ns.domain) \(ns.code)"
        }
        return name(error.code)
    }

    /// CloudKit's name for a code, as its documentation spells it, rather than the bare number
    /// `CKError.Code` prints as. By number, so a code an older SDK lacks still compiles.
    public static func name(_ code: CKError.Code) -> String {
        names[code.rawValue] ?? "code \(code.rawValue)"
    }

    private static let names: [Int: String] = [
        1: "internalError", 2: "partialFailure", 3: "networkUnavailable", 4: "networkFailure",
        5: "badContainer", 6: "serviceUnavailable", 7: "requestRateLimited", 8: "missingEntitlement",
        9: "notAuthenticated", 10: "permissionFailure", 11: "unknownItem", 12: "invalidArguments",
        13: "resultsTruncated", 14: "serverRecordChanged", 15: "serverRejectedRequest",
        16: "assetFileNotFound", 17: "assetFileModified", 18: "incompatibleVersion",
        19: "constraintViolation", 20: "operationCancelled", 21: "changeTokenExpired",
        22: "batchRequestFailed", 23: "zoneBusy", 24: "badDatabase", 25: "quotaExceeded",
        26: "zoneNotFound", 27: "limitExceeded", 28: "userDeletedZone", 29: "tooManyParticipants",
        30: "alreadyShared", 31: "referenceViolation", 32: "managedAccountRestricted",
        33: "participantMayNeedVerification", 34: "serverResponseLost", 35: "assetNotAvailable",
        36: "accountTemporarilyUnavailable", 37: "participantAlreadyInvited",
    ]
}
