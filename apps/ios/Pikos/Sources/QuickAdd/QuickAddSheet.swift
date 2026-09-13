import PikosCore
import SwiftUI

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

                Section("When") {
                    Picker("Schedule", selection: $schedule) {
                        ForEach(Schedule.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: schedule) { _, new in
                        if new != appliedSchedule { scheduleIsManual = true }
                    }

                    if schedule != .none {
                        DatePicker(
                            "Date",
                            selection: $date,
                            displayedComponents: schedule == .timed
                                ? [.date, .hourAndMinute] : [.date]
                        )
                        .onChange(of: date) { _, new in
                            if new != appliedDate { scheduleIsManual = true }
                        }
                    }
                }

                if !store.fileableFolders.isEmpty {
                    Section("Folder") {
                        Picker("Folder", selection: $folderId) {
                            Text("Inbox").tag(String?.none)
                            ForEach(store.fileableFolders, id: \.id) { folder in
                                Text(folder.name).tag(String?.some(folder.id))
                            }
                        }
                        .onChange(of: folderId) { _, new in
                            if new != appliedFolderId { folderIsManual = true }
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
                        .disabled(savedTitle.isEmpty || isSaving)
                }
            }
            // Straight into the field: the whole point of quick add is that it
            // costs one tap and a sentence.
            .onAppear {
                lineFocused = true
                // A prefill never fired `onChange`, so it has not been read yet.
                if !line.isEmpty { reparse() }
            }
        }
        .presentationDetents([.medium, .large])
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
        // else the line said still applies.
        let created = await store.createPage(
            NewPage(
                title: savedTitle,
                folderId: folderId,
                tags: parsed?.tags,
                scheduledStart: manualScheduledStart
            ))
        // Priority is not a field on a new page, so it takes a second write —
        // and it has to happen, or "!urgent" is silently dropped on any line
        // whose date was picked by hand.
        if let created, let priority = parsed?.priority {
            await store.setPriority(pageId: created.id, priority: priority)
        }
        dismiss()
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
    }

    var hasAnything: Bool {
        scheduledStart != nil || !tags.isEmpty || folderQuery != nil || priority != nil
            || repeats != nil
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
        }
    }

    private var accessibilityDescription: String {
        var parts = ["Understood as \(parsed.title.isEmpty ? "no title" : parsed.title)"]
        if let repeats = parsed.repeats { parts.append(repeats) }
        if let start = parsed.scheduledStart { parts.append(friendly(start)) }
        if let priority = parsed.priority { parts.append("\(name(priority)) priority") }
        parts.append(contentsOf: parsed.tags.map { "tagged \($0)" })
        if let folder = parsed.folderQuery { parts.append("in \(folder)") }
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
