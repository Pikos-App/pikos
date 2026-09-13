import PikosCore
import PikosSupport
import SwiftUI

/// Connected calendars: accounts, which of their calendars mirror into Pikos,
/// and a sync you ask for.
///
/// Honest about being manual. iOS suspends an in-process timer within seconds
/// of backgrounding, so the desktop's five-minute poll cannot run here — every
/// sync on this screen happens because somebody tapped something with the app
/// open. Saying that plainly costs one sentence and saves the user wondering
/// why their calendar is a day stale.
struct CalendarSyncScreen: View {
    @Environment(CalendarSyncStore.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var isAddPresented = false
    @State private var reconnecting: Reconnecting?

    /// A wrapper rather than a conformance on the generated `SyncAccount`.
    ///
    /// `sheet(item:)` wants `Identifiable`, and the account is a UniFFI record
    /// this repo does not own. A retroactive conformance on someone else's type
    /// is a name the next binding regeneration could collide with, and
    /// `@retroactive` is Swift 6 syntax on a package still on tools 5.9. Four
    /// lines here avoids both.
    private struct Reconnecting: Identifiable {
        let account: SyncAccount
        var id: String { account.id }
    }

    var body: some View {
        @Bindable var sync = sync

        List {
            if sync.isLoading && sync.accounts.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if sync.accounts.isEmpty {
                Section {
                    Text("No calendars connected.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } footer: {
                    Text(
                        "Connect a CalDAV server — Fastmail, iCloud, Nextcloud — and its events appear in Pikos as pages you can see but not edit."
                    )
                }
            }

            ForEach(sync.accounts, id: \.account.id) { entry in
                accountSection(entry)
            }

            Section {
                Button {
                    isAddPresented = true
                } label: {
                    Label("Add CalDAV account", systemImage: "plus")
                }
                .disabled(sync.isBusy)
            } footer: {
                // Both limits said here rather than discovered. The first is a
                // missing feature; the second is what iOS allows, and a user
                // who does not know it will read a day-stale calendar as a bug.
                VStack(alignment: .leading, spacing: 6) {
                    Text(
                        "Google accounts can only be added on the desktop for now — the sign-in needs a browser the phone cannot hand back to."
                    )
                    Text(
                        "Calendars sync when you ask them to. Pikos does not check in the background on iPhone."
                    )
                }
            }
        }
        .navigationTitle("Calendars")
        .navigationBarTitleDisplayMode(.inline)
        .task { await sync.load() }
        .refreshable { await sync.load() }
        .sheet(isPresented: $isAddPresented) {
            CaldavAccountSheet(mode: .connect)
        }
        .sheet(item: $reconnecting) { target in
            CaldavAccountSheet(mode: .reconnect(target.account))
        }
        .alert(
            sync.problem?.isRetryable == true ? "Could not reach the server" : "Sync problem",
            isPresented: .init(
                get: { sync.problem != nil },
                set: { if !$0 { sync.problem = nil } }
            ),
            presenting: sync.problem,
            actions: { _ in Button("OK", role: .cancel) {} },
            message: { Text($0.message) }
        )
    }

    @ViewBuilder
    private func accountSection(_ entry: SyncAccountWithCalendars) -> some View {
        Section {
            if entry.account.reconnectNeeded {
                // Above the calendars, because nothing below it is working.
                // The scheduler skips a flagged account entirely, so leaving
                // this quiet shows an account that looks connected and syncs
                // nothing.
                Button {
                    reconnecting = Reconnecting(account: entry.account)
                } label: {
                    Label("Password rejected — reconnect", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            }

            ForEach(entry.calendars, id: \.id) { calendar in
                calendarRow(calendar, account: entry.account)
            }

            Button {
                Task { await sync.sync(accountID: entry.account.id) }
            } label: {
                Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
            }
            .disabled(sync.isBusy)

            Menu {
                Button {
                    Task { await sync.sync(accountID: entry.account.id, full: true) }
                } label: {
                    Label("Re-read everything", systemImage: "arrow.clockwise")
                }
                if !entry.account.reconnectNeeded {
                    Button { reconnecting = Reconnecting(account: entry.account) } label: {
                        Label("Change password", systemImage: "key")
                    }
                }
                Button(role: .destructive) {
                    Task { await sync.disconnect(accountID: entry.account.id) }
                } label: {
                    Label("Disconnect", systemImage: "minus.circle")
                }
            } label: {
                Label("More…", systemImage: "ellipsis.circle")
            }
            .disabled(sync.isBusy)
        } header: {
            HStack {
                Text(entry.account.displayName)
                if sync.busyAccountID == entry.account.id {
                    ProgressView().controlSize(.small)
                }
            }
        } footer: {
            Text(footer(for: entry))
        }
    }

    private func calendarRow(_ calendar: SyncCalendar, account: SyncAccount) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Toggle(
                calendar.displayName,
                isOn: Binding(
                    get: { calendar.enabled },
                    set: { on in
                        Task {
                            await sync.setEnabled(
                                calendarID: calendar.id, accountID: account.id, enabled: on)
                        }
                    })
            )
            .disabled(sync.isBusy)

            // Said before the switch is flipped, not after. Turning a calendar
            // off deletes its untouched mirrors and detaches the pages the user
            // worked in; turning it back on reclaims those and lets the
            // calendar's values win over the local edits. A count of zero means
            // there is nothing to warn about, so nothing is said.
            if calendar.detachedPages > 0 {
                Text(
                    calendar.detachedPages == 1
                        ? "1 page you edited was kept when this was switched off. Switching it back on will let the calendar's version win."
                        : "\(calendar.detachedPages) pages you edited were kept when this was switched off. Switching it back on will let the calendar's versions win."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    /// When this account last managed to sync, in the reader's own words.
    ///
    /// The newest of its calendars' stamps rather than the account's own,
    /// because the account has none — syncing is per calendar, and what a
    /// reader means by "when did this last work" is the most recent one that
    /// did.
    private func footer(for entry: SyncAccountWithCalendars) -> String {
        let stamps = entry.calendars.compactMap { $0.lastSyncedAt }
        guard let newest = stamps.max(), let at = StorageTimestamp.utc(newest) else {
            return "Not synced yet."
        }
        return "Last synced \(at.formatted(.relative(presentation: .named)))."
    }
}
