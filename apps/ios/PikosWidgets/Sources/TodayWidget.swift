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
            done.call(Timeline(entries: [current], policy: .after(WidgetClock.nextHour())))
        }
    }

    private func entry() async -> TodayEntry {
        do {
            let workspace = try await WidgetWorkspace.open()
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
            WidgetHeader(title: "Today", count: entry.open.count)

            if entry.failure != nil {
                WidgetNote(text: "Can't read your notes")
            } else if entry.pages.isEmpty {
                WidgetNote(text: "Nothing scheduled")
            } else {
                ForEach(visible, id: \.id) { page in
                    // The small size is a single target that opens Today;
                    // the ring is still its own button there.
                    WidgetPageRow(
                        page: page,
                        linksToPage: family != .systemSmall,
                        lineLimit: family == .systemSmall ? 1 : 2)
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
}

// MARK: Lock screen

/// One line beside the clock: what is next, or how much is left.
private struct InlineView: View {
    let entry: TodayEntry

    var body: some View {
        if let next = entry.open.first {
            if let time = timeOfDay(next) {
                Text("\(displayTitle(next)) · \(time, style: .time)")
            } else {
                Text(displayTitle(next))
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
                        Text(displayTitle(page))
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
