import SwiftUI

/// Preferences, and what the app can tell you about itself, as a list of pages.
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
    @Environment(CalendarSyncStore.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var isResetConfirmed = false

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    Section {
                        NavigationLink {
                            AppearanceSettings()
                        } label: {
                            Label("Appearance", systemImage: "paintbrush")
                        }
                        NavigationLink {
                            CalendarSettings()
                        } label: {
                            Label("Calendar", systemImage: "calendar")
                        }
                        NavigationLink {
                            RemindersSettings()
                        } label: {
                            Label("Reminders", systemImage: "bell")
                        }
                        NavigationLink {
                            NewPagesSettings()
                        } label: {
                            Label("New pages", systemImage: "square.and.pencil")
                        }
                    }

                    Section {
                        if DeviceSync.isAvailable {
                            NavigationLink {
                                SettingsPage(title: "iCloud") { SyncSection() }
                            } label: {
                                Label("iCloud", systemImage: "icloud")
                            }
                        }
                        NavigationLink {
                            CalendarSyncScreen()
                        } label: {
                            LabeledContent {
                                Text(calendarSummary)
                            } label: {
                                Label("Calendars", systemImage: "calendar.badge.plus")
                            }
                        }
                        NavigationLink {
                            YourDataSettings(closeSettings: { dismiss() })
                        } label: {
                            Label("Your data", systemImage: "externaldrive")
                        }
                    }

                    Section {
                        NavigationLink {
                            AboutSettings()
                        } label: {
                            Label("About", systemImage: "info.circle")
                        }
                    }

                    Section {
                        // On the button, not the screen: iOS shows the confirmation as a popover
                        // pointing at what it's attached to, and attached to the screen it pointed
                        // at a row near the top.
                        Button("Reset preferences", role: .destructive) {
                            isResetConfirmed = true
                        }
                        .confirmationDialog(
                            "Reset preferences?", isPresented: $isResetConfirmed, titleVisibility: .visible
                        ) {
                            Button("Reset", role: .destructive) { settings.resetAll() }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            Text("Theme, density, week start, default folder and reminders go back to their defaults.")
                        }
                    } footer: {
                        Text("Returns the settings above to their defaults. Your pages are not touched.")
                    }
                }
                .pikosFormRows()
            }
            .task { await sync.load() }
            .navigationTitle("Settings")
            .pikosFormStyle()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
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
        if sync.accounts.isEmpty { return String(localized: "None") }
        return String(localized: "\(enabled) syncing")
    }
}
