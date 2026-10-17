import PikosCore
import PikosSupport
import SwiftUI
import UIKit

/// Create a page without leaving the list.
///
/// ## Typing and tapping, not one or the other
///
/// The line is parsed as it is typed — "call the plumber tomorrow at 3pm
/// #home !urgent" becomes a page titled "call the plumber", tagged, urgent, and
/// scheduled — by the same Rust parser the desktop's is graded against, so a
/// line means the same thing on both.
///
/// The native controls stay. On a phone a date picker beats typing "tomorrow at
/// 3pm" with a thumb, and nobody should have to learn a syntax to use quick
/// add. So the parse *fills in* the controls rather than replacing them, and
/// touching a control wins: once you have picked a date by hand, a later
/// keystroke will not move it out from under you.
///
/// ## Why the line is coloured
///
/// A parser that quietly takes half a sentence for a date is worse than one
/// that misses it, because the title loses words with no sign that anything
/// happened. The words it read are coloured where they were typed, so whatever
/// is left in the ordinary colour is the title that will be saved. A separate
/// summary of the title did the same job one line further from the eye.
///
/// ## Where it opens
///
/// On the view it was opened from: Today opens on today, a folder on that
/// folder, the calendar on the day it shows. A page typed into a view should
/// land in it, and anything typed in the line still overrules the view.
struct QuickAddSheet: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(SettingsStore.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @Environment(Route.self) private var route
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Added or cancelled. A sheet swiped away without either keeps its line as a draft for the next
    /// open, so a sentence is never lost to a stray swipe.
    @State private var isFinished = false

    @State private var line: String
    @State private var folderId: String?
    @State private var schedule: Schedule = .none
    @State private var date = Date()
    /// How long a timed page runs, when a calendar slot was dragged out to a length.
    @State private var minutes: Int?
    @State private var isSaving = false
    /// Set once the user touches a control, after which the parse stops
    /// steering it.
    @State private var scheduleIsManual = false
    @State private var folderIsManual = false
    /// What the parse last wrote into each control.
    ///
    /// The parse writes to the same controls the user does, and `onChange`
    /// cannot tell the two apart — it fires on the next update pass, so a flag
    /// raised around the write is already lowered by the time it runs. Without
    /// this the first parsed date would convince the sheet the user had taken
    /// over, and every keystroke after it would be ignored. Comparing the new
    /// value against what the parse put there does not depend on when the
    /// handler runs.
    @State private var appliedSchedule: Schedule = .none
    @State private var appliedDate: Date?
    @State private var appliedFolderId: String?
    @State private var parsed: ParsedLine?
    /// The priority, from the line or from the chip. Manual once the chip
    /// has been used, like the schedule and the folder.
    @State private var priority: Priority?
    @State private var priorityIsManual = false

    /// `prefill` arrives from a `pikos://quick-add` link and is parsed on
    /// appearance, exactly as if it had been typed. `prefillDate` arrives
    /// from a long press on a calendar slot and counts as a choice already
    /// made: the picker opens on it, and a date the line happens to mention
    /// does not move it — the reader pressed *there*.
    init(
        prefill: String = "", prefillDate: Date? = nil, prefillMinutes: Int? = nil,
        context: Route.QuickAddContext = .init()
    ) {
        _line = State(initialValue: prefill)
        self.context = context
        if let prefillDate {
            _date = State(initialValue: prefillDate)
            _minutes = State(initialValue: prefillMinutes)
            _schedule = State(initialValue: .timed)
            _scheduleIsManual = State(initialValue: true)
        } else if let day = context.day.flatMap({ DayLabel.date(from: $0) }) {
            _date = State(initialValue: day)
            _schedule = State(initialValue: .allDay)
            _appliedSchedule = State(initialValue: .allDay)
            _appliedDate = State(initialValue: day)
        }
    }

    private let context: Route.QuickAddContext

    /// The view's own day, which a line with no date of its own keeps.
    private var contextDay: Date? {
        context.day.flatMap { DayLabel.date(from: $0) }
    }

    private enum Schedule: String, CaseIterable, Identifiable {
        case none = "No date"
        case allDay = "All day"
        case timed = "At a time"

        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("New page")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            isFinished = true
                            dismiss()
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add") { Task { await save() } }
                            .disabled(!canSave)
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.surfaceElevated)
        .presentationCornerRadius(20)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuickAddField(
                text: $line,
                parsedTitle: parsed?.hasAnything == true ? parsed?.title : nil,
                priority: parsed?.priority,
                focusOnAppear: true,
                onSubmit: { Task { await save() } }
            )
            .onChange(of: line) { _, _ in reparse() }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 12)

            if let parsed, parsed.hasAnything {
                ExtrasRow(parsed: parsed, unmatchedFolder: unmatchedFolder)
                    .padding(.horizontal, 20)
                    .padding(.bottom, parsed.hasExtras || unmatchedFolder != nil ? 12 : 0)
                    .transition(.opacity)
            }

            Rectangle().fill(.borderSecondary).frame(height: 1)

            chipRow
                .padding(.vertical, 12)

            if isPickingDate && schedule != .none {
                VStack(spacing: 10) {
                    Picker("Schedule", selection: $schedule) {
                        ForEach(Schedule.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                    DatePicker(
                        "Date",
                        selection: $date,
                        displayedComponents: schedule == .timed ? [.date, .hourAndMinute] : [.date]
                    )
                    .font(.pkBodySm)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 12)
            }

            Spacer(minLength: 0)

            // Only before the first word: once there is a sentence, its lines need the room more.
            if line.isEmpty {
                Text("Type a date, !priority, #tag or ~folder, or set them with the buttons above.")
                    .font(.pkUISm)
                    .foregroundStyle(.textTertiary)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 12)
            }
        }
        .background(.surfaceElevated)
        .animation(reduceMotion ? nil : .pkQuick, value: parsed?.hasAnything)
        .animation(reduceMotion ? nil : .pkQuick, value: isPickingDate)
        .onChange(of: schedule) { _, new in
            if new != appliedSchedule { scheduleIsManual = true }
        }
        .onChange(of: date) { _, new in
            if new != appliedDate { scheduleIsManual = true }
        }
        .onChange(of: folderId) { _, new in
            if new != appliedFolderId { folderIsManual = true }
        }
        .onAppear {
            // Applied through `appliedFolderId` so "~work" in the line still wins over the view's folder.
            if !folderIsManual, let preferred = context.folderId ?? settings.defaultFolderID,
                store.fileableFolders.contains(where: { $0.id == preferred })
            {
                folderId = preferred
                appliedFolderId = preferred
            }
            // A prefill never fired `onChange`, so it has not been read yet.
            if !line.isEmpty { reparse() }
        }
        .onDisappear {
            route.quickAddDraft = isFinished ? "" : line
        }
    }

    private var canSave: Bool { !savedTitle.isEmpty && !isSaving }

    /// A "~folder" the line named that matches none of the reader's, so it is not silently lost.
    private var unmatchedFolder: String? {
        guard let query = parsed?.folderQuery else { return nil }
        let matched = store.fileableFolders.contains {
            $0.name.compare(query, options: .caseInsensitive) == .orderedSame
        }
        return matched ? nil : query
    }

    /// Whether the date pickers are unfolded under the row.
    @State private var isPickingDate = false

    @ViewBuilder
    private var chipRow: some View {
        if typeSize.isAccessibilitySize {
            // A sideways scroll nobody can see the end of hides the folder chip; wrapped, all three show.
            FlowLayout(spacing: 8, lineSpacing: 8) { chips }
                .padding(.horizontal, 20)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) { chips }
                    .padding(.horizontal, 20)
            }
        }
    }

    @ViewBuilder
    private var chips: some View {
        whenMenu
        priorityMenu
        if !store.fileableFolders.isEmpty {
            folderMenu
        }
    }

    /// Priority is the one thing about a task usually decided after the words are typed.
    private var priorityMenu: some View {
        Menu {
            Picker(
                "Priority",
                selection: Binding(
                    get: { priority.flatMap { value in PagePriority.allCases.first { $0.value == value }?.stored } ?? 0 },
                    set: { stored in
                        priority = PagePriority(stored: stored)?.value
                        priorityIsManual = true
                    })
            ) {
                PriorityChoices()
            }
            .pickerStyle(.inline)
        } label: {
            ControlChip(
                title: priorityLabel, mark: priorityLevel?.mark ?? "—",
                tint: priority == nil ? nil : priorityLevel?.textColor)
        }
        .accessibilityLabel("Priority: \(priorityLabel)")
    }

    private var priorityLevel: PagePriority? {
        priority.flatMap { value in PagePriority.allCases.first { $0.value == value } }
    }

    private var priorityLabel: String {
        priorityLevel?.name ?? String(localized: "Priority")
    }

    /// The label is the current answer, so the closed row reads as a summary.
    private var whenMenu: some View {
        Menu {
            WhenMenuItems(
                onChoose: { choice in
                    if let day = DayLabel.date(from: choice.day()) { choose(day: day) }
                },
                onPickDate: {
                    if schedule == .none { schedule = .allDay }
                    isPickingDate = true
                },
                onClear: schedule == .none
                    ? nil
                    : {
                        schedule = .none
                        isPickingDate = false
                    })
        } label: {
            ControlChip(
                title: whenLabel, systemImage: "calendar",
                tint: schedule == .none ? nil : .textAction)
        }
        .accessibilityLabel("When: \(whenLabel)")
    }

    /// Move the date to a day, keeping the time of day the page already has.
    private func choose(day: Date) {
        let calendar = Calendar.current
        let time = calendar.dateComponents([.hour, .minute], from: date)
        date =
            calendar.date(
                bySettingHour: time.hour ?? 9, minute: time.minute ?? 0, second: 0, of: day)
            ?? day
        if schedule == .none { schedule = .allDay }
    }

    private var whenLabel: String {
        guard schedule != .none else { return String(localized: "No date") }
        let calendar = Calendar.current
        let day: String
        if calendar.isDateInToday(date) {
            day = String(localized: "Today")
        } else if calendar.isDateInTomorrow(date) {
            day = String(localized: "Tomorrow")
        } else {
            day = date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        guard schedule == .timed else { return day }
        guard let end = manualEnd else { return "\(day), \(ClockTime.string(date))" }
        return "\(day), \(ClockTime.string(date)) – \(ClockTime.string(end))"
    }

    private var manualEnd: Date? {
        guard schedule == .timed, let minutes else { return nil }
        return date.addingTimeInterval(TimeInterval(minutes * 60))
    }

    private var folderMenu: some View {
        Menu {
            Picker("Folder", selection: $folderId) {
                FolderChoices(folders: store.fileableFolders)
            }
        } label: {
            ControlChip(
                title: folderLabel,
                systemImage: folderId == nil ? "tray" : "folder",
                dot: store.fileableFolders.first { $0.id == folderId }.flatMap { Color(hex: $0.color) })
        }
        .accessibilityLabel("Folder: \(folderLabel)")
    }

    private var folderLabel: String {
        store.fileableFolders.first { $0.id == folderId }?.name ?? String(localized: "Inbox")
    }

    /// The title as it will actually be saved.
    ///
    /// Always the parsed title once there is a parse, even when the date came
    /// from the picker instead — stripping `#work` out of the title is the
    /// parser's job either way, and taking the raw line here would file a page
    /// called "#work buy milk" that was also tagged `work`.
    ///
    /// A line of nothing but markers parses to an empty title, which leaves the
    /// Add button disabled and the summary saying so. That is the honest
    /// outcome: there is nothing to call the page.
    private var savedTitle: String {
        if let parsed { return parsed.title }
        return line.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether saving goes through the quick-add path, which is the only one
    /// that can produce a recurrence or a series.
    ///
    /// A hand-picked date overrules a parsed one — except on a line that also
    /// asked for a recurrence, where there is no way to express "this rule but
    /// that start" and dropping the rule is the larger loss. The summary row
    /// shows the recurrence, so it is visible that it won.
    private var usesParse: Bool {
        guard let parsed else { return false }
        return !scheduleIsManual || parsed.repeats != nil
    }

    private func reparse() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            parsed = nil
            if !priorityIsManual { priority = nil }
            return
        }
        parsed = ParsedLine(line: trimmed, reference: Date())
        applyToControls()
    }

    /// Move the pickers to match the parse, for as long as the user has left
    /// them alone.
    private func applyToControls() {
        guard let parsed else { return }

        if !scheduleIsManual {
            if let start = parsed.scheduledStart, let at = Self.wallClock(start) {
                date = at
                appliedDate = at
                schedule = start.contains("T") ? .timed : .allDay
            } else if let contextDay {
                date = contextDay
                appliedDate = contextDay
                schedule = .allDay
            } else {
                schedule = .none
            }
            appliedSchedule = schedule
        }

        if !priorityIsManual {
            priority = parsed.priority
        }

        if !folderIsManual, let query = parsed.folderQuery,
            let match = store.fileableFolders.first(where: {
                $0.name.compare(query, options: .caseInsensitive) == .orderedSame
            })
        {
            folderId = match.id
            appliedFolderId = match.id
        }
    }

    private func save() async {
        guard !savedTitle.isEmpty, !isSaving else { return }
        isSaving = true
        isFinished = true
        defer { isSaving = false }
        // Felt before the sheet goes: the page lands in a list the user may
        // not be looking at (the notice says where), and a tap that is felt
        // to land does not need to be seen to. A generator call rather than
        // `.sensoryFeedback`, whose trigger would be on a view that is
        // dismissing.
        UINotificationFeedbackGenerator().notificationOccurred(.success)

        if usesParse {
            // A folder picked by hand is still honoured — the parser only ever
            // reports a folder *name*, and matching it to one is this side's
            // job, so passing the id through covers both cases.
            // The same reference the summary was computed from, not the clock
            // at the moment Add was tapped. `createFromQuickAdd` takes one for
            // exactly this reason, and defaulting it here would let a line
            // typed at 23:59 land on a different day than the one shown.
            let created = await store.createFromQuickAdd(
                line, reference: parsed?.reference ?? Date(), folderId: folderId)
            // The chip overrules the line, the way a picked date does: a
            // priority chosen by hand after typing "!high" is the later
            // decision, and "None" chosen by hand is a real one.
            if priorityIsManual, let first = created.first, priority != parsed?.priority {
                await store.setPriority(pageId: first.id, priority: priority)
            }
            dismiss()
            return
        }

        // The date came from the picker, so the page is built here. Everything
        // else the line said still applies — the body after "//" becomes the
        // document, through the same builder the workspace uses.
        let created = await store.createPage(
            NewPage(
                title: savedTitle,
                folderId: folderId,
                content: parsed?.content.map { plainTextToDocument(text: $0) },
                tags: parsed?.tags,
                scheduledStart: manualScheduledStart,
                scheduledEnd: manualEnd.map(Self.storedWallClock)
            ))
        guard let created else {
            dismiss()
            return
        }
        // Priority is not a field on a new page, so it takes a second write —
        // and it has to happen, or "!urgent" is silently dropped on any line
        // whose date was picked by hand. The chip's answer, when there is
        // one, is already in `priority`; otherwise it is the line's.
        if let priority {
            await store.setPriority(pageId: created.id, priority: priority)
        }
        // Reminders are rows of their own, and were resolved by the parser
        // against the shape the *line* had. The picker may have chosen the
        // other shape, so they are re-shaped here the way the parser would
        // have: an all-day page carries the day-before anchor and nothing
        // else, a timed one carries minutes — with "the day before" read as
        // a day's worth of them.
        for minutes in manualReminders {
            await store.addReminder(pageId: created.id, minutesBefore: minutes)
        }
        dismiss()
    }

    /// The parsed reminders, re-shaped for the schedule the picker chose.
    private var manualReminders: [Int64] {
        guard let leads = parsed?.reminders, !leads.isEmpty, schedule != .none else { return [] }
        if schedule == .allDay { return [ParsedLine.dayBeforeMinutes] }
        let minutes = leads.map { $0 == ParsedLine.dayBeforeMinutes ? 1440 : $0 }
        return Array(Set(minutes)).sorted()
    }

    /// The picked date as the wall-clock string the workspace stores.
    private var manualScheduledStart: String? {
        guard schedule != .none else { return nil }
        guard schedule == .timed else {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter.string(from: date)
        }
        return Self.storedWallClock(date)
    }

    private static func storedWallClock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter.string(from: date)
    }

    /// Read a stored wall-clock string back into a `Date` for the picker.
    ///
    /// No timezone conversion in either direction: the string is a wall clock,
    /// and the picker shows a wall clock. `nonisolated` so the parse helper,
    /// which is not main-actor bound, can use it too.
    nonisolated static func wallClock(_ iso: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = iso.contains("T") ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd"
        return formatter.date(from: iso)
    }
}

/// What the parser made of one line, flattened to what the sheet shows.
///
/// The parse itself returns one page, several, or a recurring one; the sheet
/// only ever displays the first, because that is what the summary is for —
/// telling the user what their words did, not reproducing the whole result.
struct ParsedLine {
    var title: String = ""
    var scheduledStart: String?
    var tags: [String] = []
    var folderQuery: String?
    var priority: Priority?
    /// Set when the line produced a rule or a series, with a phrase describing
    /// it ("every weekday", "3 pages").
    var repeats: String?
    /// Reminder leads in minutes before the start, or the day-before anchor.
    /// Empty when none were asked for, or when there was no date to anchor
    /// them to — the words stay in the title then, and the parser says so by
    /// leaving them there.
    var reminders: [Int64] = []
    /// The body typed after "//", kept exactly as typed.
    var content: String?

    /// The `minutes_before` value that means "the day before" on an all-day
    /// page rather than a count of minutes — the data layer's sentinel, which
    /// the parser hands over for any lead on an all-day page.
    static let dayBeforeMinutes: Int64 = -2

    /// The clock this line was read against.
    ///
    /// Kept so saving can resolve against the same instant the summary was
    /// computed from. "tomorrow" typed at 23:59:58 and saved three seconds
    /// later must not mean two different days.
    let reference: Date

    init(line: String, reference: Date) {
        self.reference = reference
        guard
            let result = parseQuickAdd(
                input: line, reference: WorkspaceStore.wallClock(reference))
        else { return }

        switch result {
        case .single(let input):
            apply(input)
        case .recurring(let input, let rrule):
            apply(input)
            repeats = Self.describe(rrule: rrule)
        case .finite(let inputs):
            guard let first = inputs.first else { return }
            apply(first)
            repeats = "\(inputs.count) pages"
        }
    }

    private mutating func apply(_ input: QuickAddInput) {
        title = input.title
        scheduledStart = input.scheduledStart
        tags = input.tags
        folderQuery = input.folderQuery
        if case .set(let value) = input.priority { priority = value }
        reminders = input.reminderMinutes
        content = input.content
    }

    var hasAnything: Bool {
        scheduledStart != nil || !tags.isEmpty || folderQuery != nil || priority != nil
            || repeats != nil || !reminders.isEmpty || content != nil
    }

    /// What the line said that neither the colouring nor a chip below shows.
    var hasExtras: Bool {
        repeats != nil || !reminders.isEmpty || content != nil
    }

    /// The reminders in words: "30 min before", "the day before".
    var reminderLabel: String? {
        guard !reminders.isEmpty else { return nil }
        let parts = reminders.map { minutes -> String in
            if minutes == Self.dayBeforeMinutes { return "the day before" }
            if minutes == 0 { return "at the time" }
            if minutes % 1440 == 0 {
                let days = minutes / 1440
                return days == 1 ? "1 day before" : "\(days) days before"
            }
            if minutes % 60 == 0 {
                let hours = minutes / 60
                return hours == 1 ? "1 hour before" : "\(hours) hours before"
            }
            return "\(minutes) min before"
        }
        return "Remind " + parts.joined(separator: ", ")
    }

    /// A rule in words. Deliberately shallow — the point is to confirm that
    /// *something* recurring was understood, not to render RFC 5545.
    private static func describe(rrule: String) -> String {
        let fields = rrule.split(separator: ";").reduce(into: [String: String]()) { map, field in
            let parts = field.split(separator: "=", maxSplits: 1)
            if parts.count == 2 { map[String(parts[0])] = String(parts[1]) }
        }
        let every = fields["INTERVAL"].flatMap(Int.init).map { $0 > 1 ? "every \($0) " : "" } ?? ""
        let unit: String
        switch fields["FREQ"] {
        case "DAILY": unit = "day"
        case "WEEKLY": unit = "week"
        case "MONTHLY": unit = "month"
        case "YEARLY": unit = "year"
        default: unit = "repeat"
        }
        var phrase = every.isEmpty ? "every \(unit)" : "\(every)\(unit)s"
        if let days = fields["BYDAY"] {
            phrase += " on \(days.replacingOccurrences(of: ",", with: ", "))"
        }
        if let count = fields["COUNT"] {
            phrase += ", \(count) times"
        } else if fields["UNTIL"] != nil {
            phrase += ", until a date"
        }
        return phrase
    }
}

/// What the line said that has no control and no colour of its own: a repeat, a reminder, a note, a
/// folder name that matches none. Also where VoiceOver hears the whole reading, since colour is
/// not read aloud.
private struct ExtrasRow: View {
    let parsed: ParsedLine
    let unmatchedFolder: String?

    var body: some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            if let repeats = parsed.repeats {
                Chip(text: repeats, icon: "repeat", tint: .textAction)
            }
            if let unmatchedFolder {
                Chip(text: String(localized: "No folder called \(unmatchedFolder)"), icon: "folder", tint: .textSecondary)
            }
            if let reminder = parsed.reminderLabel {
                Chip(text: reminder, icon: "bell", tint: .textSecondary)
            }
            if parsed.content != nil {
                Chip(text: String(localized: "Note"), icon: "text.alignleft", tint: .textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityDescription)
    }

    private var accessibilityDescription: String {
        var parts = ["Understood as \(parsed.title.isEmpty ? "no title" : parsed.title)"]
        if let repeats = parsed.repeats { parts.append(repeats) }
        if let start = parsed.scheduledStart { parts.append(friendly(start)) }
        if let priority = parsed.priority { parts.append("\(name(priority)) priority") }
        parts.append(contentsOf: parsed.tags.map { "tagged \($0)" })
        if let folder = parsed.folderQuery { parts.append("in \(folder)") }
        if let reminder = parsed.reminderLabel { parts.append(reminder) }
        if parsed.content != nil { parts.append("with a note") }
        return parts.joined(separator: ", ")
    }

    private func friendly(_ iso: String) -> String {
        guard let date = QuickAddSheet.wallClock(iso) else { return iso }
        let calendar = Calendar.current
        let day =
            calendar.isDateInToday(date)
            ? String(localized: "Today")
            : calendar.isDateInTomorrow(date)
                ? String(localized: "Tomorrow")
                : date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        guard iso.contains("T") else { return day }
        return "\(day), \(ClockTime.string(date))"
    }

    private func name(_ priority: Priority) -> String {
        switch priority {
        case .urgent: return "Urgent"
        case .high: return "High"
        case .medium: return "Medium"
        case .low: return "Low"
        }
    }
}

/// A parsed fact, in the desktop's chip: a small rounded tag on the inset surface.
private struct Chip: View {
    let text: String
    let icon: String?
    let tint: Color

    var body: some View {
        HStack(spacing: 4) {
            if let icon {
                Image(systemName: icon).font(.system(size: 10, weight: .semibold))
            }
            Text(text).lineLimit(1)
        }
        .font(.pkUISm)
        .foregroundStyle(tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(.surfaceInset, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// An override control under the divider: outlined until it holds an answer.
private struct ControlChip: View {
    let title: String
    var systemImage: String? = nil
    var mark: String? = nil
    var tint: Color? = nil
    var dot: Color? = nil

    var body: some View {
        HStack(spacing: 6) {
            if let dot {
                Circle().fill(dot).frame(width: 7, height: 7)
            } else if let mark {
                Text(mark).fontWeight(.heavy)
            } else if let systemImage {
                Image(systemName: systemImage).font(.system(size: 13, weight: .medium))
            }
            Text(title).lineLimit(1)
        }
        .font(.pkUI)
        .foregroundStyle(tint ?? .textSecondary)
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(Capsule().fill(tint == nil && dot == nil ? Color.clear : Color.surfaceHover))
        .overlay(Capsule().strokeBorder(.borderSecondary, lineWidth: 1))
        .fixedSize()
    }
}
