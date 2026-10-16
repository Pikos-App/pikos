import PikosCore
import PikosSupport
import SwiftUI

/// How often a page repeats: the desktop's presets by name, one tap each, Custom for the rest,
/// and when it stops.
///
/// Frequency, how many of them between runs, which weekdays, a week of the month, and an end. A
/// rule that says more, such as "every 15 March" or the fifth Friday, keeps that part as it is
/// while its interval or end changes, and a new frequency replaces it, as on the desktop. The
/// workspace decides what can be edited and says so through `PageRepeat`; this screen only draws
/// the answer.
struct RepeatSheet: View {
    let page: PageFacts

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var current: PageRepeat?
    @State private var freq: RepeatFreq = .weekly
    @State private var interval = 1
    @State private var weekdays: Set<UInt32> = []
    @State private var monthlyByWeekday = false
    @State private var ends: RepeatEnds = .never
    @State private var repeats = false
    @State private var isCustom = false
    @State private var isSaving = false
    /// The rule's own pattern when it says more than these controls hold, and the frequency it
    /// belongs to.
    @State private var kept: (freq: RepeatFreq, label: String)?
    /// An end being nudged, saved once the stepper or picker has been still for a moment.
    @State private var pendingEndsSave: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            Form {
                Group {
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
                                "This repeat is more detailed than Pikos can edit on iPhone. It still works, and you can change it on the desktop."
                            )
                        }

                    case .never, .editable:
                        editor
                    }
                }
                .pikosFormRows()
            }
            .navigationTitle("Repeat")
            .pikosFormStyle()
            .navigationBarTitleDisplayMode(.inline)
            .disabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
        }
        .onDisappear {
            guard isEditable, repeats, page.scheduledStart != nil else { return }
            if isCustom {
                saveCustom()
            } else if let pending = pendingEndsSave {
                pending.cancel()
                saveEnds()
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var editor: some View {
        Section {
            ForEach(presets, id: \.title) { preset in
                Button {
                    Task { await choose(preset) }
                } label: {
                    HStack {
                        Text(preset.title).foregroundStyle(.textPrimary)
                        Spacer()
                        if !isCustom && current.map(preset.matches) == true {
                            Image(systemName: "checkmark").foregroundStyle(.textAction)
                        }
                    }
                }
                .disabled(preset.rule != nil && page.scheduledStart == nil)
            }
            Button {
                isCustom = true
                repeats = true
            } label: {
                HStack {
                    Text("Custom…").foregroundStyle(.textPrimary)
                    Spacer()
                    if isCustom {
                        Image(systemName: "checkmark").foregroundStyle(.textAction)
                    }
                }
            }
            .disabled(page.scheduledStart == nil)
        } footer: {
            if page.scheduledStart == nil {
                // Every occurrence is derived from the page's date, so there is nothing to repeat
                // from until it has one.
                Text("Give the page a date first. A repeat needs somewhere to start.")
            }
        }

        if isCustom && repeats {
            Section {
                Picker("Every", selection: $freq) {
                    ForEach(Self.frequencies, id: \.value) { option in
                        Text(interval == 1 ? option.singular : option.plural).tag(option.value)
                    }
                }
                Stepper(
                    intervalLabel, value: $interval, in: 1...99)
                if let keptLabel {
                    LabeledContent("Pattern", value: keptLabel)
                } else if freq == .monthly {
                    Picker("On", selection: $monthlyByWeekday) {
                        Text(anchor.dayOfMonthLabel).tag(false)
                        Text(anchor.weekOfMonthLabel).tag(true)
                    }
                }
            } footer: {
                if keptLabel != nil {
                    Text("Choosing another frequency replaces this pattern.")
                }
            }

            if freq == .weekly && keptLabel == nil {
                Section {
                    ForEach(Self.weekdayNames, id: \.number) { day in
                        Button {
                            toggle(day.number)
                        } label: {
                            HStack {
                                Text(day.name).foregroundStyle(.textPrimary)
                                Spacer()
                                if weekdays.contains(day.number) {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.textAction)
                                }
                            }
                        }
                    }
                } header: {
                    Text("On these days")
                } footer: {
                    // Not an error state: an empty set is a valid weekly rule
                    // meaning "the day it starts on", which is what somebody
                    // who never opens this section gets.
                    Text(
                        weekdays.isEmpty
                            ? "None chosen, so it repeats on whichever day the page is on."
                            : "")
                }
            }
        }

        if repeats {
            endsSection
        }
    }

    /// Kept across preset taps, as the desktop keeps it: changing how often something repeats is
    /// not a decision about when it stops.
    private var endsSection: some View {
        Section {
            Picker("Ends", selection: endKind) {
                Text("Never").tag(EndKind.never)
                Text("On a Day").tag(EndKind.onDay)
                Text("After").tag(EndKind.afterCount)
            }
            switch ends {
            case .never:
                EmptyView()
            case .onDay:
                DatePicker("Last day", selection: endDay, in: anchor.date..., displayedComponents: .date)
            case .afterCount(let count):
                Stepper(
                    count == 1 ? String(localized: "Once") : String(localized: "\(count) times"),
                    value: endCount, in: 1...999)
            }
        } header: {
            Text("Ends")
        }
    }

    private enum EndKind: Hashable { case never, onDay, afterCount }

    private var endKind: Binding<EndKind> {
        Binding(
            get: {
                switch ends {
                case .never: return .never
                case .onDay: return .onDay
                case .afterCount: return .afterCount
                }
            },
            set: { kind in
                switch kind {
                case .never: setEnds(.never)
                case .onDay:
                    let monthOut = Calendar.current.date(byAdding: .month, value: 1, to: anchor.date) ?? anchor.date
                    setEnds(.onDay(day: DayLabel.today(now: monthOut)))
                case .afterCount: setEnds(.afterCount(count: 10))
                }
            })
    }

    private var endDay: Binding<Date> {
        Binding(
            get: {
                if case .onDay(let day) = ends, let date = DayLabel.date(from: day) { return date }
                return anchor.date
            },
            set: { setEnds(.onDay(day: DayLabel.today(now: $0))) })
    }

    private var endCount: Binding<Int> {
        Binding(
            get: {
                if case .afterCount(let count) = ends { return Int(count) }
                return 1
            },
            set: { setEnds(.afterCount(count: UInt32($0))) })
    }

    /// Applied as chosen. A custom rule carries it when the sheet closes; a preset's is saved here.
    private func setEnds(_ value: RepeatEnds) {
        guard value != ends else { return }
        ends = value
        guard !isCustom else { return }
        pendingEndsSave?.cancel()
        pendingEndsSave = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            pendingEndsSave = nil
            saveEnds()
        }
    }

    private func saveEnds() {
        guard case .editable(let value, let label) = current else { return }
        var rule = value
        rule.ends = ends
        guard rule != value else { return }
        current = .editable(repeat: rule, label: label)
        let pageId = page.id
        Task { await store.setRepeat(pageId: pageId, to: rule) }
    }

    private var isEditable: Bool {
        switch current {
        case .fixed, .none: return false
        case .never, .editable: return true
        }
    }

    /// Shown while the frequency is still the one the pattern belongs to.
    private var keptLabel: String? {
        guard let kept, kept.freq == freq else { return nil }
        return kept.label
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
        if case .editable(let value, let label) = answer {
            repeats = true
            freq = value.freq
            interval = Int(value.interval)
            weekdays = value.monthWeek == nil ? Set(value.weekdays) : []
            monthlyByWeekday = value.monthWeek != nil
            ends = value.ends
            kept = value.keepsPattern ? (value.freq, label) : nil
            isCustom = !presets.contains { $0.matches(answer) }
        }
    }

    // MARK: - Presets

    /// A repeat people pick by name, saved the moment it is tapped.
    private struct Preset {
        let title: String
        /// Nil for "Doesn't repeat".
        let rule: Repeat?

        /// The shape alone, as the desktop compares: an end is kept across presets, not part of one.
        func matches(_ answer: PageRepeat) -> Bool {
            switch answer {
            case .never: return rule == nil
            case .fixed: return false
            case .editable(let value, _):
                guard let rule, !value.keepsPattern else { return false }
                return value.freq == rule.freq && value.interval == rule.interval
                    && Set(value.weekdays) == Set(rule.weekdays) && value.monthWeek == rule.monthWeek
            }
        }
    }

    private var anchor: RepeatAnchor {
        RepeatAnchor(page.scheduledStart.flatMap { StorageTimestamp.wallClock($0) } ?? Date())
    }

    /// The desktop's presets, each named from the page's own day so "every week" says which day.
    private var presets: [Preset] {
        let anchor = anchor
        func rule(_ freq: RepeatFreq, interval: UInt32 = 1, weekdays: [UInt32] = [], monthWeek: Int32? = nil)
            -> Repeat
        {
            Repeat(freq: freq, interval: interval, weekdays: weekdays, monthWeek: monthWeek, ends: .never)
        }
        return [
            Preset(title: String(localized: "Doesn't repeat"), rule: nil),
            Preset(title: String(localized: "Every day"), rule: rule(.daily)),
            Preset(title: String(localized: "Every weekday"), rule: rule(.weekly, weekdays: [0, 1, 2, 3, 4])),
            Preset(
                title: String(localized: "Every week on \(anchor.weekdayName)"),
                rule: rule(.weekly, weekdays: [anchor.weekday])),
            Preset(
                title: String(localized: "Every 2 weeks on \(anchor.weekdayName)"),
                rule: rule(.weekly, interval: 2, weekdays: [anchor.weekday])),
            Preset(
                title: String(localized: "Every month \(anchor.dayOfMonthLabel)"),
                rule: rule(.monthly)),
            Preset(
                title: String(localized: "Every month \(anchor.weekOfMonthLabel)"),
                rule: rule(.monthly, weekdays: [anchor.weekday], monthWeek: anchor.weekOfMonth)),
            Preset(
                title: String(localized: "Every year on \(anchor.date.formatted(.dateTime.month(.abbreviated).day()))"),
                rule: rule(.yearly)),
        ]
    }

    private func choose(_ preset: Preset) async {
        isCustom = false
        if let current, preset.matches(current) {
            dismiss()
            return
        }
        isSaving = true
        defer { isSaving = false }
        let ok: Bool
        if var rule = preset.rule {
            rule.ends = ends
            ok = await store.setRepeat(pageId: page.id, to: rule)
        } else {
            ok = await store.removeRepeat(pageId: page.id)
        }
        if ok { dismiss() }
    }

    /// A custom rule is kept when the sheet closes, however it closes.
    private func saveCustom() {
        let anchor = anchor
        let keepsPattern = keptLabel != nil
        let onWeekday = freq == .monthly && monthlyByWeekday && !keepsPattern
        let rule = Repeat(
            freq: freq,
            interval: UInt32(interval),
            // Sorted, so the same choice always produces the same rule
            // string. A set has no order, and an unordered rule would
            // make every save look like a change to anything diffing
            // the rrule.
            weekdays: keepsPattern ? [] : (freq == .weekly ? weekdays.sorted() : (onWeekday ? [anchor.weekday] : [])),
            monthWeek: onWeekday ? anchor.weekOfMonth : nil,
            ends: ends,
            keepsPattern: keepsPattern)
        if case .editable(let value, _) = current, value == rule { return }
        let pageId = page.id
        Task { await store.setRepeat(pageId: pageId, to: rule) }
    }
}

/// What the presets are named from: the day a page's repeat starts on.
private struct RepeatAnchor {
    let date: Date

    init(_ date: Date) { self.date = date }

    /// Monday-first, as the rule layer numbers weekdays.
    var weekday: UInt32 {
        UInt32((Calendar.current.component(.weekday, from: date) + 5) % 7)
    }

    var weekdayName: String { date.formatted(.dateTime.weekday(.wide)) }

    /// "on the 17th".
    var dayOfMonthLabel: String {
        String(localized: "on the \(Self.ordinal(Calendar.current.component(.day, from: date)))")
    }

    /// The desktop's reading of the start's week: a day in its month's last seven is "the last",
    /// since that late it almost always means month end, and a fifth week would skip most months.
    var weekOfMonth: Int32 {
        let calendar = Calendar.current
        let day = calendar.component(.day, from: date)
        let length = calendar.range(of: .day, in: .month, for: date)?.count ?? 31
        return day + 7 > length ? -1 : Int32((day + 6) / 7)
    }

    /// "on the 3rd Tuesday", "on the last Friday".
    var weekOfMonthLabel: String {
        let week = weekOfMonth
        let position = week == -1 ? String(localized: "last") : Self.ordinal(Int(week))
        return String(localized: "on the \(position) \(weekdayName)")
    }

    private static func ordinal(_ number: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .ordinal
        return formatter.string(from: NSNumber(value: number)) ?? "\(number)"
    }
}
