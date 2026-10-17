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
        .sensoryFeedback(.success, trigger: isDone) { _, done in done }
        .accessibilityLabel(isDone ? "Mark as not done" : "Mark as done")
        .accessibilityValue(priority.map { "\($0.name) priority" } ?? "")
        .accessibilityAddTraits(isDone ? .isSelected : [])
    }

    private var stroke: Color {
        switch priority {
        case .urgent: return .statusOverdue
        case .high: return .statusDueSoon
        default: return .borderPrimary
        }
    }
}

/// One page in the list, without its checkbox — see `CompletionToggle`.
///
/// The desktop's row: title and date on one line, the subtitle under it. Folder, repeat and tags
/// follow only where the heading does not already say them.
struct PageRow: View {
    let page: PageSummary
    /// On in the date views, where rows from every folder sit together; off inside a folder.
    var showsFolder = false

    @Environment(SettingsStore.self) private var settings
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize

    private var isDone: Bool { page.status == "done" }

    private static let shownTags = 2

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

            if settings.listDensity != .compact, let subtitle = page.subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.pkBodySm)
                    .foregroundStyle(.textTertiary)
                    .lineLimit(1)
            }

            if hasMeta {
                HStack(spacing: 10) {
                    if page.isRecurring {
                        Label("Repeats", systemImage: "repeat")
                            .labelStyle(.iconOnly)
                            .font(.system(size: 10, weight: .semibold))
                    }
                    if showsFolder, let folder {
                        FolderLabel(folder: folder)
                    }
                    if !page.tags.isEmpty {
                        tagList
                    }
                }
                .font(.pkUISm)
                .foregroundStyle(.textTertiary)
            }
        }
        .padding(.top, 12 + settings.listDensity.rowPadding)
        .padding(.bottom, 11 + settings.listDensity.rowPadding)
    }

    private var hasMeta: Bool {
        page.isRecurring || (showsFolder && folder != nil) || !page.tags.isEmpty
    }

    private var folder: Folder? {
        guard let id = page.folderId else { return nil }
        return store.folders.first { $0.id == id }
    }

    /// Offsets as ids: "#work #work" is a typeable line, and duplicate ids confuse SwiftUI.
    private var tagList: some View {
        HStack(spacing: 6) {
            ForEach(Array(page.tags.prefix(Self.shownTags).enumerated()), id: \.offset) { _, tag in
                Text("#\(tag)").lineLimit(1)
            }
            if page.tags.count > Self.shownTags {
                Text("+\(page.tags.count - Self.shownTags)")
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
        HStack(spacing: 5) {
            Circle()
                .fill(Color(hex: folder.color) ?? Color.textDisabled)
                .frame(width: 7, height: 7)
            Text(folder.name)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("In \(folder.name)")
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
