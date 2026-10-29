import PikosSupport
import SwiftUI

/// The promise, made checkable, and the ways to take the data elsewhere or wipe it.
///
/// The marketing site says the data is a file on your device. On a
/// desktop that is something a person can go and look at; on a phone the
/// container is hidden, and the claim has to be taken on faith. The first
/// section is the faith made visible: how big the file is, and a button
/// that puts a copy of it where the Files app shows it.
///
/// Above Export rather than folded into it, because it answers a
/// different question. Export is "get this into another app"; the backup is
/// "where is my data, and can I hold a copy of it".
struct YourDataSettings: View {
    /// Closes the whole settings sheet, not just this page, once everything is deleted.
    let closeSettings: () -> Void

    @Environment(WorkspaceStore.self) private var store
    @Environment(CalendarSyncStore.self) private var sync
    @Environment(ExportStore.self) private var exports
    @Environment(DeviceSync.self) private var deviceSync

    @State private var isDeleteConfirmed = false
    @State private var isDeleting = false
    @State private var includeSyncedInExport = false

    var body: some View {
        SettingsPage(title: "Your data") {
            backupSection
            exportSection
            deleteSection
        }
        .task { exports.refreshDataFacts() }
        .sheet(item: exportReady) { ready in
            ShareSheet(url: ready.url) { exports.ready = nil }
        }
        .alert(
            "Export failed", isPresented: exportFailed,
            actions: { Button("OK", role: .cancel) { exports.errorMessage = nil } },
            message: { Text(exports.errorMessage ?? "") })
    }

    private var backupSection: some View {
        Section {
            LabeledContent("On this device") {
                if let size = exports.workspaceSize {
                    Text(size, format: .byteCount(style: .file))
                } else {
                    Text("—")
                }
            }
            Button {
                Task { await exports.backUpToFiles() }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Back up to Files").foregroundStyle(.textPrimary)
                        Text(lastBackupLabel)
                            .font(.caption)
                            .foregroundStyle(.textSecondary)
                    }
                    Spacer()
                    if exports.isBackingUp {
                        ProgressView()
                    }
                }
            }
            .disabled(exports.isBackingUp)
        } footer: {
            Text(
                "Your pages, folders and images are stored on this device. A backup copies all of them into Pikos › Backups in the Files app, where you can keep it, move it or send it anywhere. Nothing leaves the phone unless you move it."
            )
        }
    }

    /// "Last backup Today at 9:41" or "Never backed up".
    ///
    /// The date is relative through the same wording the list uses for a
    /// schedule, so a backup taken this morning says "Today" and not a date
    /// the reader has to compare with the clock.
    private var lastBackupLabel: String {
        guard let date = exports.lastBackup else { return String(localized: "Never backed up") }
        let day = DayLabel.relative(DayLabel.today(now: date), today: DayLabel.today())
        let time = ClockTime.string(date)
        return String(localized: "Last backup \(day) at \(time)")
    }

    /// Three formats, each saying what it is for before it is tapped.
    ///
    /// They are not interchangeable, and the difference only becomes visible
    /// once the file is somewhere else: a CSV that imports back, a Markdown
    /// tree that opens anywhere, and a calendar file.
    @ViewBuilder
    private var exportSection: some View {
        Section {
            // The whole-workspace file is Back up to Files, above: one backup, in one place.
            ForEach(ExportStore.Format.allCases.filter { $0 != .backup }) { format in
                Button {
                    Task { await exports.export(format, includeSynced: includeSyncedInExport) }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(format.title).foregroundStyle(.textPrimary)
                            Text(format.detail)
                                .font(.caption)
                                .foregroundStyle(.textSecondary)
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
                    .tint(.interactiveFill)
            }
        } header: {
            Text("Export").sectionLabelStyle()
        } footer: {
            if hasCalendars {
                Text(
                    "Off by default: events mirrored from a calendar are that calendar's copy, and your calendar app already has them."
                )
            }
        }
    }

    private var deleteSection: some View {
        Section {
            if isDeleting {
                HStack {
                    ProgressView()
                    Text("Deleting…").foregroundStyle(.textSecondary)
                }
            } else {
                // On the button, not the screen: iOS shows the confirmation as a popover
                // pointing at what it's attached to.
                Button("Delete all data", role: .destructive) {
                    isDeleteConfirmed = true
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
                    if deviceSync.isOn {
                        Text(
                            "Every page, folder and calendar connection. This cannot be undone. The copy in iCloud stays, and iCloud sync turns off on this device until you turn it on again."
                        )
                    } else {
                        Text("Every page, folder and calendar connection. This cannot be undone.")
                    }
                }
            }
        } footer: {
            // Said before the tap. The trash makes an ordinary delete
            // recoverable, and somebody who has learned that will
            // reasonably expect the same here.
            Text(
                "Removes every page, folder and calendar connection from this device. There is no trash to recover from, so back up first if you want a copy."
            )
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
        // First, so a fetch can't pour the other devices' pages back into the emptied workspace.
        await deviceSync.turnOff()
        await store.deleteAllData()
        // The home screen's search must forget the titles too: a phone wiped
        // of its notes that keeps offering them from Spotlight has not been
        // wiped.
        await SpotlightIndexer.clear()
        closeSettings()
    }
}
