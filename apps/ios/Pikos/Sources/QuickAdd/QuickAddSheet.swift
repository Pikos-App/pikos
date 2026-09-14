import PikosCore
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
/// ## Why the understood-as summary is not decoration
///
/// A parser that quietly takes half a sentence for a date is worse than one
/// that misses it, because the title loses words with no sign that anything
/// happened. The summary row is how the boundary stays visible: it shows the
/// title that will be saved, which is the thing most likely to be wrong.
struct QuickAddSheet: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(SettingsStore.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var line: String
    @State private var folderId: String?
    @State private var schedule: Schedule = .none
    @State private var date = Date()
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
    @FocusState private var lineFocused: Bool

    /// `prefill` arrives from a `pikos://quick-add` link and is parsed on
    /// appearance, exactly as if it had been typed.
    init(prefill: String = "") {
        _line = State(initialValue: prefill)
    }

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
                    TextField("What needs doing?", text: $line, axis: .vertical)
                        .lineLimit(1...4)
                        .focused($lineFocused)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                        .onChange(of: line) { _, _ in reparse() }

                    if let parsed, parsed.hasAnything {
                        UnderstoodRow(parsed: parsed)
                    }
                }

                // One row for the two things the line may not have said,
                // rather than two sections of pickers. At the medium detent
                // with the keyboard up, the field and its chips are all that
                // fits; the pickers were below the fold on every open. The
                // chips already show what was understood — these are for
                // overriding it, and they open only when asked.
                Section {
                    HStack(spacing: 8) {
                        whenMenu
                        if !store.fileableFolders.isEmpty {
                            folderMenu
                        }
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

                    if isPickingDate && schedule != .none {
                        Picker("Schedule", selection: $schedule) {
                            ForEach(Schedule.allCases) { option in
                                Text(option.rawValue).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                        DatePicker(
                            "Date",
                            selection: $date,
                            displayedComponents: schedule == .timed
                                ? [.date, .hourAndMinute] : [.date]
                        )
                    }
                }
                .onChange(of: schedule) { _, new in
                    if new != appliedSchedule { scheduleIsManual = true }
                }
                .onChange(of: date) { _, new in
                    if new != appliedDate { scheduleIsManual = true }
                }
                .onChange(of: folderId) { _, new in
                    if new != appliedFolderId { folderIsManual = true }
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
                        .disabled(savedTitle.isEmpty || isSaving)
                }
            }
            // Straight into the field: the whole point of quick add is that it
            // costs one tap and a sentence.
            .onAppear {
                lineFocused = true
                // The preferred folder, unless the line names one. Applied here
                // rather than in `init` because the store is not reachable from
                // an initialiser, and set through `appliedFolderId` as well so
                // the parse can still override it — a default is where a page
                // goes when nothing says otherwise, and "~work" in the line
                // says otherwise.
                if !folderIsManual, let preferred = settings.defaultFolderID,
                    store.fileableFolders.contains(where: { $0.id == preferred })
                {
                    folderId = preferred
                    appliedFolderId = preferred
                }
                // A prefill never fired `onChange`, so it has not been read yet.
                if !line.isEmpty { reparse() }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    /// Whether the date pickers are unfolded under the row.
    @State private var isPickingDate = false

    /// When the page will be, as a menu: the three answers people give
    /// without a picker, and the picker for the rest.
    ///
    /// The label is the current answer, so the row reads as a summary when
    /// closed — "Tomorrow 3:00 PM" — and the parse's answer is what it shows
    /// until the user changes it.
    private var whenMenu: some View {
        Menu {
            Button("Today") { choose(day: Date()) }
            Button("Tomorrow") { choose(day: Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()) }
            Button("Pick a date…") {
                if schedule == .none { schedule = .allDay }
                isPickingDate = true
            }
            if schedule != .none {
                Divider()
                Button("No date", role: .destructive) {
                    schedule = .none
                    isPickingDate = false
                }
            }
        } label: {
            Label(whenLabel, systemImage: "calendar")
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
        switch schedule {
        case .none: return String(localized: "No date")
        case .allDay: return date.formatted(date: .abbreviated, time: .omitted)
        case .timed: return date.formatted(date: .abbreviated, time: .shortened)
        }
    }

    private var folderMenu: some View {
        Menu {
            Picker("Folder", selection: $folderId) {
                Label("Inbox", systemImage: "tray").tag(String?.none)
                ForEach(store.fileableFolders, id: \.id) { folder in
                    Label(folder.name, systemImage: "folder").tag(String?.some(folder.id))
                }
            }
        } label: {
            Label(folderLabel, systemImage: "folder")
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
            } else {
                schedule = .none
            }
            appliedSchedule = schedule
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
            _ = await store.createFromQuickAdd(
                line, reference: parsed?.reference ?? Date(), folderId: folderId)
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
                scheduledStart: manualScheduledStart
            ))
        guard let created else {
            dismiss()
            return
        }
        // Priority is not a field on a new page, so it takes a second write —
        // and it has to happen, or "!urgent" is silently dropped on any line
        // whose date was picked by hand.
        if let priority = parsed?.priority {
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
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = schedule == .allDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss"
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

/// What the line was understood to mean, shown under the field.
private struct UnderstoodRow: View {
    let parsed: ParsedLine

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The title first and on its own line: it is what the parse most
            // plausibly got wrong, and the only part the user cannot see by
            // looking at the controls.
            Text(parsed.title.isEmpty ? "No title left" : parsed.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(parsed.title.isEmpty ? .secondary : .primary)

            ViewThatFits(in: .horizontal) {
                chips
                ScrollView(.horizontal, showsIndicators: false) { chips }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityDescription)
    }

    private var chips: some View {
        HStack(spacing: 6) {
            if let repeats = parsed.repeats {
                Chip(text: repeats, icon: "repeat")
            }
            if let start = parsed.scheduledStart {
                Chip(text: friendly(start), icon: "calendar")
            }
            if let priority = parsed.priority {
                Chip(text: name(priority), icon: "exclamationmark")
            }
            // Offsets rather than the tag itself: "#work #work" is a
            // perfectly typeable line, and duplicate ids confuse SwiftUI.
            ForEach(Array(parsed.tags.enumerated()), id: \.offset) { _, tag in
                Chip(text: tag, icon: "number")
            }
            if let folder = parsed.folderQuery {
                Chip(text: folder, icon: "folder")
            }
            if let reminder = parsed.reminderLabel {
                Chip(text: reminder, icon: "bell")
            }
            if parsed.content != nil {
                Chip(text: "Note", icon: "text.alignleft")
            }
        }
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

    /// A stored wall-clock string in the reader's own formatting.
    private func friendly(_ iso: String) -> String {
        guard let date = QuickAddSheet.wallClock(iso) else { return iso }
        return date.formatted(
            date: .abbreviated,
            time: iso.contains("T") ? .shortened : .omitted)
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

private struct Chip: View {
    let text: String
    let icon: String

    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.quaternary, in: Capsule())
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}
