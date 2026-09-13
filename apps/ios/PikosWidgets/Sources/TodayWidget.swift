import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// Today's pages, on the home screen.
///
/// Reads the workspace directly rather than asking the app for a snapshot. The
/// database is in the App Group container precisely so this process can open
/// it, and a widget that depends on the app having run recently to refresh a
/// cache goes stale exactly when the user has not opened the app — which is
/// when a widget is most useful.
///
/// It opens through `ReadOnlyWorkspace`, which has no write methods at all.
/// SQLite in WAL mode permits one writer, and a widget refresh racing the app
/// for it would block the app; the symptom would be a keystroke that does not
/// appear.
struct TodayWidget: Widget {
    static let kind = "app.pikos.widget.today"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Today")
        .description("What you have scheduled for today.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Timeline

struct TodayEntry: TimelineEntry {
    let date: Date
    let pages: [PageSummary]
    /// Set when the workspace could not be read. Shown rather than swallowed:
    /// an empty widget and a broken widget look identical otherwise, and the
    /// usual cause is an App Group that is not configured.
    let failure: String?

    static let placeholder = TodayEntry(
        date: .now,
        pages: [],
        failure: nil)
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        Task { completion(await entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        Task {
            let current = await entry()
            // Refresh at the next hour boundary rather than on a fixed interval.
            // What this widget shows changes when the clock crosses into a new
            // hour — an item becoming overdue — not at an arbitrary offset from
            // whenever it last ran. WidgetKit treats the date as a request
            // rather than a promise, which is fine: being an hour stale is
            // survivable, and asking more often would spend the budget for it.
            let nextHour =
                Calendar.current.nextDate(
                    after: .now, matching: DateComponents(minute: 0), matchingPolicy: .nextTime)
                ?? Date.now.addingTimeInterval(3600)
            completion(Timeline(entries: [current], policy: .after(nextHour)))
        }
    }

    private func entry() async -> TodayEntry {
        do {
            let url = try WorkspaceLocation.databaseURL()
            let workspace = try await ReadOnlyWorkspace.openExisting(path: url.path)
            let pages = try await workspace.listToday()
            return TodayEntry(date: .now, pages: pages, failure: nil)
        } catch {
            return TodayEntry(date: .now, pages: [], failure: error.localizedDescription)
        }
    }
}

// MARK: - Views

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    private var visible: [PageSummary] {
        // The list is trimmed to what fits rather than scrolled, because a
        // widget cannot scroll. The count is the honest capacity of each size.
        let limit: Int
        switch family {
        case .systemSmall: limit = 3
        case .systemMedium: limit = 4
        default: limit = 8
        }
        return Array(entry.pages.prefix(limit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header

            if entry.failure != nil {
                Text("Can't read your notes")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if entry.pages.isEmpty {
                Text("Nothing scheduled")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(visible, id: \.id) { page in
                    row(page)
                }
                if entry.pages.count > visible.count {
                    Text("+\(entry.pages.count - visible.count) more")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)
        }
        // Tapping anywhere opens the app on Today. The same pikos:// grammar the
        // desktop app uses, parsed by the same Rust.
        .widgetURL(URL(string: "pikos://today"))
    }

    private var header: some View {
        HStack {
            Text("Today")
                .font(.caption.weight(.semibold))
            Spacer()
            if !entry.pages.isEmpty {
                Text("\(entry.pages.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ page: PageSummary) -> some View {
        let isDone = page.status == "done"
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                .font(.caption2)
                .foregroundStyle(isDone ? Color.accentColor : Color.secondary)
            Text(page.title.isEmpty ? "Untitled" : page.title)
                .font(.caption)
                .strikethrough(isDone, color: .secondary)
                .foregroundStyle(isDone ? Color.secondary : Color.primary)
                .lineLimit(family == .systemSmall ? 1 : 2)
            Spacer(minLength: 0)
        }
    }
}
