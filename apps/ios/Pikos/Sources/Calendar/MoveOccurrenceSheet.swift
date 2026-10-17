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
    /// Set once the move has been written, so closing does not write it again.
    @State private var isMoved = false

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
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    FlowLayout {
                        ForEach(WhenChoice.allCases) { choice in
                            Button {
                                moveDay(to: choice)
                            } label: {
                                Pill(
                                    title: choice.label, systemImage: choice.systemImage,
                                    isOn: WallClockDay.string(from: start) == choice.day())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    DatePicker(
                        "Day",
                        selection: Binding(get: { start }, set: { setDay($0) }),
                        displayedComponents: .date
                    )
                        .datePickerStyle(.graphical)
                    if !isAllDay {
                        DatePicker("Starts at", selection: Binding(get: { start }, set: { moveStart(to: $0) }), displayedComponents: .hourAndMinute)
                    }
                    if hasEnd {
                        DatePicker(
                            "Ends", selection: $end, in: start...,
                            displayedComponents: isAllDay ? [.date] : [.date, .hourAndMinute])
                    }
                    Text(footnote)
                        .font(.pkUISm)
                        .foregroundStyle(.textTertiary)
                }
                .font(.pkBody)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .background(.surfaceElevated)
            .navigationTitle("Move this one")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // A new time is kept however the sheet closes; a day tapped has already moved it.
        .onDisappear {
            guard !isMoved, moveTarget.start != entry.scheduledStart else { return }
            isMoved = true
            let target = moveTarget
            Task { _ = await store.moveOccurrence(entry, to: target.start, end: target.end) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.surfaceElevated)
    }

    private func moveDay(to choice: WhenChoice) {
        guard let day = DayLabel.date(from: choice.day()) else { return }
        setDay(day)
    }

    /// Move to a day, keeping the time already chosen, and close: the day was the choice.
    private func setDay(_ day: Date) {
        let calendar = Calendar.current
        let time = calendar.dateComponents([.hour, .minute], from: start)
        moveStart(to: calendar.date(bySettingHour: time.hour ?? 9, minute: time.minute ?? 0, second: 0, of: day) ?? day)
        isMoved = true
        let target = moveTarget
        dismiss()
        Task { _ = await store.moveOccurrence(entry, to: target.start, end: target.end) }
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

    /// The end follows the start by the gap already chosen, so a one-hour meeting moved to Thursday
    /// stays one hour long.
    private func moveStart(to new: Date) {
        if hasEnd { end = end.addingTimeInterval(new.timeIntervalSince(start)) }
        start = new
    }

    private var moveTarget: (start: String, end: String?) {
        (
            isAllDay ? WallClockDay.string(from: start) : WallClockDay.instant(from: start),
            hasEnd ? (isAllDay ? WallClockDay.string(from: end) : WallClockDay.instant(from: end)) : nil
        )
    }
}
