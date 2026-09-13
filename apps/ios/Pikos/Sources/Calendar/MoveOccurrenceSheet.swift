import PikosCore
import PikosSupport
import SwiftUI

/// Move one occurrence of a series, leaving the rest of it where it is.
///
/// The desktop does this by dragging the block. On a phone a drag competes with
/// scrolling the grid, so the same operation arrives through the long-press menu
/// and a picker — the gesture is different, the write underneath is identical.
///
/// Narrower than `SchedulePageSheet` on purpose, in two ways. There is no "no
/// date": an occurrence *is* a date, and a series member with none is not a
/// thing the model can hold — dropping one is what Skip is for. And the choice
/// between all-day and timed is not offered, because it is not the user's here:
/// the occurrence inherits its shape from the rule, and an all-day series whose
/// Tuesday suddenly has a time would be writing a value the reconciler matches
/// occurrences by.
struct MoveOccurrenceSheet: View {
    let entry: CalendarEntry

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var start: Date
    @State private var hasEnd: Bool
    @State private var end: Date
    @State private var isSaving = false

    private let isAllDay: Bool

    init(entry: CalendarEntry) {
        self.entry = entry
        let allDay = !entry.scheduledStart.contains("T")
        isAllDay = allDay

        let existing = StorageTimestamp.wallClock(entry.scheduledStart) ?? Date()
        _start = State(initialValue: existing)
        let existingEnd = entry.scheduledEnd.flatMap { StorageTimestamp.wallClock($0) }
        _hasEnd = State(initialValue: existingEnd != nil)
        _end = State(initialValue: existingEnd ?? existing.addingTimeInterval(3600))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker(
                        "Starts", selection: $start,
                        displayedComponents: isAllDay ? [.date] : [.date, .hourAndMinute]
                    )
                    .onChange(of: start) { old, new in
                        // Keep the length the user already has. Moving a
                        // one-hour meeting to Thursday should leave it an hour.
                        guard hasEnd else { return }
                        end = end.addingTimeInterval(new.timeIntervalSince(old))
                    }

                    if hasEnd {
                        DatePicker(
                            "Ends", selection: $end, in: start...,
                            displayedComponents: isAllDay ? [.date] : [.date, .hourAndMinute])
                    }
                } header: {
                    Text("This occurrence")
                } footer: {
                    Text(footnote)
                }
            }
            .navigationTitle("Move")
            .navigationBarTitleDisplayMode(.inline)
            .disabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Move") { Task { await save() } }
                    }
                }
            }
        }
    }

    /// Said before the move, not discovered after it.
    ///
    /// What happens to the moved occurrence depends on where the series came
    /// from, and the two outcomes are different enough that a reader who expects
    /// the wrong one will think something went wrong. A native occurrence leaves
    /// the series and becomes a page of its own, so later edits to the repeat no
    /// longer reach it. An imported one stays a member, pinned to its new time.
    private var footnote: String {
        entry.isSyncedOrigin
            ? "The rest of the series stays where it is."
            : "This one leaves the repeat and becomes a page of its own. The rest of the series stays where it is."
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }

        let moved = await store.moveOccurrence(
            entry,
            to: isAllDay
                ? WallClockDay.string(from: start) : WallClockDay.instant(from: start),
            end: hasEnd
                ? (isAllDay ? WallClockDay.string(from: end) : WallClockDay.instant(from: end))
                : nil)
        if moved { dismiss() }
    }
}
