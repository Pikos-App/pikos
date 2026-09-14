import PikosCore
import SwiftUI

/// The completion checkbox.
///
/// Its own view, placed beside the row's navigation link rather than inside it:
/// a Button inside a NavigationLink's label does not reliably receive the tap.
///
/// The ring is tinted by priority while the page is open — red for urgent,
/// orange for high, and so on down — which is how the desktop's row shows it
/// (`TaskCheckbox`'s border). The colour is the whole signal on purpose: a
/// separate flag icon would be one more thing in a row that already carries a
/// date, a tag and a folder, and the checkbox is the element the eye lands on
/// first anyway.
struct CompletionToggle: View {
    let isDone: Bool
    var priority: PagePriority? = nil
    let onToggle: (Bool) -> Void

    var body: some View {
        Button {
            onToggle(!isDone)
        } label: {
            Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                .imageScale(.large)
                .foregroundStyle(ringColor)
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        // A 17pt glyph is well under the 44pt minimum touch target, and this one
        // sits next to a navigation tap it must not steal.
        //
        // Order matters and is easy to get backwards: `contentShape` describes
        // the view it is applied to, so putting it before the frame would set
        // the hit area to the 17pt glyph and leave the surrounding 44pt padding
        // inert — the exact bug this is here to prevent, with no visible
        // symptom beyond taps that sometimes miss.
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        // A tick is felt as well as seen. Ticking is the most frequent thing
        // done in this list, and a tap the thumb feels land is one the eye
        // does not have to confirm.
        .sensoryFeedback(.success, trigger: isDone) { _, done in done }
        .accessibilityLabel(isDone ? "Mark as not done" : "Mark as done")
        .accessibilityValue(priority.map { "\($0.name) priority" } ?? "")
        .accessibilityAddTraits(isDone ? .isSelected : [])
    }

    private var ringColor: Color {
        if isDone { return .accentColor }
        return priority?.color ?? .secondary
    }
}

/// One page in the list, without its checkbox — see `CompletionToggle`.
struct PageRow: View {
    let page: PageSummary
    /// Whether to name the folder the page is filed in.
    ///
    /// On in the date views, where rows from every folder sit together and the
    /// folder is the one fact the heading does not give; off in a folder,
    /// where it would repeat the title of the screen on every row.
    var showsFolder = false

    /// Read from the environment rather than passed in. Density is a property
    /// of every row in the app, not of one list, and a parameter would have to
    /// be threaded through each new place a row appears — the failure being a
    /// single section that quietly ignores the setting.
    @Environment(SettingsStore.self) private var settings
    @Environment(WorkspaceStore.self) private var store

    private var isDone: Bool { page.status == "done" }

    /// How many tags fit on a row before the rest become a count. Two is what
    /// a phone-width row holds beside a title without pushing the title to a
    /// third line at the larger text sizes.
    private static let shownTags = 2

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(page.title.isEmpty ? "Untitled" : page.title)
                    .font(.body)
                    .strikethrough(isDone, color: .secondary)
                    .foregroundStyle(isDone ? Color.secondary : Color.primary)
                    .lineLimit(2)

                if let subtitle = page.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if hasMeta {
                    HStack(spacing: 6) {
                        // A repeating page's checkbox does something different —
                        // it completes one occurrence and advances the series
                        // rather than finishing it. Marked so that is not a
                        // surprise.
                        if page.isRecurring {
                            Image(systemName: "repeat")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .accessibilityLabel("Repeats")
                        }
                        if let scheduled = page.scheduledStart {
                            ScheduleLabel(iso: scheduled, isDone: isDone)
                        }
                        if showsFolder, let folder {
                            FolderLabel(folder: folder)
                        }
                    }
                }
            }

            Spacer(minLength: 0)

            if !page.tags.isEmpty {
                tagChips
            }
        }
        .padding(.vertical, 2 + settings.listDensity.rowPadding)
    }

    private var hasMeta: Bool {
        page.isRecurring || page.scheduledStart != nil || (showsFolder && folder != nil)
    }

    private var folder: Folder? {
        guard let id = page.folderId else { return nil }
        return store.folders.first { $0.id == id }
    }

    /// The first tags as chips, and a count for the rest.
    ///
    /// Offsets rather than the tag itself as the id: "#work #work" is a
    /// perfectly typeable line, and duplicate ids confuse SwiftUI.
    private var tagChips: some View {
        HStack(spacing: 4) {
            ForEach(Array(page.tags.prefix(Self.shownTags).enumerated()), id: \.offset) { _, tag in
                Text(tag)
                    .font(.caption2)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                    .foregroundStyle(.secondary)
            }
            if page.tags.count > Self.shownTags {
                Text("+\(page.tags.count - Self.shownTags)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tagged \(page.tags.joined(separator: ", "))")
    }
}

/// A folder's name beside its colour, as a row's metadata shows it.
struct FolderLabel: View {
    let folder: Folder

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(Color(hex: folder.color) ?? Color.secondary.opacity(0.4))
                .frame(width: 7, height: 7)
            Text(folder.name)
                .lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("In \(folder.name)")
    }
}

/// A page's schedule, formatted in the reader's locale.
///
/// The date arrives as a local wall-clock string with no zone, which is how
/// Pikos stores it — see the note on dates in the FFI. It is parsed with a
/// fixed-format parser and rendered with the user's own formatter, so the
/// storage format never leaks into what they read.
///
/// "Today" and "Tomorrow" are said as words rather than as dates, and a timed
/// page today shows only its time: on a screen whose heading already says
/// which day it is, the date is the one part of the label carrying nothing.
struct ScheduleLabel: View {
    let iso: String
    /// A finished page's date is history, not a deadline, so it is never red.
    var isDone = false

    /// Parsed once per row rather than per property.
    ///
    /// `body`, `formatted` and `isOverdue` each need the date, and a computed
    /// property would build a `DateFormatter` for every one of them — three per
    /// row, on every frame of a scroll. Constructing a `DateFormatter` costs
    /// roughly a hundred microseconds, which at a screenful of rows is a
    /// dropped frame for nothing.
    private let parsed: Date?
    private let isAllDay: Bool

    /// Explicitly main-actor because it reads the shared formatters below.
    /// SwiftUI only ever builds a view from a body, which is already there.
    @MainActor
    init(iso: String, isDone: Bool = false) {
        self.iso = iso
        self.isDone = isDone
        let allDay = !iso.contains("T")
        self.isAllDay = allDay
        self.parsed = (allDay ? Self.dayFormatter : Self.instantFormatter).date(from: iso)
    }

    var body: some View {
        Label(formatted, systemImage: isAllDay ? "calendar" : "clock")
            .labelStyle(.titleAndIcon)
            .font(.caption)
            .foregroundStyle(isOverdue ? Color.red : Color.secondary)
            .accessibilityLabel(isOverdue ? String(localized: "Overdue, \(formatted)") : formatted)
    }

    // Fixed locale and no timezone conversion: the stored value is a wall
    // clock, and interpreting it in the user's zone is exactly right — 09:00
    // means 09:00 wherever they are.
    //
    // Main-actor isolated, which is what makes a shared mutable `DateFormatter`
    // safe to hold in a `static let` at all: it is reachable only from the same
    // actor every `View` body already runs on.
    @MainActor private static let dayFormatter = fixedFormat("yyyy-MM-dd")
    @MainActor private static let instantFormatter = fixedFormat("yyyy-MM-dd'T'HH:mm:ss")

    private static func fixedFormat(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = format
        return formatter
    }

    private var formatted: String {
        guard let parsed else { return iso }
        let calendar = Calendar.current
        let time = parsed.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(parsed) {
            return isAllDay ? String(localized: "Today") : time
        }
        if calendar.isDateInTomorrow(parsed) {
            return isAllDay ? String(localized: "Tomorrow") : String(localized: "Tomorrow \(time)")
        }
        if calendar.isDateInYesterday(parsed) {
            return isAllDay ? String(localized: "Yesterday") : String(localized: "Yesterday \(time)")
        }
        // Within the year the year is noise; outside it, it is the point.
        let sameYear = calendar.isDate(parsed, equalTo: .now, toGranularity: .year)
        let day =
            sameYear
            ? parsed.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
            : parsed.formatted(.dateTime.day().month(.abbreviated).year())
        return isAllDay ? day : "\(day) \(time)"
    }

    private var isOverdue: Bool {
        guard let parsed, !isDone else { return false }
        // An all-day page is overdue from the next day; a timed one, the
        // moment its time has passed. The same two rules the Today view's
        // sections are drawn by.
        if isAllDay {
            return parsed < Calendar.current.startOfDay(for: .now)
        }
        return parsed < .now
    }
}
