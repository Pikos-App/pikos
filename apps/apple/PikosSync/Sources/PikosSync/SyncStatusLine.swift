import Foundation

/// What the person needs to do about sync's state, if anything.
public enum SyncAction: Equatable, Sendable {
    case none
    /// Join the iCloud account now signed in, merging this device's pages into it.
    case useThisAccount
    /// Send this device's pages to iCloud again, after its copy there was deleted or became unreadable.
    case uploadAgain
}

/// The line Settings shows under the sync switch, and the action it offers.
public struct SyncStatusLine: Equatable, Sendable {
    public var text: String
    public var action: SyncAction

    /// What waits on this device, read from the workspace when the status changes.
    public struct Queue: Equatable, Sendable {
        public var toSend: Int
        public var needsUpdate: Bool
        public var lastFetch: Date?

        public init(toSend: Int, needsUpdate: Bool, lastFetch: Date?) {
            self.toSend = toSend
            self.needsUpdate = needsUpdate
            self.lastFetch = lastFetch
        }
    }

    public init(status: SyncStatus?, queue: Queue, now: Date = Date()) {
        guard let status else {
            self.init(text: "Off", action: .none)
            return
        }

        switch status {
        case .noAccount:
            self.init(text: "Sign in to iCloud in the Settings app to sync.", action: .none)
        case .accountChanged:
            self.init(
                text: "This device is signed in to a different iCloud account, so sync is paused.",
                action: .useThisAccount)
        case .zoneDeleted:
            self.init(
                text: "Pikos's data was deleted from iCloud, so sync is paused.",
                action: .uploadAgain)
        case .encryptionReset:
            self.init(
                text: "iCloud can no longer read what this device sent, so sync is paused.",
                action: .uploadAgain)
        case .storageFull:
            self.init(
                text: "Your iCloud storage is full, so sync is paused. Changes send once there's room.",
                action: .none)
        case .failed(let message):
            self.init(text: "Couldn't sync: \(message)", action: .none)
        case .syncing:
            self.init(text: Self.withReassurance(Self.syncing(queue), queue), action: .none)
        case .upToDate:
            self.init(text: Self.withReassurance(Self.settled(queue, unsent: 0, now: now), queue), action: .none)
        case .unsent(let count):
            self.init(text: Self.withReassurance(Self.settled(queue, unsent: count, now: now), queue), action: .none)
        }
    }

    init(text: String, action: SyncAction) {
        self.text = text
        self.action = action
    }

    /// Someone who has just imported thousands of pages watches this line and wonders what they may
    /// do meanwhile. Everything is safe because the queue is kept in the workspace, so a quit or an
    /// update only resumes the send at the next launch.
    static let reassurance =
        "You can keep editing, import more, or quit and update Pikos: what's waiting stays on this device and sends at the next launch."

    private static func withReassurance(_ text: String, _ queue: Queue) -> String {
        let isWaiting = queue.toSend > 0
        return isWaiting ? "\(text). \(reassurance)" : text
    }

    private static func syncing(_ queue: Queue) -> String {
        switch queue.toSend {
        case 0: "Syncing…"
        case 1: "Sending 1 change"
        default: "Sending \(queue.toSend.formatted()) changes"
        }
    }

    private static func settled(_ queue: Queue, unsent: Int, now: Date) -> String {
        var parts: [String] = []
        if queue.toSend > 0 {
            parts.append(queue.toSend == 1 ? "1 change waiting to send" : "\(queue.toSend.formatted()) changes waiting to send")
        } else {
            parts.append("Up to date")
        }
        if unsent > 0 {
            parts.append("\(unsent) couldn't be sent")
        }
        if queue.needsUpdate {
            parts.append("some changes need a newer Pikos")
        }
        if let lastFetch = queue.lastFetch {
            parts.append("checked \(Self.ago(lastFetch, now: now))")
        }

        return parts.joined(separator: " · ")
    }

    /// A fetch stamped a moment after `now` read as "in 0 seconds", and seconds are noise in a line
    /// that's only redrawn when the status changes.
    private static let justNow: TimeInterval = 60

    private static func ago(_ date: Date, now: Date) -> String {
        let isRecent = now.timeIntervalSince(date) < justNow
        if isRecent { return "just now" }

        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: now)
    }
}
