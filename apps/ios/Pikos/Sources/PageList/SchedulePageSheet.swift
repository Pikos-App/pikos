import PikosCore
import PikosSupport
import SwiftUI

/// Put a page on a date, move it, or take the date away.
///
/// The gap this closes was the largest on the phone: a page got its date from
/// quick add's natural-language line and nothing could change it afterwards. A
/// page created without one could never get one, and a meeting that moved had
/// to be deleted and retyped.
///
/// Not offered for a repeating page or one a calendar owns, and the caller is
/// expected to have checked — but the workspace refuses both anyway, because a
/// list row can be a second old by the time a sheet opens.
struct SchedulePageSheet: View {
    let page: PageSummary

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var kind: Kind
    @State private var start: Date
    @State private var hasEnd: Bool
    @State private var end: Date
    @State private var isSaving = false

    /// The three shapes a schedule can take, which is also what the storage
    /// format distinguishes: no row at all, a date, or a date and a time.
    private enum Kind: String, CaseIterable, Identifiable {
        case none = "No date"
        case allDay = "All day"
        case timed = "At a time"

        var id: String { rawValue }
    }

    init(page: PageSummary) {
        self.page = page

        let existing = page.scheduledStart.flatMap { StorageTimestamp.wallClock($0) }
        let isAllDay = page.scheduledStart.map { !$0.contains("T") } ?? false
        _kind = State(
            initialValue: page.scheduledStart == nil ? .none : (isAllDay ? .allDay : .timed))
        // An unscheduled page opens on the next round hour rather than on this
        // exact second: nobody schedules anything for 14:37:22, and a picker
        // that starts there makes the user scroll away from a value they did
        // not choose.
        _start = State(initialValue: existing ?? Self.nextHour())

        let existingEnd = page.scheduledEnd.flatMap { StorageTimestamp.wallClock($0) }
        _hasEnd = State(initialValue: existingEnd != nil)
        _end = State(
            initialValue: existingEnd
                ?? (existing ?? Self.nextHour()).addingTimeInterval(3600))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("When", selection: $kind) {
                        ForEach(Kind.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                if kind != .none {
                    Section {
                        DatePicker(
                            "Starts", selection: $start,
                            displayedComponents: kind == .allDay ? [.date] : [.date, .hourAndMinute]
                        )
                        .onChange(of: start) { old, new in
                            // The end follows the start by the gap the user
                            // already chose, rather than staying put and
                            // becoming invalid. Moving a one-hour meeting to
                            // Thursday should keep it one hour long.
                            guard hasEnd else { return }
                            end = end.addingTimeInterval(new.timeIntervalSince(old))
                        }

                        Toggle(kind == .allDay ? "Ends on a later day" : "Set an end time", isOn: $hasEnd)

                        if hasEnd {
                            DatePicker(
                                "Ends", selection: $end, in: start...,
                                displayedComponents: kind == .allDay
                                    ? [.date] : [.date, .hourAndMinute])
                        }
                    } footer: {
                        if kind == .allDay {
                            // Worth saying: a reader who means "the 1st to the
                            // 7th" and gets six days would assume a bug rather
                            // than a convention.
                            Text("The end day is included — 1 to 8 July is eight days.")
                        }
                    }
                }
            }
            .navigationTitle("Schedule")
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
                        Button("Save") { Task { await save() } }
                    }
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }

        switch kind {
        case .none:
            await store.clearDate(pageId: page.id)
        case .allDay:
            await store.setSchedule(
                pageId: page.id,
                start: WallClockDay.string(from: start),
                end: hasEnd ? WallClockDay.string(from: end) : nil)
        case .timed:
            await store.setSchedule(
                pageId: page.id,
                start: WallClockDay.instant(from: start),
                end: hasEnd ? WallClockDay.instant(from: end) : nil)
        }
        dismiss()
    }

    /// The next whole hour, in the reader's own calendar.
    private static func nextHour() -> Date {
        let calendar = Calendar.current
        let next = calendar.date(byAdding: .hour, value: 1, to: Date()) ?? Date()
        return calendar.date(
            bySettingHour: calendar.component(.hour, from: next), minute: 0, second: 0, of: next)
            ?? next
    }
}
