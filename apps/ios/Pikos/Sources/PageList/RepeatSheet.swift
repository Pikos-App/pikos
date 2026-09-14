import PikosCore
import SwiftUI

/// How often a page repeats.
///
/// Quick add could make a page repeat and nothing could change it afterwards —
/// so "every Monday" typed once was every Monday forever, and the only way out
/// was to delete the page.
///
/// Narrow on purpose. Frequency, how many of them between runs, and which
/// weekdays: the repeats people actually type. Anything richer — "the last
/// Friday of the month", "every 15 March", one that stops after ten — is shown
/// and left alone, because a picker with nowhere to put those terms would save
/// the rule back without them. The workspace decides which is which and says so
/// through `PageRepeat`; this screen only draws the answer.
struct RepeatSheet: View {
    let page: PageFacts

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var current: PageRepeat?
    @State private var freq: RepeatFreq = .weekly
    @State private var interval = 1
    @State private var weekdays: Set<UInt32> = []
    @State private var repeats = false
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                switch current {
                case .none:
                    // Still reading. A form drawn from defaults and then
                    // rearranged a beat later reads as the app changing its
                    // mind about the page.
                    ProgressView().frame(maxWidth: .infinity)

                case .fixed(let label):
                    Section {
                        Text(label)
                    } header: {
                        Text("Repeats")
                    } footer: {
                        Text(
                            "This repeat is more detailed than Pikos can edit on iPhone. It still works — change it on the desktop."
                        )
                    }

                case .never, .editable:
                    editor
                }
            }
            .navigationTitle("Repeat")
            .navigationBarTitleDisplayMode(.inline)
            .disabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isEditable ? "Cancel" : "Done") { dismiss() }
                }
                if isEditable {
                    ToolbarItem(placement: .confirmationAction) {
                        if isSaving {
                            ProgressView()
                        } else {
                            Button("Save") { Task { await save() } }
                        }
                    }
                }
            }
            .task { await load() }
        }
    }

    @ViewBuilder
    private var editor: some View {
        Section {
            Toggle("Repeats", isOn: $repeats)
        } footer: {
            if page.scheduledStart == nil {
                // Said before the attempt, not after it. Every occurrence is
                // derived from the page's date, so there is nothing to repeat
                // from until it has one.
                Text("Give the page a date first — a repeat needs somewhere to start.")
            }
        }

        if repeats {
            Section {
                Picker("Every", selection: $freq) {
                    ForEach(Self.frequencies, id: \.value) { option in
                        Text(interval == 1 ? option.singular : option.plural).tag(option.value)
                    }
                }
                Stepper(
                    intervalLabel, value: $interval, in: 1...99)
            }

            if freq == .weekly {
                Section {
                    ForEach(Self.weekdayNames, id: \.number) { day in
                        Button {
                            toggle(day.number)
                        } label: {
                            HStack {
                                Text(day.name)
                                Spacer()
                                if weekdays.contains(day.number) {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                        .tint(.primary)
                    }
                } header: {
                    Text("On these days")
                } footer: {
                    // Not an error state: an empty set is a valid weekly rule
                    // meaning "the day it starts on", which is what somebody
                    // who never opens this section gets.
                    Text(
                        weekdays.isEmpty
                            ? "None chosen — it repeats on whichever day the page is on."
                            : "")
                }
            }
        }
    }

    private var isEditable: Bool {
        switch current {
        case .fixed, .none: return false
        case .never, .editable: return true
        }
    }

    private var intervalLabel: String {
        guard let unit = Self.frequencies.first(where: { $0.value == freq }) else { return "" }
        return interval == 1
            ? "Every \(unit.singular)" : "Every \(interval) \(unit.plural)"
    }

    private static let frequencies:
        [(value: RepeatFreq, singular: String, plural: String)] = [
            (.daily, "day", "days"),
            (.weekly, "week", "weeks"),
            (.monthly, "month", "months"),
            (.yearly, "year", "years"),
        ]

    /// 0 is Monday through 6 is Sunday, which is what the rule layer stores.
    ///
    /// Listed Monday-first regardless of the reader's week-start preference:
    /// this is a set, not a calendar, and renumbering it to match a Sunday-first
    /// region would put the app one off from the numbers it sends.
    private static let weekdayNames: [(number: UInt32, name: String)] = [
        (0, "Monday"), (1, "Tuesday"), (2, "Wednesday"), (3, "Thursday"),
        (4, "Friday"), (5, "Saturday"), (6, "Sunday"),
    ]

    private func toggle(_ day: UInt32) {
        if weekdays.contains(day) {
            weekdays.remove(day)
        } else {
            weekdays.insert(day)
        }
    }

    private func load() async {
        let answer = await store.pageRepeat(for: page.id) ?? .never
        current = answer
        if case .editable(let value, _) = answer {
            repeats = true
            freq = value.freq
            interval = Int(value.interval)
            weekdays = Set(value.weekdays)
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }

        let ok: Bool
        if repeats {
            ok = await store.setRepeat(
                pageId: page.id,
                to: Repeat(
                    freq: freq,
                    interval: UInt32(interval),
                    // Sorted, so the same choice always produces the same rule
                    // string. A set has no order, and an unordered rule would
                    // make every save look like a change to anything diffing
                    // the rrule.
                    weekdays: freq == .weekly ? weekdays.sorted() : []))
        } else {
            ok = await store.removeRepeat(pageId: page.id)
        }
        if ok { dismiss() }
    }
}
