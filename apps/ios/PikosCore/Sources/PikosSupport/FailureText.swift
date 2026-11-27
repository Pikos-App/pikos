import Foundation
import PikosCore

extension WorkspaceError {
    /// What the person reads: the message the workspace carried. The generated `errorDescription`
    /// prints the Swift type and case around it, and being declared on the enum it can't be
    /// replaced from here.
    public var userMessage: String {
        switch self {
        case .Open(let message), .Database(let message), .InvalidInput(let message),
            .Refused(let message), .Network(let message), .MadeByAnotherBuild(let message):
            return message
        case .NotFound(let entity, _):
            return String(localized: "That \(entity) no longer exists.")
        case .ReadOnly:
            return String(localized: "This workspace was opened read-only, so nothing can be changed.")
        case .TooNew:
            return String(localized: "This workspace was saved by a newer version of Pikos. Update Pikos to open it.")
        }
    }

    /// The case's name, which says how it failed without anything the message quotes.
    public var kind: String {
        switch self {
        case .Open: "Open"
        case .NotFound: "NotFound"
        case .Database: "Database"
        case .ReadOnly: "ReadOnly"
        case .InvalidInput: "InvalidInput"
        case .Refused: "Refused"
        case .Network: "Network"
        case .MadeByAnotherBuild: "MadeByAnotherBuild"
        case .TooNew: "TooNew"
        }
    }
}

public enum FailureText {
    /// What the person reads for any error: a workspace error's own message, or the system's.
    public static func message(_ error: Error) -> String {
        if let error = error as? WorkspaceError { return error.userMessage }
        return error.localizedDescription
    }

    /// How it failed, for a log line that can be public: the kind without the message.
    public static func kind(_ error: Error) -> String {
        if let error = error as? WorkspaceError { return "WorkspaceError.\(error.kind)" }
        let ns = error as NSError
        return "\(ns.domain) \(ns.code)"
    }
}

/// An alert about something that failed: what was being done, then why.
public struct FailureNotice: Equatable, Sendable {
    public let title: String
    public let message: String

    public init(title: String, message: String) {
        self.title = title
        self.message = message
    }

    /// `doing` completes "Couldn't …", such as "save the page".
    public init(doing: String, error: Error) {
        self.init(title: String(localized: "Couldn't \(doing)"), message: FailureText.message(error))
    }
}
