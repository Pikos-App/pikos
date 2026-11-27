import Foundation
import OSLog

/// What a tester pastes into a message when sync misbehaves: the device's sync state and this
/// launch's sync log, with nothing a page holds. Record names carry tag names and dates, so each
/// is cut to its kind, and a sync engine event is cut to its kind because its description can
/// print the records it carries.
public enum SyncReport {
    /// The log's tail, where the failure being reported is; a long launch logs thousands of lines.
    static let logLimit = 300

    private static let recordName = try! NSRegularExpression(
        pattern: #"\b(?:tomb:)?(page|body|folder|tag|pagetag|rule|sched|override|done|skip|remind|focus|asset):[^\s,;'"()\[\]{}<>]+"#)

    private static let eventPrefix = "event: "

    /// `state` is one line each for what the device knows about its sync; `log` is the log lines
    /// as read, oldest first.
    public static func text(state: [String], log: [String]) -> String {
        let lines = state + ["", "Sync log:"] + log.suffix(logLimit)

        return lines.map(scrub).joined(separator: "\n")
    }

    static func scrub(_ line: String) -> String {
        if let event = line.range(of: eventPrefix) {
            let kind = line[event.upperBound...].prefix { $0.isLetter }
            return String(line[..<event.upperBound]) + kind
        }

        let whole = NSRange(line.startIndex..., in: line)
        return recordName.stringByReplacingMatches(in: line, range: whole, withTemplate: "$1:…")
    }

    /// This launch's sync log lines, read from the app's own log, since a tester's device has no
    /// debugger attached.
    public static func readLog() -> [String] {
        let entries: AnySequence<OSLogEntry>
        do {
            entries = try OSLogStore(scope: .currentProcessIdentifier).getEntries()
        } catch {
            let ns = error as NSError
            return ["The log couldn't be read: \(ns.domain) \(ns.code), \(error.localizedDescription)"]
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        var lines: [String] = []
        for case let entry as OSLogEntryLog in entries where entry.subsystem == "app.pikos" {
            lines.append("\(formatter.string(from: entry.date)) \(entry.composedMessage)")
        }

        return lines
    }
}
