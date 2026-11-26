import PikosCore
import PikosSupport
import SwiftUI

/// Connected calendars: accounts, which of their calendars mirror into Pikos, and a sync you
/// ask for. iOS can't run the desktop's five-minute poll, so this screen says what runs
/// instead.
struct CalendarSyncScreen: View {
    @Environment(CalendarSyncStore.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var isAddPresented = false
    @State private var reconnecting: Reconnecting?

    /// A wrapper because `sheet(item:)` needs `Identifiable` and `SyncAccount` is a generated
    /// record: a retroactive conformance could collide with a later regeneration, and
    /// `@retroactive` is Swift 6 syntax on a package still on tools 5.9.
    private struct Reconnecting: Identifiable {
        let account: SyncAccount
        var id: String { account.id }
    }

    var body: some View {
        @Bindable var sync = sync

        List {
            Group {
                if sync.isLoading && sync.accounts.isEmpty {
                    ProgressView().frame(maxWidth: .infinity)
                } else if sync.accounts.isEmpty {
                    Section {
                        Text("No calendars connected.")
                            .font(.footnote)
                            .foregroundStyle(.textSecondary)
                    } footer: {
                        Text(
                            "Connect a CalDAV server, such as Fastmail, iCloud or Nextcloud, and its events appear in Pikos as pages you can see but not edit."
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
                    // Both limits said up front: a day-stale calendar reads as a bug to anyone who doesn't
                    // know what iOS allows.
                    VStack(alignment: .leading, spacing: 6) {
                        Text(
                            "Google accounts are added on the desktop, because signing in to Google needs a browser that can hand back to Pikos."
                        )
                        Text(
                            "Calendars sync when you open Pikos, when you ask, and in the background when iPhone allows it, which is on its own schedule rather than every few minutes."
                        )
                    }
                }
            }
            .pikosFormRows()
        }
        .navigationTitle("Calendars")
        .pikosFormStyle()
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
                // Above the calendars, because nothing below works: the scheduler skips a flagged account.
                Button {
                    reconnecting = Reconnecting(account: entry.account)
                } label: {
                    Label("Password rejected. Reconnect", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.textDueSoon)
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
                Text(entry.account.displayName).sectionLabelStyle()
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
            .tint(.interactiveFill)
            .disabled(sync.isBusy)

            // Said before the switch is flipped: turning a calendar off deletes untouched mirrors and
            // detaches edited pages, and turning it on lets the calendar's values win. Nothing at zero.
            if calendar.detachedPages > 0 {
                Text(
                    calendar.detachedPages == 1
                        ? "1 page you edited was kept when this was switched off. Switching it back on will let the calendar's version win."
                        : "\(calendar.detachedPages) pages you edited were kept when this was switched off. Switching it back on will let the calendar's versions win."
                )
                .font(.caption)
                .foregroundStyle(.textSecondary)
            }
        }
    }

    /// The newest of its calendars' stamps, since syncing is per calendar and the account has none.
    private func footer(for entry: SyncAccountWithCalendars) -> String {
        let stamps = entry.calendars.compactMap { $0.lastSyncedAt }
        guard let newest = stamps.max(), let at = StorageTimestamp.utc(newest) else {
            return String(localized: "Not synced yet.")
        }
        return String(localized: "Last synced \(at.formatted(.relative(presentation: .named))).")
    }
}
