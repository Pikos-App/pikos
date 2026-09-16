import PikosCore
import PikosSupport
import SwiftUI

/// Put a page on a date, move it, or take the date away: the When sheet.
///
/// Reached from When › Pick a Date… after the one-tap days, so it is for the date those do not
/// cover. A line at the top reads a typed date with quick add's parser, the day pills repeat the
/// menu's choices, and the month is open rather than behind a compact picker.
///
/// Nothing here asks to be confirmed. Tapping a day, in the pills or the month, saves it and
/// closes; the time, the end and a typed date are saved when the sheet closes, however it closes.
/// A date is easy to change back, and the notice carries Undo.
///
/// A repeating page is offered no "No Date", and one a calendar owns never reaches here; the
/// workspace refuses both anyway, because a list row can be a second old by the time a sheet opens.
struct SchedulePageSheet: View {
    enum Target {
        case page(PageFacts)
        /// Select mode's pages: one day for all of them, each keeping its own time.
        case pages([PageSummary])
    }

    let target: Target
    var onDone: () -> Void = {}

    @Environment(WorkspaceStore.self) private var store
    @Environment(SettingsStore.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var hasDate: Bool
    @State private var isTimed: Bool
    @State private var start: Date
    @State private var hasEnd: Bool
    @State private var end: Date
    @State private var typed = ""
    /// Set once the choice has been written, so closing does not write it a second time.
    @State private var isSaved = false

    init(page: PageFacts) {
        target = .page(page)
        let existing = page.scheduledStart.flatMap { StorageTimestamp.wallClock($0) }
        _hasDate = State(initialValue: page.scheduledStart != nil)
        _isTimed = State(initialValue: page.scheduledStart?.contains("T") ?? false)
        _start = State(initialValue: existing ?? Self.nextHour())
        let existingEnd = page.scheduledEnd.flatMap { StorageTimestamp.wallClock($0) }
        _hasEnd = State(initialValue: existingEnd != nil)
        _end = State(initialValue: existingEnd ?? (existing ?? Self.nextHour()).addingTimeInterval(3600))
    }

    init(pages: [PageSummary], onDone: @escaping () -> Void) {
        target = .pages(pages)
        self.onDone = onDone
        _hasDate = State(initialValue: true)
        _isTimed = State(initialValue: false)
        _start = State(initialValue: Date())
        _hasEnd = State(initialValue: false)
        _end = State(initialValue: Date())
    }

    private var isBatch: Bool {
        if case .pages = target { return true }
        return false
    }

    private var allowsNoDate: Bool {
        if case .page(let page) = target { return !page.isRecurring }
        return true
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    typedLine
                    dayPills
                    if hasDate {
                        if !isBatch {
                            Picker("Kind", selection: $isTimed) {
                                Text("All day").tag(false)
                                Text("At a time").tag(true)
                            }
                            .pickerStyle(.segmented)
                        }
                        DatePicker(
                            "Day",
                            selection: Binding(get: { start }, set: { chosen in setDay(chosen, andSave: true) }),
                            displayedComponents: .date
                        )
                        .datePickerStyle(.graphical)
                        .environment(\.calendar, settings.calendar)
                        if !isBatch {
                            endControls
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .background(.surfaceElevated)
            .navigationTitle(isBatch ? "When, for \(pageCount) pages" : "When")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onDisappear {
            guard !isSaved, hasChanged else { return }
            isSaved = true
            let choice = chosen
            Task { await save(choice) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.surfaceElevated)
    }

    private var pageCount: Int {
        if case .pages(let pages) = target { return pages.count }
        return 1
    }

    // MARK: - Typing a date

    private var typedLine: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(isBatch ? "Type a day, like friday" : "Type a date, like fri 3pm", text: $typed)
                .font(.pkBody)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit {
                    guard understood != nil else { return }
                    saveAndClose()
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(.surfaceHover, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onChange(of: typed) { _, text in readTyped(text) }
                .accessibilityLabel("Type a date")
            if let understood {
                Label(understood, systemImage: "checkmark")
                    .font(.pkUISm)
                    .foregroundStyle(.textAction)
            } else if !typed.trimmingCharacters(in: .whitespaces).isEmpty {
                Text("No date in that yet")
                    .font(.pkUISm)
                    .foregroundStyle(.textTertiary)
            }
        }
    }

    /// What the typed line last set, said back so a misread is caught before it is kept.
    @State private var understood: String?

    /// Quick add's parser on the typed line, keeping only the date it finds.
    private func readTyped(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
            let parsed = parseQuickAdd(input: trimmed, reference: WorkspaceStore.wallClock(Date())),
            let iso = Self.start(of: parsed), let date = StorageTimestamp.wallClock(iso)
        else {
            understood = nil
            return
        }
        hasDate = true
        moveStart(to: date)
        if !isBatch { isTimed = iso.contains("T") }
        let day = date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        understood =
            iso.contains("T") && !isBatch ? "\(day), \(date.formatted(date: .omitted, time: .shortened))" : day
    }

    private static func start(of result: QuickAddResult) -> String? {
        switch result {
        case .single(let input), .recurring(let input, _): return input.scheduledStart
        case .finite(let inputs): return inputs.first?.scheduledStart
        }
    }

    // MARK: - Days

    private var dayPills: some View {
        FlowLayout(spacing: 8, lineSpacing: 8) {
            ForEach(WhenChoice.allCases) { choice in
                Button {
                    choose(choice)
                } label: {
                    Pill(
                        title: choice.label, systemImage: choice.systemImage,
                        isOn: hasDate && WallClockDay.string(from: start) == choice.day())
                }
                .buttonStyle(.plain)
            }
            if allowsNoDate {
                Button {
                    hasDate = false
                    understood = nil
                    saveAndClose()
                } label: {
                    Pill(title: String(localized: "No Date"), systemImage: "calendar.badge.minus", isOn: !hasDate)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func choose(_ choice: WhenChoice) {
        guard let day = DayLabel.date(from: choice.day()) else { return }
        setDay(day, andSave: true)
    }

    /// Move to a day, keeping the time of day already chosen.
    private func setDay(_ day: Date, andSave: Bool) {
        let calendar = Calendar.current
        let time = calendar.dateComponents([.hour, .minute], from: start)
        moveStart(to: calendar.date(bySettingHour: time.hour ?? 9, minute: time.minute ?? 0, second: 0, of: day) ?? day)
        hasDate = true
        understood = nil
        if andSave { saveAndClose() }
    }

    @ViewBuilder
    private var endControls: some View {
        VStack(spacing: 12) {
            if isTimed {
                DatePicker("Starts at", selection: Binding(get: { start }, set: { moveStart(to: $0) }), displayedComponents: .hourAndMinute)
            }
            Toggle(isTimed ? "Set an end time" : "Ends on a later day", isOn: $hasEnd)
            if hasEnd {
                DatePicker(
                    "Ends", selection: $end, in: start...,
                    displayedComponents: isTimed ? [.date, .hourAndMinute] : [.date])
            }
            if !isTimed && hasEnd {
                // Worth saying: a reader who means "the 1st to the 7th" and gets six days would
                // assume a bug rather than a convention.
                Text("The end day is included, so 1 to 8 July is eight days.")
                    .font(.pkUISm)
                    .foregroundStyle(.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .font(.pkBody)
    }

    // MARK: - Saving

    /// The end follows the start by the gap already chosen, so a one-hour meeting moved to Thursday
    /// stays one hour long.
    private func moveStart(to new: Date) {
        if hasEnd { end = end.addingTimeInterval(new.timeIntervalSince(start)) }
        start = new
    }

    /// Read before dismissing: the sheet's state is not there to read once it has gone.
    private func saveAndClose() {
        isSaved = true
        let choice = chosen
        dismiss()
        Task { await save(choice) }
    }

    /// What the controls say, as the strings the workspace stores.
    private var chosen: (start: String, end: String?)? {
        guard hasDate else { return nil }
        if isTimed {
            return (WallClockDay.instant(from: start), hasEnd ? WallClockDay.instant(from: end) : nil)
        }
        return (WallClockDay.string(from: start), hasEnd ? WallClockDay.string(from: end) : nil)
    }

    private var hasChanged: Bool {
        guard case .page(let page) = target else { return false }
        return chosen?.start != page.scheduledStart || chosen?.end != page.scheduledEnd
    }

    private func save(_ chosen: (start: String, end: String?)?) async {
        switch target {
        case .pages(let pages):
            await store.schedulePages(pages, to: chosen.map { String($0.start.prefix(10)) })
        case .page(let page):
            if let chosen {
                if page.isRecurring {
                    await store.setSchedule(pageId: page.id, start: chosen.start, end: chosen.end)
                } else {
                    await store.schedule(
                        pageId: page.id, title: page.title, start: chosen.start, end: chosen.end,
                        previousStart: page.scheduledStart, previousEnd: page.scheduledEnd,
                        saying: spoken(chosen.start))
                }
            } else if page.scheduledStart != nil {
                await store.clearDate(pageId: page.id)
            }
        }
        onDone()
    }

    /// "Tomorrow" or "Fri, Sep 18, 3:00 PM", for the notice.
    private func spoken(_ iso: String) -> String {
        let day = DayLabel.relative(String(iso.prefix(10)), today: DayLabel.today())
        guard iso.contains("T"), let date = StorageTimestamp.wallClock(iso) else { return day }
        return "\(day), \(date.formatted(date: .omitted, time: .shortened))"
    }

    /// The next whole hour, in the reader's own calendar: nobody schedules anything for 14:37:22.
    private static func nextHour() -> Date {
        let calendar = Calendar.current
        let next = calendar.date(byAdding: .hour, value: 1, to: Date()) ?? Date()
        return calendar.date(
            bySettingHour: calendar.component(.hour, from: next), minute: 0, second: 0, of: next)
            ?? next
    }
}
