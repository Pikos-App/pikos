import Observation
import PikosCore
import SwiftUI

/// Connected calendars, and the operations the phone can perform on them.
///
/// Its own store: a page list fails when the database does, this fails when a server is down,
/// a password rotated or the phone offline, each needing its own sentence. Nothing polls: iOS
/// suspends an in-process timer within seconds, so a sync runs on foreground return, the OS
/// background refresh, or request.
@MainActor
@Observable
public final class CalendarSyncStore {
    public private(set) var accounts: [SyncAccountWithCalendars] = []
    public private(set) var isLoading = true

    /// The last thing that went wrong, and whether retrying is worth it: a network failure is
    /// worth retrying unchanged, a rejected password is not.
    public struct Problem: Identifiable {
        public let id = UUID()
        public let message: String
        public let isRetryable: Bool
    }

    public var problem: Problem?

    /// Which account is mid-operation, so only its row shows a spinner.
    public private(set) var busyAccountID: String?

    private let workspace: @MainActor () -> Workspace?

    /// Takes the workspace as a closure: `WorkspaceStore` opens it asynchronously, so capturing
    /// `nil` once would leave this unable to do anything.
    public init(workspace: @escaping @MainActor () -> Workspace?) {
        self.workspace = workspace
    }

    public func load() async {
        guard let workspace = workspace() else { return }
        isLoading = true
        do {
            accounts = try await workspace.syncStatus()
        } catch {
            record(error)
        }
        isLoading = false
    }

    /// Connect a CalDAV server; returns whether it worked, so the sheet knows whether to close.
    /// Discovery runs before anything is stored, so a wrong URL or password leaves no
    /// half-connected account.
    public func connect(
        baseURL: String, username: String, password: String, displayName: String
    ) async -> Bool {
        guard let workspace = workspace() else { return false }
        busyAccountID = Self.connecting
        defer { busyAccountID = nil }
        do {
            _ = try await workspace.connectCaldav(
                baseUrl: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password,
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines))
            await load()
            return true
        } catch {
            record(error)
            return false
        }
    }

    /// Swap a password that stopped working. Takes the password alone, so a typo can't create a
    /// second account instead of repairing this one.
    public func reconnect(accountID: String, password: String) async -> Bool {
        guard let workspace = workspace() else { return false }
        busyAccountID = accountID
        defer { busyAccountID = nil }
        do {
            _ = try await workspace.reconnectCaldav(accountId: accountID, password: password)
            await load()
            return true
        } catch {
            record(error)
            return false
        }
    }

    public func disconnect(accountID: String) async {
        guard let workspace = workspace() else { return }
        busyAccountID = accountID
        defer { busyAccountID = nil }
        do {
            try await workspace.disconnectSyncAccount(accountId: accountID)
            await load()
        } catch {
            record(error)
        }
    }

    public func setEnabled(calendarID: String, accountID: String, enabled: Bool) async {
        guard let workspace = workspace() else { return }
        busyAccountID = accountID
        defer { busyAccountID = nil }
        do {
            _ = try await workspace.setCalendarEnabled(
                syncCalendarId: calendarID, enabled: enabled)
            await load()
        } catch {
            record(error)
        }
    }

    /// Sync one account now. `full` discards every cursor and re-reads
    /// everything, which is the repair path rather than the everyday one.
    public func sync(accountID: String, full: Bool = false) async {
        guard let workspace = workspace() else { return }
        busyAccountID = accountID
        defer { busyAccountID = nil }
        do {
            let results =
                full
                ? try await workspace.resyncAccountFully(accountId: accountID)
                : try await workspace.syncAccountNow(accountId: accountID)
            await load()
            reportIfAnythingWentWrong(results)
        } catch {
            record(error)
        }
    }

    /// Sync every connected account that can be synced, at the two moments the process is known
    /// to run: foreground return and the OS background refresh. `quiet` because an automatic
    /// failure isn't the user's problem right now. An account flagged for reconnection is
    /// skipped: its password is already rejected.
    public func syncAll(quiet: Bool) async {
        guard let workspace = workspace() else { return }
        let accounts: [SyncAccountWithCalendars]
        do {
            accounts = try await workspace.syncStatus()
        } catch {
            if !quiet { record(error) }
            return
        }
        for entry in accounts where !entry.account.reconnectNeeded {
            busyAccountID = entry.account.id
            do {
                let results = try await workspace.syncAccountNow(accountId: entry.account.id)
                if !quiet { reportIfAnythingWentWrong(results) }
            } catch {
                if !quiet { record(error) }
            }
            busyAccountID = nil
        }
        lastAutomaticSyncAt = Date()
        await load()
    }

    /// When the last automatic pass ran, so an app switch doesn't sync every time.
    public private(set) var lastAutomaticSyncAt: Date?

    /// How long before a foreground return syncs. Longer than the desktop's poll because each
    /// costs a network round trip on battery.
    public static let staleAfter: TimeInterval = 15 * 60

    /// Sync on return to the foreground, if it has been a while.
    public func syncIfStale() async {
        if let last = lastAutomaticSyncAt, Date().timeIntervalSince(last) < Self.staleAfter {
            return
        }
        await syncAll(quiet: true)
    }

    /// `connect` has no account id yet, so it borrows a sentinel to drive the
    /// same spinner.
    public static let connecting = "connecting"

    public var isBusy: Bool { busyAccountID != nil }

    /// A sync can report per-calendar trouble without throwing. Saying nothing there makes
    /// "Sync" look like it works.
    private func reportIfAnythingWentWrong(_ results: [CalendarSyncResult]) {
        if results.contains(where: { $0.status == "reconnectNeeded" }) {
            problem = Problem(
                message: String(localized: "The server rejected the saved password. Reconnect the account to fix it."),
                isRetryable: false)
        } else if results.contains(where: { $0.status == "offline" }) {
            problem = Problem(
                message: String(localized: "Could not reach the server. Nothing was changed."),
                isRetryable: true)
        }
    }

    /// `Network` is separated: the only failure both routine and worth retrying unchanged, and
    /// the data layer's message for it names a URL rather than the problem.
    private func record(_ error: Error) {
        // Capitalised, as UniFFI spells it.
        if let error = error as? WorkspaceError, case .Network = error {
            problem = Problem(
                message: String(localized: "Could not reach the server. Check the address and your connection."),
                isRetryable: true)
        } else {
            problem = Problem(message: error.localizedDescription, isRetryable: false)
        }
    }
}
