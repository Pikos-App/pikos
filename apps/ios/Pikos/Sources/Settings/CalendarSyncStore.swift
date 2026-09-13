import Observation
import PikosCore
import SwiftUI

/// Connected calendars, and the operations the phone can perform on them.
///
/// Its own store rather than more surface on `WorkspaceStore`, because the
/// failure modes are different in kind. A page list fails when the database
/// does, which is rare and serious. This fails when a server is down, a
/// password has been rotated, or the phone is on a train — routine, transient,
/// and each needing a different sentence. Mixing them would mean one
/// `errorMessage` saying "could not read or write" over all of it.
///
/// Everything here is manual. Nothing on iOS polls: the desktop's scheduler is
/// an in-process timer and iOS suspends that within seconds of backgrounding,
/// so a sync happens because somebody asked for one with the app open. The UI
/// says so rather than implying a background service that is not there.
@MainActor
@Observable
public final class CalendarSyncStore {
    public private(set) var accounts: [SyncAccountWithCalendars] = []
    public private(set) var isLoading = true

    /// The last thing that went wrong, and whether trying again is worth it.
    ///
    /// Carried as a pair rather than a string because "retry" is advice, and
    /// advice that is wrong the first time is not taken the second. A network
    /// failure is worth retrying unchanged; a rejected password is not.
    public struct Problem: Identifiable {
        public let id = UUID()
        public let message: String
        public let isRetryable: Bool
    }

    public var problem: Problem?

    /// Which account is mid-operation, so its row can show a spinner and the
    /// others stay usable. A single global flag would freeze the whole screen
    /// for one account's slow server.
    public private(set) var busyAccountID: String?

    private let workspace: @MainActor () -> Workspace?

    /// Takes the workspace as a closure rather than a value: `WorkspaceStore`
    /// opens it asynchronously, so at construction time there is nothing to
    /// hold yet, and capturing `nil` once would leave this permanently unable
    /// to do anything.
    ///
    /// `@MainActor` on the closure because what it reads is main-actor state.
    /// Everything here is already on that actor, so it costs nothing and makes
    /// the isolation explicit rather than inferred.
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

    /// Connect a CalDAV server. Returns whether it worked, so the sheet knows
    /// whether to close.
    ///
    /// Slow on purpose: discovery runs before anything is stored, so a wrong
    /// URL or password fails here rather than leaving a half-connected account
    /// behind.
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

    /// Swap a password that stopped working.
    ///
    /// Takes the password alone: the server and username are already stored,
    /// and re-collecting them would let a typo create a second account instead
    /// of repairing this one.
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

    /// `connect` has no account id yet, so it borrows a sentinel to drive the
    /// same spinner.
    public static let connecting = "connecting"

    public var isBusy: Bool { busyAccountID != nil }

    /// A sync can come back reporting per-calendar trouble without throwing —
    /// the call succeeded, the calendars did not. Saying nothing there is how a
    /// "Sync" button appears to work while nothing is being synced.
    private func reportIfAnythingWentWrong(_ results: [CalendarSyncResult]) {
        if results.contains(where: { $0.status == "reconnectNeeded" }) {
            problem = Problem(
                message: "The server rejected the saved password. Reconnect the account to fix it.",
                isRetryable: false)
        } else if results.contains(where: { $0.status == "offline" }) {
            problem = Problem(
                message: "Could not reach the server. Nothing was changed.",
                isRetryable: true)
        }
    }

    /// Turn a thrown error into something worth reading.
    ///
    /// `Network` is the case worth separating: it is the only failure here that
    /// is both routine and worth retrying unchanged, and the message the data
    /// layer produces for it names a URL rather than the problem.
    private func record(_ error: Error) {
        // Capitalised, as UniFFI spells it — see the note in `WorkspaceStore`.
        if let error = error as? WorkspaceError, case .Network = error {
            problem = Problem(
                message: "Could not reach the server. Check the address and your connection.",
                isRetryable: true)
        } else {
            problem = Problem(message: error.localizedDescription, isRetryable: false)
        }
    }
}
