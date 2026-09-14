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

/// A completion handler WidgetKit gave us, carried into a `Task`.
///
/// `TimelineProvider` hands over plain closures, and under strict concurrency a
/// plain closure cannot be captured by the `@Sendable` closure a `Task` runs.
/// The handler is only ever called once, from the task that owns this box, so
/// the sharing the checker objects to never happens — hence `@unchecked`. A
/// box rather than an `async` provider because `StaticConfiguration` has no
/// async variant of this protocol to adopt.
private struct Completion<Value>: @unchecked Sendable {
    let call: (Value) -> Void
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        let done = Completion(call: completion)
        Task { done.call(await entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        let done = Completion(call: completion)
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
            done.call(Timeline(entries: [current], policy: .after(nextHour)))
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
                    // A row opens its own page on the medium and large sizes,
                    // where there is room to aim; the small one is a single
                    // target that opens Today, since three rows in a two-inch
                    // square are not something a thumb can pick between.
                    if family != .systemSmall, let url = URL(string: "pikos://page/\(page.id)") {
                        Link(destination: url) { row(page) }
                    } else {
                        row(page)
                    }
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

    /// The same tint the app's list gives the ring, so the widget and the
    /// list agree about which of today's rows is the urgent one. Spelled
    /// here rather than shared: the app's `PagePriority` lives in the app
    /// target, and four colours are cheaper than a third package target.
    private func ringColor(priority: Int64) -> Color {
        switch priority {
        case 1: return .red
        case 2: return .orange
        case 3: return .yellow
        case 4: return .blue
        default: return .secondary
        }
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
        // `Brand.accent` rather than `Color.accentColor`: the widget is its
        // own process with no asset catalog, so the app's accent is not here
        // to inherit.
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                .font(.caption2)
                .foregroundStyle(isDone ? Brand.accent : ringColor(priority: page.priority))
            Text(page.title.isEmpty ? "Untitled" : page.title)
                .font(.caption)
                .strikethrough(isDone, color: .secondary)
                .foregroundStyle(isDone ? Color.secondary : Color.primary)
                .lineLimit(family == .systemSmall ? 1 : 2)
            Spacer(minLength: 0)
        }
    }
}
