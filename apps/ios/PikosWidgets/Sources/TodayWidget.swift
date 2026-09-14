import AppIntents
import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// Today's pages, on the home screen and the lock screen.
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
/// appear. The one write the widget makes — ticking a ring — is a tap, not a
/// refresh, and goes through `CompletePageIntent`, which says why that is safe.
struct TodayWidget: Widget {
    static let kind = "app.pikos.widget.today"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Today")
        .description("What you have scheduled for today.")
        // The three home-screen sizes and the three lock-screen ones. One
        // widget rather than two because they show one thing — today — and a
        // person who adds "Today" to the lock screen should find the same
        // name they saw on the home screen.
        .supportedFamilies([
            .systemSmall, .systemMedium, .systemLarge,
            .accessoryInline, .accessoryCircular, .accessoryRectangular,
        ])
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

    /// What is still to do, in the order the day runs.
    var open: [PageSummary] {
        pages.filter { $0.status != "done" }
    }
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

    var body: some View {
        switch family {
        case .accessoryInline:
            InlineView(entry: entry)
        case .accessoryCircular:
            CircularView(entry: entry)
        case .accessoryRectangular:
            RectangularView(entry: entry)
        default:
            HomeScreenView(entry: entry)
        }
    }
}

/// The same tint the app's list gives the ring, so the widget and the list
/// agree about which of today's rows is the urgent one. Spelled here rather
/// than shared: the app's `PagePriority` lives in the app target, and four
/// colours are cheaper than a third package target.
private func ringColor(priority: Int64) -> Color {
    switch priority {
    case 1: return .red
    case 2: return .orange
    case 3: return .yellow
    case 4: return .blue
    default: return .secondary
    }
}

/// A page's time of day, for the lock screen, or nil for an all-day page.
///
/// The stored value is a wall clock, resolved in the reader's own zone by
/// `StorageTimestamp` — the same reading the app's list makes, so the lock
/// screen and the list never disagree by an hour.
private func timeOfDay(_ page: PageSummary) -> Date? {
    guard let start = page.scheduledStart, start.contains("T") else { return nil }
    return StorageTimestamp.wallClock(start)
}

// MARK: Home screen

private struct HomeScreenView: View {
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
        // Tapping anywhere else opens the app on Today. The same pikos://
        // grammar the desktop app uses, parsed by the same Rust.
        .widgetURL(URL(string: "pikos://today"))
    }

    private var header: some View {
        HStack {
            Text("Today")
                .font(.caption.weight(.semibold))
            Spacer()
            if !entry.pages.isEmpty {
                Text("\(entry.open.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// One page: a ring that finishes it and a title that opens it.
    ///
    /// The ring is a real button, so a task can be ticked from the home screen
    /// without the app ever coming to the front — the thing a widget is for.
    /// The title opens its page on the medium and large sizes, where there is
    /// room to aim; on the small one it falls through to the widget's own
    /// link, since three rows in a two-inch square are not something a thumb
    /// can pick between — but the ring is a target of its own even there.
    private func row(_ page: PageSummary) -> some View {
        let isDone = page.status == "done"
        // `Brand.accent` rather than `Color.accentColor`: the widget is its
        // own process with no asset catalog, so the app's accent is not here
        // to inherit.
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            Button(intent: CompletePageIntent(pageId: page.id, done: !isDone)) {
                Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                    .font(.caption2)
                    .foregroundStyle(isDone ? Brand.accent : ringColor(priority: page.priority))
                    // Drawn dimmed while the tap is being written, so the
                    // moment between the touch and the reload reads as
                    // "working" rather than "ignored".
                    .invalidatableContent()
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isDone ? "Reopen" : "Mark as done")

            let title = Text(page.title.isEmpty ? "Untitled" : page.title)
                .font(.caption)
                .strikethrough(isDone, color: .secondary)
                .foregroundStyle(isDone ? Color.secondary : Color.primary)
                .lineLimit(family == .systemSmall ? 1 : 2)
            if family != .systemSmall, let url = URL(string: "pikos://page/\(page.id)") {
                Link(destination: url) { title }
            } else {
                title
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: Lock screen

/// One line beside the clock: what is next, or how much is left.
private struct InlineView: View {
    let entry: TodayEntry

    var body: some View {
        if let next = entry.open.first {
            if let time = timeOfDay(next) {
                Text("\(next.title.isEmpty ? "Untitled" : next.title) · \(time, style: .time)")
            } else {
                Text(next.title.isEmpty ? "Untitled" : next.title)
            }
        } else if entry.pages.isEmpty {
            Text("Nothing scheduled today")
        } else {
            Text("All done for today")
        }
    }
}

/// A count, for the small round slot: how many of today's pages are open.
private struct CircularView: View {
    let entry: TodayEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -2) {
                Text("\(entry.open.count)")
                    .font(.title2.weight(.semibold).monospacedDigit())
                Text("today")
                    .font(.caption2)
                    .textCase(.uppercase)
            }
        }
        .widgetURL(URL(string: "pikos://today"))
        .accessibilityLabel("\(entry.open.count) pages open today")
    }
}

/// The next two things, with their times.
///
/// Two rather than three: the slot is three lines tall and one of them is
/// the heading, which the lock screen needs — a bare title beside the clock
/// does not say whose it is.
private struct RectangularView: View {
    let entry: TodayEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: "sun.max")
                Text("Today")
                if !entry.open.isEmpty {
                    Text("\(entry.open.count)")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption.weight(.semibold))

            if entry.failure != nil {
                Text("Can't read your notes").font(.caption2).foregroundStyle(.secondary)
            } else if entry.open.isEmpty {
                Text(entry.pages.isEmpty ? "Nothing scheduled" : "All done")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(entry.open.prefix(2), id: \.id) { page in
                    HStack(spacing: 4) {
                        if let time = timeOfDay(page) {
                            Text(time, style: .time)
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        Text(page.title.isEmpty ? "Untitled" : page.title)
                            .font(.caption2)
                            .lineLimit(1)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(URL(string: "pikos://today"))
    }
}
