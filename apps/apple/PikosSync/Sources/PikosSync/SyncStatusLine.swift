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
        case .failed(let message):
            self.init(text: "Couldn't sync: \(message)", action: .none)
        case .syncing:
            self.init(text: "Syncing…", action: .none)
        case .upToDate:
            self.init(text: Self.settled(queue, now: now), action: .none)
        }
    }

    init(text: String, action: SyncAction) {
        self.text = text
        self.action = action
    }

    private static func settled(_ queue: Queue, now: Date) -> String {
        var parts: [String] = []
        if queue.toSend > 0 {
            parts.append(queue.toSend == 1 ? "1 change waiting to send" : "\(queue.toSend) changes waiting to send")
        } else {
            parts.append("Up to date")
        }
        if queue.needsUpdate {
            parts.append("some changes need a newer Pikos")
        }
        if let lastFetch = queue.lastFetch {
            let ago = RelativeDateTimeFormatter().localizedString(for: lastFetch, relativeTo: now)
            parts.append("checked \(ago)")
        }
        return parts.joined(separator: " · ")
    }
}
