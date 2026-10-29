import PikosCore
import PikosSupport
import SwiftUI

/// The completion checkbox: the desktop's square, stroked red for urgent and amber for high.
///
/// Its own view beside the row's link rather than inside it: a Button in a link's label does not
/// reliably receive the tap.
struct CompletionToggle: View {
    let isDone: Bool
    var priority: PagePriority? = nil
    let onToggle: (Bool) -> Void

    var body: some View {
        Button {
            onToggle(!isDone)
        } label: {
            TaskCheckboxMark(isDone: isDone, stroke: stroke, size: 19)
        }
        .buttonStyle(.plain)
        // `contentShape` must follow the frame, or the hit area stays the size of the glyph.
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        // Ahead of the row's hold menu and drag, which made a plain button's tap wait about half a
        // second on a phone. The button stays for VoiceOver, which activates it directly.
        .highPriorityGesture(TapGesture().onEnded { onToggle(!isDone) })
        .sensoryFeedback(.success, trigger: isDone) { _, done in done }
        .accessibilityLabel(isDone ? "Mark as not done" : "Mark as done")
        .accessibilityValue(priority.map { "\($0.name) priority" } ?? "")
        .accessibilityAddTraits(isDone ? .isSelected : [])
    }

    private var stroke: Color {
        switch priority {
        case .urgent: return .priorityUrgent
        case .high: return .statusDueSoon
        default: return .borderPrimary
        }
    }
}

/// One page in the list, without its checkbox — see `CompletionToggle`.
///
/// The desktop's row: title and date on one line, one quiet line of detail under it.
struct PageRow: View {
    let page: PageSummary
    /// On in the date views, where rows from every folder sit together; off inside a folder.
    var showsFolder = false

    @Environment(SettingsStore.self) private var settings
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize

    private var isDone: Bool { page.status == "done" }

    var body: some View {
        // At accessibility sizes the date goes under the title: beside it, it left the title one letter wide.
        let stacksDate = typeSize.isAccessibilitySize
        let titleLine =
            stacksDate
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 3))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        VStack(alignment: .leading, spacing: 3) {
            titleLine {
                Text(page.title.isEmpty ? String(localized: "Untitled") : page.title)
                    .font(.pkBodyMedium)
                    .foregroundStyle(isDone ? Color.textTertiary : Color.textPrimary)
                    .lineLimit(2)
                if !stacksDate {
                    Spacer(minLength: 4)
                }
                if let scheduled = page.scheduledStart {
                    ScheduleLabel(iso: scheduled, end: page.scheduledEnd, isDone: isDone)
                }
            }

            if let detailLine {
                detailLine
                    .font(.pkBodySm)
                    .foregroundStyle(.textTertiary)
                    .lineLimit(1)
            }
        }
        .padding(.top, 12 + settings.listDensity.rowPadding)
        .padding(.bottom, 11 + settings.listDensity.rowPadding)
    }

    /// Folder, first tag and subtitle as one line, subtitle last so a long one truncates rather
    /// than pushing the short labels off the row. Repeating isn't marked: the page itself says so.
    private var detailLine: Text? {
        var parts: [Text] = []

        if showsFolder, let folder {
            let dot = Text(Image(systemName: "circle.fill"))
                .font(.system(size: 7))
                .foregroundStyle(Color(hex: folder.color) ?? Color.textDisabled)
            parts.append((dot + Text(verbatim: " \(folder.name)")).accessibilityLabel("In \(folder.name)"))
        }

        if let tag = page.tags.first {
            let more = page.tags.count > 1 ? " +\(page.tags.count - 1)" : ""
            parts.append(
                Text(verbatim: "#\(tag)\(more)")
                    .accessibilityLabel("Tagged \(page.tags.joined(separator: ", "))"))
        }

        if settings.listDensity != .compact, let subtitle = page.subtitle, !subtitle.isEmpty {
            parts.append(Text(subtitle))
        }

        guard let first = parts.first else { return nil }

        return parts.dropFirst().reduce(first) { $0 + Text(verbatim: "  ·  ") + $1 }
    }

    private var folder: Folder? {
        guard let id = page.folderId else { return nil }
        return store.folders.first { $0.id == id }
    }
}

/// A page's date the way the desktop's row prints it: red once late, amber within three days.
///
/// The stored value is a local wall clock with no zone, parsed with a fixed format and rendered in
/// the reader's own. "Today" and "Tomorrow" are words, and a time today is only its time.
struct ScheduleLabel: View {
    let iso: String
    var isDone = false

    /// Parsed once per row: a `DateFormatter` costs about a hundred microseconds, per frame of a scroll.
    private let parsed: Date?
    private let isAllDay: Bool
    private let rangeEnd: Date?

    @MainActor
    init(iso: String, end: String? = nil, isDone: Bool = false) {
        self.iso = iso
        self.isDone = isDone
        let allDay = !iso.contains("T")
        isAllDay = allDay
        parsed = (allDay ? Self.dayFormatter : Self.instantFormatter).date(from: iso)
        if allDay, let end, !end.contains("T"), end > iso {
            rangeEnd = Self.dayFormatter.date(from: end)
        } else {
            rangeEnd = nil
        }
    }

    var body: some View {
        Text(formatted)
            .font(.pkUISm)
            .monospacedDigit()
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
            .accessibilityLabel(isOverdue ? String(localized: "Overdue, \(formatted)") : formatted)
    }

    // Main-actor isolated, which is what makes a shared `DateFormatter` safe in a `static let`.
    @MainActor private static let dayFormatter = fixedFormat("yyyy-MM-dd")
    @MainActor private static let instantFormatter = fixedFormat("yyyy-MM-dd'T'HH:mm:ss")

    private static func fixedFormat(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = format
        return formatter
    }

    private var color: Color {
        if isOverdue { return .statusOverdue }
        if isDueSoon { return .textDueSoon }
        return .textTertiary
    }

    private var formatted: String {
        guard let parsed else { return iso }
        if let rangeEnd {
            return parsed.formatted(.dateTime.month(.abbreviated).day()) + " – "
                + rangeEnd.formatted(.dateTime.month(.abbreviated).day())
        }
        let calendar = Calendar.current
        let time = ClockTime.string(parsed)
        if calendar.isDateInToday(parsed) {
            return isAllDay ? String(localized: "Today") : time
        }
        if calendar.isDateInTomorrow(parsed) {
            return isAllDay ? String(localized: "Tomorrow") : String(localized: "Tomorrow \(time)")
        }
        if calendar.isDateInYesterday(parsed) {
            return isAllDay ? String(localized: "Yesterday") : String(localized: "Yesterday \(time)")
        }
        let sameYear = calendar.isDate(parsed, equalTo: .now, toGranularity: .year)
        let day =
            sameYear
            ? parsed.formatted(.dateTime.month(.abbreviated).day())
            : parsed.formatted(.dateTime.day().month(.abbreviated).year())
        return isAllDay ? day : "\(day), \(time)"
    }

    /// All-day is late from the next day; timed, the moment it passes — the Today view's own rules.
    private var isOverdue: Bool {
        guard let parsed, !isDone else { return false }
        if isAllDay {
            return (rangeEnd ?? parsed) < Calendar.current.startOfDay(for: .now)
        }
        return parsed < .now
    }

    /// The desktop's `isDueSoon`: ahead of now and no later than the end of the third day out.
    private var isDueSoon: Bool {
        guard let parsed, !isDone, parsed > .now else { return false }
        let calendar = Calendar.current
        guard
            let limit = calendar.date(
                byAdding: DateComponents(day: 4, second: -1), to: calendar.startOfDay(for: .now))
        else { return false }
        return parsed <= limit
    }
}
