import PikosCore
import PikosSupport
import SwiftUI

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
    @Environment(\.dismiss) private var dismiss

    @State private var isResetConfirmed = false

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

                Section {
                    NavigationLink {
                        CalendarSyncScreen()
                    } label: {
                        LabeledContent("Calendars", value: calendarSummary)
                    }
                } header: {
                    Text("External calendars")
                }

                Section("About") {
                    LabeledContent("Version", value: Self.version)
                    // Not decoration: a page written by a newer build cannot be
                    // saved over by this one, and when somebody hits that the
                    // first useful question is which version each device is on.
                    LabeledContent("Document format", value: "v\(store.contentSchemaVersion)")
                }

                Section {
                    Button("Reset preferences", role: .destructive) {
                        isResetConfirmed = true
                    }
                } footer: {
                    Text("Returns the settings above to their defaults. Your pages are not touched.")
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
                Text("Theme, density, week start and default folder go back to their defaults.")
            }
        }
    }

    /// How many calendars are mirroring, so the row says something without
    /// being opened.
    ///
    /// Counts enabled calendars rather than accounts: an account with every
    /// calendar switched off is connected and syncing nothing, and "1 account"
    /// would describe that as working.
    private var calendarSummary: String {
        let enabled = sync.accounts.flatMap(\.calendars).filter(\.enabled).count
        if sync.accounts.isEmpty { return "None" }
        return enabled == 1 ? "1 syncing" : "\(enabled) syncing"
    }

    /// Says out loud when the stored folder no longer exists.
    ///
    /// The id outlives the folder — deleting one does not reach into settings
    /// to clear it — so the picker falls back to showing Inbox. Without this
    /// sentence that looks like the preference silently reset itself, which is
    /// the one reading that would send somebody looking for a bug.
    private var defaultFolderFooter: String {
        let base = "Where a new page lands when you create one from a widget or a link."
        guard let id = settings.defaultFolderID,
            !store.fileableFolders.contains(where: { $0.id == id })
        else { return base }
        return base + " The folder this was set to no longer exists, so new pages go to the Inbox."
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
