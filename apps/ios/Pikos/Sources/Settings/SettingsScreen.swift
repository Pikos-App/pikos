import PikosCore
import PikosSupport
import SwiftUI
import UIKit

/// Preferences, and what the app can tell you about itself.
///
/// Deliberately shorter than the desktop's. That one has five tabs, and three
/// of them describe things a phone does not have: keyboard shortcuts, window
/// state, and an editor line width for a column that is always the screen's.
/// What is here is what changes something on this device — and every row that
/// is here is wired to something, because a settings screen is the one place a
/// control that does nothing is indistinguishable from one that is broken.
///
/// `apps/ios/README.md` records what was left out and why, so the next person
/// to notice a missing preference finds a decision rather than an oversight.
struct SettingsScreen: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(WorkspaceStore.self) private var store
    @Environment(CalendarSyncStore.self) private var sync
    @Environment(ExportStore.self) private var exports
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(\.dismiss) private var dismiss

    @State private var isResetConfirmed = false
    @State private var isDeleteConfirmed = false
    @State private var isDeleting = false
    @State private var includeSyncedInExport = false

    var body: some View {
        @Bindable var settings = settings

        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Theme", selection: $settings.theme) {
                        ForEach(Preferences.Theme.allCases, id: \.self) { theme in
                            Text(theme.label).tag(theme)
                        }
                    }
                    Picker("List density", selection: $settings.listDensity) {
                        ForEach(Preferences.ListDensity.allCases, id: \.self) { density in
                            Text(density.label).tag(density)
                        }
                    }
                    Picker("Calendar density", selection: $settings.calendarDensity) {
                        ForEach(Preferences.CalendarDensity.allCases, id: \.self) { density in
                            Text(density.label).tag(density)
                        }
                    }
                } footer: {
                    Text("Calendar density sets how tall an hour is — how much of the day fits on screen at once.")
                }

                Section("Dates") {
                    Picker("Week starts on", selection: $settings.weekStart) {
                        ForEach(Preferences.WeekStart.allCases, id: \.self) { start in
                            Text(start.label).tag(start)
                        }
                    }
                } footer: {
                    Text("Used by every date picker. Defaults to your region.")
                }

                Section {
                    Picker("Default folder", selection: $settings.defaultFolderID) {
                        Text("Inbox").tag(String?.none)
                        ForEach(store.fileableFolders, id: \.id) { folder in
                            Text(folder.name).tag(String?.some(folder.id))
                        }
                    }
                } header: {
                    Text("New pages")
                } footer: {
                    Text(defaultFolderFooter)
                }

                remindersSection

                Section {
                    NavigationLink {
                        CalendarSyncScreen()
                    } label: {
                        LabeledContent("Calendars", value: calendarSummary)
                    }
                } header: {
                    Text("External calendars")
                }

                exportSection

                Section("About") {
                    LabeledContent("Version", value: Self.version)
                    // Not decoration: a page written by a newer build cannot be
                    // saved over by this one, and when somebody hits that the
                    // first useful question is which version each device is on.
                    LabeledContent("Document format", value: "v\(store.contentSchemaVersion)")
                }

                #if DEBUG
                    // The first device run's checklist, answered on screen —
                    // see docs/ios/07-device-checklist.md. Not in a release
                    // build: a container path is nobody's business but the
                    // developer's, and the attribute read behind it would
                    // need a privacy declaration the shipped binary should
                    // not have to make.
                    Section {
                        ForEach(Diagnostics.report()) { row in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.label).font(.caption).foregroundStyle(.secondary)
                                Text(row.value).font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                    } header: {
                        Text("Diagnostics (debug build)")
                    } footer: {
                        Text(
                            "Lock the phone, wait for the Today widget to refresh, then come back: every file above should still read “until first unlock”."
                        )
                    }
                #endif

                Section {
                    Button("Reset preferences", role: .destructive) {
                        isResetConfirmed = true
                    }
                } footer: {
                    Text("Returns the settings above to their defaults. Your pages are not touched.")
                }

                Section {
                    if isDeleting {
                        HStack {
                            ProgressView()
                            Text("Deleting…").foregroundStyle(.secondary)
                        }
                    } else {
                        Button("Delete all data", role: .destructive) {
                            isDeleteConfirmed = true
                        }
                    }
                } footer: {
                    // Said before the tap. The trash makes an ordinary delete
                    // recoverable, and somebody who has learned that will
                    // reasonably expect the same here.
                    Text(
                        "Removes every page, folder and calendar connection from this device. There is no trash to recover from — export first if you want a copy."
                    )
                }
            }
            .task { await sync.load() }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Reset preferences?", isPresented: $isResetConfirmed, titleVisibility: .visible
            ) {
                Button("Reset", role: .destructive) { settings.resetAll() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Theme, density, week start, default folder and reminders go back to their defaults.")
            }
            .confirmationDialog(
                "Delete everything on this device?", isPresented: $isDeleteConfirmed,
                titleVisibility: .visible
            ) {
                Button("Delete all data", role: .destructive) {
                    Task { await deleteEverything() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Every page, folder and calendar connection. This cannot be undone.")
            }
            .sheet(item: exportReady) { ready in
                ShareSheet(url: ready.url) { exports.ready = nil }
            }
            .alert(
                "Export failed", isPresented: exportFailed,
                actions: { Button("OK", role: .cancel) { exports.errorMessage = nil } },
                message: { Text(exports.errorMessage ?? "") })
        }
    }

    // MARK: - Reminders

    /// The two switches a reminder passes through — ours and the system's —
    /// and the one lead that applies when a page never asked for its own.
    ///
    /// The system's state is shown here rather than discovered, because a
    /// reminder that never arrives looks the same whether it was never
    /// planned or never allowed, and only one of those is fixed on this
    /// screen. Denied permission gets a link to where it is fixed.
    @ViewBuilder
    private var remindersSection: some View {
        @Bindable var settings = settings

        Section {
            Toggle("Remind me", isOn: $settings.remindersEnabled)

            if settings.remindersEnabled {
                Picker("Default reminder", selection: $settings.defaultReminderMinutes) {
                    ForEach(Preferences.reminderLeadChoices, id: \.self) { minutes in
                        Text(SettingsStore.leadLabel(minutes)).tag(minutes)
                    }
                }

                switch reminders.authorization {
                case .denied:
                    LabeledContent("Notifications") {
                        Text("Off in Settings").foregroundStyle(.red)
                    }
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        Link("Allow notifications for Pikos", destination: url)
                    }
                case .notDetermined:
                    Button("Allow notifications") {
                        Task { await reminders.requestAuthorization() }
                    }
                default:
                    LabeledContent(
                        "Planned",
                        value: reminders.plannedCount == 1
                            ? String(localized: "1 reminder")
                            : String(localized: "\(reminders.plannedCount) reminders"))
                }
            }
        } header: {
            Text("Reminders")
        } footer: {
            Text(remindersFooter)
        }
        .task { await reminders.refreshAuthorization() }
    }

    private var remindersFooter: String {
        guard settings.remindersEnabled else {
            return String(localized: "Nothing rings on this phone. Reminders still fire on the desktop.")
        }
        return String(
            localized:
                "Pages without a reminder of their own use the default. Reminders are planned two weeks ahead and re-planned whenever something changes; use a Focus to silence them at night."
        )
    }

    // MARK: - Export

    /// Four formats, each saying what it is for before it is tapped.
    ///
    /// They are not interchangeable, and the difference only becomes visible
    /// once the file is somewhere else — a CSV that imports back, a Markdown
    /// tree that opens anywhere, a calendar file, and a backup that is the whole
    /// workspace including the trash.
    @ViewBuilder
    private var exportSection: some View {
        Section {
            ForEach(ExportStore.Format.allCases) { format in
                Button {
                    Task { await exports.export(format, includeSynced: includeSyncedInExport) }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(format.title).foregroundStyle(Color.primary)
                            Text(format.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if exports.isExporting == format {
                            ProgressView()
                        }
                    }
                }
                .disabled(exports.isExporting != nil)
            }

            // Only when there is a calendar to include. Without one the toggle
            // is a question about something the reader does not have.
            if hasCalendars {
                Toggle("Include calendar events", isOn: $includeSyncedInExport)
            }
        } header: {
            Text("Export")
        } footer: {
            if hasCalendars {
                Text(
                    "Off by default: events mirrored from a calendar are that calendar's copy, and your calendar app already has them."
                )
            }
        }
    }

    private var hasCalendars: Bool {
        sync.accounts.contains { !$0.calendars.isEmpty }
    }

    private var exportReady: Binding<ExportStore.Ready?> {
        Binding(get: { exports.ready }, set: { exports.ready = $0 })
    }

    private var exportFailed: Binding<Bool> {
        Binding(get: { exports.errorMessage != nil }, set: { if !$0 { exports.errorMessage = nil } })
    }

    private func deleteEverything() async {
        isDeleting = true
        defer { isDeleting = false }
        await store.deleteAllData()
        dismiss()
    }

    /// How many calendars are mirroring, so the row says something without
    /// being opened.
    ///
    /// Counts enabled calendars rather than accounts: an account with every
    /// calendar switched off is connected and syncing nothing, and "1 account"
    /// would describe that as working.
    private var calendarSummary: String {
        let enabled = sync.accounts.flatMap(\.calendars).filter(\.enabled).count
        if sync.accounts.isEmpty { return String(localized: "None") }
        return String(localized: "\(enabled) syncing")
    }

    /// Says out loud when the stored folder no longer exists.
    ///
    /// The id outlives the folder — deleting one does not reach into settings
    /// to clear it — so the picker falls back to showing Inbox. Without this
    /// sentence that looks like the preference silently reset itself, which is
    /// the one reading that would send somebody looking for a bug.
    private var defaultFolderFooter: String {
        let base = String(localized: "Where a new page lands when you create one from a widget or a link.")
        guard let id = settings.defaultFolderID,
            !store.fileableFolders.contains(where: { $0.id == id })
        else { return base }
        return base + " " + String(localized: "The folder this was set to no longer exists, so new pages go to the Inbox.")
    }

    /// The marketing version and build, as Xcode stamped them.
    ///
    /// Read from the bundle rather than from a constant in the source: a
    /// constant is a second place to remember on every release, and the one
    /// that gets forgotten is always the one the user is reading.
    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        guard let build = info?["CFBundleVersion"] as? String, build != short else { return short }
        return "\(short) (\(build))"
    }
}
