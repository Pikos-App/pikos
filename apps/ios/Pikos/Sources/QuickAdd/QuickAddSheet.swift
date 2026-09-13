import PikosCore
import SwiftUI

/// Create a page without leaving the list.
///
/// ## No natural-language parsing yet, deliberately
///
/// The desktop's quick add parses "tomorrow at 3pm #work ~Projects" out of a
/// single line. That parser is still TypeScript and has not been ported — see
/// `docs/ios/04-parser-grammar.md` for what porting it involves and why the
/// scope was measured before committing to it.
///
/// Rather than ship a worse imitation, this uses native controls: a date picker
/// and a folder picker. On a phone that is arguably the better interaction
/// anyway — a date picker beats typing "tomorrow at 3pm" with a thumb — so when
/// the parser does land it should be *added* alongside these, not replace them.
struct QuickAddSheet: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var folderId: String?
    @State private var schedule: Schedule = .none
    @State private var date = Date()
    @State private var isSaving = false
    @FocusState private var titleFocused: Bool

    private enum Schedule: String, CaseIterable, Identifiable {
        case none = "No date"
        case allDay = "All day"
        case timed = "At a time"

        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What needs doing?", text: $title, axis: .vertical)
                        .lineLimit(1...4)
                        .focused($titleFocused)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                }

                Section("When") {
                    Picker("Schedule", selection: $schedule) {
                        ForEach(Schedule.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)

                    if schedule != .none {
                        DatePicker(
                            "Date",
                            selection: $date,
                            displayedComponents: schedule == .timed
                                ? [.date, .hourAndMinute] : [.date])
                    }
                }

                if !store.folders.isEmpty {
                    Section("Folder") {
                        Picker("Folder", selection: $folderId) {
                            Text("Inbox").tag(String?.none)
                            ForEach(store.folders, id: \.id) { folder in
                                Text(folder.name).tag(String?.some(folder.id))
                            }
                        }
                    }
                }
            }
            .navigationTitle("New page")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await save() } }
                        .disabled(trimmedTitle.isEmpty || isSaving)
                }
            }
            // Straight into the field: the whole point of quick add is that it
            // costs one tap and a sentence.
            .onAppear { titleFocused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func save() async {
        guard !trimmedTitle.isEmpty, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }

        await store.createPage(
            NewPage(
                title: trimmedTitle,
                folderId: folderId,
                scheduledStart: scheduledStart
            ))
        dismiss()
    }

    /// The picked date as the local wall-clock string the workspace stores.
    ///
    /// Formatted with a fixed-format, fixed-locale formatter and no timezone
    /// conversion. `Date` is an instant and the stored value is a wall clock;
    /// converting would be the very mistake the string-typed boundary exists to
    /// prevent.
    private var scheduledStart: String? {
        guard schedule != .none else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = schedule == .allDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss"
        return formatter.string(from: date)
    }
}
